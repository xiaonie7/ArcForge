"""Durable SQLite state for the WeCom connector.

The connector deliberately keeps this store small and self contained.  A
single process may share it between worker threads and a second process can
open the same file; SQLite's transactional uniqueness provides the cross
process claim/CAS guarantees.
"""

from __future__ import annotations

import hashlib
import asyncio
import functools
import secrets
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from .commands import SessionKey, SessionRotation


def utc_now_ms() -> int:
    return time.time_ns() // 1_000_000


@dataclass(frozen=True)
class InboxResult:
    completed: bool
    text: str
    status: str


class SQLiteStateStore:
    """SQLite-backed sessions and durable callback inbox."""

    schema_version = 4

    def __init__(
        self,
        path: str | Path,
        *,
        installation_id: str = "wecom-default",
        lease_seconds: int = 120,
    ):
        self.path = str(Path(path).expanduser())
        self.installation_id = installation_id.strip() or "wecom-default"
        self.lease_seconds = max(1, int(lease_seconds))
        self._lock = threading.RLock()
        self._close_lock = threading.Lock()
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, timeout=5.0, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._migrate()
        self._executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="arcforge-wecom-state",
        )
        self._close_future = None
        self._closing_executor = None

    def _migrate(self) -> None:
        with self._lock, self._db:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            self._db.execute(
                """CREATE TABLE IF NOT EXISTS channel_sessions (
                    installation_id TEXT NOT NULL,
                    scope_mode TEXT NOT NULL DEFAULT 'direct',
                    chat_type TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    external_user_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    generation INTEGER NOT NULL DEFAULT 1,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (installation_id, scope_mode, chat_type, chat_id, external_user_id),
                    UNIQUE (installation_id, session_id)
                )"""
            )
            session_columns = {
                str(row[1])
                for row in self._db.execute("PRAGMA table_info(channel_sessions)")
            }
            if "generation" not in session_columns:
                self._db.execute(
                    "ALTER TABLE channel_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1"
                )

            inbox_columns = self._db.execute(
                "PRAGMA table_info(channel_inbox)"
            ).fetchall()
            if not inbox_columns:
                self._create_inbox_table()
            else:
                primary_key = [
                    str(row[1])
                    for row in sorted(inbox_columns, key=lambda row: int(row[5]))
                    if int(row[5]) > 0
                ]
                if primary_key != ["installation_id", "external_message_id"]:
                    self._migrate_inbox_to_installation_message_key()
            inbox_column_names = {
                str(row[1])
                for row in self._db.execute("PRAGMA table_info(channel_inbox)")
            }
            for column, definition in (
                ("rotation_expected_session_id", "TEXT"),
                ("rotation_candidate_session_id", "TEXT"),
                ("rotation_expected_generation", "INTEGER"),
                ("response_files_status", "TEXT NOT NULL DEFAULT ''"),
            ):
                if column not in inbox_column_names:
                    self._db.execute(
                        f"ALTER TABLE channel_inbox ADD COLUMN {column} {definition}"
                    )
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS idx_channel_inbox_expiry ON channel_inbox(expires_at_ms)"
            )
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS idx_channel_inbox_installation_updated "
                "ON channel_inbox(installation_id, updated_at_ms)"
            )
            self._db.execute(
                """CREATE TABLE IF NOT EXISTS channel_session_leases (
                    installation_id TEXT NOT NULL,
                    scope_mode TEXT NOT NULL,
                    chat_type TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    external_user_id TEXT NOT NULL,
                    owner_token TEXT NOT NULL,
                    lease_until_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (
                        installation_id, scope_mode, chat_type, chat_id,
                        external_user_id
                    )
                )"""
            )
            self._db.execute(
                "INSERT INTO schema_meta(key,value) VALUES('channel_state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(self.schema_version),),
            )

    def _create_inbox_table(self) -> None:
        self._db.execute(
            """CREATE TABLE channel_inbox (
                installation_id TEXT NOT NULL,
                chat_type TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                external_user_id TEXT NOT NULL,
                external_message_id TEXT NOT NULL,
                payload_hash TEXT NOT NULL DEFAULT '',
                state TEXT NOT NULL CHECK(state IN ('processing','completed','failed','unknown')),
                claim_token TEXT,
                lease_until_ms INTEGER,
                attempt_count INTEGER NOT NULL DEFAULT 1,
                response_text TEXT NOT NULL DEFAULT '',
                response_status TEXT NOT NULL DEFAULT '',
                rotation_expected_session_id TEXT,
                rotation_candidate_session_id TEXT,
                rotation_expected_generation INTEGER,
                response_files_status TEXT NOT NULL DEFAULT '',
                received_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL,
                PRIMARY KEY (installation_id, external_message_id)
            )"""
        )

    def _migrate_inbox_to_installation_message_key(self) -> None:
        self._db.execute("ALTER TABLE channel_inbox RENAME TO channel_inbox_v1")
        self._create_inbox_table()
        self._db.execute(
            """WITH ranked AS (
                SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY installation_id, external_message_id
                    ORDER BY
                        CASE state
                            WHEN 'completed' THEN 0
                            WHEN 'failed' THEN 1
                            WHEN 'unknown' THEN 2
                            ELSE 3
                        END,
                        updated_at_ms DESC,
                        rowid DESC
                ) AS canonical_rank
                FROM channel_inbox_v1
            )
            INSERT INTO channel_inbox(
                installation_id,chat_type,chat_id,external_user_id,
                external_message_id,payload_hash,state,claim_token,
                lease_until_ms,attempt_count,response_text,response_status,
                received_at_ms,updated_at_ms,expires_at_ms
            )
            SELECT
                installation_id,chat_type,chat_id,external_user_id,
                external_message_id,payload_hash,state,claim_token,
                lease_until_ms,attempt_count,response_text,response_status,
                received_at_ms,updated_at_ms,expires_at_ms
            FROM ranked WHERE canonical_rank=1"""
        )
        self._db.execute("DROP TABLE channel_inbox_v1")

    @staticmethod
    def _session_values(key: SessionKey) -> tuple[str, str, str, str]:
        return (
            key.chat_type,
            key.chat_id,
            key.external_user_id,
            "direct" if key.chat_type == "single" else "group_per_user",
        )

    def get_session(self, key: SessionKey, id_factory) -> str:
        chat_type, chat_id, user_id, scope = self._session_values(key)
        now = utc_now_ms()
        with self._lock, self._db:
            row = self._db.execute(
                "SELECT session_id FROM channel_sessions WHERE installation_id=? AND scope_mode=? AND chat_type=? AND chat_id=? AND external_user_id=?",
                (self.installation_id, scope, chat_type, chat_id, user_id),
            ).fetchone()
            if row:
                return str(row[0])
            session_id = id_factory()
            self._db.execute(
                "INSERT OR IGNORE INTO channel_sessions(installation_id,scope_mode,chat_type,chat_id,external_user_id,session_id,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)",
                (
                    self.installation_id,
                    scope,
                    chat_type,
                    chat_id,
                    user_id,
                    session_id,
                    now,
                    now,
                ),
            )
            row = self._db.execute(
                "SELECT session_id FROM channel_sessions WHERE installation_id=? AND scope_mode=? AND chat_type=? AND chat_id=? AND external_user_id=?",
                (self.installation_id, scope, chat_type, chat_id, user_id),
            ).fetchone()
            if row is None:
                raise ValueError("session id factory returned an existing session id")
            return str(row[0])

    def reserve_rotation(self, key: SessionKey, id_factory) -> SessionRotation:
        self.get_session(key, id_factory)
        chat_type, chat_id, user_id, scope = self._session_values(key)
        with self._lock:
            row = self._db.execute(
                "SELECT session_id,generation FROM channel_sessions WHERE installation_id=? AND scope_mode=? AND chat_type=? AND chat_id=? AND external_user_id=?",
                (self.installation_id, scope, chat_type, chat_id, user_id),
            ).fetchone()
        if row is None:
            raise RuntimeError(
                "durable session row disappeared during rotation reservation"
            )
        current = str(row[0])
        generation = int(row[1])
        candidate = id_factory()
        if candidate == current:
            raise ValueError("session id factory returned the current session id")
        return SessionRotation(key, current, candidate, generation)

    def commit_rotation(self, rotation: SessionRotation) -> bool:
        chat_type, chat_id, user_id, scope = self._session_values(rotation.key)
        if rotation.expected_generation is None:
            return False
        now = utc_now_ms()
        with self._lock, self._db:
            if rotation.expected_session_id is None:
                cur = self._db.execute(
                    "UPDATE channel_sessions SET session_id=?,generation=generation+1,updated_at_ms=? WHERE installation_id=? AND scope_mode=? AND chat_type=? AND chat_id=? AND external_user_id=? AND session_id IS NULL AND generation=?",
                    (
                        rotation.candidate_session_id,
                        now,
                        self.installation_id,
                        scope,
                        chat_type,
                        chat_id,
                        user_id,
                        rotation.expected_generation,
                    ),
                )
            else:
                cur = self._db.execute(
                    "UPDATE channel_sessions SET session_id=?,generation=generation+1,updated_at_ms=? WHERE installation_id=? AND scope_mode=? AND chat_type=? AND chat_id=? AND external_user_id=? AND session_id=? AND generation=?",
                    (
                        rotation.candidate_session_id,
                        now,
                        self.installation_id,
                        scope,
                        chat_type,
                        chat_id,
                        user_id,
                        rotation.expected_session_id,
                        rotation.expected_generation,
                    ),
                )
            if cur.rowcount == 1:
                return True
            row = self._db.execute(
                "SELECT session_id,generation FROM channel_sessions WHERE "
                "installation_id=? AND scope_mode=? AND chat_type=? AND chat_id=? "
                "AND external_user_id=?",
                (
                    self.installation_id,
                    scope,
                    chat_type,
                    chat_id,
                    user_id,
                ),
            ).fetchone()
            return bool(
                row is not None
                and str(row[0]) == rotation.candidate_session_id
                and int(row[1]) == rotation.expected_generation + 1
            )

    def rotate(self, key: SessionKey, id_factory) -> str:
        while True:
            rotation = self.reserve_rotation(key, id_factory)
            if self.commit_rotation(rotation):
                return rotation.candidate_session_id

    def claim_inbox(
        self,
        key: SessionKey,
        external_message_id: str,
        *,
        ttl_seconds: int,
        max_entries: int,
        payload: bytes | str = b"",
    ) -> tuple[bool, InboxResult | None, str | None]:
        message_id = external_message_id.strip()
        if not message_id:
            raise ValueError("external_message_id is required")
        payload_bytes = payload.encode() if isinstance(payload, str) else payload
        payload_hash = hashlib.sha256(payload_bytes).hexdigest()
        chat_type, chat_id, user_id, _ = self._session_values(key)
        now = utc_now_ms()
        lease = now + self.lease_seconds * 1000
        expires = max(now + max(1, int(ttl_seconds)) * 1000, lease)
        token = secrets.token_hex(16)
        params = (self.installation_id, message_id)
        with self._lock, self._db:
            self._prune_inbox_locked(
                now=now,
                max_entries=max_entries,
                protected_message_id=message_id,
            )
            inserted = self._db.execute(
                "INSERT OR IGNORE INTO channel_inbox(installation_id,chat_type,chat_id,external_user_id,external_message_id,payload_hash,state,claim_token,lease_until_ms,received_at_ms,updated_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    self.installation_id,
                    chat_type,
                    chat_id,
                    user_id,
                    message_id,
                    payload_hash,
                    "processing",
                    token,
                    lease,
                    now,
                    now,
                    expires,
                ),
            )
            if inserted.rowcount == 1:
                return True, None, token
            row = self._db.execute(
                "SELECT state,claim_token,lease_until_ms,response_text,response_status,payload_hash,chat_type,chat_id,external_user_id FROM channel_inbox WHERE installation_id=? AND external_message_id=?",
                params,
            ).fetchone()
            if row is None:
                raise RuntimeError("durable inbox row disappeared during claim")
            if (str(row[6]), str(row[7]), str(row[8])) != (
                chat_type,
                chat_id,
                user_id,
            ):
                return (
                    False,
                    InboxResult(
                        completed=False,
                        text="",
                        status="identity_mismatch",
                    ),
                    None,
                )
            if str(row[5]) != payload_hash:
                return (
                    False,
                    InboxResult(
                        completed=False,
                        text="",
                        status="payload_mismatch",
                    ),
                    None,
                )
            if row[0] == "processing" and (row[2] is None or int(row[2]) <= now):
                reclaimed = self._db.execute(
                    "UPDATE channel_inbox SET state='processing',claim_token=?,lease_until_ms=?,attempt_count=attempt_count+1,updated_at_ms=?,expires_at_ms=?,payload_hash=? WHERE installation_id=? AND external_message_id=? AND chat_type=? AND chat_id=? AND external_user_id=? AND state='processing' AND claim_token IS ? AND lease_until_ms IS ?",
                    (
                        token,
                        lease,
                        now,
                        expires,
                        payload_hash,
                        *params,
                        chat_type,
                        chat_id,
                        user_id,
                        row[1],
                        row[2],
                    ),
                )
                if reclaimed.rowcount == 1:
                    return True, None, token
                row = self._db.execute(
                    "SELECT state,claim_token,lease_until_ms,response_text,response_status,payload_hash,chat_type,chat_id,external_user_id FROM channel_inbox WHERE installation_id=? AND external_message_id=?",
                    params,
                ).fetchone()
                if row is None:
                    raise RuntimeError(
                        "durable inbox row disappeared during lease reclaim"
                    )
            return (
                False,
                InboxResult(
                    completed=row[0] in {"completed", "failed", "unknown"},
                    text=str(row[3] or ""),
                    status=str(row[4] or ""),
                ),
                None,
            )

    def _prune_inbox_locked(
        self,
        *,
        now: int,
        max_entries: int,
        protected_message_id: str,
    ) -> None:
        cleanup_batch = 256
        self._db.execute(
            "DELETE FROM channel_inbox WHERE rowid IN ("
            "SELECT rowid FROM channel_inbox WHERE installation_id=? "
            "AND expires_at_ms<=? AND (state<>'processing' OR lease_until_ms IS NULL "
            "OR lease_until_ms<=?) ORDER BY expires_at_ms LIMIT ?)",
            (self.installation_id, now, now, cleanup_batch),
        )
        row = self._db.execute(
            "SELECT COUNT(*) FROM channel_inbox WHERE installation_id=?",
            (self.installation_id,),
        ).fetchone()
        overflow = max(0, int(row[0] if row else 0) - max(1, int(max_entries)) + 1)
        if overflow:
            self._db.execute(
                "DELETE FROM channel_inbox WHERE rowid IN ("
                "SELECT rowid FROM channel_inbox WHERE installation_id=? "
                "AND external_message_id<>? AND state<>'processing' "
                "ORDER BY expires_at_ms,updated_at_ms LIMIT ?)",
                (
                    self.installation_id,
                    protected_message_id,
                    min(overflow, cleanup_batch),
                ),
            )

    def renew_inbox(
        self,
        key: SessionKey,
        external_message_id: str,
        *,
        claim_token: str,
        ttl_seconds: int,
    ) -> bool:
        chat_type, chat_id, user_id, _ = self._session_values(key)
        now = utc_now_ms()
        lease = now + self.lease_seconds * 1000
        expires = max(now + max(1, int(ttl_seconds)) * 1000, lease)
        with self._lock, self._db:
            cursor = self._db.execute(
                "UPDATE channel_inbox SET lease_until_ms=?,updated_at_ms=?,"
                "expires_at_ms=MAX(expires_at_ms,?) WHERE installation_id=? "
                "AND external_message_id=? AND chat_type=? AND chat_id=? "
                "AND external_user_id=? AND state='processing' AND claim_token=?",
                (
                    lease,
                    now,
                    expires,
                    self.installation_id,
                    external_message_id.strip(),
                    chat_type,
                    chat_id,
                    user_id,
                    claim_token,
                ),
            )
            return cursor.rowcount == 1

    def load_inbox_rotation(
        self,
        key: SessionKey,
        external_message_id: str,
        *,
        claim_token: str,
    ) -> SessionRotation | None:
        chat_type, chat_id, user_id, _ = self._session_values(key)
        with self._lock:
            row = self._db.execute(
                "SELECT rotation_expected_session_id,rotation_candidate_session_id,"
                "rotation_expected_generation FROM channel_inbox WHERE installation_id=? "
                "AND external_message_id=? AND chat_type=? AND chat_id=? "
                "AND external_user_id=? AND state='processing' AND claim_token=?",
                (
                    self.installation_id,
                    external_message_id.strip(),
                    chat_type,
                    chat_id,
                    user_id,
                    claim_token,
                ),
            ).fetchone()
        if row is None or row[1] is None:
            return None
        return SessionRotation(
            key=key,
            expected_session_id=None if row[0] is None else str(row[0]),
            candidate_session_id=str(row[1]),
            expected_generation=None if row[2] is None else int(row[2]),
        )

    def save_inbox_rotation(
        self,
        key: SessionKey,
        external_message_id: str,
        *,
        claim_token: str,
        rotation: SessionRotation,
    ) -> tuple[SessionRotation, bool]:
        if rotation.key != key:
            raise ValueError("rotation belongs to another session")
        chat_type, chat_id, user_id, _ = self._session_values(key)
        with self._lock, self._db:
            cursor = self._db.execute(
                "UPDATE channel_inbox SET rotation_expected_session_id=?,"
                "rotation_candidate_session_id=?,rotation_expected_generation=?,"
                "updated_at_ms=? WHERE installation_id=? AND external_message_id=? "
                "AND chat_type=? AND chat_id=? AND external_user_id=? "
                "AND state='processing' AND claim_token=? "
                "AND rotation_candidate_session_id IS NULL",
                (
                    rotation.expected_session_id,
                    rotation.candidate_session_id,
                    rotation.expected_generation,
                    utc_now_ms(),
                    self.installation_id,
                    external_message_id.strip(),
                    chat_type,
                    chat_id,
                    user_id,
                    claim_token,
                ),
            )
            stored = self._db.execute(
                "SELECT rotation_expected_session_id,rotation_candidate_session_id,"
                "rotation_expected_generation FROM channel_inbox WHERE installation_id=? "
                "AND external_message_id=? AND chat_type=? AND chat_id=? "
                "AND external_user_id=? AND state='processing' AND claim_token=?",
                (
                    self.installation_id,
                    external_message_id.strip(),
                    chat_type,
                    chat_id,
                    user_id,
                    claim_token,
                ),
            ).fetchone()
            if stored is None or stored[1] is None:
                raise RuntimeError(
                    "WeCom message lease changed before rotation persistence"
                )
            return (
                SessionRotation(
                    key=key,
                    expected_session_id=None if stored[0] is None else str(stored[0]),
                    candidate_session_id=str(stored[1]),
                    expected_generation=None if stored[2] is None else int(stored[2]),
                ),
                cursor.rowcount == 1,
            )

    def begin_response_files(
        self,
        key: SessionKey,
        external_message_id: str,
        *,
        claim_token: str,
    ) -> tuple[bool, str]:
        """Fence a non-idempotent file batch before calling WeCom."""

        chat_type, chat_id, user_id, _ = self._session_values(key)
        identity = (
            self.installation_id,
            external_message_id.strip(),
            chat_type,
            chat_id,
            user_id,
            claim_token,
        )
        with self._lock, self._db:
            row = self._db.execute(
                "SELECT response_files_status FROM channel_inbox WHERE "
                "installation_id=? AND external_message_id=? AND chat_type=? "
                "AND chat_id=? AND external_user_id=? AND state='processing' "
                "AND claim_token=?",
                identity,
            ).fetchone()
            if row is None:
                raise RuntimeError("WeCom message lease changed before file delivery")
            status = str(row[0] or "")
            if not status:
                cursor = self._db.execute(
                    "UPDATE channel_inbox SET response_files_status='sending',updated_at_ms=? "
                    "WHERE installation_id=? AND external_message_id=? AND chat_type=? "
                    "AND chat_id=? AND external_user_id=? AND state='processing' "
                    "AND claim_token=? AND response_files_status=''",
                    (utc_now_ms(), *identity),
                )
                if cursor.rowcount != 1:
                    raise RuntimeError("WeCom file delivery state changed concurrently")
                return True, "sending"
            if status == "sending":
                cursor = self._db.execute(
                    "UPDATE channel_inbox SET response_files_status='unknown',updated_at_ms=? "
                    "WHERE installation_id=? AND external_message_id=? AND chat_type=? "
                    "AND chat_id=? AND external_user_id=? AND state='processing' "
                    "AND claim_token=? AND response_files_status='sending'",
                    (utc_now_ms(), *identity),
                )
                if cursor.rowcount != 1:
                    raise RuntimeError("WeCom file delivery state changed concurrently")
                return False, "unknown"
            return False, status

    def finish_response_files(
        self,
        key: SessionKey,
        external_message_id: str,
        *,
        claim_token: str,
        status: str,
    ) -> bool:
        if status not in {"sent", "failed"}:
            raise ValueError("response file status must be sent or failed")
        chat_type, chat_id, user_id, _ = self._session_values(key)
        with self._lock, self._db:
            cursor = self._db.execute(
                "UPDATE channel_inbox SET response_files_status=?,updated_at_ms=? "
                "WHERE installation_id=? AND external_message_id=? AND chat_type=? "
                "AND chat_id=? AND external_user_id=? AND state='processing' "
                "AND claim_token=? AND response_files_status='sending'",
                (
                    status,
                    utc_now_ms(),
                    self.installation_id,
                    external_message_id.strip(),
                    chat_type,
                    chat_id,
                    user_id,
                    claim_token,
                ),
            )
            return cursor.rowcount == 1

    def complete_inbox(
        self,
        key: SessionKey,
        external_message_id: str,
        *,
        claim_token: str,
        text: str,
        status: str,
        ttl_seconds: int,
        max_entries: int,
    ) -> bool:
        chat_type, chat_id, user_id, _ = self._session_values(key)
        now = utc_now_ms()
        terminal_state = (
            status if status in {"completed", "failed", "unknown"} else "failed"
        )
        with self._lock, self._db:
            cursor = self._db.execute(
                "UPDATE channel_inbox SET state=?,claim_token=NULL,lease_until_ms=NULL,response_text=?,response_status=?,updated_at_ms=?,expires_at_ms=? WHERE installation_id=? AND external_message_id=? AND chat_type=? AND chat_id=? AND external_user_id=? AND state='processing' AND claim_token=?",
                (
                    terminal_state,
                    text,
                    status,
                    now,
                    now + max(1, int(ttl_seconds)) * 1000,
                    self.installation_id,
                    external_message_id.strip(),
                    chat_type,
                    chat_id,
                    user_id,
                    claim_token,
                ),
            )
            completed = cursor.rowcount == 1
            if completed:
                self._prune_inbox_locked(
                    now=now,
                    max_entries=max(1, int(max_entries)) + 1,
                    protected_message_id=external_message_id.strip(),
                )
            return completed

    def forget_inbox(
        self, key: SessionKey, external_message_id: str, *, claim_token: str
    ) -> bool:
        chat_type, chat_id, user_id, _ = self._session_values(key)
        with self._lock, self._db:
            cursor = self._db.execute(
                "DELETE FROM channel_inbox WHERE installation_id=? AND external_message_id=? AND chat_type=? AND chat_id=? AND external_user_id=? AND state='processing' AND claim_token=?",
                (
                    self.installation_id,
                    external_message_id.strip(),
                    chat_type,
                    chat_id,
                    user_id,
                    claim_token,
                ),
            )
            return cursor.rowcount == 1

    def release_inbox(
        self, key: SessionKey, external_message_id: str, *, claim_token: str
    ) -> bool:
        """Release a transiently interrupted claim without losing retry metadata."""

        chat_type, chat_id, user_id, _ = self._session_values(key)
        with self._lock, self._db:
            cursor = self._db.execute(
                "UPDATE channel_inbox SET claim_token=NULL,lease_until_ms=0,"
                "updated_at_ms=? WHERE installation_id=? AND external_message_id=? "
                "AND chat_type=? AND chat_id=? AND external_user_id=? "
                "AND state='processing' AND claim_token=?",
                (
                    utc_now_ms(),
                    self.installation_id,
                    external_message_id.strip(),
                    chat_type,
                    chat_id,
                    user_id,
                    claim_token,
                ),
            )
            return cursor.rowcount == 1

    def try_acquire_session_lease(self, key: SessionKey, *, owner_token: str) -> bool:
        chat_type, chat_id, user_id, scope = self._session_values(key)
        now = utc_now_ms()
        lease_until = now + self.lease_seconds * 1000
        with self._lock, self._db:
            cursor = self._db.execute(
                """INSERT INTO channel_session_leases(
                    installation_id,scope_mode,chat_type,chat_id,external_user_id,
                    owner_token,lease_until_ms,updated_at_ms
                ) VALUES(?,?,?,?,?,?,?,?)
                ON CONFLICT(
                    installation_id,scope_mode,chat_type,chat_id,external_user_id
                ) DO UPDATE SET
                    owner_token=excluded.owner_token,
                    lease_until_ms=excluded.lease_until_ms,
                    updated_at_ms=excluded.updated_at_ms
                WHERE channel_session_leases.lease_until_ms<=?
                   OR channel_session_leases.owner_token=excluded.owner_token""",
                (
                    self.installation_id,
                    scope,
                    chat_type,
                    chat_id,
                    user_id,
                    owner_token,
                    lease_until,
                    now,
                    now,
                ),
            )
            return cursor.rowcount == 1

    def renew_session_lease(self, key: SessionKey, *, owner_token: str) -> bool:
        chat_type, chat_id, user_id, scope = self._session_values(key)
        now = utc_now_ms()
        with self._lock, self._db:
            cursor = self._db.execute(
                "UPDATE channel_session_leases SET lease_until_ms=?,updated_at_ms=? "
                "WHERE installation_id=? AND scope_mode=? AND chat_type=? "
                "AND chat_id=? AND external_user_id=? AND owner_token=?",
                (
                    now + self.lease_seconds * 1000,
                    now,
                    self.installation_id,
                    scope,
                    chat_type,
                    chat_id,
                    user_id,
                    owner_token,
                ),
            )
            return cursor.rowcount == 1

    def release_session_lease(self, key: SessionKey, *, owner_token: str) -> bool:
        chat_type, chat_id, user_id, scope = self._session_values(key)
        with self._lock, self._db:
            cursor = self._db.execute(
                "DELETE FROM channel_session_leases WHERE installation_id=? "
                "AND scope_mode=? AND chat_type=? AND chat_id=? "
                "AND external_user_id=? AND owner_token=?",
                (
                    self.installation_id,
                    scope,
                    chat_type,
                    chat_id,
                    user_id,
                    owner_token,
                ),
            )
            return cursor.rowcount == 1

    async def run_async(self, function, /, *args, **kwargs):
        operation = functools.partial(function, *args, **kwargs)
        with self._close_lock:
            executor = self._executor
            if executor is None:
                raise RuntimeError("WeCom state store is closed")
            future = executor.submit(operation)
        return await asyncio.wrap_future(future)

    async def close_async(self) -> None:
        future, executor = self._begin_close()
        if future is None or executor is None:
            return
        await asyncio.shield(asyncio.wrap_future(future))

    def _begin_close(self):
        with self._close_lock:
            if self._close_future is not None:
                return self._close_future, self._closing_executor
            executor = self._executor
            if executor is None:
                return None, None
            self._executor = None
            self._closing_executor = executor
            self._close_future = executor.submit(self._close_db)
            executor.shutdown(wait=False)
            return self._close_future, executor

    def _close_db(self) -> None:
        with self._lock:
            database = self._db
            if database is None:
                return
            self._db = None
            database.close()

    def close(self) -> None:
        future, executor = self._begin_close()
        if future is None or executor is None:
            return
        future.result()
