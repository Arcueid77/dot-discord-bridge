# Provider implementation notes

The Discord transport uses the official v10 REST API and uncompressed JSON
Gateway with only `DIRECT_MESSAGES` (4096). Shared MCP, storage, callback policy
and outbox are supplied by `@dot-bridge/core/channels`.

Initialization checks the bot identity, exact type-1 DM recipient and Gateway
address before opening a socket. REST is restricted to `https://discord.com` and
Gateway addresses to `gateway*.discord.gg` under the explicit gateway hostname
pattern. Redirects are refused, HTTP bodies are limited to 2 MiB, Gateway frames
to 1 MiB, pending dispatches to 256, and initialization/request timeouts are
bounded. Incoming events never supply a network destination.

Dispatch is serial; control frames remain independent. A sequence is persisted
only after the corresponding ingestion resolves. Reconnect waits for owned
ingestion before reading the latest persisted session, uses capped backoff, and
paces new Identify commands at least five seconds apart. Fatal authentication or
intent closes block reconnect. Stop aborts HTTP, cancels timers, closes the
socket with a resumable close code, drains ingestion and awaits pending sends.

Replies use the bound stored channel, disable allowed mentions, hash core's
stable idempotency key to a 24-character nonce and request `enforce_nonce`.
There is no send retry, including after 429, timeout or ambiguous failure.

Fixture tests exercise initialization and scope, ingestion ordering/failure,
resume persistence, heartbeat liveness while ingestion is delayed, fatal close,
attachment metadata, nonce, uncertain send, private binding, bounded responses
and shutdown. Tests inject fetch and an EventTarget WebSocket implementation;
they never use accounts or platform credentials. Run `npm run check` and
`npm test` with a supported Node release. Platform account acceptance and the
original dot subscription must be verified separately before live use.

Protocol references:

- https://docs.discord.com/developers/events/gateway
- https://docs.discord.com/developers/events/gateway-events
- https://docs.discord.com/developers/resources/message#create-message
- https://docs.discord.com/developers/topics/opcodes-and-status-codes

The adapter layout was compared with cc-connect at
`2dec7173bdd44ec598c3c7e5c7ff00407acfdedf`; implementation is original and follows
this project's single-owner durable-ingestion contract.
