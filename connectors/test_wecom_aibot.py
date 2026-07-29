import asyncio
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

from connectors.wecom_aibot.channel_client import ChannelClient, make_inbound
from connectors.wecom_aibot.commands import SessionSequencer, SessionStore, parse_command
from connectors.wecom_aibot.config import ConnectorConfig, _channel_url, load_config
from connectors.wecom_aibot.dedupe import DedupeKey, DedupeStore
from connectors.wecom_aibot.protocol import (
    CHANNEL_ROLE,
    ChannelClientFrame,
    ChannelInboundMessage,
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
    _external_message_id,
    _handle_text,
    _handle_control_line,
    _register_connection_handlers,
    _routing,
    _serve_control_requests,
    _text,
    _wait_for_initial_authentication,
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
            _routing({"chatid": "ignored", "from": {"userid": "alice"}, "chattype": "1"}),
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
            return store.get(chat_type="group", chat_id="room-1", external_user_id="alice")

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
        store.complete(
            session_key,
            "message-1",
            text="answer",
            status="completed",
        )
        claimed, existing = store.claim(session_key, "message-1")
        self.assertFalse(claimed)
        self.assertEqual(existing.text, "answer")
        store._items[dedupe_key] = (time.monotonic() - 1, existing)
        claimed, existing = store.claim(session_key, "message-1")
        self.assertTrue(claimed)
        self.assertIsNone(existing)

    def test_same_message_id_is_isolated_by_user_and_chat(self):
        store = DedupeStore()
        alice = SessionStore.key(
            chat_type="single", chat_id="", external_user_id="alice"
        )
        bob = SessionStore.key(
            chat_type="single", chat_id="", external_user_id="bob"
        )
        alice_group = SessionStore.key(
            chat_type="group", chat_id="room-1", external_user_id="alice"
        )

        self.assertTrue(store.claim(alice, "message-1")[0])
        self.assertTrue(store.claim(bob, "message-1")[0])
        self.assertTrue(store.claim(alice_group, "message-1")[0])
        self.assertFalse(store.claim(alice, "message-1")[0])


class ConfigTests(unittest.TestCase):
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
                    ("default", 0, "bot-1", "tenant-1", "wecom-desktop", 0, "secret", "token"),
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
        frame = ChannelServerFrame(local_error=ErrorResponse(code=17, message="bad request"))
        decoded = ChannelServerFrame.FromString(frame.SerializeToString())
        self.assertEqual(decoded.local_error.DESCRIPTOR.full_name, "liveagent.gateway.v1.ErrorResponse")
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
        self.assertEqual(decoded.DESCRIPTOR.fields_by_name["channel_session_id"].number, 8)


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
            call.args[2]
            for call in wecom.reply_stream.await_args_list
            if call.args[3]
        ]
        self.assertEqual(len(final_replies), 2)
        self.assertNotIn("(empty response)", final_replies)

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
            any(call.args[0] is followup_frame and call.args[3] is False for call in wecom.reply_stream.await_args_list),
            "queued callbacks must receive a placeholder before waiting",
        )
        release_new.set()
        await asyncio.gather(new_task, followup_task)

        self.assertEqual([inbound.command for inbound in submitted], ["new", ""])
        self.assertEqual(submitted[0].channel_session_id, "session-2")
        self.assertEqual(submitted[1].channel_session_id, "session-2")


class ChannelClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_pending_submit_fails_when_reader_disconnects(self):
        client = ChannelClient(_config())
        client._ws = _FrameSocket()
        client._closed = False
        inbound = ChannelInboundMessage(
            external_message_id="message-1",
            external_user_id="alice",
            chat_type="single",
            text="hello",
        )
        pending = asyncio.create_task(client.submit(inbound, timeout=60))
        for _ in range(20):
            if client._responses:
                break
            await asyncio.sleep(0)
        await client._mark_failed(ConnectionError("reader stopped"))
        with self.assertRaises(ConnectionError):
            await asyncio.wait_for(pending, timeout=1)

    async def test_handshake_rejection_is_immediate(self):
        rejection = ChannelServerFrame(
            request_id="hello",
            hello=ServerHello(ok=False, message="unauthorized"),
        ).SerializeToString()
        socket = _FrameSocket([rejection])

        async def connect(_url, **_kwargs):
            return socket

        client = ChannelClient(_config())
        with patch("connectors.wecom_aibot.channel_client.websockets.connect", new=AsyncMock(side_effect=connect)):
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
            with self.subTest(error=expected_error), patch("builtins.print") as print_mock:
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

    async def test_jsonl_server_correlates_concurrent_requests_and_finishes_at_eof(self):
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
        stream = io.BytesIO((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))

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

    async def test_ready_marker_waits_for_gateway_and_wecom_authentication(self):
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
            self.assertIsInstance(wecom_instances[0].options.logger, _RedactingSdkLogger)

            with patch("connectors.wecom_aibot.worker.logger.warning"):
                wecom_instances[0].emit("disconnected", "private remote reason")
            with self.assertRaisesRegex(RuntimeError, "connection lost"):
                await task
            self.assertIn("disconnected", events)
            print_mock.assert_called_once_with(CONNECTOR_READY_MARKER, flush=True)

    async def test_connection_error_after_ready_exits_without_second_marker(self):
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
                wecom_instances.append(self)

            def on(self, event):
                return lambda handler: self.handlers.setdefault(event, handler)

            def emit(self, event, *args):
                self.handlers[event](*args)

            async def connect(self):
                self.connected = True
                self.emit("connected")

            def disconnect(self):
                return None

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
            with self.assertRaisesRegex(RuntimeError, "connection lost"):
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
