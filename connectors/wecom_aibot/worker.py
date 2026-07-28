"""WeCom AiBot worker that bridges user messages to the ArcForge desktop."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from aibot import WSClient, WSClientOptions, generate_req_id

from .channel_client import ChannelClient, make_inbound
from .commands import SessionSequencer, SessionStore, parse_command
from .config import ConnectorConfig, load_config
from .dedupe import DedupeStore

logger = logging.getLogger(__name__)

CONNECTOR_READY_MARKER = "__ARCFORGE_WECOM_CONNECTOR_READY_V1__"

_HELP_TEXT = "\n".join(
    (
        "可用命令：",
        "/new - 开启新会话",
        "/compact - 压缩当前会话上下文",
        "/help - 查看命令",
    )
)


def _body(frame: dict[str, Any]) -> dict[str, Any]:
    body = frame.get("body")
    return body if isinstance(body, dict) else {}


def _routing(body: dict[str, Any]) -> tuple[str, str, str]:
    chat_id = str(body.get("chatid") or body.get("chat_id") or "").strip()
    sender = body.get("from")
    if isinstance(sender, dict):
        user_id = str(sender.get("userid") or "").strip()
    else:
        user_id = ""
    user_id = user_id or str(body.get("userid") or "").strip()
    raw_chat_type = body.get("chattype") or body.get("chat_type")
    chat_type = str(raw_chat_type or "").strip().lower()
    if chat_type in {"1", "single", "direct"}:
        chat_type = "single"
    elif chat_type in {"2", "group"}:
        chat_type = "group"
    else:
        # Unknown or missing values must not fall back to direct-chat policy.
        chat_type = ""
    return chat_id, user_id, chat_type


def _external_message_id(frame: dict[str, Any]) -> str:
    body = _body(frame)
    headers = frame.get("headers") if isinstance(frame.get("headers"), dict) else {}
    return str(
        body.get("msgid")
        or body.get("message_id")
        or body.get("external_message_id")
        or headers.get("req_id")
        or ""
    ).strip()


def _text(frame: dict[str, Any]) -> str:
    body = _body(frame)
    text = body.get("text")
    if isinstance(text, dict):
        return str(text.get("content") or "").strip()
    return str(body.get("content") or "").strip()


def _stream_id() -> str:
    return generate_req_id("arcforge-stream")


async def _reply_final(client: Any, frame: dict[str, Any], stream_id: str, text: str) -> None:
    await client.reply_stream(frame, stream_id, text or "(empty response)", True)


async def _handle_text(
    wecom: Any,
    channel: ChannelClient,
    dedupe: DedupeStore,
    sessions: SessionStore,
    config: ConnectorConfig,
    frame: dict[str, Any],
    sequencer: SessionSequencer | None = None,
) -> None:
    body = _body(frame)
    text = _text(frame)
    if not text:
        return
    if len(text.encode("utf-8")) > config.max_text_bytes:
        await _reply_final(wecom, frame, _stream_id(), "消息过长，请分段发送。")
        return
    chat_id, user_id, chat_type = _routing(body)
    if not user_id:
        await _reply_final(wecom, frame, _stream_id(), "无法识别企业微信用户身份。")
        return
    if chat_type not in {"single", "group"}:
        await _reply_final(wecom, frame, _stream_id(), "无法识别企业微信聊天类型。")
        return
    if chat_type == "group" and not config.allow_group_messages:
        await _reply_final(wecom, frame, _stream_id(), "当前桌面端未开启群聊消息。")
        return
    if chat_type == "group" and not chat_id:
        await _reply_final(wecom, frame, _stream_id(), "无法识别企业微信群聊。")
        return
    external_id = _external_message_id(frame)
    if not external_id:
        await _reply_final(wecom, frame, _stream_id(), "无法识别消息编号，请稍后重试。")
        return
    session_key = sessions.key(
        chat_type=chat_type,
        chat_id=chat_id,
        external_user_id=user_id,
    )
    claimed, existing = dedupe.claim(session_key, external_id)
    if not claimed:
        if existing and existing.completed:
            await _reply_final(wecom, frame, _stream_id(), existing.text)
        return

    command = parse_command(text)
    stream_id = _stream_id()
    failure_message = "处理失败，请稍后重试。"

    if command == "help":
        dedupe.complete(
            session_key,
            external_id,
            text=_HELP_TEXT,
            status="completed",
        )
        await _reply_final(wecom, frame, stream_id, _HELP_TEXT)
        return

    # Acknowledge before waiting behind a previous turn so WeCom does not time
    # out while preserving per-user delivery order into the desktop runtime.
    try:
        await wecom.reply_stream(frame, stream_id, "正在处理，请稍候…", False)
    except Exception:
        logger.exception("WeCom placeholder reply failed")

    async def submit_in_order() -> None:
        rotation = None
        if command == "new":
            rotation = sessions.reserve_rotation(session_key)
            channel_session_id = rotation.candidate_session_id
        else:
            channel_session_id = sessions.get_for_key(session_key)

        inbound = make_inbound(
            external_message_id=external_id,
            external_user_id=user_id,
            chat_id=chat_id if chat_type == "group" else "",
            chat_type=chat_type,
            text="" if command else text,
            command=command,
            channel_session_id=channel_session_id,
        )
        result = await channel.submit(inbound)
        if result.status != "completed":
            answer = result.message or failure_message
        else:
            if rotation is not None and not sessions.commit_rotation(rotation):
                raise RuntimeError("WeCom session changed while /new was running")
            answer = result.text.strip() or result.message or "(empty response)"
        dedupe.complete(
            session_key,
            external_id,
            text=answer,
            status=result.status or "failed",
        )
        await _reply_final(wecom, frame, stream_id, answer)

    try:
        if sequencer is None:
            await submit_in_order()
        else:
            async with sequencer.lock_for(session_key):
                await submit_in_order()
    except Exception:
        if command:
            dedupe.complete(
                session_key,
                external_id,
                text=failure_message,
                status="failed",
            )
        else:
            dedupe.forget(session_key, external_id)
        logger.exception("WeCom message processing failed")
        with contextlib.suppress(Exception):
            await _reply_final(wecom, frame, stream_id, failure_message)


def register_handlers(
    client: Any,
    channel: ChannelClient,
    config: ConnectorConfig,
    dedupe: DedupeStore,
    sessions: SessionStore,
    sequencer: SessionSequencer,
) -> None:
    @client.on("message.text")
    async def on_text(frame: dict[str, Any]) -> None:
        asyncio.create_task(
            _handle_text(client, channel, dedupe, sessions, config, frame, sequencer)
        )


async def _wait_backoff(stop: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        return


async def _maintain_channel(
    channel: ChannelClient,
    ready: asyncio.Event,
    stop: asyncio.Event,
) -> None:
    backoff = 1.0
    while not stop.is_set():
        try:
            await channel.connect()
            ready.set()
            backoff = 1.0
            await channel.wait_closed()
            if not stop.is_set():
                logger.warning("ArcForge channel disconnected; reconnecting")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            ready.clear()
            logger.warning("ArcForge channel connection failed: %s", exc)
        finally:
            ready.clear()

        if stop.is_set():
            return
        await _wait_backoff(stop, backoff)
        backoff = min(backoff * 2, 30.0)


async def run(config: ConnectorConfig | None = None) -> None:
    config = config or load_config()
    channel = ChannelClient(config)
    dedupe = DedupeStore(config.dedupe_ttl_seconds)
    sessions = SessionStore()
    sequencer = SessionSequencer()
    wecom = WSClient(
        WSClientOptions(
            bot_id=config.bot_id,
            secret=config.secret,
            max_reconnect_attempts=-1,
        )
    )
    register_handlers(wecom, channel, config, dedupe, sessions, sequencer)
    stop = asyncio.Event()
    channel_ready = asyncio.Event()
    channel_task = asyncio.create_task(
        _maintain_channel(channel, channel_ready, stop),
        name="arcforge-channel-supervisor",
    )
    try:
        await channel_ready.wait()
        await wecom.connect()
        print(CONNECTOR_READY_MARKER, flush=True)
        await stop.wait()
    finally:
        stop.set()
        channel_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await channel_task
        await channel.close()
        wecom.disconnect()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        return
    except Exception as exc:
        logger.error("WeCom connector stopped: %s", exc)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
