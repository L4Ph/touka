import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { globSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, Response as WorkerResponse } from "miniflare";

const token = "pilot-test-token-not-a-secret-00000001";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const auth = JSON.stringify([{ id: "pilot", token, sessions: ["pilot"], resources: [] }]);
const worker = {
  modules: [
    "dist/remote_agent_server/index.js",
    ...globSync("dist/remote_agent_server/assets/*.js"),
  ].map((path) => ({ type: "ESModule" as const, path })),
  compatibilityDate: "2026-08-01",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { SESSIONS: { className: "SessionAgent", useSQLite: true } },
};
const payload = (operationId: string, input = "  Hello\r\nworld  ") => ({
  sessionId: "pilot",
  operationId,
  input,
});

function answer(text: string) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_local",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for observable operation state");
}

test(
  "webhook admits once before model completion, bounds the inbox, and survives runtime restart",
  { timeout: 60_000 },
  async () => {
    const state = await mkdtemp(join(tmpdir(), "pi-pilot-"));
    const requests: unknown[] = [];
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const options = {
      ...worker,
      durableObjectsPersist: state,
      bindings: {
        TEAM_AUTH: auth,
        MODEL_PROVIDER: "anthropic",
        MODEL_ID: "claude-sonnet-4-5",
        ANTHROPIC_API_KEY: "local-fake-key",
      },
      outboundService: async (request: Request) => {
        assert.equal(
          new URL(request.url).hostname,
          "api.anthropic.com",
          "Unexpected outbound network access",
        );
        requests.push(await request.json());
        return new WorkerResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller);
            },
          }),
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        );
      },
    };
    let runtime = new Miniflare(options);
    let url: URL;
    const submit = (body: unknown, customHeaders: Record<string, string> = headers) =>
      fetch(new URL("/adapters/webhook", url), {
        method: "POST",
        headers: customHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    const status = async (id: string) => {
      const response = await fetch(new URL(`/api/sessions/pilot/operations/${id}`, url), {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ status: string; text?: string; reason?: string }>;
    };
    try {
      url = await runtime.ready;
      assert.equal(
        (await submit(payload("op"), { "Content-Type": "application/json" })).status,
        401,
      );
      assert.equal(
        (await submit(payload("op"), { ...headers, Authorization: "Bearer wrong" })).status,
        401,
      );
      assert.equal((await submit({ ...payload("op"), sessionId: "other" })).status, 403);
      assert.equal(
        (await submit({})).status,
        400,
        "The adapter must enforce the shared input schema",
      );
      const malformed = await fetch(new URL("/adapters/webhook", url), {
        method: "POST",
        headers,
        body: "{",
      });
      assert.equal(malformed.status, 400);
      const oversized = await submit(payload("op", "x".repeat(32_769)));
      assert.equal(oversized.status, 413);
      assert.equal(
        (await fetch(new URL("/api/sessions/other/operations/op", url), { headers })).status,
        403,
      );
      assert.equal(
        (await fetch(new URL("/api/sessions/pilot/operations/missing", url), { headers })).status,
        404,
      );
      assert.equal(requests.length, 0, "Rejected requests must not reach the model");

      const receipt = await submit(payload("op"));
      assert.equal(receipt.status, 202);
      assert.deepEqual(await receipt.json(), {
        sessionId: "pilot",
        operationId: "op",
        accepted: true,
      });
      await until(
        async () => requests.length,
        (count) => count === 1,
      );
      assert.equal((await status("op")).status, "running");
      const modelRequest = requests[0] as {
        system?: unknown;
        messages: { role: string; content: { text?: string }[] }[];
      };
      assert.equal(
        modelRequest.system,
        undefined,
        "The core must not inject a system prompt, including an origin label",
      );
      assert.equal(modelRequest.messages.length, 1, "The core must not inject an origin message");
      assert.equal(modelRequest.messages[0].role, "user");
      assert.deepEqual(
        modelRequest.messages[0].content.map((block) => block.text),
        ["Hello\nworld"],
      );
      const retries = await Promise.all(
        Array.from({ length: 4 }, () => submit(payload("op", "different retry text"))),
      );
      for (const response of retries)
        assert.deepEqual(await response.json(), {
          sessionId: "pilot",
          operationId: "op",
          accepted: false,
        });
      assert.equal(requests.length, 1, "Retries must not start another generation");

      for (let index = 1; index < 16; index++)
        assert.equal((await submit(payload(`queued-${index}`))).status, 202);
      assert.equal((await status("queued-1")).status, "queued");
      assert.equal((await submit(payload("overflow"))).status, 429);
      assert.equal(
        (await fetch(new URL("/api/sessions/pilot/operations/overflow", url), { headers })).status,
        404,
        "Rejected overflow must not be durably enqueued",
      );
      assert.equal(
        (await submit(payload("op"))).status,
        202,
        "Duplicate remains admissible with a full inbox",
      );

      // Abruptly stop the runtime with model work and queued submissions still outstanding.
      await runtime.dispose();
      streams.length = 0;
      runtime = new Miniflare(options);
      url = await runtime.ready;
      const retried = await submit(payload("op"));
      assert.deepEqual(await retried.json(), {
        sessionId: "pilot",
        operationId: "op",
        accepted: false,
      });
      assert.equal((await status("queued-1")).status, "queued");
      await until(
        async () => requests.length,
        (count) => count === 2,
      );
      assert.equal((await status("op")).status, "running");
      const stream = streams.at(-1);
      assert(stream, "Restart must resume the pending model request");
      stream.enqueue(new TextEncoder().encode(answer("Durable answer")));
      stream.close();
      const done = await until(
        () => status("op"),
        (result) => result.status === "done",
      );
      assert.deepEqual(done, {
        sessionId: "pilot",
        operationId: "op",
        status: "done",
        text: "Durable answer",
      });
      const assertTranscript = async () => {
        const response = await fetch(new URL("/api/sessions/pilot/messages", url), { headers });
        assert.equal(response.status, 200);
        const transcript = (await response.json()) as {
          messages: { kind: string; model?: { content: unknown }[] }[];
        };
        assert.deepEqual(
          transcript.messages.find((entry) => entry.kind === "pi.user")?.model?.[0].content,
          "Hello\nworld",
          "Transcript must expose the submitted user message",
        );
        assert.deepEqual(
          transcript.messages.find((entry) => entry.kind === "pi.assistant")?.model?.[0].content,
          [{ type: "text", text: "Durable answer" }],
          "Transcript must expose the completed assistant answer",
        );
      };
      await assertTranscript();
      await runtime.dispose();
      streams.length = 0;
      runtime = new Miniflare(options);
      url = await runtime.ready;
      assert.deepEqual(await status("op"), done, "Terminal result must persist across restart");
      await assertTranscript();
      assert.deepEqual(await (await submit(payload("op"))).json(), {
        sessionId: "pilot",
        operationId: "op",
        accepted: false,
      });

      // Real interrupted generations exercise Pi's crash-loop guard, not a fabricated status row.
      await until(
        async () => requests.length,
        (count) => count >= 3,
      );
      let parked = false;
      for (let restart = 0; restart < 3 && !parked; restart++) {
        const before = requests.length;
        await runtime.dispose();
        runtime = new Miniflare(options);
        url = await runtime.ready;
        const recovered = await until(
          async () => ({ operation: await status("queued-1"), calls: requests.length }),
          (value) => value.operation.status === "parked" || value.calls > before,
        );
        parked = recovered.operation.status === "parked";
      }
      assert.equal(
        (await status("queued-1")).status,
        "parked",
        "Repeated interruptions must not be mislabeled running or done",
      );
      assert.deepEqual(await (await submit(payload("queued-1"))).json(), {
        sessionId: "pilot",
        operationId: "queued-1",
        accepted: false,
      });
      const retryUrl = new URL("/api/sessions/pilot/retry", url);
      assert.equal((await fetch(retryUrl, { method: "POST" })).status, 401);
      const beforeRecovery = requests.length;
      const retry = await fetch(retryUrl, { method: "POST", headers });
      assert.deepEqual(await retry.json(), { retried: true });
      await until(
        async () => requests.length,
        (count) => count > beforeRecovery,
      );
      const recoveredStream = streams.at(-1);
      assert(recoveredStream);
      recoveredStream.enqueue(new TextEncoder().encode(answer("Recovered parked operation")));
      recoveredStream.close();
      const recovered = await until(
        () => status("queued-1"),
        (result) => result.status === "done",
      );
      assert.equal(recovered.text, "Recovered parked operation");
      await fetch(new URL("/api/sessions/pilot/abort", url), {
        method: "POST",
        headers,
        body: "{}",
      });
    } finally {
      await runtime.dispose();
      await rm(state, { recursive: true, force: true });
    }
  },
);

test(
  "missing auth fails closed and missing model is honestly unanswered",
  { timeout: 20_000 },
  async () => {
    const runtime = new Miniflare({
      workers: [
        { ...worker, name: "entry", bindings: { TEAM_AUTH: auth } },
        { ...worker, name: "unconfigured" },
      ],
    });
    try {
      const url = await runtime.ready;
      const response = await fetch(new URL("/adapters/webhook", url), {
        method: "POST",
        headers,
        body: JSON.stringify(payload("no-model")),
      });
      assert.equal(response.status, 202);
      const result = await until(
        async () => {
          const status = await fetch(new URL("/api/sessions/pilot/operations/no-model", url), {
            headers,
          });
          assert.equal(status.status, 200);
          return status.json() as Promise<{ status: string; reason?: string; text?: string }>;
        },
        (value) => value.status === "unanswered",
      );
      assert.equal(result.status, "unanswered");
      assert.ok(result.reason, "An unanswered operation must expose a failure reason");
      assert.equal(result.text, undefined);
      const unconfigured = await runtime.getWorker("unconfigured");
      assert.equal(
        (
          await unconfigured.fetch("http://localhost/adapters/webhook", {
            method: "POST",
            headers,
            body: JSON.stringify(payload("no-auth")),
          })
        ).status,
        503,
      );
    } finally {
      await runtime.dispose();
    }
  },
);
