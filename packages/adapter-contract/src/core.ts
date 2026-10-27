// Transport-independent IDs and control-plane envelopes. Adapter metadata stays outside input.
export interface SubmitInput {
  sessionId: string;
  operationId: string;
  input: string;
}
export interface SubmitReceipt {
  sessionId: string;
  operationId: string;
  accepted: boolean;
}
export interface OperationStatus {
  sessionId: string;
  operationId: string;
  status: "queued" | "running" | "done" | "unanswered" | "parked";
  text?: string;
  reason?: string;
}
export interface Principal {
  id: string;
  sessions: readonly string[];
  resources: readonly string[];
}
export interface ModelSelection {
  provider: string;
  id: string;
}
export function isModelSelection(value: unknown): value is ModelSelection {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).length === 2 &&
    typeof data.provider === "string" &&
    typeof data.id === "string" &&
    data.provider.length > 0 &&
    data.provider.length <= 128 &&
    data.id.length > 0 &&
    data.id.length <= 256
  );
}
export interface ApiError {
  error: { code: string };
}
export const LIMITS = {
  requestBytes: 32_768,
  inputCharacters: 16_000,
  idCharacters: 128,
  pending: 16,
  tools: 32,
} as const;
export const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function isSubmitInput(value: unknown): value is SubmitInput {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).length === 3 &&
    validId(data.sessionId) &&
    validId(data.operationId) &&
    typeof data.input === "string" &&
    data.input.trim().length > 0 &&
    data.input.length <= LIMITS.inputCharacters
  );
}
