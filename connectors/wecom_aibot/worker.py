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
import re
import sys
import threading
from dataclasses import dataclass, field
from typing import Any

from aibot import WSClient, WSClientOptions, generate_req_id

from .channel_client import ChannelClient, ChannelResponseFile, make_inbound
from .commands import SessionSequencer, SessionStore, parse_command
from .config import ConnectorConfig, load_config
from .dedupe import DedupeStore
from .interactions import InteractionCoordinator
from .protocol import ChannelInboundFile

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
_MEDIA_UPLOAD_INIT = "aibot_upload_media_init"
_MEDIA_UPLOAD_CHUNK = "aibot_upload_media_chunk"
_MEDIA_UPLOAD_FINISH = "aibot_upload_media_finish"
_MEDIA_UPLOAD_CHUNK_BYTES = 512 * 1024
_MEDIA_UPLOAD_ATTEMPTS = 3
_MAX_IMAGE_BYTES = 10 * 1024 * 1024
_MAX_FILE_NAME_BYTES = 255
# The WeCom SDK documents 20,480 UTF-8 bytes as the stream reply content limit.
_WECOM_REPLY_MAX_BYTES = 20 * 1024
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


def _text(frame: dict[str, Any]) -> str:
    body = _body(frame)
    text = body.get("text")
    if isinstance(text, dict):
        return str(text.get("content") or "").strip()
    return str(body.get("content") or "").strip()


def _stream_id() -> str:
    return generate_req_id("arcforge-stream")


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


async def _reply_final(client: Any, frame: dict[str, Any], stream_id: str, text: str) -> None:
    chunks = _split_wecom_reply(text or "(empty response)")
    await client.reply_stream(frame, stream_id, chunks[0], True)
    if len(chunks) == 1:
        return

    target_id = _reply_target_id(frame)
    if not target_id:
        raise RuntimeError("WeCom reply continuation target is unavailable")
    for chunk in chunks[1:]:
        acknowledgement = await client.send_message(
            target_id,
            {"msgtype": "markdown", "markdown": {"content": chunk}},
        )
        _ensure_wecom_acknowledged(acknowledgement)


async def _submit_with_input_handlers(
    channel: Any,
    inbound: Any,
    *,
    input_request_handler: Any,
    input_resolved_handler: Any,
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
    if accepts_kwargs or "input_request_handler" in parameters:
        return await submit(
            inbound,
            input_request_handler=input_request_handler,
            input_resolved_handler=input_resolved_handler,
        )
    if "on_input_request" in parameters:
        return await submit(
            inbound,
            on_input_request=input_request_handler,
            on_input_resolved=input_resolved_handler,
        )
    return await submit(inbound)


class _MediaInputError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


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
    fallback = detected_image[0] if detected_image else (
        "image.bin" if media_kind == "image" else "attachment.bin"
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
) -> tuple[int, int]:
    delivered = 0
    failed = 0
    for file in files:
        if file.error_code or not isinstance(file.content, bytes):
            failed += 1
            continue
        try:
            media_id = await _upload_wecom_file(client, file)
            await _deliver_wecom_file(client, frame, target_id, media_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            failed += 1
            logger.warning("WeCom file delivery failed")
        else:
            delivered += 1
    return delivered, failed


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
) -> None:
    body = _body(frame)
    text = _text(frame)
    if not text and media_kind not in {"file", "image"}:
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

    if interactions is not None and not media_kind:
        interaction_reply = await interactions.handle_text(
            session_key=session_key,
            text=text,
            channel=channel,
        )
        if interaction_reply is not None:
            dedupe.complete(
                session_key,
                external_id,
                text=interaction_reply,
                status="completed",
            )
            await _reply_final(wecom, frame, _stream_id(), interaction_reply)
            return

    command = parse_command(text) if not media_kind else ""
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
        logger.warning("WeCom placeholder reply failed")

    inbound_files: list[ChannelInboundFile] = []
    if media_kind:
        try:
            inbound_files.append(
                await _download_inbound_media(wecom, frame, media_kind, config)
            )
        except _MediaInputError as exc:
            answer = str(exc)
            if exc.retryable:
                dedupe.forget(session_key, external_id)
            else:
                dedupe.complete(
                    session_key,
                    external_id,
                    text=answer,
                    status="failed",
                )
            logger.warning("WeCom inbound media was rejected")
            with contextlib.suppress(Exception):
                await _reply_final(wecom, frame, stream_id, answer)
            return

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
            files=inbound_files,
        )
        if interactions is None:
            result = await channel.submit(inbound)
        else:
            async def input_request_handler(request: object) -> None:
                await interactions.present(
                    request,
                    session_key=session_key,
                    wecom=wecom,
                    frame=frame,
                    stream_id=stream_id,
                )

            async def input_resolved_handler(resolved: object) -> None:
                await interactions.handle_resolved(resolved, wecom=wecom)

            result = await _submit_with_input_handlers(
                channel,
                inbound,
                input_request_handler=input_request_handler,
                input_resolved_handler=input_resolved_handler,
            )
        if result.status != "completed":
            answer = result.message or failure_message
        else:
            answer = result.text.strip()
            response_files = list(getattr(result, "files", ()) or ())
            file_target_id = chat_id if chat_type == "group" else (chat_id or user_id)
            delivered, failed = await _send_response_files(
                wecom,
                frame,
                file_target_id,
                response_files,
            )
            if not answer and delivered:
                answer = "文件已发送。"
            elif not answer and response_files:
                answer = "文件发送失败，请稍后重试。"
            elif not answer:
                raise RuntimeError("ArcForge channel completed without response text")
            if failed and answer != "文件发送失败，请稍后重试。":
                answer += "\n\n有文件未能发送，请稍后重试。"
            if rotation is not None and not sessions.commit_rotation(rotation):
                raise RuntimeError("WeCom session changed while /new was running")
        dedupe.complete(
            session_key,
            external_id,
            text=answer,
            status=result.status or "failed",
        )
        try:
            await _reply_final(wecom, frame, stream_id, answer)
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


async def _handle_text(
    wecom: Any,
    channel: ChannelClient,
    dedupe: DedupeStore,
    sessions: SessionStore,
    config: ConnectorConfig,
    frame: dict[str, Any],
    sequencer: SessionSequencer | None = None,
    interactions: InteractionCoordinator | None = None,
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
    )


def register_handlers(
    client: Any,
    channel: ChannelClient,
    config: ConnectorConfig,
    dedupe: DedupeStore,
    sessions: SessionStore,
    sequencer: SessionSequencer,
    interactions: InteractionCoordinator | None = None,
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
