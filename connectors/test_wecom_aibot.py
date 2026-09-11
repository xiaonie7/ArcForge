import asyncio
import base64
import hashlib
import io
import json
import os
import sqlite3
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from connectors.wecom_aibot.channel_client import (
    ChannelClient,
    ChannelResponse,
    ChannelResponseFile,
    ChannelSubmitInterrupted,
    make_inbound,
)
from connectors.wecom_aibot.commands import (
    SessionLeaseLost,
    SessionSequencer,
    SessionStore,
    parse_command,
)
from connectors.wecom_aibot.config import ConnectorConfig, _channel_url, load_config
from connectors.wecom_aibot.dedupe import DedupeKey, DedupeStore
from connectors.wecom_aibot.interactions import InteractionCoordinator
from connectors.wecom_aibot.state_store import SQLiteStateStore
from connectors.wecom_aibot.protocol import (
    CHANNEL_ROLE,
    ChannelAccepted,
    ChannelClientFrame,
    ChannelDelta,
    ChannelFile,
    ChannelFinal,
    ChannelInboundFile,
    ChannelInboundMessage,
    ChannelProgress,
    ChannelServerFrame,
    ClientHello,
    ErrorResponse,
    ServerHello,
)
from connectors.wecom_aibot.worker import (
    CONNECTOR_READY_MARKER,
    CONTROL_RESULT_MARKER,
    _RedactingSdkLogger,
    _WecomConnectionState,
    _download_inbound_media,
    _dedupe_payload,
    _deliver_wecom_file,
    _external_message_id,
    _handle_media,
    _handle_text,
    _handle_control_line,
    _installation_id,
    _maintain_reply_stream,
    _ProgressState,
    _register_connection_handlers,
    _reply_final,
    _split_wecom_reply,
    _WECOM_REPLY_MAX_BYTES,
    _routing,
    _send_response_files,
    _serve_control_requests,
    _text,
    _upload_wecom_file,
    _wait_for_initial_authentication,
    register_handlers,
    run,
)


def _config(**overrides):
    values = {
        "bot_id": "bot-1",
        "secret": "secret-1",
        "gateway_url": "ws://127.0.0.1:1/ws/v2/channel",
        "channel_token": "channel-token",
        "tenant_id": "tenant-1",
        "connector_id": "wecom-desktop",
    }
    values.update(overrides)
    return ConnectorConfig(**values)


class _FrameSocket:
    def __init__(self, frames=()):
        self.frames = list(frames)
        self.sent = []
        self.closed = False

    async def send(self, data):
        self.sent.append(data)

    async def close(self):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.frames:
            return self.frames.pop(0)
        raise StopAsyncIteration


class RoutingTests(unittest.TestCase):
    def test_single_and_group_routing(self):
        self.assertEqual(
            _routing(
                {"chatid": "ignored", "from": {"userid": "alice"}, "chattype": "1"}
            ),
            ("ignored", "alice", "single"),
        )
        self.assertEqual(
            _routing({"chat_id": "room-1", "userid": "bob", "chat_type": "2"}),
            ("room-1", "bob", "group"),
        )

    def test_message_fields_are_tolerant_of_sdk_shapes(self):
        frame = {
            "headers": {"req_id": "req-1"},
            "body": {"text": {"content": " hello "}},
        }
        self.assertEqual(_external_message_id(frame), "req-1")
        self.assertEqual(_text(frame), "hello")

    def test_unknown_chat_type_fails_closed(self):
        self.assertEqual(
            _routing({"userid": "alice", "chat_type": "future-type"}),
            ("", "alice", ""),
        )
        self.assertEqual(
            _routing({"userid": "alice"}),
            ("", "alice", ""),
        )


class ReplyChunkingTests(unittest.IsolatedAsyncioTestCase):
    def test_split_is_byte_safe_and_preserves_text(self):
        text = "第一行\n" + ("中" * 5) + "🙂" + "\n第三行"
        chunks = _split_wecom_reply(text, max_bytes=8)

        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(len(chunk.encode("utf-8")) <= 8 for chunk in chunks))

    def test_exact_sdk_limit_stays_as_one_chunk(self):
        text = "a" * _WECOM_REPLY_MAX_BYTES

        self.assertEqual(_split_wecom_reply(text), [text])

    async def test_long_reply_finishes_stream_then_sends_continuation(self):
        text = "中" * 7000
        wecom = SimpleNamespace(
            reply_stream=AsyncMock(return_value={"errcode": 0}),
            send_message=AsyncMock(return_value={"errcode": 0}),
        )
        frame = {
            "body": {
                "from": {"userid": "alice"},
                "chattype": "single",
                "chatid": "",
            }
        }

        await _reply_final(wecom, frame, "stream-1", text)

        wecom.reply_stream.assert_awaited_once()
        first_chunk = wecom.reply_stream.await_args.args[2]
        self.assertLessEqual(len(first_chunk.encode("utf-8")), _WECOM_REPLY_MAX_BYTES)
        wecom.send_message.assert_awaited_once()
        target_id, body = wecom.send_message.await_args.args
        self.assertEqual(target_id, "alice")
        continuation = body["markdown"]["content"]
        self.assertEqual(first_chunk + continuation, text)
        self.assertLessEqual(len(continuation.encode("utf-8")), _WECOM_REPLY_MAX_BYTES)

    async def test_expired_stream_falls_back_to_proactive_for_every_chunk(self):
        text = "中" * 7000
        wecom = SimpleNamespace(
            reply_stream=AsyncMock(
                side_effect=RuntimeError(
                    "Reply ack error: errcode=846608, errmsg=stream expired"
                )
            ),
            send_message=AsyncMock(return_value={"errcode": 0}),
        )
        frame = {
            "body": {
                "from": {"userid": "alice"},
                "chattype": "single",
                "chatid": "",
            }
        }

        await _reply_final(wecom, frame, "stream-1", text)

        wecom.reply_stream.assert_awaited_once()
        self.assertEqual(wecom.send_message.await_count, 2)
        self.assertEqual(
            "".join(
                call.args[1]["markdown"]["content"]
                for call in wecom.send_message.await_args_list
            ),
            text,
        )
        self.assertTrue(
            all(call.args[0] == "alice" for call in wecom.send_message.await_args_list)
        )

    async def test_expired_stream_ack_uses_group_chat_for_proactive_fallback(self):
        wecom = SimpleNamespace(
            reply_stream=AsyncMock(return_value={"errcode": 846608}),
            send_message=AsyncMock(return_value={"body": {"errcode": 0}}),
        )
        frame = {
            "body": {
                "from": {"userid": "alice"},
                "chattype": "group",
                "chatid": "room-1",
            }
        }

        await _reply_final(wecom, frame, "stream-1", "done")

        wecom.send_message.assert_awaited_once_with(
            "room-1",
            {"msgtype": "markdown", "markdown": {"content": "done"}},
        )

    async def test_non_expiry_stream_failure_does_not_risk_duplicate_send(self):
        wecom = SimpleNamespace(
            reply_stream=AsyncMock(
                side_effect=RuntimeError("temporary transport error")
            ),
            send_message=AsyncMock(return_value={"errcode": 0}),
        )
        frame = {
            "body": {
                "from": {"userid": "alice"},
                "chattype": "single",
                "chatid": "",
            }
        }

        with self.assertRaisesRegex(RuntimeError, "temporary transport error"):
            await _reply_final(wecom, frame, "stream-1", "done")

        wecom.send_message.assert_not_awaited()

    async def test_transport_disconnect_retries_final_after_authentication_recovers(
        self,
    ):
        authenticated = asyncio.Event()
        authenticated.set()
        attempts = 0

        async def reply_stream(*_args):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                authenticated.clear()
                asyncio.get_running_loop().call_soon(authenticated.set)
                raise RuntimeError("WebSocket connection closed")
            return {"errcode": 0}

        wecom = SimpleNamespace(
            reply_stream=AsyncMock(side_effect=reply_stream),
            send_message=AsyncMock(return_value={"errcode": 0}),
        )
        frame = {
            "body": {
                "from": {"userid": "alice"},
                "chattype": "single",
                "chatid": "",
            }
        }

        with patch(
            "connectors.wecom_aibot.worker._WECOM_REPLY_RETRY_DELAY_SECONDS",
            0,
        ):
            await _reply_final(
                wecom,
                frame,
                "stream-1",
                "done",
                authenticated=authenticated,
            )

        self.assertEqual(wecom.reply_stream.await_count, 2)
        wecom.send_message.assert_not_awaited()

    async def test_proactive_retry_does_not_resend_acknowledged_chunks(self):
        authenticated = asyncio.Event()
        authenticated.set()
        text = "a" * (_WECOM_REPLY_MAX_BYTES + 1)
        chunks = _split_wecom_reply(text)
        attempts = 0

        async def send_message(*_args):
            nonlocal attempts
            attempts += 1
            if attempts == 2:
                authenticated.clear()
                asyncio.get_running_loop().call_soon(authenticated.set)
                raise RuntimeError("WebSocket connection closed")
            return {"errcode": 0}

        wecom = SimpleNamespace(
            reply_stream=AsyncMock(return_value={"errcode": 846608}),
            send_message=AsyncMock(side_effect=send_message),
        )
        frame = {
            "body": {
                "from": {"userid": "alice"},
                "chattype": "single",
                "chatid": "",
            }
        }

        with patch(
            "connectors.wecom_aibot.worker._WECOM_REPLY_RETRY_DELAY_SECONDS",
            0,
        ):
            await _reply_final(
                wecom,
                frame,
                "stream-1",
                text,
                authenticated=authenticated,
            )

        sent = [
            call.args[1]["markdown"]["content"]
            for call in wecom.send_message.await_args_list
        ]
        self.assertEqual(sent, [chunks[0], chunks[1], chunks[1]])


class ReplyStreamKeepaliveTests(unittest.IsolatedAsyncioTestCase):
    async def test_keepalive_waits_while_interaction_is_active_then_resumes(self):
        sent = asyncio.Event()

        async def reply_stream(*_args):
            sent.set()
            return {"errcode": 0}

        wecom = SimpleNamespace(reply_stream=AsyncMock(side_effect=reply_stream))
        refresh_allowed = asyncio.Event()
        send_lock = asyncio.Lock()
        stop = asyncio.Event()
        task = asyncio.create_task(
            _maintain_reply_stream(
                wecom,
                {},
                "stream-1",
                refresh_allowed=refresh_allowed,
                send_lock=send_lock,
                stop=stop,
                interval_seconds=0.01,
            )
        )

        await asyncio.sleep(0.03)
        wecom.reply_stream.assert_not_awaited()
        refresh_allowed.set()
        await asyncio.wait_for(sent.wait(), timeout=0.2)
        stop.set()
        await asyncio.wait_for(task, timeout=0.2)

        content = wecom.reply_stream.await_args.args[2]
        self.assertIn("正在处理", content)
        self.assertFalse(wecom.reply_stream.await_args.args[3])


class ProgressPlaceholderTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _frame(message_id, text):
        return {
            "body": {
                "msgid": message_id,
                "from": {"userid": "alice"},
                "chattype": "single",
                "chatid": "",
                "text": {"content": text},
            }
        }

    def test_state_renders_tail_excerpts_and_tool_labels_without_arguments(self):
        state = _ProgressState()
        self.assertFalse(state.has_content())
        state.apply(SimpleNamespace(kind="thinking", text="先看一下", round=1))
        state.apply({"kind": "thinking", "text": "配置文件\n再决定", "round": 1})
        state.apply(SimpleNamespace(kind="tool_call", text="Read", round=1))
        state.apply(SimpleNamespace(kind="tool_call", text="Read", round=1))
        state.apply(SimpleNamespace(kind="tool_call", text="CustomTool", round=1))
        state.apply(SimpleNamespace(kind="text", text="好的，", round=1))
        state.apply(SimpleNamespace(kind="status", text="compacting", round=1))
        state.apply(SimpleNamespace(kind="unknown", text="ignored", round=1))

        rendered = state.render()
        self.assertTrue(state.has_content())
        self.assertIn("第 1 轮", rendered)
        self.assertIn("💭 先看一下配置文件 再决定", rendered)
        self.assertIn("🔧 读取文件 → 使用 CustomTool", rendered)
        self.assertIn("✍️ 好的，", rendered)
        self.assertIn("正在压缩上下文", rendered)
        self.assertNotIn("ignored", rendered)
        self.assertIn("最终回复会替换", rendered)

    def test_long_thinking_keeps_only_the_tail_and_new_round_resets(self):
        state = _ProgressState()
        state.apply(SimpleNamespace(kind="thinking", text="a" * 1000 + "END", round=1))
        rendered = state.render()
        self.assertIn("…", rendered)
        self.assertIn("END", rendered)
        self.assertLess(len(rendered), 600)

        state.apply(SimpleNamespace(kind="tool_call", text="Grep", round=1))
        state.apply(SimpleNamespace(kind="thinking", text="第二轮", round=2))
        rendered = state.render()
        self.assertNotIn("END", rendered)
        self.assertIn("第二轮", rendered)
        self.assertIn("搜索内容", rendered)

    def test_replayed_sequence_numbers_and_unchanged_status_do_not_reapply(self):
        state = _ProgressState()
        state.apply(SimpleNamespace(kind="thinking", text="一", round=1, seq=5))
        state.apply(SimpleNamespace(kind="thinking", text="二", round=1, seq=6))
        # A gateway reconnect replays the same events; they must not duplicate.
        state.apply(SimpleNamespace(kind="thinking", text="一", round=1, seq=5))
        state.apply(SimpleNamespace(kind="thinking", text="二", round=1, seq=6))
        self.assertIn("💭 一二", state.render())
        self.assertEqual(state.updates, 2)

        state.apply(SimpleNamespace(kind="status", text="compacting", round=1, seq=7))
        state.apply(SimpleNamespace(kind="status", text="compacting", round=1, seq=8))
        state.apply(SimpleNamespace(kind="status", text="running", round=1, seq=9))
        state.apply(SimpleNamespace(kind="status", text="running", round=1, seq=10))
        self.assertEqual(state.updates, 4)
        self.assertNotIn("正在压缩上下文", state.render())
        # Updates without a sequence number (older gateways) are still applied.
        state.apply(SimpleNamespace(kind="thinking", text="三", round=1))
        self.assertEqual(state.updates, 5)

    async def test_keepalive_rewrites_placeholder_on_progress_and_coalesces(self):
        sent = []
        wecom = SimpleNamespace(
            reply_stream=AsyncMock(side_effect=lambda *args: sent.append(args) or {"errcode": 0})
        )
        refresh_allowed = asyncio.Event()
        refresh_allowed.set()
        stop = asyncio.Event()
        wake = asyncio.Event()
        state = _ProgressState()
        task = asyncio.create_task(
            _maintain_reply_stream(
                wecom,
                {},
                "stream-1",
                refresh_allowed=refresh_allowed,
                send_lock=asyncio.Lock(),
                stop=stop,
                interval_seconds=60,
                progress=state,
                wake=wake,
                min_interval_seconds=0.3,
            )
        )
        try:
            state.apply(SimpleNamespace(kind="thinking", text="第一段", round=1))
            wake.set()
            await self._eventually(lambda: len(sent) == 1)
            self.assertIn("第一段", sent[0][2])
            self.assertFalse(sent[0][3])

            # A burst inside the throttle window is coalesced into one refresh
            # that carries the newest state.
            for text in ("第二段", "第三段"):
                state.apply(SimpleNamespace(kind="thinking", text=text, round=1))
                wake.set()
            await asyncio.sleep(0.05)
            self.assertEqual(len(sent), 1)
            await self._eventually(lambda: len(sent) == 2)
            self.assertIn("第三段", sent[1][2])
            await asyncio.sleep(0.05)
            self.assertEqual(len(sent), 2)
        finally:
            stop.set()
            wake.set()
            await asyncio.wait_for(task, timeout=5)
        self.assertEqual(len(sent), 2)

    async def test_stop_alone_ends_a_progress_keepalive(self):
        wecom = SimpleNamespace(reply_stream=AsyncMock(return_value={"errcode": 0}))
        refresh_allowed = asyncio.Event()
        refresh_allowed.set()
        stop = asyncio.Event()
        task = asyncio.create_task(
            _maintain_reply_stream(
                wecom,
                {},
                "stream-1",
                refresh_allowed=refresh_allowed,
                send_lock=asyncio.Lock(),
                stop=stop,
                interval_seconds=60,
                progress=_ProgressState(),
                wake=asyncio.Event(),
            )
        )
        await asyncio.sleep(0.05)
        stop.set()
        await asyncio.wait_for(task, timeout=5)
        wecom.reply_stream.assert_not_awaited()

    async def test_progress_never_overwrites_an_active_interaction_card(self):
        wecom = SimpleNamespace(reply_stream=AsyncMock(return_value={"errcode": 0}))
        refresh_allowed = asyncio.Event()
        stop = asyncio.Event()
        wake = asyncio.Event()
        state = _ProgressState()
        task = asyncio.create_task(
            _maintain_reply_stream(
                wecom,
                {},
                "stream-1",
                refresh_allowed=refresh_allowed,
                send_lock=asyncio.Lock(),
                stop=stop,
                interval_seconds=60,
                progress=state,
                wake=wake,
                min_interval_seconds=0,
            )
        )
        try:
            state.apply(SimpleNamespace(kind="thinking", text="思考", round=1))
            wake.set()
            await asyncio.sleep(0.05)
            wecom.reply_stream.assert_not_awaited()
            refresh_allowed.set()
            wake.set()
            await self._eventually(lambda: wecom.reply_stream.await_count == 1)
        finally:
            stop.set()
            wake.set()
            await asyncio.wait_for(task, timeout=5)
        wecom.reply_stream.assert_awaited_once()

    @staticmethod
    async def _eventually(predicate, timeout=3.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                raise AssertionError("condition was not met in time")
            await asyncio.sleep(0.01)

    async def test_handle_text_shows_progress_then_final_reply_replaces_it(self):
        sessions = SessionStore(id_factory=lambda: "session-1")
        dedupe = DedupeStore()
        wecom = SimpleNamespace(reply_stream=AsyncMock(return_value={"errcode": 0}))

        async def submit(_inbound, *, progress_handler=None, **_kwargs):
            self.assertIsNotNone(progress_handler)
            progress_handler(SimpleNamespace(kind="thinking", text="先分析需求", round=1))
            progress_handler(SimpleNamespace(kind="tool_call", text="Read", round=1))
            await asyncio.sleep(0.05)
            return SimpleNamespace(status="completed", text="最终答案", message="")

        channel = SimpleNamespace(submit=AsyncMock(side_effect=submit))
        await _handle_text(
            wecom,
            channel,
            dedupe,
            sessions,
            _config(),
            self._frame("message-1", "帮我看看"),
        )

        replies = [call.args[2:4] for call in wecom.reply_stream.await_args_list]
        self.assertEqual(replies[0], ("正在处理，请稍候…", False))
        progress_replies = [content for content, finish in replies if not finish and "先分析需求" in content]
        self.assertTrue(progress_replies, replies)
        self.assertIn("读取文件", progress_replies[-1])
        self.assertEqual(replies[-1], ("最终答案", True))
        self.assertNotIn("先分析需求", replies[-1][0])

    async def test_progress_can_be_disabled_by_configuration(self):
        sessions = SessionStore(id_factory=lambda: "session-1")
        dedupe = DedupeStore()
        wecom = SimpleNamespace(reply_stream=AsyncMock(return_value={"errcode": 0}))
        seen = {}

        async def submit(_inbound, *, progress_handler=None, **_kwargs):
            seen["progress_handler"] = progress_handler
            return SimpleNamespace(status="completed", text="答案", message="")

        channel = SimpleNamespace(submit=AsyncMock(side_effect=submit))
        await _handle_text(
            wecom,
            channel,
            dedupe,
            sessions,
            _config(show_progress=False),
            self._frame("message-1", "帮我看看"),
        )
        self.assertIsNone(seen["progress_handler"])
        replies = [call.args[2:4] for call in wecom.reply_stream.await_args_list]
        self.assertEqual(replies, [("正在处理，请稍候…", False), ("答案", True)])

    async def test_legacy_submit_signature_never_receives_progress_handler(self):
        sessions = SessionStore(id_factory=lambda: "session-1")
        dedupe = DedupeStore()
        wecom = SimpleNamespace(reply_stream=AsyncMock(return_value={"errcode": 0}))

        async def submit(_inbound):
            return SimpleNamespace(status="completed", text="答案", message="")

        channel = SimpleNamespace(submit=AsyncMock(side_effect=submit))
        await _handle_text(
            wecom,
            channel,
            dedupe,
            sessions,
            _config(),
            self._frame("message-1", "帮我看看"),
        )
        self.assertEqual(channel.submit.await_args.kwargs, {})
        self.assertEqual(wecom.reply_stream.await_args.args[2:4], ("答案", True))


class CommandTests(unittest.TestCase):
    def test_allowlisted_commands_are_exact_matches(self):
        aliases = {
            "/new": "new",
            "/newchat": "new",
            "/新会话": "new",
            "/compact": "compact",
            "/压缩": "compact",
            "/压缩上下文": "compact",
            "/help": "help",
            "/帮助": "help",
        }
        for text, command in aliases.items():
            with self.subTest(text=text):
                self.assertEqual(parse_command(f" \t{text}\n"), command)

    def test_other_slash_text_is_not_a_command(self):
        for text in ("/new now", "/NEW", "//new", "/compact please", "/unknown"):
            with self.subTest(text=text):
                self.assertEqual(parse_command(text), "")


class SessionStoreTests(unittest.TestCase):
    def test_sessions_are_stable_and_isolated_by_user_and_chat(self):
        store = SessionStore()
        alice_direct = store.get(
            chat_type="single", chat_id="ignored", external_user_id="alice"
        )
        self.assertEqual(
            store.get(chat_type="single", chat_id="other", external_user_id="alice"),
            alice_direct,
        )
        self.assertNotEqual(
            store.get(chat_type="single", chat_id="", external_user_id="bob"),
            alice_direct,
        )
        alice_room = store.get(
            chat_type="group", chat_id="room-1", external_user_id="alice"
        )
        self.assertNotEqual(alice_room, alice_direct)
        self.assertNotEqual(
            store.get(chat_type="group", chat_id="room-2", external_user_id="alice"),
            alice_room,
        )

    def test_rotate_is_stable_until_the_next_rotation(self):
        ids = iter(("session-1", "session-2"))
        store = SessionStore(id_factory=lambda: next(ids))
        original = store.get(chat_type="single", chat_id="", external_user_id="alice")
        rotated = store.rotate(chat_type="single", chat_id="", external_user_id="alice")
        self.assertEqual(original, "session-1")
        self.assertEqual(rotated, "session-2")
        self.assertEqual(
            store.get(chat_type="single", chat_id="", external_user_id="alice"),
            rotated,
        )

    def test_concurrent_creation_returns_one_session(self):
        store = SessionStore()

        def get_session(_index):
            return store.get(
                chat_type="group", chat_id="room-1", external_user_id="alice"
            )

        with ThreadPoolExecutor(max_workers=16) as executor:
            sessions = list(executor.map(get_session, range(200)))
        self.assertEqual(len(set(sessions)), 1)


class DedupeTests(unittest.TestCase):
    def test_claim_complete_and_expiry(self):
        store = DedupeStore(ttl_seconds=1)
        session_key = SessionStore.key(
            chat_type="single", chat_id="", external_user_id="alice"
        )
        dedupe_key = DedupeKey.from_session(session_key, "message-1")
        claimed, existing = store.claim(session_key, "message-1")
        self.assertTrue(claimed)
        self.assertIsNone(existing)
        claimed, existing = store.claim(session_key, "message-1")
        self.assertFalse(claimed)
        self.assertFalse(existing.completed)
        self.assertTrue(
            store.complete(
                session_key,
                "message-1",
                text="answer",
                status="completed",
            )
        )
        claimed, existing = store.claim(session_key, "message-1")
        self.assertFalse(claimed)
        self.assertEqual(existing.text, "answer")
        store._items[dedupe_key.external_message_id] = (
            time.monotonic() - 1,
            dedupe_key,
            existing,
        )
        claimed, existing = store.claim(session_key, "message-1")
        self.assertTrue(claimed)
        self.assertIsNone(existing)

    def test_same_message_id_cannot_be_reclaimed_under_another_identity(self):
        store = DedupeStore()
        alice = SessionStore.key(
            chat_type="single", chat_id="", external_user_id="alice"
        )
        bob = SessionStore.key(chat_type="single", chat_id="", external_user_id="bob")
        alice_group = SessionStore.key(
            chat_type="group", chat_id="room-1", external_user_id="alice"
        )

        self.assertTrue(store.claim(alice, "message-1")[0])
        self.assertEqual(store.claim(bob, "message-1")[1].status, "identity_mismatch")
        self.assertEqual(
            store.claim(alice_group, "message-1")[1].status,
            "identity_mismatch",
        )
        self.assertFalse(store.claim(alice, "message-1")[0])


class PersistentStateStoreTests(unittest.TestCase):
    @staticmethod
    def _binding_request(
        key,
        *,
        operation_id,
        action,
        session_id,
        generation,
        installation_id="installation",
    ):
        return SimpleNamespace(
            operation_id=operation_id,
            action=action,
            installation_id=installation_id,
            scope_key=key.scope_key(),
            expected_session_id=session_id,
            expected_generation=generation,
        )

    def test_binding_close_is_idempotent_and_next_message_opens_one_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = SQLiteStateStore(
                os.path.join(directory, "wecom-state.sqlite3"),
                installation_id="installation",
            )
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            self.assertEqual(backend.get_session(key, lambda: "session-1"), "session-1")
            self.assertEqual(backend.session_generation(key), 1)

            query = self._binding_request(
                key,
                operation_id="query-1",
                action="query",
                session_id="session-1",
                generation=1,
            )
            self.assertEqual(backend.binding_operation(query)["status"], "current")

            close = self._binding_request(
                key,
                operation_id="close-1",
                action="close",
                session_id="session-1",
                generation=1,
            )
            first = backend.binding_operation(close)
            self.assertEqual((first["status"], first["generation"]), ("closed", 1))
            self.assertEqual(backend.binding_operation(close), first)
            self.assertEqual(backend.current_bindings(), [])

            with self.assertRaises(ValueError):
                backend.binding_operation(
                    self._binding_request(
                        key,
                        operation_id="close-1",
                        action="query",
                        session_id="session-1",
                        generation=1,
                    )
                )

            self.assertEqual(backend.get_session(key, lambda: "session-2"), "session-2")
            self.assertEqual(backend.session_generation(key), 2)
            stale = backend.binding_operation(
                self._binding_request(
                    key,
                    operation_id="query-2",
                    action="query",
                    session_id="session-1",
                    generation=1,
                )
            )
            self.assertEqual((stale["status"], stale["session_id"]), ("not_current", "session-2"))
            backend.close()

    def test_binding_old_generation_is_not_current_when_session_id_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = SQLiteStateStore(
                os.path.join(directory, "wecom-state.sqlite3"),
                installation_id="installation",
            )
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            self.assertEqual(backend.get_session(key, lambda: "reused-session"), "reused-session")
            with backend._lock, backend._db:
                backend._db.execute(
                    "UPDATE channel_sessions SET generation=2,closed_at_ms=NULL "
                    "WHERE installation_id=? AND session_id=?",
                    ("installation", "reused-session"),
                )

            stale = backend.binding_operation(
                self._binding_request(
                    key,
                    operation_id="query-reused-session-generation-1",
                    action="query",
                    session_id="reused-session",
                    generation=1,
                )
            )
            self.assertEqual(
                (stale["status"], stale["session_id"], stale["generation"]),
                ("not_current", "reused-session", 2),
            )
            backend.close()

    def test_inbox_binding_stays_on_closed_session_during_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = SQLiteStateStore(
                os.path.join(directory, "wecom-state.sqlite3"),
                installation_id="installation",
            )
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            session_id = backend.get_session(key, lambda: "session-1")
            claimed, _, claim_token = backend.claim_inbox(
                key, "message-1", ttl_seconds=60, max_entries=100
            )
            self.assertTrue(claimed)
            self.assertIsNotNone(claim_token)
            self.assertEqual(
                backend.inbox_session(
                    key,
                    "message-1",
                    claim_token=claim_token,
                    session_id=session_id,
                    generation=1,
                ),
                ("session-1", 1),
            )
            backend.binding_operation(
                self._binding_request(
                    key,
                    operation_id="close-1",
                    action="close",
                    session_id="session-1",
                    generation=1,
                )
            )
            self.assertEqual(backend.get_session(key, lambda: "session-2"), "session-2")
            self.assertEqual(
                backend.inbox_session(
                    key, "message-1", claim_token=claim_token
                ),
                ("session-1", 1),
            )
            backend.close()

    def test_schema_uses_wal_and_does_not_key_inbox_by_session(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            backend = SQLiteStateStore(path, installation_id="installation")
            columns = backend._db.execute("PRAGMA table_info(channel_inbox)").fetchall()
            names = {str(column[1]) for column in columns}
            primary_key = [
                str(column[1])
                for column in sorted(columns, key=lambda column: int(column[5]))
                if int(column[5]) > 0
            ]
            self.assertNotIn("channel_session_id", names)
            self.assertEqual(
                primary_key,
                ["installation_id", "external_message_id"],
            )
            self.assertEqual(
                backend._db.execute("PRAGMA journal_mode").fetchone()[0],
                "wal",
            )
            self.assertEqual(
                backend._db.execute("PRAGMA synchronous").fetchone()[0],
                2,
            )
            backend.close()

    def test_legacy_identity_scoped_inbox_is_migrated_to_message_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            connection = sqlite3.connect(path)
            connection.execute(
                """CREATE TABLE channel_inbox (
                    installation_id TEXT NOT NULL,
                    chat_type TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    external_user_id TEXT NOT NULL,
                    external_message_id TEXT NOT NULL,
                    payload_hash TEXT NOT NULL DEFAULT '',
                    state TEXT NOT NULL,
                    claim_token TEXT,
                    lease_until_ms INTEGER,
                    attempt_count INTEGER NOT NULL DEFAULT 1,
                    response_text TEXT NOT NULL DEFAULT '',
                    response_status TEXT NOT NULL DEFAULT '',
                    received_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    expires_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (
                        installation_id, chat_type, chat_id,
                        external_user_id, external_message_id
                    )
                )"""
            )
            rows = [
                (
                    "installation",
                    "single",
                    "direct",
                    "alice",
                    "message-1",
                    "hash",
                    "processing",
                    "claim",
                    1,
                    1,
                    "",
                    "",
                    1,
                    1,
                    1000,
                ),
                (
                    "installation",
                    "single",
                    "direct",
                    "bob",
                    "message-1",
                    "hash",
                    "completed",
                    None,
                    None,
                    2,
                    "canonical",
                    "completed",
                    1,
                    2,
                    1000,
                ),
            ]
            connection.executemany(
                "INSERT INTO channel_inbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                rows,
            )
            connection.commit()
            connection.close()

            backend = SQLiteStateStore(path, installation_id="installation")
            columns = backend._db.execute("PRAGMA table_info(channel_inbox)").fetchall()
            primary_key = [
                str(column[1])
                for column in sorted(columns, key=lambda column: int(column[5]))
                if int(column[5]) > 0
            ]
            self.assertEqual(primary_key, ["installation_id", "external_message_id"])
            migrated = backend._db.execute(
                "SELECT external_user_id,state,response_text FROM channel_inbox"
            ).fetchall()
            self.assertEqual(
                [tuple(row) for row in migrated],
                [("bob", "completed", "canonical")],
            )
            backend.close()

    def test_durable_message_id_reuse_under_another_identity_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            backend = SQLiteStateStore(path, installation_id="installation")
            dedupe = DedupeStore(ttl_seconds=60, state_store=backend)
            alice = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            bob = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="bob"
            )
            self.assertTrue(dedupe.claim(alice, "message-1", payload="same")[0])
            claimed, result = dedupe.claim(bob, "message-1", payload="same")
            self.assertFalse(claimed)
            self.assertEqual(result.status, "identity_mismatch")
            backend.close()

    def test_sessions_and_completed_inbox_survive_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            backend = SQLiteStateStore(path, installation_id="tenant:bot:connector")
            sessions = SessionStore(id_factory=lambda: "session-1", state_store=backend)
            key = sessions.key(chat_type="single", chat_id="", external_user_id="alice")
            self.assertEqual(sessions.get_for_key(key), "session-1")
            dedupe = DedupeStore(ttl_seconds=60, state_store=backend)
            self.assertTrue(dedupe.claim(key, "message-1")[0])
            dedupe.complete(
                key, "message-1", text="persisted answer", status="completed"
            )
            backend.close()

            reopened = SQLiteStateStore(path, installation_id="tenant:bot:connector")
            restarted_sessions = SessionStore(
                id_factory=lambda: "unexpected", state_store=reopened
            )
            restarted_dedupe = DedupeStore(ttl_seconds=60, state_store=reopened)
            self.assertEqual(restarted_sessions.get_for_key(key), "session-1")
            claimed, result = restarted_dedupe.claim(key, "message-1")
            self.assertFalse(claimed)
            self.assertTrue(result.completed)
            self.assertEqual(result.text, "persisted answer")
            reopened.close()

    def test_only_one_store_claims_a_message_concurrently(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            stores = [
                SQLiteStateStore(path, installation_id="installation") for _ in range(8)
            ]
            key = SessionStore.key(
                chat_type="group", chat_id="room-1", external_user_id="alice"
            )

            def claim(index):
                return DedupeStore(ttl_seconds=60, state_store=stores[index]).claim(
                    key, "message-1"
                )[0]

            with ThreadPoolExecutor(max_workers=len(stores)) as executor:
                claims = list(executor.map(claim, range(len(stores))))
            self.assertEqual(claims.count(True), 1)
            for store in stores:
                store.close()

    def test_expired_processing_lease_can_be_reclaimed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            backend = SQLiteStateStore(
                path, installation_id="installation", lease_seconds=60
            )
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            dedupe = DedupeStore(ttl_seconds=60, state_store=backend)
            self.assertTrue(dedupe.claim(key, "message-1")[0])
            self.assertFalse(dedupe.claim(key, "message-1")[0])
            connection = sqlite3.connect(path)
            try:
                connection.execute(
                    "UPDATE channel_inbox SET lease_until_ms=0 "
                    "WHERE external_message_id='message-1'"
                )
                connection.commit()
            finally:
                connection.close()
            self.assertTrue(dedupe.claim(key, "message-1")[0])
            backend.close()

    def test_short_ttl_cleanup_preserves_an_active_processing_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            first_backend = SQLiteStateStore(
                path, installation_id="installation", lease_seconds=120
            )
            second_backend = SQLiteStateStore(
                path, installation_id="installation", lease_seconds=120
            )
            first = DedupeStore(ttl_seconds=1, state_store=first_backend)
            second = DedupeStore(ttl_seconds=1, state_store=second_backend)
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            self.assertTrue(first.claim(key, "message-1")[0])
            connection = sqlite3.connect(path)
            try:
                connection.execute(
                    "UPDATE channel_inbox SET expires_at_ms=0 "
                    "WHERE external_message_id='message-1'"
                )
                connection.commit()
            finally:
                connection.close()
            self.assertFalse(second.claim(key, "message-1")[0])
            first_backend.close()
            second_backend.close()

    def test_claim_owner_can_renew_before_lease_takeover(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            first_backend = SQLiteStateStore(
                path, installation_id="installation", lease_seconds=1
            )
            second_backend = SQLiteStateStore(
                path, installation_id="installation", lease_seconds=1
            )
            first = DedupeStore(ttl_seconds=1, state_store=first_backend)
            second = DedupeStore(ttl_seconds=1, state_store=second_backend)
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            self.assertTrue(first.claim(key, "message-1")[0])
            connection = sqlite3.connect(path)
            try:
                connection.execute(
                    "UPDATE channel_inbox SET lease_until_ms=0 "
                    "WHERE external_message_id='message-1'"
                )
                connection.commit()
            finally:
                connection.close()
            self.assertTrue(first.renew(key, "message-1"))
            self.assertFalse(second.claim(key, "message-1")[0])
            first_backend.close()
            second_backend.close()

    def test_only_one_store_reclaims_an_expired_processing_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            stores = [
                SQLiteStateStore(path, installation_id="installation") for _ in range(8)
            ]
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            first = DedupeStore(ttl_seconds=60, state_store=stores[0])
            self.assertTrue(first.claim(key, "message-1")[0])
            connection = sqlite3.connect(path)
            try:
                connection.execute(
                    "UPDATE channel_inbox SET lease_until_ms=0 "
                    "WHERE external_message_id='message-1'"
                )
                connection.commit()
            finally:
                connection.close()

            def reclaim(index):
                return DedupeStore(ttl_seconds=60, state_store=stores[index]).claim(
                    key, "message-1"
                )[0]

            with ThreadPoolExecutor(max_workers=len(stores)) as executor:
                claims = list(executor.map(reclaim, range(len(stores))))
            self.assertEqual(claims.count(True), 1)
            for store in stores:
                store.close()

    def test_expired_inbox_entry_can_be_claimed_as_new(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            backend = SQLiteStateStore(path, installation_id="installation")
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            dedupe = DedupeStore(ttl_seconds=60, state_store=backend)
            self.assertTrue(dedupe.claim(key, "message-1")[0])
            dedupe.complete(key, "message-1", text="old", status="completed")
            connection = sqlite3.connect(path)
            try:
                connection.execute(
                    "UPDATE channel_inbox SET expires_at_ms=0 "
                    "WHERE external_message_id='message-1'"
                )
                connection.commit()
            finally:
                connection.close()
            claimed, result = dedupe.claim(key, "message-1")
            self.assertTrue(claimed)
            self.assertIsNone(result)
            backend.close()

    def test_session_rotation_uses_cross_process_cas(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            first_backend = SQLiteStateStore(path, installation_id="installation")
            second_backend = SQLiteStateStore(path, installation_id="installation")
            ids = iter(("session-1", "candidate-1"))
            first = SessionStore(
                id_factory=lambda: next(ids), state_store=first_backend
            )
            second = SessionStore(
                id_factory=lambda: "candidate-2", state_store=second_backend
            )
            key = first.key(chat_type="single", chat_id="", external_user_id="alice")
            self.assertEqual(first.get_for_key(key), "session-1")
            first_rotation = first.reserve_rotation(key)
            second_rotation = second.reserve_rotation(key)
            self.assertTrue(second.commit_rotation(second_rotation))
            self.assertFalse(first.commit_rotation(first_rotation))
            self.assertEqual(first.get_for_key(key), "candidate-2")
            first_backend.close()
            second_backend.close()

    def test_session_rotation_commit_is_idempotent_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = SQLiteStateStore(
                os.path.join(directory, "wecom-state.sqlite3"),
                installation_id="installation",
            )
            ids = iter(("session-1", "candidate-1"))
            sessions = SessionStore(
                id_factory=lambda: next(ids),
                state_store=backend,
            )
            key = sessions.key(chat_type="single", chat_id="", external_user_id="alice")
            rotation = sessions.reserve_rotation(key)
            self.assertTrue(sessions.commit_rotation(rotation))
            self.assertTrue(sessions.commit_rotation(rotation))
            backend.close()

    def test_session_rotation_generation_prevents_aba_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            first_backend = SQLiteStateStore(path, installation_id="installation")
            second_backend = SQLiteStateStore(path, installation_id="installation")
            first_ids = iter(("session-a", "candidate-stale"))
            second_ids = iter(("session-b", "session-a"))
            first = SessionStore(
                id_factory=lambda: next(first_ids), state_store=first_backend
            )
            second = SessionStore(
                id_factory=lambda: next(second_ids), state_store=second_backend
            )
            key = first.key(chat_type="single", chat_id="", external_user_id="alice")
            self.assertEqual(first.get_for_key(key), "session-a")
            stale_rotation = first.reserve_rotation(key)

            first_change = second.reserve_rotation(key)
            self.assertTrue(second.commit_rotation(first_change))
            second_change = second.reserve_rotation(key)
            self.assertTrue(second.commit_rotation(second_change))
            self.assertEqual(first.get_for_key(key), "session-a")

            self.assertFalse(first.commit_rotation(stale_rotation))
            self.assertEqual(first.get_for_key(key), "session-a")
            first_backend.close()
            second_backend.close()

    def test_expired_claim_owner_cannot_overwrite_new_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            first_backend = SQLiteStateStore(path, installation_id="installation")
            second_backend = SQLiteStateStore(path, installation_id="installation")
            first = DedupeStore(ttl_seconds=60, state_store=first_backend)
            second = DedupeStore(ttl_seconds=60, state_store=second_backend)
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            self.assertTrue(first.claim(key, "message-1")[0])
            connection = sqlite3.connect(path)
            try:
                connection.execute(
                    "UPDATE channel_inbox SET lease_until_ms=0 "
                    "WHERE external_message_id='message-1'"
                )
                connection.commit()
            finally:
                connection.close()
            self.assertTrue(second.claim(key, "message-1")[0])
            self.assertFalse(
                first.complete(key, "message-1", text="stale", status="completed")
            )
            self.assertTrue(
                second.complete(key, "message-1", text="current", status="completed")
            )

            claimed, result = first.claim(key, "message-1")
            self.assertFalse(claimed)
            self.assertEqual(result.text, "current")
            first_backend.close()
            second_backend.close()

    def test_interrupted_file_delivery_becomes_unknown_instead_of_resending(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            first_backend = SQLiteStateStore(path, installation_id="installation")
            second_backend = SQLiteStateStore(path, installation_id="installation")
            first = DedupeStore(ttl_seconds=60, state_store=first_backend)
            second = DedupeStore(ttl_seconds=60, state_store=second_backend)
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            self.assertTrue(first.claim(key, "message-1")[0])
            self.assertEqual(
                first.begin_response_files(key, "message-1"),
                (True, "sending"),
            )

            connection = sqlite3.connect(path)
            try:
                connection.execute(
                    "UPDATE channel_inbox SET lease_until_ms=0 "
                    "WHERE external_message_id='message-1'"
                )
                connection.commit()
            finally:
                connection.close()

            self.assertTrue(second.claim(key, "message-1")[0])
            self.assertEqual(
                second.begin_response_files(key, "message-1"),
                (False, "unknown"),
            )
            self.assertFalse(
                first.finish_response_files(key, "message-1", status="sent")
            )
            first_backend.close()
            second_backend.close()

    def test_completed_file_delivery_is_not_sent_again_after_reclaim(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            backend = SQLiteStateStore(path, installation_id="installation")
            dedupe = DedupeStore(ttl_seconds=60, state_store=backend)
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            self.assertTrue(dedupe.claim(key, "message-1")[0])
            self.assertEqual(
                dedupe.begin_response_files(key, "message-1"),
                (True, "sending"),
            )
            self.assertTrue(
                dedupe.finish_response_files(key, "message-1", status="sent")
            )
            self.assertTrue(dedupe.release(key, "message-1"))
            self.assertTrue(dedupe.claim(key, "message-1")[0])
            self.assertEqual(
                dedupe.begin_response_files(key, "message-1"),
                (False, "sent"),
            )
            backend.close()

    def test_reused_message_id_with_different_payload_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            backend = SQLiteStateStore(path, installation_id="installation")
            dedupe = DedupeStore(ttl_seconds=60, state_store=backend)
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            self.assertTrue(dedupe.claim(key, "message-1", payload="original")[0])
            claimed, result = dedupe.claim(key, "message-1", payload="modified")
            self.assertFalse(claimed)
            self.assertEqual(result.status, "payload_mismatch")
            backend.close()

    def test_failed_terminal_transition_keeps_claim_token_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = SQLiteStateStore(
                os.path.join(directory, "wecom-state.sqlite3"),
                installation_id="installation",
            )
            dedupe = DedupeStore(ttl_seconds=60, state_store=backend)
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            self.assertTrue(dedupe.claim(key, "message-1")[0])

            with patch.object(
                backend,
                "complete_inbox",
                side_effect=sqlite3.OperationalError("database is locked"),
            ):
                with self.assertRaises(sqlite3.OperationalError):
                    dedupe.complete(
                        key,
                        "message-1",
                        text="answer",
                        status="completed",
                    )

            self.assertTrue(
                dedupe.complete(
                    key,
                    "message-1",
                    text="answer",
                    status="completed",
                )
            )
            backend.close()

    def test_durable_inbox_honors_max_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = SQLiteStateStore(
                os.path.join(directory, "wecom-state.sqlite3"),
                installation_id="installation",
            )
            dedupe = DedupeStore(
                ttl_seconds=60,
                max_entries=2,
                state_store=backend,
            )
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            for index in range(5):
                message_id = f"message-{index}"
                self.assertTrue(dedupe.claim(key, message_id)[0])
                self.assertTrue(
                    dedupe.complete(
                        key,
                        message_id,
                        text=f"answer-{index}",
                        status="completed",
                    )
                )

            count = backend._db.execute(
                "SELECT COUNT(*) FROM channel_inbox WHERE installation_id=?",
                ("installation",),
            ).fetchone()[0]
            self.assertLessEqual(count, 2)
            backend.close()

    def test_expired_inbox_cleanup_is_batched(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = SQLiteStateStore(
                os.path.join(directory, "wecom-state.sqlite3"),
                installation_id="installation",
            )
            with backend._db:
                backend._db.executemany(
                    "INSERT INTO channel_inbox(installation_id,chat_type,chat_id,"
                    "external_user_id,external_message_id,payload_hash,state,"
                    "received_at_ms,updated_at_ms,expires_at_ms) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?)",
                    [
                        (
                            "installation",
                            "single",
                            "direct",
                            "alice",
                            f"expired-{index}",
                            "hash",
                            "completed",
                            0,
                            index,
                            0,
                        )
                        for index in range(300)
                    ],
                )
            dedupe = DedupeStore(
                ttl_seconds=60,
                max_entries=1000,
                state_store=backend,
            )
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            self.assertTrue(dedupe.claim(key, "current-message")[0])
            count = backend._db.execute(
                "SELECT COUNT(*) FROM channel_inbox WHERE installation_id=?",
                ("installation",),
            ).fetchone()[0]
            self.assertEqual(count, 45)
            backend.close()

    def test_released_claim_preserves_new_session_candidate_across_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            first_backend = SQLiteStateStore(path, installation_id="installation")
            first_sessions = SessionStore(
                id_factory=iter(("session-1", "candidate-1")).__next__,
                state_store=first_backend,
            )
            key = first_sessions.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            self.assertEqual(first_sessions.get_for_key(key), "session-1")
            first_dedupe = DedupeStore(ttl_seconds=60, state_store=first_backend)
            self.assertTrue(first_dedupe.claim(key, "message-1")[0])
            rotation, created = first_dedupe.save_rotation(
                key,
                "message-1",
                first_sessions.reserve_rotation(key),
            )
            self.assertTrue(created)
            self.assertTrue(first_dedupe.release(key, "message-1"))
            first_backend.close()

            second_backend = SQLiteStateStore(path, installation_id="installation")
            second_dedupe = DedupeStore(ttl_seconds=60, state_store=second_backend)
            self.assertTrue(second_dedupe.claim(key, "message-1")[0])
            self.assertEqual(second_dedupe.load_rotation(key, "message-1"), rotation)
            second_backend.close()


class PersistentStateAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_sqlite_claim_does_not_block_event_loop(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = SQLiteStateStore(
                os.path.join(directory, "wecom-state.sqlite3"),
                installation_id="installation",
            )
            dedupe = DedupeStore(ttl_seconds=60, state_store=backend)
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            original = backend.claim_inbox

            def slow_claim(*args, **kwargs):
                time.sleep(0.15)
                return original(*args, **kwargs)

            with patch.object(backend, "claim_inbox", side_effect=slow_claim):
                started = time.monotonic()
                claim = asyncio.create_task(dedupe.claim_async(key, "message-1"))
                await asyncio.sleep(0.02)
                self.assertLess(time.monotonic() - started, 0.1)
                self.assertTrue((await claim)[0])
            await backend.close_async()

    async def test_session_sequencer_serializes_across_store_instances(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            first_backend = SQLiteStateStore(
                path, installation_id="installation", lease_seconds=1
            )
            second_backend = SQLiteStateStore(
                path, installation_id="installation", lease_seconds=1
            )
            first = SessionSequencer(state_store=first_backend)
            second = SessionSequencer(state_store=second_backend)
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            first_entered = asyncio.Event()
            release_first = asyncio.Event()
            second_entered = asyncio.Event()

            async def hold_first():
                async with first.lock_for(key):
                    first_entered.set()
                    await release_first.wait()

            async def enter_second():
                async with second.lock_for(key):
                    second_entered.set()

            first_task = asyncio.create_task(hold_first())
            await first_entered.wait()
            second_task = asyncio.create_task(enter_second())
            await asyncio.sleep(0.1)
            self.assertFalse(second_entered.is_set())
            release_first.set()
            await asyncio.gather(first_task, second_task)
            self.assertTrue(second_entered.is_set())
            await first_backend.close_async()
            await second_backend.close_async()

    async def test_false_session_lease_renewal_interrupts_holder(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = SQLiteStateStore(
                os.path.join(directory, "wecom-state.sqlite3"),
                installation_id="installation",
                lease_seconds=1,
            )
            sequencer = SessionSequencer(state_store=backend)
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )

            with patch.object(backend, "renew_session_lease", return_value=False):
                with self.assertRaises(SessionLeaseLost):
                    async with sequencer.lock_for(key):
                        await asyncio.Event().wait()

            remaining = backend._db.execute(
                "SELECT COUNT(*) FROM channel_session_leases"
            ).fetchone()[0]
            self.assertEqual(remaining, 0)
            await backend.close_async()

    async def test_renewal_errors_fence_holder_before_second_store_enters(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            first_backend = SQLiteStateStore(
                path, installation_id="installation", lease_seconds=1
            )
            second_backend = SQLiteStateStore(
                path, installation_id="installation", lease_seconds=1
            )
            first = SessionSequencer(state_store=first_backend)
            second = SessionSequencer(state_store=second_backend)
            key = SessionStore.key(
                chat_type="single", chat_id="", external_user_id="alice"
            )
            first_entered = asyncio.Event()
            first_stopped = asyncio.Event()
            second_entered = asyncio.Event()

            async def hold_first():
                try:
                    async with first.lock_for(key):
                        first_entered.set()
                        await asyncio.Event().wait()
                except SessionLeaseLost:
                    first_stopped.set()

            async def enter_second():
                async with second.lock_for(key):
                    self.assertTrue(first_stopped.is_set())
                    second_entered.set()

            with patch.object(
                first_backend,
                "renew_session_lease",
                side_effect=sqlite3.OperationalError("database is locked"),
            ):
                first_task = asyncio.create_task(hold_first())
                await first_entered.wait()
                second_task = asyncio.create_task(enter_second())
                await asyncio.wait_for(
                    asyncio.gather(first_task, second_task),
                    timeout=2,
                )

            self.assertTrue(first_stopped.is_set())
            self.assertTrue(second_entered.is_set())
            await first_backend.close_async()
            await second_backend.close_async()

    async def test_state_store_close_is_strictly_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            async_backend = SQLiteStateStore(
                os.path.join(directory, "async.sqlite3"),
                installation_id="installation",
            )
            await asyncio.gather(
                async_backend.close_async(),
                async_backend.close_async(),
            )
            await async_backend.close_async()
            async_backend.close()
            self.assertIsNone(async_backend._db)
            self.assertIsNone(async_backend._executor)
            with self.assertRaisesRegex(RuntimeError, "closed"):
                await async_backend.run_async(lambda: None)

            sync_backend = SQLiteStateStore(
                os.path.join(directory, "sync.sqlite3"),
                installation_id="installation",
            )
            sync_backend.close()
            sync_backend.close()
            await sync_backend.close_async()
            self.assertIsNone(sync_backend._db)
            self.assertIsNone(sync_backend._executor)

    async def test_cancelled_close_does_not_cancel_shared_database_close(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = SQLiteStateStore(
                os.path.join(directory, "cancelled.sqlite3"),
                installation_id="installation",
            )
            operation_started = asyncio.Event()
            loop = asyncio.get_running_loop()

            def slow_operation():
                loop.call_soon_threadsafe(operation_started.set)
                time.sleep(0.1)

            operation = asyncio.create_task(backend.run_async(slow_operation))
            await operation_started.wait()
            closing = asyncio.create_task(backend.close_async())
            await asyncio.sleep(0)
            closing.cancel()

            with self.assertRaises(asyncio.CancelledError):
                await closing
            await operation
            await backend.close_async()
            self.assertIsNone(backend._db)
            self.assertIsNone(backend._executor)


class ConfigTests(unittest.TestCase):
    def test_installation_scope_includes_channel_tenant_bot_and_connector(self):
        scope = json.loads(_installation_id(_config()))
        self.assertEqual(
            scope,
            {
                "bot_id": "bot-1",
                "channel": "wecom",
                "connector_id": "wecom-desktop",
                "tenant_id": "tenant-1",
            },
        )

    def test_channel_url_normalization(self):
        self.assertEqual(
            _channel_url("https://gateway.example/root/"),
            "wss://gateway.example/root/ws/v2/channel",
        )
        self.assertEqual(
            _channel_url("ws://gateway.example/ws/v2/channel"),
            "ws://gateway.example/ws/v2/channel",
        )

    def test_environment_values_override_desktop_defaults(self):
        with tempfile.NamedTemporaryFile(suffix=".sqlite") as db:
            env = {
                "ARCFORGE_CONFIG_DB": db.name,
                "WECOM_AIBOT_BOT_ID": " env-bot ",
                "WECOM_AIBOT_SECRET": " env-secret ",
                "ARCFORGE_GATEWAY_CHANNEL_TOKEN": " env-token ",
                "ARCFORGE_GATEWAY_URL": "https://gateway.example",
            }
            with patch.dict(os.environ, env, clear=False):
                config = load_config()
        self.assertEqual(config.bot_id, "env-bot")
        self.assertEqual(config.secret, "env-secret")
        self.assertEqual(config.channel_token, "env-token")
        self.assertEqual(config.gateway_url, "wss://gateway.example/ws/v2/channel")

    def test_explicit_environment_credentials_override_disabled_desktop_flag(self):
        with tempfile.NamedTemporaryFile(suffix=".sqlite") as db:
            env = {
                "ARCFORGE_CONFIG_DB": db.name,
                "WECOM_AIBOT_BOT_ID": "env-bot",
                "WECOM_AIBOT_SECRET": "env-secret",
                "ARCFORGE_GATEWAY_CHANNEL_TOKEN": "env-token",
                "ARCFORGE_GATEWAY_URL": "https://gateway.example",
            }
            with patch.dict(os.environ, env, clear=False):
                config = load_config()
        self.assertEqual(config.bot_id, "env-bot")

    def test_state_database_path_can_be_configured(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = os.path.join(directory, "custom-state.sqlite3")
            env = {
                "WECOM_AIBOT_BOT_ID": "env-bot",
                "WECOM_AIBOT_SECRET": "env-secret",
                "ARCFORGE_GATEWAY_CHANNEL_TOKEN": "env-token",
                "ARCFORGE_GATEWAY_URL": "https://gateway.example",
                "ARCFORGE_CHANNEL_STATE_DB": state_path,
            }
            with patch.dict(os.environ, env, clear=False):
                config = load_config()
        self.assertEqual(config.state_db_path, state_path)

    def test_state_database_defaults_below_arcforge_channel_state(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {
                "ARCFORGE_HOME": directory,
                "ARCFORGE_CHANNEL_STATE_DB": "",
                "WECOM_AIBOT_BOT_ID": "env-bot",
                "WECOM_AIBOT_SECRET": "env-secret",
                "ARCFORGE_GATEWAY_CHANNEL_TOKEN": "env-token",
                "ARCFORGE_GATEWAY_URL": "https://gateway.example",
            }
            with patch.dict(os.environ, env, clear=False):
                config = load_config()
        self.assertEqual(
            config.state_db_path,
            os.path.join(directory, "channel-state", "wecom-state.sqlite3"),
        )

    def test_disabled_desktop_connector_is_rejected_without_environment_override(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = os.path.join(directory, "config.sqlite")
            with sqlite3.connect(db_path) as connection:
                connection.execute(
                    "CREATE TABLE wecom_settings ("
                    "config_id TEXT PRIMARY KEY, enabled INTEGER, bot_id TEXT, tenant_id TEXT, "
                    "connector_id TEXT, allow_group_messages INTEGER, aibot_secret TEXT, "
                    "channel_token TEXT)"
                )
                connection.execute(
                    "CREATE TABLE remote_settings (config_id TEXT PRIMARY KEY, payload_json TEXT)"
                )
                connection.execute(
                    "INSERT INTO wecom_settings VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        "default",
                        0,
                        "bot-1",
                        "tenant-1",
                        "wecom-desktop",
                        0,
                        "secret",
                        "token",
                    ),
                )
            connection.close()
            env = {
                "ARCFORGE_CONFIG_DB": db_path,
                "WECOM_AIBOT_BOT_ID": "",
                "WECOM_AIBOT_SECRET": "",
                "ARCFORGE_GATEWAY_CHANNEL_TOKEN": "",
            }
            with patch.dict(os.environ, env, clear=False):
                with self.assertRaisesRegex(ValueError, "disabled"):
                    load_config()


class ProtocolTests(unittest.TestCase):
    def test_client_frame_round_trip(self):
        frame = ChannelClientFrame(
            request_id="hello-1",
            hello=ClientHello(
                protocol_version=2,
                role=CHANNEL_ROLE,
                token="token",
                channel_tenant_id="tenant-1",
                channel_bot_id="bot-1",
                connector_id="wecom-desktop",
            ),
        )
        decoded = ChannelClientFrame.FromString(frame.SerializeToString())
        self.assertEqual(decoded.request_id, "hello-1")
        self.assertEqual(decoded.hello.role, CHANNEL_ROLE)

    def test_v1_error_response_wire_shape(self):
        frame = ChannelServerFrame(
            local_error=ErrorResponse(code=17, message="bad request")
        )
        decoded = ChannelServerFrame.FromString(frame.SerializeToString())
        self.assertEqual(
            decoded.local_error.DESCRIPTOR.full_name,
            "liveagent.gateway.v1.ErrorResponse",
        )
        self.assertEqual(decoded.local_error.code, 17)
        self.assertEqual(decoded.local_error.message, "bad request")

    def test_inbound_command_and_session_fields_round_trip(self):
        inbound = make_inbound(
            external_message_id=" message-1 ",
            external_user_id=" alice ",
            chat_id="",
            chat_type=" SINGLE ",
            text="",
            command=" COMPACT ",
            channel_session_id=" session-1 ",
            timestamp=123,
        )
        decoded = ChannelInboundMessage.FromString(inbound.SerializeToString())
        self.assertEqual(decoded.command, "compact")
        self.assertEqual(decoded.channel_session_id, "session-1")
        self.assertEqual(decoded.DESCRIPTOR.fields_by_name["command"].number, 7)
        self.assertEqual(
            decoded.DESCRIPTOR.fields_by_name["channel_session_id"].number, 8
        )

    def test_file_frames_round_trip_with_canonical_field_numbers(self):
        inbound = make_inbound(
            external_message_id="message-1",
            external_user_id="alice",
            chat_id="",
            chat_type="single",
            text="",
            files=[
                ChannelInboundFile(
                    file_name="report.csv",
                    mime_type="text/csv",
                    content=b"a,b\n1,2\n",
                )
            ],
        )
        decoded = ChannelInboundMessage.FromString(inbound.SerializeToString())
        self.assertEqual(decoded.DESCRIPTOR.fields_by_name["files"].number, 9)
        self.assertEqual(decoded.files[0].file_name, "report.csv")
        self.assertEqual(decoded.files[0].content, b"a,b\n1,2\n")

        server = ChannelServerFrame(
            request_id="request-1",
            file=ChannelFile(
                run_id="run-1",
                conversation_id="conversation-1",
                seq=3,
                file_name="answer.csv",
                mime_type="text/csv",
                size_bytes=3,
                content=b"abc",
            ),
        )
        decoded_server = ChannelServerFrame.FromString(server.SerializeToString())
        self.assertEqual(decoded_server.DESCRIPTOR.fields_by_name["file"].number, 8)
        self.assertEqual(decoded_server.file.size_bytes, 3)
        self.assertEqual(decoded_server.file.content, b"abc")

    def test_progress_frame_and_hello_opt_in_use_canonical_field_numbers(self):
        hello = ClientHello(
            protocol_version=2,
            role=CHANNEL_ROLE,
            token="token",
            channel_tenant_id="tenant-1",
            channel_bot_id="bot-1",
            connector_id="wecom-desktop",
            channel_progress_version=1,
        )
        self.assertEqual(
            hello.DESCRIPTOR.fields_by_name["channel_progress_version"].number, 12
        )
        self.assertEqual(ClientHello.FromString(hello.SerializeToString()).channel_progress_version, 1)

        server = ChannelServerFrame(
            request_id="request-1",
            progress=ChannelProgress(
                run_id="run-1",
                conversation_id="conversation-1",
                seq=4,
                kind="thinking",
                text="先看一下",
                round=2,
            ),
        )
        decoded = ChannelServerFrame.FromString(server.SerializeToString())
        self.assertEqual(decoded.DESCRIPTOR.fields_by_name["progress"].number, 13)
        self.assertEqual(decoded.WhichOneof("payload"), "progress")
        self.assertEqual(decoded.progress.kind, "thinking")
        self.assertEqual(decoded.progress.text, "先看一下")
        self.assertEqual(decoded.progress.round, 2)
        fields = decoded.progress.DESCRIPTOR.fields_by_name
        self.assertEqual(
            [fields[name].number for name in ("run_id", "conversation_id", "seq", "kind", "text", "round")],
            [1, 2, 3, 4, 5, 6],
        )


class WorkerCommandTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _frame(message_id, text, *, user_id="alice", chat_id="", chat_type="single"):
        return {
            "body": {
                "msgid": message_id,
                "from": {"userid": user_id},
                "chattype": chat_type,
                "chatid": chat_id,
                "text": {"content": text},
            }
        }

    async def test_new_rotates_once_and_unknown_slash_text_stays_ordinary(self):
        ids = iter(("session-1", "session-2"))
        sessions = SessionStore(id_factory=lambda: next(ids))
        dedupe = DedupeStore()
        wecom = SimpleNamespace(reply_stream=AsyncMock())
        result = SimpleNamespace(status="completed", text="ok", message="")
        channel = SimpleNamespace(submit=AsyncMock(return_value=result))
        config = _config()

        await _handle_text(
            wecom,
            channel,
            dedupe,
            sessions,
            config,
            self._frame("message-1", "/new later"),
        )
        await _handle_text(
            wecom,
            channel,
            dedupe,
            sessions,
            config,
            self._frame("message-2", "/new"),
        )
        await _handle_text(
            wecom,
            channel,
            dedupe,
            sessions,
            config,
            self._frame("message-2", "/new"),
        )

        self.assertEqual(channel.submit.await_count, 2)
        ordinary = channel.submit.await_args_list[0].args[0]
        command = channel.submit.await_args_list[1].args[0]
        self.assertEqual(ordinary.text, "/new later")
        self.assertEqual(ordinary.command, "")
        self.assertEqual(ordinary.channel_session_id, "session-1")
        self.assertEqual(command.text, "")
        self.assertEqual(command.command, "new")
        self.assertEqual(command.channel_session_id, "session-2")
        self.assertEqual(
            sessions.get(chat_type="single", chat_id="", external_user_id="alice"),
            "session-2",
        )

    async def test_compact_keeps_session_and_help_is_answered_locally(self):
        sessions = SessionStore(id_factory=lambda: "session-1")
        dedupe = DedupeStore()
        wecom = SimpleNamespace(reply_stream=AsyncMock())
        result = SimpleNamespace(status="completed", text="ok", message="")
        channel = SimpleNamespace(submit=AsyncMock(return_value=result))
        config = _config()

        await _handle_text(
            wecom,
            channel,
            dedupe,
            sessions,
            config,
            self._frame("message-1", "/compact"),
        )
        await _handle_text(
            wecom,
            channel,
            dedupe,
            sessions,
            config,
            self._frame("message-2", "/帮助"),
        )

        self.assertEqual(channel.submit.await_count, 1)
        compact = channel.submit.await_args_list[0].args[0]
        self.assertEqual((compact.command, compact.text), ("compact", ""))
        self.assertEqual(compact.channel_session_id, "session-1")
        help_reply = wecom.reply_stream.await_args_list[-1].args
        self.assertIn("/new", help_reply[2])
        self.assertIn("/compact", help_reply[2])
        self.assertTrue(help_reply[3])

    async def test_stale_lease_owner_does_not_send_a_final_reply(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "wecom-state.sqlite3")
            first_backend = SQLiteStateStore(path, installation_id="installation")
            second_backend = SQLiteStateStore(path, installation_id="installation")
            first = DedupeStore(ttl_seconds=60, state_store=first_backend)
            second = DedupeStore(ttl_seconds=60, state_store=second_backend)
            session_ids = iter(("session-1", "session-2"))
            sessions = SessionStore(id_factory=lambda: next(session_ids))
            frame = self._frame("message-1", "/new")
            key = sessions.key(chat_type="single", chat_id="", external_user_id="alice")
            self.assertEqual(sessions.get_for_key(key), "session-1")

            async def submit(_inbound):
                connection = sqlite3.connect(path)
                try:
                    connection.execute(
                        "UPDATE channel_inbox SET lease_until_ms=0 "
                        "WHERE external_message_id='message-1'"
                    )
                    connection.commit()
                finally:
                    connection.close()
                self.assertTrue(
                    second.claim(
                        key,
                        "message-1",
                        payload=_dedupe_payload(frame["body"]),
                    )[0]
                )
                return SimpleNamespace(
                    status="completed",
                    text="stale",
                    message="",
                    files=[
                        ChannelResponseFile(
                            file_name="stale.txt",
                            content=b"stale",
                            size_bytes=5,
                        )
                    ],
                )

            wecom = SimpleNamespace(
                reply_stream=AsyncMock(),
                upload_media=AsyncMock(return_value={"media_id": "media-1"}),
                send_message=AsyncMock(return_value={"errcode": 0}),
            )
            channel = SimpleNamespace(submit=AsyncMock(side_effect=submit))
            with patch("connectors.wecom_aibot.worker.logger.warning"):
                await _handle_text(
                    wecom,
                    channel,
                    first,
                    sessions,
                    _config(),
                    frame,
                )

            final_replies = [
                call for call in wecom.reply_stream.await_args_list if call.args[3]
            ]
            self.assertEqual(final_replies, [])
            wecom.upload_media.assert_not_awaited()
            wecom.send_message.assert_not_awaited()
            self.assertEqual(sessions.get_for_key(key), "session-1")
            first_backend.close()
            second_backend.close()

    async def test_failed_new_retry_does_not_rotate_again(self):
        ids = iter(("session-1", "session-2"))
        sessions = SessionStore(id_factory=lambda: next(ids))
        sessions.get(chat_type="single", chat_id="", external_user_id="alice")
        dedupe = DedupeStore()
        wecom = SimpleNamespace(reply_stream=AsyncMock())
        channel = SimpleNamespace(submit=AsyncMock(side_effect=RuntimeError("offline")))
        config = _config()
        frame = self._frame("message-1", "/new")

        with patch("connectors.wecom_aibot.worker.logger.exception"):
            await _handle_text(wecom, channel, dedupe, sessions, config, frame)
            await _handle_text(wecom, channel, dedupe, sessions, config, frame)

        self.assertEqual(channel.submit.await_count, 1)
        self.assertEqual(
            sessions.get(chat_type="single", chat_id="", external_user_id="alice"),
            "session-1",
        )

    async def test_unverified_deduped_new_does_not_commit_fresh_candidate(self):
        ids = iter(("session-1", "session-2"))
        sessions = SessionStore(id_factory=lambda: next(ids))
        key = sessions.key(chat_type="single", chat_id="", external_user_id="alice")
        self.assertEqual(sessions.get_for_key(key), "session-1")
        result = SimpleNamespace(
            status="completed",
            text="canonical answer",
            message="",
            files=[],
            deduped=True,
        )
        channel = SimpleNamespace(submit=AsyncMock(return_value=result))

        with patch("connectors.wecom_aibot.worker.logger.warning"):
            await _handle_text(
                SimpleNamespace(reply_stream=AsyncMock()),
                channel,
                DedupeStore(),
                sessions,
                _config(),
                self._frame("message-1", "/new"),
            )

        self.assertEqual(sessions.get_for_key(key), "session-1")

    async def test_ambiguous_submit_retry_reuses_canonical_new_candidate(self):
        ids = iter(("session-1", "session-2"))
        sessions = SessionStore(id_factory=lambda: next(ids))
        key = sessions.key(chat_type="single", chat_id="", external_user_id="alice")
        self.assertEqual(sessions.get_for_key(key), "session-1")
        ambiguous = ChannelResponse(
            request_id="request-1",
            external_message_id="message-1",
            message="accepted frame was lost",
            canonical_started=True,
        )
        canonical = SimpleNamespace(
            status="completed",
            text="canonical answer",
            message="",
            files=[],
            deduped=True,
        )
        channel = SimpleNamespace(
            submit=AsyncMock(
                side_effect=(ChannelSubmitInterrupted(ambiguous), canonical)
            )
        )
        dedupe = DedupeStore()
        frame = self._frame("message-1", "/new")

        with patch("connectors.wecom_aibot.worker.logger.warning"):
            await _handle_text(
                SimpleNamespace(reply_stream=AsyncMock()),
                channel,
                dedupe,
                sessions,
                _config(),
                frame,
            )
            await _handle_text(
                SimpleNamespace(reply_stream=AsyncMock()),
                channel,
                dedupe,
                sessions,
                _config(),
                frame,
            )

        submitted = [call.args[0] for call in channel.submit.await_args_list]
        self.assertEqual(
            [message.channel_session_id for message in submitted],
            ["session-2", "session-2"],
        )
        self.assertEqual(sessions.get_for_key(key), "session-2")

    async def test_accepted_disconnect_retry_reuses_canonical_new_candidate(self):
        ids = iter(("session-1", "session-2"))
        sessions = SessionStore(id_factory=lambda: next(ids))
        key = sessions.key(chat_type="single", chat_id="", external_user_id="alice")
        self.assertEqual(sessions.get_for_key(key), "session-1")
        interrupted = ChannelResponse(
            request_id="request-1",
            external_message_id="message-1",
            run_id="run-1",
            conversation_id="conversation-1",
            status="failed",
            message="disconnected",
        )
        canonical = SimpleNamespace(
            status="completed",
            text="canonical answer",
            message="",
            files=[],
            deduped=True,
        )
        channel = SimpleNamespace(
            submit=AsyncMock(
                side_effect=(ChannelSubmitInterrupted(interrupted), canonical)
            )
        )
        dedupe = DedupeStore()
        wecom = SimpleNamespace(reply_stream=AsyncMock())
        frame = self._frame("message-1", "/new")

        with patch("connectors.wecom_aibot.worker.logger.warning"):
            await _handle_text(wecom, channel, dedupe, sessions, _config(), frame)
            await _handle_text(wecom, channel, dedupe, sessions, _config(), frame)

        submitted = [call.args[0] for call in channel.submit.await_args_list]
        self.assertEqual(
            [message.channel_session_id for message in submitted],
            ["session-2", "session-2"],
        )
        self.assertEqual(sessions.get_for_key(key), "session-2")

    async def test_accepted_lease_loss_releases_new_for_canonical_retry(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        backend = SQLiteStateStore(
            os.path.join(directory, "wecom-state.sqlite3"),
            installation_id="installation",
            lease_seconds=1,
        )
        self.addAsyncCleanup(backend.close_async)
        ids = iter(("session-1", "session-2"))
        sessions = SessionStore(
            id_factory=lambda: next(ids),
            state_store=backend,
        )
        dedupe = DedupeStore(ttl_seconds=60, state_store=backend)
        sequencer = SessionSequencer(state_store=backend)
        key = sessions.key(chat_type="single", chat_id="", external_user_id="alice")
        self.assertEqual(await sessions.get_for_key_async(key), "session-1")
        accepted = asyncio.Event()
        submit_count = 0

        async def submit(_inbound):
            nonlocal submit_count
            submit_count += 1
            if submit_count == 1:
                accepted.set()
                await asyncio.Event().wait()
            return SimpleNamespace(
                status="completed",
                text="canonical answer",
                message="",
                files=[],
                deduped=True,
            )

        channel = SimpleNamespace(submit=AsyncMock(side_effect=submit))
        wecom = SimpleNamespace(
            reply_stream=AsyncMock(),
            upload_media=AsyncMock(),
            send_message=AsyncMock(),
        )
        frame = self._frame("message-1", "/new")

        with (
            patch.object(backend, "renew_session_lease", return_value=False),
            patch("connectors.wecom_aibot.worker.logger.warning"),
        ):
            first_attempt = asyncio.create_task(
                _handle_text(
                    wecom,
                    channel,
                    dedupe,
                    sessions,
                    _config(),
                    frame,
                    sequencer,
                )
            )
            await asyncio.wait_for(accepted.wait(), timeout=1)
            await asyncio.wait_for(first_attempt, timeout=1)

        inbox = backend._db.execute(
            "SELECT state,claim_token,lease_until_ms,response_status,"
            "rotation_expected_session_id,rotation_candidate_session_id,"
            "rotation_expected_generation FROM channel_inbox "
            "WHERE external_message_id='message-1'"
        ).fetchone()
        self.assertEqual(tuple(inbox[:4]), ("processing", None, 0, ""))
        self.assertEqual(
            tuple(inbox[4:]),
            ("session-1", "session-2", 1),
        )
        self.assertEqual(await sessions.get_for_key_async(key), "session-1")
        self.assertFalse(
            any(call.args[3] for call in wecom.reply_stream.await_args_list)
        )
        wecom.upload_media.assert_not_awaited()
        wecom.send_message.assert_not_awaited()

        with patch("connectors.wecom_aibot.worker.logger.warning"):
            await _handle_text(
                wecom,
                channel,
                dedupe,
                sessions,
                _config(),
                frame,
                sequencer,
            )

        submitted = [call.args[0] for call in channel.submit.await_args_list]
        self.assertEqual(
            [message.channel_session_id for message in submitted],
            ["session-2", "session-2"],
        )
        self.assertEqual(await sessions.get_for_key_async(key), "session-2")
        final_replies = [
            call.args[2] for call in wecom.reply_stream.await_args_list if call.args[3]
        ]
        self.assertEqual(final_replies, ["canonical answer"])

    async def test_new_with_empty_completed_response_does_not_rotate(self):
        ids = iter(("session-1", "session-2"))
        sessions = SessionStore(id_factory=lambda: next(ids))
        sessions.get(chat_type="single", chat_id="", external_user_id="alice")
        dedupe = DedupeStore()
        wecom = SimpleNamespace(reply_stream=AsyncMock())
        channel = SimpleNamespace(
            submit=AsyncMock(
                return_value=SimpleNamespace(
                    status="completed",
                    text="",
                    message="",
                    files=[],
                )
            )
        )

        with patch("connectors.wecom_aibot.worker.logger.exception"):
            await _handle_text(
                wecom,
                channel,
                dedupe,
                sessions,
                _config(),
                self._frame("message-1", "/new"),
            )

        self.assertEqual(
            sessions.get(chat_type="single", chat_id="", external_user_id="alice"),
            "session-1",
        )

    async def test_completed_without_text_is_failed_and_not_cached(self):
        sessions = SessionStore(id_factory=lambda: "session-1")
        dedupe = DedupeStore()
        wecom = SimpleNamespace(reply_stream=AsyncMock())
        result = SimpleNamespace(status="completed", text="", message="")
        channel = SimpleNamespace(submit=AsyncMock(return_value=result))
        config = _config()
        frame = self._frame("message-1", "hello")

        with patch("connectors.wecom_aibot.worker.logger.exception"):
            await _handle_text(wecom, channel, dedupe, sessions, config, frame)
            await _handle_text(wecom, channel, dedupe, sessions, config, frame)

        self.assertEqual(channel.submit.await_count, 2)
        final_replies = [
            call.args[2] for call in wecom.reply_stream.await_args_list if call.args[3]
        ]
        self.assertEqual(len(final_replies), 2)
        self.assertNotIn("(empty response)", final_replies)

    async def test_long_turn_waits_for_reauthentication_before_final_reply(self):
        authenticated = asyncio.Event()
        authenticated.set()
        submit_started = asyncio.Event()
        release_result = asyncio.Event()

        async def submit(_inbound):
            submit_started.set()
            await release_result.wait()
            return SimpleNamespace(
                status="completed", text="desktop result", message=""
            )

        wecom = SimpleNamespace(
            reply_stream=AsyncMock(return_value={"errcode": 0}),
            send_message=AsyncMock(return_value={"errcode": 0}),
        )
        channel = SimpleNamespace(submit=AsyncMock(side_effect=submit))
        task = asyncio.create_task(
            _handle_text(
                wecom,
                channel,
                DedupeStore(),
                SessionStore(id_factory=lambda: "session-1"),
                _config(),
                self._frame("message-1", "long question"),
                authenticated=authenticated,
            )
        )

        await asyncio.wait_for(submit_started.wait(), timeout=1)
        authenticated.clear()
        release_result.set()
        await asyncio.sleep(0)
        self.assertFalse(task.done())

        authenticated.set()
        await asyncio.wait_for(task, timeout=1)

        final_calls = [
            call for call in wecom.reply_stream.await_args_list if call.args[3] is True
        ]
        self.assertEqual(len(final_calls), 1)
        self.assertEqual(final_calls[0].args[2], "desktop result")

    async def test_new_and_followup_are_submitted_in_session_order(self):
        ids = iter(("session-1", "session-2"))
        sessions = SessionStore(id_factory=lambda: next(ids))
        sessions.get(chat_type="single", chat_id="", external_user_id="alice")
        sequencer = SessionSequencer()
        dedupe = DedupeStore()
        wecom = SimpleNamespace(reply_stream=AsyncMock())
        new_started = asyncio.Event()
        release_new = asyncio.Event()
        submitted = []

        async def submit(inbound):
            submitted.append(inbound)
            if inbound.command == "new":
                new_started.set()
                await release_new.wait()
            return SimpleNamespace(status="completed", text="ok", message="")

        channel = SimpleNamespace(submit=AsyncMock(side_effect=submit))
        config = _config()
        new_task = asyncio.create_task(
            _handle_text(
                wecom,
                channel,
                dedupe,
                sessions,
                config,
                self._frame("message-1", "/new"),
                sequencer,
            )
        )
        await new_started.wait()
        followup_frame = self._frame("message-2", "next question")
        followup_task = asyncio.create_task(
            _handle_text(
                wecom,
                channel,
                dedupe,
                sessions,
                config,
                followup_frame,
                sequencer,
            )
        )
        await asyncio.sleep(0)

        self.assertEqual(channel.submit.await_count, 1)
        self.assertTrue(
            any(
                call.args[0] is followup_frame and call.args[3] is False
                for call in wecom.reply_stream.await_args_list
            ),
            "queued callbacks must receive a placeholder before waiting",
        )
        release_new.set()
        await asyncio.gather(new_task, followup_task)

        self.assertEqual([inbound.command for inbound in submitted], ["new", ""])
        self.assertEqual(submitted[0].channel_session_id, "session-2")
        self.assertEqual(submitted[1].channel_session_id, "session-2")


class WorkerInteractionTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _frame(message_id, text, *, user_id="alice"):
        return {
            "headers": {"req_id": f"callback-{message_id}"},
            "body": {
                "msgid": message_id,
                "from": {"userid": user_id},
                "chattype": "single",
                "chatid": "",
                "text": {"content": text},
            },
        }

    @staticmethod
    def _request(*, interaction_id="input-1", deadline_at_ms=None):
        return {
            "interaction_id": interaction_id,
            "deadline_at_ms": deadline_at_ms or int(time.time() * 1000) + 60_000,
            "questions": [
                {
                    "id": "dimension",
                    "header": "口径",
                    "prompt": "您要分析哪种事业群口径？",
                    "options": [
                        {
                            "id": "business",
                            "label": "业务板块事业群",
                            "description": "按业务板块统计",
                            "recommended": True,
                        },
                        {
                            "id": "organization",
                            "label": "组织事业群",
                            "description": "按组织架构统计",
                        },
                    ],
                }
            ],
        }

    @staticmethod
    def _wecom(**overrides):
        values = {
            "reply_stream": AsyncMock(return_value={"errcode": 0}),
            "reply_stream_with_card": AsyncMock(return_value={"errcode": 0}),
            "update_template_card": AsyncMock(return_value={"errcode": 0}),
        }
        values.update(overrides)
        return SimpleNamespace(**values)

    async def test_text_answer_bypasses_active_session_lock_and_resumes_same_turn(self):
        interactions = InteractionCoordinator()
        sessions = SessionStore(id_factory=lambda: "session-1")
        sequencer = SessionSequencer()
        dedupe = DedupeStore()
        wecom = self._wecom()
        request_presented = asyncio.Event()
        answer_received = asyncio.Event()

        async def submit(
            _inbound,
            *,
            input_request_handler=None,
            input_resolved_handler=None,
        ):
            self.assertIsNotNone(input_request_handler)
            self.assertIsNotNone(input_resolved_handler)
            await input_request_handler(self._request())
            request_presented.set()
            await answer_received.wait()
            await input_resolved_handler(
                {"interaction_id": "input-1", "status": "answered"}
            )
            return SimpleNamespace(status="completed", text="done", message="")

        async def answer_input(interaction_id, selections):
            self.assertEqual(interaction_id, "input-1")
            self.assertEqual(
                selections,
                [{"question_id": "dimension", "option_id": "business"}],
            )
            answer_received.set()
            return {
                "interaction_id": interaction_id,
                "accepted": True,
                "status": "accepted",
            }

        channel = SimpleNamespace(
            submit=AsyncMock(side_effect=submit),
            answer_input=AsyncMock(side_effect=answer_input),
        )
        turn = asyncio.create_task(
            _handle_text(
                wecom,
                channel,
                dedupe,
                sessions,
                _config(),
                self._frame("message-1", "开始分析"),
                sequencer,
                interactions,
            )
        )
        await asyncio.wait_for(request_presented.wait(), timeout=1)

        # The original turn still owns the SessionSequencer lock. A reply that
        # goes through the normal turn path would deadlock here.
        await asyncio.wait_for(
            _handle_text(
                wecom,
                channel,
                dedupe,
                sessions,
                _config(),
                self._frame("message-2", "1"),
                sequencer,
                interactions,
            ),
            timeout=1,
        )
        await asyncio.wait_for(turn, timeout=1)

        self.assertEqual(channel.submit.await_count, 1)
        channel.answer_input.assert_awaited_once()
        wecom.reply_stream_with_card.assert_awaited_once()
        answer_replies = [call.args[2] for call in wecom.reply_stream.await_args_list]
        self.assertTrue(any("选择已提交" in text for text in answer_replies))

    async def test_turn_keepalive_pauses_for_input_card_and_resumes_after_resolution(
        self,
    ):
        interactions = InteractionCoordinator()
        sessions = SessionStore(id_factory=lambda: "session-1")
        dedupe = DedupeStore()
        wecom = self._wecom()
        keepalive_started = asyncio.Event()
        captured = {}

        async def fake_keepalive(
            _client,
            _frame,
            _stream_id,
            *,
            refresh_allowed,
            send_lock,
            stop,
            interval_seconds=240,
            **_kwargs,
        ):
            captured["refresh_allowed"] = refresh_allowed
            captured["send_lock"] = send_lock
            captured["interval_seconds"] = interval_seconds
            keepalive_started.set()
            await stop.wait()

        async def submit(
            _inbound,
            *,
            input_request_handler=None,
            input_resolved_handler=None,
        ):
            await asyncio.wait_for(keepalive_started.wait(), timeout=1)
            await input_request_handler(self._request())
            self.assertFalse(captured["refresh_allowed"].is_set())
            self.assertFalse(captured["send_lock"].locked())
            await input_resolved_handler(
                {"interaction_id": "input-1", "status": "answered"}
            )
            self.assertTrue(captured["refresh_allowed"].is_set())
            return SimpleNamespace(status="completed", text="done", message="")

        channel = SimpleNamespace(submit=AsyncMock(side_effect=submit))
        with patch(
            "connectors.wecom_aibot.worker._maintain_reply_stream",
            new=fake_keepalive,
        ):
            await _handle_text(
                wecom,
                channel,
                dedupe,
                sessions,
                _config(),
                self._frame("message-1", "开始分析"),
                interactions=interactions,
            )

        wecom.reply_stream_with_card.assert_awaited_once()
        self.assertEqual(await interactions.pending_count(), 0)

    async def test_final_reply_waits_for_delayed_input_resolution_update(self):
        interactions = InteractionCoordinator()
        sessions = SessionStore(id_factory=lambda: "session-1")
        dedupe = DedupeStore()
        wecom = self._wecom()

        async def submit(
            _inbound,
            *,
            input_request_handler=None,
            input_resolved_handler=None,
        ):
            await input_request_handler(self._request())

            async def resolve_later():
                await asyncio.sleep(0.01)
                await input_resolved_handler(
                    {"interaction_id": "input-1", "status": "answered"}
                )

            asyncio.create_task(resolve_later())
            return SimpleNamespace(status="completed", text="done", message="")

        channel = SimpleNamespace(submit=AsyncMock(side_effect=submit))
        await _handle_text(
            wecom,
            channel,
            dedupe,
            sessions,
            _config(),
            self._frame("message-1", "开始分析"),
            interactions=interactions,
        )

        replies = [call.args[2:4] for call in wecom.reply_stream.await_args_list]
        self.assertIn(("选择已完成，桌面端正在继续处理。", False), replies)
        self.assertEqual(replies[-1], ("done", True))

    async def test_card_failure_falls_back_to_numbered_markdown_without_remote_error(
        self,
    ):
        interactions = InteractionCoordinator()
        wecom = self._wecom(
            reply_stream_with_card=AsyncMock(
                side_effect=RuntimeError("remote response containing sensitive text")
            )
        )
        session_key = SessionStore.key(
            chat_type="single", chat_id="", external_user_id="alice"
        )

        with patch("connectors.wecom_aibot.interactions.logger.warning"):
            presented = await interactions.present(
                self._request(),
                session_key=session_key,
                wecom=wecom,
                frame=self._frame("message-1", "start"),
                stream_id="stream-1",
            )

        self.assertTrue(presented)
        wecom.reply_stream_with_card.assert_awaited_once()
        markdown = wecom.reply_stream.await_args.args[2]
        self.assertIn("您要分析哪种事业群口径", markdown)
        self.assertIn("1. 业务板块事业群", markdown)
        self.assertIn("回复选项序号", markdown)
        self.assertNotIn("sensitive", markdown)

    async def test_card_click_is_mapped_updated_and_duplicate_click_is_idempotent(self):
        interactions = InteractionCoordinator()
        wecom = self._wecom()
        session_key = SessionStore.key(
            chat_type="single", chat_id="", external_user_id="alice"
        )
        await interactions.present(
            self._request(),
            session_key=session_key,
            wecom=wecom,
            frame=self._frame("message-1", "start"),
            stream_id="stream-1",
        )
        card = wecom.reply_stream_with_card.await_args.kwargs["template_card"]
        event_frame = {
            "headers": {"req_id": "card-event-1"},
            "body": {
                "from": {"userid": "alice"},
                "chattype": "single",
                "event": {
                    "eventtype": "template_card_event",
                    "task_id": card["task_id"],
                    "event_key": "o2",
                },
            },
        }
        channel = SimpleNamespace(
            answer_input=AsyncMock(
                return_value={
                    "interaction_id": "input-1",
                    "accepted": True,
                    "status": "accepted",
                }
            )
        )

        self.assertTrue(
            await interactions.handle_card_event(
                frame=event_frame,
                session_key=session_key,
                wecom=wecom,
                channel=channel,
            )
        )
        self.assertTrue(
            await interactions.handle_card_event(
                frame=event_frame,
                session_key=session_key,
                wecom=wecom,
                channel=channel,
            )
        )

        channel.answer_input.assert_awaited_once_with(
            "input-1",
            [{"question_id": "dimension", "option_id": "organization"}],
        )
        self.assertEqual(wecom.update_template_card.await_count, 1)
        updated_card = wecom.update_template_card.await_args_list[0].args[1]
        self.assertEqual(updated_card["card_type"], "text_notice")
        self.assertEqual(updated_card["main_title"]["title"], "选择已收到")

    async def test_multi_question_card_advances_one_button_question_at_a_time(self):
        interactions = InteractionCoordinator()
        wecom = self._wecom()
        session_key = SessionStore.key(
            chat_type="single", chat_id="", external_user_id="alice"
        )
        request = self._request()
        request["questions"].append(
            {
                "id": "period",
                "header": "周期",
                "prompt": "选择统计周期？",
                "options": [
                    {"id": "month", "label": "月度"},
                    {"id": "quarter", "label": "季度"},
                ],
            }
        )
        await interactions.present(
            request,
            session_key=session_key,
            wecom=wecom,
            frame=self._frame("message-1", "start"),
            stream_id="stream-1",
        )
        first_card = wecom.reply_stream_with_card.await_args.kwargs["template_card"]
        self.assertEqual(first_card["card_type"], "button_interaction")
        self.assertEqual(
            [button["key"] for button in first_card["button_list"]], ["o1", "o2"]
        )

        channel = SimpleNamespace(
            answer_input=AsyncMock(
                return_value={
                    "interaction_id": "input-1",
                    "accepted": True,
                    "status": "accepted",
                }
            )
        )
        first_event = {
            "headers": {"req_id": "card-event-1"},
            "body": {
                "from": {"userid": "alice"},
                "chattype": "single",
                "event": {"task_id": first_card["task_id"], "event_key": "o2"},
            },
        }
        self.assertTrue(
            await interactions.handle_card_event(
                frame=first_event,
                session_key=session_key,
                wecom=wecom,
                channel=channel,
            )
        )
        second_card = wecom.update_template_card.await_args_list[0].args[1]
        self.assertEqual(second_card["card_type"], "button_interaction")
        self.assertEqual(
            [button["key"] for button in second_card["button_list"]], ["o1", "o2"]
        )

        second_event = {
            "headers": {"req_id": "card-event-2"},
            "body": {
                "from": {"userid": "alice"},
                "chattype": "single",
                "event": {"task_id": first_card["task_id"], "event_key": "o1"},
            },
        }
        await interactions.handle_card_event(
            frame=second_event,
            session_key=session_key,
            wecom=wecom,
            channel=channel,
        )
        channel.answer_input.assert_awaited_once_with(
            "input-1",
            [
                {"question_id": "dimension", "option_id": "organization"},
                {"question_id": "period", "option_id": "month"},
            ],
        )

    async def test_expired_and_desktop_resolved_inputs_stop_intercepting_text(self):
        interactions = InteractionCoordinator()
        wecom = self._wecom()
        session_key = SessionStore.key(
            chat_type="single", chat_id="", external_user_id="alice"
        )
        channel = SimpleNamespace(answer_input=AsyncMock())
        await interactions.present(
            self._request(interaction_id="expired", deadline_at_ms=1),
            session_key=session_key,
            wecom=wecom,
            frame=self._frame("message-1", "start"),
            stream_id="stream-1",
        )
        reply = await interactions.handle_text(
            session_key=session_key,
            text="1",
            channel=channel,
        )
        self.assertIn("过期", reply)
        channel.answer_input.assert_not_awaited()
        self.assertEqual(await interactions.pending_count(), 0)

        await interactions.present(
            self._request(interaction_id="desktop-answered"),
            session_key=session_key,
            wecom=wecom,
            frame=self._frame("message-2", "start"),
            stream_id="stream-2",
        )
        self.assertTrue(
            await interactions.handle_resolved(
                {"interaction_id": "desktop-answered", "status": "answered"},
                wecom=wecom,
            )
        )
        self.assertEqual(await interactions.pending_count(), 0)
        self.assertIsNone(
            await interactions.handle_text(
                session_key=session_key,
                text="1",
                channel=channel,
            )
        )


class WorkerFileTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _media_frame(
        message_id="message-1",
        *,
        media_kind="file",
        chat_id="",
        chat_type="single",
    ):
        return {
            "headers": {"req_id": f"callback-{message_id}"},
            "body": {
                "msgid": message_id,
                "from": {"userid": "alice"},
                "chattype": chat_type,
                "chatid": chat_id,
                media_kind: {
                    "url": "https://files.example/download",
                    "aeskey": "aes-secret",
                },
            },
        }

    async def test_registers_text_file_and_image_callbacks(self):
        handlers = {}

        class FakeClient:
            def on(self, event_name):
                def register(handler):
                    handlers[event_name] = handler
                    return handler

                return register

        register_handlers(
            FakeClient(),
            SimpleNamespace(),
            _config(),
            DedupeStore(),
            SessionStore(),
            SessionSequencer(),
        )
        self.assertEqual(
            set(handlers),
            {
                "message.text",
                "message.file",
                "message.image",
                "event.template_card_event",
            },
        )
        self.assertFalse(
            asyncio.iscoroutinefunction(handlers["event.template_card_event"]),
            "card callbacks must return immediately and schedule their work",
        )

    async def test_inbound_file_is_downloaded_safely_and_forwarded(self):
        wecom = SimpleNamespace(
            reply_stream=AsyncMock(),
            download_file=AsyncMock(
                return_value=(b"a,b\n1,2\n", "..\\private\\report.csv")
            ),
        )
        channel = SimpleNamespace(
            submit=AsyncMock(
                return_value=SimpleNamespace(
                    status="completed",
                    text="已收到",
                    message="",
                    files=[],
                )
            )
        )

        await _handle_media(
            wecom,
            channel,
            DedupeStore(),
            SessionStore(id_factory=lambda: "session-1"),
            _config(),
            self._media_frame(),
            "file",
        )

        wecom.download_file.assert_awaited_once_with(
            "https://files.example/download", "aes-secret"
        )
        inbound = channel.submit.await_args.args[0]
        self.assertEqual(inbound.text, "")
        self.assertEqual(len(inbound.files), 1)
        self.assertEqual(inbound.files[0].file_name, "report.csv")
        self.assertEqual(inbound.files[0].mime_type, "text/csv")
        self.assertEqual(inbound.files[0].content, b"a,b\n1,2\n")

    async def test_oversized_inbound_file_is_rejected_before_gateway(self):
        wecom = SimpleNamespace(
            reply_stream=AsyncMock(),
            download_file=AsyncMock(return_value=(b"1234", "large.bin")),
        )
        channel = SimpleNamespace(submit=AsyncMock())
        with patch("connectors.wecom_aibot.worker.logger.warning"):
            await _handle_media(
                wecom,
                channel,
                DedupeStore(),
                SessionStore(),
                _config(max_file_bytes=3),
                self._media_frame(),
                "file",
            )

        channel.submit.assert_not_awaited()
        final_text = [
            call.args[2] for call in wecom.reply_stream.await_args_list if call.args[3]
        ][-1]
        self.assertIn("文件过大", final_text)

    async def test_transient_download_failure_can_retry_same_callback(self):
        wecom = SimpleNamespace(
            reply_stream=AsyncMock(),
            download_file=AsyncMock(
                side_effect=[
                    RuntimeError("temporary download failure"),
                    (b"retry succeeded", "answer.txt"),
                ]
            ),
        )
        channel = SimpleNamespace(
            submit=AsyncMock(
                return_value=SimpleNamespace(
                    status="completed",
                    text="已收到",
                    message="",
                    files=[],
                )
            )
        )
        dedupe = DedupeStore()
        frame = self._media_frame()

        with patch("connectors.wecom_aibot.worker.logger.warning"):
            await _handle_media(
                wecom,
                channel,
                dedupe,
                SessionStore(id_factory=lambda: "session-1"),
                _config(),
                frame,
                "file",
            )
            await _handle_media(
                wecom,
                channel,
                dedupe,
                SessionStore(id_factory=lambda: "session-1"),
                _config(),
                frame,
                "file",
            )

        self.assertEqual(wecom.download_file.await_count, 2)
        self.assertEqual(channel.submit.await_count, 1)

    async def test_inbound_image_without_filename_is_sniffed(self):
        png = b"\x89PNG\r\n\x1a\n" + b"payload"
        wecom = SimpleNamespace(download_file=AsyncMock(return_value=(png, None)))
        inbound = await _download_inbound_media(
            wecom,
            self._media_frame(media_kind="image"),
            "image",
            _config(),
        )
        self.assertEqual(inbound.file_name, "image.png")
        self.assertEqual(inbound.mime_type, "image/png")
        self.assertEqual(inbound.content, png)

    async def test_inbound_image_uses_content_mime_over_filename(self):
        png = b"\x89PNG\r\n\x1a\n" + b"payload"
        wecom = SimpleNamespace(
            download_file=AsyncMock(return_value=(png, "misleading.txt"))
        )
        inbound = await _download_inbound_media(
            wecom,
            self._media_frame(media_kind="image"),
            "image",
            _config(),
        )
        self.assertEqual(inbound.file_name, "misleading.txt")
        self.assertEqual(inbound.mime_type, "image/png")

    async def test_outbound_upload_uses_512k_chunks_and_protocol_checksum(self):
        calls = []

        async def reply(frame, body, command=None):
            calls.append((frame, body, command))
            if command == "aibot_upload_media_init":
                return {"body": {"errcode": 0, "upload_id": "upload-1"}}
            if command == "aibot_upload_media_finish":
                return {"body": {"errcode": 0, "media_id": "media-1"}}
            return {"body": {"errcode": 0}}

        client = SimpleNamespace(reply=AsyncMock(side_effect=reply))
        content = b"a" * (512 * 1024) + b"xyz"
        media_id = await _upload_wecom_file(
            client,
            ChannelResponseFile(
                file_name="report.bin",
                mime_type="application/octet-stream",
                content=content,
                size_bytes=len(content),
            ),
        )

        self.assertEqual(media_id, "media-1")
        init_body = calls[0][1]
        self.assertEqual(init_body["total_chunks"], 2)
        self.assertEqual(init_body["total_size"], len(content))
        self.assertEqual(init_body["md5"], hashlib.md5(content).hexdigest())
        chunks = [
            body for _frame, body, cmd in calls if cmd == "aibot_upload_media_chunk"
        ]
        self.assertEqual([chunk["chunk_index"] for chunk in chunks], [0, 1])
        self.assertEqual(
            b"".join(base64.b64decode(chunk["base64_data"]) for chunk in chunks),
            content,
        )
        self.assertTrue(
            all(call[0]["headers"]["req_id"] for call in calls),
            "upload stages must use synthetic request IDs",
        )

    async def test_upload_stage_retries_without_exposing_remote_error(self):
        attempts = 0

        async def reply(_frame, _body, command=None):
            nonlocal attempts
            if command == "aibot_upload_media_init":
                return {"body": {"errcode": 0, "upload_id": "upload-1"}}
            if command == "aibot_upload_media_chunk":
                attempts += 1
                if attempts < 3:
                    raise RuntimeError("private remote response")
                return {"body": {"errcode": 0}}
            if command == "aibot_upload_media_finish":
                return {"body": {"errcode": 0, "media_id": "media-1"}}
            return {"body": {"errcode": 0}}

        client = SimpleNamespace(reply=AsyncMock(side_effect=reply))
        with patch(
            "connectors.wecom_aibot.worker.asyncio.sleep", new=AsyncMock()
        ) as sleep_mock:
            result = await _upload_wecom_file(
                client,
                ChannelResponseFile(
                    file_name="answer.txt",
                    content=b"answer",
                    size_bytes=6,
                ),
            )
        self.assertEqual(result, "media-1")
        self.assertEqual(attempts, 3)
        self.assertEqual(
            [call.args[0] for call in sleep_mock.await_args_list], [0.5, 1.0]
        )

    async def test_upload_init_is_not_retried(self):
        client = SimpleNamespace(
            reply=AsyncMock(side_effect=RuntimeError("private remote response"))
        )
        with patch(
            "connectors.wecom_aibot.worker.asyncio.sleep", new=AsyncMock()
        ) as sleep_mock:
            with self.assertRaises(RuntimeError):
                await _upload_wecom_file(
                    client,
                    ChannelResponseFile(
                        file_name="answer.txt",
                        content=b"answer",
                        size_bytes=6,
                    ),
                )
        self.assertEqual(client.reply.await_count, 1)
        sleep_mock.assert_not_awaited()

    async def test_empty_file_declares_zero_chunks_but_sends_one_empty_chunk(self):
        calls = []

        async def reply(_frame, body, command=None):
            calls.append((body, command))
            if command == "aibot_upload_media_init":
                return {"body": {"errcode": 0, "upload_id": "upload-1"}}
            if command == "aibot_upload_media_finish":
                return {"body": {"errcode": 0, "media_id": "media-1"}}
            return {"body": {"errcode": 0}}

        await _upload_wecom_file(
            SimpleNamespace(reply=AsyncMock(side_effect=reply)),
            ChannelResponseFile(file_name="empty.txt", content=b"", size_bytes=0),
        )
        init = next(body for body, cmd in calls if cmd == "aibot_upload_media_init")
        chunks = [body for body, cmd in calls if cmd == "aibot_upload_media_chunk"]
        self.assertEqual(init["total_chunks"], 0)
        self.assertEqual(
            chunks,
            [{"upload_id": "upload-1", "chunk_index": 0, "base64_data": ""}],
        )

    async def test_outbound_file_uses_send_message_for_chat_id(self):
        async def reply(_frame, _body, command=None):
            if command == "aibot_upload_media_init":
                return {"body": {"errcode": 0, "upload_id": "upload-1"}}
            if command == "aibot_upload_media_finish":
                return {"body": {"errcode": 0, "media_id": "media-1"}}
            return {"body": {"errcode": 0}}

        client = SimpleNamespace(
            reply=AsyncMock(side_effect=reply),
            send_message=AsyncMock(return_value={"body": {"errcode": 0}}),
        )
        delivered, failed = await _send_response_files(
            client,
            self._media_frame(chat_id="room-1", chat_type="group"),
            "room-1",
            [
                ChannelResponseFile(
                    file_name="answer.txt",
                    mime_type="text/plain",
                    content=b"answer",
                    size_bytes=6,
                )
            ],
        )
        self.assertEqual((delivered, failed), (1, 0))
        client.send_message.assert_awaited_once_with(
            "room-1",
            {"msgtype": "file", "file": {"media_id": "media-1"}},
        )

    async def test_file_delivery_rechecks_claim_after_upload(self):
        async def reply(_frame, _body, command=None):
            if command == "aibot_upload_media_init":
                return {"body": {"errcode": 0, "upload_id": "upload-1"}}
            if command == "aibot_upload_media_finish":
                return {"body": {"errcode": 0, "media_id": "media-1"}}
            return {"body": {"errcode": 0}}

        client = SimpleNamespace(
            reply=AsyncMock(side_effect=reply),
            send_message=AsyncMock(return_value={"body": {"errcode": 0}}),
        )
        ownership = iter((True, False))

        with self.assertRaisesRegex(RuntimeError, "lease changed"):
            await _send_response_files(
                client,
                self._media_frame(chat_id="room-1", chat_type="group"),
                "room-1",
                [
                    ChannelResponseFile(
                        file_name="answer.txt",
                        content=b"answer",
                        size_bytes=6,
                    )
                ],
                renew_claim=lambda: next(ownership),
            )

        client.send_message.assert_not_awaited()

    async def test_final_reply_failure_does_not_resend_completed_files(self):
        wecom = SimpleNamespace(
            reply_stream=AsyncMock(
                side_effect=[None, RuntimeError("reply expired"), None]
            ),
            download_file=AsyncMock(return_value=(b"question", "question.txt")),
        )
        response_file = ChannelResponseFile(
            file_name="answer.txt",
            content=b"answer",
            size_bytes=6,
        )
        channel = SimpleNamespace(
            submit=AsyncMock(
                return_value=SimpleNamespace(
                    status="completed",
                    text="请查收文件。",
                    message="",
                    files=[response_file],
                )
            )
        )
        dedupe = DedupeStore()
        sessions = SessionStore(id_factory=lambda: "session-1")
        frame = self._media_frame()

        with (
            patch(
                "connectors.wecom_aibot.worker._send_response_files",
                new=AsyncMock(return_value=(1, 0)),
            ) as send_files,
            patch("connectors.wecom_aibot.worker.logger.warning"),
        ):
            await _handle_media(
                wecom,
                channel,
                dedupe,
                sessions,
                _config(),
                frame,
                "file",
            )
            await _handle_media(
                wecom,
                channel,
                dedupe,
                sessions,
                _config(),
                frame,
                "file",
            )

        self.assertEqual(channel.submit.await_count, 1)
        self.assertEqual(send_files.await_count, 1)
        self.assertEqual(wecom.download_file.await_count, 1)
        self.assertEqual(wecom.reply_stream.await_count, 3)

    async def test_outbound_file_uses_user_id_for_direct_chat(self):
        media_replies = []

        async def reply(_frame, body, command=None):
            if command == "aibot_upload_media_init":
                return {"body": {"errcode": 0, "upload_id": "upload-1"}}
            if command == "aibot_upload_media_finish":
                return {"body": {"errcode": 0, "media_id": "media-1"}}
            if command == "aibot_upload_media_chunk":
                return {"body": {"errcode": 0}}
            media_replies.append(body)
            return {"body": {"errcode": 0}}

        client = SimpleNamespace(
            reply=AsyncMock(side_effect=reply),
            send_message=AsyncMock(return_value={"body": {"errcode": 0}}),
        )
        delivered, failed = await _send_response_files(
            client,
            self._media_frame(),
            "alice",
            [
                ChannelResponseFile(
                    file_name="answer.txt",
                    content=b"answer",
                    size_bytes=6,
                )
            ],
        )
        self.assertEqual((delivered, failed), (1, 0))
        client.send_message.assert_awaited_once_with(
            "alice",
            {"msgtype": "file", "file": {"media_id": "media-1"}},
        )
        self.assertEqual(media_replies, [])

    async def test_file_reply_fallback_requires_a_safe_callback_request_id(self):
        client = SimpleNamespace(
            reply=AsyncMock(return_value={"body": {"errcode": 0}}),
            send_message=AsyncMock(),
        )
        frame = self._media_frame()
        await _deliver_wecom_file(client, frame, "", "media-1")
        client.reply.assert_awaited_once_with(
            frame,
            {"msgtype": "file", "file": {"media_id": "media-1"}},
        )
        with self.assertRaises(RuntimeError):
            await _deliver_wecom_file(
                client,
                {"headers": {"req_id": "unsafe request id"}},
                "",
                "media-2",
            )


class ChannelClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_progress_frames_dispatch_in_order_and_never_touch_final_text(self):
        client = ChannelClient(_config())
        received = []
        response = ChannelResponse(
            request_id="request-1", progress_handler=lambda update: received.append(update.text)
        )
        client._responses["request-1"] = response
        for text in ("一", "二"):
            await client._handle_frame(
                ChannelServerFrame(
                    request_id="request-1",
                    progress=ChannelProgress(kind="thinking", text=text, round=1),
                )
            )
        await client._handle_frame(
            ChannelServerFrame(request_id="request-1", delta=ChannelDelta(text="答案"))
        )
        self.assertEqual(received, ["一", "二"])
        self.assertEqual(response.text, "答案")

        # A missing handler and a failing handler are both harmless.
        client._responses["request-2"] = ChannelResponse(request_id="request-2")
        await client._handle_frame(
            ChannelServerFrame(request_id="request-2", progress=ChannelProgress(kind="text", text="x"))
        )
        failing = ChannelResponse(
            request_id="request-3",
            progress_handler=lambda _update: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        client._responses["request-3"] = failing
        with patch("connectors.wecom_aibot.channel_client.logger.exception"):
            await client._handle_frame(
                ChannelServerFrame(request_id="request-3", progress=ChannelProgress(kind="text", text="x"))
            )
        self.assertFalse(failing.done.is_set())

    def test_progress_opt_in_follows_configuration(self):
        self.assertTrue(ChannelClient(_config()).progress_enabled)
        self.assertFalse(ChannelClient(_config(show_progress=False)).progress_enabled)

    async def test_file_frame_is_accumulated_and_size_checked(self):
        client = ChannelClient(_config(max_file_bytes=8))
        response = ChannelResponse(request_id="request-1")
        client._responses["request-1"] = response
        await client._handle_frame(
            ChannelServerFrame(
                request_id="request-1",
                file=ChannelFile(
                    file_name="answer.txt",
                    mime_type="text/plain",
                    size_bytes=6,
                    content=b"answer",
                ),
            )
        )
        await client._handle_frame(
            ChannelServerFrame(
                request_id="request-1",
                file=ChannelFile(
                    file_name="bad.txt",
                    size_bytes=5,
                    content=b"bad",
                ),
            )
        )
        self.assertEqual(response.files[0].content, b"answer")
        self.assertEqual(response.files[0].error_code, "")
        self.assertEqual(response.files[1].content, b"")
        self.assertEqual(response.files[1].error_code, "invalid_file_size")

    async def test_pending_submit_without_accepted_is_released_as_uncertain(self):
        client = ChannelClient(_config())
        client._ws = _FrameSocket()
        client._closed = False
        inbound = ChannelInboundMessage(
            external_message_id="message-1",
            external_user_id="alice",
            chat_type="single",
            text="hello",
        )
        pending = asyncio.create_task(client.submit(inbound, timeout=0.05))
        for _ in range(20):
            if client._responses:
                break
            await asyncio.sleep(0)
        await client._mark_failed(ConnectionError("reader stopped"))
        with self.assertRaises(ChannelSubmitInterrupted) as raised:
            await asyncio.wait_for(pending, timeout=1)
        self.assertTrue(raised.exception.response.canonical_started)

    async def test_lost_accepted_frame_releases_without_waiting_for_reconnect(self):
        client = ChannelClient(_config())
        first_socket = _FrameSocket()
        client._ws = first_socket
        client._closed = False
        inbound = ChannelInboundMessage(
            external_message_id="message-1",
            external_user_id="alice",
            chat_type="single",
            text="hello",
            channel_session_id="session-1",
        )
        pending = asyncio.create_task(client.submit(inbound, timeout=1))
        for _ in range(20):
            if first_socket.sent:
                break
            await asyncio.sleep(0)
        await client._mark_failed(ConnectionError("accepted frame was lost"))
        with self.assertRaises(ChannelSubmitInterrupted) as raised:
            await asyncio.wait_for(pending, timeout=1)
        self.assertTrue(raised.exception.response.canonical_started)

    async def test_accepted_submit_reconnects_and_queries_canonical_result(self):
        client = ChannelClient(_config())
        first_socket = _FrameSocket()
        client._ws = first_socket
        client._closed = False
        inbound = ChannelInboundMessage(
            external_message_id="message-1",
            external_user_id="alice",
            chat_type="single",
            text="hello",
            channel_session_id="session-1",
        )
        pending = asyncio.create_task(client.submit(inbound, timeout=1))
        for _ in range(20):
            if first_socket.sent:
                break
            await asyncio.sleep(0)
        first_request = ChannelClientFrame.FromString(first_socket.sent[0])
        await client._handle_frame(
            ChannelServerFrame(
                request_id=first_request.request_id,
                accepted=ChannelAccepted(
                    external_message_id="message-1",
                    run_id="run-1",
                    conversation_id="conversation-1",
                    deduped=False,
                ),
            )
        )
        await client._mark_failed(ConnectionError("reader stopped"))

        second_socket = _FrameSocket()
        client._ws = second_socket
        client._connection_error = None
        client._closed = False
        client._connected.set()
        for _ in range(20):
            if second_socket.sent:
                break
            await asyncio.sleep(0)
        second_request = ChannelClientFrame.FromString(second_socket.sent[0])
        await client._handle_frame(
            ChannelServerFrame(
                request_id=second_request.request_id,
                accepted=ChannelAccepted(
                    external_message_id="message-1",
                    run_id="run-1",
                    conversation_id="conversation-1",
                    deduped=True,
                ),
            )
        )
        await client._handle_frame(
            ChannelServerFrame(
                request_id=second_request.request_id,
                delta=ChannelDelta(run_id="run-1", text="canonical answer"),
            )
        )
        await client._handle_frame(
            ChannelServerFrame(
                request_id=second_request.request_id,
                final=ChannelFinal(run_id="run-1", status="completed"),
            )
        )

        response = await pending
        self.assertTrue(response.deduped)
        self.assertTrue(response.canonical_started)
        self.assertEqual(response.text, "canonical answer")
        self.assertEqual(
            first_request.inbound.SerializeToString(),
            second_request.inbound.SerializeToString(),
        )

    async def test_handshake_rejection_is_immediate(self):
        rejection = ChannelServerFrame(
            request_id="hello",
            hello=ServerHello(ok=False, message="unauthorized"),
        ).SerializeToString()
        socket = _FrameSocket([rejection])

        async def connect(_url, **_kwargs):
            return socket

        client = ChannelClient(_config())
        with patch(
            "connectors.wecom_aibot.channel_client.websockets.connect",
            new=AsyncMock(side_effect=connect),
        ):
            with self.assertRaises(RuntimeError) as raised:
                await asyncio.wait_for(client.connect(), timeout=1)
        self.assertIn("unauthorized", str(raised.exception))
        self.assertTrue(socket.closed)


class ConnectorControlTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _line(request_id="request-1", **overrides):
        request = {
            "v": 1,
            "type": "send_markdown",
            "requestId": request_id,
            "chatId": "alice",
            "content": "hello **world**",
        }
        request.update(overrides)
        return json.dumps(request) + "\n"

    @staticmethod
    def _result(print_mock):
        output = print_mock.call_args.args[0]
        if not output.startswith(CONTROL_RESULT_MARKER):
            raise AssertionError(f"unexpected control output: {output!r}")
        return output, json.loads(output[len(CONTROL_RESULT_MARKER) :])

    async def test_send_markdown_uses_authenticated_singleton_and_redacted_result(self):
        authenticated = asyncio.Event()
        authenticated.set()
        client = SimpleNamespace(send_message=AsyncMock(return_value={"errcode": 0}))

        with patch("builtins.print") as print_mock:
            await _handle_control_line(
                client,
                authenticated,
                self._line(chatId=" alice "),
                max_text_bytes=1024,
            )

        client.send_message.assert_awaited_once_with(
            "alice",
            {
                "msgtype": "markdown",
                "markdown": {"content": "hello **world**"},
            },
        )
        output, result = self._result(print_mock)
        self.assertEqual(
            result,
            {"requestId": "request-1", "ok": True, "error": ""},
        )
        self.assertEqual(set(result), {"requestId", "ok", "error"})
        self.assertNotIn("alice", output)
        self.assertNotIn("hello", output)

    async def test_send_failure_does_not_expose_sdk_error_or_message(self):
        authenticated = asyncio.Event()
        authenticated.set()
        client = SimpleNamespace(
            send_message=AsyncMock(
                side_effect=RuntimeError("secret-credential and private-message")
            )
        )

        with (
            patch("builtins.print") as print_mock,
            patch("connectors.wecom_aibot.worker.logger.warning") as warning_mock,
        ):
            await _handle_control_line(
                client,
                authenticated,
                self._line(content="private-message"),
                max_text_bytes=1024,
            )

        output, result = self._result(print_mock)
        self.assertEqual(
            result,
            {"requestId": "request-1", "ok": False, "error": "send_failed"},
        )
        self.assertNotIn("private-message", output)
        self.assertNotIn("secret-credential", output)
        warning_mock.assert_called_once_with("WeCom proactive message failed")

    async def test_nonzero_ack_is_reported_as_send_failure(self):
        authenticated = asyncio.Event()
        authenticated.set()
        client = SimpleNamespace(
            send_message=AsyncMock(
                return_value={"errcode": 40013, "errmsg": "private remote detail"}
            )
        )

        with (
            patch("builtins.print") as print_mock,
            patch("connectors.wecom_aibot.worker.logger.warning"),
        ):
            await _handle_control_line(
                client,
                authenticated,
                self._line(),
                max_text_bytes=1024,
            )

        output, result = self._result(print_mock)
        self.assertEqual(result["error"], "send_failed")
        self.assertNotIn("private remote detail", output)

    async def test_invalid_and_unauthenticated_requests_are_rejected_before_send(self):
        cases = (
            ("not-json", "invalid_json", ""),
            (json.dumps([]), "invalid_request", ""),
            (self._line(request_id="bad request"), "invalid_request_id", ""),
            (self._line(v=2), "unsupported_version", "request-1"),
            (self._line(type="send_text"), "unsupported_type", "request-1"),
            (self._line(chatId=" \n "), "invalid_chat_id", "request-1"),
            (self._line(content="\u00e9\u00e9"), "invalid_content", "request-1"),
        )
        authenticated = asyncio.Event()
        client = SimpleNamespace(send_message=AsyncMock())
        for line, expected_error, expected_request_id in cases:
            with (
                self.subTest(error=expected_error),
                patch("builtins.print") as print_mock,
            ):
                await _handle_control_line(
                    client,
                    authenticated,
                    line,
                    max_text_bytes=3,
                )
                _output, result = self._result(print_mock)
                self.assertEqual(result["requestId"], expected_request_id)
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"], expected_error)
                self.assertEqual(set(result), {"requestId", "ok", "error"})

        with patch("builtins.print") as print_mock:
            await _handle_control_line(
                client,
                authenticated,
                self._line(content="ok"),
                max_text_bytes=3,
            )
        _output, result = self._result(print_mock)
        self.assertEqual(result["error"], "not_authenticated")
        client.send_message.assert_not_awaited()

    async def test_disconnected_event_clears_outbound_authentication(self):
        handlers = {}

        class FakeWecom:
            def on(self, event):
                return lambda handler: handlers.setdefault(event, handler)

        state = _WecomConnectionState()
        _register_connection_handlers(FakeWecom(), state)
        handlers["authenticated"]()
        self.assertTrue(state.authenticated.is_set())
        with patch("connectors.wecom_aibot.worker.logger.warning"):
            handlers["disconnected"]("connection lost")
        self.assertFalse(state.authenticated.is_set())
        self.assertFalse(state.startup_failed.is_set())

        handlers["reconnecting"](1)
        handlers["connected"]()
        handlers["authenticated"]()
        self.assertTrue(state.authenticated.is_set())
        self.assertTrue(state.ever_authenticated)

    async def test_jsonl_server_correlates_concurrent_requests_and_finishes_at_eof(
        self,
    ):
        authenticated = asyncio.Event()
        authenticated.set()
        both_started = asyncio.Event()
        release = asyncio.Event()
        started = []

        async def send_message(chat_id, body):
            started.append((chat_id, body))
            if len(started) == 2:
                both_started.set()
            await release.wait()
            return {"errcode": 0}

        client = SimpleNamespace(send_message=AsyncMock(side_effect=send_message))
        stream = io.StringIO(self._line("request-1") + self._line("request-2"))
        with patch("builtins.print") as print_mock:
            task = asyncio.create_task(
                _serve_control_requests(
                    client,
                    authenticated,
                    max_text_bytes=1024,
                    stream=stream,
                )
            )
            await asyncio.wait_for(both_started.wait(), timeout=1)
            release.set()
            await asyncio.wait_for(task, timeout=1)

        results = []
        for call in print_mock.call_args_list:
            output = call.args[0]
            self.assertTrue(output.startswith(CONTROL_RESULT_MARKER))
            results.append(json.loads(output[len(CONTROL_RESULT_MARKER) :]))
        self.assertEqual(
            {result["requestId"] for result in results},
            {"request-1", "request-2"},
        )
        self.assertTrue(all(result["ok"] for result in results))
        self.assertEqual(client.send_message.await_count, 2)

    async def test_binary_stdin_is_decoded_as_utf8(self):
        authenticated = asyncio.Event()
        authenticated.set()
        client = SimpleNamespace(send_message=AsyncMock(return_value={"errcode": 0}))
        request = {
            "v": 1,
            "type": "send_markdown",
            "requestId": "request-utf8",
            "chatId": "alice",
            "content": "\u4e2d\u6587 Markdown",
        }
        stream = io.BytesIO(
            (json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8")
        )

        with patch("builtins.print"):
            await _serve_control_requests(
                client,
                authenticated,
                max_text_bytes=1024,
                stream=stream,
            )

        client.send_message.assert_awaited_once_with(
            "alice",
            {
                "msgtype": "markdown",
                "markdown": {"content": "\u4e2d\u6587 Markdown"},
            },
        )

    async def test_real_stdin_pipe_uses_unbuffered_file_descriptor_reads(self):
        authenticated = asyncio.Event()
        authenticated.set()
        client = SimpleNamespace(send_message=AsyncMock(return_value={"errcode": 0}))
        stream = SimpleNamespace(
            fileno=lambda: 123,
            readline=lambda: self.fail("buffered readline must not be used"),
        )
        payload = self._line(content="pipe message").encode("utf-8")

        with (
            patch(
                "connectors.wecom_aibot.worker.os.read",
                side_effect=(payload, b""),
            ) as read_mock,
            patch("builtins.print"),
        ):
            await _serve_control_requests(
                client,
                authenticated,
                max_text_bytes=1024,
                stream=stream,
            )

        self.assertEqual(read_mock.call_count, 2)
        client.send_message.assert_awaited_once_with(
            "alice",
            {
                "msgtype": "markdown",
                "markdown": {"content": "pipe message"},
            },
        )


class SdkLoggerTests(unittest.TestCase):
    def test_sdk_logger_never_forwards_dynamic_messages_or_arguments(self):
        sdk_logger = _RedactingSdkLogger()
        with (
            patch("connectors.wecom_aibot.worker.logger.debug") as debug_mock,
            patch("connectors.wecom_aibot.worker.logger.info") as info_mock,
            patch("connectors.wecom_aibot.worker.logger.warning") as warning_mock,
            patch("connectors.wecom_aibot.worker.logger.error") as error_mock,
        ):
            sdk_logger.debug("private debug %s", "secret")
            sdk_logger.info("private info %s", "secret")
            sdk_logger.warn("private warning %s", "secret")
            sdk_logger.error("private errmsg %s", "secret")

        debug_mock.assert_called_once_with("WeCom SDK debug event")
        info_mock.assert_called_once_with("WeCom SDK status event")
        warning_mock.assert_called_once_with("WeCom SDK warning")
        error_mock.assert_called_once_with("WeCom SDK error")
        all_calls = repr(
            debug_mock.call_args_list
            + info_mock.call_args_list
            + warning_mock.call_args_list
            + error_mock.call_args_list
        )
        self.assertNotIn("private", all_calls)
        self.assertNotIn("secret", all_calls)


class ConnectorReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def test_initial_authentication_wait_times_out(self):
        with self.assertRaisesRegex(TimeoutError, "authentication timed out"):
            await _wait_for_initial_authentication(
                _WecomConnectionState(),
                timeout=0.01,
            )

    async def test_ready_marker_survives_transient_disconnect_and_reauthentication(
        self,
    ):
        events = []
        wecom_instances = []

        class FakeChannel:
            def __init__(self, _config):
                self.closed = asyncio.Event()

            async def connect(self):
                events.append("gateway")

            async def wait_closed(self):
                await self.closed.wait()

            async def close(self):
                self.closed.set()

        class FakeWecom:
            def __init__(self, _options):
                self.options = _options
                self.handlers = {}
                wecom_instances.append(self)

            def on(self, event):
                return lambda handler: self.handlers.setdefault(event, handler)

            def emit(self, event, *args):
                self.handlers[event](*args)

            async def connect(self):
                events.append("wecom")
                self.emit("connected")

            def disconnect(self):
                events.append("disconnected")

        with (
            patch("connectors.wecom_aibot.worker.ChannelClient", FakeChannel),
            patch("connectors.wecom_aibot.worker.WSClient", FakeWecom),
            patch("builtins.print") as print_mock,
        ):
            task = asyncio.create_task(run(_config()))
            for _ in range(100):
                if "wecom" in events:
                    break
                await asyncio.sleep(0)

            self.assertEqual(events[:2], ["gateway", "wecom"])
            print_mock.assert_not_called()

            wecom_instances[0].emit("authenticated")
            for _ in range(100):
                if print_mock.call_args_list:
                    break
                await asyncio.sleep(0)
            print_mock.assert_called_once_with(CONNECTOR_READY_MARKER, flush=True)
            self.assertIsInstance(
                wecom_instances[0].options.logger, _RedactingSdkLogger
            )

            with patch("connectors.wecom_aibot.worker.logger.warning"):
                wecom_instances[0].emit("disconnected", "private remote reason")
            await asyncio.sleep(0)
            self.assertFalse(task.done())

            wecom_instances[0].emit("reconnecting", 1)
            wecom_instances[0].emit("connected")
            wecom_instances[0].emit("authenticated")
            await asyncio.sleep(0)
            self.assertFalse(task.done())

            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertIn("disconnected", events)
            print_mock.assert_called_once_with(CONNECTOR_READY_MARKER, flush=True)

    async def test_connection_error_after_ready_does_not_exit_or_repeat_marker(self):
        wecom_instances = []

        class FakeChannel:
            def __init__(self, _config):
                self.closed = asyncio.Event()

            async def connect(self):
                return None

            async def wait_closed(self):
                await self.closed.wait()

            async def close(self):
                self.closed.set()

        class FakeWecom:
            def __init__(self, _options):
                self.handlers = {}
                self.connected = False
                self.connect_count = 0
                self.disconnect_count = 0
                wecom_instances.append(self)

            def on(self, event):
                return lambda handler: self.handlers.setdefault(event, handler)

            def emit(self, event, *args):
                self.handlers[event](*args)

            async def connect(self):
                self.connect_count += 1
                self.connected = True
                self.emit("connected")
                if self.connect_count > 1:
                    self.emit("authenticated")

            def disconnect(self):
                self.disconnect_count += 1
                self.connected = False

        with (
            patch("connectors.wecom_aibot.worker.ChannelClient", FakeChannel),
            patch("connectors.wecom_aibot.worker.WSClient", FakeWecom),
            patch("builtins.print") as print_mock,
        ):
            task = asyncio.create_task(run(_config()))
            for _ in range(100):
                if wecom_instances and wecom_instances[0].connected:
                    break
                await asyncio.sleep(0)
            wecom_instances[0].emit("authenticated")
            for _ in range(100):
                if print_mock.call_args_list:
                    break
                await asyncio.sleep(0)
            print_mock.assert_called_once_with(CONNECTOR_READY_MARKER, flush=True)

            with patch("connectors.wecom_aibot.worker.logger.warning"):
                wecom_instances[0].emit("error", RuntimeError("private remote error"))
            for _ in range(100):
                if wecom_instances[0].connect_count > 1:
                    break
                await asyncio.sleep(0)
            self.assertFalse(task.done())
            self.assertEqual(wecom_instances[0].connect_count, 2)
            self.assertEqual(wecom_instances[0].disconnect_count, 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        print_mock.assert_called_once_with(CONNECTOR_READY_MARKER, flush=True)

    async def test_authentication_error_exits_without_ready_marker(self):
        class FakeChannel:
            def __init__(self, _config):
                self.closed = asyncio.Event()

            async def connect(self):
                return None

            async def wait_closed(self):
                await self.closed.wait()

            async def close(self):
                self.closed.set()

        class FakeWecom:
            def __init__(self, _options):
                self.handlers = {}

            def on(self, event):
                return lambda handler: self.handlers.setdefault(event, handler)

            async def connect(self):
                self.handlers["connected"]()
                self.handlers["error"](RuntimeError("credential details"))

            def disconnect(self):
                return None

        with (
            patch("connectors.wecom_aibot.worker.ChannelClient", FakeChannel),
            patch("connectors.wecom_aibot.worker.WSClient", FakeWecom),
            patch("connectors.wecom_aibot.worker.logger.warning"),
            patch("builtins.print") as print_mock,
        ):
            with self.assertRaisesRegex(RuntimeError, "authentication failed"):
                await asyncio.wait_for(run(_config()), timeout=1)
        print_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
