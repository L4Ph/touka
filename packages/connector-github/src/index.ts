import { createPrivateKey, sign, type KeyObject } from "node:crypto";
// Server-only credentials; Tools expose operations, never tokens, to the model.
export interface GitHubEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** JSON object mapping exact owner/repo names to numeric installation IDs. */
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

export type GitHubAccess = "read" | "write" | "reply";
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
    const id = Object.hasOwn(repos, repo) ? (repos as Record<string, unknown>)[repo] : undefined;
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
  async function token(repo: string, access: GitHubAccess = "read"): Promise<string> {
    const id = installation(repo);
    if (!["read", "write", "reply"].includes(access)) throw new Error("github_invalid_permissions");
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
        permissions:
          access === "reply"
            ? { issues: "write", pull_requests: "write" }
            : {
                contents: access === "write" ? "write" : "read",
                ...(access === "write" ? { pull_requests: "write" } : {}),
              },
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
async function json(response: Response): Promise<Record<string, any>> {
  if (!response.ok) {
    await response.body?.cancel();
    const retry = response.headers.get("retry-after");
    throw new GitHubError(response.status, retry && /^\d{1,6}$/.test(retry) ? retry : undefined);
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
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, any>;
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
      write: boolean,
      method: "GET" | "POST" | "PUT",
      suffix: string,
      body?: unknown,
    ) {
      // Fixed operations below are the only callers; no arbitrary API URL is public.
      const token = await auth.token(repo, write ? "write" : "read");
      const response = await fetch(`${API}/repos/${repo}/${suffix}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: headers(token),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).catch(() => {
        throw new Error("github_transport_failed");
      });
      if (response.status === 401) auth.invalidate(repo, write ? "write" : "read");
      return json(response);
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
function text(value: string, max: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error("invalid_text");
}

function createConnector(env: GitHubEnv) {
  const github = createGitHubClient(env);
  function authorize(repo: string, write: boolean, resources: readonly string[]) {
    validateRepo(repo);
    if (!resources.includes(`github:${repo}:${write ? "write" : "read"}`))
      throw new Error("github_forbidden");
    github.auth.installation(repo);
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
      authorize(args.repo, false, resources);
      ref(args.ref);
      const data = await github.request(
        args.repo,
        false,
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
      authorize(args.repo, true, resources);
      ref(args.branch);
      sha(args.sha);
      const data = await github.request(args.repo, true, "POST", "git/refs", {
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
      authorize(args.repo, true, resources);
      ref(args.branch);
      text(args.message, 500);
      if (args.expectedSha !== null) sha(args.expectedSha);
      if (typeof args.content !== "string" || args.content.length > 100_000)
        throw new Error("invalid_content");
      const bytes = new TextEncoder().encode(args.content);
      // Avoid spreading large files onto the JS stack.
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const data = await github.request(args.repo, true, "PUT", `contents/${path(args.path)}`, {
        branch: args.branch,
        message: args.message,
        content: btoa(binary),
        ...(args.expectedSha === null ? {} : { sha: args.expectedSha }),
      });
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
      authorize(args.repo, true, resources);
      ref(args.head);
      ref(args.base);
      text(args.title, 256);
      if (args.head === args.base || typeof args.body !== "string" || args.body.length > 20_000)
        throw new Error("invalid_pull_request");
      const data = await github.request(args.repo, true, "POST", "pulls", {
        head: args.head,
        base: args.base,
        title: args.title,
        body: args.body,
      });
      if (!Number.isSafeInteger(data.number) || data.number <= 0)
        throw new Error("github_invalid_response");
      return { number: data.number };
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
      `https://api.github.com/repos/${repo}/${
        reviewComment === undefined ? `issues/${number}/comments` : `pulls/${number}/comments`
      }`,
      {
        method: "POST",
        redirect: "manual",
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "remote-agent",
        },
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
