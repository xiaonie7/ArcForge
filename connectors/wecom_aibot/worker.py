"""WeCom AiBot worker that bridges user messages to the ArcForge desktop."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import sys
import threading
from dataclasses import dataclass, field
from typing import Any

from aibot import WSClient, WSClientOptions, generate_req_id

from .channel_client import ChannelClient, make_inbound
from .commands import SessionSequencer, SessionStore, parse_command
from .config import ConnectorConfig, load_config
from .dedupe import DedupeStore

logger = logging.getLogger(__name__)

CONNECTOR_READY_MARKER = "__ARCFORGE_WECOM_CONNECTOR_READY_V1__"
CONTROL_RESULT_MARKER = "__ARCFORGE_WECOM_CONTROL_RESULT_V1__"

_CONTROL_VERSION = 1
_CONTROL_SEND_MARKDOWN = "send_markdown"
_CONTROL_QUEUE_SIZE = 32
_CONTROL_MAX_IN_FLIGHT = 16
_MAX_REQUEST_ID_BYTES = 128
_MAX_CHAT_ID_CHARACTERS = 256
_AUTHENTICATION_TIMEOUT_SECONDS = 30.0
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]+$")

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
            answer = result.text.strip()
            if not answer:
                raise RuntimeError("ArcForge channel completed without response text")
            if rotation is not None and not sessions.commit_rotation(rotation):
                raise RuntimeError("WeCom session changed while /new was running")
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


@dataclass
class _WecomConnectionState:
    authenticated: asyncio.Event = field(default_factory=asyncio.Event)
    startup_failed: asyncio.Event = field(default_factory=asyncio.Event)


class _RedactingSdkLogger:
    """SDK logger adapter that never forwards remote or message-derived text."""

    def debug(self, _message: str, *_args: object) -> None:
        logger.debug("WeCom SDK debug event")

    def info(self, _message: str, *_args: object) -> None:
        logger.info("WeCom SDK status event")

    def warn(self, _message: str, *_args: object) -> None:
        logger.warning("WeCom SDK warning")

    def error(self, _message: str, *_args: object) -> None:
        logger.error("WeCom SDK error")


def _register_connection_handlers(client: Any, state: _WecomConnectionState) -> None:
    @client.on("connected")
    def on_connected() -> None:
        # A later socket connection may recover from an earlier transport error.
        state.authenticated.clear()
        state.startup_failed.clear()

    @client.on("authenticated")
    def on_authenticated() -> None:
        state.startup_failed.clear()
        state.authenticated.set()

    @client.on("disconnected")
    def on_disconnected(_reason: Any = None) -> None:
        state.authenticated.clear()
        state.startup_failed.set()
        logger.warning("WeCom connection disconnected")

    @client.on("error")
    def on_error(_error: Any) -> None:
        # Do not log the SDK exception: it can contain remote response details.
        state.authenticated.clear()
        state.startup_failed.set()
        logger.warning("WeCom connection error")


async def _wait_for_initial_authentication(
    state: _WecomConnectionState,
    timeout: float = _AUTHENTICATION_TIMEOUT_SECONDS,
) -> None:
    authenticated = asyncio.create_task(state.authenticated.wait())
    failed = asyncio.create_task(state.startup_failed.wait())
    try:
        done, _pending = await asyncio.wait(
            (authenticated, failed),
            timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if state.authenticated.is_set():
            return
        if failed in done:
            raise RuntimeError("WeCom authentication failed")
        raise TimeoutError("WeCom authentication timed out")
    finally:
        for task in (authenticated, failed):
            if not task.done():
                task.cancel()
        await asyncio.gather(authenticated, failed, return_exceptions=True)


def _has_forbidden_control_characters(value: str, *, multiline: bool = False) -> bool:
    allowed = {"\n", "\r", "\t"} if multiline else set()
    return any(
        (ord(character) < 32 or 127 <= ord(character) <= 159)
        and character not in allowed
        for character in value
    )


def _utf8_size(value: str) -> int | None:
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError:
        return None


def _control_result(request_id: str, ok: bool, error: str) -> None:
    payload = {
        "requestId": request_id,
        "ok": ok,
        "error": error,
    }
    encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    print(f"{CONTROL_RESULT_MARKER}{encoded}", flush=True)


async def _handle_control_line(
    client: Any,
    authenticated: asyncio.Event,
    line: str,
    *,
    max_text_bytes: int,
) -> None:
    request_id = ""
    try:
        request = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        _control_result(request_id, False, "invalid_json")
        return
    if not isinstance(request, dict):
        _control_result(request_id, False, "invalid_request")
        return

    raw_request_id = request.get("requestId")
    if (
        not isinstance(raw_request_id, str)
        or not raw_request_id
        or _REQUEST_ID_PATTERN.fullmatch(raw_request_id) is None
        or len(raw_request_id.encode("utf-8")) > _MAX_REQUEST_ID_BYTES
    ):
        _control_result(request_id, False, "invalid_request_id")
        return
    request_id = raw_request_id

    if type(request.get("v")) is not int or request["v"] != _CONTROL_VERSION:
        _control_result(request_id, False, "unsupported_version")
        return
    if request.get("type") != _CONTROL_SEND_MARKDOWN:
        _control_result(request_id, False, "unsupported_type")
        return

    raw_chat_id = request.get("chatId")
    if not isinstance(raw_chat_id, str):
        _control_result(request_id, False, "invalid_chat_id")
        return
    chat_id = raw_chat_id.strip()
    chat_id_size = _utf8_size(chat_id)
    if (
        not chat_id
        or len(chat_id) > _MAX_CHAT_ID_CHARACTERS
        or chat_id_size is None
        or _has_forbidden_control_characters(chat_id)
    ):
        _control_result(request_id, False, "invalid_chat_id")
        return

    content = request.get("content")
    content_size = _utf8_size(content) if isinstance(content, str) else None
    if (
        not isinstance(content, str)
        or not content.strip()
        or content_size is None
        or content_size > max_text_bytes
        or _has_forbidden_control_characters(content, multiline=True)
    ):
        _control_result(request_id, False, "invalid_content")
        return
    if not authenticated.is_set():
        _control_result(request_id, False, "not_authenticated")
        return

    try:
        acknowledgement = await client.send_message(
            chat_id,
            {"msgtype": "markdown", "markdown": {"content": content}},
        )
        if (
            isinstance(acknowledgement, dict)
            and acknowledgement.get("errcode") not in (None, 0)
        ):
            raise RuntimeError("WeCom rejected the message")
    except asyncio.CancelledError:
        raise
    except Exception:
        # The control response is intentionally stable and redacted.
        logger.warning("WeCom proactive message failed")
        _control_result(request_id, False, "send_failed")
        return
    _control_result(request_id, True, "")


def _start_stdin_reader(
    stream: Any,
    loop: asyncio.AbstractEventLoop,
    queue: asyncio.Queue[str | None],
) -> None:
    def enqueue(value: str | None) -> bool:
        operation = queue.put(value)
        try:
            future = asyncio.run_coroutine_threadsafe(operation, loop)
        except RuntimeError:
            operation.close()
            return False
        try:
            future.result()
        except Exception:
            return False
        return True

    def read_lines() -> None:
        while True:
            try:
                raw_line = stream.readline()
            except Exception:
                raw_line = b""
            if raw_line in (b"", "", None):
                enqueue(None)
                return
            if isinstance(raw_line, bytes):
                try:
                    line = raw_line.decode("utf-8")
                except UnicodeDecodeError:
                    line = "__invalid_utf8__\n"
            elif isinstance(raw_line, str):
                line = raw_line
            else:
                line = "__invalid_control_input__\n"
            if not enqueue(line):
                return

    threading.Thread(
        target=read_lines,
        name="arcforge-wecom-control-stdin",
        daemon=True,
    ).start()


async def _serve_control_requests(
    client: Any,
    authenticated: asyncio.Event,
    *,
    max_text_bytes: int,
    stream: Any = None,
) -> None:
    queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=_CONTROL_QUEUE_SIZE)
    if stream is None:
        stream = getattr(sys.stdin, "buffer", sys.stdin)
    _start_stdin_reader(stream, asyncio.get_running_loop(), queue)
    pending: set[asyncio.Task[None]] = set()
    try:
        while True:
            line = await queue.get()
            if line is None:
                break
            completed = {task for task in pending if task.done()}
            pending.difference_update(completed)
            if completed:
                await asyncio.gather(*completed)
            if len(pending) >= _CONTROL_MAX_IN_FLIGHT:
                completed, _waiting = await asyncio.wait(
                    pending,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                pending.difference_update(completed)
                await asyncio.gather(*completed)
            pending.add(
                asyncio.create_task(
                    _handle_control_line(
                        client,
                        authenticated,
                        line,
                        max_text_bytes=max_text_bytes,
                    )
                )
            )
        if pending:
            await asyncio.gather(*pending)
    except asyncio.CancelledError:
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        raise


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
            logger=_RedactingSdkLogger(),
        )
    )
    register_handlers(wecom, channel, config, dedupe, sessions, sequencer)
    connection_state = _WecomConnectionState()
    _register_connection_handlers(wecom, connection_state)
    stop = asyncio.Event()
    channel_ready = asyncio.Event()
    control_task: asyncio.Task[None] | None = None
    channel_task = asyncio.create_task(
        _maintain_channel(channel, channel_ready, stop),
        name="arcforge-channel-supervisor",
    )
    try:
        await channel_ready.wait()
        await wecom.connect()
        await _wait_for_initial_authentication(connection_state)
        control_task = asyncio.create_task(
            _serve_control_requests(
                wecom,
                connection_state.authenticated,
                max_text_bytes=config.max_text_bytes,
            ),
            name="arcforge-wecom-control",
        )
        print(CONNECTOR_READY_MARKER, flush=True)
        await connection_state.startup_failed.wait()
        raise RuntimeError("WeCom connection lost after authentication")
    finally:
        stop.set()
        if control_task is not None:
            control_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await control_task
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
