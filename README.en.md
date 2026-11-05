# Discord for DotBridge

[简体中文](README.md) · [English](README.en.md)

Connect the explicitly bound owner's private Discord conversation to the existing ChatGPT dot through the official Secure MCP Tunnel. Shared authentication, encrypted state and routing come from `dot-bridge-core`; this repository owns the provider protocol.

Use the [unified distribution](https://github.com/Arcueid77/dot-bridge) to install only selected channels. Node.js >=24.15 and <25 is required. Preserve an existing working binding, storage key and database during upgrades. Credentials stay in protected files owned by the runtime user: directory 0700 and files 0600, or matching private Windows ACLs.

## Messaging and media

Text, images, audio and files can be read and replied to. Each attachment is limited to 5 MiB. Use the source-attachment reply tool to return a received attachment by index, without copying Base64 through the model. Replies return to the original authorized conversation.

A complete answer is bounded to 20,000 characters. Above 2000 native text characters, the default sends a complete `answer.txt` file. The opt-in `chunks` policy persists each native part and acknowledgement. Pending is not delivered; unknown outcomes remain uncertain and are never automatically repeated.

Text attachments include bounded UTF-8/UTF-16 excerpts. Shared protected Linux processing can also extract PDF and Office text. Truncation is explicit and original bytes remain available. Optional local Whisper provides reference transcription; raw audio and transcripts remain separate. Audio replies use existing recordings.

## Setup

1. Create or reuse your application and Bot in [Discord Developer Portal](https://discord.com/developers/applications). Save the token privately.
2. Install the bot into your server with `bot` scope and the required channel permissions. Owner DM setup needs no administrator grant. Open the bot's one-to-one DM.
3. Use Developer Mode to obtain your user ID and this DM's channel ID. Store `botToken`, `ownerId`, and `conversationId` in the protected credentials file, with IDs as strings.
4. Stop the old consumer and configure the unified router, official Tunnel and original-dot task through the [unified guide](https://github.com/Arcueid77/dot-bridge/blob/main/docs/new-channels.en.md).

Use [discord.env.example](docs/discord.env.example), with `DISCORD_CREDENTIALS_FILE` referencing the JSON. Startup verifies the token's bot and the DM participants. Owner-only operation uses `DIRECT_MESSAGES`; guild rules select the additional intents below.

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node --env-file=/var/lib/dot-bridge/private/discord.env scripts/run-live.js --confirm-live
```

This starts the backend. Use the unified router/service entry for persistent operation. Linux and Windows foreground hosts are supported; Linux provides systemd. macOS is unverified; trials and feedback are welcome.

Refresh the existing dot Bridge Tunnel tool directory. Reuse or renew the existing message event task; create one only when none exists. A real subscription supplies the callback and signing material. Allow only its verified exact callback hostname; keep MCP on loopback and retain standard HTTPS, DNS/IP, TLS and redirect checks.

Owner DMs use `discord.message.created` with `conversation=owner`. Keep one consumer and preserve its database/storage key. Gateway resume works while Discord accepts the saved session; after expiry the bridge resumes new events without fetching offline history. Bots, webhooks, edits and application interaction commands are excluded. Audio replies are playable/downloadable attachments; media captions are limited to 2,000 characters.


## Feedback, context and owner commands

Set `DOT_BRIDGE_INTERACTION_POLICY_FILE` in the private environment file to a JSON policy owned by the runtime user. Linux directories use 0700 and files 0600; Windows uses private ACLs. Start with owner DMs and an empty group list:

```json
{
  "version": 1,
  "feedback": {"enabled": true, "reaction": true, "typing": true, "streaming": true, "lease_seconds": 60},
  "context": {"max_messages": 20, "max_chars": 12000},
  "replies": {"long_text": "file"},
  "management": {"enabled": true},
  "groups": []
}
```

Receipt feedback follows durable acceptance. Reading a message or explicitly beginning work starts a bounded typing lease; terminal outcomes clear feedback. `get_discord_context` reads retained history and quotes in the same conversation, topic and configured member scope.

Owner DMs accept `/help`, `/status`, `/queue`, `/subscription`, and `/cancel [reference]`. Cancellation affects unsent bridge replies; inflight and uncertain outcomes remain for review. The original dot/platform renews the real subscription.

`get_discord_reply_status` reports final delivery: `none` before enqueue, `pending` after enqueue, `processing` during a final write, and `sent` after platform acknowledgement. Feedback has a separate lease. Processing still needs one final answer; uncertain delivery is never automatically repeated.

Use `begin_discord_reply` when work genuinely starts, `append_discord_reply` for consecutive cumulative generated text starting at sequence 1, and `reply_to_discord` to finalize the same native message. Short answers can finalize directly. Long text defaults to a complete file; `replies.long_text: "chunks"` opts into durably acknowledged native parts.

## Opt-in groups and topics

New groups remain disabled. Add an owner-approved group/channel rule to the same policy's `groups` array:

```json
{
  "conversation_id": "REPLACE_WITH_VERIFIED_GROUP_OR_CHANNEL_ID",
  "enabled": true,
  "members": "all",
  "mention": true,
  "auto_reply": "off",
  "reply_in_thread": true,
  "context_scope": "sender"
}
```

`members` is `owner`, `allowlist`, or `all`; supply `allow_from` for an allowlist. `auto_reply` is `off`, `keywords`, or `all`; supply `keywords` for keyword mode. Include lists only for their corresponding modes. Real mentions and automatic triggers are combined with OR. `context_scope` defaults to `sender`, with explicit `group` sharing available; conversation and topic isolation remain in place.

Settle inflight replies, then coordinate the existing task's single subscription to `conversation=configured` through its real subscription flow. Keep the database and deduplication state. Group tasks use the source scope and preserve private-chat memory. The operator approves platform permissions and the added reception scope.

Discord mention mode adds guild-message intent. Keyword/all-message mode also needs Message Content intent enabled in the official portal. Forum rules use the parent channel ID while replies preserve the actual thread; ordinary configured channels use their channel ID. Replies suppress additional mentions.

See [shared interaction configuration](https://github.com/Arcueid77/dot-bridge/blob/main/docs/new-channels.en.md#shared-interaction-and-group-rules) for policy limits and protected-file requirements.

## Owner reminders

Explicit `DOT_BRIDGE_OUTBOUND=owner-text` enables owner-only text and fixed reminders, at most 2,000 characters each. Recurring reminders require an end date. Reuse the existing task and inspect stored outcomes. See [scheduled messages](https://github.com/Arcueid77/dot-bridge/blob/main/docs/scheduled-messages.en.md).
