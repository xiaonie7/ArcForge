"""Small bounded TTL store for WeCom callback retries."""

from __future__ import annotations

import contextvars
import threading
import time
from dataclasses import dataclass

from .commands import SessionKey, SessionRotation


@dataclass(frozen=True)
class DedupeKey:
    chat_type: str
    chat_id: str
    external_user_id: str
    external_message_id: str

    @classmethod
    def from_session(
        cls, session_key: SessionKey, external_message_id: str
    ) -> "DedupeKey":
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
    def __init__(
        self,
        ttl_seconds: int = 24 * 60 * 60,
        max_entries: int = 100_000,
        *,
        state_store=None,
        db_path=None,
        installation_id: str = "wecom-default",
    ):
        self.ttl_seconds = max(1, ttl_seconds)
        self.max_entries = max(1, max_entries)
        self._owns_state_store = state_store is None and bool(db_path)
        if state_store is None and db_path:
            from .state_store import SQLiteStateStore

            state_store = SQLiteStateStore(db_path, installation_id=installation_id)
        self._state_store = state_store
        self._claim_tokens: contextvars.ContextVar[dict[DedupeKey, str] | None] = (
            contextvars.ContextVar(
                f"wecom_dedupe_claims_{id(self)}",
                default=None,
            )
        )
        self._items: dict[str, tuple[float, DedupeKey, DedupeResult]] = {}
        self._rotations: dict[DedupeKey, SessionRotation] = {}
        self._response_file_states: dict[DedupeKey, str] = {}
        self._lock = threading.Lock()

    @property
    def lease_renew_interval_seconds(self) -> float | None:
        if self._state_store is None:
            return None
        lease_seconds = max(1, int(self._state_store.lease_seconds))
        return max(0.25, lease_seconds / 3)

    def _prune(self, now: float) -> None:
        expired = [
            key for key, (expires, _, _) in self._items.items() if expires <= now
        ]
        for key in expired:
            removed = self._items.pop(key, None)
            if removed is not None:
                self._response_file_states.pop(removed[1], None)
        if len(self._items) <= self.max_entries:
            return
        for key, _ in sorted(self._items.items(), key=lambda item: item[1][0])[
            : len(self._items) - self.max_entries
        ]:
            removed = self._items.pop(key, None)
            if removed is not None:
                self._response_file_states.pop(removed[1], None)

    def claim(
        self,
        session_key: SessionKey,
        external_message_id: str,
        *,
        payload: bytes | str = b"",
    ) -> tuple[bool, DedupeResult | None]:
        key = DedupeKey.from_session(session_key, external_message_id)
        if self._state_store is not None:
            claimed, existing, claim_token = self._state_store.claim_inbox(
                key=session_key,
                external_message_id=external_message_id,
                ttl_seconds=self.ttl_seconds,
                max_entries=self.max_entries,
                payload=payload,
            )
            if claimed and claim_token:
                claims = dict(self._claim_tokens.get() or {})
                claims[key] = claim_token
                self._claim_tokens.set(claims)
            if existing is None:
                return claimed, None
            return claimed, DedupeResult(
                completed=existing.completed,
                text=existing.text,
                status=existing.status,
            )
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            existing = self._items.get(key.external_message_id)
            if existing is not None:
                _, owner, result = existing
                if owner != key:
                    return False, DedupeResult(status="identity_mismatch")
                return False, result
            self._items[key.external_message_id] = (
                now + self.ttl_seconds,
                key,
                DedupeResult(),
            )
            return True, None

    def complete(
        self,
        session_key: SessionKey,
        external_message_id: str,
        *,
        text: str,
        status: str,
    ) -> bool:
        key = DedupeKey.from_session(session_key, external_message_id)
        if self._state_store is not None:
            claim_token = self._claim_token(key)
            if not claim_token:
                return False
            completed = bool(
                self._state_store.complete_inbox(
                    session_key,
                    external_message_id,
                    claim_token=claim_token,
                    text=text,
                    status=status,
                    ttl_seconds=self.ttl_seconds,
                    max_entries=self.max_entries,
                )
            )
            if completed:
                self._discard_claim_token(key, claim_token)
            return completed
        with self._lock:
            now = time.monotonic()
            existing = self._items.get(key.external_message_id)
            if existing is None or existing[1] != key:
                return False
            self._items[key.external_message_id] = (
                now + self.ttl_seconds,
                key,
                DedupeResult(completed=True, text=text, status=status),
            )
            self._prune(now)
            self._rotations.pop(key, None)
            return True

    def renew(self, session_key: SessionKey, external_message_id: str) -> bool:
        key = DedupeKey.from_session(session_key, external_message_id)
        if self._state_store is not None:
            claim_token = (self._claim_tokens.get() or {}).get(key)
            if not claim_token:
                return False
            return bool(
                self._state_store.renew_inbox(
                    session_key,
                    external_message_id,
                    claim_token=claim_token,
                    ttl_seconds=self.ttl_seconds,
                )
            )
        with self._lock:
            existing = self._items.get(key.external_message_id)
            if existing is None or existing[1] != key or existing[2].completed:
                return False
            self._items[key.external_message_id] = (
                time.monotonic() + self.ttl_seconds,
                key,
                existing[2],
            )
            return True

    def forget(self, session_key: SessionKey, external_message_id: str) -> bool:
        key = DedupeKey.from_session(session_key, external_message_id)
        if self._state_store is not None:
            claim_token = self._claim_token(key)
            if not claim_token:
                return False
            forgotten = bool(
                self._state_store.forget_inbox(
                    session_key,
                    external_message_id,
                    claim_token=claim_token,
                )
            )
            if forgotten:
                self._discard_claim_token(key, claim_token)
            return forgotten
        with self._lock:
            existing = self._items.get(key.external_message_id)
            if existing is None or existing[1] != key:
                return False
            self._items.pop(key.external_message_id, None)
            self._rotations.pop(key, None)
            self._response_file_states.pop(key, None)
            return True

    def release(self, session_key: SessionKey, external_message_id: str) -> bool:
        """Make a transiently interrupted claim immediately retryable."""

        key = DedupeKey.from_session(session_key, external_message_id)
        if self._state_store is not None:
            claim_token = self._claim_token(key)
            if not claim_token:
                return False
            released = bool(
                self._state_store.release_inbox(
                    session_key,
                    external_message_id,
                    claim_token=claim_token,
                )
            )
            if released:
                self._discard_claim_token(key, claim_token)
            return released
        with self._lock:
            existing = self._items.get(key.external_message_id)
            if existing is None or existing[1] != key:
                return False
            self._items.pop(key.external_message_id, None)
            return True

    def load_rotation(
        self, session_key: SessionKey, external_message_id: str
    ) -> SessionRotation | None:
        key = DedupeKey.from_session(session_key, external_message_id)
        if self._state_store is not None:
            claim_token = self._claim_token(key)
            if not claim_token:
                return None
            return self._state_store.load_inbox_rotation(
                session_key,
                external_message_id,
                claim_token=claim_token,
            )
        with self._lock:
            return self._rotations.get(key)

    def save_rotation(
        self,
        session_key: SessionKey,
        external_message_id: str,
        rotation: SessionRotation,
    ) -> tuple[SessionRotation, bool]:
        key = DedupeKey.from_session(session_key, external_message_id)
        if self._state_store is not None:
            claim_token = self._claim_token(key)
            if not claim_token:
                raise RuntimeError("WeCom message claim is unavailable")
            return self._state_store.save_inbox_rotation(
                session_key,
                external_message_id,
                claim_token=claim_token,
                rotation=rotation,
            )
        with self._lock:
            existing = self._rotations.get(key)
            if existing is not None:
                return existing, False
            self._rotations[key] = rotation
            return rotation, True

    def begin_response_files(
        self, session_key: SessionKey, external_message_id: str
    ) -> tuple[bool, str]:
        key = DedupeKey.from_session(session_key, external_message_id)
        if self._state_store is not None:
            claim_token = self._claim_token(key)
            if not claim_token:
                raise RuntimeError("WeCom message claim is unavailable")
            return self._state_store.begin_response_files(
                session_key,
                external_message_id,
                claim_token=claim_token,
            )
        with self._lock:
            status = self._response_file_states.get(key, "")
            if not status:
                self._response_file_states[key] = "sending"
                return True, "sending"
            if status == "sending":
                self._response_file_states[key] = "unknown"
                return False, "unknown"
            return False, status

    def finish_response_files(
        self,
        session_key: SessionKey,
        external_message_id: str,
        *,
        status: str,
    ) -> bool:
        key = DedupeKey.from_session(session_key, external_message_id)
        if self._state_store is not None:
            claim_token = self._claim_token(key)
            if not claim_token:
                return False
            return bool(
                self._state_store.finish_response_files(
                    session_key,
                    external_message_id,
                    claim_token=claim_token,
                    status=status,
                )
            )
        with self._lock:
            if self._response_file_states.get(key) != "sending":
                return False
            self._response_file_states[key] = status
            return True

    async def claim_async(
        self,
        session_key: SessionKey,
        external_message_id: str,
        *,
        payload: bytes | str = b"",
    ) -> tuple[bool, DedupeResult | None]:
        if self._state_store is None:
            return self.claim(session_key, external_message_id, payload=payload)
        key = DedupeKey.from_session(session_key, external_message_id)
        claimed, existing, claim_token = await self._state_store.run_async(
            self._state_store.claim_inbox,
            key=session_key,
            external_message_id=external_message_id,
            ttl_seconds=self.ttl_seconds,
            max_entries=self.max_entries,
            payload=payload,
        )
        if claimed and claim_token:
            self._set_claim_token(key, claim_token)
        if existing is None:
            return claimed, None
        return claimed, DedupeResult(
            completed=existing.completed,
            text=existing.text,
            status=existing.status,
        )

    async def complete_async(
        self,
        session_key: SessionKey,
        external_message_id: str,
        *,
        text: str,
        status: str,
    ) -> bool:
        if self._state_store is None:
            return self.complete(
                session_key,
                external_message_id,
                text=text,
                status=status,
            )
        key = DedupeKey.from_session(session_key, external_message_id)
        claim_token = self._claim_token(key)
        if not claim_token:
            return False
        completed = bool(
            await self._state_store.run_async(
                self._state_store.complete_inbox,
                session_key,
                external_message_id,
                claim_token=claim_token,
                text=text,
                status=status,
                ttl_seconds=self.ttl_seconds,
                max_entries=self.max_entries,
            )
        )
        if completed:
            self._discard_claim_token(key, claim_token)
        return completed

    async def renew_async(
        self, session_key: SessionKey, external_message_id: str
    ) -> bool:
        if self._state_store is None:
            return self.renew(session_key, external_message_id)
        key = DedupeKey.from_session(session_key, external_message_id)
        claim_token = self._claim_token(key)
        if not claim_token:
            return False
        return bool(
            await self._state_store.run_async(
                self._state_store.renew_inbox,
                session_key,
                external_message_id,
                claim_token=claim_token,
                ttl_seconds=self.ttl_seconds,
            )
        )

    async def forget_async(
        self, session_key: SessionKey, external_message_id: str
    ) -> bool:
        if self._state_store is None:
            return self.forget(session_key, external_message_id)
        key = DedupeKey.from_session(session_key, external_message_id)
        claim_token = self._claim_token(key)
        if not claim_token:
            return False
        forgotten = bool(
            await self._state_store.run_async(
                self._state_store.forget_inbox,
                session_key,
                external_message_id,
                claim_token=claim_token,
            )
        )
        if forgotten:
            self._discard_claim_token(key, claim_token)
        return forgotten

    async def release_async(
        self, session_key: SessionKey, external_message_id: str
    ) -> bool:
        if self._state_store is None:
            return self.release(session_key, external_message_id)
        key = DedupeKey.from_session(session_key, external_message_id)
        claim_token = self._claim_token(key)
        if not claim_token:
            return False
        released = bool(
            await self._state_store.run_async(
                self._state_store.release_inbox,
                session_key,
                external_message_id,
                claim_token=claim_token,
            )
        )
        if released:
            self._discard_claim_token(key, claim_token)
        return released

    async def load_rotation_async(
        self, session_key: SessionKey, external_message_id: str
    ) -> SessionRotation | None:
        if self._state_store is None:
            return self.load_rotation(session_key, external_message_id)
        key = DedupeKey.from_session(session_key, external_message_id)
        claim_token = self._claim_token(key)
        if not claim_token:
            return None
        return await self._state_store.run_async(
            self._state_store.load_inbox_rotation,
            session_key,
            external_message_id,
            claim_token=claim_token,
        )

    async def bound_session_async(self, session_key: SessionKey, external_message_id: str, session_id: str = "", generation: int = 0):
        if self._state_store is None:
            return (session_id, generation) if session_id else None
        token = self._claim_token(DedupeKey.from_session(session_key, external_message_id))
        if not token:
            raise RuntimeError("WeCom message claim is unavailable")
        return await self._state_store.run_async(
            self._state_store.inbox_session, session_key, external_message_id, token, session_id, generation,
        )

    async def save_rotation_async(
        self,
        session_key: SessionKey,
        external_message_id: str,
        rotation: SessionRotation,
    ) -> tuple[SessionRotation, bool]:
        if self._state_store is None:
            return self.save_rotation(session_key, external_message_id, rotation)
        key = DedupeKey.from_session(session_key, external_message_id)
        claim_token = self._claim_token(key)
        if not claim_token:
            raise RuntimeError("WeCom message claim is unavailable")
        return await self._state_store.run_async(
            self._state_store.save_inbox_rotation,
            session_key,
            external_message_id,
            claim_token=claim_token,
            rotation=rotation,
        )

    async def begin_response_files_async(
        self, session_key: SessionKey, external_message_id: str
    ) -> tuple[bool, str]:
        if self._state_store is None:
            return self.begin_response_files(session_key, external_message_id)
        key = DedupeKey.from_session(session_key, external_message_id)
        claim_token = self._claim_token(key)
        if not claim_token:
            raise RuntimeError("WeCom message claim is unavailable")
        return await self._state_store.run_async(
            self._state_store.begin_response_files,
            session_key,
            external_message_id,
            claim_token=claim_token,
        )

    async def finish_response_files_async(
        self,
        session_key: SessionKey,
        external_message_id: str,
        *,
        status: str,
    ) -> bool:
        if self._state_store is None:
            return self.finish_response_files(
                session_key, external_message_id, status=status
            )
        key = DedupeKey.from_session(session_key, external_message_id)
        claim_token = self._claim_token(key)
        if not claim_token:
            return False
        return bool(
            await self._state_store.run_async(
                self._state_store.finish_response_files,
                session_key,
                external_message_id,
                claim_token=claim_token,
                status=status,
            )
        )

    def _set_claim_token(self, key: DedupeKey, token: str) -> None:
        claims = dict(self._claim_tokens.get() or {})
        claims[key] = token
        self._claim_tokens.set(claims)

    def _claim_token(self, key: DedupeKey) -> str | None:
        return (self._claim_tokens.get() or {}).get(key)

    def _discard_claim_token(self, key: DedupeKey, token: str) -> None:
        claims = dict(self._claim_tokens.get() or {})
        if claims.get(key) == token:
            claims.pop(key, None)
            self._claim_tokens.set(claims)

    def close(self) -> None:
        if self._owns_state_store and self._state_store is not None:
            self._state_store.close()
