"""WeCom AiBot worker that bridges user messages to the ArcForge desktop."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import inspect
import json
import logging
import mimetypes
import os
import re
import sys
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from aibot import WSClient, WSClientOptions, generate_req_id

from .channel_client import (
    ChannelClient,
    ChannelResponseFile,
    ChannelSubmitInterrupted,
    make_inbound,
)
from .commands import (
    SessionKey,
    SessionLeaseLost,
    SessionSequencer,
    SessionStore,
    parse_command,
)
from .config import ConnectorConfig, load_config
from .dedupe import DedupeStore
from .interactions import InteractionCoordinator
from .protocol import ChannelInboundFile
from .state_store import SQLiteStateStore

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
_WECOM_REPLY_RETRY_TIMEOUT_SECONDS = 5 * 60.0
_WECOM_REPLY_RETRY_DELAY_SECONDS = 0.25
_WECOM_RECOVERY_POLL_SECONDS = 5.0
_WECOM_DISCONNECT_TIMEOUT_SECONDS = 5.0
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]+$")
_MEDIA_UPLOAD_INIT = "aibot_upload_media_init"
_MEDIA_UPLOAD_CHUNK = "aibot_upload_media_chunk"
_MEDIA_UPLOAD_FINISH = "aibot_upload_media_finish"
_MEDIA_UPLOAD_CHUNK_BYTES = 512 * 1024
_MEDIA_UPLOAD_ATTEMPTS = 3
_MAX_IMAGE_BYTES = 10 * 1024 * 1024
_MAX_FILE_NAME_BYTES = 255
# The WeCom SDK documents 20,480 UTF-8 bytes as the stream reply content limit.
_WECOM_REPLY_MAX_BYTES = 20 * 1024
# WeCom rejects a stream that has not been updated for more than six minutes.
# Refresh at four minutes so scheduler and network jitter cannot consume the
# entire safety window.
_WECOM_STREAM_REFRESH_SECONDS = 4 * 60
# Progress-driven refreshes reuse the same stream. Coalesce bursts so the
# placeholder is rewritten at most once per interval regardless of how many
# fragments the desktop produced in between.
_WECOM_PROGRESS_MIN_INTERVAL_SECONDS = 3.0
# A progress-capable keepalive waits on its wake event and re-checks the stop
# flag at this cadence; the owner also sets wake on stop, so this only bounds
# shutdown latency if a future caller forgets to.
_WECOM_KEEPALIVE_STOP_POLL_SECONDS = 1.0
# Only the tail of each transient excerpt is shown. Keeping the visible area
# small also limits what could remain visible if the stream context expires
# before the final answer replaces the placeholder.
_WECOM_PROGRESS_THINKING_CHARS = 300
_WECOM_PROGRESS_TEXT_CHARS = 200
_WECOM_PROGRESS_MAX_TOOLS = 8
_WECOM_PROGRESS_TOOL_LABELS = {
    "Read": "读取文件",
    "Image": "查看图片",
    "Write": "写入文件",
    "Edit": "编辑文件",
    "Delete": "删除文件",
    "List": "浏览目录",
    "Glob": "查找文件",
    "Grep": "搜索内容",
    "Bash": "执行命令",
    "ManagedProcess": "管理进程",
    "ReadTerminal": "读取终端",
    "PresentFile": "准备文件",
    "TodoWrite": "整理任务清单",
    "MemoryManager": "查阅记忆",
    "WebSearch": "搜索网页",
    "WebFetch": "访问网页",
}
_WECOM_PROGRESS_STATUS_LABELS = {
    "compacting": "正在压缩上下文",
}
_WECOM_INTERACTION_DRAIN_SECONDS = 5.0
_WECOM_REPLY_CONTEXT_ERROR_CODES = frozenset({846605, 846608})
_WECOM_REPLY_CONTEXT_ERROR_PATTERN = re.compile(r"(?<!\d)(846605|846608)(?!\d)")
_WINDOWS_RESERVED_FILE_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}

_HELP_TEXT = "\n".join(
    (
        "可用命令：",
        "/new - 开启新会话",
        "/compact - 压缩当前会话上下文",
        "/help - 查看命令",
        "也可以直接发送文件或图片；Agent 生成的文件会回传到当前会话。",
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


def _dedupe_payload(body: dict[str, Any]) -> str:
    """Canonical callback body used to detect message ID reuse."""

    return json.dumps(
        body,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def _installation_id(config: ConnectorConfig) -> str:
    """Build an unambiguous installation scope across channel identities."""

    return json.dumps(
        {
            "bot_id": config.bot_id,
            "channel": "wecom",
            "connector_id": config.connector_id,
            "tenant_id": config.tenant_id,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _text(frame: dict[str, Any]) -> str:
    body = _body(frame)
    text = body.get("text")
    if isinstance(text, dict):
        return str(text.get("content") or "").strip()
    return str(body.get("content") or "").strip()


def _stream_id() -> str:
    return generate_req_id("arcforge-stream")


def _progress_field(update: Any, name: str, default: Any = "") -> Any:
    if isinstance(update, dict):
        return update.get(name, default)
    return getattr(update, name, default)


def _compact_excerpt(text: str, max_chars: int) -> str:
    """Collapse whitespace and keep only the trailing ``max_chars`` characters."""

    collapsed = " ".join(text.split())
    if len(collapsed) <= max_chars:
        return collapsed
    return "…" + collapsed[-max_chars:]


def _format_elapsed(seconds: float) -> str:
    total = max(0, int(seconds))
    if total < 60:
        return f"{total} 秒"
    minutes, remainder = divmod(total, 60)
    if remainder == 0:
        return f"{minutes} 分钟"
    return f"{minutes} 分 {remainder} 秒"


class _ProgressState:
    """Transient view of what the desktop run is doing right now.

    The state feeds only the in-place WeCom placeholder. It is never written
    to the dedupe store or included in the final reply, so nothing here
    survives once the answer replaces the stream content.
    """

    def __init__(self) -> None:
        self.started_at = time.monotonic()
        self.round = 0
        self.thinking = ""
        self.text = ""
        self.status = ""
        self.tools: list[str] = []
        self.updates = 0
        self.last_seq = 0

    def apply(self, update: Any) -> None:
        kind = str(_progress_field(update, "kind") or "").strip()
        text = str(_progress_field(update, "text") or "")
        try:
            round_number = int(_progress_field(update, "round", 0) or 0)
        except (TypeError, ValueError):
            round_number = 0
        try:
            seq = int(_progress_field(update, "seq", 0) or 0)
        except (TypeError, ValueError):
            seq = 0
        # After a reconnect the gateway replays the run's earlier events.
        # Sequence numbers only grow, so anything at or below the last seen
        # one has already been rendered.
        if seq > 0:
            if seq <= self.last_seq:
                return
            self.last_seq = seq
        if round_number > self.round:
            # A new model round starts a fresh excerpt; earlier reasoning
            # is no longer what the run is doing.
            self.round = round_number
            self.thinking = ""
            self.text = ""
        if kind == "thinking":
            self.thinking = (self.thinking + text)[-(_WECOM_PROGRESS_THINKING_CHARS * 4):]
            self.status = ""
        elif kind == "text":
            self.text = (self.text + text)[-(_WECOM_PROGRESS_TEXT_CHARS * 4):]
            self.status = ""
        elif kind == "tool_call":
            name = text.strip()
            if not name:
                return
            label = _WECOM_PROGRESS_TOOL_LABELS.get(name, f"使用 {name}")
            if not self.tools or self.tools[-1] != label:
                self.tools.append(label)
                del self.tools[:-_WECOM_PROGRESS_MAX_TOOLS]
            # Visible text emitted before a tool call was a preface, not the
            # answer; drop it so the placeholder tracks the current action.
            self.text = ""
            self.status = ""
        elif kind == "status":
            label = _WECOM_PROGRESS_STATUS_LABELS.get(text.strip(), "")
            if label == self.status:
                return
            self.status = label
        else:
            return
        self.updates += 1

    def has_content(self) -> bool:
        return self.updates > 0

    def render(self) -> str:
        elapsed = _format_elapsed(time.monotonic() - self.started_at)
        header = f"⏳ 正在处理（已用时 {elapsed}"
        if self.round > 0:
            header += f"，第 {self.round} 轮"
        header += "）"
        lines = [header]
        if self.tools:
            lines.append("🔧 " + " → ".join(self.tools))
        if self.status:
            lines.append(f"⚙️ {self.status}")
        thinking = _compact_excerpt(self.thinking, _WECOM_PROGRESS_THINKING_CHARS)
        if thinking:
            lines.append(f"💭 {thinking}")
        text = _compact_excerpt(self.text, _WECOM_PROGRESS_TEXT_CHARS)
        if text:
            lines.append(f"✍️ {text}")
        lines.append("最终回复会替换这里的过程内容。")
        return "\n".join(lines)


def _utf8_prefix_length(text: str, max_bytes: int) -> int:
    """Return the largest character prefix that fits within max_bytes."""
    used = 0
    for index, character in enumerate(text):
        character_bytes = len(character.encode("utf-8"))
        if used + character_bytes > max_bytes:
            return index
        used += character_bytes
    return len(text)


def _split_wecom_reply(text: str, max_bytes: int = _WECOM_REPLY_MAX_BYTES) -> list[str]:
    """Split a reply at UTF-8 byte boundaries, preferring Markdown line breaks."""
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    if len(text.encode("utf-8")) <= max_bytes:
        return [text]

    chunks: list[str] = []
    current: list[str] = []
    current_bytes = 0

    def flush() -> None:
        nonlocal current, current_bytes
        if current:
            chunks.append("".join(current))
            current = []
            current_bytes = 0

    for segment in text.splitlines(keepends=True):
        segment_bytes = len(segment.encode("utf-8"))
        if segment_bytes <= max_bytes:
            if current and current_bytes + segment_bytes > max_bytes:
                flush()
            current.append(segment)
            current_bytes += segment_bytes
            continue

        flush()
        remainder = segment
        while len(remainder.encode("utf-8")) > max_bytes:
            prefix_length = _utf8_prefix_length(remainder, max_bytes)
            if prefix_length <= 0:
                raise ValueError("max_bytes is too small for UTF-8 text")
            chunks.append(remainder[:prefix_length])
            remainder = remainder[prefix_length:]
        if remainder:
            current.append(remainder)
            current_bytes = len(remainder.encode("utf-8"))

    flush()
    return chunks


def _reply_target_id(frame: dict[str, Any]) -> str:
    chat_id, user_id, chat_type = _routing(_body(frame))
    return chat_id if chat_type == "group" else (chat_id or user_id)


def _wecom_error_code(value: object) -> int | None:
    """Extract a known numeric error code without exposing remote error text."""

    candidates: list[object] = []
    if isinstance(value, BaseException):
        candidates.extend(
            getattr(value, name, None) for name in ("errcode", "error_code", "code")
        )
        candidates.extend(value.args)
    else:
        for mapping in _ack_mappings(value):
            candidates.extend(
                mapping.get(name) for name in ("errcode", "error_code", "code")
            )

    found_success = False
    for candidate in candidates:
        if isinstance(candidate, bool) or candidate is None:
            continue
        error_code: int | None = None
        if isinstance(candidate, int):
            error_code = candidate
        elif isinstance(candidate, str):
            stripped = candidate.strip()
            if stripped.lstrip("-").isdigit():
                error_code = int(stripped)
            else:
                match = _WECOM_REPLY_CONTEXT_ERROR_PATTERN.search(stripped)
                if match is not None:
                    error_code = int(match.group(1))
        if error_code not in (None, 0):
            return error_code
        if error_code == 0:
            found_success = True

    if isinstance(value, BaseException):
        match = _WECOM_REPLY_CONTEXT_ERROR_PATTERN.search(str(value))
        if match is not None:
            return int(match.group(1))
    return 0 if found_success else None


def _reply_context_expired(value: object) -> bool:
    return _wecom_error_code(value) in _WECOM_REPLY_CONTEXT_ERROR_CODES


async def _send_proactive_reply_chunks(
    client: Any,
    frame: dict[str, Any],
    chunks: list[str],
    *,
    authenticated: asyncio.Event | None = None,
    deadline: float | None = None,
) -> None:
    target_id = _reply_target_id(frame)
    if not target_id:
        raise RuntimeError("WeCom proactive reply target is unavailable")
    next_chunk = 0
    while next_chunk < len(chunks):
        if authenticated is not None:
            remaining = (
                max(0.0, deadline - time.monotonic())
                if deadline is not None
                else _WECOM_REPLY_RETRY_TIMEOUT_SECONDS
            )
            if not await _wait_for_wecom_authentication(
                authenticated,
                timeout=remaining,
            ):
                raise TimeoutError(
                    "WeCom authentication did not recover before proactive reply"
                )
        try:
            acknowledgement = await client.send_message(
                target_id,
                {
                    "msgtype": "markdown",
                    "markdown": {"content": chunks[next_chunk]},
                },
            )
            _ensure_wecom_acknowledged(acknowledgement)
        except asyncio.CancelledError:
            raise
        except Exception:
            if (
                authenticated is not None
                and _wecom_transport_unavailable(client, authenticated)
                and (deadline is None or time.monotonic() < deadline)
            ):
                await asyncio.sleep(_WECOM_REPLY_RETRY_DELAY_SECONDS)
                continue
            raise
        next_chunk += 1


async def _wait_for_wecom_authentication(
    authenticated: asyncio.Event,
    *,
    timeout: float = _WECOM_REPLY_RETRY_TIMEOUT_SECONDS,
) -> bool:
    """Wait for the SDK to finish a transient reconnect before sending."""

    if authenticated.is_set():
        return True
    try:
        await asyncio.wait_for(authenticated.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        return False
    return True


def _wecom_transport_unavailable(
    client: Any, authenticated: asyncio.Event | None
) -> bool:
    if authenticated is not None and not authenticated.is_set():
        return True
    connected = getattr(client, "is_connected", None)
    if isinstance(connected, bool):
        return not connected
    return False


async def _reply_final(
    client: Any,
    frame: dict[str, Any],
    stream_id: str,
    text: str,
    *,
    authenticated: asyncio.Event | None = None,
) -> None:
    chunks = _split_wecom_reply(text or "(empty response)")
    deadline = time.monotonic() + _WECOM_REPLY_RETRY_TIMEOUT_SECONDS
    while True:
        if authenticated is not None and not await _wait_for_wecom_authentication(
            authenticated,
            timeout=max(0.0, deadline - time.monotonic()),
        ):
            raise TimeoutError(
                "WeCom authentication did not recover before final reply"
            )

        try:
            acknowledgement = await client.reply_stream(
                frame, stream_id, chunks[0], True
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if _reply_context_expired(exc):
                await _send_proactive_reply_chunks(
                    client,
                    frame,
                    chunks,
                    authenticated=authenticated,
                    deadline=deadline,
                )
                logger.info("WeCom final reply used proactive fallback")
                return
            if (
                authenticated is not None
                and _wecom_transport_unavailable(client, authenticated)
                and time.monotonic() < deadline
            ):
                await asyncio.sleep(_WECOM_REPLY_RETRY_DELAY_SECONDS)
                continue
            raise

        error_code = _wecom_error_code(acknowledgement)
        if error_code in _WECOM_REPLY_CONTEXT_ERROR_CODES:
            await _send_proactive_reply_chunks(
                client,
                frame,
                chunks,
                authenticated=authenticated,
                deadline=deadline,
            )
            logger.info("WeCom final reply used proactive fallback")
            return
        if error_code not in (None, 0):
            raise RuntimeError("WeCom rejected the final stream reply")
        if len(chunks) == 1:
            return

        await _send_proactive_reply_chunks(
            client,
            frame,
            chunks[1:],
            authenticated=authenticated,
            deadline=deadline,
        )
        return


async def _wait_for_refresh_trigger(
    stop: asyncio.Event,
    wake: asyncio.Event | None,
    timeout: float,
) -> None:
    """Return when ``stop`` or ``wake`` is set, or after ``timeout`` seconds.

    Only the current task ever awaits here: no helper tasks are spawned, so
    cancelling the keepalive can never be swallowed by a child's cancellation.
    ``stop`` is polled once per second as a safety net; callers that own a
    ``wake`` event also set it when stopping so shutdown is immediate.
    """

    if wake is None:
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=timeout)
        return
    deadline = time.monotonic() + timeout
    while not stop.is_set() and not wake.is_set():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(
                wake.wait(),
                timeout=min(remaining, _WECOM_KEEPALIVE_STOP_POLL_SECONDS),
            )


async def _maintain_reply_stream(
    client: Any,
    frame: dict[str, Any],
    stream_id: str,
    *,
    refresh_allowed: asyncio.Event,
    send_lock: asyncio.Lock,
    stop: asyncio.Event,
    interval_seconds: float = _WECOM_STREAM_REFRESH_SECONDS,
    progress: _ProgressState | None = None,
    wake: asyncio.Event | None = None,
    min_interval_seconds: float = _WECOM_PROGRESS_MIN_INTERVAL_SECONDS,
) -> None:
    """Refresh a long-running reply while leaving interactive cards untouched.

    Without ``progress`` the placeholder is only refreshed every
    ``interval_seconds`` so WeCom keeps the stream alive. With ``progress`` the
    placeholder is additionally rewritten whenever ``wake`` fires, coalesced to
    at most one send per ``min_interval_seconds``.
    """

    started_at = time.monotonic()
    last_sent_at: float | None = None
    while not stop.is_set():
        await _wait_for_refresh_trigger(stop, wake, interval_seconds)
        if stop.is_set():
            return
        if wake is not None and wake.is_set() and last_sent_at is not None:
            remaining = min_interval_seconds - (time.monotonic() - last_sent_at)
            if remaining > 0:
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(stop.wait(), timeout=remaining)
                if stop.is_set():
                    return
        if not refresh_allowed.is_set():
            if wake is not None:
                wake.clear()
            continue

        async with send_lock:
            if stop.is_set() or not refresh_allowed.is_set():
                continue
            # Clear before rendering so fragments that arrive while this send
            # is in flight trigger exactly one more refresh with newer state.
            if wake is not None:
                wake.clear()
            if progress is not None and progress.has_content():
                content = progress.render()
            else:
                elapsed_minutes = max(1, int((time.monotonic() - started_at) / 60))
                content = f"正在处理，已用时约 {elapsed_minutes} 分钟，请稍候…"
            last_sent_at = time.monotonic()
            try:
                acknowledgement = await client.reply_stream(
                    frame,
                    stream_id,
                    content,
                    False,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if _reply_context_expired(exc):
                    logger.warning("WeCom reply stream expired during keepalive")
                    return
                logger.warning("WeCom reply stream keepalive failed")
                continue

            error_code = _wecom_error_code(acknowledgement)
            if error_code in _WECOM_REPLY_CONTEXT_ERROR_CODES:
                logger.warning("WeCom reply stream expired during keepalive")
                return
            if error_code not in (None, 0):
                logger.warning("WeCom reply stream keepalive was rejected")


async def _submit_with_input_handlers(
    channel: Any,
    inbound: Any,
    *,
    input_request_handler: Any,
    input_resolved_handler: Any,
    progress_handler: Any = None,
) -> Any:
    """Call new and pre-input ChannelClient implementations without version checks."""

    submit = channel.submit
    signature_target = getattr(submit, "side_effect", None)
    if not callable(signature_target):
        signature_target = submit
    try:
        parameters = inspect.signature(signature_target).parameters
    except (TypeError, ValueError):
        parameters = {}
    accepts_kwargs = any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in parameters.values()
    )
    extra: dict[str, Any] = {}
    if progress_handler is not None and (accepts_kwargs or "progress_handler" in parameters):
        extra["progress_handler"] = progress_handler
    if accepts_kwargs or "input_request_handler" in parameters:
        return await submit(
            inbound,
            input_request_handler=input_request_handler,
            input_resolved_handler=input_resolved_handler,
            **extra,
        )
    if "on_input_request" in parameters:
        return await submit(
            inbound,
            on_input_request=input_request_handler,
            on_input_resolved=input_resolved_handler,
            **extra,
        )
    if extra:
        return await submit(inbound, **extra)
    return await submit(inbound)


class _MediaInputError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


class _DedupeLeaseLost(RuntimeError):
    pass


def _safe_file_name(value: object, fallback: str) -> str:
    raw_value = value if isinstance(value, str) else ""
    candidate = (
        raw_value.encode("utf-8", "replace")
        .decode("utf-8")
        .replace("\\", "/")
        .rsplit("/", 1)[-1]
        .strip()
    )
    candidate = "".join(
        "_"
        if (
            ord(character) < 32
            or 127 <= ord(character) <= 159
            or character in '<>:"|?*'
        )
        else character
        for character in candidate
    ).rstrip(" .")
    if candidate in {"", ".", ".."}:
        candidate = fallback
    if candidate.split(".", 1)[0].upper() in _WINDOWS_RESERVED_FILE_NAMES:
        candidate = f"_{candidate}"
    while len(candidate.encode("utf-8")) > _MAX_FILE_NAME_BYTES:
        candidate = candidate[:-1]
    return candidate or fallback


def _media_body(frame: dict[str, Any], media_kind: str) -> dict[str, Any]:
    value = _body(frame).get(media_kind)
    return value if isinstance(value, dict) else {}


def _sniff_image(content: bytes) -> tuple[str, str] | None:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image.png", "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image.jpg", "image/jpeg"
    if content.startswith((b"GIF87a", b"GIF89a")):
        return "image.gif", "image/gif"
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image.webp", "image/webp"
    if content.startswith(b"BM"):
        return "image.bmp", "image/bmp"
    return None


async def _download_inbound_media(
    wecom: Any,
    frame: dict[str, Any],
    media_kind: str,
    config: ConnectorConfig,
) -> ChannelInboundFile:
    media = _media_body(frame, media_kind)
    url = media.get("url")
    if not isinstance(url, str) or not url.strip():
        raise _MediaInputError("无法读取文件，请重新发送。")
    aes_key = media.get("aeskey") or media.get("aes_key")
    if aes_key is not None and not isinstance(aes_key, str):
        raise _MediaInputError("无法读取文件，请重新发送。")
    try:
        content, downloaded_name = await wecom.download_file(
            url.strip(),
            aes_key.strip() if isinstance(aes_key, str) else None,
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        raise _MediaInputError(
            "文件下载失败，请重新发送。",
            retryable=True,
        ) from exc
    if not isinstance(content, (bytes, bytearray, memoryview)):
        raise _MediaInputError("文件内容无效，请重新发送。")
    content = bytes(content)
    size_limit = config.max_file_bytes
    if media_kind == "image":
        size_limit = min(size_limit, _MAX_IMAGE_BYTES)
    if len(content) > size_limit:
        limit_mb = max(1, size_limit // (1024 * 1024))
        raise _MediaInputError(f"文件过大，请发送不超过 {limit_mb} MB 的文件。")

    detected_image = _sniff_image(content) if media_kind == "image" else None
    fallback = (
        detected_image[0]
        if detected_image
        else ("image.bin" if media_kind == "image" else "attachment.bin")
    )
    file_name = _safe_file_name(
        downloaded_name or media.get("filename") or media.get("file_name"),
        fallback,
    )
    guessed_mime, _encoding = mimetypes.guess_type(file_name)
    mime_type = (
        detected_image[1]
        if detected_image
        else guessed_mime or "application/octet-stream"
    )
    return ChannelInboundFile(
        file_name=file_name,
        mime_type=mime_type,
        content=content,
    )


def _ack_mappings(acknowledgement: object) -> list[dict[str, Any]]:
    if not isinstance(acknowledgement, dict):
        return []
    mappings = [acknowledgement]
    body = acknowledgement.get("body")
    if isinstance(body, dict):
        mappings.append(body)
        body_data = body.get("data")
        if isinstance(body_data, dict):
            mappings.append(body_data)
    data = acknowledgement.get("data")
    if isinstance(data, dict):
        mappings.append(data)
    return mappings


def _ensure_wecom_acknowledged(acknowledgement: object) -> None:
    mappings = _ack_mappings(acknowledgement)
    if not mappings:
        raise RuntimeError("WeCom returned an invalid acknowledgement")
    for mapping in mappings:
        error_code = mapping.get("errcode")
        if error_code not in (None, 0, "0"):
            raise RuntimeError("WeCom rejected the request")


def _ack_value(acknowledgement: object, name: str) -> str:
    _ensure_wecom_acknowledged(acknowledgement)
    for mapping in _ack_mappings(acknowledgement):
        value = mapping.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise RuntimeError("WeCom acknowledgement omitted a required value")


async def _upload_media_stage(
    client: Any,
    command: str,
    body: dict[str, Any],
    *,
    attempts: int = 1,
) -> object:
    synthetic_frame = {
        "headers": {"req_id": generate_req_id(command)},
    }
    attempt_count = max(1, attempts)
    for attempt in range(attempt_count):
        try:
            acknowledgement = await client.reply(synthetic_frame, body, command)
            _ensure_wecom_acknowledged(acknowledgement)
            return acknowledgement
        except asyncio.CancelledError:
            raise
        except Exception:
            if attempt + 1 >= attempt_count:
                raise
            await asyncio.sleep(0.5 * (2**attempt))
    raise RuntimeError("WeCom media upload failed")


async def _upload_wecom_file(client: Any, file: ChannelResponseFile) -> str:
    file_name = _safe_file_name(file.file_name, "attachment.bin")
    content = bytes(file.content)
    total_chunks = (
        len(content) + _MEDIA_UPLOAD_CHUNK_BYTES - 1
    ) // _MEDIA_UPLOAD_CHUNK_BYTES
    acknowledgement = await _upload_media_stage(
        client,
        _MEDIA_UPLOAD_INIT,
        {
            "type": "file",
            "filename": file_name,
            "total_size": len(content),
            "total_chunks": total_chunks,
            "md5": hashlib.md5(content).hexdigest(),  # noqa: S324 - protocol checksum
        },
    )
    upload_id = _ack_value(acknowledgement, "upload_id")
    # The WeCom SDK declares zero chunks for an empty file but still sends one
    # empty chunk before finish.
    for chunk_index in range(max(1, total_chunks)):
        start = chunk_index * _MEDIA_UPLOAD_CHUNK_BYTES
        chunk = content[start : start + _MEDIA_UPLOAD_CHUNK_BYTES]
        await _upload_media_stage(
            client,
            _MEDIA_UPLOAD_CHUNK,
            {
                "upload_id": upload_id,
                "chunk_index": chunk_index,
                "base64_data": base64.b64encode(chunk).decode("ascii"),
            },
            attempts=_MEDIA_UPLOAD_ATTEMPTS,
        )
    acknowledgement = await _upload_media_stage(
        client,
        _MEDIA_UPLOAD_FINISH,
        {"upload_id": upload_id},
    )
    return _ack_value(acknowledgement, "media_id")


def _safe_original_request(frame: dict[str, Any]) -> bool:
    headers = frame.get("headers")
    if not isinstance(headers, dict):
        return False
    request_id = headers.get("req_id")
    request_id_size = _utf8_size(request_id) if isinstance(request_id, str) else None
    return (
        isinstance(request_id, str)
        and bool(request_id)
        and request_id_size is not None
        and request_id_size <= _MAX_REQUEST_ID_BYTES
        and _REQUEST_ID_PATTERN.fullmatch(request_id) is not None
    )


async def _deliver_wecom_file(
    client: Any,
    frame: dict[str, Any],
    target_id: str,
    media_id: str,
) -> None:
    body = {"msgtype": "file", "file": {"media_id": media_id}}
    if target_id:
        acknowledgement = await client.send_message(target_id, body)
    elif _safe_original_request(frame):
        acknowledgement = await client.reply(frame, body)
    else:
        raise RuntimeError("WeCom callback cannot be used for a file reply")
    _ensure_wecom_acknowledged(acknowledgement)


async def _send_response_files(
    client: Any,
    frame: dict[str, Any],
    target_id: str,
    files: list[ChannelResponseFile],
    *,
    renew_claim: Callable[[], bool | Awaitable[bool]] | None = None,
) -> tuple[int, int]:
    async def still_owns_claim() -> bool:
        if renew_claim is None:
            return True
        renewed = renew_claim()
        if inspect.isawaitable(renewed):
            renewed = await renewed
        return bool(renewed)

    delivered = 0
    failed = 0
    for file in files:
        if file.error_code or not isinstance(file.content, bytes):
            failed += 1
            continue
        if not await still_owns_claim():
            raise _DedupeLeaseLost("WeCom message lease changed before file upload")
        try:
            media_id = await _upload_wecom_file(client, file)
            if not await still_owns_claim():
                raise _DedupeLeaseLost(
                    "WeCom message lease changed before file delivery"
                )
            await _deliver_wecom_file(client, frame, target_id, media_id)
        except asyncio.CancelledError:
            raise
        except _DedupeLeaseLost:
            raise
        except Exception:
            failed += 1
            logger.warning("WeCom file delivery failed")
        else:
            delivered += 1
    return delivered, failed


async def _maintain_dedupe_lease(
    dedupe: DedupeStore,
    session_key: SessionKey,
    external_message_id: str,
    *,
    interval_seconds: float,
    stop: asyncio.Event,
) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
            return
        except asyncio.TimeoutError:
            pass
        try:
            if not await dedupe.renew_async(session_key, external_message_id):
                logger.warning("WeCom message lease was lost while processing")
                return
        except Exception:
            logger.warning("WeCom message lease renewal failed")


async def _handle_message(
    wecom: Any,
    channel: ChannelClient,
    dedupe: DedupeStore,
    sessions: SessionStore,
    config: ConnectorConfig,
    frame: dict[str, Any],
    sequencer: SessionSequencer | None = None,
    interactions: InteractionCoordinator | None = None,
    *,
    media_kind: str = "",
    authenticated: asyncio.Event | None = None,
) -> None:
    body = _body(frame)
    text = _text(frame)

    async def reply_immediately(answer: str, stream_id: str = "") -> None:
        await _reply_final(
            wecom,
            frame,
            stream_id or _stream_id(),
            answer,
            authenticated=authenticated,
        )

    if not text and media_kind not in {"file", "image"}:
        return
    if len(text.encode("utf-8")) > config.max_text_bytes:
        await reply_immediately("消息过长，请分段发送。")
        return
    chat_id, user_id, chat_type = _routing(body)
    if not user_id:
        await reply_immediately("无法识别企业微信用户身份。")
        return
    if chat_type not in {"single", "group"}:
        await reply_immediately("无法识别企业微信聊天类型。")
        return
    if chat_type == "group" and not config.allow_group_messages:
        await reply_immediately("当前桌面端未开启群聊消息。")
        return
    if chat_type == "group" and not chat_id:
        await reply_immediately("无法识别企业微信群聊。")
        return
    external_id = _external_message_id(frame)
    if not external_id:
        await reply_immediately("无法识别消息编号，请稍后重试。")
        return
    session_key = sessions.key(
        chat_type=chat_type,
        chat_id=chat_id,
        external_user_id=user_id,
    )
    claimed, existing = await dedupe.claim_async(
        session_key,
        external_id,
        payload=_dedupe_payload(body),
    )
    if not claimed:
        if existing and existing.status == "payload_mismatch":
            logger.warning(
                "WeCom callback message ID was reused with a different payload"
            )
        if existing and existing.completed:
            await reply_immediately(existing.text)
        return

    if interactions is not None and not media_kind:
        interaction_reply = await interactions.handle_text(
            session_key=session_key,
            text=text,
            channel=channel,
        )
        if interaction_reply is not None:
            owns_claim = await dedupe.complete_async(
                session_key,
                external_id,
                text=interaction_reply,
                status="completed",
            )
            if owns_claim:
                await reply_immediately(interaction_reply)
            return

    command = parse_command(text) if not media_kind else ""
    stream_id = _stream_id()
    failure_message = "处理失败，请稍后重试。"

    if command == "help":
        owns_claim = await dedupe.complete_async(
            session_key,
            external_id,
            text=_HELP_TEXT,
            status="completed",
        )
        if owns_claim:
            await reply_immediately(_HELP_TEXT, stream_id)
        return

    dedupe_lease_stop = asyncio.Event()
    dedupe_lease_task: asyncio.Task[None] | None = None
    lease_renew_interval = dedupe.lease_renew_interval_seconds
    if lease_renew_interval is not None:
        dedupe_lease_task = asyncio.create_task(
            _maintain_dedupe_lease(
                dedupe,
                session_key,
                external_id,
                interval_seconds=lease_renew_interval,
                stop=dedupe_lease_stop,
            ),
            name="arcforge-wecom-dedupe-lease",
        )

    async def stop_dedupe_lease() -> None:
        dedupe_lease_stop.set()
        if dedupe_lease_task is not None:
            await dedupe_lease_task

    # Acknowledge before waiting behind a previous turn so WeCom does not time
    # out while preserving per-user delivery order into the desktop runtime.
    refresh_allowed = asyncio.Event()
    refresh_allowed.set()
    stream_stop = asyncio.Event()
    stream_send_lock = asyncio.Lock()
    stream_keepalive_task: asyncio.Task[None] | None = None
    placeholder_sent = False
    # Transient run activity only ever lands in the in-place placeholder that
    # the final reply overwrites; it is never stored or replayed.
    progress_state: _ProgressState | None = None
    progress_wake: asyncio.Event | None = None
    if getattr(config, "show_progress", True):
        progress_state = _ProgressState()
        progress_wake = asyncio.Event()

    def progress_handler(update: Any) -> None:
        if progress_state is None or progress_wake is None:
            return
        progress_state.apply(update)
        if progress_state.has_content():
            progress_wake.set()

    try:
        acknowledgement = await wecom.reply_stream(
            frame,
            stream_id,
            "正在处理，请稍候…",
            False,
        )
        error_code = _wecom_error_code(acknowledgement)
        if error_code not in (None, 0):
            raise RuntimeError("WeCom rejected the placeholder reply")
        placeholder_sent = True
    except Exception:
        logger.warning("WeCom placeholder reply failed")

    # Without a live placeholder there is nothing to rewrite, so do not ask
    # the desktop for progress at all.
    active_progress_handler = (
        progress_handler if placeholder_sent and progress_state is not None else None
    )

    if placeholder_sent:
        stream_keepalive_task = asyncio.create_task(
            _maintain_reply_stream(
                wecom,
                frame,
                stream_id,
                refresh_allowed=refresh_allowed,
                send_lock=stream_send_lock,
                stop=stream_stop,
                progress=progress_state,
                wake=progress_wake,
            ),
            name="arcforge-wecom-stream-keepalive",
        )

    async def stop_stream_keepalive() -> None:
        stream_stop.set()
        if progress_wake is not None:
            progress_wake.set()
        if stream_keepalive_task is not None:
            await stream_keepalive_task

    async def deliver_final(answer: str) -> None:
        await stop_stream_keepalive()
        if not refresh_allowed.is_set():
            try:
                await asyncio.wait_for(
                    refresh_allowed.wait(),
                    timeout=_WECOM_INTERACTION_DRAIN_SECONDS,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "WeCom input resolution update did not finish before final reply"
                )
        async with stream_send_lock:
            await _reply_final(
                wecom,
                frame,
                stream_id,
                answer,
                authenticated=authenticated,
            )

    inbound_files: list[ChannelInboundFile] = []
    if media_kind:
        try:
            inbound_files.append(
                await _download_inbound_media(wecom, frame, media_kind, config)
            )
        except asyncio.CancelledError:
            await stop_dedupe_lease()
            await stop_stream_keepalive()
            raise
        except _MediaInputError as exc:
            answer = str(exc)
            await stop_dedupe_lease()
            if exc.retryable:
                owns_claim = await dedupe.forget_async(session_key, external_id)
            else:
                owns_claim = await dedupe.complete_async(
                    session_key,
                    external_id,
                    text=answer,
                    status="failed",
                )
            logger.warning("WeCom inbound media was rejected")
            if owns_claim:
                with contextlib.suppress(Exception):
                    await deliver_final(answer)
            return
        except Exception:
            await stop_dedupe_lease()
            await dedupe.forget_async(session_key, external_id)
            await stop_stream_keepalive()
            raise

    async def submit_in_order() -> None:
        rotation = None
        rotation_matches_canonical_retry = False
        pinned_session = await dedupe.bound_session_async(session_key, external_id)
        if command == "new":
            rotation = await dedupe.load_rotation_async(session_key, external_id)
            if rotation is None:
                proposed = await sessions.reserve_rotation_async(session_key)
                rotation, created = await dedupe.save_rotation_async(
                    session_key,
                    external_id,
                    proposed,
                )
                rotation_matches_canonical_retry = not created
            else:
                rotation_matches_canonical_retry = True
            channel_session_id = rotation.candidate_session_id
        elif pinned_session is not None:
            channel_session_id = pinned_session[0]
        else:
            channel_session_id = await sessions.get_for_key_async(session_key)

        session_generation = pinned_session[1] if pinned_session is not None else (
            (rotation.expected_generation or 0) + 1
            if rotation is not None and rotation.expected_generation is not None
            else await sessions.generation_for_key_async(session_key)
        )
        channel_session_id, session_generation = await dedupe.bound_session_async(
            session_key, external_id, channel_session_id, session_generation,
        )

        inbound = make_inbound(
            external_message_id=external_id,
            external_user_id=user_id,
            chat_id=chat_id if chat_type == "group" else "",
            chat_type=chat_type,
            text="" if command else text,
            command=command,
            channel_session_id=channel_session_id,
            channel_scope_key=session_key.scope_key(),
            channel_session_generation=session_generation,
            files=inbound_files,
        )
        if interactions is None:
            if active_progress_handler is None:
                result = await channel.submit(inbound)
            else:
                result = await _submit_with_input_handlers(
                    channel,
                    inbound,
                    input_request_handler=None,
                    input_resolved_handler=None,
                    progress_handler=active_progress_handler,
                )
        else:

            async def input_request_handler(request: object) -> None:
                # The card and the keepalive share one stream. Pause before
                # taking the send lock so a refresh can never overwrite a
                # question after it has been presented.
                refresh_allowed.clear()
                presented = False
                try:
                    async with stream_send_lock:
                        presented = await interactions.present(
                            request,
                            session_key=session_key,
                            wecom=wecom,
                            frame=frame,
                            stream_id=stream_id,
                        )
                finally:
                    if not presented:
                        refresh_allowed.set()

            async def input_resolved_handler(resolved: object) -> None:
                try:
                    async with stream_send_lock:
                        await interactions.handle_resolved(resolved, wecom=wecom)
                finally:
                    # Resolution itself updates the stream. Resume the regular
                    # four-minute cadence only after that update is complete.
                    refresh_allowed.set()

            result = await _submit_with_input_handlers(
                channel,
                inbound,
                input_request_handler=input_request_handler,
                input_resolved_handler=input_resolved_handler,
                progress_handler=active_progress_handler,
            )
        if result.status != "completed":
            answer = result.message or failure_message
        else:
            answer = result.text.strip()
            response_files = list(getattr(result, "files", ()) or ())
            if not await dedupe.renew_async(session_key, external_id):
                logger.warning("WeCom message lease changed before final side effects")
                return
            file_target_id = chat_id if chat_type == "group" else (chat_id or user_id)
            delivered = 0
            failed = 0
            file_delivery_status = ""
            if response_files:
                (
                    should_send_files,
                    file_delivery_status,
                ) = await dedupe.begin_response_files_async(session_key, external_id)
                if should_send_files:
                    delivered, failed = await _send_response_files(
                        wecom,
                        frame,
                        file_target_id,
                        response_files,
                        renew_claim=lambda: dedupe.renew_async(
                            session_key, external_id
                        ),
                    )
                    file_delivery_status = "sent" if failed == 0 else "failed"
                    if not await dedupe.finish_response_files_async(
                        session_key,
                        external_id,
                        status=file_delivery_status,
                    ):
                        logger.warning(
                            "WeCom message lease changed after file delivery"
                        )
                        return
                elif file_delivery_status == "sent":
                    delivered = len(response_files)
                else:
                    failed = len(response_files)
            if not answer and delivered:
                answer = "文件已发送。"
            elif not answer and file_delivery_status == "unknown":
                answer = "文件投递结果未知，为避免重复发送未自动重试。"
            elif not answer and response_files:
                answer = "文件发送失败，请稍后重试。"
            elif not answer:
                raise RuntimeError("ArcForge channel completed without response text")
            if file_delivery_status == "unknown" and not answer.endswith(
                "为避免重复发送未自动重试。"
            ):
                answer += "\n\n有文件投递结果未知，为避免重复发送未自动重试。"
            elif failed and answer != "文件发送失败，请稍后重试。":
                answer += "\n\n有文件未能发送，请稍后重试。"
            if rotation is not None:
                if not await dedupe.renew_async(session_key, external_id):
                    logger.warning(
                        "WeCom message lease changed before session rotation"
                    )
                    return
                canonical_started_here = bool(
                    getattr(result, "canonical_started", False)
                )
                if not getattr(result, "deduped", False) or (
                    rotation_matches_canonical_retry or canonical_started_here
                ):
                    if not await sessions.commit_rotation_async(rotation):
                        raise RuntimeError(
                            "WeCom session changed while /new was running"
                        )
                else:
                    logger.warning(
                        "WeCom skipped an unverified session rotation for a canonical replay"
                    )
        await stop_dedupe_lease()
        owns_claim = await dedupe.complete_async(
            session_key,
            external_id,
            text=answer,
            status=result.status or "failed",
        )
        if not owns_claim:
            logger.warning("WeCom message lease changed before final reply")
            return
        try:
            await deliver_final(answer)
        except Exception:
            # The turn and any file deliveries have already completed. Keep the
            # dedupe entry so a callback retry only replays the final text.
            logger.warning("WeCom final reply failed")

    try:
        if sequencer is None:
            await submit_in_order()
        else:
            async with sequencer.lock_for(session_key):
                await submit_in_order()
    except ChannelSubmitInterrupted:
        await stop_dedupe_lease()
        owns_claim = await dedupe.release_async(session_key, external_id)
        logger.warning(
            "ArcForge channel disconnected after accepting the WeCom message"
        )
        if not owns_claim:
            logger.warning("WeCom message lease changed before retry release")
    except SessionLeaseLost:
        await stop_dedupe_lease()
        owns_claim = await dedupe.release_async(session_key, external_id)
        logger.warning("WeCom session lease was lost while processing")
        if not owns_claim:
            logger.warning("WeCom message lease changed before session retry release")
    except Exception:
        await stop_dedupe_lease()
        if command:
            owns_claim = await dedupe.complete_async(
                session_key,
                external_id,
                text=failure_message,
                status="failed",
            )
        else:
            owns_claim = await dedupe.forget_async(session_key, external_id)
        logger.exception("WeCom message processing failed")
        if owns_claim:
            with contextlib.suppress(Exception):
                await deliver_final(failure_message)
    finally:
        await stop_dedupe_lease()
        await stop_stream_keepalive()


async def _handle_text(
    wecom: Any,
    channel: ChannelClient,
    dedupe: DedupeStore,
    sessions: SessionStore,
    config: ConnectorConfig,
    frame: dict[str, Any],
    sequencer: SessionSequencer | None = None,
    interactions: InteractionCoordinator | None = None,
    authenticated: asyncio.Event | None = None,
) -> None:
    await _handle_message(
        wecom,
        channel,
        dedupe,
        sessions,
        config,
        frame,
        sequencer,
        interactions,
        authenticated=authenticated,
    )


async def _handle_media(
    wecom: Any,
    channel: ChannelClient,
    dedupe: DedupeStore,
    sessions: SessionStore,
    config: ConnectorConfig,
    frame: dict[str, Any],
    media_kind: str,
    sequencer: SessionSequencer | None = None,
    interactions: InteractionCoordinator | None = None,
    authenticated: asyncio.Event | None = None,
) -> None:
    await _handle_message(
        wecom,
        channel,
        dedupe,
        sessions,
        config,
        frame,
        sequencer,
        interactions,
        media_kind=media_kind,
        authenticated=authenticated,
    )


def register_handlers(
    client: Any,
    channel: ChannelClient,
    config: ConnectorConfig,
    dedupe: DedupeStore,
    sessions: SessionStore,
    sequencer: SessionSequencer,
    interactions: InteractionCoordinator | None = None,
    authenticated: asyncio.Event | None = None,
) -> None:
    interactions = interactions or InteractionCoordinator()

    @client.on("message.text")
    async def on_text(frame: dict[str, Any]) -> None:
        asyncio.create_task(
            _handle_text(
                client,
                channel,
                dedupe,
                sessions,
                config,
                frame,
                sequencer,
                interactions,
                authenticated,
            )
        )

    @client.on("message.file")
    async def on_file(frame: dict[str, Any]) -> None:
        asyncio.create_task(
            _handle_media(
                client,
                channel,
                dedupe,
                sessions,
                config,
                frame,
                "file",
                sequencer,
                interactions,
                authenticated,
            )
        )

    @client.on("message.image")
    async def on_image(frame: dict[str, Any]) -> None:
        asyncio.create_task(
            _handle_media(
                client,
                channel,
                dedupe,
                sessions,
                config,
                frame,
                "image",
                sequencer,
                interactions,
                authenticated,
            )
        )

    @client.on("event.template_card_event")
    def on_template_card_event(frame: dict[str, Any]) -> None:
        body = _body(frame)
        chat_id, user_id, chat_type = _routing(body)
        session_key = None
        if user_id and chat_type in {"single", "group"}:
            with contextlib.suppress(ValueError):
                session_key = sessions.key(
                    chat_type=chat_type,
                    chat_id=chat_id,
                    external_user_id=user_id,
                )
        asyncio.create_task(
            interactions.handle_card_event(
                frame=frame,
                session_key=session_key,
                wecom=client,
                channel=channel,
            )
        )


@dataclass
class _WecomConnectionState:
    authenticated: asyncio.Event = field(default_factory=asyncio.Event)
    startup_failed: asyncio.Event = field(default_factory=asyncio.Event)
    recovery_requested: asyncio.Event = field(default_factory=asyncio.Event)
    ever_authenticated: bool = False
    sdk_reconnecting: bool = False


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
        state.sdk_reconnecting = False
        if not state.ever_authenticated:
            state.startup_failed.clear()

    @client.on("authenticated")
    def on_authenticated() -> None:
        state.startup_failed.clear()
        state.recovery_requested.clear()
        state.ever_authenticated = True
        state.sdk_reconnecting = False
        state.authenticated.set()

    @client.on("disconnected")
    def on_disconnected(_reason: Any = None) -> None:
        state.authenticated.clear()
        state.sdk_reconnecting = True
        if not state.ever_authenticated:
            state.startup_failed.set()
        logger.warning("WeCom connection disconnected")

    @client.on("error")
    def on_error(_error: Any) -> None:
        # Do not log the SDK exception: it can contain remote response details.
        state.authenticated.clear()
        state.sdk_reconnecting = False
        if not state.ever_authenticated:
            state.startup_failed.set()
        else:
            # Connection creation errors are followed immediately by the SDK's
            # reconnecting event. Authentication and receive-loop errors are
            # not, so the recovery supervisor restarts this same client.
            state.recovery_requested.set()
        logger.warning("WeCom connection error")

    @client.on("reconnecting")
    def on_reconnecting(_attempt: Any = None) -> None:
        state.authenticated.clear()
        state.sdk_reconnecting = True
        logger.info("WeCom connection reconnecting")


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
        if isinstance(acknowledgement, dict) and acknowledgement.get("errcode") not in (
            None,
            0,
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

    def decode_line(raw_line: bytes) -> str:
        try:
            return raw_line.decode("utf-8")
        except UnicodeDecodeError:
            return "__invalid_utf8__\n"

    def read_file_descriptor(file_descriptor: int) -> None:
        pending = bytearray()
        while True:
            try:
                chunk = os.read(file_descriptor, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                if pending and not enqueue(decode_line(bytes(pending))):
                    return
                enqueue(None)
                return

            pending.extend(chunk)
            while True:
                newline = pending.find(b"\n")
                if newline < 0:
                    break
                raw_line = bytes(pending[: newline + 1])
                del pending[: newline + 1]
                if not enqueue(decode_line(raw_line)):
                    return

    def read_lines() -> None:
        try:
            file_descriptor = stream.fileno()
        except (AttributeError, OSError, ValueError):
            file_descriptor = None
        if isinstance(file_descriptor, int) and file_descriptor >= 0:
            # Read the parent-child control pipe without touching the buffered
            # sys.stdin lock. A daemon blocked in BufferedReader.readline()
            # can otherwise crash CPython during interpreter finalization.
            read_file_descriptor(file_descriptor)
            return

        while True:
            try:
                raw_line = stream.readline()
            except Exception:
                raw_line = b""
            if raw_line in (b"", "", None):
                enqueue(None)
                return
            if isinstance(raw_line, bytes):
                line = decode_line(raw_line)
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


async def _disconnect_wecom(client: Any) -> None:
    """Drain the SDK's fire-and-forget disconnect before reconnecting or exiting."""

    result = client.disconnect()
    if inspect.isawaitable(result):
        await result

    manager = getattr(client, "_ws_manager", None)
    deadline = time.monotonic() + _WECOM_DISCONNECT_TIMEOUT_SECONDS
    while manager is not None:
        receive_task = getattr(manager, "_receive_task", None)
        socket = getattr(manager, "_ws", None)
        if socket is None and (
            receive_task is None or getattr(receive_task, "done", lambda: True)()
        ):
            return
        if time.monotonic() >= deadline:
            raise TimeoutError("WeCom SDK disconnect timed out")
        await asyncio.sleep(0.05)

    # Test doubles and future SDKs may not expose the current manager fields.
    # Yield once so a synchronous disconnect can schedule its cleanup task.
    await asyncio.sleep(0)


async def _maintain_wecom_recovery(
    client: Any,
    state: _WecomConnectionState,
    stop: asyncio.Event,
) -> None:
    """Recover SDK errors that do not enter the SDK's reconnect loop."""

    backoff = 1.0
    while not stop.is_set():
        requested = False
        try:
            await asyncio.wait_for(
                state.recovery_requested.wait(),
                timeout=_WECOM_RECOVERY_POLL_SECONDS,
            )
            requested = True
        except asyncio.TimeoutError:
            connected = getattr(client, "is_connected", None)
            requested = (
                state.ever_authenticated
                and state.authenticated.is_set()
                and isinstance(connected, bool)
                and not connected
            )

        if stop.is_set():
            return
        if not requested:
            continue

        state.recovery_requested.clear()
        if state.sdk_reconnecting:
            # A connect failure emits error immediately before reconnecting;
            # leave that path to the SDK so its backoff is not reset.
            continue

        state.authenticated.clear()
        try:
            logger.warning("WeCom connection requires local recovery")
            await _disconnect_wecom(client)
            if stop.is_set():
                return
            await client.connect()
            await asyncio.wait_for(
                state.authenticated.wait(),
                timeout=_AUTHENTICATION_TIMEOUT_SECONDS,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("WeCom local recovery failed")
            if state.sdk_reconnecting:
                backoff = 1.0
                continue
            await _wait_backoff(stop, backoff)
            backoff = min(backoff * 2, 30.0)
            if not stop.is_set():
                state.recovery_requested.set()
        else:
            backoff = 1.0


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
    state_store = None
    if config.state_db_path:
        state_store = SQLiteStateStore(
            config.state_db_path,
            installation_id=_installation_id(config),
        )
    dedupe = DedupeStore(
        config.dedupe_ttl_seconds,
        state_store=state_store,
    )
    sessions = SessionStore(state_store=state_store)
    sequencer = SessionSequencer(state_store=state_store)
    if state_store is not None:
        from .lifecycle import binding_handler

        channel.binding_handler = binding_handler(state_store, sequencer)
        binding_snapshot_cache = None
        async def load_bindings(offset):
            nonlocal binding_snapshot_cache
            if offset == 0 or binding_snapshot_cache is None:
                # Freeze one ordered view for the whole paged handshake. Live
                # OFFSET pagination could skip a still-open row if another
                # lifecycle request closes an earlier row between pages.
                binding_snapshot_cache = await state_store.run_async(
                    state_store.current_bindings, 0, None,
                )
            return binding_snapshot_cache[offset:offset + 100]
        channel.binding_snapshot_loader = load_bindings
    wecom = WSClient(
        WSClientOptions(
            bot_id=config.bot_id,
            secret=config.secret,
            max_reconnect_attempts=-1,
            logger=_RedactingSdkLogger(),
        )
    )
    connection_state = _WecomConnectionState()
    _register_connection_handlers(wecom, connection_state)
    register_handlers(
        wecom,
        channel,
        config,
        dedupe,
        sessions,
        sequencer,
        authenticated=connection_state.authenticated,
    )
    stop = asyncio.Event()
    channel_ready = asyncio.Event()
    control_task: asyncio.Task[None] | None = None
    recovery_task: asyncio.Task[None] | None = None
    channel_task = asyncio.create_task(
        _maintain_channel(channel, channel_ready, stop),
        name="arcforge-channel-supervisor",
    )
    try:
        await channel_ready.wait()
        await wecom.connect()
        await _wait_for_initial_authentication(connection_state)
        recovery_task = asyncio.create_task(
            _maintain_wecom_recovery(wecom, connection_state, stop),
            name="arcforge-wecom-recovery",
        )
        control_task = asyncio.create_task(
            _serve_control_requests(
                wecom,
                connection_state.authenticated,
                max_text_bytes=config.max_text_bytes,
            ),
            name="arcforge-wecom-control",
        )
        print(CONNECTOR_READY_MARKER, flush=True)
        # The SDK owns transient WeCom reconnects. Keep this process and its
        # in-flight Gateway turns alive so their final replies can be delivered
        # after authentication recovers.
        await asyncio.Event().wait()
    finally:
        stop.set()
        if control_task is not None:
            control_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await control_task
        if recovery_task is not None:
            recovery_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await recovery_task
        channel_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await channel_task
        try:
            await channel.close()
            await _disconnect_wecom(wecom)
        finally:
            if state_store is not None:
                await state_store.close_async()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        return
    except Exception as exc:
        logger.error("WeCom connector stopped: %s", exc)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
