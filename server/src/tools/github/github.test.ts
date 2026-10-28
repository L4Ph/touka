import { vi, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { create } from "./index";
import { deliver } from "@remote-agent/trigger-github";

test("web Tools and Trigger replies share the GitHub Connector, but reply authority cannot write repository contents", async (t) => {
  const env = Object.assign(Object.create(null), {
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    GITHUB_REPOSITORIES: '{"team/project":42}',
  });
  const scopes: unknown[] = [];
  const paths: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    assert.ok(typeof url === "string" && init);
    const path = new URL(url).pathname;
    if (path.endsWith("/access_tokens")) {
      scopes.push(JSON.parse(String(init.body)).permissions);
      return Response.json({
        token: `token-${scopes.length}`,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    paths.push(path);
    if (path.endsWith("/issues/7/comments")) {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer token-1");
      assert.deepEqual(JSON.parse(String(init.body)), { body: "Answer" });
      return new Response(null, { status: 201 });
    }
    assert.equal(path, "/repos/team/project/contents/hello.txt");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer token-2");
    return Response.json({
      type: "file",
      encoding: "base64",
      content: btoa("Hello"),
      sha: "a".repeat(40),
    });
  });
  assert.deepEqual(
    await deliver({
      env,
      job: {
        trigger: "github",
        input: { sessionId: "thread", operationId: "event", input: "task" },
        principal: { id: "actor", sessions: ["thread"], resources: [] },
        reply: { repo: "team/project", number: 7 },
      },
      result: { sessionId: "thread", operationId: "event", status: "done", text: "Answer" },
      signal: new AbortController().signal,
    }),
    { status: "delivered" },
  );
  const context = {
    env,
    sessionId: "web-conversation",
    principal: {
      id: "viewer",
      sessions: ["web-conversation"],
      resources: ["github:team/project:read"],
    },
  };
  const tools = create(context).tools!;
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.replay]),
    [
      ["github_read_file", "safe"],
      ["github_create_branch", "unsafe"],
      ["github_write_file", "unsafe"],
      ["github_open_pull_request", "unsafe"],
    ],
  );
  const read = tools.find((tool) => tool.name === "github_read_file")!;
  const args = { repo: "team/project", path: "hello.txt", ref: "main" };
  assert.deepEqual(JSON.parse((await Reflect.apply(read.execute, read, [args])).output[0].text), {
    sha: "a".repeat(40),
    content: "Hello",
  });
  const write = tools.find((tool) => tool.name === "github_create_branch")!;
  await assert.rejects(
    Reflect.apply(write.execute, write, [
      { repo: "team/project", branch: "change", sha: "a".repeat(40) },
    ]),
    /github_forbidden/,
  );
  const unbound = create({ ...context, principal: { ...context.principal, sessions: [] } })
    .tools![0];
  await assert.rejects(Reflect.apply(unbound.execute, unbound, [args]), /github_forbidden/);
  assert.deepEqual(scopes, [{ issues: "write", pull_requests: "write" }, { contents: "read" }]);
  assert.deepEqual(paths, [
    "/repos/team/project/issues/7/comments",
    "/repos/team/project/contents/hello.txt",
  ]);
});
