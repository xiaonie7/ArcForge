"""Runtime protobuf schema for the restricted ArcForge channel.

The canonical schema lives in ``crates/agent-gateway/proto/v2``. This small
runtime descriptor keeps the standalone connector independent from Go or
Node build tooling while preserving the exact field numbers and oneofs.
"""

from __future__ import annotations

from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

CHANNEL_SUBPROTOCOL = "liveagent.v2.pb"


def _field(
    message: descriptor_pb2.DescriptorProto,
    name: str,
    number: int,
    kind: int,
    *,
    type_name: str = "",
    repeated: bool = False,
) -> None:
    item = message.field.add(
        name=name,
        number=number,
        label=3 if repeated else 1,
        type=kind,
    )
    if type_name:
        item.type_name = type_name


def _build_pool() -> descriptor_pool.DescriptorPool:
    # ErrorResponse is owned by the v1 schema.  The channel descriptor imports
    # that message so the Python client exercises the same fully-qualified
    # protobuf type as the Go gateway while remaining wire-compatible.
    v1_file = descriptor_pb2.FileDescriptorProto(
        name="arcforge/gateway_v1.proto",
        package="liveagent.gateway.v1",
        syntax="proto3",
    )
    v1_error = v1_file.message_type.add(name="ErrorResponse")
    _field(v1_error, "code", 1, 5)
    _field(v1_error, "message", 2, 9)

    file = descriptor_pb2.FileDescriptorProto(
        name="arcforge/connector_channel.proto",
        package="liveagent.gateway.v2",
        syntax="proto3",
    )
    file.dependency.append(v1_file.name)
    enum = file.enum_type.add(name="ClientRole")
    for name, number in (("CLIENT_ROLE_UNSPECIFIED", 0), ("CLIENT_ROLE_BROWSER", 1), ("CLIENT_ROLE_AGENT", 2), ("CLIENT_ROLE_CHANNEL", 3)):
        enum.value.add(name=name, number=number)

    hello = file.message_type.add(name="ClientHello")
    for name, number, kind in (("protocol_version", 1, 13), ("role", 2, 14), ("token", 3, 9), ("agent_id", 4, 9), ("agent_version", 5, 9), ("client_name", 6, 9), ("client_version", 7, 9), ("channel_tenant_id", 8, 9), ("channel_bot_id", 9, 9), ("connector_id", 10, 9)):
        _field(hello, name, number, kind, type_name=".liveagent.gateway.v2.ClientRole" if name == "role" else "")
    server = file.message_type.add(name="ServerHello")
    for name, number, kind in (("ok", 1, 8), ("message", 2, 9), ("session_id", 3, 9), ("server_time", 4, 3), ("heartbeat_period_seconds", 5, 13), ("max_message_bytes", 6, 4)):
        _field(server, name, number, kind)
    ping = file.message_type.add(name="PingFrame")
    _field(ping, "timestamp", 1, 3)
    pong = file.message_type.add(name="PongFrame")
    _field(pong, "timestamp", 1, 3)
    inbound_file = file.message_type.add(name="ChannelInboundFile")
    for name, number, kind in (
        ("file_name", 1, 9),
        ("mime_type", 2, 9),
        ("content", 3, 12),
    ):
        _field(inbound_file, name, number, kind)
    inbound = file.message_type.add(name="ChannelInboundMessage")
    for name, number, kind in (("external_message_id", 1, 9), ("external_user_id", 2, 9), ("chat_id", 3, 9), ("chat_type", 4, 9), ("text", 5, 9), ("timestamp", 6, 3), ("command", 7, 9), ("channel_session_id", 8, 9)):
        _field(inbound, name, number, kind)
    _field(
        inbound,
        "files",
        9,
        11,
        type_name=".liveagent.gateway.v2.ChannelInboundFile",
        repeated=True,
    )
    accepted = file.message_type.add(name="ChannelAccepted")
    for name, number, kind in (("external_message_id", 1, 9), ("run_id", 2, 9), ("conversation_id", 3, 9), ("deduped", 4, 8)):
        _field(accepted, name, number, kind)
    delta = file.message_type.add(name="ChannelDelta")
    for name, number, kind in (("run_id", 1, 9), ("conversation_id", 2, 9), ("seq", 3, 3), ("text", 4, 9)):
        _field(delta, name, number, kind)
    final = file.message_type.add(name="ChannelFinal")
    for name, number, kind in (("run_id", 1, 9), ("conversation_id", 2, 9), ("status", 3, 9), ("error_code", 4, 9), ("message", 5, 9)):
        _field(final, name, number, kind)
    channel_file = file.message_type.add(name="ChannelFile")
    for name, number, kind in (
        ("run_id", 1, 9),
        ("conversation_id", 2, 9),
        ("seq", 3, 3),
        ("file_name", 4, 9),
        ("mime_type", 5, 9),
        ("size_bytes", 6, 4),
        ("content", 7, 12),
        ("error_code", 8, 9),
        ("message", 9, 9),
    ):
        _field(channel_file, name, number, kind)

    input_option = file.message_type.add(name="ChannelInputOption")
    for name, number, kind in (
        ("id", 1, 9),
        ("label", 2, 9),
        ("description", 3, 9),
        ("recommended", 4, 8),
    ):
        _field(input_option, name, number, kind)
    input_question = file.message_type.add(name="ChannelInputQuestion")
    for name, number, kind in (
        ("id", 1, 9),
        ("header", 2, 9),
        ("prompt", 3, 9),
    ):
        _field(input_question, name, number, kind)
    _field(
        input_question,
        "options",
        4,
        11,
        type_name=".liveagent.gateway.v2.ChannelInputOption",
        repeated=True,
    )
    input_request = file.message_type.add(name="ChannelInputRequest")
    for name, number, kind in (
        ("interaction_id", 1, 9),
        ("run_id", 2, 9),
        ("conversation_id", 3, 9),
        ("seq", 4, 3),
        ("deadline_at_ms", 5, 3),
    ):
        _field(input_request, name, number, kind)
    _field(
        input_request,
        "questions",
        6,
        11,
        type_name=".liveagent.gateway.v2.ChannelInputQuestion",
        repeated=True,
    )
    input_answer_selection = file.message_type.add(name="ChannelInputAnswerSelection")
    for name, number in (("question_id", 1), ("option_id", 2)):
        _field(input_answer_selection, name, number, 9)
    input_answer = file.message_type.add(name="ChannelInputAnswer")
    _field(input_answer, "interaction_id", 1, 9)
    _field(
        input_answer,
        "selections",
        2,
        11,
        type_name=".liveagent.gateway.v2.ChannelInputAnswerSelection",
        repeated=True,
    )
    input_answer_result = file.message_type.add(name="ChannelInputAnswerResult")
    for name, number, kind in (
        ("interaction_id", 1, 9),
        ("accepted", 2, 8),
        ("status", 3, 9),
        ("message", 4, 9),
    ):
        _field(input_answer_result, name, number, kind)
    input_resolved = file.message_type.add(name="ChannelInputResolved")
    for name, number, kind in (
        ("interaction_id", 1, 9),
        ("status", 2, 9),
    ):
        _field(input_resolved, name, number, kind)
    _field(
        input_resolved,
        "selections",
        3,
        11,
        type_name=".liveagent.gateway.v2.ChannelInputAnswerSelection",
        repeated=True,
    )
    _field(input_resolved, "message", 4, 9)

    client = file.message_type.add(name="ChannelClientFrame")
    _field(client, "request_id", 1, 9)
    oneof = client.oneof_decl.add(name="payload")
    for name, number, type_name in (("hello", 2, ".liveagent.gateway.v2.ClientHello"), ("inbound", 3, ".liveagent.gateway.v2.ChannelInboundMessage"), ("pong", 4, ".liveagent.gateway.v2.PongFrame"), ("input_answer", 5, ".liveagent.gateway.v2.ChannelInputAnswer")):
        item = client.field.add(name=name, number=number, label=1, type=11, type_name=type_name, oneof_index=0)
    server_frame = file.message_type.add(name="ChannelServerFrame")
    _field(server_frame, "request_id", 1, 9)
    server_oneof = server_frame.oneof_decl.add(name="payload")
    for name, number, type_name in (("hello", 2, ".liveagent.gateway.v2.ServerHello"), ("accepted", 3, ".liveagent.gateway.v2.ChannelAccepted"), ("delta", 4, ".liveagent.gateway.v2.ChannelDelta"), ("final", 5, ".liveagent.gateway.v2.ChannelFinal"), ("local_error", 6, ".liveagent.gateway.v1.ErrorResponse"), ("ping", 7, ".liveagent.gateway.v2.PingFrame"), ("file", 8, ".liveagent.gateway.v2.ChannelFile"), ("input_request", 9, ".liveagent.gateway.v2.ChannelInputRequest"), ("input_answer_result", 10, ".liveagent.gateway.v2.ChannelInputAnswerResult"), ("input_resolved", 11, ".liveagent.gateway.v2.ChannelInputResolved")):
        server_frame.field.add(name=name, number=number, label=1, type=11, type_name=type_name, oneof_index=0)
    pool = descriptor_pool.DescriptorPool()
    pool.Add(v1_file)
    pool.Add(file)
    return pool


_POOL = _build_pool()
ClientHello = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ClientHello"))
ErrorResponse = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v1.ErrorResponse"))
ServerHello = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ServerHello"))
PingFrame = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.PingFrame"))
PongFrame = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.PongFrame"))
ChannelInboundFile = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelInboundFile"))
ChannelInboundMessage = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelInboundMessage"))
ChannelAccepted = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelAccepted"))
ChannelDelta = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelDelta"))
ChannelFinal = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelFinal"))
ChannelFile = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelFile"))
ChannelInputOption = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelInputOption"))
ChannelInputQuestion = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelInputQuestion"))
ChannelInputRequest = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelInputRequest"))
ChannelInputAnswerSelection = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelInputAnswerSelection"))
ChannelInputAnswer = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelInputAnswer"))
ChannelInputAnswerResult = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelInputAnswerResult"))
ChannelInputResolved = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelInputResolved"))
ChannelClientFrame = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelClientFrame"))
ChannelServerFrame = message_factory.GetMessageClass(_POOL.FindMessageTypeByName("liveagent.gateway.v2.ChannelServerFrame"))

CHANNEL_ROLE = 3
