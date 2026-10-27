import { createPrivateKey, sign, type KeyObject } from "node:crypto";
// Server-only capability seam: adapters may obtain scoped App credentials, never expose them to a model.
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

export function createGitHubClient(env: GitHubEnv) {
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
      // This helper is module-private to tools; callers never supply arbitrary API URLs.
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
