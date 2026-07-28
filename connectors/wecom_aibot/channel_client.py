"""Async protobuf client for ``/ws/v2/channel``."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import websockets

from .config import ConnectorConfig
from .protocol import (
    CHANNEL_ROLE,
    CHANNEL_SUBPROTOCOL,
    ChannelAccepted,
    ChannelClientFrame,
    ChannelFinal,
    ChannelInboundMessage,
    ChannelServerFrame,
    ClientHello,
    PongFrame,
)

logger = logging.getLogger(__name__)


@dataclass
class ChannelResponse:
    request_id: str
    external_message_id: str = ""
    run_id: str = ""
    conversation_id: str = ""
    deduped: bool = False
    text: str = ""
    status: str = ""
    error_code: str = ""
    message: str = ""
    failure: BaseException | None = None
    done: asyncio.Event = field(default_factory=asyncio.Event)


class ChannelClient:
    def __init__(self, config: ConnectorConfig):
        self.config = config
        self._ws: Any = None
        self._reader_task: asyncio.Task[None] | None = None
        self._write_lock = asyncio.Lock()
        self._hello = asyncio.Event()
        self._connection_closed = asyncio.Event()
        self._connection_error: BaseException | None = None
        self._closed = False
        self._responses: dict[str, ChannelResponse] = {}
        self._responses_lock = asyncio.Lock()

    async def connect(self) -> None:
        if self._ws is not None or self._reader_task is not None:
            await self.close()
        self._closed = False
        self._connection_error = None
        self._hello.clear()
        self._connection_closed.clear()
        try:
            self._ws = await websockets.connect(
                self.config.gateway_url,
                max_size=max(self.config.max_text_bytes * 2, 1 << 20),
                subprotocols=[CHANNEL_SUBPROTOCOL],
                ping_interval=20,
                ping_timeout=20,
                close_timeout=5,
            )
            self._reader_task = asyncio.create_task(
                self._read_loop(), name="arcforge-channel-reader"
            )
            request_id = f"channel-hello-{uuid.uuid4().hex}"
            hello = ClientHello(
                protocol_version=2,
                role=CHANNEL_ROLE,
                token=self.config.channel_token,
                client_name="wecom-aibot",
                client_version="1",
                channel_tenant_id=self.config.tenant_id,
                channel_bot_id=self.config.bot_id,
                connector_id=self.config.connector_id,
            )
            await self._send(ChannelClientFrame(request_id=request_id, hello=hello))
            await asyncio.wait_for(self._hello.wait(), timeout=10)
            if self._connection_error is not None:
                raise RuntimeError(str(self._connection_error)) from self._connection_error
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._mark_failed(exc)
            await self._stop_transport()
            self._closed = True
            raise

    async def close(self) -> None:
        self._closed = True
        await self._mark_failed(ConnectionError("ArcForge channel closed"))
        await self._stop_transport()
        self._hello.clear()

    async def wait_closed(self) -> None:
        """Wait until the current connection has failed or been closed."""

        await self._connection_closed.wait()

    async def submit(self, inbound: ChannelInboundMessage, *, timeout: float = 30 * 60) -> ChannelResponse:
        if self._closed or self._ws is None or self._connection_error is not None:
            raise RuntimeError("ArcForge channel is not connected")
        request_id = f"channel-{uuid.uuid4().hex}"
        response = ChannelResponse(request_id=request_id)
        async with self._responses_lock:
            self._responses[request_id] = response
        try:
            await self._send(
                ChannelClientFrame(
                    request_id=request_id,
                    inbound=inbound,
                )
            )
            await asyncio.wait_for(response.done.wait(), timeout=timeout)
            if response.failure is not None:
                raise ConnectionError(response.message or "ArcForge channel disconnected") from response.failure
            return response
        finally:
            async with self._responses_lock:
                self._responses.pop(request_id, None)

    async def _send(self, frame: ChannelClientFrame) -> None:
        data = frame.SerializeToString()
        async with self._write_lock:
            if self._ws is None:
                raise RuntimeError("ArcForge channel is not connected")
            await self._ws.send(data)

    async def _stop_transport(self) -> None:
        reader_task = self._reader_task
        self._reader_task = None
        if reader_task is not None and reader_task is not asyncio.current_task():
            reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader_task
        ws = self._ws
        self._ws = None
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

    async def _mark_failed(self, failure: BaseException) -> None:
        if self._connection_error is None:
            self._connection_error = failure
        message = str(self._connection_error) or "ArcForge channel disconnected"
        self._hello.set()
        self._connection_closed.set()
        async with self._responses_lock:
            for response in self._responses.values():
                if response.done.is_set():
                    continue
                response.failure = self._connection_error
                response.status = "failed"
                response.error_code = "channel_disconnected"
                response.message = message
                response.done.set()

    async def _read_loop(self) -> None:
        failure: BaseException | None = None
        try:
            async for raw in self._ws:
                if not isinstance(raw, (bytes, bytearray, memoryview)):
                    continue
                frame = ChannelServerFrame()
                frame.ParseFromString(bytes(raw))
                await self._handle_frame(frame)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            failure = exc
            if not self._closed:
                logger.exception("ArcForge channel reader stopped")
        else:
            if not self._closed:
                failure = ConnectionError("ArcForge channel disconnected")
        finally:
            if failure is not None:
                await self._mark_failed(failure)

    async def _handle_frame(self, frame: ChannelServerFrame) -> None:
        request_id = frame.request_id.strip()
        if frame.HasField("hello"):
            if not frame.hello.ok:
                raise RuntimeError(frame.hello.message or "ArcForge channel handshake rejected")
            self._hello.set()
            return
        if frame.HasField("ping"):
            await self._send(
                ChannelClientFrame(
                    request_id=request_id,
                    pong=PongFrame(timestamp=frame.ping.timestamp),
                )
            )
            return
        async with self._responses_lock:
            response = self._responses.get(request_id)
        if response is None:
            return
        if frame.HasField("accepted"):
            accepted: ChannelAccepted = frame.accepted
            response.external_message_id = accepted.external_message_id
            response.run_id = accepted.run_id
            response.conversation_id = accepted.conversation_id
            response.deduped = accepted.deduped
        elif frame.HasField("delta"):
            response.text += frame.delta.text
        elif frame.HasField("final"):
            final: ChannelFinal = frame.final
            response.status = final.status
            response.error_code = final.error_code
            response.message = final.message
            response.done.set()
        elif frame.HasField("local_error"):
            response.status = "failed"
            response.error_code = str(frame.local_error.code)
            response.message = frame.local_error.message
            response.done.set()


def make_inbound(
    *,
    external_message_id: str,
    external_user_id: str,
    chat_id: str,
    chat_type: str,
    text: str,
    command: str = "",
    channel_session_id: str = "",
    timestamp: int | None = None,
) -> ChannelInboundMessage:
    return ChannelInboundMessage(
        external_message_id=external_message_id.strip(),
        external_user_id=external_user_id.strip(),
        chat_id=chat_id.strip(),
        chat_type=chat_type.strip().lower(),
        text=text.strip(),
        timestamp=timestamp or int(time.time()),
        command=command.strip().lower(),
        channel_session_id=channel_session_id.strip(),
    )
