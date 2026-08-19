"""Restricted WeCom commands and per-user channel sessions."""

from __future__ import annotations

import asyncio
import contextlib
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
    expected_generation: int | None = None


class SessionLeaseLost(RuntimeError):
    """The process no longer owns the cross-process session lease."""


class SessionSequencer:
    """Serialize a session locally and, when configured, across processes."""

    def __init__(self, *, state_store=None, poll_interval_seconds: float = 0.05):
        self._locks: dict[SessionKey, asyncio.Lock] = {}
        self._lock = threading.Lock()
        self._state_store = state_store
        self._poll_interval_seconds = max(0.01, poll_interval_seconds)

    def _local_lock_for(self, key: SessionKey) -> asyncio.Lock:
        with self._lock:
            lock = self._locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[key] = lock
            return lock

    def lock_for(self, key: SessionKey):
        return _SessionSequenceLock(self, key)


class _SessionSequenceLock:
    def __init__(self, sequencer: SessionSequencer, key: SessionKey):
        self._sequencer = sequencer
        self._key = key
        self._local_lock: asyncio.Lock | None = None
        self._owner_token = uuid.uuid4().hex
        self._lease_stop = asyncio.Event()
        self._lease_changed = asyncio.Event()
        self._lease_task: asyncio.Task[None] | None = None
        self._lease_watchdog_task: asyncio.Task[None] | None = None
        self._lease_deadline = 0.0
        self._lease_error: SessionLeaseLost | None = None
        self._owner_task: asyncio.Task | None = None

    async def __aenter__(self):
        self._local_lock = self._sequencer._local_lock_for(self._key)
        await self._local_lock.acquire()
        state_store = self._sequencer._state_store
        if state_store is None:
            return self
        self._owner_task = asyncio.current_task()
        try:
            while not await state_store.run_async(
                state_store.try_acquire_session_lease,
                self._key,
                owner_token=self._owner_token,
            ):
                await asyncio.sleep(self._sequencer._poll_interval_seconds)
            self._lease_deadline = (
                asyncio.get_running_loop().time() + state_store.lease_seconds
            )
            self._lease_task = asyncio.create_task(
                self._renew_lease(),
                name="arcforge-wecom-session-lease",
            )
            self._lease_watchdog_task = asyncio.create_task(
                self._watch_lease(),
                name="arcforge-wecom-session-lease-watchdog",
            )
            return self
        except BaseException:
            if state_store is not None:
                with contextlib.suppress(Exception, asyncio.CancelledError):
                    await asyncio.shield(
                        state_store.run_async(
                            state_store.release_session_lease,
                            self._key,
                            owner_token=self._owner_token,
                        )
                    )
            self._local_lock.release()
            self._local_lock = None
            raise

    async def _renew_lease(self) -> None:
        state_store = self._sequencer._state_store
        interval = max(0.25, state_store.lease_seconds / 3)
        retry_interval = min(interval, self._sequencer._poll_interval_seconds)
        next_interval = interval
        while not self._lease_stop.is_set():
            try:
                await asyncio.wait_for(self._lease_stop.wait(), timeout=next_interval)
                return
            except asyncio.TimeoutError:
                pass
            try:
                renewed = await state_store.run_async(
                    state_store.renew_session_lease,
                    self._key,
                    owner_token=self._owner_token,
                )
            except Exception:
                next_interval = retry_interval
                continue
            if not renewed:
                self._mark_lease_lost("WeCom session lease ownership changed")
                return
            self._lease_deadline = (
                asyncio.get_running_loop().time() + state_store.lease_seconds
            )
            self._lease_changed.set()
            next_interval = interval

    async def _watch_lease(self) -> None:
        state_store = self._sequencer._state_store
        safety_margin = min(1.0, max(0.05, state_store.lease_seconds / 4))
        while not self._lease_stop.is_set() and self._lease_error is None:
            remaining = (
                self._lease_deadline
                - safety_margin
                - asyncio.get_running_loop().time()
            )
            if remaining <= 0:
                self._mark_lease_lost("WeCom session lease renewal deadline expired")
                return
            self._lease_changed.clear()
            try:
                await asyncio.wait_for(self._lease_changed.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                if (
                    asyncio.get_running_loop().time()
                    < self._lease_deadline - safety_margin
                ):
                    continue
                self._mark_lease_lost("WeCom session lease renewal deadline expired")
                return

    def _mark_lease_lost(self, message: str) -> None:
        if self._lease_error is not None or self._lease_stop.is_set():
            return
        self._lease_error = SessionLeaseLost(message)
        self._lease_changed.set()
        owner = self._owner_task
        if owner is not None and not owner.done():
            owner.cancel()

    def ensure_owned(self) -> None:
        if self._lease_error is not None:
            raise self._lease_error

    async def __aexit__(self, _exc_type, _exc, _traceback) -> None:
        state_store = self._sequencer._state_store
        try:
            self._lease_stop.set()
            self._lease_changed.set()
            if self._lease_task is not None:
                with contextlib.suppress(asyncio.CancelledError):
                    await self._lease_task
            if self._lease_watchdog_task is not None:
                with contextlib.suppress(asyncio.CancelledError):
                    await self._lease_watchdog_task
            if state_store is not None:
                with contextlib.suppress(Exception):
                    await state_store.run_async(
                        state_store.release_session_lease,
                        self._key,
                        owner_token=self._owner_token,
                    )
        finally:
            if self._local_lock is not None:
                self._local_lock.release()
                self._local_lock = None
        if self._lease_error is not None:
            raise self._lease_error from _exc


class SessionStore:
    """Keep one stable session per WeCom user/chat scope.

    Methods are synchronous and protected by a lock so callers from asyncio
    tasks and worker threads observe atomic creation and rotation.
    """

    def __init__(
        self,
        id_factory: Callable[[], str] | None = None,
        *,
        state_store=None,
        db_path=None,
        installation_id: str = "wecom-default",
    ):
        self._id_factory = id_factory or (lambda: uuid.uuid4().hex)
        self._owns_state_store = state_store is None and bool(db_path)
        if state_store is None and db_path:
            from .state_store import SQLiteStateStore

            state_store = SQLiteStateStore(db_path, installation_id=installation_id)
        self._state_store = state_store
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
        if self._state_store is not None:
            return self._state_store.get_session(key, self._new_id)
        with self._lock:
            session_id = self._sessions.get(key)
            if session_id is None:
                session_id = self._new_id()
                self._sessions[key] = session_id
            return session_id

    async def get_for_key_async(self, key: SessionKey) -> str:
        if self._state_store is None:
            return self.get_for_key(key)
        return await self._state_store.run_async(
            self._state_store.get_session,
            key,
            self._new_id,
        )

    def reserve_rotation(self, key: SessionKey) -> SessionRotation:
        """Create a candidate without changing the session visible to readers."""

        if self._state_store is not None:
            return self._state_store.reserve_rotation(key, self._new_id)
        with self._lock:
            current = self._sessions.get(key)
            candidate = self._new_id()
            if candidate == current:
                raise ValueError("session id factory returned the current session id")
            return SessionRotation(key, current, candidate)

    async def reserve_rotation_async(self, key: SessionKey) -> SessionRotation:
        if self._state_store is None:
            return self.reserve_rotation(key)
        return await self._state_store.run_async(
            self._state_store.reserve_rotation,
            key,
            self._new_id,
        )

    def commit_rotation(self, rotation: SessionRotation) -> bool:
        """Commit a reservation only if its observed session is still current."""

        if self._state_store is not None:
            return self._state_store.commit_rotation(rotation)
        with self._lock:
            current = self._sessions.get(rotation.key)
            if current == rotation.candidate_session_id:
                return True
            if current != rotation.expected_session_id:
                return False
            self._sessions[rotation.key] = rotation.candidate_session_id
            return True

    async def commit_rotation_async(self, rotation: SessionRotation) -> bool:
        if self._state_store is None:
            return self.commit_rotation(rotation)
        return bool(
            await self._state_store.run_async(
                self._state_store.commit_rotation,
                rotation,
            )
        )

    def rotate(self, *, chat_type: str, chat_id: str, external_user_id: str) -> str:
        """Atomically rotate a session for callers that do not need rollback."""

        key = self.key(
            chat_type=chat_type,
            chat_id=chat_id,
            external_user_id=external_user_id,
        )
        if self._state_store is not None:
            return self._state_store.rotate(key, self._new_id)
        with self._lock:
            session_id = self._new_id()
            self._sessions[key] = session_id
            return session_id

    def _new_id(self) -> str:
        session_id = self._id_factory().strip()
        if not session_id:
            raise ValueError("session id factory returned an empty value")
        return session_id

    def close(self) -> None:
        if self._owns_state_store and self._state_store is not None:
            self._state_store.close()
