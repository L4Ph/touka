import type nodeAssert from "node:assert/strict";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** How the agent behaves. Infrastructure and secrets live in `cloudflare.config.ts` and the environment. */
export interface ToukaConfig {
  /** The agent's identity and standing orders: the system prompt, before the language rule. */
  instructions: string;
  /** Model for new conversations, any pi-ai provider and model. A conversation can still pick another. */
  model: { provider: string; id: string };
  /** Reasoning effort for new conversations. Omitted: the model's own default. */
  thinkingLevel?: ModelThinkingLevel;
  /** Model request retries. */
  retry: { maxRetries: number; baseDelayMs: number };
  /** How many times a crashed run is restarted before it is parked. */
  restartLimit: number;
  /** Compaction headroom as a share of each model's context window. */
  compaction: { reserve: number; keepRecent: number; background: number };
  /**
   * Replying in a thread without a mention: a small classifier model judges whether a message is meant
   * for the agent, and the agent answers at or above `threshold`.
   */
  followUp: { model: { provider: string; id: string }; threshold: number };
  /** Runs before every tool call. Return a reason to block the call, nothing to let it through. */
  beforeTool?: (call: { name: string; arguments: Record<string, unknown> }) => string | undefined;
}

const defaults: ToukaConfig = {
  instructions:
    "You are Touka, a general-purpose assistant that helps a team with their tasks. Keep replies short and conversational. " +
    "When asked to change code: sandbox_checkout the repository, read its AGENTS.md or CLAUDE.md and any skill under .agents/skills that applies, " +
    "make the change in the checkout, run what can run offline with sandbox_shell, then github_create_branch from the checkout's sha, " +
    "sandbox_publish, and github_open_pull_request saying what changed, why, and how you checked it. " +
    "When asked to review a pull request: read it with github_get_pull_request, read the changed code in context, and submit one review " +
    "with inline comments and a decision. Say plainly what you could not verify: the container is offline, so dependencies are not installed " +
    "and a test that needs them was not run. Never claim a check passed that you did not run.",
  model: { provider: "anthropic", id: "claude-sonnet-5-5" },
  retry: { maxRetries: 2, baseDelayMs: 500 },
  restartLimit: 3,
  compaction: { reserve: 0.1, keepRecent: 0.15, background: 0.2 },
  followUp: { model: { provider: "typesafe", id: "jev-latest" }, threshold: 0.6 },
};

export function defineConfig(
  config: Partial<Omit<ToukaConfig, "model" | "retry" | "compaction" | "followUp">> & {
    model?: Partial<ToukaConfig["model"]>;
    retry?: Partial<ToukaConfig["retry"]>;
    compaction?: Partial<ToukaConfig["compaction"]>;
    followUp?: Partial<ToukaConfig["followUp"]>;
  } = {},
): ToukaConfig {
  return {
    ...defaults,
    ...config,
    model: { ...defaults.model, ...config.model },
    retry: { ...defaults.retry, ...config.retry },
    compaction: { ...defaults.compaction, ...config.compaction },
    followUp: { ...defaults.followUp, ...config.followUp },
  };
}

/** Always appended to `instructions`, so a replacement of them cannot lose it. */
const REPLY_LANGUAGE =
  "Reply in the language the user wrote in, matching their register, and stay in it unless they ask to switch.";

/** The identity section of the system prompt. */
export function systemPrompt({ instructions }: ToukaConfig): string {
  return `${instructions} ${REPLY_LANGUAGE}`;
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { default: config } = await import("../touka.config");

  test("unset options fall back to defaults, and nested options merge field by field", () => {
    const resolved = defineConfig({ retry: { maxRetries: 5 }, compaction: { reserve: 0.2 } });
    assert.deepEqual(resolved.retry, { maxRetries: 5, baseDelayMs: 500 });
    assert.deepEqual(resolved.compaction, { reserve: 0.2, keepRecent: 0.15, background: 0.2 });
    assert.equal(resolved.restartLimit, 3);
  });

  test("the agent always replies in the user's language, whatever the instructions say", () => {
    assert.match(systemPrompt(defineConfig()), /Reply in the language the user wrote in/);
    const custom = systemPrompt(defineConfig({ instructions: "Be terse." }));
    assert.ok(custom.startsWith("Be terse. "));
    assert.match(custom, /Reply in the language the user wrote in/);
  });

  test("the shipped touka.config.ts is a complete, valid configuration", () => {
    assert.ok(config.instructions.length > 0);
    assert.ok(config.compaction.reserve > 0 && config.compaction.reserve < 1);
  });
}
