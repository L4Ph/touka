import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { chromium, expect } from "@playwright/test";
import { reply, webRuntimeOptions } from "./fixtures";

test("unconfirmed input survives another chat", { timeout: 60000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "mandarin-recovery-"));
  const modelInputs: string[] = [];
  const runtime = new Miniflare(
    webRuntimeOptions(state, async (request) => {
      assert.equal(new URL(request.url).hostname, "api.anthropic.com");
      modelInputs.push(await request.text());
      return new WorkerResponse(reply(), { headers: { "Content-Type": "text/event-stream" } });
    }),
  );
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--ignore-certificate-errors"],
  });
  try {
    const origin = (await runtime.ready).origin;
    const db = await runtime.getD1Database("DB", "web");
    for (const file of globSync("../db/migrations/*.sql"))
      for (const sql of readFileSync(file, "utf8").split("--> statement-breakpoint"))
        if (sql.trim()) await db.prepare(sql).run();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const start = await context.request.post(`${origin}/api/auth/sign-in/social`, {
      data: { provider: "github", callbackURL: "/" },
      headers: { Origin: origin },
    });
    assert.equal(start.status(), 200);
    const oauth = new URL((await start.json()).url);
    const callback = await context.request.get(
      `${origin}/api/auth/callback/github?code=alice&state=${oauth.searchParams.get("state")}`,
      { maxRedirects: 0 },
    );
    assert.equal(callback.status(), 302);
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Connected");
    const sessionA = await page.locator(".session-id").innerText();
    const inputA = "Keep A's exact input\nincluding whitespace  ";
    const requests: { url: string; body: string | null }[] = [];
    await page.route("**/api/agent/sessions/*/inputs", async (route) => {
      requests.push({ url: route.request().url(), body: route.request().postData() });
      const response = await route.fetch();
      assert.equal(response.status(), 202);
      assert.equal((await response.json()).accepted, requests.length !== 3);
      // Drop only the browser receipt, after the actual durable acceptance.
      if (requests.length === 1) await route.abort("failed");
      else await route.fulfill({ response });
    });
    const composer = page.getByLabel("Message Mandarin", { exact: true });
    await composer.fill(inputA);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry same message", exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel("Transcript")).toContainText("Mandarin local response");

    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.getByText("Ask Mandarin anything to begin.")).toBeVisible();
    const sessionB = await page.locator(".session-id").innerText();
    assert.notEqual(sessionB, sessionA);
    await composer.fill("Successful message in B");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(composer).toHaveValue("");
    await expect(page.getByLabel("Transcript")).toContainText("Mandarin local response");
    await page.getByRole("button", { name: sessionA, exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Retry same message", exact: true }),
    ).toBeEnabled();
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveValue(inputA);
    await page.getByRole("button", { name: "Retry same message", exact: true }).click();
    await expect(composer).toBeEditable();
    await expect(composer).toHaveValue("");
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, `${origin}/api/agent/sessions/${sessionA}/inputs`);
    assert.equal(requests[1].url, `${origin}/api/agent/sessions/${sessionB}/inputs`);
    assert.equal(JSON.parse(requests[0].body!).input, inputA);
    assert.deepEqual(
      requests[2],
      requests[0],
      "Retry must preserve the session, operation ID and exact payload",
    );
    const operationId = JSON.parse(requests[0].body!).operationId;
    const operation = await context.request.get(
      `${origin}/api/agent/sessions/${sessionA}/operations/${operationId}`,
    );
    assert.equal(operation.status(), 200);
    assert.equal((await operation.json()).status, "done");
    const history = await context.request.get(`${origin}/api/agent/sessions/${sessionA}/messages`);
    assert.equal(history.status(), 200);
    const { messages } = await history.json();
    assert.equal(messages.filter((entry: { kind: string }) => entry.kind === "pi.user").length, 1);
    assert.equal(
      modelInputs.filter((body) => body.includes(JSON.stringify(inputA).slice(1, -1))).length,
      1,
      "A must execute the model only once despite its lost receipt",
    );
    assert.equal(modelInputs.length, 2, "Only A and B should execute");
  } finally {
    await browser.close();
    await runtime.dispose();
    await rm(state, { recursive: true, force: true });
  }
});

test("rejected input remains editable", { timeout: 60000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "mandarin-rejection-"));
  const runtime = new Miniflare(
    webRuntimeOptions(state, async (request) => {
      assert.equal(new URL(request.url).hostname, "api.anthropic.com");
      return new WorkerResponse(reply(), { headers: { "Content-Type": "text/event-stream" } });
    }),
  );
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--ignore-certificate-errors"],
  });
  try {
    const origin = (await runtime.ready).origin;
    const db = await runtime.getD1Database("DB", "web");
    for (const file of globSync("../db/migrations/*.sql"))
      for (const sql of readFileSync(file, "utf8").split("--> statement-breakpoint"))
        if (sql.trim()) await db.prepare(sql).run();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const start = await context.request.post(`${origin}/api/auth/sign-in/social`, {
      data: { provider: "github", callbackURL: "/" },
      headers: { Origin: origin },
    });
    assert.equal(start.status(), 200);
    const oauth = new URL((await start.json()).url);
    const callback = await context.request.get(
      `${origin}/api/auth/callback/github?code=alice&state=${oauth.searchParams.get("state")}`,
      { maxRedirects: 0 },
    );
    assert.equal(callback.status(), 302);
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Connected");
    const composer = page.getByLabel("Message Mandarin", { exact: true });
    const oversized = "x".repeat(16001);
    await composer.fill(oversized);
    const rejection = page.waitForResponse((response) => response.url().endsWith("/inputs"));
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const rejected = await rejection;
    assert.equal(rejected.status(), 400);
    assert.deepEqual(await rejected.json(), { error: { code: "invalid_input" } });
    await expect(page.getByRole("alert")).toContainText("invalid_input");
    await expect(composer).toBeEditable();
    await expect(composer).toHaveValue(oversized);
    await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
    await composer.fill("Corrected message");
    const acceptance = page.waitForResponse((response) => response.url().endsWith("/inputs"));
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const accepted = await acceptance;
    assert.equal(accepted.status(), 202);
    assert.notEqual(
      accepted.request().postDataJSON().operationId,
      rejected.request().postDataJSON().operationId,
      "Corrected input must be a new operation, not a mutation of an uncertain submission",
    );
    await expect(
      page.getByLabel("Transcript").getByText("Corrected message", { exact: true }),
    ).toHaveCount(1);
    await expect(page.getByLabel("Transcript")).toContainText("Mandarin local response");
    await expect(composer).toHaveValue("");
    await expect(composer).toBeEditable();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await browser.close();
    await runtime.dispose();
    await rm(state, { recursive: true, force: true });
  }
});
