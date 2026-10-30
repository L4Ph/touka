# Session event stream

`GET /api/sessions/:sessionId/events` upgrades to a read-only Durable Object WebSocket. Send `Authorization: Bearer <team token>` in the upgrade headers. Both Worker and DO enforce team authentication and session access. Missing auth configuration fails closed. Query parameters are rejected; never place credentials in URLs. A session must exist before connecting.

The first JSON frame is `{ type: "snapshot", sequence: 0, snapshot }`, containing Pi's native `SnapshotEvent`. Subsequent frames are `{ type: "events", sequence, events }`, containing native committed Pi event batches. Types and limits are exported from `server/src/stream-protocol.ts`. Native Pi entries preserve the SDK event format rather than a normalized chat transcript. Reconnect always opens a fresh snapshot, including changes made while disconnected; there is no cursor replay. Pi can also replace overflowing internal event batches with a snapshot event inside a batch.

Clients acknowledge received frames with `{ type: "ack", sequence }`; acknowledgments are cumulative. Only outstanding sequence numbers are valid. `{ type: "unsubscribe" }` closes normally. All other commands close with 1008 and cannot mutate Pi. Disconnect, unsubscribe, stream completion and errors stop the Pi subscription and release the connection slot.

Limits per session: 8 connections; 256 KiB per outbound frame; 1 KiB per inbound message; 32 unacknowledged frames and 1 MiB outstanding bytes per connection. Slow consumers close with 1008; oversized messages close with 1009. A snapshot exceeding the frame bound closes the stream: use HTTP history instead. Connections are in-memory, non-hibernating subscriptions; eviction/restart requires reconnect. Authorization is checked at upgrade, not continuously revalidated during an established connection.

The stream protocol is checked against real Pi events in the deployed Worker; there is no separate end-to-end test.
