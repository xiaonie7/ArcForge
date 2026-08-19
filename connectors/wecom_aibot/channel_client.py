"""Async protobuf client for ``/ws/v2/channel``."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
import time
import uuid
from collections.abc import Callable, Iterable, Mapping
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
    ChannelFile,
    ChannelInboundFile,
    ChannelInboundMessage,
    ChannelInputAnswer,
    ChannelInputAnswerResult,
    ChannelInputAnswerSelection,
    ChannelInputRequest,
    ChannelInputResolved,
    ChannelServerFrame,
    ClientHello,
    PongFrame,
)

logger = logging.getLogger(__name__)
_ACCEPTED_RECONNECT_TIMEOUT_SECONDS = 60.0

ChannelInputHandler = Callable[[Any], Any]


@dataclass
class ChannelResponseFile:
    file_name: str = ""
    mime_type: str = ""
    content: bytes = b""
    size_bytes: int = 0
    error_code: str = ""
    message: str = ""


@dataclass
class ChannelResponse:
    request_id: str
    external_message_id: str = ""
    run_id: str = ""
    conversation_id: str = ""
    deduped: bool = False
    canonical_started: bool = False
    text: str = ""
    status: str = ""
    error_code: str = ""
    message: str = ""
    files: list[ChannelResponseFile] = field(default_factory=list)
    failure: BaseException | None = None
    done: asyncio.Event = field(default_factory=asyncio.Event)
    input_request_handler: ChannelInputHandler | None = field(default=None, repr=False)
    input_resolved_handler: ChannelInputHandler | None = field(default=None, repr=False)


class ChannelSubmitInterrupted(ConnectionError):
    """A transport failure after a submission may have reached Gateway."""

    def __init__(self, response: ChannelResponse):
        super().__init__(
            response.message or "ArcForge channel disconnected after acceptance"
        )
        self.response = response


class ChannelClient:
    def __init__(self, config: ConnectorConfig):
        self.config = config
        self._ws: Any = None
        self._reader_task: asyncio.Task[None] | None = None
        self._write_lock = asyncio.Lock()
        self._hello = asyncio.Event()
        self._connected = asyncio.Event()
        self._connection_closed = asyncio.Event()
        self._connection_error: BaseException | None = None
        self._closed = False
        self._responses: dict[str, ChannelResponse] = {}
        self._responses_lock = asyncio.Lock()
        self._answer_waiters: dict[str, asyncio.Future[Any]] = {}
        self._answer_waiters_lock = asyncio.Lock()
        self._callback_tasks: set[asyncio.Task[None]] = set()

    async def connect(self) -> None:
        if self._ws is not None or self._reader_task is not None:
            await self.close()
        self._closed = False
        self._connection_error = None
        self._hello.clear()
        self._connected.clear()
        self._connection_closed.clear()
        try:
            self._ws = await websockets.connect(
                self.config.gateway_url,
                max_size=max(
                    self.config.max_text_bytes * 2,
                    self.config.max_file_bytes + (1 << 20),
                ),
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
                raise RuntimeError(
                    str(self._connection_error)
                ) from self._connection_error
            self._connected.set()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._mark_failed(exc)
            await self._stop_transport()
            self._closed = True
            raise

    async def close(self) -> None:
        self._closed = True
        self._connected.clear()
        await self._mark_failed(ConnectionError("ArcForge channel closed"))
        await self._stop_transport()
        self._hello.clear()

    async def wait_closed(self) -> None:
        """Wait until the current connection has failed or been closed."""

        await self._connection_closed.wait()

    async def submit(
        self,
        inbound: ChannelInboundMessage,
        *,
        timeout: float = 30 * 60,
        input_request_handler: ChannelInputHandler | None = None,
        input_resolved_handler: ChannelInputHandler | None = None,
        on_input_request: ChannelInputHandler | None = None,
        on_input_resolved: ChannelInputHandler | None = None,
    ) -> ChannelResponse:
        if input_request_handler is not None and on_input_request is not None:
            raise ValueError("input_request_handler and on_input_request are aliases")
        if input_resolved_handler is not None and on_input_resolved is not None:
            raise ValueError("input_resolved_handler and on_input_resolved are aliases")
        deadline = asyncio.get_running_loop().time() + timeout
        accepted_interruption: ChannelSubmitInterrupted | None = None
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                if accepted_interruption is not None:
                    raise accepted_interruption
                raise asyncio.TimeoutError
            if self._closed or self._ws is None or self._connection_error is not None:
                if accepted_interruption is None:
                    raise RuntimeError("ArcForge channel is not connected")
                try:
                    await asyncio.wait_for(
                        self._connected.wait(),
                        timeout=min(remaining, _ACCEPTED_RECONNECT_TIMEOUT_SECONDS),
                    )
                except asyncio.TimeoutError:
                    raise accepted_interruption
                continue

            request_id = f"channel-{uuid.uuid4().hex}"
            response = ChannelResponse(
                request_id=request_id,
                input_request_handler=input_request_handler or on_input_request,
                input_resolved_handler=input_resolved_handler or on_input_resolved,
            )
            async with self._responses_lock:
                self._responses[request_id] = response
            try:
                await self._send(
                    ChannelClientFrame(
                        request_id=request_id,
                        inbound=inbound,
                    )
                )
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                await asyncio.wait_for(response.done.wait(), timeout=remaining)
                if response.failure is None:
                    response.canonical_started = bool(
                        response.canonical_started
                        or (
                            accepted_interruption is not None
                            and accepted_interruption.response.canonical_started
                        )
                    )
                    return response
                if response.run_id and response.conversation_id:
                    response.canonical_started = not response.deduped or bool(
                        accepted_interruption
                        and accepted_interruption.response.canonical_started
                    )
                    accepted_interruption = ChannelSubmitInterrupted(response)
                    continue
                # The websocket send completed, so a disconnect before the
                # accepted frame is an ambiguous acknowledgement: Gateway may
                # already have durably claimed and dispatched this request.
                # Reconnect and query the canonical request instead of turning
                # a command such as /new into a permanent local failure. With
                # no canonical run id there is nothing useful to query on this
                # call, so release promptly and let the durable callback inbox
                # retry the external message id.
                response.canonical_started = True
                raise ChannelSubmitInterrupted(response)
            except asyncio.TimeoutError:
                if response.run_id and response.conversation_id:
                    response.canonical_started = not response.deduped or bool(
                        accepted_interruption
                        and accepted_interruption.response.canonical_started
                    )
                    accepted_interruption = ChannelSubmitInterrupted(response)
                    continue
                if accepted_interruption is not None:
                    raise accepted_interruption
                # A response timeout after websocket.send completed is the
                # same ambiguous-ack window as a reader disconnect.
                response.canonical_started = True
                raise ChannelSubmitInterrupted(response)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if accepted_interruption is not None:
                    raise accepted_interruption from exc
                raise
            finally:
                async with self._responses_lock:
                    self._responses.pop(request_id, None)

    async def answer_input(
        self,
        interaction_id: str,
        selections: Iterable[Any],
        *,
        timeout: float = 30,
    ) -> ChannelInputAnswerResult:
        if self._closed or self._ws is None or self._connection_error is not None:
            raise RuntimeError("ArcForge channel is not connected")
        normalized_interaction_id = interaction_id.strip()
        if not normalized_interaction_id:
            raise ValueError("interaction_id is required")
        normalized_selections = _normalize_input_selections(selections)
        request_id = f"channel-input-answer-{uuid.uuid4().hex}"
        waiter: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        async with self._answer_waiters_lock:
            self._answer_waiters[request_id] = waiter
        try:
            await self._send(
                ChannelClientFrame(
                    request_id=request_id,
                    input_answer=ChannelInputAnswer(
                        interaction_id=normalized_interaction_id,
                        selections=normalized_selections,
                    ),
                )
            )
            result = await asyncio.wait_for(waiter, timeout=timeout)
            if result.interaction_id.strip() != normalized_interaction_id:
                raise RuntimeError(
                    "ArcForge returned an input answer for another interaction"
                )
            return result
        finally:
            async with self._answer_waiters_lock:
                self._answer_waiters.pop(request_id, None)

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
        self._connected.clear()
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
        async with self._answer_waiters_lock:
            for waiter in self._answer_waiters.values():
                if not waiter.done():
                    disconnect = ConnectionError(message)
                    disconnect.__cause__ = self._connection_error
                    waiter.set_exception(disconnect)

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
                raise RuntimeError(
                    frame.hello.message or "ArcForge channel handshake rejected"
                )
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
        if frame.HasField("input_answer_result"):
            async with self._answer_waiters_lock:
                waiter = self._answer_waiters.get(request_id)
            if waiter is not None and not waiter.done():
                waiter.set_result(_copy_message(frame.input_answer_result))
            return
        if frame.HasField("local_error"):
            async with self._answer_waiters_lock:
                answer_waiter = self._answer_waiters.get(request_id)
            if answer_waiter is not None:
                if not answer_waiter.done():
                    answer_waiter.set_exception(
                        RuntimeError(
                            frame.local_error.message
                            or "ArcForge rejected the input answer"
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
        elif frame.HasField("file"):
            channel_file: ChannelFile = frame.file
            content = bytes(channel_file.content)
            error_code = channel_file.error_code.strip()
            if not error_code and len(content) > self.config.max_file_bytes:
                content = b""
                error_code = "file_too_large"
            elif not error_code and channel_file.size_bytes != len(content):
                content = b""
                error_code = "invalid_file_size"
            response.files.append(
                ChannelResponseFile(
                    file_name=channel_file.file_name,
                    mime_type=channel_file.mime_type,
                    content=content,
                    size_bytes=int(channel_file.size_bytes),
                    error_code=error_code,
                    message=channel_file.message,
                )
            )
        elif frame.HasField("input_request"):
            input_request: ChannelInputRequest = frame.input_request
            self._schedule_input_handler(response.input_request_handler, input_request)
        elif frame.HasField("input_resolved"):
            input_resolved: ChannelInputResolved = frame.input_resolved
            self._schedule_input_handler(
                response.input_resolved_handler, input_resolved
            )
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

    def _schedule_input_handler(
        self, handler: ChannelInputHandler | None, payload: Any
    ) -> None:
        if handler is None:
            return
        copied_payload = _copy_message(payload)

        async def invoke_handler() -> None:
            try:
                result = handler(copied_payload)
                if inspect.isawaitable(result):
                    await result
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("ArcForge channel input callback failed")

        task = asyncio.create_task(
            invoke_handler(), name="arcforge-channel-input-callback"
        )
        self._callback_tasks.add(task)
        task.add_done_callback(self._callback_tasks.discard)


def _copy_message(message: Any) -> Any:
    copied = message.__class__()
    copied.CopyFrom(message)
    return copied


def _normalize_input_selections(selections: Iterable[Any]) -> list[Any]:
    normalized: list[Any] = []
    for selection in selections:
        if isinstance(selection, ChannelInputAnswerSelection):
            question_id = selection.question_id
            option_id = selection.option_id
        elif isinstance(selection, Mapping):
            question_id = selection.get("question_id", selection.get("questionId", ""))
            option_id = selection.get("option_id", selection.get("optionId", ""))
        elif isinstance(selection, (tuple, list)) and len(selection) == 2:
            question_id, option_id = selection
        else:
            raise TypeError(
                "each input selection must contain question_id and option_id"
            )
        question_id = str(question_id).strip()
        option_id = str(option_id).strip()
        if not question_id or not option_id:
            raise ValueError("question_id and option_id are required")
        normalized.append(
            ChannelInputAnswerSelection(question_id=question_id, option_id=option_id)
        )
    if not normalized:
        raise ValueError("at least one input selection is required")
    return normalized


def make_inbound(
    *,
    external_message_id: str,
    external_user_id: str,
    chat_id: str,
    chat_type: str,
    text: str,
    command: str = "",
    channel_session_id: str = "",
    files: list[ChannelInboundFile] | tuple[ChannelInboundFile, ...] = (),
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
        files=files,
    )
