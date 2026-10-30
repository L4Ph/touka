import type { GitHubAccess } from "@remote-agent/connector-github";

/** What a container may do on GitHub: the caller's `github:<repo|owner/*>:<level>` resources. */
export interface EgressProps {
  resources: readonly string[];
}

export type Decision =
  | { kind: "anonymous" }
  | { kind: "deny"; reason: string }
  | { kind: "token"; repo: string; access: GitHubAccess; scheme: "Bearer" | "Basic" };

const READ = new Set(["GET", "HEAD"]);
const CI_PATH =
  /^\/(actions|check-runs|check-suites|statuses?)(\/|$)|^\/commits\/[^/]+\/(status|statuses|check-runs|check-suites)(\/|$)/;

const granted = (resources: readonly string[], repo: string, level: string) =>
  resources.includes(`github:${repo}:${level}`) ||
  resources.includes(`github:${repo.split("/")[0]}/*:${level}`);

/**
 * Decide how one request from the container to GitHub is treated. A repository the caller holds no
 * grant for is reachable only as the public internet would be: reads without a credential, and no
 * writes. Hosts other than GitHub's are not this function's business.
 */
export function decide(request: { method: string; url: string }, props: EgressProps): Decision {
  const url = new URL(request.url);
  const path = url.pathname;
  const read = READ.has(request.method);
  let repo: string | undefined;
  let rest = "";
  let scheme: "Bearer" | "Basic" = "Basic";
  let access: GitHubAccess = read ? "read" : "write";
  if (url.hostname === "api.github.com") {
    scheme = "Bearer";
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (match) {
      repo = `${match[1]}/${match[2]}`;
      rest = match[3] ?? "";
      if (read && CI_PATH.test(rest)) access = "ci";
      else if (!read && rest.startsWith("/contents/.github/workflows/")) access = "workflow";
    }
  } else if (url.hostname === "github.com" || url.hostname === "codeload.github.com") {
    const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?(\/.*)?$/.exec(path);
    if (match) {
      repo = `${match[1]}/${match[2]}`;
      rest = match[3] ?? "";
      // Fetching is a POST too, but only receive-pack changes the repository.
      if (request.method === "POST" && rest === "/git-upload-pack") access = "read";
      else if (!read && rest !== "/git-receive-pack")
        return { kind: "deny", reason: "github_forbidden" };
      // A push may touch workflow files, which GitHub rejects without that permission on the token.
      if (access === "write" && granted(props.resources, repo, "workflow")) access = "workflow";
    }
  }
  const need = access === "ci" ? "read" : access === "workflow" ? "workflow" : access;
  if (repo && granted(props.resources, repo, need)) return { kind: "token", repo, access, scheme };
  if (read || (request.method === "POST" && rest === "/git-upload-pack"))
    return { kind: "anonymous" };
  return { kind: "deny", reason: "github_forbidden" };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const props = { resources: ["github:o/r:read", "github:o/r:write", "github:team/*:read"] };
  const at = (method: string, url: string) => decide({ method, url }, props);

  test("a granted repository's API reads and writes get that level's token", () => {
    expect(at("GET", "https://api.github.com/repos/o/r/pulls/1")).toMatchObject({
      kind: "token",
      repo: "o/r",
      access: "read",
      scheme: "Bearer",
    });
    expect(at("POST", "https://api.github.com/repos/o/r/pulls")).toMatchObject({
      kind: "token",
      access: "write",
    });
    expect(at("GET", "https://api.github.com/repos/o/r/actions/runs")).toMatchObject({
      access: "ci",
    });
  });

  test("an owner wildcard covers its repositories for the level it names only", () => {
    expect(at("GET", "https://api.github.com/repos/team/any/issues")).toMatchObject({
      kind: "token",
      repo: "team/any",
    });
    expect(at("POST", "https://api.github.com/repos/team/any/issues")).toEqual({
      kind: "deny",
      reason: "github_forbidden",
    });
  });

  test("a repository without a grant is public-only: anonymous reads, no writes", () => {
    expect(at("GET", "https://api.github.com/repos/other/x")).toEqual({ kind: "anonymous" });
    expect(at("PUT", "https://api.github.com/repos/other/x/contents/a")).toEqual({
      kind: "deny",
      reason: "github_forbidden",
    });
    expect(at("POST", "https://api.github.com/graphql")).toEqual({
      kind: "deny",
      reason: "github_forbidden",
    });
  });

  test("workflow files need the workflow grant", () => {
    const url = "https://api.github.com/repos/o/r/contents/.github/workflows/ci.yml";
    expect(at("PUT", url)).toEqual({ kind: "deny", reason: "github_forbidden" });
    expect(decide({ method: "PUT", url }, { resources: ["github:o/r:workflow"] })).toMatchObject({
      access: "workflow",
    });
  });

  test("git over HTTPS: clone and fetch read, only receive-pack writes", () => {
    expect(at("GET", "https://github.com/o/r.git/info/refs?service=git-upload-pack")).toMatchObject(
      { kind: "token", access: "read", scheme: "Basic" },
    );
    expect(at("POST", "https://github.com/o/r.git/git-upload-pack")).toMatchObject({
      access: "read",
    });
    expect(at("POST", "https://github.com/o/r.git/git-receive-pack")).toMatchObject({
      access: "write",
    });
    expect(at("POST", "https://github.com/o/r/settings")).toEqual({
      kind: "deny",
      reason: "github_forbidden",
    });
    expect(
      decide(
        { method: "POST", url: "https://github.com/o/r.git/git-receive-pack" },
        { resources: ["github:o/r:write", "github:o/r:workflow"] },
      ),
    ).toMatchObject({ access: "workflow" });
  });

  test("a clone of an ungranted repository goes out anonymously", () => {
    expect(at("POST", "https://github.com/other/x.git/git-upload-pack")).toEqual({
      kind: "anonymous",
    });
  });
}
