"""WeCom presentation and reply handling for desktop input requests."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

from .commands import SessionKey

logger = logging.getLogger(__name__)

_MAX_QUESTIONS = 4
_MAX_OPTIONS = 6
_RESOLVED_RETENTION_SECONDS = 10 * 60
_TOKEN_SPLIT = re.compile(r"[\s,，;；]+")
_KEYED_CHOICE = re.compile(r"^(\d+)(?:[:：=\-]?)([A-Fa-f]|\d+)$")
_CARD_EVENT_KEY = re.compile(r"^o[1-6]$")


def _value(value: object, *names: str, default: object = None) -> object:
    if isinstance(value, dict):
        for name in names:
            if name in value:
                return value[name]
        return default
    for name in names:
        if hasattr(value, name):
            return getattr(value, name)
    return default


def _text(value: object, *names: str) -> str:
    raw = _value(value, *names, default="")
    return raw.strip() if isinstance(raw, str) else ""


def _items(value: object, *names: str) -> list[object]:
    raw = _value(value, *names, default=())
    if isinstance(raw, (str, bytes, bytearray, dict)) or raw is None:
        return []
    try:
        return list(raw)
    except TypeError:
        return []


@dataclass(frozen=True)
class InteractionOption:
    option_id: str
    label: str
    description: str = ""
    recommended: bool = False


@dataclass(frozen=True)
class InteractionQuestion:
    question_id: str
    header: str
    prompt: str
    options: tuple[InteractionOption, ...]


@dataclass
class PendingInteraction:
    interaction_id: str
    session_key: SessionKey
    frame: dict[str, Any]
    stream_id: str
    deadline_at_ms: int
    questions: tuple[InteractionQuestion, ...]
    task_id: str
    card: dict[str, Any]
    question_by_card_key: dict[str, InteractionQuestion]
    option_by_card_key: dict[tuple[str, str], InteractionOption]
    current_question_index: int = 0
    state: str = "pending"
    card_sent: bool = False
    selections: list[dict[str, str]] = field(default_factory=list)
    resolved_at: float = 0.0
    handled_event_ids: set[str] = field(default_factory=set, repr=False)


def normalize_input_request(request: object) -> tuple[str, int, tuple[InteractionQuestion, ...]]:
    interaction_id = _text(request, "interaction_id", "interactionId")
    if not interaction_id:
        raise ValueError("interaction_id is required")
    raw_deadline = _value(request, "deadline_at_ms", "deadlineAtMs", default=0)
    try:
        deadline_at_ms = max(0, int(raw_deadline or 0))
    except (TypeError, ValueError) as exc:
        raise ValueError("deadline_at_ms is invalid") from exc

    questions: list[InteractionQuestion] = []
    seen_question_ids: set[str] = set()
    for raw_question in _items(request, "questions"):
        if len(questions) >= _MAX_QUESTIONS:
            raise ValueError("too many questions")
        question_id = _text(raw_question, "id", "question_id", "questionId")
        prompt = _text(raw_question, "prompt")
        if not question_id or not prompt or question_id in seen_question_ids:
            raise ValueError("invalid question")
        seen_question_ids.add(question_id)
        options: list[InteractionOption] = []
        seen_option_ids: set[str] = set()
        for raw_option in _items(raw_question, "options"):
            if len(options) >= _MAX_OPTIONS:
                raise ValueError("too many options")
            option_id = _text(raw_option, "id", "option_id", "optionId")
            label = _text(raw_option, "label")
            if not option_id or not label or option_id in seen_option_ids:
                raise ValueError("invalid option")
            seen_option_ids.add(option_id)
            options.append(
                InteractionOption(
                    option_id=option_id,
                    label=label,
                    description=_text(raw_option, "description"),
                    recommended=bool(_value(raw_option, "recommended", default=False)),
                )
            )
        if len(options) < 2:
            raise ValueError("question needs at least two options")
        questions.append(
            InteractionQuestion(
                question_id=question_id,
                header=_text(raw_question, "header"),
                prompt=prompt,
                options=tuple(options),
            )
        )
    if not questions:
        raise ValueError("questions are required")
    return interaction_id, deadline_at_ms, tuple(questions)


def _short(value: str, limit: int) -> str:
    value = " ".join(value.split())
    if len(value) <= limit:
        return value
    return value[: max(1, limit - 1)] + "…"


def render_numbered_questions(questions: tuple[InteractionQuestion, ...]) -> str:
    lines = ["### 需要你的选择"]
    for question_index, question in enumerate(questions, start=1):
        lines.append("")
        lines.append(f"**{question_index}. {question.prompt}**")
        for option_index, option in enumerate(question.options, start=1):
            recommendation = "（推荐）" if option.recommended else ""
            description = f" - {option.description}" if option.description else ""
            lines.append(f"{option_index}. {option.label}{recommendation}{description}")
    lines.append("")
    if len(questions) == 1:
        lines.append("请点击卡片提交，或直接回复选项序号，例如 `1`。")
    else:
        lines.append("请点击卡片提交，或按题目顺序回复选项序号，例如 `1,2`。")
    return "\n".join(lines)


def _card_task_id(interaction_id: str) -> str:
    digest = hashlib.sha256(interaction_id.encode("utf-8", "replace")).hexdigest()[:24]
    return f"arcforge-{digest}"


def _build_card(
    interaction_id: str,
    questions: tuple[InteractionQuestion, ...],
) -> tuple[
    str,
    dict[str, Any],
    dict[str, InteractionQuestion],
    dict[tuple[str, str], InteractionOption],
]:
    task_id = _card_task_id(interaction_id)
    question_by_card_key: dict[str, InteractionQuestion] = {}
    option_by_card_key: dict[tuple[str, str], InteractionOption] = {}
    for question_index, question in enumerate(questions, start=1):
        question_key = f"q{question_index}"
        question_by_card_key[question_key] = question
        for option_index, option in enumerate(question.options, start=1):
            # WeCom button callbacks expose only event_key. Keep the key
            # opaque and bounded; the active question is tracked server-side.
            option_key = f"o{option_index}"
            option_by_card_key[(question_key, option_key)] = option
    card = _question_card(task_id, questions, question_index=0)
    return task_id, card, question_by_card_key, option_by_card_key


def _question_card(
    task_id: str,
    questions: tuple[InteractionQuestion, ...],
    *,
    question_index: int,
    selected_option_key: str = "",
) -> dict[str, Any]:
    """Build the official WeCom button-interaction card for one question.

    WeCom card callbacks reliably carry only ``task_id`` and ``event_key``.
    Showing one question at a time keeps the callback self-contained and lets
    us advance a multi-question interaction by updating the same card.
    """
    question = questions[question_index]
    question_key = f"q{question_index + 1}"
    title = question.header or f"第 {question_index + 1} 题"
    desc = f"第 {question_index + 1}/{len(questions)} 题"
    buttons = []
    for option_index, option in enumerate(question.options, start=1):
        option_key = f"o{option_index}"
        style = 1 if option_key == selected_option_key or option.recommended else 2
        buttons.append(
            {
                "text": _short(option.label, 10),
                "key": option_key,
                "style": style,
            }
        )
    card: dict[str, Any] = {
        "card_type": "button_interaction",
        "main_title": {"title": _short(title, 26), "desc": _short(desc, 30)},
        "sub_title_text": _short(question.prompt, 112),
        "button_list": buttons,
        "task_id": task_id,
    }
    if selected_option_key:
        card["sub_title_text"] = _short(
            f"已选择：{next((button['text'] for button in buttons if button['key'] == selected_option_key), '')}\n{question.prompt}",
            112,
        )
    return card


def _resolved_card(task_id: str, title: str, description: str = "") -> dict[str, Any]:
    return {
        "card_type": "text_notice",
        "main_title": {"title": _short(title, 26), "desc": _short(description, 30)},
        "task_id": task_id,
    }


def _choice_index(token: str, option_count: int) -> int | None:
    token = token.strip()
    if len(token) == 1 and token.upper() in "ABCDEF":
        index = ord(token.upper()) - ord("A")
    elif token.isdigit():
        index = int(token) - 1
    else:
        return None
    return index if 0 <= index < option_count else None


def parse_text_selections(
    questions: tuple[InteractionQuestion, ...],
    raw_text: str,
) -> list[dict[str, str]] | None:
    text = raw_text.strip()
    if not text:
        return None
    if len(questions) == 1:
        question = questions[0]
        for option in question.options:
            if text.casefold() == option.label.casefold():
                return [{"question_id": question.question_id, "option_id": option.option_id}]
        match = _KEYED_CHOICE.fullmatch(text)
        choice = match.group(2) if match and not text.isdigit() else text
        index = _choice_index(choice, len(question.options))
        if index is None:
            return None
        return [
            {
                "question_id": question.question_id,
                "option_id": question.options[index].option_id,
            }
        ]

    tokens = [token for token in _TOKEN_SPLIT.split(text) if token]
    if len(tokens) != len(questions):
        return None
    selections: list[dict[str, str]] = []
    keyed = all(_KEYED_CHOICE.fullmatch(token) for token in tokens)
    if keyed:
        by_question: dict[int, str] = {}
        for token in tokens:
            match = _KEYED_CHOICE.fullmatch(token)
            assert match is not None
            question_index = int(match.group(1)) - 1
            if question_index in by_question or not 0 <= question_index < len(questions):
                return None
            by_question[question_index] = match.group(2)
        ordered_choices = [by_question.get(index, "") for index in range(len(questions))]
    else:
        ordered_choices = tokens
    for question, choice in zip(questions, ordered_choices):
        index = _choice_index(choice, len(question.options))
        if index is None:
            return None
        selections.append(
            {
                "question_id": question.question_id,
                "option_id": question.options[index].option_id,
            }
        )
    return selections


def _ack_rejected(acknowledgement: object) -> bool:
    mappings: list[dict[str, Any]] = []
    if isinstance(acknowledgement, dict):
        mappings.append(acknowledgement)
        for key in ("body", "data"):
            nested = acknowledgement.get(key)
            if isinstance(nested, dict):
                mappings.append(nested)
    return any(mapping.get("errcode") not in (None, 0, "0") for mapping in mappings)


async def _call_answer_input(
    channel: Any,
    interaction_id: str,
    selections: list[dict[str, str]],
) -> object:
    method = getattr(channel, "answer_input", None)
    if not callable(method):
        raise RuntimeError("channel does not support input answers")

    try:
        signature = inspect.signature(method)
        positional = [
            parameter
            for parameter in signature.parameters.values()
            if parameter.kind
            in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
        ]
        accepts_many = any(
            parameter.kind == inspect.Parameter.VAR_POSITIONAL
            for parameter in signature.parameters.values()
        )
    except (TypeError, ValueError):
        positional = []
        accepts_many = True

    if accepts_many or len(positional) >= 2:
        return await method(interaction_id, selections)

    from . import protocol

    selection_type = getattr(protocol, "ChannelInputAnswerSelection")
    answer_type = getattr(protocol, "ChannelInputAnswer")
    answer = answer_type(
        interaction_id=interaction_id,
        selections=[
            selection_type(
                question_id=selection["question_id"],
                option_id=selection["option_id"],
            )
            for selection in selections
        ],
    )
    return await method(answer)


def _answer_result(result: object) -> tuple[bool, str]:
    accepted = bool(_value(result, "accepted", default=False))
    status = _text(result, "status", "error_code", "errorCode").lower()
    return accepted, status


def _resolved_status(resolved: object) -> tuple[str, str]:
    return (
        _text(resolved, "interaction_id", "interactionId"),
        _text(resolved, "status").lower(),
    )


def _event_payload(frame: dict[str, Any]) -> dict[str, Any]:
    body = frame.get("body")
    if not isinstance(body, dict):
        return {}
    event = body.get("event")
    return event if isinstance(event, dict) else {}


def _event_task_id(frame: dict[str, Any]) -> str:
    event = _event_payload(frame)
    value = event.get("task_id") or event.get("taskId")
    if not value:
        body = frame.get("body")
        if isinstance(body, dict):
            value = body.get("task_id") or body.get("taskId")
    return value.strip() if isinstance(value, str) else ""


def _event_choice(
    pending: PendingInteraction,
    frame: dict[str, Any],
) -> tuple[str, str] | None:
    event = _event_payload(frame)
    event_key = _text(event, "event_key", "eventKey")
    if not _CARD_EVENT_KEY.fullmatch(event_key):
        return None
    question_key = f"q{pending.current_question_index + 1}"
    if (question_key, event_key) not in pending.option_by_card_key:
        return None
    return question_key, event_key


def _event_id(frame: dict[str, Any]) -> str:
    headers = frame.get("headers")
    if isinstance(headers, dict):
        value = headers.get("req_id") or headers.get("request_id")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


class InteractionCoordinator:
    """Own pending input requests for one WeCom connector process."""

    def __init__(self) -> None:
        self._by_session: dict[SessionKey, PendingInteraction] = {}
        self._by_interaction: dict[str, PendingInteraction] = {}
        self._by_task: dict[str, PendingInteraction] = {}
        self._lock = asyncio.Lock()

    def _sweep_locked(self) -> None:
        cutoff = time.monotonic() - _RESOLVED_RETENTION_SECONDS
        stale = [
            pending
            for pending in self._by_interaction.values()
            if pending.resolved_at and pending.resolved_at < cutoff
        ]
        for pending in stale:
            self._by_interaction.pop(pending.interaction_id, None)
            self._by_task.pop(pending.task_id, None)

    async def present(
        self,
        request: object,
        *,
        session_key: SessionKey,
        wecom: Any,
        frame: dict[str, Any],
        stream_id: str,
    ) -> bool:
        try:
            interaction_id, deadline_at_ms, questions = normalize_input_request(request)
        except ValueError:
            logger.warning("ArcForge input request was invalid")
            return False
        task_id, card, question_map, option_map = _build_card(interaction_id, questions)
        pending = PendingInteraction(
            interaction_id=interaction_id,
            session_key=session_key,
            frame=frame,
            stream_id=stream_id,
            deadline_at_ms=deadline_at_ms,
            questions=questions,
            task_id=task_id,
            card=card,
            question_by_card_key=question_map,
            option_by_card_key=option_map,
        )
        async with self._lock:
            self._sweep_locked()
            existing = self._by_interaction.get(interaction_id)
            if existing is not None:
                return True
            previous = self._by_session.get(session_key)
            if previous is not None:
                previous.state = "superseded"
                previous.resolved_at = time.monotonic()
            self._by_session[session_key] = pending
            self._by_interaction[interaction_id] = pending
            self._by_task[task_id] = pending

        markdown = render_numbered_questions(questions)
        card_method = getattr(wecom, "reply_stream_with_card", None)
        if callable(card_method):
            try:
                acknowledgement = await card_method(
                    frame,
                    stream_id,
                    markdown,
                    False,
                    template_card=card,
                )
                if _ack_rejected(acknowledgement):
                    raise RuntimeError("WeCom rejected the template card")
                pending.card_sent = True
                return True
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("WeCom input card failed; using Markdown fallback")
        try:
            acknowledgement = await wecom.reply_stream(frame, stream_id, markdown, False)
            if _ack_rejected(acknowledgement):
                raise RuntimeError("WeCom rejected the Markdown input prompt")
            return True
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("WeCom input prompt delivery failed")
            return False

    async def _claim(
        self,
        pending: PendingInteraction,
        selections: list[dict[str, str]],
    ) -> str:
        async with self._lock:
            if pending.state == "answering":
                return "answering"
            if pending.state != "pending":
                return "resolved"
            if pending.deadline_at_ms and int(time.time() * 1000) >= pending.deadline_at_ms:
                pending.state = "expired"
                pending.resolved_at = time.monotonic()
                if self._by_session.get(pending.session_key) is pending:
                    self._by_session.pop(pending.session_key, None)
                return "expired"
            pending.state = "answering"
            pending.selections = selections
            return "claimed"

    async def _finish_answer(
        self,
        pending: PendingInteraction,
        channel: Any,
        selections: list[dict[str, str]],
    ) -> str:
        try:
            result = await _call_answer_input(channel, pending.interaction_id, selections)
        except asyncio.CancelledError:
            raise
        except Exception:
            async with self._lock:
                if pending.state == "answering":
                    pending.state = "pending"
            logger.warning("ArcForge input answer delivery failed")
            return "failed"
        accepted, status = _answer_result(result)
        async with self._lock:
            if accepted or status in {"answered", "accepted", "resolved", "already_resolved"}:
                pending.state = "answered"
                pending.resolved_at = time.monotonic()
                if self._by_session.get(pending.session_key) is pending:
                    self._by_session.pop(pending.session_key, None)
                return "accepted"
            if status in {"expired", "timed_out", "timeout", "not_pending", "cancelled"}:
                pending.state = status or "resolved"
                pending.resolved_at = time.monotonic()
                if self._by_session.get(pending.session_key) is pending:
                    self._by_session.pop(pending.session_key, None)
                return "expired" if "expir" in pending.state or "time" in pending.state else "resolved"
            pending.state = "pending"
        return "failed"

    async def handle_text(
        self,
        *,
        session_key: SessionKey,
        text: str,
        channel: Any,
    ) -> str | None:
        async with self._lock:
            self._sweep_locked()
            pending = self._by_session.get(session_key)
        if pending is None:
            return None
        selections = parse_text_selections(pending.questions, text)
        if selections is None:
            return "当前正在等待选择，请按提示回复有效的选项序号。"
        claim = await self._claim(pending, selections)
        if claim == "answering":
            return "选择正在提交，请稍候。"
        if claim in {"resolved", "expired"}:
            return "该选择已经处理或过期，请等待桌面端继续。"
        outcome = await self._finish_answer(pending, channel, selections)
        if outcome == "accepted":
            return "选择已提交，桌面端正在继续处理。"
        if outcome in {"resolved", "expired"}:
            return "该选择已经处理或过期，请等待桌面端继续。"
        return "选择提交失败，请重新回复选项序号。"

    async def _update_card(
        self,
        pending: PendingInteraction,
        *,
        wecom: Any,
        frame: dict[str, Any],
        card: dict[str, Any] | None = None,
        status_text: str = "",
    ) -> None:
        if not pending.card_sent:
            return
        if card is None:
            card = _resolved_card(pending.task_id, status_text or "该选择已处理")
        method = getattr(wecom, "update_template_card", None)
        try:
            if callable(method):
                acknowledgement = await method(frame, card)
            else:
                reply = getattr(wecom, "reply", None)
                if not callable(reply):
                    return
                acknowledgement = await reply(
                    frame,
                    {"response_type": "update_template_card", "template_card": card},
                    "aibot_respond_update_msg",
                )
            if _ack_rejected(acknowledgement):
                raise RuntimeError("WeCom rejected the template card update")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("WeCom input card update failed")

    async def _claim_card_choice(
        self,
        pending: PendingInteraction,
        question_key: str,
        option_key: str,
    ) -> tuple[str, list[dict[str, str]] | None, dict[str, Any] | None]:
        """Advance one button click while serializing duplicate callbacks."""
        async with self._lock:
            if pending.state != "pending":
                return "resolved", None, None
            if pending.deadline_at_ms and int(time.time() * 1000) >= pending.deadline_at_ms:
                pending.state = "expired"
                pending.resolved_at = time.monotonic()
                if self._by_session.get(pending.session_key) is pending:
                    self._by_session.pop(pending.session_key, None)
                return "expired", None, None
            expected_question_key = f"q{pending.current_question_index + 1}"
            if question_key != expected_question_key:
                return "stale", None, pending.card
            option = pending.option_by_card_key.get((question_key, option_key))
            if option is None:
                return "invalid", None, None
            question = pending.question_by_card_key[question_key]
            pending.selections.append(
                {"question_id": question.question_id, "option_id": option.option_id}
            )
            pending.current_question_index += 1
            if pending.current_question_index >= len(pending.questions):
                pending.state = "answering"
                return "claimed", list(pending.selections), None
            pending.card = _question_card(
                pending.task_id,
                pending.questions,
                question_index=pending.current_question_index,
            )
            return "advanced", None, pending.card

    async def _rollback_card_choice(self, pending: PendingInteraction) -> None:
        async with self._lock:
            if pending.state != "answering" or not pending.selections:
                return
            pending.selections.pop()
            pending.current_question_index = len(pending.selections)
            pending.state = "pending"
            pending.card = _question_card(
                pending.task_id,
                pending.questions,
                question_index=pending.current_question_index,
            )

    async def handle_card_event(
        self,
        *,
        frame: dict[str, Any],
        session_key: SessionKey | None,
        wecom: Any,
        channel: Any,
    ) -> bool:
        task_id = _event_task_id(frame)
        if not task_id:
            return False
        async with self._lock:
            self._sweep_locked()
            pending = self._by_task.get(task_id)
            if pending is None or (
                session_key is not None and session_key != pending.session_key
            ):
                return False
        callback_id = _event_id(frame)
        if callback_id:
            async with self._lock:
                if callback_id in pending.handled_event_ids:
                    return True
                pending.handled_event_ids.add(callback_id)
        if pending.state != "pending":
            await self._update_card(
                pending,
                wecom=wecom,
                frame=frame,
                status_text="该选择已处理",
            )
            return True
        choice = _event_choice(pending, frame)
        if choice is None:
            logger.warning("WeCom input card event had invalid event_key")
            return True
        question_key, option_key = choice
        claim, selections, next_card = await self._claim_card_choice(
            pending, question_key, option_key
        )
        if claim == "advanced" and next_card is not None:
            await self._update_card(pending, wecom=wecom, frame=frame, card=next_card)
            return True
        if claim == "stale":
            await self._update_card(
                pending,
                wecom=wecom,
                frame=frame,
                card=pending.card,
            )
            return True
        if claim == "expired":
            await self._update_card(
                pending,
                wecom=wecom,
                frame=frame,
                card=_resolved_card(pending.task_id, "选择已超时", "桌面端将继续处理。"),
            )
            return True
        if claim != "claimed" or selections is None:
            await self._update_card(
                pending,
                wecom=wecom,
                frame=frame,
                status_text="该选择已处理",
            )
            return True
        # Card callbacks must be acknowledged quickly; disable the original card
        # before waiting for the desktop round trip.
        await self._update_card(
            pending,
            wecom=wecom,
            frame=frame,
            card=_resolved_card(pending.task_id, "选择已收到", "正在提交到桌面端。"),
        )
        outcome = await self._finish_answer(pending, channel, selections)
        if outcome == "failed":
            await self._rollback_card_choice(pending)
            await self._update_card(pending, wecom=wecom, frame=frame, card=pending.card)
            with contextlib.suppress(Exception):
                await wecom.reply_stream(
                    pending.frame,
                    pending.stream_id,
                    "卡片提交失败，请按编号直接回复。",
                    False,
                )
        return True

    async def handle_resolved(self, resolved: object, *, wecom: Any) -> bool:
        interaction_id, status = _resolved_status(resolved)
        if not interaction_id:
            return False
        async with self._lock:
            self._sweep_locked()
            pending = self._by_interaction.get(interaction_id)
            if pending is None:
                return False
            pending.state = status or "resolved"
            pending.resolved_at = time.monotonic()
            if self._by_session.get(pending.session_key) is pending:
                self._by_session.pop(pending.session_key, None)
        if status in {"expired", "timed_out", "timeout"}:
            content = "选择已超时，桌面端已继续处理。"
        elif status in {"cancelled", "canceled"}:
            content = "本次选择已取消。"
        else:
            content = "选择已完成，桌面端正在继续处理。"
        # A resolved frame is not a WeCom callback frame, so it cannot be used
        # with update_template_card (that API requires the original click
        # request id). The text stream remains the reliable cross-client
        # acknowledgement; the next card click receives an already-processed
        # response using its own callback frame.
        try:
            await wecom.reply_stream(pending.frame, pending.stream_id, content, False)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("WeCom input resolution update failed")
        return True

    async def pending_count(self) -> int:
        async with self._lock:
            return len(self._by_session)
