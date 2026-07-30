import asyncio
import unittest

from connectors.wecom_aibot.channel_client import ChannelClient, make_inbound
from connectors.wecom_aibot.config import ConnectorConfig
from connectors.wecom_aibot.protocol import (
    ChannelClientFrame,
    ChannelFinal,
    ChannelInputAnswerResult,
    ChannelInputAnswerSelection,
    ChannelInputOption,
    ChannelInputQuestion,
    ChannelInputRequest,
    ChannelInputResolved,
    ChannelServerFrame,
    ErrorResponse,
)


def _config() -> ConnectorConfig:
    return ConnectorConfig(
        bot_id="bot-1",
        secret="secret",
        gateway_url="ws://127.0.0.1:1/ws/v2/channel",
        channel_token="channel-token",
        tenant_id="tenant-1",
        connector_id="wecom-desktop",
    )


def _inbound():
    return make_inbound(
        external_message_id="message-1",
        external_user_id="alice",
        chat_id="",
        chat_type="single",
        text="hello",
        channel_session_id="session-1",
    )


class _RecordingSocket:
    def __init__(self):
        self.sent: list[bytes] = []
        self.closed = False

    async def send(self, data: bytes) -> None:
        self.sent.append(bytes(data))

    async def close(self) -> None:
        self.closed = True


async def _wait_for_sent(socket: _RecordingSocket, count: int) -> None:
    for _ in range(100):
        if len(socket.sent) >= count:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"expected {count} sent frames, got {len(socket.sent)}")


class ChannelInteractionProtocolTests(unittest.TestCase):
    def test_interaction_frames_round_trip_with_canonical_field_numbers(self):
        request = ChannelInputRequest(
            interaction_id="interaction-1",
            run_id="run-1",
            conversation_id="conversation-1",
            seq=7,
            deadline_at_ms=123456,
            questions=[
                ChannelInputQuestion(
                    id="q1",
                    header="Scope",
                    prompt="Choose one",
                    options=[
                        ChannelInputOption(
                            id="a",
                            label="Option A",
                            description="Recommended choice",
                            recommended=True,
                        ),
                        ChannelInputOption(id="b", label="Option B"),
                    ],
                )
            ],
        )
        server = ChannelServerFrame(request_id="request-1", input_request=request)
        decoded_server = ChannelServerFrame.FromString(server.SerializeToString())

        self.assertEqual(decoded_server.DESCRIPTOR.fields_by_name["input_request"].number, 9)
        self.assertEqual(decoded_server.DESCRIPTOR.fields_by_name["input_answer_result"].number, 10)
        self.assertEqual(decoded_server.DESCRIPTOR.fields_by_name["input_resolved"].number, 11)
        self.assertEqual(decoded_server.input_request.questions[0].id, "q1")
        self.assertEqual(decoded_server.input_request.questions[0].options[0].id, "a")
        self.assertTrue(decoded_server.input_request.questions[0].options[0].recommended)

        client = ChannelClientFrame(
            request_id="answer-1",
            input_answer={
                "interaction_id": "interaction-1",
                "selections": [{"question_id": "q1", "option_id": "a"}],
            },
        )
        decoded_client = ChannelClientFrame.FromString(client.SerializeToString())
        self.assertEqual(decoded_client.DESCRIPTOR.fields_by_name["input_answer"].number, 5)
        self.assertEqual(decoded_client.input_answer.selections[0].question_id, "q1")
        self.assertEqual(decoded_client.input_answer.selections[0].option_id, "a")

        resolved = ChannelInputResolved(
            interaction_id="interaction-1",
            status="answered",
            selections=[ChannelInputAnswerSelection(question_id="q1", option_id="a")],
            message="resolved",
        )
        decoded_resolved = ChannelInputResolved.FromString(resolved.SerializeToString())
        self.assertEqual(decoded_resolved.DESCRIPTOR.fields_by_name["status"].number, 2)
        self.assertEqual(decoded_resolved.DESCRIPTOR.fields_by_name["selections"].number, 3)
        self.assertEqual(decoded_resolved.DESCRIPTOR.fields_by_name["message"].number, 4)


class ChannelInteractionClientTests(unittest.IsolatedAsyncioTestCase):
    def _client(self) -> tuple[ChannelClient, _RecordingSocket]:
        client = ChannelClient(_config())
        socket = _RecordingSocket()
        client._ws = socket
        client._closed = False
        return client, socket

    async def test_submit_dispatches_input_callbacks_without_blocking_frame_handling(self):
        client, socket = self._client()
        request_started = asyncio.Event()
        release_request = asyncio.Event()
        resolved_seen = asyncio.Event()
        received = []

        async def handle_request(request):
            received.append(("request", request.interaction_id))
            request_started.set()
            await release_request.wait()

        async def handle_resolved(resolved):
            received.append(("resolved", resolved.status))
            resolved_seen.set()

        submit_task = asyncio.create_task(
            client.submit(
                _inbound(),
                input_request_handler=handle_request,
                input_resolved_handler=handle_resolved,
            )
        )
        await _wait_for_sent(socket, 1)
        submitted = ChannelClientFrame.FromString(socket.sent[0])

        await client._handle_frame(
            ChannelServerFrame(
                request_id=submitted.request_id,
                input_request=ChannelInputRequest(
                    interaction_id="interaction-1",
                    run_id="run-1",
                    conversation_id="conversation-1",
                    questions=[
                        ChannelInputQuestion(
                            id="q1",
                            prompt="Choose",
                            options=[
                                ChannelInputOption(id="a", label="A"),
                                ChannelInputOption(id="b", label="B"),
                            ],
                        )
                    ],
                ),
            )
        )
        await asyncio.wait_for(request_started.wait(), timeout=1)

        await client._handle_frame(
            ChannelServerFrame(
                request_id=submitted.request_id,
                input_resolved=ChannelInputResolved(
                    interaction_id="interaction-1",
                    status="answered",
                    selections=[{"question_id": "q1", "option_id": "a"}],
                ),
            )
        )
        await asyncio.wait_for(resolved_seen.wait(), timeout=1)
        self.assertEqual(received, [("request", "interaction-1"), ("resolved", "answered")])

        await client._handle_frame(
            ChannelServerFrame(
                request_id=submitted.request_id,
                final=ChannelFinal(
                    run_id="run-1",
                    conversation_id="conversation-1",
                    status="completed",
                ),
            )
        )
        response = await asyncio.wait_for(submit_task, timeout=1)
        self.assertEqual(response.status, "completed")

        release_request.set()
        await asyncio.gather(*tuple(client._callback_tasks))

    async def test_answer_input_uses_independent_request_and_waits_for_result(self):
        client, socket = self._client()
        answer_task = asyncio.create_task(
            client.answer_input(
                " interaction-1 ",
                [
                    ("q1", "a"),
                    {"questionId": "q2", "optionId": "b"},
                ],
            )
        )
        await _wait_for_sent(socket, 1)
        sent = ChannelClientFrame.FromString(socket.sent[0])

        self.assertTrue(sent.request_id.startswith("channel-input-answer-"))
        self.assertEqual(sent.input_answer.interaction_id, "interaction-1")
        self.assertEqual(
            [(item.question_id, item.option_id) for item in sent.input_answer.selections],
            [("q1", "a"), ("q2", "b")],
        )

        await client._handle_frame(
            ChannelServerFrame(
                request_id=sent.request_id,
                input_answer_result=ChannelInputAnswerResult(
                    interaction_id="interaction-1",
                    accepted=True,
                    status="accepted",
                ),
            )
        )
        result = await asyncio.wait_for(answer_task, timeout=1)
        self.assertTrue(result.accepted)
        self.assertEqual(result.status, "accepted")
        self.assertEqual(client._answer_waiters, {})

    async def test_answer_input_local_error_releases_waiter(self):
        client, socket = self._client()
        answer_task = asyncio.create_task(client.answer_input("interaction-1", [("q1", "a")]))
        await _wait_for_sent(socket, 1)
        sent = ChannelClientFrame.FromString(socket.sent[0])

        await client._handle_frame(
            ChannelServerFrame(
                request_id=sent.request_id,
                local_error=ErrorResponse(code=17, message="expired"),
            )
        )
        with self.assertRaisesRegex(RuntimeError, "expired"):
            await asyncio.wait_for(answer_task, timeout=1)
        self.assertEqual(client._answer_waiters, {})

    async def test_disconnect_releases_submit_and_answer_waiters(self):
        client, socket = self._client()
        submit_task = asyncio.create_task(client.submit(_inbound()))
        answer_task = asyncio.create_task(client.answer_input("interaction-1", [("q1", "a")]))
        await _wait_for_sent(socket, 2)

        await client._mark_failed(ConnectionError("reader stopped"))
        results = await asyncio.wait_for(
            asyncio.gather(submit_task, answer_task, return_exceptions=True),
            timeout=1,
        )
        self.assertEqual(len(results), 2)
        self.assertTrue(all(isinstance(result, ConnectionError) for result in results))
        self.assertEqual(client._responses, {})
        self.assertEqual(client._answer_waiters, {})


if __name__ == "__main__":
    unittest.main()
