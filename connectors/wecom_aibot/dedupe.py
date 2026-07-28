"""Small bounded TTL store for WeCom callback retries."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from .commands import SessionKey


@dataclass(frozen=True)
class DedupeKey:
    chat_type: str
    chat_id: str
    external_user_id: str
    external_message_id: str

    @classmethod
    def from_session(cls, session_key: SessionKey, external_message_id: str) -> "DedupeKey":
        message_id = external_message_id.strip()
        if not message_id:
            raise ValueError("external_message_id is required")
        return cls(
            chat_type=session_key.chat_type,
            chat_id=session_key.chat_id,
            external_user_id=session_key.external_user_id,
            external_message_id=message_id,
        )


@dataclass
class DedupeResult:
    completed: bool = False
    text: str = ""
    status: str = ""


class DedupeStore:
    def __init__(self, ttl_seconds: int = 24 * 60 * 60, max_entries: int = 100_000):
        self.ttl_seconds = max(1, ttl_seconds)
        self.max_entries = max(100, max_entries)
        self._items: dict[DedupeKey, tuple[float, DedupeResult]] = {}
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        expired = [key for key, (expires, _) in self._items.items() if expires <= now]
        for key in expired:
            self._items.pop(key, None)
        if len(self._items) <= self.max_entries:
            return
        for key, _ in sorted(self._items.items(), key=lambda item: item[1][0])[
            : len(self._items) - self.max_entries
        ]:
            self._items.pop(key, None)

    def claim(
        self,
        session_key: SessionKey,
        external_message_id: str,
    ) -> tuple[bool, DedupeResult | None]:
        key = DedupeKey.from_session(session_key, external_message_id)
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            existing = self._items.get(key)
            if existing is not None:
                return False, existing[1]
            self._items[key] = (now + self.ttl_seconds, DedupeResult())
            return True, None

    def complete(
        self,
        session_key: SessionKey,
        external_message_id: str,
        *,
        text: str,
        status: str,
    ) -> None:
        key = DedupeKey.from_session(session_key, external_message_id)
        with self._lock:
            now = time.monotonic()
            self._items[key] = (
                now + self.ttl_seconds,
                DedupeResult(completed=True, text=text, status=status),
            )
            self._prune(now)

    def forget(self, session_key: SessionKey, external_message_id: str) -> None:
        key = DedupeKey.from_session(session_key, external_message_id)
        with self._lock:
            self._items.pop(key, None)
