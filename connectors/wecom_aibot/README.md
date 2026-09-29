# ArcForge WeCom AiBot Connector

This process receives WeCom AiBot callbacks and forwards text, file, and image
messages over the protobuf WebSocket endpoint `/ws/v2/channel`. The desktop app
remains the execution owner. The connector never receives tool calls, workdirs,
model selections, or conversation history; it receives an output file only
when the desktop runtime explicitly presents that file to the user.

In desktop-managed local mode, ArcForge starts the bundled Gateway first,
waits for its loopback health check, and then starts this Connector. The
desktop generates separate Agent and channel tokens in Rust memory and passes
them to the child processes without exposing them to the WebView.

For external-Gateway development, run the Connector from the repository root:

```powershell
python -m connectors.wecom_aibot.worker
```

Required runtime variables are `WECOM_AIBOT_BOT_ID`, `WECOM_AIBOT_SECRET`,
`ARCFORGE_GATEWAY_CHANNEL_TOKEN`, and `ARCFORGE_GATEWAY_URL` (or
`ARCFORGE_GATEWAY_CHANNEL_URL`). The connector can read these values from the
desktop `config.sqlite` when it runs on the same machine; environment values
always take precedence. In external mode, the desktop WeCom settings page
stores the Bot ID, AiBot Secret, channel token, tenant/connector identity, and
enable switch. The externally deployed Gateway must be started with the same
`ARCFORGE_GATEWAY_CHANNEL_TOKEN`; the desktop database does not rewrite a
separately deployed Gateway process. Group messages are disabled unless
`ARCFORGE_GATEWAY_CHANNEL_ALLOW_GROUP_MESSAGES=true` is set in both the
connector and Gateway configuration.

The Gateway persists accepted commands and their terminal results in SQLite.
Its default path is `./arcforge-gateway-state.sqlite3`; production deployments
must place this file on a persistent volume by setting
`ARCFORGE_GATEWAY_STATE_DB` (for example, `/var/lib/arcforge/gateway-state.sqlite3`).
Gateway startup fails if the configured database cannot be created or opened;
it never silently falls back to volatile command state.

Session mappings and processed callback IDs are stored in
`~/.arcforge/channel-state/wecom-state.sqlite3`. Override the location with
`ARCFORGE_CHANNEL_STATE_DB`. The connector refuses to start when a configured
state database cannot be opened; it does not silently fall back to volatile
state.

## Files and images

Incoming `message.file` and `message.image` callbacks are downloaded and
decrypted immediately because WeCom download URLs expire quickly. The
Connector strips directory components from received filenames, applies the
configured byte limit, and forwards the content as a normal ArcForge chat
attachment. Files default to a 20 MB maximum; lower it with
`ARCFORGE_GATEWAY_CHANNEL_MAX_FILE_BYTES`. WeCom images are additionally capped
at 10 MB.

For outgoing files, ArcForge forwards only files selected by the explicit
`PresentFile` tool. The Connector uploads each result through WeCom's chunked
media protocol and then sends the returned media ID to the originating chat.
Files merely read by a tool or present elsewhere in the workspace are never
sent automatically. Upload, download, and delivery errors are logged without
URLs, media IDs, filenames, response bodies, or message content.

## Proactive messages

When the managed Connector is authenticated, the ArcForge WeCom settings page
can send a Markdown message to an exact WeCom target. Use a user's `userid` for
a direct message or a group `chatid` for a group message. The target and message
are passed to the existing authenticated Connector over its local parent-child
control pipe; they are not persisted as settings or written to runtime logs.

The current control surface intentionally supports Markdown only. It does not
provide a contact directory, scheduled delivery, or model-initiated sending.

## Restricted commands

The connector recognizes only these exact commands (leading and trailing
whitespace is ignored):

- `/new`, `/newchat`, `/新会话`: start a new isolated conversation session
- `/compact`, `/压缩`, `/压缩上下文`: request compaction of the current session
- `/help`, `/帮助`: show the supported command help locally in the Connector

`/new` and `/compact` are sent to the Gateway in a dedicated protobuf field and
are never converted into ordinary model prompts. `/help` does not start or
interrupt a desktop run. Other slash-prefixed text remains a normal user
message. Sessions are isolated by WeCom user and chat: direct messages use one
session per user, while group sessions also include the group chat ID. Messages
for one identity are submitted one at a time across Connector processes that
share the state database, while different identities can run concurrently.
Within one Connector process, queued callbacks retain arrival order. A failed
`/new` keeps the previous session active. Its rotation
candidate is persisted before Gateway submission, so a canonical retry cannot
commit a candidate that was never run. Commands accepted before a Gateway
disconnect are resubmitted with the same external message ID after reconnection
and reuse the canonical run. Session IDs and completed callback results remain
stable across Connector restarts. Expired processing leases can be reclaimed
safely, while claim-token fencing prevents an older worker from replacing the
newer worker's result.

The desktop receives the authenticated `external_user_id` in the trusted
principal context for each turn. The identity is used to isolate conversations
and provide trusted audit metadata; it does not define a separate capability
policy. WeCom turns use the desktop's current workdir, Skills, system tools,
MCP, Memory, SSH, tunnel, and database settings, including the same tool-level
safety checks.

## Progress placeholder

While the desktop runs a turn, the Connector keeps one WeCom stream message
alive and rewrites it in place. By default that placeholder shows what the run
is doing: the tail of the model's current reasoning, the tools it started
(names only, mapped to short labels), and the elapsed time. The Gateway only
forwards these transient fragments to connectors that opt in at handshake time
(`channel_progress_version = 1`); tool arguments and tool results are never
forwarded. Progress is coalesced to at most one WeCom update every three
seconds and is never stored or replayed.

The final answer overwrites the same stream message, so nothing from the
placeholder remains in the WeCom conversation after the turn completes. The
one exception is a stream context that WeCom expires before the answer
arrives: that message can no longer be updated and keeps its last placeholder,
while the answer is delivered as a separate proactive message. Set
`ARCFORGE_GATEWAY_CHANNEL_SHOW_PROGRESS=false` to fall back to the plain
"processing" placeholder.

## Interactive questions

The desktop `AskUserQuestion` tool is synchronized to WeCom through a restricted
input protocol. The connector exposes only the question text and bounded,
gateway-generated aliases; it never exposes arbitrary desktop tool calls or
workspace details.

When card delivery is available, WeCom receives an official
`button_interaction` card with one question at a time. Each input request sends
an independent `template_card` through the SDK's `send_message`: direct chats
target the user's `userid`, and group chats target the `chatid`. The original
reply remains a plain stream for question details, progress, and the final
answer. This avoids upgrading an existing stream to a combined card message
or trying to attach multiple cards to one message (the SDK permits only one).
A click is identified by the opaque `task_id` and a question-specific
`event_key`; delayed clicks on an earlier question cannot answer the next one.
The connector updates the card immediately
and advances to the next question. After the final click, the connector sends
the selections back to the same desktop run. If the card callback is unavailable
or rejected, users can reply with option numbers (`1` for one question or
`1,2` in question order for two questions). Invalid, duplicate, expired, and
already-resolved replies are handled without starting a second desktop turn.

Card prompts direct users to click a button, which sends an interaction callback
without a separate user text message. They also retain numbered reply
instructions in case the client does not display the buttons; a successful
delivery acknowledgement alone cannot confirm client rendering. Failed card
updates show the complete numbered fallback, and a failed final submission
restores the last question for another click. Manually sent option numbers remain in
WeCom chat history; the connector cannot hide them. Successful submissions are
consumed silently, including duplicate callbacks, and the original reply stream
continues with progress and the final result. Submission failures and timeout
or cancellation notices remain visible.

The desktop may also answer the same question from its local card. In that case
the connector receives a resolved notification, records completion locally,
and stops intercepting subsequent text without sending a success notice. A
subsequent click updates the original card to its processed state. The default response window is three
minutes, matching the desktop tool's timeout behavior.

## Per-user memory

Only WeCom conversations use isolated memory spaces. The desktop resolves a
space from its persisted, trusted installation and user binding; group chats
also include the group ID. New sessions keep the same space, while ordinary
desktop and browser conversations continue using the existing local library.

WeCom memory lives under `~/.arcforge/channel-memory/<space-hash>/`, with its
own Markdown files and SQLite index. Recall, MemoryManager operations, delayed
extraction and organizer runs use the same captured context. Missing bindings
or a disabled memory policy fail closed, and scoped historical-chat search is
disabled until the shared history index supports owner filtering. Existing
local memories are not copied into new WeCom spaces.

The memory settings panel can select a local or WeCom space for inspection and
cleanup. It currently lists spaces with an active binding and memory enabled;
archived-only or disabled spaces remain on disk but are omitted from this list
and scheduled organizing. This isolates the memory feature; unrestricted local
shell/filesystem access is still governed by the deployment's tool permissions.
