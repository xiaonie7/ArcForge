//! Conversation lifecycle facts live beside history, never in a UI cache.
//!
//! Every admission and archive preparation takes an IMMEDIATE transaction on
//! the same database. Runtime and queue guards never expire; renderer-owned
//! editing guards use a short renewable lease so a crashed tab cannot block
//! automatic archive forever.

use chrono::{DateTime, Days, LocalResult, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

use crate::commands::{chat_history, history_db};
use crate::runtime::project_path::project_path_key;

const EDITING_ADMISSION_LEASE_MS: i64 = 90_000;

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    Sha256::digest(value.as_ref())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMutationInput {
    pub id: String,
    pub operation_id: String,
    pub expected_lifecycle_version: i64,
    pub expected_activity_version: Option<i64>,
    pub reason: Option<String>,
    pub policy_revision: Option<i64>,
    pub scheduled_for_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleOperation {
    pub operation_id: String,
    pub conversation_id: String,
    pub kind: String,
    pub status: String,
    pub expected_lifecycle_version: i64,
    pub expected_activity_version: i64,
    pub reason: String,
    pub policy_revision: Option<i64>,
    pub scheduled_for_at: Option<i64>,
    pub binding_snapshot_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationLifecycleMeta {
    pub conversation_id: String,
    pub archived_at: Option<i64>,
    pub archive_reason: Option<String>,
    pub unarchived_at: Option<i64>,
    pub lifecycle_version: i64,
    pub last_user_message_at: Option<i64>,
    pub last_turn_finished_at: Option<i64>,
    pub activity_version: i64,
    pub auto_archive_exempt: bool,
    pub origin_source_id: Option<String>,
    pub is_pinned: bool,
    pub cwd: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAdmission {
    pub token: String,
    pub conversation_id: String,
    pub phase: String,
    pub origin_source_id: Option<String>,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePolicy {
    pub enabled: bool,
    pub mode: String,
    pub idle_minutes: i64,
    pub daily_time: String,
    pub time_zone: String,
    pub minimum_idle_minutes: i64,
    pub source_mode: String,
    pub source_ids: Vec<String>,
    pub project_mode: String,
    pub project_paths: Vec<String>,
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub updated_at: i64,
}

impl Default for ArchivePolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: "idle".into(),
            idle_minutes: 480,
            daily_time: "04:00".into(),
            time_zone: iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into()),
            minimum_idle_minutes: 120,
            source_mode: "all".into(),
            source_ids: Vec::new(),
            project_mode: "all".into(),
            project_paths: Vec::new(),
            revision: 0,
            updated_at: 0,
        }
    }
}

pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversationLifecycleOperation (
            operation_id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            expected_lifecycle_version INTEGER NOT NULL,
            expected_activity_version INTEGER NOT NULL,
            reason TEXT NOT NULL,
            policy_revision INTEGER,
            scheduled_for_at INTEGER,
            request_json TEXT NOT NULL,
            binding_snapshot_json TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversationLifecycle_pending
            ON conversationLifecycleOperation(conversation_id) WHERE status = 'prepared';
        CREATE TABLE IF NOT EXISTS conversationAdmission (
            token TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            phase TEXT NOT NULL,
            origin_source_id TEXT,
            expires_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conversationAdmission_conversation
            ON conversationAdmission(conversation_id, phase);
        CREATE TABLE IF NOT EXISTS conversationActivityFact (
            conversation_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            source_id TEXT,
            PRIMARY KEY (conversation_id, kind, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_conversationActivityFact_time
            ON conversationActivityFact(conversation_id, kind, occurred_at);
        CREATE TABLE IF NOT EXISTS conversationArchivePolicy (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            policy_json TEXT NOT NULL,
            revision INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversationArchivePolicyCycle (
            policy_revision INTEGER NOT NULL,
            scheduled_for_at INTEGER NOT NULL,
            time_zone TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(policy_revision, scheduled_for_at)
        );
        CREATE TABLE IF NOT EXISTS conversationArchivePolicyCandidate (
            policy_revision INTEGER NOT NULL,
            scheduled_for_at INTEGER NOT NULL,
            conversation_id TEXT NOT NULL,
            input_json TEXT NOT NULL,
            PRIMARY KEY(policy_revision, scheduled_for_at, conversation_id)
        );",
    )
    .map_err(|e| format!("初始化会话生命周期存储失败：{e}"))?;
    let has_expires_at = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(conversationAdmission)")
            .map_err(|e| format!("读取会话接纳结构失败：{e}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("查询会话接纳结构失败：{e}"))?;
        let mut found = false;
        for row in rows {
            if row.map_err(|e| format!("读取会话接纳字段失败：{e}"))? == "expires_at" {
                found = true;
                break;
            }
        }
        found
    };
    if !has_expires_at {
        conn.execute(
            "ALTER TABLE conversationAdmission ADD COLUMN expires_at INTEGER",
            [],
        )
        .map_err(|e| format!("迁移会话编辑租约失败：{e}"))?;
    }
    Ok(())
}

fn require_id(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 {
        return Err(format!(
            "invalid_{label}: 必须为非空且不超过 512 字节的标识"
        ));
    }
    Ok(value.to_string())
}

fn checked_source(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-/".contains(&b))
    {
        return Err("invalid_source_id: 来源标识格式无效".into());
    }
    Ok(Some(value.into()))
}

pub(crate) fn metadata_on(
    conn: &Connection,
    id: &str,
) -> Result<Option<ConversationLifecycleMeta>, String> {
    conn.query_row(
        "SELECT id, archived_at, archive_reason, unarchived_at, lifecycle_version,
                last_user_message_at, last_turn_finished_at, activity_version,
                auto_archive_exempt, origin_source_id, is_pinned, cwd, created_at
         FROM chatHistory WHERE id = ?1",
        [id],
        |row| {
            Ok(ConversationLifecycleMeta {
                conversation_id: row.get(0)?,
                archived_at: row.get(1)?,
                archive_reason: row.get(2)?,
                unarchived_at: row.get(3)?,
                lifecycle_version: row.get(4)?,
                last_user_message_at: row.get(5)?,
                last_turn_finished_at: row.get(6)?,
                activity_version: row.get(7)?,
                auto_archive_exempt: row.get::<_, i64>(8)? != 0,
                origin_source_id: row.get(9)?,
                is_pinned: row.get::<_, i64>(10)? != 0,
                cwd: row.get(11)?,
                created_at: row.get(12)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("读取会话生命周期失败：{e}"))
}

pub fn metadata(id: &str) -> Result<Option<ConversationLifecycleMeta>, String> {
    metadata_on(
        &history_db::open_connection()?,
        &require_id(id, "conversation_id")?,
    )
}

fn operation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LifecycleOperation> {
    Ok(LifecycleOperation {
        operation_id: row.get("operation_id")?,
        conversation_id: row.get("conversation_id")?,
        kind: row.get("kind")?,
        status: row.get("status")?,
        expected_lifecycle_version: row.get("expected_lifecycle_version")?,
        expected_activity_version: row.get("expected_activity_version")?,
        reason: row.get("reason")?,
        policy_revision: row.get("policy_revision")?,
        scheduled_for_at: row.get("scheduled_for_at")?,
        binding_snapshot_json: row.get("binding_snapshot_json")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_operation(conn: &Connection, id: &str) -> Result<Option<LifecycleOperation>, String> {
    conn.query_row(
        "SELECT * FROM conversationLifecycleOperation WHERE operation_id = ?1",
        [id],
        operation_row,
    )
    .optional()
    .map_err(|e| format!("读取归档操作失败：{e}"))
}

pub fn operation(operation_id: &str) -> Result<Option<LifecycleOperation>, String> {
    let operation_id = require_id(operation_id, "operation_id")?;
    read_operation(&history_db::open_connection()?, &operation_id)
}

pub fn list_pending_operations() -> Result<Vec<LifecycleOperation>, String> {
    let conn = history_db::open_connection()?;
    let mut stmt = conn.prepare("SELECT * FROM conversationLifecycleOperation WHERE status = 'prepared' ORDER BY created_at, operation_id")
        .map_err(|e| format!("准备待确认归档查询失败：{e}"))?;
    let rows = stmt
        .query_map([], operation_row)
        .map_err(|e| format!("查询待确认归档失败：{e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取待确认归档失败：{e}"))
}

pub(crate) fn has_blocking_admission(
    conn: &Connection,
    id: &str,
    automatic: bool,
    now: i64,
) -> Result<bool, String> {
    conn.execute(
        "DELETE FROM conversationAdmission WHERE phase = 'editing' AND expires_at IS NOT NULL AND expires_at <= ?1",
        [now],
    )
    .map_err(|e| format!("清理失效编辑门禁失败：{e}"))?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM conversationAdmission WHERE conversation_id = ?1
            AND (phase != 'editing' OR (?2 AND (expires_at IS NULL OR expires_at > ?3))))",
        params![id, automatic, now],
        |row| row.get(0),
    )
    .map_err(|e| format!("检查会话接纳门禁失败：{e}"))
}

pub(crate) fn has_pending_operation(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM conversationLifecycleOperation WHERE conversation_id = ?1 AND status = 'prepared')",
        [id], |row| row.get(0),
    ).map_err(|e| format!("检查会话生命周期门禁失败：{e}"))
}

fn normalize_mutation(input: &ArchiveMutationInput) -> Result<ArchiveMutationInput, String> {
    let mut value = input.clone();
    value.id = require_id(&value.id, "conversation_id")?;
    value.operation_id = require_id(&value.operation_id, "operation_id")?;
    if value.expected_lifecycle_version < 0
        || value.expected_activity_version.is_some_and(|v| v < 0)
    {
        return Err("invalid_lifecycle_version".into());
    }
    let reason = value.reason.as_deref().unwrap_or("manual").trim();
    if !matches!(reason, "manual" | "idle" | "daily" | "policy") {
        return Err("invalid_archive_reason".into());
    }
    value.reason = Some(reason.to_string());
    Ok(value)
}

fn verify_operation_request(
    conn: &Connection,
    operation: &LifecycleOperation,
    kind: &str,
    input: &ArchiveMutationInput,
) -> Result<(), String> {
    let stored: String = conn
        .query_row(
            "SELECT request_json FROM conversationLifecycleOperation WHERE operation_id = ?1",
            [&operation.operation_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取归档操作参数失败：{e}"))?;
    let request = serde_json::to_string(input).map_err(|e| e.to_string())?;
    if operation.kind != kind || stored != request {
        return Err("lifecycle_operation_conflict: 同一操作 ID 不可复用于不同参数".into());
    }
    Ok(())
}

fn insert_operation(
    conn: &Connection,
    input: &ArchiveMutationInput,
    kind: &str,
    status: &str,
    activity_version: i64,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO conversationLifecycleOperation(operation_id,conversation_id,kind,status,
            expected_lifecycle_version,expected_activity_version,reason,policy_revision,scheduled_for_at,request_json,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",
        params![input.operation_id,input.id,kind,status,input.expected_lifecycle_version,activity_version,
            input.reason.as_deref().unwrap_or("manual"),input.policy_revision,input.scheduled_for_at,
            serde_json::to_string(input).map_err(|e| e.to_string())?,now],
    ).map_err(|e| format!("记录归档操作失败：{e}"))?;
    Ok(())
}

pub(crate) fn prepare_archive_on(
    conn: &mut Connection,
    input: &ArchiveMutationInput,
    now: i64,
) -> Result<LifecycleOperation, String> {
    let input = normalize_mutation(input)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("锁定归档准备事务失败：{e}"))?;
    if let Some(operation) = read_operation(&tx, &input.operation_id)? {
        verify_operation_request(&tx, &operation, "archive", &input)?;
        if operation.status != "aborted" {
            return Ok(operation);
        }
        // Abort is only legal before any external binding side effect. The
        // exact same operation ID can therefore be retried safely; keeping it
        // stable also lets clients survive an acknowledgement race.
        tx.execute(
            "DELETE FROM conversationLifecycleOperation WHERE operation_id = ?1 AND status = 'aborted'",
            [&input.operation_id],
        )
        .map_err(|e| format!("重置未执行的归档操作失败：{e}"))?;
    }
    let meta = metadata_on(&tx, &input.id)?.ok_or("conversation_not_found")?;
    if meta.lifecycle_version != input.expected_lifecycle_version {
        return Err("lifecycle_version_conflict: 会话状态已变化，请刷新后重试".into());
    }
    if input
        .expected_activity_version
        .is_some_and(|version| version != meta.activity_version)
    {
        return Err("activity_version_conflict: 会话已有新的交互".into());
    }
    if has_pending_operation(&tx, &input.id)? {
        return Err("conversation_archive_pending: 该会话已有待确认操作".into());
    }
    let automatic = input.reason.as_deref() != Some("manual");
    if has_blocking_admission(&tx, &input.id, automatic, now)? {
        return Err("conversation_busy: 会话运行、排队或等待确认中".into());
    }
    if automatic {
        let policy = get_policy_on(&tx)?;
        if !policy.enabled || Some(policy.revision) != input.policy_revision {
            return Err("archive_policy_changed".into());
        }
        let cutoff = input.scheduled_for_at.unwrap_or(now);
        if !policy_matches(&policy, &meta, cutoff) {
            return Err("archive_policy_not_due".into());
        }
    }
    let status = if meta.archived_at.is_some() {
        "completed"
    } else {
        "prepared"
    };
    insert_operation(&tx, &input, "archive", status, meta.activity_version, now)?;
    let operation =
        read_operation(&tx, &input.operation_id)?.ok_or("archive_operation_not_found")?;
    tx.commit().map_err(|e| format!("提交归档准备失败：{e}"))?;
    Ok(operation)
}

pub fn prepare_archive(
    input: &ArchiveMutationInput,
    now: i64,
) -> Result<LifecycleOperation, String> {
    prepare_archive_on(&mut history_db::open_connection()?, input, now)
}

pub fn set_operation_bindings(
    operation_id: &str,
    binding_snapshot_json: &str,
    now: i64,
) -> Result<(), String> {
    let snapshot: serde_json::Value = serde_json::from_str(binding_snapshot_json)
        .map_err(|e| format!("invalid_binding_snapshot: {e}"))?;
    let normalized = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    let mut conn = history_db::open_connection()?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let operation = read_operation(&tx, operation_id)?.ok_or("archive_operation_not_found")?;
    if let Some(existing) = operation.binding_snapshot_json {
        if existing != normalized {
            return Err("binding_snapshot_conflict".into());
        }
        return Ok(());
    }
    if operation.status != "prepared" {
        return Err("archive_operation_not_pending".into());
    }
    tx.execute("UPDATE conversationLifecycleOperation SET binding_snapshot_json = ?1, updated_at = ?2 WHERE operation_id = ?3", params![normalized,now,operation_id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// The coordinator calls this only after every frozen binding is acknowledged
/// closed (or positively confirmed no longer pointing at this conversation).
pub(crate) fn complete_archive_on(
    conn: &mut Connection,
    operation_id: &str,
    now: i64,
) -> Result<chat_history::ChatHistorySummary, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let operation = read_operation(&tx, operation_id)?.ok_or("archive_operation_not_found")?;
    if operation.kind != "archive" || operation.status == "aborted" {
        return Err("invalid_archive_operation".into());
    }
    if operation.status == "completed" {
        return chat_history::get_summary_by_id(&tx, &operation.conversation_id);
    }
    if operation.status != "prepared" {
        return Err("archive_operation_not_pending".into());
    }
    if has_blocking_admission(
        &tx,
        &operation.conversation_id,
        operation.reason != "manual",
        now,
    )? {
        return Err("conversation_busy".into());
    }
    let meta = metadata_on(&tx, &operation.conversation_id)?.ok_or("conversation_not_found")?;
    if meta.archived_at.is_some() || meta.lifecycle_version != operation.expected_lifecycle_version
    {
        tx.execute(
            "UPDATE conversationLifecycleOperation SET status = 'aborted', error = 'lifecycle_changed', updated_at = ?1 WHERE operation_id = ?2 AND status = 'prepared'",
            params![now, operation_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Err("archive_confirmation_conflict: 会话生命周期已变化，本次归档已终止".into());
    }
    if operation.reason != "manual" {
        let policy = get_policy_on(&tx)?;
        let cutoff = operation.scheduled_for_at.unwrap_or(now);
        if !policy.enabled
            || Some(policy.revision) != operation.policy_revision
            || !policy_matches(&policy, &meta, cutoff)
        {
            // A new interaction or policy change invalidates automatic intent.
            // Make the prepared row terminal so it cannot fence the
            // conversation forever; a later scheduler cycle gets a new
            // activity-version-derived operation ID when it becomes due again.
            tx.execute(
                "UPDATE conversationLifecycleOperation SET status = 'aborted', error = 'automatic_archive_no_longer_due', updated_at = ?1 WHERE operation_id = ?2 AND status = 'prepared'",
                params![now, operation_id],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            return Err("archive_cancelled_activity_changed: 自动归档条件已变化".into());
        }
    }
    let confirmed_activity_version = meta.activity_version;
    if confirmed_activity_version != operation.expected_activity_version {
        // Manual intent survives a late persisted message. Automatic intent
        // reaches here only after the policy was revalidated against that
        // message. Rebase inside the same IMMEDIATE transaction so the final
        // history update still has a strict compare-and-swap guard.
        tx.execute(
            "UPDATE conversationLifecycleOperation SET expected_activity_version = ?1, updated_at = ?2 WHERE operation_id = ?3 AND status = 'prepared'",
            params![confirmed_activity_version, now, operation_id],
        )
        .map_err(|e| e.to_string())?;
    }
    let changed = tx.execute(
        "UPDATE chatHistory SET archived_at = ?1, archive_reason = ?2, lifecycle_version = lifecycle_version + 1
         WHERE id = ?3 AND archived_at IS NULL AND lifecycle_version = ?4 AND activity_version = ?5",
        params![now,operation.reason,operation.conversation_id,operation.expected_lifecycle_version,confirmed_activity_version],
    ).map_err(|e| format!("确认会话归档失败：{e}"))?;
    if changed != 1 {
        tx.execute(
            "UPDATE conversationLifecycleOperation SET status = 'aborted', error = 'confirmation_compare_and_swap_failed', updated_at = ?1 WHERE operation_id = ?2 AND status = 'prepared'",
            params![now, operation_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Err("archive_confirmation_conflict: 会话状态已变化，本次归档已终止".into());
    }
    tx.execute("UPDATE conversationLifecycleOperation SET status = 'completed', updated_at = ?1 WHERE operation_id = ?2", params![now,operation_id])
        .map_err(|e| e.to_string())?;
    let summary = chat_history::get_summary_by_id(&tx, &operation.conversation_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(summary)
}

pub fn complete_archive(
    operation_id: &str,
    now: i64,
) -> Result<chat_history::ChatHistorySummary, String> {
    complete_archive_on(&mut history_db::open_connection()?, operation_id, now)
}

/// Only abort before any binding close was attempted. A timeout or partial
/// acknowledgement must leave the prepared operation available for recovery.
pub fn abort_archive(operation_id: &str, reason: &str, now: i64) -> Result<(), String> {
    let conn = history_db::open_connection()?;
    conn.execute("UPDATE conversationLifecycleOperation SET status = 'aborted', error = ?1, updated_at = ?2 WHERE operation_id = ?3 AND status = 'prepared'", params![reason,now,operation_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn unarchive_on(
    conn: &mut Connection,
    input: &ArchiveMutationInput,
    now: i64,
) -> Result<chat_history::ChatHistorySummary, String> {
    let input = normalize_mutation(input)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if let Some(operation) = read_operation(&tx, &input.operation_id)? {
        verify_operation_request(&tx, &operation, "unarchive", &input)?;
        return chat_history::get_summary_by_id(&tx, &input.id);
    }
    let meta = metadata_on(&tx, &input.id)?.ok_or("conversation_not_found")?;
    if meta.lifecycle_version != input.expected_lifecycle_version {
        return Err("lifecycle_version_conflict".into());
    }
    if has_pending_operation(&tx, &input.id)? {
        return Err("conversation_archive_pending".into());
    }
    if has_blocking_admission(&tx, &input.id, false, now)? {
        return Err("conversation_busy".into());
    }
    if meta.archived_at.is_some() {
        tx.execute("UPDATE chatHistory SET archived_at = NULL, archive_reason = NULL, unarchived_at = ?1, lifecycle_version = lifecycle_version + 1 WHERE id = ?2", params![now,input.id])
            .map_err(|e| e.to_string())?;
    }
    insert_operation(
        &tx,
        &input,
        "unarchive",
        "completed",
        meta.activity_version,
        now,
    )?;
    let summary = chat_history::get_summary_by_id(&tx, &input.id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(summary)
}

pub fn unarchive(
    input: &ArchiveMutationInput,
    now: i64,
) -> Result<chat_history::ChatHistorySummary, String> {
    unarchive_on(&mut history_db::open_connection()?, input, now)
}

fn set_origin_on(
    conn: &Connection,
    id: &str,
    source: Option<&str>,
    now: i64,
) -> Result<(), String> {
    let Some(source) = checked_source(source)? else {
        return Ok(());
    };
    // Existing legacy history is not relabelled by whichever client opens it.
    let message_count: Option<i64> = conn
        .query_row(
            "SELECT total_message_count FROM chatHistory WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if message_count.is_some_and(|count| count > 0) {
        return Ok(());
    }
    conn.execute("INSERT OR IGNORE INTO conversationActivityFact(conversation_id,event_id,kind,occurred_at,source_id) VALUES(?1,'origin','origin',?2,?3)", params![id,now,source])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn sync_activity_to_history(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE chatHistory SET
            last_user_message_at = NULLIF(MAX(COALESCE(last_user_message_at,0), COALESCE((SELECT MAX(occurred_at) FROM conversationActivityFact WHERE conversation_id = ?1 AND kind = 'user'),0)),0),
            last_turn_finished_at = NULLIF(MAX(COALESCE(last_turn_finished_at,0), COALESCE((SELECT MAX(occurred_at) FROM conversationActivityFact WHERE conversation_id = ?1 AND kind = 'finished'),0)),0),
            activity_version = MAX(activity_version, (SELECT COUNT(*) FROM conversationActivityFact WHERE conversation_id = ?1 AND kind IN ('user','finished'))),
            origin_source_id = COALESCE(origin_source_id, (SELECT source_id FROM conversationActivityFact WHERE conversation_id = ?1 AND kind = 'origin' LIMIT 1))
         WHERE id = ?1", [id],
    ).map_err(|e| format!("同步真实会话活动失败：{e}"))?;
    Ok(())
}

fn record_fact_on(
    conn: &Connection,
    id: &str,
    event_id: &str,
    kind: &str,
    at: i64,
) -> Result<(), String> {
    if at <= 0 {
        return Err("invalid_activity_time".into());
    }
    conn.execute("INSERT OR IGNORE INTO conversationActivityFact(conversation_id,event_id,kind,occurred_at) VALUES(?1,?2,?3,?4)", params![id,event_id,kind,at])
        .map_err(|e| e.to_string())?;
    sync_activity_to_history(conn, id)
}

pub fn record_user_activity(
    conversation_id: &str,
    event_id: &str,
    occurred_at: i64,
    origin_source_id: Option<&str>,
) -> Result<(), String> {
    let id = require_id(conversation_id, "conversation_id")?;
    let event_id = require_id(event_id, "event_id")?;
    let mut conn = history_db::open_connection()?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    set_origin_on(&tx, &id, origin_source_id, occurred_at)?;
    record_fact_on(&tx, &id, &event_id, "user", occurred_at)?;
    tx.commit().map_err(|e| e.to_string())
}

pub(crate) fn record_persisted_user_messages(
    conn: &Connection,
    id: &str,
    messages_json: &str,
) -> Result<(), String> {
    let Ok(messages) = serde_json::from_str::<Vec<serde_json::Value>>(messages_json) else {
        return Ok(());
    };
    for message in messages {
        if message.get("role").and_then(|value| value.as_str()) != Some("user") {
            continue;
        }
        let Some(at) = message
            .get("timestamp")
            .and_then(|v| v.as_i64())
            .filter(|at| *at > 0)
        else {
            continue;
        };
        let content = message.get("content");
        if content.is_none()
            || content.is_some_and(|v| {
                v.is_null()
                    || v.as_str().is_some_and(|s| s.trim().is_empty())
                    || v.as_array().is_some_and(|a| a.is_empty())
            })
        {
            continue;
        }
        let stable = serde_json::to_vec(
            &serde_json::json!({"timestamp": at,"content": content,"id": message.get("id")}),
        )
        .map_err(|e| e.to_string())?;
        let key = format!("persisted:{}", sha256_hex(stable));
        record_fact_on(conn, id, &key, "user", at)?;
    }
    Ok(())
}

fn admission_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationAdmission> {
    Ok(ConversationAdmission {
        token: row.get("token")?,
        conversation_id: row.get("conversation_id")?,
        phase: row.get("phase")?,
        origin_source_id: row.get("origin_source_id")?,
        expires_at: row.get("expires_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn admit_on(
    conn: &mut Connection,
    conversation_id: &str,
    token: &str,
    phase: &str,
    origin_source_id: Option<&str>,
    now: i64,
) -> Result<(), String> {
    let id = require_id(conversation_id, "conversation_id")?;
    let token = require_id(token, "admission_token")?;
    let source = checked_source(origin_source_id)?;
    let expires_at = (phase == "editing").then(|| now.saturating_add(EDITING_ADMISSION_LEASE_MS));
    if !matches!(
        phase,
        "queued"
            | "running"
            | "cancelling"
            | "waiting_approval"
            | "waiting_input"
            | "unknown"
            | "editing"
    ) {
        return Err("invalid_admission_phase".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let existing = tx
        .query_row(
            "SELECT * FROM conversationAdmission WHERE token = ?1",
            [&token],
            admission_row,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if existing
        .as_ref()
        .is_some_and(|entry| entry.conversation_id != id)
    {
        return Err("admission_token_conflict".into());
    }
    if metadata_on(&tx, &id)?.is_some_and(|m| m.archived_at.is_some()) {
        return Err("conversation_archived: 请先取消归档或创建新的会话".into());
    }
    if has_pending_operation(&tx, &id)? {
        return Err("conversation_archive_pending".into());
    }
    if phase == "running" {
        let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM conversationAdmission WHERE conversation_id = ?1 AND token != ?2 AND phase IN ('running','cancelling','waiting_approval','waiting_input','unknown'))", params![id,token], |r| r.get(0)).map_err(|e| e.to_string())?;
        if busy {
            return Err("conversation_busy".into());
        }
    }
    tx.execute("INSERT INTO conversationAdmission(token,conversation_id,phase,origin_source_id,expires_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)
        ON CONFLICT(token) DO UPDATE SET phase = excluded.phase, origin_source_id = excluded.origin_source_id,
            expires_at = excluded.expires_at, updated_at = excluded.updated_at", params![token,id,phase,source,expires_at,now])
        .map_err(|e| e.to_string())?;
    if phase != "editing" {
        set_origin_on(&tx, &id, source.as_deref(), now)?;
    }
    sync_activity_to_history(&tx, &id)?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn admit(
    conversation_id: &str,
    token: &str,
    phase: &str,
    origin_source_id: Option<&str>,
    now: i64,
) -> Result<(), String> {
    admit_on(
        &mut history_db::open_connection()?,
        conversation_id,
        token,
        phase,
        origin_source_id,
        now,
    )
}

pub(crate) fn release_on(
    conn: &mut Connection,
    token: &str,
    finished: bool,
    now: i64,
) -> Result<Option<String>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let entry = tx
        .query_row(
            "SELECT * FROM conversationAdmission WHERE token = ?1",
            [token],
            admission_row,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(entry) = entry else {
        return Ok(None);
    };
    if finished && entry.phase != "editing" {
        record_fact_on(&tx, &entry.conversation_id, token, "finished", now)?;
    }
    tx.execute(
        "DELETE FROM conversationAdmission WHERE token = ?1",
        [token],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(entry.conversation_id))
}

pub fn release(token: &str, finished: bool, now: i64) -> Result<Option<String>, String> {
    release_on(&mut history_db::open_connection()?, token, finished, now)
}

pub fn list_admissions() -> Result<Vec<ConversationAdmission>, String> {
    let conn = history_db::open_connection()?;
    let mut stmt = conn
        .prepare("SELECT * FROM conversationAdmission ORDER BY created_at, token")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], admission_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn get_policy_on(conn: &Connection) -> Result<ArchivePolicy, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT policy_json FROM conversationArchivePolicy WHERE singleton = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|json| serde_json::from_str(&json).map_err(|e| format!("读取自动归档策略失败：{e}")))
        .unwrap_or_else(|| Ok(ArchivePolicy::default()))
}

pub fn get_policy() -> Result<ArchivePolicy, String> {
    get_policy_on(&history_db::open_connection()?)
}

pub fn validate_policy(input: &ArchivePolicy) -> Result<ArchivePolicy, String> {
    let mut policy = input.clone();
    if !matches!(policy.mode.as_str(), "idle" | "daily") {
        return Err("invalid_archive_mode".into());
    }
    if !(1..=525_600).contains(&policy.idle_minutes)
        || !(1..=525_600).contains(&policy.minimum_idle_minutes)
    {
        return Err("invalid_archive_idle_duration: 闲置时间必须介于 1 分钟与 365 天之间".into());
    }
    policy.daily_time = policy.daily_time.trim().to_string();
    if policy.daily_time.len() != 5
        || NaiveTime::parse_from_str(&policy.daily_time, "%H:%M").is_err()
    {
        return Err("invalid_archive_daily_time: 请输入 HH:mm 时间".into());
    }
    policy.time_zone = policy.time_zone.trim().to_string();
    if policy.time_zone.parse::<Tz>().is_err() {
        return Err("invalid_archive_time_zone: 请输入有效的 IANA 时区".into());
    }
    if !matches!(policy.source_mode.as_str(), "all" | "selected")
        || !matches!(
            policy.project_mode.as_str(),
            "all" | "unassigned" | "selected"
        )
    {
        return Err("invalid_archive_scope".into());
    }
    if policy.source_ids.len() > 1_000 || policy.project_paths.len() > 1_000 {
        return Err("archive_scope_too_large".into());
    }
    let mut sources = HashSet::new();
    let mut normalized_sources = Vec::new();
    for source in &policy.source_ids {
        if let Some(value) = checked_source(Some(source))? {
            if sources.insert(value.clone()) {
                normalized_sources.push(value);
            }
        }
    }
    policy.source_ids = normalized_sources;
    let mut projects = HashSet::new();
    policy
        .project_paths
        .retain(|path| !path.trim().is_empty() && projects.insert(project_path_key(path)));
    for path in &mut policy.project_paths {
        *path = path.trim().to_string();
        if path.len() > 4_096 {
            return Err("invalid_archive_project_path".into());
        }
    }
    if policy.revision < 0 {
        return Err("invalid_policy_revision".into());
    }
    Ok(policy)
}

pub(crate) fn save_policy_on(
    conn: &mut Connection,
    input: &ArchivePolicy,
    now: i64,
) -> Result<ArchivePolicy, String> {
    let mut policy = validate_policy(input)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let existing = get_policy_on(&tx)?;
    if policy.revision != existing.revision {
        return Err("archive_policy_version_conflict: 策略已被其他页面修改，请刷新".into());
    }
    policy.revision = policy
        .revision
        .checked_add(1)
        .ok_or("archive_policy_version_overflow")?;
    policy.updated_at = now;
    tx.execute("INSERT INTO conversationArchivePolicy(singleton,policy_json,revision,updated_at) VALUES(1,?1,?2,?3)
        ON CONFLICT(singleton) DO UPDATE SET policy_json = excluded.policy_json, revision = excluded.revision, updated_at = excluded.updated_at",
        params![serde_json::to_string(&policy).map_err(|e| e.to_string())?,policy.revision,now]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(policy)
}

pub fn save_policy(input: &ArchivePolicy, now: i64) -> Result<ArchivePolicy, String> {
    save_policy_on(&mut history_db::open_connection()?, input, now)
}

pub fn activity_baseline(meta: &ConversationLifecycleMeta) -> Option<i64> {
    [
        meta.last_user_message_at,
        meta.last_turn_finished_at,
        meta.unarchived_at,
    ]
    .into_iter()
    .flatten()
    .filter(|value| *value > 0)
    .max()
}

/// cutoff is the actual scheduled instant for daily runs, not the later wake
/// time. Restores and new messages after that instant cannot become eligible.
pub fn policy_matches(
    policy: &ArchivePolicy,
    meta: &ConversationLifecycleMeta,
    cutoff: i64,
) -> bool {
    if !policy.enabled
        || meta.archived_at.is_some()
        || meta.auto_archive_exempt
        || meta.is_pinned
        || meta.created_at > cutoff
    {
        return false;
    }
    let Some(baseline) = activity_baseline(meta) else {
        return false;
    };
    if policy.source_mode == "selected"
        && !policy
            .source_ids
            .iter()
            .any(|id| id == meta.origin_source_id.as_deref().unwrap_or("unknown"))
    {
        return false;
    }
    let cwd_key = project_path_key(meta.cwd.as_deref().unwrap_or_default());
    match policy.project_mode.as_str() {
        "unassigned" if !cwd_key.is_empty() => return false,
        "selected"
            if !policy
                .project_paths
                .iter()
                .any(|path| project_path_key(path) == cwd_key) =>
        {
            return false
        }
        _ => {}
    }
    let minutes = if policy.mode == "daily" {
        policy.minimum_idle_minutes
    } else {
        policy.idle_minutes
    };
    baseline <= cutoff && cutoff.saturating_sub(baseline) >= minutes.saturating_mul(60_000)
}

/// Ambiguous fall-back times use their first occurrence. A spring-forward gap
/// uses the first valid local minute afterwards; both resolve to one UTC cutoff.
pub fn latest_daily_cutoff(policy: &ArchivePolicy, now: i64) -> Result<Option<i64>, String> {
    let tz = policy
        .time_zone
        .parse::<Tz>()
        .map_err(|_| "invalid_archive_time_zone")?;
    let time = NaiveTime::parse_from_str(&policy.daily_time, "%H:%M")
        .map_err(|_| "invalid_archive_daily_time")?;
    let current = DateTime::<Utc>::from_timestamp_millis(now)
        .ok_or("invalid_archive_clock")?
        .with_timezone(&tz);
    for days_back in 0..=4 {
        let Some(date) = current.date_naive().checked_sub_days(Days::new(days_back)) else {
            continue;
        };
        let local = date.and_time(time);
        let mut resolved = None;
        for minute in 0..=180 {
            let Some(candidate) = local.checked_add_signed(chrono::Duration::minutes(minute))
            else {
                break;
            };
            match tz.from_local_datetime(&candidate) {
                LocalResult::Single(value) => {
                    resolved = Some(value.timestamp_millis());
                    break;
                }
                LocalResult::Ambiguous(first, second) => {
                    resolved = Some(first.timestamp_millis().min(second.timestamp_millis()));
                    break;
                }
                LocalResult::None => {}
            }
        }
        if let Some(cutoff) = resolved.filter(|cutoff| *cutoff <= now) {
            return Ok(Some(cutoff));
        }
    }
    Ok(None)
}

fn make_policy_candidate(
    policy: &ArchivePolicy,
    meta: &ConversationLifecycleMeta,
    now: i64,
    scheduled: Option<i64>,
) -> ArchiveMutationInput {
    let discriminator = scheduled.unwrap_or(now / 60_000);
    let key = format!(
        "{}:{}:{}:{}:{}",
        policy.revision,
        discriminator,
        meta.conversation_id,
        meta.lifecycle_version,
        meta.activity_version
    );
    ArchiveMutationInput {
        id: meta.conversation_id.clone(),
        operation_id: format!("auto-archive:{}", sha256_hex(key.as_bytes())),
        expected_lifecycle_version: meta.lifecycle_version,
        expected_activity_version: Some(meta.activity_version),
        reason: Some(policy.mode.clone()),
        policy_revision: Some(policy.revision),
        scheduled_for_at: scheduled,
    }
}

fn due_now_on(
    conn: &Connection,
    policy: &ArchivePolicy,
    cutoff: i64,
    now: i64,
    scheduled: Option<i64>,
) -> Result<Vec<ArchiveMutationInput>, String> {
    let ids = {
        let mut stmt = conn.prepare("SELECT id FROM chatHistory WHERE archived_at IS NULL AND is_pinned = 0 AND auto_archive_exempt = 0 ORDER BY id").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let mut candidates = Vec::new();
    for id in ids {
        let Some(meta) = metadata_on(conn, &id)? else {
            continue;
        };
        if !policy_matches(policy, &meta, cutoff)
            || has_blocking_admission(conn, &id, true, now)?
            || has_pending_operation(conn, &id)?
        {
            continue;
        }
        let input = make_policy_candidate(policy, &meta, now, scheduled);
        if read_operation(conn, &input.operation_id)?
            .is_some_and(|operation| operation.status != "aborted")
        {
            continue;
        }
        candidates.push(input);
    }
    Ok(candidates)
}

pub(crate) fn list_due_archive_candidates_on(
    conn: &mut Connection,
    now: i64,
) -> Result<Vec<ArchiveMutationInput>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let policy = get_policy_on(&tx)?;
    if !policy.enabled {
        return Ok(Vec::new());
    }
    if policy.mode == "idle" {
        return due_now_on(&tx, &policy, now, now, None);
    }
    let Some(cutoff) =
        latest_daily_cutoff(&policy, now)?.filter(|value| *value > policy.updated_at)
    else {
        return Ok(Vec::new());
    };
    let already_frozen: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM conversationArchivePolicyCycle WHERE policy_revision = ?1 AND scheduled_for_at = ?2)", params![policy.revision,cutoff], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !already_frozen {
        let candidates = due_now_on(&tx, &policy, cutoff, now, Some(cutoff))?;
        tx.execute("INSERT INTO conversationArchivePolicyCycle(policy_revision,scheduled_for_at,time_zone,created_at) VALUES(?1,?2,?3,?4)", params![policy.revision,cutoff,policy.time_zone,now]).map_err(|e| e.to_string())?;
        for candidate in &candidates {
            tx.execute("INSERT INTO conversationArchivePolicyCandidate(policy_revision,scheduled_for_at,conversation_id,input_json) VALUES(?1,?2,?3,?4)", params![policy.revision,cutoff,candidate.id,serde_json::to_string(candidate).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(candidates);
    }
    let frozen = {
        let mut stmt = tx.prepare("SELECT input_json FROM conversationArchivePolicyCandidate WHERE policy_revision = ?1 AND scheduled_for_at = ?2 ORDER BY conversation_id").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![policy.revision, cutoff], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let mut candidates = Vec::new();
    for raw in frozen {
        let input: ArchiveMutationInput = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if read_operation(&tx, &input.operation_id)?
            .is_some_and(|operation| operation.status != "aborted")
            || has_pending_operation(&tx, &input.id)?
        {
            continue;
        }
        let Some(meta) = metadata_on(&tx, &input.id)? else {
            continue;
        };
        if meta.lifecycle_version == input.expected_lifecycle_version
            && Some(meta.activity_version) == input.expected_activity_version
            && policy_matches(&policy, &meta, cutoff)
            && !has_blocking_admission(&tx, &input.id, true, now)?
        {
            candidates.push(input);
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(candidates)
}

pub fn list_due_archive_candidates(now: i64) -> Result<Vec<ArchiveMutationInput>, String> {
    list_due_archive_candidates_on(&mut history_db::open_connection()?, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open test database");
        history_db::initialize_connection(&conn).expect("initialize history schema");
        conn
    }

    fn seed_conversation(
        conn: &Connection,
        id: &str,
        created_at: i64,
        last_user_message_at: Option<i64>,
        is_pinned: bool,
        auto_archive_exempt: bool,
    ) {
        conn.execute(
            "INSERT INTO chatHistory(
                id,title,provider_id,model,session_id,cwd,context_meta_json,
                active_segment_index,total_segment_count,total_message_count,
                created_at,updated_at,is_pinned,auto_archive_exempt,last_user_message_at
             ) VALUES(?1,?1,'openai','test-model',?1,'C:/workspace','{}',0,0,0,?2,?2,?3,?4,?5)",
            params![
                id,
                created_at,
                i64::from(is_pinned),
                i64::from(auto_archive_exempt),
                last_user_message_at
            ],
        )
        .expect("seed conversation");
    }

    fn manual_input(id: &str, operation_id: &str, lifecycle_version: i64) -> ArchiveMutationInput {
        ArchiveMutationInput {
            id: id.into(),
            operation_id: operation_id.into(),
            expected_lifecycle_version: lifecycle_version,
            expected_activity_version: Some(0),
            reason: Some("manual".into()),
            policy_revision: None,
            scheduled_for_at: None,
        }
    }

    #[test]
    fn manual_archive_and_unarchive_are_idempotent_and_versioned() {
        let mut conn = test_connection();
        seed_conversation(&conn, "conversation-1", 1_000, Some(2_000), false, false);
        let archive = manual_input("conversation-1", "archive-1", 0);

        let prepared = prepare_archive_on(&mut conn, &archive, 3_000).expect("prepare archive");
        assert_eq!(prepared.status, "prepared");
        assert_eq!(
            prepare_archive_on(&mut conn, &archive, 3_001)
                .expect("retry prepare")
                .operation_id,
            "archive-1"
        );

        let conflicting = ArchiveMutationInput {
            scheduled_for_at: Some(3_000),
            ..archive.clone()
        };
        assert!(prepare_archive_on(&mut conn, &conflicting, 3_002)
            .expect_err("operation id reuse must conflict")
            .contains("lifecycle_operation_conflict"));

        conn.execute(
            "UPDATE conversationLifecycleOperation SET status = 'aborted' WHERE operation_id = 'archive-1'",
            [],
        )
        .expect("abort before external side effects");
        assert_eq!(
            prepare_archive_on(&mut conn, &archive, 3_003)
                .expect("retry exact aborted operation")
                .status,
            "prepared"
        );

        let archived =
            complete_archive_on(&mut conn, "archive-1", 4_000).expect("complete archive");
        assert_eq!(archived.archived_at, Some(4_000));
        assert_eq!(archived.archive_reason.as_deref(), Some("manual"));
        assert_eq!(archived.lifecycle_version, 1);
        assert_eq!(
            complete_archive_on(&mut conn, "archive-1", 4_001)
                .expect("retry completion")
                .archived_at,
            Some(4_000)
        );

        let restore = manual_input("conversation-1", "unarchive-1", 1);
        let restored = unarchive_on(&mut conn, &restore, 5_000).expect("unarchive");
        assert_eq!(restored.archived_at, None);
        assert_eq!(restored.archive_reason, None);
        assert_eq!(restored.unarchived_at, Some(5_000));
        assert_eq!(restored.lifecycle_version, 2);
        assert_eq!(
            unarchive_on(&mut conn, &restore, 5_001)
                .expect("retry unarchive")
                .unarchived_at,
            Some(5_000)
        );
    }

    #[test]
    fn manual_completion_rebases_late_persisted_activity_without_sticking_prepared() {
        let mut conn = test_connection();
        seed_conversation(&conn, "conversation-1", 1_000, Some(2_000), false, false);
        let archive = manual_input("conversation-1", "archive-activity-cas", 0);
        prepare_archive_on(&mut conn, &archive, 3_000).expect("prepare archive");

        record_fact_on(&conn, "conversation-1", "late-message", "user", 3_500)
            .expect("record racing activity");
        let archived = complete_archive_on(&mut conn, "archive-activity-cas", 4_000)
            .expect("manual intent includes the late persisted message");
        assert_eq!(archived.archived_at, Some(4_000));
        let operation = read_operation(&conn, "archive-activity-cas")
            .expect("read operation")
            .expect("operation");
        assert_eq!(operation.status, "completed");
        assert_eq!(operation.expected_activity_version, 1);
    }

    #[test]
    fn automatic_completion_cancels_when_late_activity_is_no_longer_due() {
        let mut conn = test_connection();
        seed_conversation(&conn, "conversation-1", 1_000, Some(2_000), false, false);
        let policy = save_policy_on(
            &mut conn,
            &ArchivePolicy {
                enabled: true,
                idle_minutes: 1,
                ..ArchivePolicy::default()
            },
            2_100,
        )
        .expect("save policy");
        let archive = ArchiveMutationInput {
            id: "conversation-1".into(),
            operation_id: "automatic-activity-cas".into(),
            expected_lifecycle_version: 0,
            expected_activity_version: Some(0),
            reason: Some("idle".into()),
            policy_revision: Some(policy.revision),
            scheduled_for_at: None,
        };
        prepare_archive_on(&mut conn, &archive, 70_000).expect("prepare automatic archive");
        record_fact_on(&conn, "conversation-1", "late-message", "user", 75_000)
            .expect("record racing activity");

        let error = complete_archive_on(&mut conn, "automatic-activity-cas", 80_000)
            .expect_err("recent activity invalidates automatic archive");
        assert!(error.contains("archive_cancelled_activity_changed"));
        assert!(!has_pending_operation(&conn, "conversation-1").expect("pending operation"));
        assert_eq!(
            read_operation(&conn, "automatic-activity-cas")
                .expect("read operation")
                .expect("operation")
                .status,
            "aborted"
        );
    }

    #[test]
    fn durable_admissions_protect_running_and_edited_conversations() {
        let mut conn = test_connection();
        seed_conversation(&conn, "running", 1_000, Some(2_000), false, false);
        seed_conversation(&conn, "editing", 1_000, Some(2_000), false, false);

        admit_on(
            &mut conn,
            "running",
            "run-token",
            "running",
            Some("desktop"),
            2_500,
        )
        .expect("admit running turn");
        assert!(prepare_archive_on(
            &mut conn,
            &manual_input("running", "archive-running", 0),
            3_000
        )
        .expect_err("running conversation must be protected")
        .contains("conversation_busy"));

        admit_on(&mut conn, "editing", "edit-token", "editing", None, 2_500)
            .expect("admit edited draft");
        let mut policy = ArchivePolicy {
            enabled: true,
            idle_minutes: 1,
            ..ArchivePolicy::default()
        };
        policy = save_policy_on(&mut conn, &policy, 2_600).expect("save policy");
        let automatic = ArchiveMutationInput {
            id: "editing".into(),
            operation_id: "archive-editing-auto".into(),
            expected_lifecycle_version: 0,
            expected_activity_version: Some(0),
            reason: Some("idle".into()),
            policy_revision: Some(policy.revision),
            scheduled_for_at: Some(3_000),
        };
        assert!(prepare_archive_on(&mut conn, &automatic, 3_000)
            .expect_err("edited draft must block automatic archive")
            .contains("conversation_busy"));

        // Editing is an automatic-archive exemption, not a prohibition on an
        // explicit user archive action.
        assert_eq!(
            prepare_archive_on(
                &mut conn,
                &manual_input("editing", "archive-editing-manual", 0),
                3_000
            )
            .expect("manual archive may proceed")
            .status,
            "prepared"
        );
    }

    #[test]
    fn expired_editing_lease_no_longer_blocks_automatic_archive() {
        let mut conn = test_connection();
        seed_conversation(&conn, "editing", 1_000, Some(2_000), false, false);
        admit_on(&mut conn, "editing", "edit-token", "editing", None, 2_500)
            .expect("admit edited draft");
        assert!(
            has_blocking_admission(&conn, "editing", true, 90_000).expect("active editing lease")
        );
        assert!(!has_blocking_admission(&conn, "editing", true, 100_000)
            .expect("expired editing lease"));
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversationAdmission WHERE token = 'edit-token'",
                [],
                |row| row.get(0),
            )
            .expect("count expired editing leases");
        assert_eq!(remaining, 0);
    }

    #[test]
    fn idle_policy_selects_only_stable_eligible_conversations() {
        let mut conn = test_connection();
        let now = 10 * 60 * 60 * 1_000;
        let old = now - 9 * 60 * 60 * 1_000;
        let recent = now - 60 * 60 * 1_000;
        seed_conversation(&conn, "eligible", 1_000, Some(old), false, false);
        seed_conversation(&conn, "pinned", 1_000, Some(old), true, false);
        seed_conversation(&conn, "exempt", 1_000, Some(old), false, true);
        seed_conversation(&conn, "unknown-baseline", 1_000, None, false, false);
        seed_conversation(&conn, "recent", 1_000, Some(recent), false, false);

        let policy = ArchivePolicy {
            enabled: true,
            idle_minutes: 8 * 60,
            ..ArchivePolicy::default()
        };
        let saved = save_policy_on(&mut conn, &policy, 2_000).expect("save policy");
        let candidates = list_due_archive_candidates_on(&mut conn, now).expect("list candidates");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].id, "eligible");
        assert_eq!(candidates[0].policy_revision, Some(saved.revision));

        admit_on(
            &mut conn,
            "eligible",
            "editing-candidate",
            "editing",
            None,
            now,
        )
        .expect("mark editing");
        assert!(list_due_archive_candidates_on(&mut conn, now)
            .expect("list protected candidates")
            .is_empty());
    }

    #[test]
    fn policy_revision_and_dst_cutoffs_are_deterministic() {
        let mut conn = test_connection();
        let initial = ArchivePolicy::default();
        let saved = save_policy_on(&mut conn, &initial, 1_000).expect("save initial policy");
        assert_eq!(saved.revision, 1);
        assert!(save_policy_on(&mut conn, &initial, 2_000)
            .expect_err("stale policy revision must conflict")
            .contains("archive_policy_version_conflict"));

        let spring = ArchivePolicy {
            daily_time: "02:30".into(),
            time_zone: "America/New_York".into(),
            ..ArchivePolicy::default()
        };
        let spring_now = DateTime::parse_from_rfc3339("2024-03-10T08:00:00Z")
            .expect("spring timestamp")
            .timestamp_millis();
        let spring_cutoff = latest_daily_cutoff(&spring, spring_now)
            .expect("spring cutoff")
            .expect("spring occurrence");
        assert_eq!(
            spring_cutoff,
            DateTime::parse_from_rfc3339("2024-03-10T07:00:00Z")
                .expect("expected spring cutoff")
                .timestamp_millis()
        );

        let fall = ArchivePolicy {
            daily_time: "01:30".into(),
            time_zone: "America/New_York".into(),
            ..ArchivePolicy::default()
        };
        let fall_now = DateTime::parse_from_rfc3339("2024-11-03T07:00:00Z")
            .expect("fall timestamp")
            .timestamp_millis();
        let fall_cutoff = latest_daily_cutoff(&fall, fall_now)
            .expect("fall cutoff")
            .expect("fall occurrence");
        assert_eq!(
            fall_cutoff,
            DateTime::parse_from_rfc3339("2024-11-03T05:30:00Z")
                .expect("expected fall cutoff")
                .timestamp_millis()
        );
    }
}
