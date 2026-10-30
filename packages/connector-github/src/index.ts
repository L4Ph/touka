import type { TestContext } from "vite-plus/test";
import type nodeAssert from "node:assert/strict";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
// Server-only credentials; Tools expose operations, never tokens, to the model.
export interface GitHubEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** JSON object mapping `owner/repo`, or `owner/*` for a whole organization, to numeric installation IDs. */
  GITHUB_REPOSITORIES?: string;
}

export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfter?: string,
  ) {
    super(`github_http_${status}`);
  }
}

const API = "https://api.github.com";
const encoder = new TextEncoder();
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
export function validateRepo(repo: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) ||
    [".", ".."].includes(repo.split("/")[1])
  )
    throw new Error("invalid_repository");
}

/**
 * `ci` reads checks, statuses and workflow logs; `workflow` writes files under `.github/workflows/`.
 * Both need the App to hold those permissions, so only the operations that need them ask for them.
 */
export type GitHubAccess = "read" | "write" | "reply" | "ci" | "workflow";
export function createGitHubAppAuth(env: GitHubEnv) {
  const cache = new Map<string, { token: string; expires: number }>();
  let key: KeyObject | undefined;
  function installation(repo: string): number {
    validateRepo(repo);
    if (
      !env.GITHUB_APP_ID ||
      !/^\d+$/.test(env.GITHUB_APP_ID) ||
      !env.GITHUB_APP_PRIVATE_KEY ||
      !env.GITHUB_REPOSITORIES
    )
      throw new Error("github_unconfigured");
    let repos: unknown;
    try {
      repos = JSON.parse(env.GITHUB_REPOSITORIES);
    } catch {
      throw new Error("github_unconfigured");
    }
    if (!repos || typeof repos !== "object" || Array.isArray(repos))
      throw new Error("github_unconfigured");
    // An exact `owner/repo` entry wins; otherwise `owner/*` covers every repository the owner's
    // installation can see, including ones created later.
    const map = repos as Record<string, unknown>;
    const key = Object.hasOwn(map, repo) ? repo : `${repo.split("/")[0]}/*`;
    const id = Object.hasOwn(map, key) ? map[key] : undefined;
    if (!Number.isSafeInteger(id) || (id as number) <= 0) throw new Error("repository_forbidden");
    return id as number;
  }
  async function jwt(): Promise<string> {
    try {
      key ??= createPrivateKey(env.GITHUB_APP_PRIVATE_KEY!);
      if (key.asymmetricKeyType !== "rsa") throw new Error();
      const now = Math.floor(Date.now() / 1000);
      const body = `${base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${base64url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })))}`;
      return `${body}.${base64url(sign("RSA-SHA256", encoder.encode(body), key))}`;
    } catch {
      throw new Error("github_auth_failed");
    }
  }
  // Reads started together share one credential request instead of minting one each.
  const inflight = new Map<string, Promise<string>>();
  function token(repo: string, access: GitHubAccess = "read"): Promise<string> {
    const key = `${repo}:${access}`;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now() + 60_000) return Promise.resolve(cached.token);
    let pending = inflight.get(key);
    if (!pending) {
      pending = mint(repo, access).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  }
  async function mint(repo: string, access: GitHubAccess): Promise<string> {
    const id = installation(repo);
    if (!["read", "write", "reply", "ci", "workflow"].includes(access))
      throw new Error("github_invalid_permissions");
    const cacheKey = `${repo}:${access}`;
    const previous = cache.get(cacheKey);
    if (previous && previous.expires > Date.now() + 60_000) return previous.token;
    const response = await fetch(`${API}/app/installations/${id}/access_tokens`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: headers(await jwt()),
      body: JSON.stringify({
        repositories: [repo.split("/")[1]],
        // Issues and pull requests are part of what the tools read and write, not only contents.
        permissions:
          access === "reply"
            ? { issues: "write", pull_requests: "write" }
            : access === "ci"
              ? { actions: "read", checks: "read", statuses: "read" }
              : access === "workflow"
                ? { contents: "write", workflows: "write" }
                : access === "write"
                  ? { contents: "write", issues: "write", pull_requests: "write" }
                  : { contents: "read", issues: "read", pull_requests: "read" },
      }),
    }).catch(() => {
      throw new Error("github_transport_failed");
    });
    const data = await json(response);
    if (
      typeof data.token !== "string" ||
      data.token.length > 4096 ||
      !data.token ||
      typeof data.expires_at !== "string" ||
      !(Date.parse(data.expires_at) > Date.now() + 60_000)
    )
      throw new Error("github_auth_failed");
    cache.set(cacheKey, { token: data.token, expires: Date.parse(data.expires_at) });
    return data.token;
  }
  return {
    installation,
    token,
    invalidate(repo: string, access: GitHubAccess = "read") {
      cache.delete(`${repo}:${access}`);
    },
  };
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "remote-agent",
  };
}
async function json(response: Response, list = false): Promise<any> {
  if (!response.ok) {
    await response.body?.cancel();
    const retry = response.headers.get("retry-after");
    throw new GitHubError(response.status, retry && /^\d{1,6}$/.test(retry) ? retry : undefined);
  }
  if (response.status === 204) {
    await response.body?.cancel();
    return list ? [] : {};
  }
  // Bound remote payloads before parsing; error bodies are deliberately never surfaced.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("github_invalid_response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 600_000) throw new Error("github_response_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data) !== list) throw new Error();
    return data;
  } catch {
    throw new Error("github_invalid_response");
  }
}

function createGitHubClient(env: GitHubEnv) {
  const auth = createGitHubAppAuth(env);
  return {
    auth,
    async request(
      repo: string,
      level: GitHubAccess,
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      suffix: string,
      body?: unknown,
      list = false,
    ) {
      // Fixed operations below are the only callers; no arbitrary API URL is public.
      const token = await auth.token(repo, level);
      // A leading slash is a path from the API root (search); otherwise it is under the repository.
      const response = await fetch(
        suffix.startsWith("/") ? `${API}${suffix}` : `${API}/repos/${repo}/${suffix}`,
        {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
          headers: headers(token),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ).catch(() => {
        throw new Error("github_transport_failed");
      });
      if (response.status === 401) auth.invalidate(repo, level);
      return json(response, list);
    },
    /** A download behind GitHub's redirect (logs, archives). The pre-signed link never sees the token. */
    async download(repo: string, access: GitHubAccess, suffix: string): Promise<Response> {
      const token = await auth.token(repo, access);
      const first = await fetch(`${API}/repos/${repo}/${suffix}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: headers(token),
      }).catch(() => {
        throw new Error("github_transport_failed");
      });
      if (first.status === 401) auth.invalidate(repo, access);
      let response = first;
      if (first.status === 302 || first.status === 301) {
        const location = first.headers.get("location") ?? "";
        await first.body?.cancel();
        // The download link is pre-signed; sending the installation token there would leak it.
        if (!location.startsWith("https://")) throw new Error("github_invalid_response");
        response = await fetch(location, { signal: AbortSignal.timeout(30_000) }).catch(() => {
          throw new Error("github_transport_failed");
        });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new GitHubError(response.status);
      }
      return response;
    },
    /** The tail of a text download, read as a stream: logs can be hundreds of megabytes. */
    async tail(repo: string, access: GitHubAccess, suffix: string, chars: number) {
      const response = await this.download(repo, access, suffix);
      const keep = chars * 4;
      let tail = new Uint8Array(0);
      let read = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("github_invalid_response");
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          read += value.length;
          const joined = new Uint8Array(tail.length + value.length);
          joined.set(tail);
          joined.set(value, tail.length);
          tail = joined.length > keep ? joined.slice(-keep) : joined;
          if (read > 25_000_000) break;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const text = new TextDecoder().decode(tail);
      return text.length > chars ? text.slice(-chars) : text;
    },
  };
}

function ref(value: string): void {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.split("/").some((p) => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock"))
  )
    throw new Error("invalid_ref");
}
function path(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 500 ||
    !value ||
    /[\\\x00-\x1f\x7f%?#]/.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    throw new Error("invalid_path");
  return value.split("/").map(encodeURIComponent).join("/");
}
function sha(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("invalid_sha");
}
const clip = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";
const author = (user: unknown): string | null => {
  const name = (user as { login?: unknown } | null)?.login;
  return typeof name === "string" ? name : null;
};
const LIST_PAGE = 50;
// Comments arrive oldest first, so the latest ones are on the last page (and the one before it).
const lastPage = (total: unknown) =>
  Number.isSafeInteger(total) && (total as number) > 0
    ? Math.ceil((total as number) / LIST_PAGE)
    : 1;
function issueNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid_number");
}
function text(value: string, max: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error("invalid_text");
}

const loginName = (value: unknown): boolean =>
  typeof value === "string" && /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/.test(value);
function logins(values: readonly string[] | undefined, max: number): void {
  if (values === undefined) return;
  if (!Array.isArray(values) || values.length > max || !values.every(loginName))
    throw new Error("invalid_login");
}
function labelNames(values: readonly string[] | undefined): void {
  if (values === undefined) return;
  if (
    !Array.isArray(values) ||
    values.length > 20 ||
    !values.every((v) => typeof v === "string" && /^[^\r\n\0]{1,50}$/.test(v))
  )
    throw new Error("invalid_labels");
}
/**
 * A credential asking for a permission the App does not hold is refused with 422 when it is minted.
 * Say so, instead of a bare status the model cannot act on. Only the mint is wrapped: a 422 from the
 * API itself (an unknown ref, a branch that moved) means something else and must reach the model as is.
 */
async function needing(permission: string, mint: () => Promise<unknown>): Promise<void> {
  try {
    await mint();
  } catch (error) {
    if (error instanceof GitHubError && error.status === 422)
      throw new Error(`github_app_lacks_permission:${permission}`);
    throw error;
  }
}
const WORKFLOWS = ".github/workflows/";
const REACTIONS = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"];
const branchPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");
export type ReactionTarget = { kind: "issue-comment" | "review-comment"; id: number };

function createConnector(env: GitHubEnv) {
  const github = createGitHubClient(env);
  function authorize(
    repo: string,
    access: "read" | "write" | "workflow",
    resources: readonly string[],
  ) {
    validateRepo(repo);
    // An exact `owner/repo` grant, or `owner/*` for every repository of one owner.
    if (
      !resources.includes(`github:${repo}:${access}`) &&
      !resources.includes(`github:${repo.split("/")[0]}/*:${access}`)
    )
      throw new Error("github_forbidden");
    github.auth.installation(repo);
  }
  /** The newest comments of a list that arrives oldest first: the last page, topped up from the one before. */
  async function latest(repo: string, base: string, total: unknown): Promise<any[]> {
    const page = (n: number) =>
      github.request(
        repo,
        "read",
        "GET",
        `${base}?per_page=${LIST_PAGE}&page=${n}`,
        undefined,
        true,
      );
    const last = lastPage(total);
    const items = (await page(last)) as any[];
    if (last > 1 && items.length < LIST_PAGE)
      return [...((await page(last - 1)) as any[]), ...items].slice(-LIST_PAGE);
    return items;
  }
  return {
    auth: github.auth,
    reply: (
      repo: string,
      number: number,
      reviewComment: number | undefined,
      text: string,
      signal: AbortSignal,
    ) => sendReply(github.auth, repo, number, reviewComment, text, signal),
    async readFile(
      args: { repo: string; path: string; ref: string },
      resources: readonly string[],
    ) {
      authorize(args.repo, "read", resources);
      ref(args.ref);
      const data = await github.request(
        args.repo,
        "read",
        "GET",
        `contents/${path(args.path)}?ref=${encodeURIComponent(args.ref)}`,
      );
      if (
        data.type !== "file" ||
        data.encoding !== "base64" ||
        typeof data.content !== "string" ||
        data.content.length > 400_000 ||
        typeof data.sha !== "string"
      )
        throw new Error("github_unsupported_file");
      sha(data.sha);
      try {
        const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, "")), (c) =>
          c.charCodeAt(0),
        );
        return {
          sha: data.sha,
          content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        };
      } catch {
        throw new Error("github_unsupported_file");
      }
    },
    async createBranch(
      args: { repo: string; branch: string; sha: string },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      ref(args.branch);
      sha(args.sha);
      const data = await github.request(args.repo, "write", "POST", "git/refs", {
        ref: `refs/heads/${args.branch}`,
        sha: args.sha,
      });
      if (data.ref !== `refs/heads/${args.branch}` || data.object?.sha !== args.sha)
        throw new Error("github_invalid_response");
      return { ref: `refs/heads/${args.branch}`, sha: args.sha };
    },
    async writeFile(
      args: {
        repo: string;
        branch: string;
        path: string;
        content: string;
        expectedSha: string | null;
        message: string;
      },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      const workflow = args.path.startsWith(WORKFLOWS);
      if (workflow) {
        authorize(args.repo, "workflow", resources);
        await needing("workflows-write", () => github.auth.token(args.repo, "workflow"));
      }
      ref(args.branch);
      text(args.message, 500);
      if (args.expectedSha !== null) sha(args.expectedSha);
      if (typeof args.content !== "string" || args.content.length > 100_000)
        throw new Error("invalid_content");
      const bytes = new TextEncoder().encode(args.content);
      // Avoid spreading large files onto the JS stack.
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const data = await github.request(
        args.repo,
        args.path.startsWith(WORKFLOWS) ? "workflow" : "write",
        "PUT",
        `contents/${path(args.path)}`,
        {
          branch: args.branch,
          message: args.message,
          content: btoa(binary),
          ...(args.expectedSha === null ? {} : { sha: args.expectedSha }),
        },
      );
      if (typeof data.content?.sha !== "string" || typeof data.commit?.sha !== "string")
        throw new Error("github_invalid_response");
      sha(data.content.sha);
      sha(data.commit.sha);
      return { sha: data.content.sha, commit: data.commit.sha };
    },
    async openPullRequest(
      args: { repo: string; head: string; base: string; title: string; body: string },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      ref(args.head);
      ref(args.base);
      text(args.title, 256);
      if (args.head === args.base || typeof args.body !== "string" || args.body.length > 20_000)
        throw new Error("invalid_pull_request");
      const data = await github.request(args.repo, "write", "POST", "pulls", {
        head: args.head,
        base: args.base,
        title: args.title,
        body: args.body,
      });
      if (!Number.isSafeInteger(data.number) || data.number <= 0)
        throw new Error("github_invalid_response");
      return { number: data.number };
    },
    /** An issue or pull request conversation: body, labels and the latest comments. */
    async getIssue(args: { repo: string; number: number }, resources: readonly string[]) {
      authorize(args.repo, "read", resources);
      issueNumber(args.number);
      const issue = await github.request(args.repo, "read", "GET", `issues/${args.number}`);
      if (!Number.isSafeInteger(issue.number) || typeof issue.title !== "string")
        throw new Error("github_invalid_response");
      const comments = await latest(args.repo, `issues/${args.number}/comments`, issue.comments);
      return {
        number: issue.number,
        title: clip(issue.title, 500),
        state: issue.state,
        author: author(issue.user),
        isPullRequest: Boolean(issue.pull_request),
        labels: (issue.labels ?? []).map((l: any) => (typeof l === "string" ? l : l?.name)),
        body: clip(issue.body, 20_000),
        commentCount: issue.comments,
        comments: comments.slice(-LIST_PAGE).map((c: any) => ({
          id: c.id,
          author: author(c.user),
          createdAt: c.created_at,
          body: clip(c.body, 4_000),
        })),
      };
    },
    /** Pull request metadata, changed files with bounded patches, and the latest review comments. */
    async getPullRequest(args: { repo: string; number: number }, resources: readonly string[]) {
      authorize(args.repo, "read", resources);
      issueNumber(args.number);
      const pr = await github.request(args.repo, "read", "GET", `pulls/${args.number}`);
      if (!Number.isSafeInteger(pr.number) || typeof pr.title !== "string")
        throw new Error("github_invalid_response");
      const [files, reviewComments] = await Promise.all([
        github.request(
          args.repo,
          "read",
          "GET",
          `pulls/${args.number}/files?per_page=100`,
          undefined,
          true,
        ),
        latest(args.repo, `pulls/${args.number}/comments`, pr.review_comments),
      ]);
      let patchBudget = 60_000;
      return {
        number: pr.number,
        title: clip(pr.title, 500),
        state: pr.state,
        draft: Boolean(pr.draft),
        merged: Boolean(pr.merged),
        author: author(pr.user),
        base: pr.base?.ref,
        head: pr.head?.ref,
        headSha: pr.head?.sha,
        body: clip(pr.body, 20_000),
        changedFiles: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
        files: files.map((f: any) => {
          const patch = clip(f.patch, Math.min(4_000, patchBudget));
          patchBudget -= patch.length;
          return {
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch,
          };
        }),
        reviewCommentCount: pr.review_comments,
        reviewComments: reviewComments.slice(-LIST_PAGE).map((c: any) => ({
          id: c.id,
          author: author(c.user),
          path: c.path,
          line: c.line ?? c.original_line ?? null,
          inReplyTo: c.in_reply_to_id ?? null,
          body: clip(c.body, 4_000),
        })),
      };
    },
    async createIssue(
      args: { repo: string; title: string; body: string },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      text(args.title, 256);
      if (typeof args.body !== "string" || args.body.length > 20_000)
        throw new Error("invalid_issue");
      const data = await github.request(args.repo, "write", "POST", "issues", {
        title: args.title,
        body: args.body,
      });
      if (!Number.isSafeInteger(data.number) || data.number <= 0)
        throw new Error("github_invalid_response");
      return { number: data.number };
    },
    /** Comment on an issue or pull request conversation (pull requests are issues to this endpoint). */
    async comment(
      args: { repo: string; number: number; body: string },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      issueNumber(args.number);
      text(args.body, 20_000);
      const data = await github.request(
        args.repo,
        "write",
        "POST",
        `issues/${args.number}/comments`,
        {
          body: args.body,
        },
      );
      if (!Number.isSafeInteger(data.id) || data.id <= 0)
        throw new Error("github_invalid_response");
      return { id: data.id };
    },
    /**
     * Submit one review: a decision (comment, approve, request changes), optional inline comments on
     * lines of the diff, pinned to a commit. Approving or requesting changes is a decision; merging
     * stays out of scope.
     */
    async reviewPullRequest(
      args: {
        repo: string;
        number: number;
        event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
        body: string;
        commitId?: string;
        comments?: {
          path: string;
          line: number;
          side?: "LEFT" | "RIGHT";
          startLine?: number;
          startSide?: "LEFT" | "RIGHT";
          body: string;
        }[];
      },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      issueNumber(args.number);
      if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(args.event))
        throw new Error("invalid_review");
      if (args.commitId !== undefined) sha(args.commitId);
      const inline = args.comments ?? [];
      if (!Array.isArray(inline) || inline.length > 50) throw new Error("invalid_review");
      for (const c of inline) {
        path(c.path);
        issueNumber(c.line);
        if (c.startLine !== undefined) {
          issueNumber(c.startLine);
          if (c.startLine >= c.line) throw new Error("invalid_review");
        }
        for (const side of [c.side, c.startSide])
          if (side !== undefined && !["LEFT", "RIGHT"].includes(side))
            throw new Error("invalid_review");
        text(c.body, 4_000);
      }
      // GitHub rejects an empty body for COMMENT and REQUEST_CHANGES unless inline comments carry it.
      if (!((args.event === "APPROVE" || inline.length > 0) && args.body === ""))
        text(args.body, 20_000);
      const data = await github.request(
        args.repo,
        "write",
        "POST",
        `pulls/${args.number}/reviews`,
        {
          event: args.event,
          body: args.body,
          ...(args.commitId === undefined ? {} : { commit_id: args.commitId }),
          ...(inline.length
            ? {
                comments: inline.map((c) => ({
                  path: c.path,
                  line: c.line,
                  side: c.side ?? "RIGHT",
                  ...(c.startLine === undefined
                    ? {}
                    : { start_line: c.startLine, start_side: c.startSide ?? c.side ?? "RIGHT" }),
                  body: c.body,
                })),
              }
            : {}),
        },
      );
      if (!Number.isSafeInteger(data.id) || data.id <= 0)
        throw new Error("github_invalid_response");
      return { id: data.id };
    },
    /** Answer in an existing review thread. */
    async replyReviewComment(
      args: { repo: string; number: number; commentId: number; body: string },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      issueNumber(args.number);
      issueNumber(args.commentId);
      text(args.body, 20_000);
      const data = await github.request(
        args.repo,
        "write",
        "POST",
        `pulls/${args.number}/comments/${args.commentId}/replies`,
        { body: args.body },
      );
      if (!Number.isSafeInteger(data.id) || data.id <= 0)
        throw new Error("github_invalid_response");
      return { id: data.id };
    },
    /** The entries of a directory, to find a file before reading it. */
    async listFiles(
      args: { repo: string; path?: string; ref?: string },
      resources: readonly string[],
    ) {
      authorize(args.repo, "read", resources);
      const directory = args.path ? path(args.path) : "";
      if (args.ref !== undefined) ref(args.ref);
      const data = await github.request(
        args.repo,
        "read",
        "GET",
        `contents/${directory}${args.ref === undefined ? "" : `?ref=${encodeURIComponent(args.ref)}`}`,
        undefined,
        true,
      );
      const entries = data as any[];
      return {
        truncated: entries.length > 300,
        entries: entries.slice(0, 300).map((f) => ({
          name: f.name,
          path: f.path,
          type: f.type,
          size: f.size,
        })),
      };
    },
    /** Code search inside the one repository the credential is scoped to. */
    async searchCode(args: { repo: string; query: string }, resources: readonly string[]) {
      authorize(args.repo, "read", resources);
      text(args.query, 200);
      // The repository is fixed by us; a query may not widen it to other owners or repositories.
      if (/[\r\n]/.test(args.query) || /(?:^|\s)-?(?:repo|org|user):/i.test(args.query))
        throw new Error("invalid_text");
      const data = await github.request(
        args.repo,
        "read",
        "GET",
        `/search/code?q=${encodeURIComponent(`${args.query} repo:${args.repo}`)}&per_page=20`,
      );
      if (!Array.isArray(data.items)) throw new Error("github_invalid_response");
      return {
        total: data.total_count,
        items: (data.items as any[]).slice(0, 20).map((i) => ({ path: i.path, name: i.name })),
      };
    },
    /**
     * The files of a repository at a ref as a gzip tarball, plus the commit it resolved to (so a
     * branch can be started from exactly what was read). The caller bounds how much it reads.
     */
    async archive(args: { repo: string; ref?: string }, resources: readonly string[]) {
      authorize(args.repo, "read", resources);
      const wanted = args.ref ?? "HEAD";
      ref(wanted);
      const commit = await github.request(
        args.repo,
        "read",
        "GET",
        `commits/${encodeURIComponent(wanted)}`,
      );
      sha(commit.sha ?? "");
      const response = await github.download(args.repo, "read", `tarball/${commit.sha}`);
      if (!response.body) throw new Error("github_invalid_response");
      return { sha: commit.sha as string, body: response.body };
    },
    /** Check runs and commit statuses of a ref (usually a pull request's head commit). */
    async getChecks(args: { repo: string; ref: string }, resources: readonly string[]) {
      authorize(args.repo, "read", resources);
      ref(args.ref);
      await needing("actions-checks-statuses-read", () => github.auth.token(args.repo, "ci"));
      const target = encodeURIComponent(args.ref);
      const [runs, status] = await Promise.all([
        github.request(args.repo, "ci", "GET", `commits/${target}/check-runs?per_page=50`),
        github.request(args.repo, "ci", "GET", `commits/${target}/status`),
      ]);
      const checks = (runs.check_runs ?? []) as any[];
      const statuses = (status.statuses ?? []) as any[];
      return {
        state: status.state,
        // Said out loud: a failing check beyond the page would otherwise read as "all green".
        truncated: (runs.total_count ?? 0) > 50 || (status.total_count ?? 0) > 50,
        checks: checks.slice(0, 50).map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          summary: clip(c.output?.summary, 500),
          url: c.html_url,
        })),
        statuses: statuses.slice(0, 50).map((c) => ({
          context: c.context,
          state: c.state,
          description: clip(c.description, 200),
        })),
      };
    },
    /** The end of a GitHub Actions job's log. A check run's id is its job id. */
    async getJobLog(args: { repo: string; jobId: number }, resources: readonly string[]) {
      authorize(args.repo, "read", resources);
      issueNumber(args.jobId);
      await needing("actions-checks-statuses-read", () => github.auth.token(args.repo, "ci"));
      return { log: await github.tail(args.repo, "ci", `actions/jobs/${args.jobId}/logs`, 12_000) };
    },
    /**
     * Several files, deletions included, in one commit on a branch. The branch moves only if nobody
     * pushed in between. New files are regular files; to keep an executable bit use `writeFile`.
     */
    async commitFiles(
      args: {
        repo: string;
        branch: string;
        message: string;
        files: { path: string; content?: string; delete?: boolean }[];
      },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      ref(args.branch);
      text(args.message, 500);
      const files = args.files;
      if (!Array.isArray(files) || files.length < 1 || files.length > 50)
        throw new Error("invalid_files");
      const seen = new Set<string>();
      for (const f of files) {
        path(f.path);
        if (seen.has(f.path)) throw new Error("invalid_files");
        seen.add(f.path);
        if (f.delete === true ? f.content !== undefined : typeof f.content !== "string")
          throw new Error("invalid_files");
        if (f.content !== undefined && f.content.length > 100_000)
          throw new Error("invalid_content");
      }
      // Why not fold this into "write": a credential that can rewrite .github/workflows/ runs code with
      // the repository's secrets, so it needs its own grant, which ingress never hands out.
      const workflow = files.some((f) => f.path.startsWith(WORKFLOWS));
      if (workflow) {
        authorize(args.repo, "workflow", resources);
        await needing("workflows-write", () => github.auth.token(args.repo, "workflow"));
      }
      const access: GitHubAccess = workflow ? "workflow" : "write";
      const branch = branchPath(args.branch);
      const head = await github.request(args.repo, access, "GET", `git/ref/heads/${branch}`);
      sha(head.object?.sha ?? "");
      const commit = await github.request(
        args.repo,
        access,
        "GET",
        `git/commits/${head.object.sha}`,
      );
      sha(commit.tree?.sha ?? "");
      const tree = await github.request(args.repo, access, "POST", "git/trees", {
        base_tree: commit.tree.sha,
        tree: files.map((f) => ({
          path: f.path,
          // Why not preserve modes: the API needs one, and an unknown existing mode would be a guess.
          mode: "100644",
          type: "blob",
          ...(f.delete === true ? { sha: null } : { content: f.content }),
        })),
      });
      sha(tree.sha ?? "");
      const created = await github.request(args.repo, access, "POST", "git/commits", {
        message: args.message,
        tree: tree.sha,
        parents: [head.object.sha],
      });
      sha(created.sha ?? "");
      // 422 here means the branch moved since it was read; force stays off so nothing is overwritten.
      await github.request(args.repo, access, "PATCH", `git/refs/heads/${branch}`, {
        sha: created.sha,
        force: false,
      });
      return { commit: created.sha as string, files: files.length };
    },
    async updateIssue(
      args: {
        repo: string;
        number: number;
        title?: string;
        body?: string;
        state?: "open" | "closed";
        stateReason?: "completed" | "not_planned" | "reopened";
        labels?: string[];
        assignees?: string[];
      },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      issueNumber(args.number);
      if (args.title !== undefined) text(args.title, 256);
      if (args.body !== undefined && (typeof args.body !== "string" || args.body.length > 20_000))
        throw new Error("invalid_issue");
      if (args.state !== undefined && !["open", "closed"].includes(args.state))
        throw new Error("invalid_issue");
      if (
        args.stateReason !== undefined &&
        !["completed", "not_planned", "reopened"].includes(args.stateReason)
      )
        throw new Error("invalid_issue");
      labelNames(args.labels);
      logins(args.assignees, 10);
      const change = {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.state === undefined ? {} : { state: args.state }),
        ...(args.stateReason === undefined ? {} : { state_reason: args.stateReason }),
        ...(args.labels === undefined ? {} : { labels: args.labels }),
        ...(args.assignees === undefined ? {} : { assignees: args.assignees }),
      };
      if (!Object.keys(change).length) throw new Error("invalid_issue");
      const data = await github.request(
        args.repo,
        "write",
        "PATCH",
        `issues/${args.number}`,
        change,
      );
      return { number: data.number, state: data.state };
    },
    /** Add labels without touching the ones already there. */
    async addLabels(
      args: { repo: string; number: number; labels: string[] },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      issueNumber(args.number);
      labelNames(args.labels);
      if (!args.labels?.length) throw new Error("invalid_labels");
      await github.request(
        args.repo,
        "write",
        "POST",
        `issues/${args.number}/labels`,
        { labels: args.labels },
        true,
      );
      return { labels: args.labels.length };
    },
    async updatePullRequest(
      args: {
        repo: string;
        number: number;
        title?: string;
        body?: string;
        base?: string;
        state?: "open" | "closed";
      },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      issueNumber(args.number);
      if (args.title !== undefined) text(args.title, 256);
      if (args.body !== undefined && (typeof args.body !== "string" || args.body.length > 20_000))
        throw new Error("invalid_pull_request");
      if (args.base !== undefined) ref(args.base);
      if (args.state !== undefined && !["open", "closed"].includes(args.state))
        throw new Error("invalid_pull_request");
      const change = {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.base === undefined ? {} : { base: args.base }),
        ...(args.state === undefined ? {} : { state: args.state }),
      };
      if (!Object.keys(change).length) throw new Error("invalid_pull_request");
      const data = await github.request(
        args.repo,
        "write",
        "PATCH",
        `pulls/${args.number}`,
        change,
      );
      return { number: data.number, state: data.state };
    },
    async requestReviewers(
      args: { repo: string; number: number; reviewers?: string[]; teamReviewers?: string[] },
      resources: readonly string[],
    ) {
      authorize(args.repo, "write", resources);
      issueNumber(args.number);
      logins(args.reviewers, 15);
      logins(args.teamReviewers, 15);
      if (!args.reviewers?.length && !args.teamReviewers?.length) throw new Error("invalid_login");
      await github.request(args.repo, "write", "POST", `pulls/${args.number}/requested_reviewers`, {
        ...(args.reviewers?.length ? { reviewers: args.reviewers } : {}),
        ...(args.teamReviewers?.length ? { team_reviewers: args.teamReviewers } : {}),
      });
      return { requested: (args.reviewers?.length ?? 0) + (args.teamReviewers?.length ?? 0) };
    },
    /**
     * Status emoji on a comment: remove the App's own reaction, then add others. A signal for people,
     * so it never throws and a missing permission or an existing reaction is not an error.
     */
    async react(
      repo: string,
      target: ReactionTarget,
      change: { add?: string[]; remove?: string[] },
      ownLogin: string,
    ): Promise<void> {
      try {
        github.auth.installation(repo);
        if (!Number.isSafeInteger(target.id) || target.id <= 0 || !loginName(ownLogin)) return;
        const base = `${target.kind === "issue-comment" ? "issues" : "pulls"}/comments/${target.id}`;
        for (const content of (change.remove ?? []).filter((c) => REACTIONS.includes(c))) {
          const mine = await github.request(
            repo,
            "reply",
            "GET",
            `${base}/reactions?content=${encodeURIComponent(content)}&per_page=100`,
            undefined,
            true,
          );
          for (const r of mine as any[])
            if (String(r.user?.login).toLowerCase() === ownLogin.toLowerCase())
              await github.request(repo, "reply", "DELETE", `${base}/reactions/${r.id}`);
        }
        for (const content of (change.add ?? []).filter((c) => REACTIONS.includes(c)))
          await github.request(repo, "reply", "POST", `${base}/reactions`, { content });
      } catch {
        // Why not report: this is a signal for people sitting beside the real reply, and a failure
        // here (no permission, a deleted comment, a rate limit) must never fail or repeat that reply.
      }
    },
  };
}
const connectors = new WeakMap<object, ReturnType<typeof createConnector>>();
export function githubConnector(env: GitHubEnv) {
  let connector = connectors.get(env);
  if (!connector) {
    connector = createConnector(env);
    connectors.set(env, connector);
  }
  return connector;
}

export type SendResult =
  | { status: "delivered" }
  | { status: "retry" | "failed"; code: string; retryAfterMs?: number };
const record = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" ? (value as Record<string, any>) : {};

function retryDelay(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value !== null) {
    const ms = /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value) * 1000
      : Date.parse(value) - Date.now();
    if (Number.isFinite(ms)) return Math.min(3600000, Math.max(0, ms));
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (reset > 0) return Math.min(3600000, Math.max(0, reset * 1000 - Date.now()));
  return undefined;
}
async function sendReply(
  github: ReturnType<typeof createGitHubAppAuth>,
  repo: string,
  number: number,
  reviewComment: number | undefined,
  text: string,
  signal: AbortSignal,
): Promise<SendResult> {
  try {
    github.installation(repo);
  } catch {
    return { status: "failed", code: "repository_forbidden" };
  }
  let token: string;
  try {
    token = await github.token(repo, "reply");
  } catch (error) {
    const status = record(error).status;
    if (
      status === 429 ||
      (status === 403 && record(error).retryAfter !== undefined) ||
      (typeof status === "number" && status >= 500) ||
      (error instanceof Error && error.message === "github_transport_failed")
    )
      return {
        status: "retry",
        code: "github_auth_unavailable",
        retryAfterMs: retryDelay(
          new Headers({ "retry-after": String(record(error).retryAfter ?? "") }),
        ),
      };
    return { status: "failed", code: "github_auth_failed" };
  }
  // Bound UTF-8 bytes, not just JS characters; GitHub limits comment bodies to 65536 bytes.
  let body = "";
  let size = 0;
  for (const char of text) {
    size += new TextEncoder().encode(char).length;
    if (size > 60000) {
      body += "\n\n[Response truncated; see the session.]";
      break;
    }
    body += char;
  }
  let response: Response;
  try {
    response = await fetch(
      `${API}/repos/${repo}/${
        reviewComment === undefined ? `issues/${number}/comments` : `pulls/${number}/comments`
      }`,
      {
        method: "POST",
        redirect: "manual",
        signal,
        headers: { ...headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          ...(reviewComment === undefined ? {} : { in_reply_to: reviewComment }),
        }),
      },
    );
  } catch {
    return { status: "retry", code: "github_transport_failed" };
  }
  await response.body?.cancel();
  if (response.status === 201) return { status: "delivered" };
  if (response.status === 401) {
    github.invalidate(repo, "reply");
    return { status: "failed", code: "github_unauthorized" };
  }
  if (
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"))
  )
    return {
      status: "retry",
      code: "github_rate_or_server_error",
      retryAfterMs: retryDelay(response.headers),
    };
  return { status: "failed", code: "github_reply_rejected" };
}

if (import.meta.vitest) {
  const { vi, test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { generateKeyPairSync } = await import("node:crypto");

  const session = "github-thread";
  test("GitHub delivery bounds UTF-8 replies and classifies rate limits, vendor errors and App auth failures", async (t) => {
    const now = 1800000000000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let authError: { status?: number; retryAfter?: string; message?: string } | undefined;
    let tokenCalls = 0;
    const env = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      GITHUB_REPOSITORIES: '{"team/project":456}',
    };
    const connector = githubConnector(env);
    const context = {
      env,
      signal: new AbortController().signal,
      job: {
        trigger: "github",
        input: { sessionId: session, operationId: "reply", input: "Hello" },
        principal: { id: session, sessions: [session], resources: [] },
        reply: { repo: "team/project", number: 7 },
      },
      result: { text: "Answer" },
    };
    let response = new Response(null, { status: 201 });
    let transportFailure = false;
    let sends = 0;
    let expectedBody = "😀".repeat(15000) + "\n\n[Response truncated; see the session.]";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      assert.ok(typeof url === "string" && init);
      if (url.includes("/access_tokens")) {
        tokenCalls++;
        if (authError) {
          if (!authError.status) throw new TypeError("network unavailable");
          return new Response(null, {
            status: authError.status,
            headers: authError.retryAfter ? { "retry-after": authError.retryAfter } : {},
          });
        }
        return Response.json({
          token: "boundary-token",
          expires_at: new Date(now + 3600000).toISOString(),
        });
      }
      sends++;
      assert.equal(url, "https://api.github.com/repos/team/project/issues/7/comments");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer boundary-token");
      assert.deepEqual(
        JSON.parse(String(init.body)),
        { body: expectedBody },
        "Reply content preserves complete UTF-8 characters and includes a visible notice when truncated",
      );
      if (transportFailure) throw new TypeError("network unavailable");
      return response;
    });
    context.result.text = "😀".repeat(16000);
    assert.deepEqual(
      await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
      { status: "delivered" },
    );
    context.result.text = "Answer";
    expectedBody = "Answer";
    for (const [status, headers, delay] of [
      [429, { "retry-after": "2" }, 2000],
      [403, { "retry-after": "3" }, 3000],
      [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 45) }, 45000],
      [429, { "retry-after": new Date(now + 60000).toUTCString() }, 60000],
      [429, { "retry-after": "99999" }, 3600000],
      [503, {}, undefined],
    ] as const) {
      response = new Response(null, { status, headers: new Headers(headers) });
      assert.deepEqual(
        await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
        { status: "retry", code: "github_rate_or_server_error", retryAfterMs: delay },
        `HTTP ${status} must preserve its retry delay`,
      );
    }
    for (const status of [403, 404, 422]) {
      response = new Response(null, { status });
      assert.deepEqual(
        await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
        { status: "failed", code: "github_reply_rejected" },
      );
    }
    response = new Response(null, { status: 401 });
    assert.deepEqual(
      await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
      { status: "failed", code: "github_unauthorized" },
    );
    const beforeRefresh = tokenCalls;
    transportFailure = true;
    assert.deepEqual(
      await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
      { status: "retry", code: "github_transport_failed" },
    );
    assert.equal(tokenCalls, beforeRefresh + 1, "Unauthorized installation token is evicted");
    connector.auth.invalidate("team/project", "reply");
    const sendsBeforeAuthFailure = sends;
    authError = Object.assign(new Error("github_http_403"), { status: 403, retryAfter: "30" });
    assert.deepEqual(
      await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
      { status: "retry", code: "github_auth_unavailable", retryAfterMs: 30000 },
      "Secondary rate limits during App token acquisition preserve the retry delay, unlike ordinary auth 403s",
    );
    for (const error of [
      Object.assign(new Error("limited"), { status: 429, retryAfter: "4" }),
      Object.assign(new Error("upstream"), { status: 502 }),
      new Error("github_transport_failed"),
    ]) {
      authError = error;
      const result = await connector.reply(
        "team/project",
        7,
        undefined,
        context.result.text,
        context.signal,
      );
      assert.deepEqual(result, {
        status: "retry",
        code: "github_auth_unavailable",
        retryAfterMs: error.message === "limited" ? 4000 : undefined,
      });
    }
    for (const status of [401, 403, 404]) {
      authError = Object.assign(new Error("denied"), { status });
      assert.deepEqual(
        await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
        { status: "failed", code: "github_auth_failed" },
      );
    }
    assert.equal(
      sends,
      sendsBeforeAuthFailure,
      "App auth failures never send unauthenticated comments",
    );
  });
}

if (import.meta.vitest) {
  const { vi, test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { createServer } = await import("node:http");
  const { generateKeyPairSync, verify } = await import("node:crypto");
  const { once } = await import("node:events");

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = {
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    GITHUB_REPOSITORIES: JSON.stringify({ "team/project": 42 }),
  };
  const commit = "a".repeat(40);
  const updated = "b".repeat(40);
  function tools(
    resources = ["github:team/project:read", "github:team/project:write"],
    env: GitHubEnv = config,
  ) {
    return { connector: githubConnector(Object.assign(Object.create(null), env)), resources };
  }
  async function call(
    registered: ReturnType<typeof tools>,
    name: string,
    args: Record<string, unknown>,
  ) {
    const methods = {
      read_file: "readFile",
      create_branch: "createBranch",
      write_file: "writeFile",
      open_pull_request: "openPullRequest",
      get_issue: "getIssue",
      get_pull_request: "getPullRequest",
      create_issue: "createIssue",
    } as const;
    const method = methods[name as keyof typeof methods];
    return Reflect.apply(registered.connector[method], registered.connector, [
      args,
      registered.resources,
    ]);
  }

  // Real localhost HTTP; only routing of the external GitHub boundary is substituted.
  async function boundary(t: TestContext) {
    const requests: { path: string; method: string; body: any; authorization: string }[] = [];
    let status = 200;
    let tokenCalls = 0;
    let fileSha: string | null = commit;
    const branches = new Set<string>();
    let prs = 0;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      const path = req.url!;
      const authorization = req.headers.authorization ?? "";
      requests.push({ path, method: req.method!, body, authorization });
      res.setHeader("Content-Type", "application/json");
      function send(code: number, value: unknown) {
        res.statusCode = code;
        res.end(JSON.stringify(value));
      }
      if (path === "/app/installations/42/access_tokens") {
        tokenCalls++;
        return send(201, {
          token: `server-secret-${tokenCalls}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (status !== 200) {
        res.setHeader("Retry-After", "30");
        if (status === 302) res.setHeader("Location", "/must-not-follow");
        return send(status, { message: "server-secret-do-not-output" });
      }
      if (path === "/repos/team/project/contents/docs/hello.txt?ref=main" && req.method === "GET") {
        return send(200, {
          type: "file",
          encoding: "base64",
          content: Buffer.from("Hello \u4e16\u754c").toString("base64"),
          sha: fileSha,
        });
      }
      if (path === "/repos/team/project/git/refs" && req.method === "POST") {
        if (branches.has(body.ref)) return send(422, { message: "Reference already exists" });
        branches.add(body.ref);
        return send(201, { ref: body.ref, object: { sha: body.sha } });
      }
      if (path === "/repos/team/project/contents/docs/hello.txt" && req.method === "PUT") {
        if ((body.sha ?? null) !== fileSha) return send(409, { message: "stale SHA" });
        fileSha = updated;
        return send(200, { content: { sha: fileSha }, commit: { sha: updated } });
      }
      if (path === "/repos/team/project/pulls" && req.method === "POST") {
        if (prs) return send(422, { message: "A pull request already exists" });
        prs++;
        return send(201, { number: 7, token: "server-secret-do-not-output" });
      }
      if (path === "/repos/team/project/issues/7" && req.method === "GET")
        return send(200, {
          number: 7,
          title: "Fix the thing",
          state: "open",
          user: { login: "alice" },
          body: "x".repeat(25_000),
          labels: [{ name: "bug" }],
          comments: 120,
          pull_request: {},
        });
      if (
        path === "/repos/team/project/issues/7/comments?per_page=50&page=2" &&
        req.method === "GET"
      )
        return send(
          200,
          Array.from({ length: 50 }, (_, i) => ({
            id: 100 + i,
            user: { login: "bob" },
            body: "older",
          })),
        );
      if (
        path === "/repos/team/project/issues/7/comments?per_page=50&page=3" &&
        req.method === "GET"
      )
        return send(200, [
          { id: 1, user: { login: "bob" }, created_at: "t", body: "y".repeat(5_000) },
        ]);
      if (path === "/repos/team/project/pulls/7" && req.method === "GET")
        return send(200, {
          number: 7,
          title: "Fix the thing",
          state: "open",
          user: { login: "alice" },
          base: { ref: "main" },
          head: { ref: "fix", sha: commit },
          body: "b",
          changed_files: 2,
          review_comments: 1,
        });
      if (path === "/repos/team/project/pulls/7/files?per_page=100" && req.method === "GET")
        return send(200, [
          {
            filename: "a.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "p".repeat(9_000),
          },
          { filename: "b.png", status: "added", additions: 0, deletions: 0 },
        ]);
      if (
        path === "/repos/team/project/pulls/7/comments?per_page=50&page=1" &&
        req.method === "GET"
      )
        return send(200, [{ id: 9, user: { login: "carol" }, path: "a.ts", line: 3, body: "nit" }]);
      return send(404, { message: "unexpected route" });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      assert.ok(typeof input === "string" && init);
      const url = new URL(input);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(init.redirect, "manual");
      return realFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
    });
    t.onTestFinished(() => {
      server.closeAllConnections();
      server.close();
    });
    return {
      requests,
      setStatus: (value: number) => {
        status = value;
      },
      newFile: () => {
        fileSha = null;
      },
    };
  }

  test("authorized file → branch → optimistic file update → PR uses signed, repo-scoped cached credentials", async (t) => {
    const http = await boundary(t);
    const registered = tools();
    const file = await call(registered, "read_file", {
      repo: "team/project",
      path: "docs/hello.txt",
      ref: "main",
    });
    assert.deepEqual(file, { sha: commit, content: "Hello \u4e16\u754c" });
    await call(registered, "read_file", {
      repo: "team/project",
      path: "docs/hello.txt",
      ref: "main",
    });
    assert.deepEqual(
      await call(registered, "create_branch", {
        repo: "team/project",
        branch: "agent/change",
        sha: file.sha,
      }),
      { ref: "refs/heads/agent/change", sha: commit },
    );
    assert.deepEqual(
      await call(registered, "write_file", {
        repo: "team/project",
        branch: "agent/change",
        path: "docs/hello.txt",
        expectedSha: file.sha,
        message: "Update greeting",
        content: "New \u4e16\u754c",
      }),
      { sha: updated, commit: updated },
    );
    assert.deepEqual(
      await call(registered, "open_pull_request", {
        repo: "team/project",
        head: "agent/change",
        base: "main",
        title: "Greeting",
        body: "Update greeting",
      }),
      { number: 7 },
    );
    const tokens = http.requests.filter((r) => r.path.endsWith("/access_tokens"));
    assert.equal(tokens.length, 2, "read/write credentials must be distinct and cached");
    assert.deepEqual(
      tokens.map((r) => r.body),
      [
        {
          repositories: ["project"],
          permissions: { contents: "read", issues: "read", pull_requests: "read" },
        },
        {
          repositories: ["project"],
          permissions: { contents: "write", issues: "write", pull_requests: "write" },
        },
      ],
    );
    const jwt = tokens[0].authorization.slice(7).split(".");
    assert.equal(
      verify(
        "RSA-SHA256",
        Buffer.from(`${jwt[0]}.${jwt[1]}`),
        publicKey,
        Buffer.from(jwt[2], "base64url"),
      ),
      true,
    );
    assert.deepEqual(JSON.parse(Buffer.from(jwt[0], "base64url").toString()), {
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(jwt[1], "base64url").toString());
    assert.equal(claims.iss, "123");
    assert.equal(claims.exp - claims.iat, 600);
    assert.ok(claims.iat <= Date.now() / 1000 && claims.exp > Date.now() / 1000);
    const write = http.requests.find((r) => r.method === "PUT")!;
    assert.equal(write.body.sha, commit);
    assert.equal(write.body.branch, "agent/change");
    assert.equal(Buffer.from(write.body.content, "base64").toString(), "New \u4e16\u754c");
    assert.equal(http.requests.at(-1)!.authorization, "Bearer server-secret-2");
  });

  test("branch and PR retries do not mutate existing resources; stale and create-only writes fail", async (t) => {
    const http = await boundary(t);
    const registered = tools();
    const branch = { repo: "team/project", branch: "agent/change", sha: commit };
    await call(registered, "create_branch", branch);
    await assert.rejects(call(registered, "create_branch", branch), /github_http_422/);
    const write = {
      repo: "team/project",
      branch: "agent/change",
      path: "docs/hello.txt",
      expectedSha: commit,
      content: "New",
      message: "Update",
    };
    await assert.rejects(
      call(registered, "write_file", { ...write, expectedSha: null }),
      /github_http_409/,
    );
    await call(registered, "write_file", write);
    await assert.rejects(call(registered, "write_file", write), /github_http_409/);
    const pr = {
      repo: "team/project",
      head: "agent/change",
      base: "main",
      title: "Change",
      body: "",
    };
    await call(registered, "open_pull_request", pr);
    await assert.rejects(call(registered, "open_pull_request", pr), /github_http_422/);
    http.newFile();
    assert.deepEqual(await call(registered, "write_file", { ...write, expectedSha: null }), {
      sha: updated,
      commit: updated,
    });
    assert.equal(Object.hasOwn(http.requests.at(-1)!.body, "sha"), false);
  });

  test("scope and malformed repo/path/ref fail before any external HTTP", async (t) => {
    const http = await boundary(t);
    const read = { repo: "team/project", path: "docs/hello.txt", ref: "main" };
    await assert.rejects(call(tools([]), "read_file", read), /github_forbidden/);
    await assert.rejects(
      call(tools(["github:team/project:read"]), "create_branch", {
        repo: "team/project",
        branch: "change",
        sha: commit,
      }),
      /github_forbidden/,
    );
    await assert.rejects(
      call(tools(["github:other/repo:read"]), "read_file", { ...read, repo: "other/repo" }),
      /repository_forbidden/,
    );
    for (const repo of [
      "https://evil.test/repo",
      "team/project/../other",
      "team/..",
      "team/project?evil",
    ]) {
      await assert.rejects(call(tools(), "read_file", { ...read, repo }), /invalid_repository/);
    }
    for (const path of [
      "../secret",
      "/secret",
      "a//b",
      "a/%2e%2e/b",
      "a\\b",
      ".git/config",
      "file?ref=other",
      "a\0b",
    ]) {
      await assert.rejects(call(tools(), "read_file", { ...read, path }), /invalid_path/);
    }
    for (const ref of ["../main", "a..b", "a.lock", "/main", "a//b", "a@{1}", "a?x", "a/.hidden"]) {
      await assert.rejects(call(tools(), "read_file", { ...read, ref }), /invalid_ref/);
    }
    await assert.rejects(
      call(tools(), "create_branch", { repo: "team/project", branch: "change", sha: "not-a-sha" }),
      /invalid_sha/,
    );
    await assert.rejects(
      call(tools(), "write_file", {
        repo: "team/project",
        branch: "change",
        path: "valid",
        expectedSha: commit,
        message: "Update",
        content: "x".repeat(100_001),
      }),
      /invalid_content/,
    );
    await assert.rejects(call(tools(undefined, {}), "read_file", read), /github_unconfigured/);
    assert.equal(http.requests.length, 0);
  });

  test("401 invalidates credentials without replay; redirects and 403/409/429 fail sanitized without following or retrying", async (t) => {
    const http = await boundary(t);
    const registered = tools();
    for (const status of [401, 302, 403, 409, 429]) {
      http.setStatus(status);
      const before = http.requests.filter((r) => r.path.includes("/contents/")).length;
      await assert.rejects(
        call(registered, "write_file", {
          repo: "team/project",
          branch: "change",
          path: "docs/hello.txt",
          expectedSha: commit,
          message: "Update",
          content: "New",
        }),
        (error: unknown) => {
          assert.ok(error instanceof GitHubError);
          assert.equal(error.message, `github_http_${status}`);
          assert.equal(error.status, status);
          assert.equal(error.retryAfter, "30");
          return true;
        },
      );
      assert.equal(http.requests.filter((r) => r.path.includes("/contents/")).length, before + 1);
    }
    assert.equal(
      http.requests.filter((r) => r.path.endsWith("/access_tokens")).length,
      2,
      "only 401 invalidates the token",
    );
  });

  test("Connector auth refreshes expiring cached tokens and fails closed on bad key/config", async (t) => {
    const http = await boundary(t);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const auth = createGitHubAppAuth(config);
    assert.equal(await auth.token("team/project"), "server-secret-1");
    assert.equal(await auth.token("team/project"), "server-secret-1");
    now += 3_550_000;
    assert.equal(await auth.token("team/project"), "server-secret-2");
    assert.equal(http.requests.length, 2);
    await assert.rejects(
      createGitHubAppAuth({ ...config, GITHUB_APP_PRIVATE_KEY: "secret-invalid-key" }).token(
        "team/project",
      ),
      /github_auth_failed/,
    );
    await assert.rejects(
      createGitHubAppAuth({ ...config, GITHUB_REPOSITORIES: "{" }).token("team/project"),
      /github_unconfigured/,
    );
    assert.equal(http.requests.length, 2, "invalid configuration must not contact GitHub");
    assert.equal(await auth.token("team/project", "reply"), "server-secret-3");
    assert.deepEqual(http.requests[2].body, {
      repositories: ["project"],
      permissions: { issues: "write", pull_requests: "write" },
    });
    assert.equal(await auth.token("team/project", "reply"), "server-secret-3");
    assert.equal(http.requests.length, 3, "Reply credentials must be scoped separately and cached");
  });

  test("an owner wildcard covers the whole organization, and an exact entry overrides it", () => {
    const auth = createGitHubAppAuth({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "unused",
      GITHUB_REPOSITORIES: JSON.stringify({ "acme/*": 7, "acme/special": 9 }),
    });
    assert.equal(auth.installation("acme/anything"), 7);
    assert.equal(auth.installation("acme/special"), 9);
    assert.throws(() => auth.installation("other/anything"), /repository_forbidden/);
  });

  test("issue and pull request reads are bounded, take the latest comments, and need read access", async (t) => {
    await boundary(t);
    const registered = tools(["github:team/project:read"]);
    const issue = await call(registered, "get_issue", { repo: "team/project", number: 7 });
    assert.equal(issue.title, "Fix the thing");
    assert.equal(issue.isPullRequest, true);
    assert.deepEqual(issue.labels, ["bug"]);
    assert.equal(issue.body.length, 20_000);
    assert.equal(issue.commentCount, 120);
    assert.equal(issue.comments.length, 50, "the short last page is topped up from the one before");
    assert.equal(issue.comments.at(-1).id, 1, "the newest comment is last");
    assert.equal(issue.comments.at(-1).body.length, 4_000);
    const pr = await call(registered, "get_pull_request", { repo: "team/project", number: 7 });
    assert.equal(pr.base, "main");
    assert.equal(pr.headSha, commit);
    assert.equal(pr.files[0].patch.length, 4_000, "one patch is capped");
    assert.equal(pr.files[1].patch, "", "binary files have no patch");
    assert.deepEqual(pr.reviewComments, [
      { id: 9, author: "carol", path: "a.ts", line: 3, inReplyTo: null, body: "nit" },
    ]);
    await assert.rejects(
      call(tools([]), "get_issue", { repo: "team/project", number: 7 }),
      /github_forbidden/,
    );
    await assert.rejects(
      call(registered, "get_issue", { repo: "team/project", number: 0 }),
      /invalid_number/,
    );
  });

  test("an owner wildcard grant covers that owner's repositories for its own access level only", async (t) => {
    await boundary(t);
    const read = tools(["github:team/*:read"]);
    assert.equal((await call(read, "get_issue", { repo: "team/project", number: 7 })).number, 7);
    await assert.rejects(
      call(read, "create_issue", { repo: "team/project", title: "t", body: "b" }),
      /github_forbidden/,
      "a read wildcard must not allow writes",
    );
    await assert.rejects(
      call(tools(["github:other/*:read"]), "get_issue", { repo: "team/project", number: 7 }),
      /github_forbidden/,
      "another owner's wildcard must not match",
    );
  });
}

if (import.meta.vitest) {
  const { vi, test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { generateKeyPairSync } = await import("node:crypto");

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config: GitHubEnv = {
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    GITHUB_REPOSITORIES: JSON.stringify({ "team/*": 42 }),
  };
  const resources = ["github:team/*:read", "github:team/*:write"];
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);

  type Handler = (body: any) => unknown;
  /** A fake GitHub: routes by "METHOD /path?query", records calls and the permissions each token asked for. */
  function github(routes: Record<string, Handler>) {
    const calls: { key: string; body: any; authorization: string | null }[] = [];
    const permissions: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname === "/app/installations/42/access_tokens") {
        permissions.push(body.permissions);
        return Response.json(
          {
            token: `t${permissions.length}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          { status: 201 },
        );
      }
      const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
      calls.push({ key, body, authorization: new Headers(init?.headers).get("authorization") });
      const handler = routes[key];
      if (!handler) return new Response("{}", { status: 404 });
      const out = handler(body);
      return out instanceof Response ? out : Response.json(out);
    });
    const connector = githubConnector(Object.assign(Object.create(null), config));
    return { connector, calls, permissions };
  }

  test("a review carries a decision, inline comments on lines, and a pinned commit", async () => {
    const { connector, calls } = github({
      "POST /repos/team/project/pulls/7/reviews": () => ({ id: 11 }),
    });
    const out = await connector.reviewPullRequest(
      {
        repo: "team/project",
        number: 7,
        event: "REQUEST_CHANGES",
        body: "Two things.",
        commitId: A,
        comments: [
          { path: "src/a.ts", line: 10, body: "Null here." },
          { path: "src/b.ts", line: 20, startLine: 18, side: "LEFT", body: "Why removed?" },
        ],
      },
      resources,
    );
    assert.deepEqual(out, { id: 11 });
    assert.deepEqual(calls[0].body, {
      event: "REQUEST_CHANGES",
      body: "Two things.",
      commit_id: A,
      comments: [
        { path: "src/a.ts", line: 10, side: "RIGHT", body: "Null here." },
        {
          path: "src/b.ts",
          line: 20,
          side: "LEFT",
          start_line: 18,
          start_side: "LEFT",
          body: "Why removed?",
        },
      ],
    });
  });

  test("review input is validated before any request", async () => {
    const { connector, calls } = github({});
    const review = (extra: object) =>
      connector.reviewPullRequest(
        { repo: "team/project", number: 7, event: "COMMENT", body: "x", ...extra },
        resources,
      );
    await assert.rejects(review({ body: "" }), /invalid_text/, "a bare COMMENT needs a body");
    await assert.rejects(review({ commitId: "nope" }), /invalid_sha/);
    await assert.rejects(
      review({ comments: [{ path: "a", line: 5, startLine: 5, body: "x" }] }),
      /invalid_review/,
    );
    await assert.rejects(
      review({ comments: [{ path: "a", line: 5, side: "UP", body: "x" }] }),
      /invalid_review/,
    );
    await assert.rejects(
      review({ comments: [{ path: "../a", line: 5, body: "x" }] }),
      /invalid_path/,
    );
    await assert.rejects(
      review({ comments: Array.from({ length: 51 }, () => ({ path: "a", line: 1, body: "x" })) }),
      /invalid_review/,
    );
    await assert.rejects(review({ event: "MERGE" }), /invalid_review/);
    assert.equal(calls.length, 0);
  });

  test("an approval may be empty, and inline comments can stand in for the body", async () => {
    const { connector, calls } = github({
      "POST /repos/team/project/pulls/7/reviews": () => ({ id: 1 }),
    });
    await connector.reviewPullRequest(
      { repo: "team/project", number: 7, event: "APPROVE", body: "" },
      resources,
    );
    await connector.reviewPullRequest(
      {
        repo: "team/project",
        number: 7,
        event: "COMMENT",
        body: "",
        comments: [{ path: "a.ts", line: 1, body: "x" }],
      },
      resources,
    );
    assert.deepEqual(
      calls.map((call) => [call.body.event, call.body.body, call.body.comments?.length ?? 0]),
      [
        ["APPROVE", "", 0],
        ["COMMENT", "", 1],
      ],
    );
  });

  test("replying in a review thread targets that comment", async () => {
    const { connector, calls } = github({
      "POST /repos/team/project/pulls/7/comments/99/replies": () => ({ id: 100 }),
    });
    assert.deepEqual(
      await connector.replyReviewComment(
        { repo: "team/project", number: 7, commentId: 99, body: "Fixed." },
        resources,
      ),
      { id: 100 },
    );
    assert.deepEqual(calls[0].body, { body: "Fixed." });
  });

  test("directories can be listed and code searched inside the one repository", async () => {
    const { connector, calls } = github({
      "GET /repos/team/project/contents/src?ref=main": () => [
        { name: "a.ts", path: "src/a.ts", type: "file", size: 10, sha: A },
        { name: "lib", path: "src/lib", type: "dir", size: 0 },
      ],
      "GET /search/code?q=orderAvailable%20repo%3Ateam%2Fproject&per_page=20": () => ({
        total_count: 1,
        items: [{ path: "src/a.ts", name: "a.ts", score: 1 }],
      }),
    });
    assert.deepEqual(
      await connector.listFiles({ repo: "team/project", path: "src", ref: "main" }, resources),
      {
        truncated: false,
        entries: [
          { name: "a.ts", path: "src/a.ts", type: "file", size: 10 },
          { name: "lib", path: "src/lib", type: "dir", size: 0 },
        ],
      },
    );
    assert.deepEqual(
      await connector.searchCode({ repo: "team/project", query: "orderAvailable" }, resources),
      {
        total: 1,
        items: [{ path: "src/a.ts", name: "a.ts" }],
      },
    );
    await assert.rejects(
      connector.searchCode({ repo: "team/project", query: "a\nb" }, resources),
      /invalid_text/,
    );
    for (const widened of ["x org:other", "x repo:other/y", "x -user:me"])
      await assert.rejects(
        connector.searchCode({ repo: "team/project", query: widened }, resources),
        /invalid_text/,
        widened,
      );
    assert.equal(calls.length, 2);
  });

  test("checks and job logs use a credential scoped to CI reads, and the log link never sees it", async () => {
    const { connector, calls, permissions } = github({
      "GET /repos/team/project/commits/feature/check-runs?per_page=50": () => ({
        check_runs: [
          {
            id: 9,
            name: "test",
            status: "completed",
            conclusion: "failure",
            output: { summary: "1 failed" },
            html_url: "u",
          },
        ],
      }),
      "GET /repos/team/project/commits/feature/status": () => ({
        state: "failure",
        statuses: [{ context: "ci/x", state: "failure", description: "no" }],
      }),
      "GET /repos/team/project/actions/jobs/9/logs": () =>
        new Response(null, { status: 302, headers: { location: "https://logs.example/blob/xyz" } }),
      "GET /blob/xyz": () => new Response(`${"x".repeat(20_000)}\nTAIL`),
    });
    const checks = await connector.getChecks({ repo: "team/project", ref: "feature" }, resources);
    assert.equal(checks.state, "failure");
    assert.equal(checks.checks[0].conclusion, "failure");
    const log = await connector.getJobLog({ repo: "team/project", jobId: 9 }, resources);
    assert.equal(log.log.length, 12_000);
    assert.ok(log.log.endsWith("\nTAIL"));
    assert.deepEqual(permissions, [{ actions: "read", checks: "read", statuses: "read" }]);
    const download = calls.find((call) => call.key === "GET /blob/xyz");
    assert.equal(
      download?.authorization,
      null,
      "the pre-signed download must not receive the token",
    );
  });

  test("several files, deletions included, go in one commit that only fast-forwards the branch", async () => {
    const { connector, calls, permissions } = github({
      "GET /repos/team/project/git/ref/heads/fix/x": () => ({ object: { sha: A } }),
      [`GET /repos/team/project/git/commits/${A}`]: () => ({ tree: { sha: B } }),
      "POST /repos/team/project/git/trees": () => ({ sha: C }),
      "POST /repos/team/project/git/commits": () => ({ sha: "d".repeat(40) }),
      "PATCH /repos/team/project/git/refs/heads/fix/x": () => ({}),
    });
    const out = await connector.commitFiles(
      {
        repo: "team/project",
        branch: "fix/x",
        message: "Fix",
        files: [
          { path: "a.ts", content: "1" },
          { path: "old.ts", delete: true },
        ],
      },
      resources,
    );
    assert.deepEqual(out, { commit: "d".repeat(40), files: 2 });
    assert.deepEqual(calls[2].body, {
      base_tree: B,
      tree: [
        { path: "a.ts", mode: "100644", type: "blob", content: "1" },
        { path: "old.ts", mode: "100644", type: "blob", sha: null },
      ],
    });
    assert.deepEqual(calls[3].body, { message: "Fix", tree: C, parents: [A] });
    assert.deepEqual(calls[4].body, { sha: "d".repeat(40), force: false });
    assert.deepEqual(permissions, [{ contents: "write", issues: "write", pull_requests: "write" }]);
  });

  test("workflow files need their own grant, and then get the Workflows credential, and nothing else does", async () => {
    const { connector, permissions } = github({
      "GET /repos/team/project/git/ref/heads/b": () => ({ object: { sha: A } }),
      [`GET /repos/team/project/git/commits/${A}`]: () => ({ tree: { sha: B } }),
      "POST /repos/team/project/git/trees": () => ({ sha: C }),
      "POST /repos/team/project/git/commits": () => ({ sha: "d".repeat(40) }),
      "PATCH /repos/team/project/git/refs/heads/b": () => ({}),
    });
    const workflowFile = {
      repo: "team/project",
      branch: "b",
      message: "ci",
      files: [{ path: ".github/workflows/ci.yml", content: "on: push" }],
    };
    await assert.rejects(connector.commitFiles(workflowFile, resources), /github_forbidden/);
    assert.deepEqual(permissions, [], "no credential is minted without the grant");
    await connector.commitFiles(workflowFile, [...resources, "github:team/*:workflow"]);
    assert.deepEqual(permissions, [{ contents: "write", workflows: "write" }]);
  });

  test("a commit is refused when the branch moved, and bad file lists never reach GitHub", async () => {
    const { connector, calls } = github({
      "GET /repos/team/project/git/ref/heads/b": () => ({ object: { sha: A } }),
      [`GET /repos/team/project/git/commits/${A}`]: () => ({ tree: { sha: B } }),
      "POST /repos/team/project/git/trees": () => ({ sha: C }),
      "POST /repos/team/project/git/commits": () => ({ sha: "d".repeat(40) }),
      "PATCH /repos/team/project/git/refs/heads/b": () => new Response("{}", { status: 422 }),
    });
    const commit = (files: unknown) =>
      connector.commitFiles(
        { repo: "team/project", branch: "b", message: "m", files: files as never },
        resources,
      );
    await assert.rejects(commit([{ path: "a", content: "1" }]), { status: 422 });
    const before = calls.length;
    await assert.rejects(commit([]), /invalid_files/);
    await assert.rejects(
      commit([
        { path: "a", content: "1" },
        { path: "a", content: "2" },
      ]),
      /invalid_files/,
    );
    await assert.rejects(commit([{ path: "a" }]), /invalid_files/);
    await assert.rejects(commit([{ path: "a", delete: true, content: "x" }]), /invalid_files/);
    await assert.rejects(commit([{ path: "../a", content: "x" }]), /invalid_path/);
    assert.equal(calls.length, before);
  });

  test("issues and pull requests can be edited, labelled and given reviewers", async () => {
    const { connector, calls } = github({
      "PATCH /repos/team/project/issues/7": () => ({ number: 7, state: "closed" }),
      "POST /repos/team/project/issues/7/labels": () => [],
      "PATCH /repos/team/project/pulls/8": () => ({ number: 8, state: "open" }),
      "POST /repos/team/project/pulls/8/requested_reviewers": () => ({}),
    });
    assert.deepEqual(
      await connector.updateIssue(
        {
          repo: "team/project",
          number: 7,
          state: "closed",
          stateReason: "not_planned",
          labels: ["wontfix"],
          assignees: ["alice"],
        },
        resources,
      ),
      { number: 7, state: "closed" },
    );
    assert.deepEqual(calls[0].body, {
      state: "closed",
      state_reason: "not_planned",
      labels: ["wontfix"],
      assignees: ["alice"],
    });
    await connector.addLabels({ repo: "team/project", number: 7, labels: ["bug"] }, resources);
    assert.deepEqual(calls[1].body, { labels: ["bug"] });
    await connector.updatePullRequest(
      { repo: "team/project", number: 8, title: "T", base: "main" },
      resources,
    );
    assert.deepEqual(calls[2].body, { title: "T", base: "main" });
    await connector.requestReviewers(
      { repo: "team/project", number: 8, reviewers: ["bob"], teamReviewers: ["core"] },
      resources,
    );
    assert.deepEqual(calls[3].body, { reviewers: ["bob"], team_reviewers: ["core"] });
    const bad = (run: Promise<unknown>, pattern: RegExp) => assert.rejects(run, pattern);
    await bad(
      connector.updateIssue({ repo: "team/project", number: 7 }, resources),
      /invalid_issue/,
    );
    await bad(
      connector.updateIssue(
        { repo: "team/project", number: 7, assignees: ["bad login"] },
        resources,
      ),
      /invalid_login/,
    );
    await bad(
      connector.addLabels({ repo: "team/project", number: 7, labels: [] }, resources),
      /invalid_labels/,
    );
    await bad(
      connector.updatePullRequest({ repo: "team/project", number: 8 }, resources),
      /invalid_pull_request/,
    );
    await bad(
      connector.requestReviewers({ repo: "team/project", number: 8 }, resources),
      /invalid_login/,
    );
    assert.equal(calls.length, 4);
  });

  test("all of it needs the matching grant: reads for reading, writes for changing", async () => {
    const { connector, calls } = github({});
    const read = ["github:team/*:read"];
    await assert.rejects(
      connector.commitFiles(
        { repo: "team/project", branch: "b", message: "m", files: [{ path: "a", content: "1" }] },
        read,
      ),
      /github_forbidden/,
    );
    await assert.rejects(
      connector.updateIssue({ repo: "team/project", number: 1, title: "t" }, read),
      /github_forbidden/,
    );
    await assert.rejects(
      connector.replyReviewComment(
        { repo: "team/project", number: 1, commentId: 1, body: "x" },
        read,
      ),
      /github_forbidden/,
    );
    await assert.rejects(
      connector.listFiles({ repo: "team/project" }, ["github:team/*:write"]),
      /github_forbidden/,
    );
    assert.equal(calls.length, 0);
  });

  test("reactions swap the App's own emoji, leave other people's, and never throw", async () => {
    const { connector, calls } = github({
      "GET /repos/team/project/issues/comments/55/reactions?content=eyes&per_page=100": () => [
        { id: 1, user: { login: "touka-ai[bot]" } },
        { id: 2, user: { login: "alice" } },
      ],
      "DELETE /repos/team/project/issues/comments/55/reactions/1": () =>
        new Response(null, { status: 204 }),
      "POST /repos/team/project/issues/comments/55/reactions": () => ({}),
    });
    await connector.react(
      "team/project",
      { kind: "issue-comment", id: 55 },
      { remove: ["eyes"], add: ["rocket"] },
      "touka-ai[bot]",
    );
    assert.deepEqual(
      calls.map((call) => call.key),
      [
        "GET /repos/team/project/issues/comments/55/reactions?content=eyes&per_page=100",
        "DELETE /repos/team/project/issues/comments/55/reactions/1",
        "POST /repos/team/project/issues/comments/55/reactions",
      ],
    );
    assert.deepEqual(calls[2].body, { content: "rocket" });
    // Review comments live under pulls/, an unknown emoji is dropped, and a failing GitHub is not an error.
    calls.length = 0;
    await connector.react(
      "team/project",
      { kind: "review-comment", id: 7 },
      { add: ["rocket", "not-an-emoji"] },
      "touka-ai[bot]",
    );
    assert.deepEqual(
      calls.map((call) => call.key),
      ["POST /repos/team/project/pulls/comments/7/reactions"],
    );
  });

  test("a missing App permission is reported by name, but a real API 422 is not mistaken for one", async () => {
    const mint422 = (input: RequestInfo | URL) => String(input).endsWith("/access_tokens");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      mint422(input)
        ? Response.json({ message: "permissions not granted" }, { status: 422 })
        : new Response("{}", { status: 404 }),
    );
    const connector = githubConnector(Object.assign(Object.create(null), config));
    await assert.rejects(
      connector.getChecks({ repo: "team/project", ref: "main" }, resources),
      /github_app_lacks_permission:actions-checks-statuses-read/,
    );
    await assert.rejects(
      connector.commitFiles(
        {
          repo: "team/project",
          branch: "b",
          message: "m",
          files: [{ path: ".github/workflows/x.yml", content: "on: push" }],
        },
        [...resources, "github:team/*:workflow"],
      ),
      /github_app_lacks_permission:workflows-write/,
    );
    vi.restoreAllMocks();
    // Tokens are fine now; GitHub itself answers 422 (unknown ref, branch moved): that must reach the model unchanged.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      mint422(input)
        ? Response.json(
            { token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            { status: 201 },
          )
        : new Response("{}", { status: 422 }),
    );
    const healthy = githubConnector(Object.assign(Object.create(null), config));
    await assert.rejects(healthy.getChecks({ repo: "team/project", ref: "nope" }, resources), {
      status: 422,
    });
    await assert.rejects(
      healthy.commitFiles(
        {
          repo: "team/project",
          branch: "b",
          message: "m",
          files: [{ path: ".github/workflows/x.yml", content: "x" }],
        },
        [...resources, "github:team/*:workflow"],
      ),
      { status: 422 },
    );
  });
}
