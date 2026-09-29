"""Exercise interactive cards through the installed WeCom SDK without a network."""

import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from connectors.wecom_aibot.commands import SessionSequencer, SessionStore
from connectors.wecom_aibot.config import ConnectorConfig
from connectors.wecom_aibot.dedupe import DedupeStore
from connectors.wecom_aibot.interactions import InteractionCoordinator
from connectors.wecom_aibot.worker import register_handlers

try:
    from aibot import WSClient, WSClientOptions
except ModuleNotFoundError as exc:
    if exc.name != "aibot":
        raise
    WSClient = None
    WSClientOptions = None


def _request(interaction_id="input-1", *, multiple=False):
    questions = [
        {
            "id": "metric",
            "header": "预算分析",
            "prompt": "您想测试哪个指标？",
            "options": [
                {"id": "orders", "label": "预测订单完成率", "recommended": True},
                {"id": "revenue", "label": "预测收入达成率"},
                {"id": "payments", "label": "预测回款达成率"},
            ],
        }
    ]
    if multiple:
        questions.append(
            {
                "id": "dimension",
                "header": "分析维度",
                "prompt": "以什么维度展示？",
                "options": [
                    {"id": "department", "label": "按部门汇总"},
                    {"id": "customer", "label": "按客户透视"},
                ],
            }
        )
    return {"interaction_id": interaction_id, "questions": questions}


def _message_frame(*, chat_type="single", chat_id="single-chat-id"):
    return {
        "cmd": "aibot_msg_callback",
        "headers": {"req_id": "original-message-request"},
        "body": {
            "msgtype": "text",
            "msgid": "original-message",
            "chattype": chat_type,
            "chatid": chat_id,
            "from": {"userid": "alice"},
            "text": {"content": "再给我几个选项测试下"},
        },
    }


@unittest.skipIf(WSClient is None, "install the WeCom connector SDK requirements")
class WeComCardSdkProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = WSClient(WSClientOptions(bot_id="test-bot", secret="test-secret"))
        self.sent = []
        self.sent_changed = asyncio.Event()

        async def capture_reply(req_id, body, cmd):
            # The real SDK builds the body, routing and command. Only its final
            # transport call is replaced; round-trip JSON also catches payloads
            # that would not be serializable on the wire.
            self.sent.append(
                json.loads(json.dumps({"cmd": cmd, "headers": {"req_id": req_id}, "body": body}))
            )
            self.sent_changed.set()
            return {"headers": {"req_id": req_id}, "errcode": 0}

        transport = patch.object(
            self.client._ws_manager,
            "send_reply",
            new=AsyncMock(side_effect=capture_reply),
        )
        transport.start()
        self.addCleanup(transport.stop)
        self.interactions = InteractionCoordinator()

    async def _wait_for_messages(self, count):
        async def wait():
            while len(self.sent) < count:
                self.sent_changed.clear()
                await self.sent_changed.wait()

        await asyncio.wait_for(wait(), timeout=1)

    async def _assert_standalone_routing(self, *, chat_type, chat_id, expected_target):
        frame = _message_frame(chat_type=chat_type, chat_id=chat_id)
        session_key = SessionStore.key(
            chat_type=chat_type, chat_id=chat_id, external_user_id="alice"
        )
        await self.client.reply_stream(frame, "original-stream", "正在处理", False)
        self.assertTrue(
            await self.interactions.present(
                _request(),
                session_key=session_key,
                wecom=self.client,
                frame=frame,
                stream_id="original-stream",
            )
        )
        await self.client.reply_stream(frame, "original-stream", "处理完成", True)

        self.assertEqual(
            [message["body"]["msgtype"] for message in self.sent],
            ["stream", "template_card", "stream", "stream"],
        )
        card_message = self.sent[1]
        self.assertEqual(card_message["cmd"], "aibot_send_msg")
        self.assertEqual(card_message["body"]["chatid"], expected_target)
        self.assertNotEqual(card_message["headers"]["req_id"], frame["headers"]["req_id"])
        self.assertNotIn("stream", card_message["body"])
        card = card_message["body"]["template_card"]
        self.assertEqual(card["card_type"], "button_interaction")
        self.assertEqual([button["key"] for button in card["button_list"]], ["q1_o1", "q1_o2", "q1_o3"])
        for message in (self.sent[0], self.sent[2], self.sent[3]):
            self.assertEqual(message["cmd"], "aibot_respond_msg")
            self.assertEqual(message["headers"], frame["headers"])
            self.assertEqual(message["body"]["stream"]["id"], "original-stream")
            self.assertNotIn("template_card", message["body"])
        self.assertFalse(self.sent[2]["body"]["stream"]["finish"])
        self.assertTrue(self.sent[3]["body"]["stream"]["finish"])

    async def test_single_chat_card_uses_user_id_and_preserves_existing_stream(self):
        await self._assert_standalone_routing(
            chat_type="single", chat_id="single-chat-id", expected_target="alice"
        )

    async def test_group_card_uses_group_chat_id_and_preserves_existing_stream(self):
        await self._assert_standalone_routing(
            chat_type="group", chat_id="group-1", expected_target="group-1"
        )

    async def test_successive_interactions_each_get_an_independent_card_message(self):
        frame = _message_frame()
        session_key = SessionStore.key(
            chat_type="single", chat_id="single-chat-id", external_user_id="alice"
        )
        await self.client.reply_stream(frame, "original-stream", "正在处理", False)
        for interaction_id in ("input-1", "input-2"):
            self.assertTrue(
                await self.interactions.present(
                    _request(interaction_id),
                    session_key=session_key,
                    wecom=self.client,
                    frame=frame,
                    stream_id="original-stream",
                )
            )
        cards = [message for message in self.sent if message["body"]["msgtype"] == "template_card"]
        self.assertEqual(len(cards), 2)
        self.assertTrue(all(message["cmd"] == "aibot_send_msg" for message in cards))
        self.assertEqual(len({message["headers"]["req_id"] for message in cards}), 2)
        self.assertEqual(len({message["body"]["template_card"]["task_id"] for message in cards}), 2)
        self.assertTrue(all(message["body"]["msgtype"] != "stream_with_template_card" for message in self.sent))

    async def test_sdk_dispatches_clicks_updates_card_and_submits_complete_answers(self):
        answered = asyncio.Event()

        async def answer_input(interaction_id, selections):
            answered.set()
            return {"accepted": True, "status": "accepted"}

        channel = SimpleNamespace(answer_input=AsyncMock(side_effect=answer_input))
        sessions = SessionStore()
        register_handlers(
            self.client,
            channel,
            ConnectorConfig(
                bot_id="test-bot",
                secret="test-secret",
                gateway_url="ws://127.0.0.1:1/ws/v2/channel",
                channel_token="test-token",
                tenant_id="test-tenant",
                connector_id="wecom-desktop",
            ),
            DedupeStore(),
            sessions,
            SessionSequencer(),
            self.interactions,
        )
        await self.interactions.present(
            _request(multiple=True),
            session_key=sessions.key(
                chat_type="single", chat_id="single-chat-id", external_user_id="alice"
            ),
            wecom=self.client,
            frame=_message_frame(),
            stream_id="original-stream",
        )
        first_card = self.sent[0]["body"]["template_card"]

        def dispatch_click(req_id, event_key):
            # Feed the same entry point used by the SDK WebSocket reader,
            # including its required command/msgtype/eventtype envelope.
            self.client._ws_manager.on_message(
                {
                    "cmd": "aibot_event_callback",
                    "headers": {"req_id": req_id},
                    "body": {
                        "msgtype": "event",
                        "chattype": "single",
                        "chatid": "single-chat-id",
                        "from": {"userid": "alice"},
                        "event": {
                            "eventtype": "template_card_event",
                            "task_id": first_card["task_id"],
                            "event_key": event_key,
                        },
                    },
                }
            )

        dispatch_click("first-click", "q1_o2")
        await self._wait_for_messages(3)
        channel.answer_input.assert_not_awaited()
        update = self.sent[2]
        self.assertEqual(update["cmd"], "aibot_respond_update_msg")
        self.assertEqual(update["headers"]["req_id"], "first-click")
        self.assertEqual(update["body"]["response_type"], "update_template_card")
        self.assertEqual(update["body"]["template_card"]["task_id"], first_card["task_id"])
        self.assertEqual(
            [button["key"] for button in update["body"]["template_card"]["button_list"]],
            ["q2_o1", "q2_o2"],
        )

        dispatch_click("second-click", "q2_o1")
        await asyncio.wait_for(answered.wait(), timeout=1)
        channel.answer_input.assert_awaited_once_with(
            "input-1",
            [
                {"question_id": "metric", "option_id": "revenue"},
                {"question_id": "dimension", "option_id": "department"},
            ],
        )
        final_update = self.sent[3]
        self.assertEqual(final_update["cmd"], "aibot_respond_update_msg")
        self.assertEqual(final_update["headers"]["req_id"], "second-click")
        self.assertEqual(final_update["body"]["template_card"]["card_type"], "text_notice")
        self.assertEqual(await self.interactions.pending_count(), 0)


if __name__ == "__main__":
    unittest.main()
