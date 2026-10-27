import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { create, createGitHubAppAuth, GitHubError, type GitHubEnv } from "./index";

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
  sessions = ["session-1"],
  env: GitHubEnv = config,
) {
  // The unused DO binding is absent: these tests exercise only the outbound HTTP capability.
  return create({
    env: Object.assign(Object.create(null), env),
    sessionId: "session-1",
    principal: { id: "member", sessions, resources },
  }).tools!;
}
async function call(
  registered: ReturnType<typeof tools>,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = registered.find((t) => t.name === `github_${name}`);
  assert.ok(tool, `missing tool ${name}`);
  const result = await Reflect.apply(tool.execute, tool, [args]);
  return JSON.parse(result.output[0].text);
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
    return send(404, { message: "unexpected route" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init.redirect, "manual");
    return realFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
  });
  t.after(() => {
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
      { repositories: ["project"], permissions: { contents: "read" } },
      { repositories: ["project"], permissions: { contents: "write", pull_requests: "write" } },
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
  assert.deepEqual(
    registered.map((tool) => [tool.name, tool.replay]),
    [
      ["github_read_file", "safe"],
      ["github_create_branch", "unsafe"],
      ["github_write_file", "unsafe"],
      ["github_open_pull_request", "unsafe"],
    ],
  );
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

test("scope, session and malformed repo/path/ref fail before any external HTTP", async (t) => {
  const http = await boundary(t);
  const read = { repo: "team/project", path: "docs/hello.txt", ref: "main" };
  await assert.rejects(call(tools([], []), "read_file", read), /github_forbidden/);
  await assert.rejects(
    call(tools(["github:team/project:read"], []), "read_file", read),
    /github_forbidden/,
  );
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
  await assert.rejects(
    call(tools(undefined, undefined, {}), "read_file", read),
    /github_unconfigured/,
  );
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

test("server auth seam refreshes expiring cached tokens and fails closed on bad key/config", async (t) => {
  const http = await boundary(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
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
