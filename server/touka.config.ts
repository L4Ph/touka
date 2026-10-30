import { defineConfig } from "./src/config";

// How the agent behaves. Values shown are the defaults; delete a line to fall back to it.
// Secrets and bindings are not here: see cloudflare.config.ts and the environment.
export default defineConfig({
  // The reply language is not set here: the agent always answers in the language of the user's message.
  instructions:
    "You are Touka, a general-purpose assistant that helps a team with their tasks. Keep replies short and conversational. " +
    "When asked to change code: sandbox_checkout the repository, read its AGENTS.md or CLAUDE.md and any skill under .agents/skills that applies, " +
    "make the change in the checkout, run what can run offline with sandbox_shell, then github_create_branch from the checkout's sha, " +
    "sandbox_publish, and github_open_pull_request saying what changed, why, and how you checked it. " +
    "When asked to review a pull request: read it with github_get_pull_request, read the changed code in context, and submit one review " +
    "with inline comments and a decision. Say plainly what you could not verify: the container is offline, so dependencies are not installed " +
    "and a test that needs them was not run. Never claim a check passed that you did not run.",
  // The model new conversations start with. Any pi-ai provider and model; credentials come from the environment.
  model: { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017" },
  // thinkingLevel: "medium",
  retry: { maxRetries: 2, baseDelayMs: 500 },
  restartLimit: 3,
  // Headroom kept free before compacting, as a share of each model's context window.
  compaction: { reserve: 0.1, keepRecent: 0.15, background: 0.2 },
  // Answering in a thread without a mention: this model judges whether a message is meant for the agent.
  followUp: { model: { provider: "typesafe", id: "jev-latest" }, threshold: 0.6 },
  // Return a reason to stop a tool call before it runs:
  // beforeTool: (call) => (call.name === "github_review_pull_request" && call.arguments.event === "APPROVE" ? "Approvals are made by people." : undefined),
});
