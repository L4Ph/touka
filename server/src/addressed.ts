import type { ConversationSample } from "@remote-agent/trigger-contract";
import config from "../touka.config";
import type { Env } from "./env";
import { sessionModels } from "./models";

const QUESTION = {
  addressed: {
    type: "bool",
    instructions:
      "The latest message is in a thread where an AI assistant has been taking part. Is it a request, question, confirmation or instruction for that assistant? Conversation between people is false.",
    criteria: {
      true: "It asks, tells or confirms something with the AI assistant: a request, a question, a go-ahead, a correction",
      false:
        "People talking to each other, talking to themselves, addressing another person, or saying they will handle it themselves",
    },
  },
} as const;

/**
 * Judge with a small classifier, not the agent. Any failure counts as "not addressed": staying
 * quiet costs one more mention, while answering people's own conversation costs trust.
 */
export async function addressed(env: Env, sample: ConversationSample): Promise<boolean> {
  try {
    const { model: wanted, threshold } = config.followUp;
    const models = sessionModels(env);
    const model = models.getModelOfType("classifier", wanted.provider, wanted.id);
    if (!model) return false;
    const result = await models.classify(model, {
      state: { thread: sample.thread, latest: sample.latest },
      questions: QUESTION,
    });
    const answer = result.answers?.addressed;
    return answer?.type === "bool" && answer.probability >= threshold;
  } catch {
    return false;
  }
}
