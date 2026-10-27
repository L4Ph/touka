import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build } from "vite";
import { Miniflare, Response as WorkerResponse } from "miniflare";

const token = "upgrade-local-token-not-a-secret-0001";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5" };
const opus = { provider: "anthropic", id: "claude-opus-4-5" };
const root = resolve("..");

async function legacyWorker() {
  // Compile the actual pre-marker release, not today's submit with a deleted KV key.
  const result = await build({
    configFile: false,
    logLevel: "silent",
    resolve: { conditions: ["workerd", "worker", "browser"] },
    build: {
      write: false,
      target: "es2022",
      minify: false,
      lib: { entry: resolve("src/index.ts"), formats: ["es"] },
      rollupOptions: { external: /^(cloudflare:|node:)/, output: { inlineDynamicImports: true } },
    },
    plugins: [
      {
        name: "m0-sources",
        enforce: "pre",
        resolveId(source, importer) {
          if (!importer || !source.startsWith(".")) return;
          const path = resolve(importer, "..", source.endsWith(".ts") ? source : `${source}.ts`);
          const name = relative(root, path);
          if (name.startsWith("server/src/") || name.startsWith("shared/")) return path;
        },
        load(path) {
          const name = relative(root, path);
          if (!name.startsWith("server/src/") && !name.startsWith("shared/")) return;
          const source = execFileSync("git", ["show", `da11e5251583dbe72366548ccd9ed554280b0e1d:${name}`], {
            cwd: root,
            encoding: "utf8",
          });
          if (name === "server/src/plugins.ts") {
            const files = execFileSync(
              "git",
              ["ls-tree", "-r", "--name-only", "da11e5251583dbe72366548ccd9ed554280b0e1d", "server/src"],
              { cwd: root, encoding: "utf8" },
            )
              .trim()
              .split("\n");
            // Resolve glob membership from the historical tree, never today's feature directories.
            return source
              .replace(
                /import\.meta\.glob<\w+>\('\.\/(adapters|tools)\/\*\/index\.ts', \{ eager: true \}\)/g,
                (_match, kind: string) => {
                  const entries = files.filter((file) =>
                    new RegExp(`^server/src/${kind}/[^/]+/index\\.ts$`).test(file),
                  );
                  return `{${entries.map((file) => `${JSON.stringify("./" + file.slice("server/src/".length))}: __historical_${files.indexOf(file)}`).join(",")}}`;
                },
              )
              .replace(
                /^/m,
                files
                  .filter((file) => /^server\/src\/(adapters|tools)\/[^/]+\/index\.ts$/.test(file))
                  .map(
                    (file) =>
                      `import * as __historical_${files.indexOf(file)} from ${JSON.stringify("./" + file.slice("server/src/".length))};\n`,
                  )
                  .join(""),
              );
          }
          // M0 had no history endpoint; expose only its existing Pi reader in this fixture.
          if (name === "server/src/session.ts")
            return source.replace(
              "  async inspect()",
              "  async transcript() { return JSON.stringify({ messages: await this.harness.messages() }); }\n\n  async inspect()",
            );
          if (name === "server/src/index.ts")
            return source.replace(
              "mountAdapters(app);",
              "app.get('/api/sessions/:sessionId/messages', async (c) => c.body(await c.env.SESSIONS.getByName(c.req.param('sessionId')).transcript(), 200, { 'Content-Type': 'application/json' }));\nmountAdapters(app);",
            );
          return source;
        },
      },
    ],
  });
  const output = Array.isArray(result) ? result[0] : result;
  assert("output" in output);
  const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);
  assert(entry?.type === "chunk");
  return [{ type: "ESModule" as const, path: resolve("dist/m0-upgrade.js"), contents: entry.code }];
}

function answer() {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_upgrade",
        type: "message",
        role: "assistant",
        model: sonnet.id,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Legacy answer" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

test(
  "M0 SQLite sessions survive M1 discovery, duplicate creation, model controls and authenticated snapshots after reopen",
  { timeout: 60_000 },
  async () => {
    const state = await mkdtemp(join(tmpdir(), "pi-upgrade-"));
    let modelCalls = 0;
    const options = {
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { SESSIONS: { className: "SessionAgent", useSQLite: true } },
      durableObjectsPersist: state,
      bindings: {
        TEAM_AUTH: JSON.stringify([
          {
            id: "owner",
            token,
            sessions: ["legacy", "duplicate-first", "socket-first", "absent", "probed"],
            resources: [],
          },
          { id: "other", token: `${token}-other`, sessions: ["private"], resources: [] },
        ]),
        MODEL_PROVIDER: sonnet.provider,
        MODEL_ID: sonnet.id,
        ANTHROPIC_API_KEY: "local-fake-key",
      },
      outboundService: async (request: Request) => {
        assert.equal(new URL(request.url).hostname, "api.anthropic.com");
        modelCalls++;
        return new WorkerResponse(answer(), { headers: { "Content-Type": "text/event-stream" } });
      },
    };
    let runtime = new Miniflare({ ...options, modules: await legacyWorker() });
    let url = await runtime.ready;
    const call = (path: string, method = "GET", body?: unknown) =>
      fetch(new URL(path, url), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    const result = (session: string) =>
      call(`/api/sessions/${session}/operations/legacy-op`).then((r) => r.json());
    const expected = (sessionId: string) => ({
      sessionId,
      operationId: "legacy-op",
      status: "done",
      text: "Legacy answer",
    });
    const currentModules = [
      "dist/remote_agent_server/index.js",
      ...globSync("dist/remote_agent_server/assets/*.js"),
    ].map((path) => ({ type: "ESModule" as const, path }));
    const legacyTranscripts = new Map<string, unknown>();
    try {
      // M0 inspection alone opens a root conversation; that must not become a session.
      assert.equal((await call("/api/sessions/probed/runtime")).status, 200);
      for (const sessionId of ["legacy", "duplicate-first", "socket-first"]) {
        const receipt = await call("/adapters/webhook", "POST", {
          sessionId,
          operationId: "legacy-op",
          input: "Legacy input",
        });
        assert.equal(receipt.status, 202);
        assert.equal(((await receipt.json()) as { accepted: boolean }).accepted, true);
        const deadline = Date.now() + 10_000;
        let settled;
        do {
          settled = await result(sessionId);
          assert(settled && typeof settled === "object" && "status" in settled);
          if (settled.status === "done") break;
          await new Promise<void>((resolve) => setImmediate(resolve));
        } while (Date.now() < deadline);
        assert.deepEqual(settled, expected(sessionId));
        const history = await call(`/api/sessions/${sessionId}/messages`);
        assert.equal(history.status, 200);
        legacyTranscripts.set(sessionId, await history.json());
      }
      await runtime.dispose();
      runtime = new Miniflare({
        ...options,
        bindings: { ...options.bindings, MODEL_ID: opus.id },
        modules: currentModules,
      });
      url = await runtime.ready;
      assert.equal(
        (await call("/api/sessions", "POST", { sessionId: "duplicate-first", model: opus })).status,
        409,
        "Creation as the first M1 access must not overwrite M0",
      );
      const socketResponse = await runtime.dispatchFetch(
        "http://localhost/api/sessions/socket-first/events",
        { headers: { ...headers, Upgrade: "websocket" } },
      );
      assert.equal(socketResponse.status, 101, "WS as the first M1 access must recognize M0");
      const socket = socketResponse.webSocket!;
      const snapshot = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No upgrade snapshot")), 5000);
        socket.addEventListener(
          "message",
          ({ data }) => {
            clearTimeout(timer);
            resolve(JSON.parse(String(data)));
          },
          { once: true },
        );
      });
      socket.accept();
      const frame = await snapshot;
      assert.equal(frame.type, "snapshot");
      assert.equal(frame.snapshot.agent.model.modelId, sonnet.id);
      assert(JSON.stringify(frame.snapshot.entries).includes("Legacy answer"));
      socket.close();
      for (let reopen = 0; reopen < 2; reopen++) {
        const listed = (await (await call("/api/sessions")).json()) as {
          sessions: { sessionId: string }[];
        };
        assert.deepEqual(listed.sessions.map((s) => s.sessionId).sort(), [
          "duplicate-first",
          "legacy",
          "socket-first",
        ]);
        for (const sessionId of ["legacy", "duplicate-first", "socket-first"]) {
          const detail = await call(`/api/sessions/${sessionId}`);
          assert.equal(detail.status, 200);
          assert.deepEqual(
            ((await detail.json()) as { model: unknown }).model,
            reopen === 1 && sessionId === "legacy" ? opus : sonnet,
          );
          assert.deepEqual(await result(sessionId), expected(sessionId));
          const messages = await (await call(`/api/sessions/${sessionId}/messages`)).json();
          assert.deepEqual(
            messages,
            legacyTranscripts.get(sessionId),
            `${sessionId}: discovery and reopen must preserve the complete M0 transcript`,
          );
          assert.equal(
            (await call("/api/sessions", "POST", { sessionId, model: opus })).status,
            409,
          );
          assert.deepEqual(
            await (
              await call("/triggers/webhook", "POST", {
                sessionId,
                operationId: "legacy-op",
                input: "Must not replace history",
              })
            ).json(),
            { sessionId, operationId: "legacy-op", accepted: false },
          );
          assert.deepEqual(
            await (await call(`/api/sessions/${sessionId}/messages`)).json(),
            legacyTranscripts.get(sessionId),
            `${sessionId}: rejected creation and duplicate input must preserve the complete M0 transcript`,
          );
        }
        for (const sessionId of ["absent", "probed"]) {
          assert.equal((await call(`/api/sessions/${sessionId}`)).status, 404);
          assert.equal((await call(`/api/sessions/${sessionId}/model`, "PUT", opus)).status, 404);
          assert.equal(
            (
              await runtime.dispatchFetch(`http://localhost/api/sessions/${sessionId}/events`, {
                headers: { ...headers, Upgrade: "websocket" },
              })
            ).status,
            404,
          );
        }
        assert.equal((await call("/api/sessions/legacy/model", "PUT", opus)).status, 200);
        if (reopen === 0) {
          await runtime.dispose();
          runtime = new Miniflare({ ...options, modules: currentModules });
          url = await runtime.ready;
        }
      }
      assert.equal(
        (
          await runtime.dispatchFetch("http://localhost/api/sessions/legacy/events", {
            headers: { Upgrade: "websocket" },
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await runtime.dispatchFetch("http://localhost/api/sessions/legacy/events", {
            headers: { Authorization: `Bearer ${token}-other`, Upgrade: "websocket" },
          })
        ).status,
        403,
      );
      assert.equal(
        modelCalls,
        3,
        "Upgrade and duplicate submissions must not regenerate completed operations",
      );
    } finally {
      await runtime.dispose();
      await rm(state, { recursive: true, force: true });
    }
  },
);
