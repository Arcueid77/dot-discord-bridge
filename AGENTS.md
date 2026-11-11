# Repository scope
This repository owns one IM provider only. Shared MCP, encrypted state, callback policy, persistence and process lifecycle live in ../dot-bridge-core; do not duplicate them here.
- You are not alone in the workspace. Do not revert other contributors' edits.
- Provider contract is described in ../dot-bridge-core/docs/channel-provider-contract.md. Keep src/channel.js metadata stable unless coordinated.
- Use synthetic HTTP/WebSocket fixtures in ordinary tests. Never connect real accounts, generate persistent credentials or create callback subscriptions.
- Never log raw provider events, messages, identities, secrets, full callback URLs or SDK errors.
- User-facing docs explain configuration, use and limitations; put development evidence separately.
- Make small fixes, documentation updates and routine maintenance directly on `main`; do not create a branch by default. Reserve `dev/` branches for larger work that needs isolation.
- Run npm run check and npm test for behavior changes.
