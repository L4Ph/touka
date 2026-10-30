import type nodeAssert from "node:assert/strict";
import type { ThreadMessage } from "@remote-agent/connector-slack";
import type { ConversationSample } from "@remote-agent/trigger-contract";

const MESSAGES = 30;
const MESSAGE_CHARS = 1000;
const TOTAL_CHARS = 8000;
const SAMPLE_MESSAGES = 8;

const clean = (text: string, botUserId: string) =>
  text
    .replace(new RegExp(`<@${botUserId}>`, "g"), "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, MESSAGE_CHARS);

/**
 * What people said in the thread that the agent has not answered yet: everything after its last
 * message, or the whole thread when it has not spoken. Messages from the agent itself are already in
 * its conversation, and the message being handled is passed on separately.
 */
export function unseen(messages: ThreadMessage[], botUserId: string, latestTs: string): string {
  const before = messages.filter((m) => Number(m.ts) < Number(latestTs));
  let last = -1;
  before.forEach((m, index) => {
    if (m.user === botUserId) last = index;
  });
  const lines: string[] = [];
  let total = 0;
  for (const m of before.slice(last + 1).reverse()) {
    const text = clean(m.text, botUserId);
    if (!text || lines.length >= MESSAGES || total + text.length > TOTAL_CHARS) continue;
    lines.push(`${m.user ? `<@${m.user}>` : "bot"}: ${text}`);
    total += text.length;
  }
  return lines.reverse().join("\n");
}

/** The input for the agent: earlier context, if any, then the message itself. */
export function withContext(context: string, text: string): string {
  return context
    ? `Earlier in this thread, since you last replied (oldest first):\n${context}\n\nMessage for you:\n${text}`
    : text;
}

/** A short excerpt for the classifier, including the agent's own replies so it can follow the exchange. */
export function sample(
  messages: ThreadMessage[],
  botUserId: string,
  latest: { user: string; text: string; ts: string },
): ConversationSample {
  const who = (m: ThreadMessage) => (m.user === botUserId ? "assistant" : (m.user ?? "bot"));
  return {
    thread: messages
      .filter((m) => Number(m.ts) < Number(latest.ts))
      .slice(-SAMPLE_MESSAGES)
      .map((m) => ({ who: who(m), text: clean(m.text, botUserId) }))
      .filter((m) => m.text),
    latest: { who: latest.user, text: clean(latest.text, botUserId) },
  };
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;

  const BOT = "UBOT";
  const m = (ts: string, user: string | null, text: string) => ({
    ts,
    user,
    text,
    bot: user === BOT,
  });
  const thread = [
    m("1.1", "UA", "Can someone look at the deploy?"),
    m("1.2", BOT, "Looking now."),
    m("1.3", "UB", "I think it was the cache"),
    m("1.4", "UA", `<@${BOT}> is that right?`),
    m("1.5", "UB", "later message"),
  ];

  test("only what people said since the agent last replied is carried over, never the message itself", () => {
    assert.equal(unseen(thread, BOT, "1.4"), "<@UB>: I think it was the cache");
    assert.equal(unseen(thread, BOT, "1.2"), "<@UA>: Can someone look at the deploy?");
  });

  test("a thread the agent has not spoken in is carried over whole, with its own mention stripped", () => {
    const first = [m("2.1", "UA", "context one"), m("2.2", "UB", `<@${BOT}> do it`)];
    assert.equal(unseen(first, BOT, "2.2"), "<@UA>: context one");
    assert.equal(unseen([], BOT, "2.2"), "");
  });

  test("carried-over context is bounded", () => {
    const long = Array.from({ length: 50 }, (_, i) => m(`3.${100 + i}`, "UA", `line ${i}`));
    const lines = unseen(long, BOT, "3.999").split("\n");
    assert.equal(lines.length, 30);
    assert.equal(lines.at(-1), "<@UA>: line 49", "the newest messages win");
    const wide = [m("4.1", "UA", "x".repeat(5000)), m("4.2", "UB", "short")];
    assert.ok(unseen(wide, BOT, "4.9").length < 1200, "one message is clipped");
  });

  test("the input stays the plain message when there is no context", () => {
    assert.equal(withContext("", "hello"), "hello");
    assert.match(
      withContext("<@UB>: hi", "hello"),
      /Earlier in this thread[\s\S]*<@UB>: hi[\s\S]*hello$/,
    );
  });

  test("the classifier sees the agent's own replies as the assistant, and only earlier messages", () => {
    const out = sample(thread, BOT, { user: "UA", text: `<@${BOT}> is that right?`, ts: "1.4" });
    assert.deepEqual(
      out.thread.map((t) => t.who),
      ["UA", "assistant", "UB"],
    );
    assert.deepEqual(out.latest, { who: "UA", text: "is that right?" });
  });
}
