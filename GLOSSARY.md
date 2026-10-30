# Touka

Terminology for a general-purpose agent with multiple entry points.

## Language

**Touka**:
The name of this product and its general-purpose agent for a private team.

**Agent Core**:
The owner of a conversation and its execution. It does not depend on the service that initiated the work.
_Avoid_: Slack bot when referring to the core.

**Connector**:
A connection that manages authentication, authorization, and external service reads and writes. It can be used independently of the conversation's entry point.
_Avoid_: Trigger when referring to service access.

**Trigger**:
An entry point that receives an external Event, submits input to a conversation, and routes results back. Invocation does not automatically grant Connector permissions.
_Avoid_: Connector for an entry point; Adapter as a product term.

**Event**:
Data describing an external occurrence, not the executable entry point itself.

**Session**:
One continuing conversation, associated with an external thread or created through the management API. Authorized callers share the original conversation rather than separate copies.

**Operation**:
An accepted input and its execution. Retries identify the same operation.

**Tool**:
An operation explicitly exposed to the agent, including Connector operations and isolated execution, usable only within granted permissions.

## Durable Objects

- `PiDurable` (`PI_DURABLE`): one session's Pi conversation, execution grant, pending input and event stream. One thread maps to one instance.
- `DELIVERY`: a Cloudflare Queue whose consumer is the same Worker. Each message only wakes a reply attempt for one operation; the reply record (destination, attempts, failure) lives in the `PiDurable` that answers it. It is not the Trigger itself; Triggers are ordinary Worker routes.
- `SandboxContainer` (`SANDBOX_CONTAINER`): container coordination for isolated JavaScript execution on the managed Node image, with best-effort workspace snapshots.
