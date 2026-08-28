//! Durable control-plane state for chat connectors.
//!
//! This store intentionally lives in the existing settings database. It is
//! the desktop authority for immutable permission-profile revisions, principal
//! bindings, stable delivery targets and the delivery outbox. Connector
//! processes should only submit trusted identities and enqueue work through
//! this API; they must not provide execution capabilities directly.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfile {
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub policy: Value,
    pub policy_hash: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrincipalBinding {
    pub id: String,
    pub installation_id: String,
    pub principal_type: String,
    pub principal_id: String,
    pub profile_id: String,
    pub profile_revision: u64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallationDefault {
    pub profile: PermissionProfile,
    pub binding: PrincipalBinding,
    pub follows_desktop: bool,
    pub profile_current_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryTarget {
    pub id: String,
    pub channel: String,
    pub installation_id: String,
    pub external_target_id: String,
    pub target_type: String,
    pub display_name: String,
    pub enabled: bool,
    pub validation_status: String,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryOutboxEntry {
    pub id: String,
    pub target_id: String,
    pub run_id: Option<String>,
    pub idempotency_key: String,
    pub body: String,
    pub status: String,
    pub attempt_count: u32,
    pub lease_until: Option<i64>,
    pub last_error: Option<String>,
    pub sent_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedDelivery {
    pub outbox: DeliveryOutboxEntry,
    pub target: DeliveryTarget,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePermissionProfile {
    pub id: Option<String>,
    pub name: String,
    pub policy: Value,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidatedPermissionPolicy {
    execution_mode: String,
    workdir: Option<String>,
    #[serde(default)]
    allow_empty_workdir: bool,
    allowed_skills: Option<Vec<String>>,
    allowed_system_tools: Option<Vec<String>>,
    allowed_mcp_servers: Option<Vec<String>>,
    memory_enabled: Option<bool>,
    native_web_search_enabled: Option<bool>,
    max_duration_seconds: Option<u64>,
    max_output_chars: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePrincipalBinding {
    pub id: Option<String>,
    pub installation_id: String,
    pub principal_type: String,
    pub principal_id: String,
    pub profile_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureInstallationDefault {
    pub installation_id: String,
    pub name: String,
    pub policy: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationDefaultExpectation {
    pub binding_id: String,
    pub profile_id: String,
    pub profile_revision: u64,
    pub profile_current_revision: u64,
    pub policy_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptInstallationDefault {
    pub installation_id: String,
    pub name: String,
    pub policy: Value,
    pub expected: InstallationDefaultExpectation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDeliveryTarget {
    pub channel: String,
    pub installation_id: String,
    pub external_target_id: String,
    pub target_type: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_pending_validation")]
    pub validation_status: String,
}

fn default_true() -> bool {
    true
}
fn default_pending_validation() -> String {
    "pending".to_string()
}

fn validate_permission_policy(value: &Value) -> Result<(), String> {
    let policy: ValidatedPermissionPolicy = serde_json::from_value(value.clone())
        .map_err(|e| format!("invalid permission policy: {e}"))?;
    if !matches!(
        policy.execution_mode.as_str(),
        "text" | "tools" | "agent-dev"
    ) {
        return Err(
            "permission policy executionMode must be text, tools, or agent-dev".to_string(),
        );
    }
    if let Some(workdir) = policy.workdir {
        if workdir.len() > 4096 || workdir.chars().any(char::is_control) {
            return Err("permission policy workdir is invalid".to_string());
        }
    }
    for (label, values) in [
        ("allowedSkills", policy.allowed_skills),
        ("allowedSystemTools", policy.allowed_system_tools),
        ("allowedMcpServers", policy.allowed_mcp_servers),
    ] {
        let Some(values) = values else { continue };
        if values.len() > 256 {
            return Err(format!("permission policy {label} exceeds 256 entries"));
        }
        let mut seen = std::collections::HashSet::with_capacity(values.len());
        for value in values {
            if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                return Err(format!("permission policy {label} contains an invalid id"));
            }
            if !seen.insert(value) {
                return Err(format!("permission policy {label} contains duplicate ids"));
            }
        }
    }
    if let Some(seconds) = policy.max_duration_seconds {
        if !(1..=3600).contains(&seconds) {
            return Err(
                "permission policy maxDurationSeconds must be between 1 and 3600".to_string(),
            );
        }
    }
    if let Some(chars) = policy.max_output_chars {
        if !(1..=1_000_000).contains(&chars) {
            return Err(
                "permission policy maxOutputChars must be between 1 and 1000000".to_string(),
            );
        }
    }
    let _ = (
        policy.memory_enabled,
        policy.native_web_search_enabled,
        policy.allow_empty_workdir,
    );
    Ok(())
}

fn normalize_permission_policy(value: &Value) -> Result<Value, String> {
    validate_permission_policy(value)?;
    let mut normalized = value.clone();
    normalized
        .as_object_mut()
        .expect("validated permission policy is an object")
        .entry("allowEmptyWorkdir")
        .or_insert(Value::Bool(false));
    normalized
        .as_object_mut()
        .expect("validated permission policy is an object")
        .entry("nativeWebSearchEnabled")
        .or_insert(Value::Bool(false));
    Ok(normalized)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueDelivery {
    pub target_id: String,
    pub run_id: Option<String>,
    pub idempotency_key: String,
    pub body: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

const DELIVERY_RETRY_BASE_DELAY_MS: i64 = 2_000;
const DELIVERY_RETRY_MAX_DELAY_MS: i64 = 60_000;

/// Delay a prepared delivery after a safe preflight failure. Attempt zero is
/// a newly enqueued row and remains immediately claimable; later attempts use
/// bounded exponential backoff. While a row is prepared, `lease_until` stores
/// this retry-not-before timestamp. Once claimed it resumes its normal meaning
/// as the in-flight sending lease.
fn delivery_retry_delay_ms(attempt_count: i64) -> i64 {
    if attempt_count <= 0 {
        return 0;
    }
    let shift = u32::try_from(attempt_count.saturating_sub(1))
        .unwrap_or(u32::MAX)
        .min(5);
    DELIVERY_RETRY_BASE_DELAY_MS
        .saturating_mul(1_i64 << shift)
        .min(DELIVERY_RETRY_MAX_DELAY_MS)
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort_unstable();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonical_json(&object[key]));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}

pub fn policy_hash(policy: &Value) -> Result<String, String> {
    let canonical = serde_json::to_vec(&canonical_json(policy))
        .map_err(|e| format!("serialize permission policy failed: {e}"))?;
    Ok(to_hex(&Sha256::digest(canonical)))
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

pub fn stable_target_id(
    channel: &str,
    installation_id: &str,
    target_type: &str,
    external_id: &str,
) -> String {
    let input = format!("target:v1\0{channel}\0{installation_id}\0{target_type}\0{external_id}");
    format!("target_{}", to_hex(&Sha256::digest(input.as_bytes())[..16]))
}

pub struct ChannelControlStore {
    conn: Mutex<Connection>,
}

impl ChannelControlStore {
    pub fn open() -> Result<Self, String> {
        let path = crate::commands::settings::config_db_path()?;
        let conn = Connection::open(path)
            .map_err(|e| format!("open channel control database failed: {e}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(|e| e.to_string())?;
        initialize_schema(&conn)?;
        recover_interrupted_sends(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        initialize_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "channel control store lock poisoned".to_string())
    }

    pub fn list_profiles(&self) -> Result<Vec<PermissionProfile>, String> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT p.id,p.name,p.current_revision,r.policy_json,r.policy_hash,p.enabled,p.created_at,p.updated_at FROM channel_permission_profiles p JOIN channel_permission_profile_revisions r ON r.profile_id=p.id AND r.revision=p.current_revision ORDER BY p.name,p.id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], profile_from_row)
            .map_err(|e| e.to_string())?;
        rows.map(|r| r.map_err(|e| e.to_string()).and_then(parse_profile))
            .collect()
    }

    pub fn save_profile(&self, input: SavePermissionProfile) -> Result<PermissionProfile, String> {
        require_non_empty("profile name", &input.name)?;
        if !input.policy.is_object() {
            return Err("permission profile policy must be a JSON object".to_string());
        }
        let policy = normalize_permission_policy(&input.policy)?;
        let policy_hash = policy_hash(&policy)?;
        let now = now_ms();
        let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut conn = self.lock()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let current: Option<(u64, i64)> = tx
            .query_row(
                "SELECT current_revision,created_at FROM channel_permission_profiles WHERE id=?1",
                params![id],
                |r| Ok((r.get::<_, i64>(0)? as u64, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let revision = next_profile_revision(current.map(|(r, _)| r).unwrap_or(0))?;
        let created = current.map(|(_, c)| c).unwrap_or(now);
        let json = serde_json::to_string(&policy).map_err(|e| e.to_string())?;
        // Explicit edits transfer ownership back to the desktop user, even
        // when only the profile name or enabled state changes.
        tx.execute(
            "DELETE FROM channel_managed_installation_defaults WHERE profile_id=?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO channel_permission_profiles (id,name,current_revision,enabled,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6)", params![id,input.name,revision as i64,input.enabled as i64,created,now]).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO channel_permission_profile_revisions (profile_id,revision,policy_json,policy_hash,created_at) VALUES (?1,?2,?3,?4,?5)", params![id,revision as i64,json,policy_hash,now]).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO channel_permission_profiles (id,name,current_revision,enabled,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,current_revision=excluded.current_revision,enabled=excluded.enabled,updated_at=excluded.updated_at", params![id,input.name,revision as i64,input.enabled as i64,created,now]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(PermissionProfile {
            id,
            name: input.name,
            revision,
            policy,
            policy_hash,
            enabled: input.enabled,
            created_at: created,
            updated_at: now,
        })
    }

    pub fn bind_principal(&self, input: SavePrincipalBinding) -> Result<PrincipalBinding, String> {
        require_non_empty("installation id", &input.installation_id)?;
        require_non_empty("principal type", &input.principal_type)?;
        require_non_empty("principal id", &input.principal_id)?;
        let now = now_ms();
        let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut conn = self.lock()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let revision: i64 = tx.query_row("SELECT current_revision FROM channel_permission_profiles WHERE id=?1 AND enabled=1", params![input.profile_id], |r| r.get(0)).map_err(|e| format!("enabled profile not found: {e}"))?;
        if input.principal_type == "installation" && input.principal_id == "*" {
            tx.execute(
                "DELETE FROM channel_managed_installation_defaults WHERE installation_id=?1",
                params![input.installation_id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute("INSERT INTO channel_principal_bindings (id,installation_id,principal_type,principal_id,profile_id,profile_revision,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(installation_id,principal_type,principal_id) DO UPDATE SET id=excluded.id,profile_id=excluded.profile_id,profile_revision=excluded.profile_revision,updated_at=excluded.updated_at", params![id,input.installation_id,input.principal_type,input.principal_id,input.profile_id,revision,now]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(PrincipalBinding {
            id,
            installation_id: input.installation_id,
            principal_type: input.principal_type,
            principal_id: input.principal_id,
            profile_id: input.profile_id,
            profile_revision: revision as u64,
            updated_at: now,
        })
    }

    pub fn ensure_installation_default(
        &self,
        input: EnsureInstallationDefault,
    ) -> Result<InstallationDefault, String> {
        require_non_empty("installation id", &input.installation_id)?;
        require_non_empty("profile name", &input.name)?;
        let policy = normalize_permission_policy(&input.policy)?;
        let policy_hash = policy_hash(&policy)?;
        let policy_json = serde_json::to_string(&policy).map_err(|e| e.to_string())?;
        let now = now_ms();
        let mut conn = self.lock()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if let Some(existing) = read_installation_default(&tx, &input.installation_id)? {
            // Ownership also checks the current profile revision. A binding
            // can still point at an older revision after a manual profile edit.
            if existing.follows_desktop && existing.profile.policy_hash != policy_hash {
                let revision = next_profile_revision(existing.profile_current_revision)?;
                tx.execute(
                    "INSERT INTO channel_permission_profile_revisions (profile_id,revision,policy_json,policy_hash,created_at) VALUES (?1,?2,?3,?4,?5)",
                    params![existing.profile.id, revision as i64, policy_json, policy_hash, now],
                )
                .map_err(|e| e.to_string())?;
                tx.execute(
                    "UPDATE channel_permission_profiles SET current_revision=?1,updated_at=?2 WHERE id=?3",
                    params![revision as i64, now, existing.profile.id],
                )
                .map_err(|e| e.to_string())?;
                tx.execute(
                    "UPDATE channel_principal_bindings SET profile_revision=?1,updated_at=?2 WHERE id=?3 AND installation_id=?4 AND principal_type='installation' AND principal_id='*'",
                    params![revision as i64, now, existing.binding.id, input.installation_id],
                )
                .map_err(|e| e.to_string())?;
                tx.execute(
                    "UPDATE channel_managed_installation_defaults SET last_synced_revision=?1 WHERE installation_id=?2",
                    params![revision as i64, input.installation_id],
                )
                .map_err(|e| e.to_string())?;
                let synced = read_installation_default(&tx, &input.installation_id)?
                    .ok_or_else(|| "installation default disappeared during sync".to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
                return Ok(synced);
            }
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(existing);
        }

        let created = create_managed_installation_default_in_transaction(
            &tx,
            &input.installation_id,
            &input.name,
            &policy_json,
            &policy_hash,
            now,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(created)
    }

    pub fn adopt_installation_default(
        &self,
        input: AdoptInstallationDefault,
    ) -> Result<InstallationDefault, String> {
        require_non_empty("installation id", &input.installation_id)?;
        require_non_empty("profile name", &input.name)?;
        let policy = normalize_permission_policy(&input.policy)?;
        let policy_hash = policy_hash(&policy)?;
        let policy_json = serde_json::to_string(&policy).map_err(|e| e.to_string())?;
        let mut conn = self.lock()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let existing = read_installation_default(&tx, &input.installation_id)?;
        let matches_expectation = existing.as_ref().is_some_and(|existing| {
            existing.binding.id == input.expected.binding_id
                && existing.profile.id == input.expected.profile_id
                && existing.binding.profile_revision == input.expected.profile_revision
                && existing.profile_current_revision == input.expected.profile_current_revision
                && existing.profile.policy_hash == input.expected.policy_hash
        });
        if !matches_expectation {
            return Err(
                "installation default conflict: reload the current profile before following desktop permissions"
                    .to_string(),
            );
        }
        // Create a new profile so explicit user and conversation bindings keep
        // their previous policy, even if they share the old default profile.
        let adopted = create_managed_installation_default_in_transaction(
            &tx,
            &input.installation_id,
            &input.name,
            &policy_json,
            &policy_hash,
            now_ms(),
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(adopted)
    }

    pub fn resolve_profile(
        &self,
        installation_id: &str,
        principal_type: &str,
        principal_id: &str,
    ) -> Result<Option<PermissionProfile>, String> {
        let conn = self.lock()?;
        conn.query_row("SELECT p.id,p.name,b.profile_revision,r.policy_json,r.policy_hash,p.enabled,p.created_at,p.updated_at FROM channel_principal_bindings b JOIN channel_permission_profiles p ON p.id=b.profile_id JOIN channel_permission_profile_revisions r ON r.profile_id=b.profile_id AND r.revision=b.profile_revision WHERE b.installation_id=?1 AND b.principal_type=?2 AND b.principal_id=?3 AND p.enabled=1", params![installation_id,principal_type,principal_id], profile_from_row).optional().map_err(|e| e.to_string())?.map(parse_profile).transpose()
    }

    /// Resolves the effective policy using the channel authorization order:
    /// principal binding, then conversation binding, then installation
    /// default (`*`). Returning `None` means deny.
    pub fn resolve_effective_profile(
        &self,
        installation_id: &str,
        user_id: &str,
        conversation_id: Option<&str>,
    ) -> Result<Option<PermissionProfile>, String> {
        require_non_empty("installation id", installation_id)?;
        require_non_empty("user id", user_id)?;
        let conn = self.lock()?;
        conn.query_row(
            "SELECT p.id,p.name,b.profile_revision,r.policy_json,r.policy_hash,p.enabled,p.created_at,p.updated_at
             FROM channel_principal_bindings b
             JOIN channel_permission_profiles p ON p.id=b.profile_id
             JOIN channel_permission_profile_revisions r ON r.profile_id=b.profile_id AND r.revision=b.profile_revision
             WHERE b.installation_id=?1 AND p.enabled=1 AND (
                 (b.principal_type='user' AND b.principal_id=?2) OR
                 (?3 IS NOT NULL AND b.principal_type IN ('conversation','group') AND b.principal_id=?3) OR
                 (b.principal_type='installation' AND b.principal_id='*')
             )
             ORDER BY CASE b.principal_type
                 WHEN 'user' THEN 0
                 WHEN 'conversation' THEN 1
                 WHEN 'group' THEN 2
                 WHEN 'installation' THEN 3
                 ELSE 4
             END, b.id
             LIMIT 1",
            params![installation_id, user_id, conversation_id],
            profile_from_row,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .map(parse_profile)
        .transpose()
    }

    pub fn upsert_target(&self, input: SaveDeliveryTarget) -> Result<DeliveryTarget, String> {
        let conn = self.lock()?;
        upsert_delivery_target_in_transaction(&conn, &input)
    }

    pub fn list_targets(&self, channel: Option<&str>) -> Result<Vec<DeliveryTarget>, String> {
        let conn = self.lock()?;
        let mut stmt = if channel.is_some() {
            conn.prepare("SELECT id,channel,installation_id,external_target_id,target_type,display_name,enabled,validation_status,revision,created_at,updated_at FROM channel_delivery_targets WHERE channel=?1 ORDER BY display_name,id").map_err(|e| e.to_string())?
        } else {
            conn.prepare("SELECT id,channel,installation_id,external_target_id,target_type,display_name,enabled,validation_status,revision,created_at,updated_at FROM channel_delivery_targets ORDER BY display_name,id").map_err(|e| e.to_string())?
        };
        let rows = match channel {
            Some(c) => stmt
                .query_map(params![c], target_from_row)
                .map_err(|e| e.to_string())?,
            None => stmt
                .query_map([], target_from_row)
                .map_err(|e| e.to_string())?,
        };
        rows.map(|r| r.map_err(|e| e.to_string())).collect()
    }

    pub fn enqueue(&self, input: EnqueueDelivery) -> Result<DeliveryOutboxEntry, String> {
        let conn = self.lock()?;
        enqueue_delivery_in_transaction(&conn, &input)
    }

    pub fn claim_outbox_for_run(&self, run_id: &str) -> Result<Option<ClaimedDelivery>, String> {
        let mut conn = self.lock()?;
        claim_outbox_for_run_in_connection(&mut conn, run_id, 30_000)
    }

    pub fn claim_outbox(
        &self,
        limit: u32,
        lease_ms: i64,
    ) -> Result<Vec<DeliveryOutboxEntry>, String> {
        let now = now_ms();
        let until = now.saturating_add(lease_ms.max(1));
        let mut conn = self.lock()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        recover_expired_sends(&tx, now)?;
        let ids: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT o.id FROM channel_delivery_outbox o JOIN channel_delivery_targets t ON t.id=o.target_id WHERE o.status='prepared' AND (o.lease_until IS NULL OR o.lease_until<=?1) AND t.enabled=1 AND t.validation_status='valid' ORDER BY o.updated_at,o.created_at,o.id LIMIT ?2")
                .map_err(|e| e.to_string())?;
            let collected = stmt
                .query_map(params![now, limit], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            collected
        };
        let mut claimed = Vec::new();
        for id in ids {
            let changed = tx.execute("UPDATE channel_delivery_outbox SET status='sending',attempt_count=attempt_count+1,lease_until=?2,updated_at=?3 WHERE id=?1 AND status='prepared'", params![id,until,now]).map_err(|e| e.to_string())?;
            if changed == 1 {
                claimed.push(tx.query_row("SELECT id,target_id,run_id,idempotency_key,body,status,attempt_count,lease_until,last_error,sent_at,created_at,updated_at FROM channel_delivery_outbox WHERE id=?1", params![id], outbox_from_row).map_err(|e| e.to_string())?);
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(claimed)
    }

    pub fn mark_outbox(&self, id: &str, status: &str, error: Option<&str>) -> Result<(), String> {
        let conn = self.lock()?;
        mark_delivery_in_transaction(&conn, id, status, error)
    }
}

fn require_non_empty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(format!(
            "{label} must be non-empty and contain no control characters"
        ));
    }
    Ok(())
}

fn profile_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(String, String, i64, String, String, i64, i64, i64)> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

fn next_profile_revision(current: u64) -> Result<u64, String> {
    current
        .checked_add(1)
        .filter(|revision| *revision <= i64::MAX as u64)
        .ok_or_else(|| "permission profile revision exhausted".to_string())
}

/// The caller must hold an immediate transaction and either have observed no
/// default or verified the user's expectation before replacing its binding.
fn create_managed_installation_default_in_transaction(
    conn: &Connection,
    installation_id: &str,
    name: &str,
    policy_json: &str,
    policy_hash: &str,
    now: i64,
) -> Result<InstallationDefault, String> {
    let profile_id = Uuid::new_v4().to_string();
    let binding_id = Uuid::new_v4().to_string();
    conn.execute(
        "DELETE FROM channel_managed_installation_defaults WHERE installation_id=?1",
        params![installation_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO channel_permission_profiles (id,name,current_revision,enabled,created_at,updated_at) VALUES (?1,?2,1,1,?3,?3)",
        params![profile_id, name, now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO channel_permission_profile_revisions (profile_id,revision,policy_json,policy_hash,created_at) VALUES (?1,1,?2,?3,?4)",
        params![profile_id, policy_json, policy_hash, now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO channel_principal_bindings (id,installation_id,principal_type,principal_id,profile_id,profile_revision,updated_at) VALUES (?1,?2,'installation','*',?3,1,?4)
         ON CONFLICT(installation_id,principal_type,principal_id) DO UPDATE SET id=excluded.id,profile_id=excluded.profile_id,profile_revision=excluded.profile_revision,updated_at=excluded.updated_at",
        params![binding_id, installation_id, profile_id, now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO channel_managed_installation_defaults (installation_id,profile_id,binding_id,last_synced_revision) VALUES (?1,?2,?3,1)",
        params![installation_id, profile_id, binding_id],
    )
    .map_err(|e| e.to_string())?;
    read_installation_default(conn, installation_id)?
        .ok_or_else(|| "installation default was not created".to_string())
}

fn read_installation_default(
    conn: &Connection,
    installation_id: &str,
) -> Result<Option<InstallationDefault>, String> {
    type Raw = (
        String,
        i64,
        String,
        String,
        i64,
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        bool,
    );
    let raw: Option<Raw> = conn
        .query_row(
            "SELECT b.id,b.updated_at,p.id,p.name,b.profile_revision,r.policy_json,r.policy_hash,p.enabled,p.created_at,p.updated_at,p.current_revision,
                    EXISTS(
                        SELECT 1 FROM channel_managed_installation_defaults m
                        WHERE m.installation_id=b.installation_id
                          AND m.profile_id=b.profile_id AND m.binding_id=b.id
                          AND m.last_synced_revision=b.profile_revision
                          AND p.current_revision=b.profile_revision AND p.enabled=1
                    )
             FROM channel_principal_bindings b
             JOIN channel_permission_profiles p ON p.id=b.profile_id
             JOIN channel_permission_profile_revisions r ON r.profile_id=b.profile_id AND r.revision=b.profile_revision
             WHERE b.installation_id=?1 AND b.principal_type='installation' AND b.principal_id='*'",
            params![installation_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(raw) = raw else { return Ok(None) };
    let profile = parse_profile((
        raw.2.clone(),
        raw.3,
        raw.4,
        raw.5,
        raw.6,
        raw.7,
        raw.8,
        raw.9,
    ))?;
    Ok(Some(InstallationDefault {
        binding: PrincipalBinding {
            id: raw.0,
            installation_id: installation_id.to_string(),
            principal_type: "installation".to_string(),
            principal_id: "*".to_string(),
            profile_id: raw.2,
            profile_revision: raw.4 as u64,
            updated_at: raw.1,
        },
        profile,
        follows_desktop: raw.11,
        profile_current_revision: raw.10 as u64,
    }))
}
fn parse_profile(
    raw: (String, String, i64, String, String, i64, i64, i64),
) -> Result<PermissionProfile, String> {
    Ok(PermissionProfile {
        id: raw.0,
        name: raw.1,
        revision: raw.2 as u64,
        policy: serde_json::from_str(&raw.3).map_err(|e| e.to_string())?,
        policy_hash: raw.4,
        enabled: raw.5 != 0,
        created_at: raw.6,
        updated_at: raw.7,
    })
}
fn target_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeliveryTarget> {
    Ok(DeliveryTarget {
        id: row.get(0)?,
        channel: row.get(1)?,
        installation_id: row.get(2)?,
        external_target_id: row.get(3)?,
        target_type: row.get(4)?,
        display_name: row.get(5)?,
        enabled: row.get::<_, i64>(6)? != 0,
        validation_status: row.get(7)?,
        revision: row.get::<_, i64>(8)? as u64,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub fn resolve_delivery_target(
    conn: &Connection,
    target_id: &str,
) -> Result<Option<DeliveryTarget>, String> {
    conn.query_row("SELECT id,channel,installation_id,external_target_id,target_type,display_name,enabled,validation_status,revision,created_at,updated_at FROM channel_delivery_targets WHERE id=?1", params![target_id], target_from_row)
        .optional()
        .map_err(|e| e.to_string())
}

pub fn upsert_delivery_target_in_transaction(
    conn: &Connection,
    input: &SaveDeliveryTarget,
) -> Result<DeliveryTarget, String> {
    require_non_empty("channel", &input.channel)?;
    require_non_empty("installation id", &input.installation_id)?;
    require_non_empty("target type", &input.target_type)?;
    require_non_empty("external target id", &input.external_target_id)?;
    if !matches!(
        input.validation_status.as_str(),
        "pending" | "valid" | "invalid"
    ) {
        return Err("invalid delivery target validation status".to_string());
    }
    let id = stable_target_id(
        &input.channel,
        &input.installation_id,
        &input.target_type,
        &input.external_target_id,
    );
    let now = now_ms();
    let current: Option<(u64, i64)> = conn
        .query_row(
            "SELECT revision,created_at FROM channel_delivery_targets WHERE id=?1",
            params![id],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let revision = current.map(|(revision, _)| revision + 1).unwrap_or(1);
    let created_at = current.map(|(_, created_at)| created_at).unwrap_or(now);
    conn.execute("INSERT INTO channel_delivery_targets (id,channel,installation_id,external_target_id,target_type,display_name,enabled,validation_status,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,enabled=excluded.enabled,validation_status=excluded.validation_status,revision=excluded.revision,updated_at=excluded.updated_at", params![id,input.channel,input.installation_id,input.external_target_id,input.target_type,input.display_name,input.enabled as i64,input.validation_status,revision as i64,created_at,now]).map_err(|e| e.to_string())?;
    Ok(DeliveryTarget {
        id,
        channel: input.channel.clone(),
        installation_id: input.installation_id.clone(),
        external_target_id: input.external_target_id.clone(),
        target_type: input.target_type.clone(),
        display_name: input.display_name.clone(),
        enabled: input.enabled,
        validation_status: input.validation_status.clone(),
        revision,
        created_at,
        updated_at: now,
    })
}

/// Enqueues against an existing connection or caller-owned transaction. This
/// is the integration point used to commit an automation terminal state and
/// its durable outbox row atomically.
pub fn enqueue_delivery_in_transaction(
    conn: &Connection,
    input: &EnqueueDelivery,
) -> Result<DeliveryOutboxEntry, String> {
    require_non_empty("idempotency key", &input.idempotency_key)?;
    if let Some(existing) = conn
        .query_row("SELECT id,target_id,run_id,idempotency_key,body,status,attempt_count,lease_until,last_error,sent_at,created_at,updated_at FROM channel_delivery_outbox WHERE idempotency_key=?1", params![input.idempotency_key], outbox_from_row)
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(existing);
    }
    let target = resolve_delivery_target(conn, &input.target_id)?;
    if !target.is_some_and(|target| target.enabled && target.validation_status == "valid") {
        return Err("delivery target not found or disabled".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute("INSERT INTO channel_delivery_outbox (id,target_id,run_id,idempotency_key,body,status,attempt_count,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'prepared',0,?6,?6) ON CONFLICT(idempotency_key) DO NOTHING", params![id,input.target_id,input.run_id,input.idempotency_key,input.body,now]).map_err(|e| e.to_string())?;
    conn.query_row("SELECT id,target_id,run_id,idempotency_key,body,status,attempt_count,lease_until,last_error,sent_at,created_at,updated_at FROM channel_delivery_outbox WHERE idempotency_key=?1", params![input.idempotency_key], outbox_from_row).map_err(|e| e.to_string())
}

pub fn claim_outbox_for_run_in_connection(
    conn: &mut Connection,
    run_id: &str,
    lease_ms: i64,
) -> Result<Option<ClaimedDelivery>, String> {
    require_non_empty("run id", run_id)?;
    let now = now_ms();
    let lease_until = now.saturating_add(lease_ms.max(1));
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let id: Option<String> = tx
        .query_row(
            "SELECT o.id FROM channel_delivery_outbox o JOIN channel_delivery_targets t ON t.id=o.target_id WHERE o.run_id=?1 AND o.status='prepared' AND (o.lease_until IS NULL OR o.lease_until<=?2) AND t.enabled=1 AND t.validation_status='valid' ORDER BY o.created_at,o.id LIMIT 1",
            params![run_id, now],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(id) = id else {
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(None);
    };
    let changed = tx
        .execute(
            "UPDATE channel_delivery_outbox SET status='sending',attempt_count=attempt_count+1,lease_until=?2,updated_at=?3 WHERE id=?1 AND status='prepared'",
            params![id, lease_until, now],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(None);
    }
    let outbox = tx
        .query_row("SELECT id,target_id,run_id,idempotency_key,body,status,attempt_count,lease_until,last_error,sent_at,created_at,updated_at FROM channel_delivery_outbox WHERE id=?1", params![id], outbox_from_row)
        .map_err(|e| e.to_string())?;
    let target = resolve_delivery_target(&tx, &outbox.target_id)?
        .ok_or_else(|| "claimed delivery target disappeared".to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(ClaimedDelivery { outbox, target }))
}

pub fn mark_delivery_in_transaction(
    conn: &Connection,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    if !matches!(status, "sent" | "failed" | "unknown") {
        return Err("outbox can only be marked sent, failed, or unknown".to_string());
    }
    let now = now_ms();
    let sent_at = (status == "sent").then_some(now);
    let changed = conn.execute("UPDATE channel_delivery_outbox SET status=?2,last_error=?3,lease_until=NULL,sent_at=COALESCE(?4,sent_at),updated_at=?5 WHERE id=?1 AND status='sending'", params![id,status,error,sent_at,now]).map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("outbox entry is not in sending state".to_string());
    }
    Ok(())
}

pub fn requeue_delivery_in_transaction(
    conn: &Connection,
    id: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let attempt_count: Option<i64> = conn
        .query_row(
            "SELECT attempt_count FROM channel_delivery_outbox WHERE id=?1 AND status='sending'",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(attempt_count) = attempt_count else {
        return Err("outbox entry is not in sending state".to_string());
    };
    let now = now_ms();
    let retry_not_before = now.saturating_add(delivery_retry_delay_ms(attempt_count));
    let changed = conn
        .execute(
            "UPDATE channel_delivery_outbox
             SET status='prepared',last_error=?2,lease_until=?3,updated_at=?4
             WHERE id=?1 AND status='sending'",
            params![id, error, retry_not_before, now],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("outbox entry is not in sending state".to_string());
    }
    Ok(())
}
fn outbox_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeliveryOutboxEntry> {
    Ok(DeliveryOutboxEntry {
        id: row.get(0)?,
        target_id: row.get(1)?,
        run_id: row.get(2)?,
        idempotency_key: row.get(3)?,
        body: row.get(4)?,
        status: row.get(5)?,
        attempt_count: row.get::<_, i64>(6)? as u32,
        lease_until: row.get(7)?,
        last_error: row.get(8)?,
        sent_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

pub fn initialize_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS channel_control_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_permission_profiles (id TEXT PRIMARY KEY,name TEXT NOT NULL,current_revision INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS channel_permission_profile_revisions (profile_id TEXT NOT NULL,revision INTEGER NOT NULL,policy_json TEXT NOT NULL,policy_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(profile_id,revision),FOREIGN KEY(profile_id) REFERENCES channel_permission_profiles(id)); CREATE TABLE IF NOT EXISTS channel_principal_bindings (id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,principal_type TEXT NOT NULL,principal_id TEXT NOT NULL,profile_id TEXT NOT NULL,profile_revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(installation_id,principal_type,principal_id),FOREIGN KEY(profile_id,profile_revision) REFERENCES channel_permission_profile_revisions(profile_id,revision)); CREATE INDEX IF NOT EXISTS idx_channel_bindings_profile ON channel_principal_bindings(profile_id); CREATE TABLE IF NOT EXISTS channel_delivery_targets (id TEXT PRIMARY KEY,channel TEXT NOT NULL,installation_id TEXT NOT NULL,external_target_id TEXT NOT NULL,target_type TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,validation_status TEXT NOT NULL DEFAULT 'pending',revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(channel,installation_id,target_type,external_target_id)); CREATE TABLE IF NOT EXISTS channel_delivery_outbox (id TEXT PRIMARY KEY,target_id TEXT NOT NULL,run_id TEXT,idempotency_key TEXT NOT NULL UNIQUE,body TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('prepared','sending','sent','failed','unknown')),attempt_count INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,last_error TEXT,sent_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,FOREIGN KEY(target_id) REFERENCES channel_delivery_targets(id)); CREATE INDEX IF NOT EXISTS idx_channel_outbox_claim ON channel_delivery_outbox(status,lease_until,created_at); CREATE INDEX IF NOT EXISTS idx_channel_outbox_run ON channel_delivery_outbox(run_id,status);")
        .map_err(|e| format!("initialize channel control schema failed: {e}"))?;
    // Existing defaults deliberately receive no ownership marker. Their origin
    // cannot be inferred safely; only an explicit adoption can claim them.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS channel_managed_installation_defaults (
            installation_id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL UNIQUE,
            binding_id TEXT NOT NULL UNIQUE,
            last_synced_revision INTEGER NOT NULL,
            FOREIGN KEY(profile_id,last_synced_revision)
                REFERENCES channel_permission_profile_revisions(profile_id,revision),
            FOREIGN KEY(binding_id) REFERENCES channel_principal_bindings(id)
        );",
    )
    .map_err(|e| format!("initialize managed installation defaults failed: {e}"))?;
    conn.execute(
        "INSERT INTO channel_control_meta (key,value) VALUES ('schema_version','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [],
    )
    .map_err(|e| format!("stamp channel control schema failed: {e}"))?;
    Ok(())
}

fn recover_interrupted_sends(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE channel_delivery_outbox SET status='unknown',lease_until=NULL,last_error=COALESCE(last_error,'delivery interrupted while send result was unknown'),updated_at=?1 WHERE status='sending'",
        params![now_ms()],
    )
    .map_err(|e| format!("recover interrupted channel deliveries failed: {e}"))?;
    Ok(())
}

fn recover_expired_sends(conn: &Connection, now: i64) -> Result<usize, String> {
    conn.execute(
        "UPDATE channel_delivery_outbox
         SET status='unknown',lease_until=NULL,
             last_error=COALESCE(last_error,'delivery lease expired while send result was unknown'),
             updated_at=?1
         WHERE status='sending' AND lease_until IS NOT NULL AND lease_until<=?1",
        params![now],
    )
    .map_err(|e| format!("recover expired channel deliveries failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_input(skills: &[&str]) -> EnsureInstallationDefault {
        EnsureInstallationDefault {
            installation_id: "wecom-bot".into(),
            name: "WeCom bot default".into(),
            policy: serde_json::json!({"executionMode":"tools","allowedSkills":skills}),
        }
    }

    fn current_default(store: &ChannelControlStore) -> InstallationDefault {
        read_installation_default(&store.lock().unwrap(), "wecom-bot")
            .unwrap()
            .unwrap()
    }

    fn default_expectation(default: &InstallationDefault) -> InstallationDefaultExpectation {
        InstallationDefaultExpectation {
            binding_id: default.binding.id.clone(),
            profile_id: default.profile.id.clone(),
            profile_revision: default.binding.profile_revision,
            profile_current_revision: default.profile_current_revision,
            policy_hash: default.profile.policy_hash.clone(),
        }
    }

    fn adoption_input(default: &InstallationDefault) -> AdoptInstallationDefault {
        let input = default_input(&["read", "scripts"]);
        AdoptInstallationDefault {
            installation_id: input.installation_id,
            name: input.name,
            policy: input.policy,
            expected: default_expectation(default),
        }
    }

    fn legacy_default(store: &ChannelControlStore) -> InstallationDefault {
        let input = default_input(&["read"]);
        let profile = store
            .save_profile(SavePermissionProfile {
                id: None,
                name: input.name,
                policy: input.policy,
                enabled: true,
            })
            .unwrap();
        store
            .bind_principal(SavePrincipalBinding {
                id: None,
                installation_id: input.installation_id,
                principal_type: "installation".into(),
                principal_id: "*".into(),
                profile_id: profile.id,
            })
            .unwrap();
        current_default(store)
    }

    fn revision_count(store: &ChannelControlStore, profile_id: &str) -> i64 {
        store
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM channel_permission_profile_revisions WHERE profile_id=?1",
                params![profile_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn managed_default_syncs_the_complete_policy_with_immutable_revisions() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let original = store
            .ensure_installation_default(default_input(&["read"]))
            .unwrap();
        assert!(original.follows_desktop);
        assert_eq!(original.profile_current_revision, 1);
        let mut input = default_input(&["read", "scripts"]);
        input.policy["allowedSystemTools"] = serde_json::json!(["execute"]);
        input.policy["allowedMcpServers"] = serde_json::json!(["business"]);
        input.policy["workdir"] = serde_json::json!("E:/workspace");
        input.policy["memoryEnabled"] = serde_json::json!(true);
        input.policy["maxDurationSeconds"] = serde_json::json!(300);
        let expected_policy = normalize_permission_policy(&input.policy).unwrap();
        let synced = store.ensure_installation_default(input).unwrap();
        assert_eq!(synced.profile.id, original.profile.id);
        assert_eq!(synced.binding.id, original.binding.id);
        assert_eq!(synced.profile.revision, 2);
        assert_eq!(synced.binding.profile_revision, 2);
        assert_eq!(synced.profile_current_revision, 2);
        assert!(synced.follows_desktop);
        assert_eq!(synced.profile.policy, expected_policy);
        assert_eq!(
            synced.profile.policy_hash,
            policy_hash(&expected_policy).unwrap()
        );
        assert_ne!(synced.profile.policy_hash, original.profile.policy_hash);
        assert_eq!(revision_count(&store, &original.profile.id), 2);
        let stored_original: (String, String) = store.lock().unwrap().query_row(
            "SELECT policy_json,policy_hash FROM channel_permission_profile_revisions WHERE profile_id=?1 AND revision=1",
            params![original.profile.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&stored_original.0).unwrap(),
            original.profile.policy
        );
        assert_eq!(stored_original.1, original.profile.policy_hash);
        assert_eq!(store.list_profiles().unwrap(), vec![synced.profile]);
    }

    #[test]
    fn managed_default_same_normalized_hash_is_a_complete_noop() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let original = store
            .ensure_installation_default(default_input(&["read"]))
            .unwrap();
        let mut input = default_input(&["read"]);
        input.policy = serde_json::json!({
            "nativeWebSearchEnabled": false,
            "allowedSkills": ["read"],
            "allowEmptyWorkdir": false,
            "executionMode": "tools"
        });
        let unchanged = store.ensure_installation_default(input).unwrap();
        assert_eq!(unchanged, original);
        assert_eq!(revision_count(&store, &original.profile.id), 1);
    }

    #[test]
    fn profile_revision_and_hash_are_stable() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let a = store
            .save_profile(SavePermissionProfile {
                id: Some("default".into()),
                name: "Default".into(),
                policy: serde_json::json!({"executionMode":"tools","allowedSkills":["read"],"memoryEnabled":true}),
                enabled: true,
            })
            .unwrap();
        let b = store
            .save_profile(SavePermissionProfile {
                id: Some("default".into()),
                name: "Default".into(),
                policy: serde_json::json!({"memoryEnabled":true,"allowedSkills":["read"],"executionMode":"tools"}),
                enabled: true,
            })
            .unwrap();
        assert_eq!(a.revision, 1);
        assert_eq!(b.revision, 2);
        assert_eq!(a.policy_hash, b.policy_hash);
        assert_eq!(a.policy["allowEmptyWorkdir"], false);
        assert_eq!(a.policy["nativeWebSearchEnabled"], false);
    }
    #[test]
    fn managed_default_sync_preserves_user_and_group_bindings() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let original = store
            .ensure_installation_default(default_input(&["read"]))
            .unwrap();
        let principals = [
            ("wecom-bot", "user", "alice"),
            ("wecom-bot", "conversation", "room"),
            ("wecom-bot", "group", "legacy-room"),
            ("other-bot", "installation", "*"),
        ];
        for (installation, principal_type, principal_id) in principals {
            store
                .bind_principal(SavePrincipalBinding {
                    id: None,
                    installation_id: installation.into(),
                    principal_type: principal_type.into(),
                    principal_id: principal_id.into(),
                    profile_id: original.profile.id.clone(),
                })
                .unwrap();
        }
        let synced = store
            .ensure_installation_default(default_input(&["read", "scripts"]))
            .unwrap();
        assert!(synced.follows_desktop);
        assert_eq!(synced.profile.revision, 2);
        for (installation, principal_type, principal_id) in principals {
            let frozen = store
                .resolve_profile(installation, principal_type, principal_id)
                .unwrap()
                .unwrap();
            assert_eq!(frozen.revision, 1);
            assert_eq!(frozen.policy, original.profile.policy);
            assert_eq!(frozen.policy_hash, original.profile.policy_hash);
        }
        let fallback = store
            .resolve_effective_profile("wecom-bot", "bob", None)
            .unwrap()
            .unwrap();
        assert_eq!(fallback, synced.profile);
    }

    #[test]
    fn binding_freezes_the_profile_revision() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        store
            .save_profile(SavePermissionProfile {
                id: Some("default".into()),
                name: "Default".into(),
                policy: serde_json::json!({"executionMode":"tools","allowedSkills":["read"]}),
                enabled: true,
            })
            .unwrap();
        store
            .bind_principal(SavePrincipalBinding {
                id: None,
                installation_id: "bot".into(),
                principal_type: "user".into(),
                principal_id: "alice".into(),
                profile_id: "default".into(),
            })
            .unwrap();
        store
            .save_profile(SavePermissionProfile {
                id: Some("default".into()),
                name: "Default".into(),
                policy: serde_json::json!({"executionMode":"tools","allowedSkills":["write"]}),
                enabled: true,
            })
            .unwrap();
        let resolved = store
            .resolve_profile("bot", "user", "alice")
            .unwrap()
            .unwrap();
        assert_eq!(resolved.revision, 1);
        assert_eq!(resolved.policy["allowedSkills"][0], "read");
    }
    #[test]
    fn effective_resolution_prefers_principal_then_conversation_then_default() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        for id in ["default", "group", "legacy-group", "user"] {
            store
                .save_profile(SavePermissionProfile {
                    id: Some(id.into()),
                    name: id.into(),
                    policy: serde_json::json!({"executionMode":"tools","allowedSkills":[id]}),
                    enabled: true,
                })
                .unwrap();
        }
        for (principal_type, principal_id, profile_id) in [
            ("installation", "*", "default"),
            ("group", "room", "legacy-group"),
            ("conversation", "room", "group"),
            ("user", "alice", "user"),
        ] {
            store
                .bind_principal(SavePrincipalBinding {
                    id: None,
                    installation_id: "bot".into(),
                    principal_type: principal_type.into(),
                    principal_id: principal_id.into(),
                    profile_id: profile_id.into(),
                })
                .unwrap();
        }
        assert_eq!(
            store
                .resolve_effective_profile("bot", "alice", Some("room"))
                .unwrap()
                .unwrap()
                .id,
            "user"
        );
        assert_eq!(
            store
                .resolve_effective_profile("bot", "bob", Some("room"))
                .unwrap()
                .unwrap()
                .id,
            "group"
        );
        assert_eq!(
            store
                .resolve_effective_profile("bot", "bob", None)
                .unwrap()
                .unwrap()
                .id,
            "default"
        );
        assert!(store
            .resolve_effective_profile("other-installation", "bob", None)
            .unwrap()
            .is_none());
    }
    #[test]
    fn permission_policy_rejects_unknown_invalid_and_unbounded_fields() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let save = |policy| {
            store.save_profile(SavePermissionProfile {
                id: None,
                name: "invalid".into(),
                policy,
                enabled: true,
            })
        };
        assert!(save(serde_json::json!({"executionMode":"tools","unknown":true})).is_err());
        assert!(save(serde_json::json!({"executionMode":"root"})).is_err());
        assert!(
            save(serde_json::json!({"executionMode":"tools","allowEmptyWorkdir":"yes"})).is_err()
        );
        assert!(
            save(serde_json::json!({"executionMode":"tools","allowedSkills":["x","x"]})).is_err()
        );
        assert!(
            save(serde_json::json!({"executionMode":"tools","maxDurationSeconds":3601})).is_err()
        );
    }
    #[test]
    fn manual_profile_edits_and_disabling_stop_default_sync() {
        for (enabled, keep_policy) in [(true, false), (true, true), (false, true)] {
            let store = ChannelControlStore::open_in_memory().unwrap();
            let original = store
                .ensure_installation_default(default_input(&["read"]))
                .unwrap();
            let edited = store
                .save_profile(SavePermissionProfile {
                    id: Some(original.profile.id.clone()),
                    name: "Manual default".into(),
                    policy: if keep_policy {
                        original.profile.policy.clone()
                    } else {
                        serde_json::json!({"executionMode":"text","allowedSkills":[]})
                    },
                    enabled,
                })
                .unwrap();
            let before = current_default(&store);
            assert!(!before.follows_desktop);
            assert_eq!(before.profile_current_revision, 2);
            assert_eq!(before.binding.profile_revision, 1);
            let after = store
                .ensure_installation_default(default_input(&["scripts"]))
                .unwrap();
            assert_eq!(after, before);
            assert_eq!(store.list_profiles().unwrap(), vec![edited]);
            assert_eq!(revision_count(&store, &original.profile.id), 2);
            if !enabled {
                assert!(store
                    .resolve_effective_profile("wecom-bot", "alice", None)
                    .unwrap()
                    .is_none());
            }
        }
    }

    #[test]
    fn explicit_installation_rebinding_stops_sync_even_for_the_same_profile() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let original = store
            .ensure_installation_default(default_input(&["read"]))
            .unwrap();
        store
            .bind_principal(SavePrincipalBinding {
                id: Some(original.binding.id.clone()),
                installation_id: "wecom-bot".into(),
                principal_type: "installation".into(),
                principal_id: "*".into(),
                profile_id: original.profile.id.clone(),
            })
            .unwrap();
        let before = current_default(&store);
        assert!(!before.follows_desktop);
        let after = store
            .ensure_installation_default(default_input(&["scripts"]))
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(revision_count(&store, &original.profile.id), 1);
    }

    #[test]
    fn schema_upgrade_does_not_claim_legacy_defaults() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let mut original = store
            .ensure_installation_default(default_input(&["read"]))
            .unwrap();
        {
            let conn = store.lock().unwrap();
            conn.execute_batch(
                "DROP TABLE channel_managed_installation_defaults;
                 UPDATE channel_control_meta SET value='1' WHERE key='schema_version';",
            )
            .unwrap();
            initialize_schema(&conn).unwrap();
            initialize_schema(&conn).unwrap();
            let version: String = conn
                .query_row(
                    "SELECT value FROM channel_control_meta WHERE key='schema_version'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(version, "2");
        }
        original.follows_desktop = false;
        let untouched = store
            .ensure_installation_default(default_input(&["scripts"]))
            .unwrap();
        assert_eq!(untouched, original);
        assert_eq!(revision_count(&store, &original.profile.id), 1);
        assert_eq!(store.list_profiles().unwrap().len(), 1);
    }

    #[test]
    fn adoption_rejects_every_stale_expectation_without_writing() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let original = legacy_default(&store);
        for field in 0..5 {
            let mut input = adoption_input(&original);
            match field {
                0 => input.expected.binding_id = "different-binding".into(),
                1 => input.expected.profile_id = "different-profile".into(),
                2 => input.expected.profile_revision += 1,
                3 => input.expected.profile_current_revision += 1,
                _ => input.expected.policy_hash = "different-hash".into(),
            }
            let error = store.adopt_installation_default(input).unwrap_err();
            assert!(error.contains("installation default conflict"), "{error}");
            assert_eq!(current_default(&store), original);
            assert_eq!(store.list_profiles().unwrap().len(), 1);
            assert_eq!(revision_count(&store, &original.profile.id), 1);
        }
        let missing = ChannelControlStore::open_in_memory().unwrap();
        assert!(missing
            .adopt_installation_default(adoption_input(&original))
            .unwrap_err()
            .contains("conflict"));
        assert!(missing.list_profiles().unwrap().is_empty());
    }

    #[test]
    fn explicit_adoption_creates_a_new_profile_and_preserves_explicit_bindings() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let original = legacy_default(&store);
        for (principal_type, principal_id) in [
            ("user", "alice"),
            ("conversation", "room"),
            ("group", "legacy-room"),
        ] {
            store
                .bind_principal(SavePrincipalBinding {
                    id: None,
                    installation_id: "wecom-bot".into(),
                    principal_type: principal_type.into(),
                    principal_id: principal_id.into(),
                    profile_id: original.profile.id.clone(),
                })
                .unwrap();
        }
        let adopted = store
            .adopt_installation_default(adoption_input(&original))
            .unwrap();
        assert!(adopted.follows_desktop);
        assert_ne!(adopted.profile.id, original.profile.id);
        assert_eq!(adopted.profile.revision, 1);
        assert_eq!(adopted.binding.profile_revision, 1);
        assert_eq!(adopted.profile_current_revision, 1);
        assert_eq!(
            adopted.profile.policy["allowedSkills"],
            serde_json::json!(["read", "scripts"])
        );
        for (principal_type, principal_id) in [
            ("user", "alice"),
            ("conversation", "room"),
            ("group", "legacy-room"),
        ] {
            let frozen = store
                .resolve_profile("wecom-bot", principal_type, principal_id)
                .unwrap()
                .unwrap();
            assert_eq!(frozen, original.profile);
        }
        let profiles = store.list_profiles().unwrap();
        assert_eq!(profiles.len(), 2);
        assert_eq!(
            profiles
                .iter()
                .find(|profile| profile.id == original.profile.id),
            Some(&original.profile)
        );
        assert!(store
            .adopt_installation_default(adoption_input(&original))
            .unwrap_err()
            .contains("conflict"));
        assert_eq!(store.list_profiles().unwrap().len(), 2);
        let synced = store
            .ensure_installation_default(default_input(&["scripts"]))
            .unwrap();
        assert_eq!(synced.profile.id, adopted.profile.id);
        assert_eq!(synced.profile.revision, 2);
    }

    #[test]
    fn stale_ownership_and_adoption_expectations_do_not_override_manual_edits() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let original = store
            .ensure_installation_default(default_input(&["read"]))
            .unwrap();
        store
            .save_profile(SavePermissionProfile {
                id: Some(original.profile.id.clone()),
                name: "Manual".into(),
                policy: serde_json::json!({"executionMode":"text"}),
                enabled: true,
            })
            .unwrap();
        store.lock().unwrap().execute(
            "INSERT INTO channel_managed_installation_defaults (installation_id,profile_id,binding_id,last_synced_revision) VALUES (?1,?2,?3,1)",
            params!["wecom-bot", original.profile.id, original.binding.id],
        ).unwrap();
        let before = current_default(&store);
        assert!(!before.follows_desktop);
        assert_eq!(before.profile_current_revision, 2);
        assert_eq!(before.profile.revision, 1);
        assert_eq!(before.profile.policy_hash, original.profile.policy_hash);
        assert_eq!(
            store
                .ensure_installation_default(default_input(&["scripts"]))
                .unwrap(),
            before
        );
        assert!(store
            .adopt_installation_default(adoption_input(&original))
            .unwrap_err()
            .contains("conflict"));
        assert_eq!(current_default(&store), before);
        assert_eq!(revision_count(&store, &original.profile.id), 2);
    }

    #[test]
    fn installation_default_dtos_use_camel_case() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let original = legacy_default(&store);
        let response = serde_json::to_value(&original).unwrap();
        assert_eq!(response["followsDesktop"], false);
        assert_eq!(response["profileCurrentRevision"], 1);
        assert!(response.get("follows_desktop").is_none());
        assert!(response.get("profile_current_revision").is_none());
        let input: AdoptInstallationDefault = serde_json::from_value(serde_json::json!({
            "installationId": "wecom-bot",
            "name": "Desktop default",
            "policy": {"executionMode":"tools","allowedSkills":["scripts"]},
            "expected": {
                "bindingId": original.binding.id,
                "profileId": original.profile.id,
                "profileRevision": original.binding.profile_revision,
                "profileCurrentRevision": original.profile_current_revision,
                "policyHash": original.profile.policy_hash
            }
        }))
        .unwrap();
        let adopted = store.adopt_installation_default(input).unwrap();
        assert_eq!(
            serde_json::to_value(adopted).unwrap()["followsDesktop"],
            true
        );
    }

    #[test]
    fn concurrent_default_sync_uses_one_revision_across_connections() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("channel-control-test.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.busy_timeout(Duration::from_secs(5)).unwrap();
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        initialize_schema(&connection).unwrap();
        let store = ChannelControlStore {
            conn: Mutex::new(connection),
        };
        let original = store
            .ensure_installation_default(default_input(&["read"]))
            .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let connection = Connection::open(path).unwrap();
                    connection.busy_timeout(Duration::from_secs(5)).unwrap();
                    connection
                        .pragma_update(None, "foreign_keys", true)
                        .unwrap();
                    let store = ChannelControlStore {
                        conn: Mutex::new(connection),
                    };
                    barrier.wait();
                    store
                        .ensure_installation_default(default_input(&["read", "scripts"]))
                        .unwrap()
                })
            })
            .collect();
        for handle in handles {
            let synced = handle.join().unwrap();
            assert_eq!(synced.profile.id, original.profile.id);
            assert_eq!(synced.profile.revision, 2);
            assert_eq!(synced.binding.profile_revision, 2);
            assert_eq!(synced.profile_current_revision, 2);
            assert!(synced.follows_desktop);
            assert_eq!(
                synced.profile.policy_hash,
                policy_hash(&synced.profile.policy).unwrap()
            );
        }
        assert_eq!(store.list_profiles().unwrap().len(), 1);
        assert_eq!(revision_count(&store, &original.profile.id), 2);
    }

    #[test]
    fn failed_manual_changes_preserve_managed_ownership() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let original = store
            .ensure_installation_default(default_input(&["read"]))
            .unwrap();
        store
            .bind_principal(SavePrincipalBinding {
                id: Some("reserved-binding".into()),
                installation_id: "wecom-bot".into(),
                principal_type: "user".into(),
                principal_id: "alice".into(),
                profile_id: original.profile.id.clone(),
            })
            .unwrap();
        assert!(store
            .bind_principal(SavePrincipalBinding {
                id: Some("reserved-binding".into()),
                installation_id: "wecom-bot".into(),
                principal_type: "installation".into(),
                principal_id: "*".into(),
                profile_id: original.profile.id.clone(),
            })
            .is_err());
        assert_eq!(current_default(&store), original);
        store.lock().unwrap().execute_batch(
            "CREATE TEMP TRIGGER fail_profile_revision BEFORE INSERT ON channel_permission_profile_revisions
             BEGIN SELECT RAISE(ABORT, 'test profile write failure'); END;"
        ).unwrap();
        assert!(store
            .save_profile(SavePermissionProfile {
                id: Some(original.profile.id.clone()),
                name: "Manual".into(),
                policy: original.profile.policy.clone(),
                enabled: true,
            })
            .is_err());
        assert_eq!(current_default(&store), original);
        assert_eq!(revision_count(&store, &original.profile.id), 1);
    }

    #[test]
    fn disabled_profile_with_a_stale_marker_is_not_reenabled() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let original = store
            .ensure_installation_default(default_input(&["read"]))
            .unwrap();
        store
            .lock()
            .unwrap()
            .execute(
                "UPDATE channel_permission_profiles SET enabled=0 WHERE id=?1",
                params![original.profile.id],
            )
            .unwrap();
        let disabled = current_default(&store);
        assert!(!disabled.follows_desktop);
        assert!(!disabled.profile.enabled);
        assert_eq!(
            store
                .ensure_installation_default(default_input(&["scripts"]))
                .unwrap(),
            disabled
        );
        assert_eq!(revision_count(&store, &original.profile.id), 1);
    }

    #[test]
    fn ensure_installation_default_is_atomic_and_idempotent() {
        let store = std::sync::Arc::new(ChannelControlStore::open_in_memory().unwrap());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let store = std::sync::Arc::clone(&store);
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    store
                        .ensure_installation_default(EnsureInstallationDefault {
                            installation_id: "wecom-bot".into(),
                            name: format!("Default {index}"),
                            policy: serde_json::json!({
                                "executionMode":"tools",
                                "maxOutputChars": 1000
                            }),
                        })
                        .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        for result in &results[1..] {
            assert_eq!(result.profile.id, results[0].profile.id);
            assert_eq!(result.profile.revision, 1);
            assert_eq!(result.profile.policy_hash, results[0].profile.policy_hash);
            assert_eq!(result.binding.id, results[0].binding.id);
        }
        assert_eq!(store.list_profiles().unwrap().len(), 1);
        assert_eq!(
            store
                .resolve_effective_profile("wecom-bot", "alice", None)
                .unwrap()
                .unwrap()
                .id,
            results[0].profile.id
        );
    }
    #[test]
    fn target_id_and_outbox_are_idempotent() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let target = store
            .upsert_target(SaveDeliveryTarget {
                channel: "wecom".into(),
                installation_id: "bot".into(),
                external_target_id: "chat".into(),
                target_type: "group".into(),
                display_name: "Chat".into(),
                enabled: true,
                validation_status: "valid".into(),
            })
            .unwrap();
        let again = store
            .upsert_target(SaveDeliveryTarget {
                channel: "wecom".into(),
                installation_id: "bot".into(),
                external_target_id: "chat".into(),
                target_type: "group".into(),
                display_name: "Chat 2".into(),
                enabled: true,
                validation_status: "valid".into(),
            })
            .unwrap();
        assert_eq!(target.id, again.id);
        assert_eq!(again.revision, 2);
        let first = store
            .enqueue(EnqueueDelivery {
                target_id: target.id.clone(),
                run_id: None,
                idempotency_key: "k".into(),
                body: "x".into(),
            })
            .unwrap();
        let second = store
            .enqueue(EnqueueDelivery {
                target_id: target.id,
                run_id: None,
                idempotency_key: "k".into(),
                body: "y".into(),
            })
            .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.body, "x");
        let claimed = store.claim_outbox(10, 1000).unwrap();
        assert_eq!(claimed.len(), 1);
        assert!(store.mark_outbox(&claimed[0].id, "prepared", None).is_err());
        store.mark_outbox(&claimed[0].id, "sent", None).unwrap();
        assert!(store.mark_outbox(&claimed[0].id, "sent", None).is_err());
    }

    #[test]
    fn transaction_enqueue_and_run_claim_return_the_registered_target() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let target = store
            .upsert_target(SaveDeliveryTarget {
                channel: "wecom".into(),
                installation_id: "bot".into(),
                external_target_id: "chat".into(),
                target_type: "group".into(),
                display_name: "Room".into(),
                enabled: true,
                validation_status: "valid".into(),
            })
            .unwrap();
        let input = EnqueueDelivery {
            target_id: target.id.clone(),
            run_id: Some("run-1".into()),
            idempotency_key: "run-1:delivery".into(),
            body: "done".into(),
        };
        {
            let mut conn = store.lock().unwrap();
            let tx = conn.transaction().unwrap();
            enqueue_delivery_in_transaction(&tx, &input).unwrap();
            tx.rollback().unwrap();
        }
        store.enqueue(input).unwrap();
        let claimed = store.claim_outbox_for_run("run-1").unwrap().unwrap();
        assert_eq!(claimed.target.id, target.id);
        assert_eq!(claimed.target.display_name, "Room");
        assert_eq!(claimed.outbox.status, "sending");
        assert!(store.claim_outbox_for_run("run-1").unwrap().is_none());
    }

    #[test]
    fn uncertain_send_is_never_automatically_reclaimed() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let target = store
            .upsert_target(SaveDeliveryTarget {
                channel: "wecom".into(),
                installation_id: "bot".into(),
                external_target_id: "chat".into(),
                target_type: "group".into(),
                display_name: String::new(),
                enabled: true,
                validation_status: "valid".into(),
            })
            .unwrap();
        let queued = store
            .enqueue(EnqueueDelivery {
                target_id: target.id,
                run_id: None,
                idempotency_key: "uncertain".into(),
                body: "x".into(),
            })
            .unwrap();
        assert_eq!(store.claim_outbox(1, 1).unwrap().len(), 1);
        assert!(store.claim_outbox(1, 1).unwrap().is_empty());
        {
            let conn = store.lock().unwrap();
            recover_interrupted_sends(&conn).unwrap();
            let status: String = conn
                .query_row(
                    "SELECT status FROM channel_delivery_outbox WHERE id=?1",
                    params![queued.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(status, "unknown");
        }
        assert!(store.claim_outbox(1, 1).unwrap().is_empty());
    }

    #[test]
    fn enqueue_rejects_missing_disabled_or_unvalidated_targets() {
        let store = ChannelControlStore::open_in_memory().unwrap();
        let input = |target_id: String, key: &str| EnqueueDelivery {
            target_id,
            run_id: None,
            idempotency_key: key.to_string(),
            body: "x".into(),
        };
        assert!(store.enqueue(input("missing".into(), "missing")).is_err());
        let disabled = store
            .upsert_target(SaveDeliveryTarget {
                channel: "wecom".into(),
                installation_id: "bot".into(),
                external_target_id: "disabled".into(),
                target_type: "user".into(),
                display_name: String::new(),
                enabled: false,
                validation_status: "valid".into(),
            })
            .unwrap();
        assert!(store.enqueue(input(disabled.id, "disabled")).is_err());

        for validation_status in ["pending", "invalid"] {
            let target = store
                .upsert_target(SaveDeliveryTarget {
                    channel: "wecom".into(),
                    installation_id: "bot".into(),
                    external_target_id: format!("{validation_status}-target"),
                    target_type: "user".into(),
                    display_name: String::new(),
                    enabled: true,
                    validation_status: validation_status.into(),
                })
                .unwrap();
            assert!(store
                .enqueue(input(target.id, &format!("{validation_status}-enqueue")))
                .is_err());
        }

        let enabled = store
            .upsert_target(SaveDeliveryTarget {
                channel: "wecom".into(),
                installation_id: "bot".into(),
                external_target_id: "later-disabled".into(),
                target_type: "user".into(),
                display_name: String::new(),
                enabled: true,
                validation_status: "valid".into(),
            })
            .unwrap();
        store.enqueue(input(enabled.id.clone(), "queued")).unwrap();
        store
            .upsert_target(SaveDeliveryTarget {
                channel: "wecom".into(),
                installation_id: "bot".into(),
                external_target_id: "later-disabled".into(),
                target_type: "user".into(),
                display_name: String::new(),
                enabled: false,
                validation_status: "valid".into(),
            })
            .unwrap();
        assert!(store.claim_outbox(10, 1000).unwrap().is_empty());

        let unvalidated = store
            .upsert_target(SaveDeliveryTarget {
                channel: "wecom".into(),
                installation_id: "bot".into(),
                external_target_id: "later-unvalidated".into(),
                target_type: "user".into(),
                display_name: String::new(),
                enabled: true,
                validation_status: "valid".into(),
            })
            .unwrap();
        store
            .enqueue(input(unvalidated.id.clone(), "queued-unvalidated"))
            .unwrap();
        for validation_status in ["pending", "invalid"] {
            store
                .upsert_target(SaveDeliveryTarget {
                    channel: "wecom".into(),
                    installation_id: "bot".into(),
                    external_target_id: "later-unvalidated".into(),
                    target_type: "user".into(),
                    display_name: String::new(),
                    enabled: true,
                    validation_status: validation_status.into(),
                })
                .unwrap();
            assert!(store.claim_outbox(10, 1000).unwrap().is_empty());
        }
    }
}
