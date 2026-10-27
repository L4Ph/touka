# Mandarin

Terminology for a general-purpose agent with multiple entry points.

**Mandarin**:
The product and general-purpose agent with team-shared conversations, distinct from internal package IDs and Cloudflare bindings.

## Language

**Agent Core**:
The owner of a conversation and its execution. It does not depend on the service that initiated the work.
_Avoid_: Slack bot when referring to the core.

**Adapter**:
A connection that converts external service requests into agent input and routes results back to their origin.
_Avoid_: Agent when referring to a connection module.

**Session**:
One continuing conversation, associated with an external thread or created directly from the Web UI.

**Operation**:
An accepted input and its execution. Retries identify the same operation.

**Tool**:
An operation the agent can perform only within explicitly granted authority, distinct from an Adapter that receives service events.
