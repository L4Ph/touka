import type { AgentEvent, SnapshotEvent } from '@earendil-works/pi-durable';

export const STREAM_LIMITS = {
  connections: 8, frameBytes: 262_144, clientBytes: 1024, unackedFrames: 32, unackedBytes: 1_048_576,
} as const;
export type SessionStreamFrame =
  | { type: 'snapshot'; sequence: number; snapshot: SnapshotEvent }
  | { type: 'events'; sequence: number; events: readonly AgentEvent[] };
