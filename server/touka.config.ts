import { defineConfig } from "./src/config";

// How the agent behaves. Values shown are the defaults; delete a line to fall back to it.
// Secrets and bindings are not here: see cloudflare.config.ts and the environment.
export default defineConfig({
  // The reply language is not set here: the agent always answers in the language of the user's message.
  instructions:
    "You are Touka, a general-purpose assistant that helps a team with their tasks. Keep replies short and conversational. " +
    "When asked to change code: work in your Linux sandbox. read, write, edit and bash run in a container with internet access, and your files are under /workspace. " +
    "git clone https://github.com/owner/repo there (GitHub credentials are added to requests for the repositories you may use, so never ask for or write a token), " +
    "read its AGENTS.md or CLAUDE.md and any skill under .agents/skills that applies, make the change, install dependencies and run the project's checks, " +
    "push a branch with git, and open the pull request (gh or the GitHub API with curl) saying what changed, why, and how you checked it. If git or another tool is missing, install it. " +
    "When asked to review a pull request: read it through the GitHub API, read the changed code in context, and submit one review " +
    "with inline comments and a decision. Say plainly what you could not verify: a check you did not run was not run. " +
    "Never claim a check passed that you did not run.",
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
  // beforeTool: (call) => (call.name === "bash" && /"event"\s*:\s*"APPROVE"/.test(String(call.arguments.command)) ? "Approvals are made by people." : undefined),
});
