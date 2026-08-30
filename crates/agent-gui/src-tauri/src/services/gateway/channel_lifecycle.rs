//! Authenticated channel routing controls. History remains in the history DB;
//! these associations and receipts never claim cross-database atomicity.

use super::*;
use crate::commands::settings::open_db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize)]
struct ChannelInstallationIdentity<'a> {
    bot_id: &'a str,
    channel: &'a str,
    connector_id: &'a str,
    tenant_id: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelConversationBinding {
    pub conversation_id: String,
    pub installation_id: String,
    pub scope_key: String,
    pub session_id: String,
    pub generation: u64,
    #[serde(default)]
    pub lifecycle_version: u32,
}

/// Local UI sources never own an external routing pointer. Every other
/// authenticated source fails closed when its current binding snapshot is
/// unavailable. The archive core does not enumerate connector vendors.
pub fn source_requires_channel_binding(source_id: Option<&str>) -> bool {
    match source_id.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("unknown" | "desktop" | "web") => false,
        Some(_) => true,
    }
}

fn binding_db() -> Result<Connection, String> {
    let conn = open_db()?;
    ensure_binding_schema(&conn)?;
    Ok(conn)
}

fn ensure_binding_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS channel_conversation_bindings (
        conversation_id TEXT NOT NULL, installation_id TEXT NOT NULL, scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL, generation INTEGER NOT NULL, lifecycle_version INTEGER NOT NULL DEFAULT 0,
        closed_at INTEGER, PRIMARY KEY(conversation_id,installation_id,scope_key,session_id)
    ); CREATE INDEX IF NOT EXISTS idx_channel_bindings_conversation ON channel_conversation_bindings(conversation_id,closed_at);")
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record_channel_binding(input: ChannelConversationBinding) -> Result<(), String> {
    record_channel_binding_on(&binding_db()?, input)
}

fn record_channel_binding_on(
    conn: &Connection,
    input: ChannelConversationBinding,
) -> Result<(), String> {
    if input.conversation_id.trim().is_empty()
        || input.installation_id.trim().is_empty()
        || input.session_id.trim().is_empty()
        || input.scope_key.trim().is_empty()
        || input.scope_key.len() > 2048
        || input.installation_id.len() > 4096
        || input.generation == 0
        || input.generation > 9_007_199_254_740_991
    {
        return Err("Invalid channel conversation binding".into());
    }
    conn.execute("INSERT INTO channel_conversation_bindings(conversation_id,installation_id,scope_key,session_id,generation,lifecycle_version)
        VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(conversation_id,installation_id,scope_key,session_id) DO UPDATE SET
        closed_at=CASE WHEN excluded.generation > channel_conversation_bindings.generation THEN NULL ELSE channel_conversation_bindings.closed_at END,
        generation=MAX(generation,excluded.generation),lifecycle_version=MAX(lifecycle_version,excluded.lifecycle_version)",
        params![input.conversation_id,input.installation_id,input.scope_key,input.session_id,input.generation as i64,input.lifecycle_version as i64])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn channel_installation_id(
    channel: &str,
    tenant_id: &str,
    bot_id: &str,
    connector_id: &str,
) -> Result<String, String> {
    serde_json::to_string(&ChannelInstallationIdentity {
        bot_id: bot_id.trim(),
        channel: channel.trim(),
        connector_id: connector_id.trim(),
        tenant_id: tenant_id.trim(),
    })
    .map_err(|error| format!("encode channel installation identity failed: {error}"))
}

/// Derive and validate a binding carried by the same authenticated chat
/// envelope that will be admitted into the desktop runtime. Recording this
/// before enqueue makes binding delivery and chat admission fail together;
/// connector snapshots remain a recovery path for conversations with no new
/// inbound message after the desktop reconnects.
pub(crate) fn binding_from_trusted_chat(
    event: &GatewayChatRequestEvent,
) -> Result<Option<ChannelConversationBinding>, String> {
    let Some(origin) = event.origin.as_ref() else {
        return Ok(None);
    };
    if origin.channel_lifecycle_version == 0 {
        return Ok(None);
    }
    if origin.channel_lifecycle_version != 1 {
        return Err("channel_archive_unsupported: unsupported channel lifecycle version".into());
    }
    let binding = ChannelConversationBinding {
        conversation_id: event.conversation_id.trim().to_string(),
        installation_id: channel_installation_id(
            &origin.channel,
            &origin.tenant_id,
            &origin.bot_id,
            &origin.connector_id,
        )?,
        scope_key: origin.channel_scope_key.trim().to_string(),
        session_id: origin.channel_session_id.trim().to_string(),
        generation: origin.channel_session_generation,
        lifecycle_version: origin.channel_lifecycle_version,
    };
    if binding.conversation_id.is_empty()
        || binding.scope_key.is_empty()
        || binding.session_id.is_empty()
        || binding.generation == 0
    {
        return Err("invalid trusted channel binding metadata".into());
    }
    Ok(Some(binding))
}

pub fn list_channel_bindings(
    conversation_id: &str,
) -> Result<Vec<ChannelConversationBinding>, String> {
    let conn = binding_db()?;
    let mut stmt = conn.prepare("SELECT conversation_id,installation_id,scope_key,session_id,generation,lifecycle_version
        FROM channel_conversation_bindings WHERE conversation_id=?1 AND closed_at IS NULL ORDER BY installation_id,scope_key,session_id")
        .map_err(|e| e.to_string())?;
    let records = stmt
        .query_map([conversation_id], |row| {
            Ok(ChannelConversationBinding {
                conversation_id: row.get(0)?,
                installation_id: row.get(1)?,
                scope_key: row.get(2)?,
                session_id: row.get(3)?,
                generation: row.get::<_, i64>(4)? as u64,
                lifecycle_version: row.get::<_, i64>(5)? as u32,
            })
        })
        .map_err(|e| e.to_string())?;
    records
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// An empty open-binding list is safe only when the registry has durable
/// evidence that this conversation had a binding and every known route was
/// closed. No rows at all remains an unknown/fail-closed state.
pub fn has_known_channel_binding(conversation_id: &str) -> Result<bool, String> {
    binding_db()?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM channel_conversation_bindings WHERE conversation_id = ?1)",
            [conversation_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
}

pub fn mark_channel_binding_closed(binding: &ChannelConversationBinding) -> Result<(), String> {
    mark_channel_binding_closed_on(&binding_db()?, binding)
}

fn mark_channel_binding_closed_on(
    conn: &Connection,
    binding: &ChannelConversationBinding,
) -> Result<(), String> {
    let changed = conn.execute("UPDATE channel_conversation_bindings SET closed_at=COALESCE(closed_at,?1)
        WHERE conversation_id=?2 AND installation_id=?3 AND scope_key=?4 AND session_id=?5 AND generation=?6",
        params![now_unix_seconds(),binding.conversation_id,binding.installation_id,binding.scope_key,binding.session_id,binding.generation as i64])
        .map_err(|e|e.to_string())?;
    if changed == 1 {
        return Ok(());
    }
    let current: Option<(i64, Option<i64>)> = conn
        .query_row(
            "SELECT generation,closed_at FROM channel_conversation_bindings
             WHERE conversation_id=?1 AND installation_id=?2 AND scope_key=?3 AND session_id=?4",
            params![
                binding.conversation_id,
                binding.installation_id,
                binding.scope_key,
                binding.session_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match current {
        // The connector's authoritative reply resolved the frozen generation;
        // never mark a newer route closed on behalf of that older snapshot.
        Some((generation, _)) if generation > binding.generation as i64 => Ok(()),
        Some((generation, Some(_))) if generation == binding.generation as i64 => Ok(()),
        _ => Err("channel_binding_registry_conflict".into()),
    }
}

pub(crate) fn is_archive_gate_rejection(error: &str) -> bool {
    error.starts_with("conversation_archived") || error.starts_with("conversation_archive_pending")
}

fn rejected_binding_operation_id(request_id: &str, binding: &ChannelConversationBinding) -> String {
    let identity = serde_json::to_vec(&serde_json::json!({
        "requestId": request_id.trim(),
        "installationId": binding.installation_id,
        "scopeKey": binding.scope_key,
        "sessionId": binding.session_id,
        "generation": binding.generation,
    }))
    .unwrap_or_default();
    let digest = Sha256::digest(identity);
    let hash: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("archive-rejected-binding:{hash}")
}

impl GatewayController {
    /// If archive preparation wins the history-DB race against a newly
    /// arrived channel request, that request cannot enter the native inbox.
    /// Close its authenticated route before reporting the rejection so the
    /// connector lazily creates a fresh conversation on the next inbound.
    pub(crate) async fn close_archive_rejected_binding(
        &self,
        request_id: &str,
        binding: &ChannelConversationBinding,
    ) -> Result<(), String> {
        let response = self
            .channel_binding_request(proto::ChannelBindingRequest {
                operation_id: rejected_binding_operation_id(request_id, binding),
                action: "close".into(),
                installation_id: binding.installation_id.clone(),
                scope_key: binding.scope_key.clone(),
                expected_session_id: binding.session_id.clone(),
                expected_generation: binding.generation,
            })
            .await?;
        match response.status.trim() {
            "closed" | "not_current" | "not_found" => {
                let binding = binding.clone();
                tauri::async_runtime::spawn_blocking(move || mark_channel_binding_closed(&binding))
                    .await
                    .map_err(|error| error.to_string())?
            }
            "busy" => Err("channel_archive_pending: 渠道正在处理并发消息".into()),
            "unsupported" => Err("channel_archive_unsupported: 渠道连接器不支持安全归档".into()),
            "conflict" => Err("channel_binding_conflict: 渠道会话已经变化".into()),
            status => Err(format!("channel_archive_unknown_status: {status}")),
        }
    }

    pub async fn channel_binding_request(
        &self,
        request: proto::ChannelBindingRequest,
    ) -> Result<proto::ChannelBindingResponse, String> {
        if !self.status().online {
            return Err("Channel gateway is offline".into());
        }
        let request_id = format!("channel-binding-{}", uuid::Uuid::new_v4());
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self
                .pending_channel_binding_requests
                .lock()
                .map_err(|_| "Channel lifecycle state unavailable")?;
            if pending.len() >= 256 {
                return Err("Too many pending channel lifecycle operations".into());
            }
            pending.insert(request_id.clone(), (request.operation_id.clone(), sender));
        }
        let sent = self
            .send_agent_envelope(proto::AgentEnvelope {
                request_id: request_id.clone(),
                timestamp: now_unix_seconds(),
                payload: Some(proto::agent_envelope::Payload::ChannelBinding(request)),
            })
            .await;
        let result = match sent {
            Err(error) => Err(error),
            Ok(()) => tokio::time::timeout(Duration::from_secs(15), receiver)
                .await
                .map_err(|_| {
                    "Channel lifecycle result is unknown; retry the same operation ID".to_string()
                })
                .and_then(|reply| {
                    reply.map_err(|_| "Channel lifecycle response interrupted".to_string())
                }),
        };
        if let Ok(mut pending) = self.pending_channel_binding_requests.lock() {
            pending.remove(&request_id);
        }
        result
    }

    pub(crate) fn receive_channel_binding_response(
        &self,
        request_id: &str,
        response: proto::ChannelBindingResponse,
    ) {
        if let Ok(mut pending) = self.pending_channel_binding_requests.lock() {
            if pending
                .get(request_id)
                .is_some_and(|(id, _)| id == &response.operation_id)
            {
                if let Some((_, sender)) = pending.remove(request_id) {
                    let _ = sender.send(response);
                }
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelBindingInput {
    pub operation_id: String,
    pub action: String,
    pub installation_id: String,
    pub scope_key: String,
    pub expected_session_id: String,
    pub expected_generation: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelBindingResult {
    pub operation_id: String,
    pub status: String,
    pub session_id: String,
    pub generation: u64,
    pub message: String,
}

impl From<ChannelBindingInput> for proto::ChannelBindingRequest {
    fn from(input: ChannelBindingInput) -> Self {
        Self {
            operation_id: input.operation_id,
            action: input.action,
            installation_id: input.installation_id,
            scope_key: input.scope_key,
            expected_session_id: input.expected_session_id,
            expected_generation: input.expected_generation,
        }
    }
}
impl From<proto::ChannelBindingResponse> for ChannelBindingResult {
    fn from(reply: proto::ChannelBindingResponse) -> Self {
        Self {
            operation_id: reply.operation_id,
            status: reply.status,
            session_id: reply.session_id,
            generation: reply.generation,
            message: reply.message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        channel_installation_id, ensure_binding_schema, is_archive_gate_rejection,
        mark_channel_binding_closed_on, record_channel_binding_on, rejected_binding_operation_id,
        source_requires_channel_binding, ChannelConversationBinding,
    };
    use rusqlite::Connection;

    #[test]
    fn routing_requirement_uses_trusted_source_metadata_not_conversation_ids() {
        assert!(!source_requires_channel_binding(None));
        assert!(!source_requires_channel_binding(Some("desktop")));
        assert!(!source_requires_channel_binding(Some("web")));
        assert!(source_requires_channel_binding(Some("wecom")));
        assert!(source_requires_channel_binding(Some(
            "future-registered-adapter"
        )));
    }

    #[test]
    fn installation_identity_matches_the_connector_contract() {
        assert_eq!(
            channel_installation_id("wecom", r#"租户\one"#, "机器人<&", r#"connector"one"#)
                .expect("serialize installation identity"),
            r#"{"bot_id":"机器人<&","channel":"wecom","connector_id":"connector\"one","tenant_id":"租户\\one"}"#
        );
    }

    #[test]
    fn higher_generation_reopens_a_reused_session_id_without_replaying_stale_snapshots() {
        let conn = Connection::open_in_memory().expect("open binding database");
        ensure_binding_schema(&conn).expect("create binding schema");
        let binding = |generation| ChannelConversationBinding {
            conversation_id: "conversation-1".into(),
            installation_id: "installation-1".into(),
            scope_key: "scope-1".into(),
            session_id: "reused-session".into(),
            generation,
            lifecycle_version: 1,
        };
        record_channel_binding_on(&conn, binding(1)).expect("record first generation");
        conn.execute(
            "UPDATE channel_conversation_bindings SET closed_at = 1 WHERE conversation_id = 'conversation-1'",
            [],
        )
        .expect("close first generation");

        record_channel_binding_on(&conn, binding(1)).expect("replay first generation");
        let stale_closed_at: Option<i64> = conn
            .query_row(
                "SELECT closed_at FROM channel_conversation_bindings WHERE conversation_id = 'conversation-1'",
                [],
                |row| row.get(0),
            )
            .expect("read stale replay");
        assert_eq!(stale_closed_at, Some(1));

        record_channel_binding_on(&conn, binding(2)).expect("record second generation");
        let (generation, reopened_at): (i64, Option<i64>) = conn
            .query_row(
                "SELECT generation, closed_at FROM channel_conversation_bindings WHERE conversation_id = 'conversation-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read reopened binding");
        assert_eq!(generation, 2);
        assert_eq!(reopened_at, None);
    }

    #[test]
    fn archive_gate_rejection_uses_a_stable_bounded_binding_operation_id() {
        let binding = ChannelConversationBinding {
            conversation_id: "conversation-1".into(),
            installation_id: "installation-1".into(),
            scope_key: "scope-1".into(),
            session_id: "session-1".into(),
            generation: 7,
            lifecycle_version: 1,
        };
        let first = rejected_binding_operation_id("request-1", &binding);
        assert_eq!(first, rejected_binding_operation_id("request-1", &binding));
        assert!(first.len() <= 256);
        assert!(is_archive_gate_rejection("conversation_archived: archived"));
        assert!(is_archive_gate_rejection("conversation_archive_pending"));
        assert!(!is_archive_gate_rejection("conversation_busy"));
    }

    #[test]
    fn resolving_an_old_generation_never_closes_its_newer_replacement() {
        let conn = Connection::open_in_memory().expect("open binding database");
        ensure_binding_schema(&conn).expect("create binding schema");
        let binding = |generation| ChannelConversationBinding {
            conversation_id: "conversation-1".into(),
            installation_id: "installation-1".into(),
            scope_key: "scope-1".into(),
            session_id: "reused-session".into(),
            generation,
            lifecycle_version: 1,
        };
        record_channel_binding_on(&conn, binding(1)).expect("record first generation");
        record_channel_binding_on(&conn, binding(2)).expect("record newer generation");

        mark_channel_binding_closed_on(&conn, &binding(1))
            .expect("older generation is already authoritatively resolved");
        let closed_at: Option<i64> = conn
            .query_row(
                "SELECT closed_at FROM channel_conversation_bindings WHERE conversation_id='conversation-1'",
                [],
                |row| row.get(0),
            )
            .expect("read newer binding");
        assert_eq!(closed_at, None);
    }
}
