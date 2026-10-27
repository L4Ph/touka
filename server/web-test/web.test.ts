import { test } from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { chromium, expect } from "@playwright/test";

const modules = (directory: string) => [`${directory}/index.js`, ...globSync(`${directory}/assets/*.js`)].map((path) => ({ type: "ESModule" as const, path }));
const model = "claude-sonnet-4-5";
function reply(tool = false) {
  const events = [
    { type: "message_start", message: { id: "web", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: "read", name: "github_read_file", input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify({ repo: "owner/repo", path: "README.md", ref: "main" }) } : { type: "text_delta", text: "Mandarin local response" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

test("SSR Mandarin chat uses team cookies, shared adapter threads, stable retries and fresh WS reconnect", { timeout: 60000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "mandarin-web-"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let modelCalls = 0;
  let modelGate: (() => void) | undefined;
  let toolGate: (() => void) | undefined;
  let mode: "text" | "partial" | "tool" | "hold" = "text";
  const options: ConstructorParameters<typeof Miniflare>[0] = {
    host: "localhost", https: true,
    durableObjectsPersist: join(state, "do"), d1Persist: join(state, "d1"),
    workers: [
      { name: "web", modulesRoot: resolve(".."), modules: modules("../dist/ssr"), compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
        assets: { directory: "../dist/client", binding: "ASSETS", routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } },
        d1Databases: { DB: "web-auth" },
        bindings: { BETTER_AUTH_SECRET: "web-test-auth-secret-at-least-thirty-two", AUTH_GITHUB_CLIENT_ID: "fake-client", AUTH_GITHUB_CLIENT_SECRET: "fake-secret", TEAM_EMAILS: "alice@example.com,bob@example.com" },
        serviceBindings: { AGENT_CORE: { name: "core", entrypoint: "WebGateway" } },
        outboundService: async (request: Request) => {
          const url = new URL(request.url);
          if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") return WorkerResponse.json({ access_token: new URLSearchParams(await request.text()).get("code"), token_type: "bearer", scope: "user:email" });
          assert.equal(url.hostname, "api.github.com");
          const name = request.headers.get("authorization")!.replace(/^Bearer /i, "");
          if (url.pathname === "/user") return WorkerResponse.json({ id: name === "alice" ? 1 : 2, login: name, name, email: `${name}@example.com` });
          assert.equal(url.pathname, "/user/emails");
          return WorkerResponse.json([{ email: `${name}@example.com`, primary: true, verified: true }]);
        },
      },
      { name: "core", modules: modules("dist/remote_agent_server"), compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
        durableObjects: { SESSIONS: { className: "SessionAgent", useSQLite: true }, SESSION_DIRECTORY: { className: "SessionDirectory", useSQLite: true }, ADAPTER_JOBS: { className: "AdapterJobs", useSQLite: true } },
        bindings: { TEAM_AUTH: JSON.stringify([{ id: "adapter", token: "web-test-machine-token-at-least-32-characters", sessions: ["discord_team_thread"], resources: [] }]), MODEL_PROVIDER: "anthropic", MODEL_ID: model, ANTHROPIC_API_KEY: "fake-model-key", OPENAI_API_KEY: "fake-second-provider-key", WEB_RESOURCES: '["github:owner/repo:read"]', GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), GITHUB_REPOSITORIES: '{"owner/repo":42}' },
        outboundService: async (request: Request) => {
          const url = new URL(request.url);
          if (url.hostname === "api.github.com") {
            if (url.pathname === "/app/installations/42/access_tokens") return WorkerResponse.json({ token: "fake-installation", expires_at: new Date(Date.now() + 3600000).toISOString() });
            assert.equal(url.pathname, "/repos/owner/repo/contents/README.md");
            await new Promise<void>((resolve) => { toolGate = resolve; });
            return WorkerResponse.json({ type: "file", content: btoa("Shared tool file"), encoding: "base64", sha: "a".repeat(40) });
          }
          assert.equal(url.hostname, "api.anthropic.com");
          const body = await request.json() as { system: { text: string }[] };
          assert.match(JSON.stringify(body.system), /You are Mandarin/);
          modelCalls++;
          if (mode === "tool") { mode = "text"; return new WorkerResponse(reply(true), { headers: { "Content-Type": "text/event-stream" } }); }
          if (mode === "partial" || mode === "hold") {
            const content = reply();
            const split = content.indexOf("event: content_block_stop");
            const stream = new ReadableStream<Uint8Array>({ start(controller) {
              controller.enqueue(new TextEncoder().encode(content.slice(0, split)));
              modelGate = () => { try { controller.enqueue(new TextEncoder().encode(content.slice(split))); controller.close(); } catch { /* Runtime may already have cancelled the upstream stream. */ } };
            } });
            return new WorkerResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
          }
          return new WorkerResponse(reply(), { headers: { "Content-Type": "text/event-stream" } });
        },
      },
    ],
  };
  let runtime = new Miniflare(options);
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--ignore-certificate-errors"] });
  try {
    let origin = (await runtime.ready).origin;
    const db = await runtime.getD1Database("DB", "web");
    for (const file of globSync("../db/migrations/*.sql")) for (const sql of readFileSync(file, "utf8").split("--> statement-breakpoint")) if (sql.trim()) await db.prepare(sql).run();
    const core = await runtime.getWorker("core");
    const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await anonymous.newPage();
    const html = await anonymous.request.get(origin);
    assert.equal(html.status(), 200, await html.text());
    assert.match(await html.text(), /<h1>Mandarin<\/h1>/, "Heading must be server-rendered");
    await page.goto(origin);
    await expect(page).toHaveTitle("Mandarin");
    await expect(page.getByRole("heading", { name: "Mandarin", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
    assert.equal((await anonymous.request.get(`${origin}/api/agent/sessions`)).status(), 401);
    await expect(page.getByRole("button", { name: "discord_team_thread" })).toHaveCount(0);
    async function login(name: string) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const start = await context.request.post(`${origin}/api/auth/sign-in/social`, { data: { provider: "github", callbackURL: "/" }, headers: { Origin: origin } });
      assert.equal(start.status(), 200);
      const oauth = new URL((await start.json()).url);
      const callback = await context.request.get(`${origin}/api/auth/callback/github?code=${name}&state=${oauth.searchParams.get("state")}`, { maxRedirects: 0 });
      assert.equal(callback.status(), 302);
      return context;
    }
    // Only the external authorization page is replaced; the button, redirect, state and callback are real.
    await page.route("https://github.com/login/oauth/authorize**", async (route) => {
      const oauth = new URL(route.request().url());
      await route.fulfill({ status: 302, headers: { location: `${origin}/api/auth/callback/github?code=alice&state=${oauth.searchParams.get("state")}` } });
    });
    await page.getByRole("button", { name: "Sign in with GitHub" }).click();
    await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeVisible();
    await expect(page.getByText("No chats yet. Start a Mandarin conversation.", { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    const seeded = await core.fetch("https://core/api/sessions", { method: "POST", headers: { Authorization: "Bearer web-test-machine-token-at-least-32-characters", "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "discord_team_thread" }) });
    assert.equal(seeded.status, 201);
    let releaseDirectory!: () => void;
    const directoryGate = new Promise<void>((resolve) => { releaseDirectory = resolve; });
    await page.route("**/api/agent/sessions?*", async (route) => {
      const response = await route.fetch();
      await directoryGate;
      await route.fulfill({ response });
    });
    try {
      await page.getByRole("button", { name: "Refresh chats", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Loading chats…");
      await expect(page.getByRole("button", { name: "Refresh chats", exact: true })).toBeDisabled();
      await expect(page.getByText("No chats yet. Start a Mandarin conversation.", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "discord_team_thread", exact: true })).toHaveCount(0);
    } finally { releaseDirectory(); }
    await expect(page.getByRole("button", { name: "discord_team_thread", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh chats", exact: true })).toBeEnabled();
    await page.unroute("**/api/agent/sessions?*");
    const alice = anonymous;
    const bob = await login("bob");
    const alicePage = page;
    const bobPage = await bob.newPage();
    for (const view of [alicePage, bobPage]) {
      await view.goto(origin);
      if (view === alicePage) {
        await expect(view.getByRole("button", { name: "discord_team_thread", exact: true })).toBeVisible();
        await expect(view.getByRole("button", { name: "Refresh chats", exact: true })).toBeEnabled();
        for (const name of ["Sign out", "New chat", "Refresh chats", "discord_team_thread"]) {
          await view.keyboard.press("Tab");
          await expect(view.getByRole("button", { name, exact: true })).toBeFocused();
        }
        await view.keyboard.press("Enter");
      } else await view.getByRole("button", { name: "discord_team_thread", exact: true }).click();
      await expect(view.getByRole("status")).toContainText("Connected");
    }
    for (const name of ["Reconnect", "Stop shared run", "Retry parked work"]) {
      await alicePage.keyboard.press("Tab");
      await expect(alicePage.getByRole("button", { name, exact: true })).toBeFocused();
    }
    await alicePage.keyboard.press("Tab");
    await expect(alicePage.getByText("Provider and model", { exact: true })).toBeFocused();
    await alicePage.keyboard.press("Tab");
    await expect(alicePage.getByLabel("Message Mandarin", { exact: true })).toBeFocused();
    await alicePage.keyboard.type("Shared adapter continuation");
    await alicePage.keyboard.press("Tab");
    await expect(alicePage.getByRole("button", { name: "Send message", exact: true })).toBeFocused();
    await alicePage.keyboard.press("Space");
    await expect(bobPage.getByLabel("Transcript")).toContainText("Shared adapter continuation");
    await expect(bobPage.getByLabel("Transcript")).toContainText("Mandarin local response");
    // Sort fifty real conversations before the adapter thread, forcing discovery onto page two.
    for (let index = 0; index < 50; index++) {
      const created = await alice.request.post(`${origin}/api/agent/sessions`, { data: { sessionId: `a_directory_${String(index).padStart(2, "0")}` }, headers: { Origin: origin } });
      assert.equal(created.status(), 201);
    }
    const firstPage = await alice.request.get(`${origin}/api/agent/sessions?limit=50`);
    const directoryPage = await firstPage.json();
    assert.equal(directoryPage.sessions.length, 50);
    assert.equal(directoryPage.sessions.some((session: { sessionId: string }) => session.sessionId === "discord_team_thread"), false);
    assert.equal(typeof directoryPage.next, "string");
    for (const view of [alicePage, bobPage]) {
      await view.reload();
      await view.getByRole("button", { name: "discord_team_thread", exact: true }).click();
      await expect(view.getByLabel("Transcript")).toContainText("Shared adapter continuation");
      await expect(view.getByLabel("Transcript")).toContainText("Mandarin local response");
    }
    await alicePage.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(alicePage.getByText("Ask Mandarin anything to begin.")).toBeVisible();
    const newId = await alicePage.locator(".session-id").innerText();
    await bobPage.getByRole("button", { name: "Refresh chats" }).click();
    await bobPage.getByRole("button", { name: newId, exact: true }).click();
    const submissions: string[] = [];
    let loseReceipt = true;
    await alicePage.route("**/api/agent/sessions/*/inputs", async (route) => {
      submissions.push(route.request().postDataJSON().operationId);
      const response = await route.fetch();
      if (loseReceipt) { loseReceipt = false; await route.abort("failed"); } else await route.fulfill({ response });
    });
    await alicePage.getByLabel("Message Mandarin", { exact: true }).fill("Retry exactly once");
    await alicePage.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(alicePage.getByRole("alert")).toBeVisible();
    await alicePage.getByRole("button", { name: "Retry same message", exact: true }).click();
    await expect(alicePage.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0], submissions[1], "Lost receipt must not create a new operation");
    await expect(bobPage.getByLabel("Transcript")).toContainText("Retry exactly once");
    await expect(bobPage.getByLabel("Transcript").getByText("Retry exactly once", { exact: true })).toHaveCount(1);
    await alicePage.getByText("Provider and model", { exact: true }).click();
    await expect(alicePage.getByLabel("Provider", { exact: true })).toHaveValue("anthropic");
    await alicePage.getByLabel("Provider", { exact: true }).selectOption("openai");
    await alicePage.getByLabel("Model", { exact: true }).selectOption("gpt-4o-mini");
    const saved = alicePage.waitForResponse((response) => response.url().endsWith("/model") && response.request().method() === "PUT");
    await alicePage.getByRole("button", { name: "Save model", exact: true }).click();
    assert.equal((await saved).status(), 200);
    const configured = await alice.request.get(`${origin}/api/agent/sessions/${newId}`);
    assert.deepEqual((await configured.json()).model, { provider: "openai", id: "gpt-4o-mini" });
    await bobPage.reload();
    await bobPage.getByRole("button", { name: newId, exact: true }).click();
    await bobPage.getByText("Provider and model", { exact: true }).click();
    await expect(bobPage.getByLabel("Provider", { exact: true })).toHaveValue("openai");
    await expect(bobPage.getByLabel("Model", { exact: true })).toHaveValue("gpt-4o-mini");
    // Restore the provider implemented by the upstream SSE fake for the remaining run-lifecycle checks.
    await alicePage.getByLabel("Provider", { exact: true }).selectOption("anthropic");
    await alicePage.getByLabel("Model", { exact: true }).selectOption("claude-haiku-4-5");
    const restored = alicePage.waitForResponse((response) => response.url().endsWith("/model") && response.request().method() === "PUT");
    await alicePage.getByRole("button", { name: "Save model", exact: true }).click();
    assert.equal((await restored).status(), 200);
    await expect(alicePage.getByRole("alert")).toHaveCount(0);
    await bob.setOffline(true);
    await expect(bobPage.getByRole("status")).toContainText("Offline");
    await alicePage.getByLabel("Message Mandarin", { exact: true }).fill("While Bob is offline");
    await alicePage.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(alicePage.getByLabel("Transcript")).toContainText("While Bob is offline");
    await bob.setOffline(false);
    await expect(bobPage.getByRole("status")).toContainText("Connected");
    await expect(bobPage.getByLabel("Transcript")).toContainText("While Bob is offline");
    const beforeStop = modelCalls;
    mode = "partial";
    await alicePage.getByLabel("Message Mandarin", { exact: true }).fill("Stop this shared run");
    await alicePage.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(bobPage.getByRole("status")).toContainText("Running");
    await expect.poll(() => modelCalls).toBeGreaterThan(beforeStop);
    await expect(bobPage.getByLabel("Streaming response")).toContainText("Mandarin local response");
    const stoppedInput = submissions.at(-1)!;
    await bobPage.getByRole("button", { name: "Stop shared run", exact: true }).click();
    // Keep the successful model response gated: Ready alone also passes when abort is a no-op.
    await expect.poll(async () => (await (await alice.request.get(`${origin}/api/agent/sessions/${newId}/operations/${stoppedInput}`)).json())).toMatchObject({ status: "unanswered", reason: "aborted" });
    await expect(alicePage.getByRole("status")).toContainText("Ready");
    await expect(alicePage.getByLabel("Transcript")).toContainText("Unanswered: aborted");
    modelGate?.(); mode = "text";

    mode = "partial";
    await alicePage.getByLabel("Message Mandarin", { exact: true }).fill("Show partial then finish");
    await alicePage.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(alicePage.getByLabel("Streaming response")).toContainText("Mandarin local response");
    await expect(alicePage.getByRole("status")).toContainText("Running");
    modelGate?.(); mode = "text";
    await expect(alicePage.getByLabel("Streaming response")).toHaveCount(0);
    await expect(alicePage.getByRole("status")).toContainText("Ready");
    await expect(alicePage.getByLabel("Transcript").getByRole("listitem").last()).toContainText("Mandarin local response");

    mode = "tool";
    await alicePage.getByLabel("Message Mandarin", { exact: true }).fill("Read the shared file");
    await alicePage.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(alicePage.getByLabel("Tool activity")).toContainText("github_read_file: Running");
    await expect.poll(() => Boolean(toolGate)).toBe(true);
    toolGate?.();
    await expect(alicePage.getByLabel("Tool activity")).toContainText("github_read_file: Finished");
    await expect(alicePage.getByLabel("Transcript")).toContainText("Shared tool file");
    await expect(alicePage.getByRole("status")).toContainText("Ready");

    // Interrupt real SQLite-backed generations until Pi's crash-loop protection parks the operation.
    mode = "hold";
    await alicePage.getByLabel("Message Mandarin", { exact: true }).fill("Recover interrupted work");
    await alicePage.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(alicePage.getByLabel("Streaming response")).toBeVisible();
    const parkedInput = submissions.at(-1)!;
    let parked = false;
    for (let restart = 0; restart < 3 && !parked; restart++) {
      const before = modelCalls;
      await runtime.dispose();
      runtime = new Miniflare(options);
      origin = (await runtime.ready).origin;
      await expect.poll(async () => {
        const operation = await (await alice.request.get(`${origin}/api/agent/sessions/${newId}/operations/${parkedInput}`)).json();
        parked = operation.status === "parked";
        return parked || modelCalls > before;
      }).toBe(true);
    }
    assert.equal(parked, true, "Repeated interrupted generations must park, not complete");
    await alicePage.goto(origin);
    await alicePage.getByRole("button", { name: new RegExp(`^${newId}`) }).click();
    await expect(alicePage.getByRole("status")).toContainText("Parked — retry to resume");
    mode = "text";
    await alicePage.getByRole("button", { name: "Retry parked work", exact: true }).click();
    await expect.poll(async () => (await (await alice.request.get(`${origin}/api/agent/sessions/${newId}/operations/${parkedInput}`)).json()).status).toBe("done");
    await expect(alicePage.getByRole("status")).not.toContainText("Parked");
    await expect(alicePage.getByRole("status")).toContainText("Ready");
    await expect(alicePage.getByLabel("Transcript")).toContainText("Recover interrupted work");
    await alicePage.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(alicePage.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
    await expect(alicePage.getByLabel("Transcript")).toHaveCount(0);
  } finally { modelGate?.(); toolGate?.(); await browser.close(); await runtime.dispose(); await rm(state, { recursive: true, force: true }); }
});
