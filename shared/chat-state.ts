import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";

export type ChatState = {
  entries: SnapshotEvent["entries"];
  partial: string;
  running: boolean;
  status: string;
  tools: Record<string, { name: string; output: string; done: boolean }>;
};
export const emptyChat: ChatState = { entries: [], partial: "", running: false, status: "Ready", tools: {} };
export function textContent(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((block) => block.type === "text" ? block.text : block.type === "toolCall" ? `Tool: ${block.name}` : "").filter(Boolean).join("\n");
}
export function applyEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.type) {
    case "snapshot": return {
      entries: event.entries, partial: event.generation?.message ? textContent(event.generation.message) : "",
      running: Boolean(event.run), status: event.generation?.retry ? `Retrying: ${event.generation.retry.error}` : event.run ? "Running" : "Ready",
      tools: Object.fromEntries(event.tools.map((tool) => [tool.callId, { name: tool.name, output: tool.output ?? "", done: tool.status === "done" }])),
    };
    case "run_start": return { ...state, running: true, status: "Running" };
    case "run_end": return { ...state, running: false, partial: "", status: "Ready" };
    case "message_start": return { ...state, partial: textContent(event.message) };
    case "message_update": {
      let partial = state.partial;
      for (const change of event.changes) {
        if (change.type === "text_delta") partial += change.delta;
        if (change.type === "message") partial = textContent(change.message);
      }
      return { ...state, partial };
    }
    case "message_end":
    case "entry_appended": return { ...state, partial: "", entries: [...state.entries.filter((entry) => entry.id !== event.entry.id), event.entry] };
    case "tool_execution_start": return { ...state, tools: { ...state.tools, [event.toolCallId]: { name: event.toolName, output: "", done: false } } };
    case "tool_execution_update": {
      const tool = state.tools[event.toolCallId] ?? { name: event.toolName, output: "", done: false };
      const output = event.output;
      return { ...state, tools: { ...state.tools, [event.toolCallId]: { ...tool, output: !output ? tool.output : "set" in output ? output.set : tool.output.slice(output.trimStart ?? 0) + (output.append ?? "") } } };
    }
    case "tool_execution_end": return { ...state, tools: { ...state.tools, [event.toolCallId]: { name: event.toolName, output: state.tools[event.toolCallId]?.output ?? "", done: true } } };
    case "auto_retry_start": return { ...state, status: `Retrying: ${event.errorMessage}` };
    case "task_failed": return { ...state, status: `Unanswered: ${event.message}` };
    default: return state;
  }
}
