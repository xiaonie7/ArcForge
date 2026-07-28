"""Restricted WeCom commands and per-user channel sessions."""

from __future__ import annotations

import asyncio
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass


_COMMAND_ALIASES = {
    "/new": "new",
    "/newchat": "new",
    "/新会话": "new",
    "/compact": "compact",
    "/压缩": "compact",
    "/压缩上下文": "compact",
    "/help": "help",
    "/帮助": "help",
}


def parse_command(text: str) -> str:
    """Return a canonical command only for an exact, allowlisted match."""

    return _COMMAND_ALIASES.get(text.strip(), "")


@dataclass(frozen=True)
class SessionKey:
    chat_type: str
    chat_id: str
    external_user_id: str


@dataclass(frozen=True)
class SessionRotation:
    key: SessionKey
    expected_session_id: str | None
    candidate_session_id: str


class SessionSequencer:
    """Provide one fair asyncio lock per normalized WeCom session key."""

    def __init__(self):
        self._locks: dict[SessionKey, asyncio.Lock] = {}
        self._lock = threading.Lock()

    def lock_for(self, key: SessionKey) -> asyncio.Lock:
        with self._lock:
            lock = self._locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[key] = lock
            return lock


class SessionStore:
    """Keep one stable session per WeCom user/chat scope.

    Methods are synchronous and protected by a lock so callers from asyncio
    tasks and worker threads observe atomic creation and rotation.
    """

    def __init__(self, id_factory: Callable[[], str] | None = None):
        self._id_factory = id_factory or (lambda: uuid.uuid4().hex)
        self._sessions: dict[SessionKey, str] = {}
        self._lock = threading.Lock()

    @staticmethod
    def key(*, chat_type: str, chat_id: str, external_user_id: str) -> SessionKey:
        normalized_type = chat_type.strip().lower()
        if normalized_type not in {"single", "group"}:
            raise ValueError("chat_type must be single or group")
        normalized_user = external_user_id.strip()
        if not normalized_user:
            raise ValueError("external_user_id is required")
        normalized_chat = chat_id.strip() if normalized_type == "group" else "direct"
        if not normalized_chat:
            raise ValueError("chat_id is required for group messages")
        return SessionKey(normalized_type, normalized_chat, normalized_user)

    def get(self, *, chat_type: str, chat_id: str, external_user_id: str) -> str:
        key = self.key(
            chat_type=chat_type,
            chat_id=chat_id,
            external_user_id=external_user_id,
        )
        return self.get_for_key(key)

    def get_for_key(self, key: SessionKey) -> str:
        with self._lock:
            session_id = self._sessions.get(key)
            if session_id is None:
                session_id = self._new_id()
                self._sessions[key] = session_id
            return session_id

    def reserve_rotation(self, key: SessionKey) -> SessionRotation:
        """Create a candidate without changing the session visible to readers."""

        with self._lock:
            current = self._sessions.get(key)
            candidate = self._new_id()
            if candidate == current:
                raise ValueError("session id factory returned the current session id")
            return SessionRotation(key, current, candidate)

    def commit_rotation(self, rotation: SessionRotation) -> bool:
        """Commit a reservation only if its observed session is still current."""

        with self._lock:
            if self._sessions.get(rotation.key) != rotation.expected_session_id:
                return False
            self._sessions[rotation.key] = rotation.candidate_session_id
            return True

    def rotate(self, *, chat_type: str, chat_id: str, external_user_id: str) -> str:
        """Atomically rotate a session for callers that do not need rollback."""

        key = self.key(
            chat_type=chat_type,
            chat_id=chat_id,
            external_user_id=external_user_id,
        )
        with self._lock:
            session_id = self._new_id()
            self._sessions[key] = session_id
            return session_id

    def _new_id(self) -> str:
        session_id = self._id_factory().strip()
        if not session_id:
            raise ValueError("session id factory returned an empty value")
        return session_id
