# ArcForge WeCom AiBot Connector

This process receives WeCom AiBot callbacks and forwards text messages over
the restricted protobuf WebSocket endpoint `/ws/v2/channel`. The desktop app
remains the execution owner; the connector never receives tool calls, files,
workdirs, model selections, or conversation history.

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
for one identity are submitted in arrival order while different identities can
run concurrently. A failed `/new` keeps the previous session active. Session
IDs remain stable for the lifetime of the connector process; restarting the
connector starts fresh sessions.

The desktop receives the authenticated `external_user_id` in the trusted
principal context for each turn. Skills and built-in executors should use that
value for explicit local authorization lookups; they must not infer identity
from message text. WeCom principals do not receive MCP invocation scope by
default.
