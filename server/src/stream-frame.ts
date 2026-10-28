import { STREAM_LIMITS, type SessionStreamFrame } from "./stream-protocol";

export function encodeStreamFrame(frame: SessionStreamFrame) {
  const data = JSON.stringify(frame);
  const bytes = new TextEncoder().encode(data).byteLength;
  return bytes > STREAM_LIMITS.frameBytes ? null : { data, bytes };
}
