# Session event stream

`GET /api/sessions/:sessionId/events` upgrades to a read-only Durable Object WebSocket. Send `Authorization: Bearer <team token>` in the upgrade headers. Both Worker and DO enforce team authentication and session access. Missing auth configuration fails closed. Query parameters are rejected; never place credentials in URLs. A session must exist before connecting.

The first JSON frame is `{ type: "snapshot", sequence: 0, snapshot }`, containing Pi 1.5's native `ConversationView`. Subsequent frames are `{ type: "changes", sequence, ops }`, containing the native watch operations to apply to that view. Types and limits are exported from `server/src/stream-protocol.ts`. The view includes the newest 10 entries initially (growing to 20 before trimming back to 10) and live documents (tools, generation, failures, and inbox); it is not a normalized chat transcript. Reconnect always replaces the client view with a fresh snapshot; there is no cursor replay. This replaces the pre-1.5 event protocol without a compatibility adapter.

Clients acknowledge received frames with `{ type: "ack", sequence }`; acknowledgments are cumulative. Only outstanding sequence numbers are valid. `{ type: "unsubscribe" }` closes normally. All other commands close with 1008 and cannot mutate Pi. Disconnect, unsubscribe, stream completion and errors stop the Pi subscription and release the connection slot.

Limits per session: 8 connections; 256 KiB per outbound frame; 1 KiB per inbound message; 32 unacknowledged frames and 1 MiB outstanding bytes per connection. Slow consumers close with 1008; oversized messages close with 1009. A snapshot exceeding the frame bound closes the stream: use HTTP history instead. Sockets are hibernatable; their in-memory watches are recreated with a fresh snapshot on wake. Clients must accept a new sequence starting at zero. Authorization is checked at upgrade, not continuously revalidated during an established connection.

`vp test stream-frame` opens a real Pi 1.4 SQLite fixture with Pi 1.5, preserves its transcript, continues an operation, and serializes native view changes. This does not replace live WebSocket/Worker verification.
