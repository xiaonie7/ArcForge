//! Durable conversation archive coordinator.
//!
//! History, runtime admission and channel routing live in different stores.
//! The prepared history operation is therefore the durable gate; connector
//! acknowledgements are replayed with stable operation IDs until every frozen
//! binding is closed, after which the history transition is committed.

use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::Manager;

use crate::commands::chat_history::{self, ChatHistorySummary};
use crate::services::conversation_lifecycle::{self, ArchiveMutationInput, LifecycleOperation};
use crate::services::gateway::{
    build_history_sync_delete, build_history_sync_upsert, has_known_channel_binding,
    list_channel_bindings, mark_channel_binding_closed, proto, source_requires_channel_binding,
    ChannelConversationBinding, GatewayController,
};

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

fn binding_operation_id(operation_id: &str, index: usize) -> String {
    let candidate = format!("{operation_id}:binding:{index}");
    if candidate.len() <= 240 {
        return candidate;
    }
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(candidate.as_bytes());
    let hash: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("archive-binding:{hash}")
}

fn operation_input(operation: &LifecycleOperation) -> ArchiveMutationInput {
    ArchiveMutationInput {
        id: operation.conversation_id.clone(),
        operation_id: operation.operation_id.clone(),
        expected_lifecycle_version: operation.expected_lifecycle_version,
        expected_activity_version: Some(operation.expected_activity_version),
        reason: Some(operation.reason.clone()),
        policy_revision: operation.policy_revision,
        scheduled_for_at: operation.scheduled_for_at,
    }
}

fn needs_binding_preflight(existing: Option<&LifecycleOperation>) -> bool {
    match existing {
        None => true,
        Some(operation) => {
            operation.status == "aborted"
                || (operation.status == "prepared" && operation.binding_snapshot_json.is_none())
        }
    }
}

async fn existing_operation(operation_id: &str) -> Result<Option<LifecycleOperation>, String> {
    let id = operation_id.to_string();
    blocking(move || conversation_lifecycle::operation(&id)).await
}

/// Archive one conversation. Retrying the exact input resumes the same
/// prepared operation; a caller must never invent a replacement operation ID
/// after an acknowledgement timeout.
pub async fn archive_conversation(
    app: &tauri::AppHandle,
    input: ArchiveMutationInput,
) -> Result<ChatHistorySummary, String> {
    let controller = app.state::<Arc<GatewayController>>().inner().clone();
    // A prepared/completed operation must reuse its frozen binding snapshot.
    // An aborted operation is deleted and prepared again by the lifecycle
    // store, so it must also repeat the channel preflight. Otherwise a retry
    // after a busy acknowledgement could freeze an empty binding list and
    // archive history while the connector still routes to it.
    let existing = existing_operation(&input.operation_id).await?;

    let needs_binding_preflight = needs_binding_preflight(existing.as_ref());
    let current_bindings = if needs_binding_preflight {
        let id = input.id.clone();
        let bindings = blocking(move || list_channel_bindings(&id)).await?;
        let metadata_id = input.id.clone();
        let source_id = blocking(move || {
            Ok(conversation_lifecycle::metadata(&metadata_id)?
                .and_then(|metadata| metadata.origin_source_id))
        })
        .await?;
        let has_known_binding =
            if bindings.is_empty() && source_requires_channel_binding(source_id.as_deref()) {
                let id = input.id.clone();
                blocking(move || has_known_channel_binding(&id)).await?
            } else {
                false
            };
        if bindings.is_empty()
            && source_requires_channel_binding(source_id.as_deref())
            && !has_known_binding
        {
            return Err(
                "channel_binding_unknown: 渠道会话尚未完成安全路由回填，请等待连接器上线后重试"
                    .into(),
            );
        }
        if bindings.iter().any(|binding| {
            binding.lifecycle_version < 1
                || binding.scope_key.trim().is_empty()
                || binding.generation == 0
        }) {
            return Err("channel_archive_unsupported: 当前渠道连接器版本不支持安全归档".into());
        }
        bindings
    } else {
        Vec::new()
    };

    if controller.has_pending_chat_request(&input.id)? {
        return Err("conversation_busy: 会话仍有待处理消息".into());
    }

    let prepared_input = input.clone();
    let operation =
        blocking(move || conversation_lifecycle::prepare_archive(&prepared_input, now_ms()))
            .await?;
    if operation.status == "completed" {
        let operation_id = operation.operation_id.clone();
        return blocking(move || conversation_lifecycle::complete_archive(&operation_id, now_ms()))
            .await;
    }

    let bindings: Vec<ChannelConversationBinding> =
        if let Some(snapshot) = &operation.binding_snapshot_json {
            serde_json::from_str(snapshot)
                .map_err(|error| format!("invalid_binding_snapshot: {error}"))?
        } else {
            let snapshot =
                serde_json::to_string(&current_bindings).map_err(|error| error.to_string())?;
            let operation_id = operation.operation_id.clone();
            blocking(move || {
                conversation_lifecycle::set_operation_bindings(&operation_id, &snapshot, now_ms())
            })
            .await?;
            current_bindings
        };

    // Close the race between the preflight check and the durable prepare. No
    // external routing side effect has happened yet, so this case can abort.
    if controller.has_pending_chat_request(&operation.conversation_id)? {
        let operation_id = operation.operation_id.clone();
        blocking(move || {
            conversation_lifecycle::abort_archive(&operation_id, "conversation_busy", now_ms())
        })
        .await?;
        return Err("conversation_busy: 会话收到了一条新的待处理消息".into());
    }

    let mut acknowledged_close = false;
    for (index, binding) in bindings.iter().enumerate() {
        let response = controller
            .channel_binding_request(proto::ChannelBindingRequest {
                operation_id: binding_operation_id(&operation.operation_id, index),
                action: "close".into(),
                installation_id: binding.installation_id.clone(),
                scope_key: binding.scope_key.clone(),
                expected_session_id: binding.session_id.clone(),
                expected_generation: binding.generation,
            })
            .await?;
        match response.status.trim() {
            "closed" => {
                acknowledged_close = true;
                let binding = binding.clone();
                blocking(move || mark_channel_binding_closed(&binding)).await?;
            }
            "not_current" | "not_found" => {
                // This frozen binding is durably resolved. It may have been
                // closed by an earlier attempt whose response was lost, so a
                // later busy binding must not cause the operation to abort.
                acknowledged_close = true;
                let binding = binding.clone();
                blocking(move || mark_channel_binding_closed(&binding)).await?;
            }
            "busy" if !acknowledged_close => {
                let operation_id = operation.operation_id.clone();
                blocking(move || {
                    conversation_lifecycle::abort_archive(&operation_id, "channel_busy", now_ms())
                })
                .await?;
                return Err("conversation_busy: 渠道仍在处理该会话的消息".into());
            }
            "busy" => return Err("channel_archive_pending: 部分渠道已关闭，将自动继续对账".into()),
            "unsupported" => {
                return Err("channel_archive_unsupported: 渠道连接器不支持安全归档".into())
            }
            "conflict" => {
                return Err("channel_binding_conflict: 渠道会话已经变化，归档等待对账".into())
            }
            status => return Err(format!("channel_archive_unknown_status: {status}")),
        }
    }

    if controller.has_pending_chat_request(&operation.conversation_id)? {
        return Err("conversation_busy: 会话仍有待处理消息，归档保持待确认状态".into());
    }
    let operation_id = operation.operation_id.clone();
    let summary =
        blocking(move || conversation_lifecycle::complete_archive(&operation_id, now_ms())).await?;
    controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::{needs_binding_preflight, LifecycleOperation};

    fn operation(status: &str, binding_snapshot_json: Option<&str>) -> LifecycleOperation {
        LifecycleOperation {
            operation_id: "operation-1".into(),
            conversation_id: "conversation-1".into(),
            kind: "archive".into(),
            status: status.into(),
            expected_lifecycle_version: 0,
            expected_activity_version: 0,
            reason: "manual".into(),
            policy_revision: None,
            scheduled_for_at: None,
            binding_snapshot_json: binding_snapshot_json.map(str::to_string),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn aborted_retry_repeats_channel_binding_preflight() {
        assert!(needs_binding_preflight(None));
        assert!(needs_binding_preflight(Some(&operation("aborted", None))));
        assert!(!needs_binding_preflight(Some(&operation(
            "prepared",
            Some("[]")
        ))));
        assert!(!needs_binding_preflight(Some(&operation(
            "completed",
            None
        ))));
    }

    #[test]
    fn prepared_retry_without_a_frozen_snapshot_repeats_preflight() {
        assert!(needs_binding_preflight(Some(&operation("prepared", None))));
    }
}

async fn run_scheduler_cycle(app: &tauri::AppHandle) -> Result<(), String> {
    let pending = blocking(conversation_lifecycle::list_pending_operations).await?;
    for operation in pending {
        if let Err(error) = archive_conversation(app, operation_input(&operation)).await {
            eprintln!("conversation archive reconciliation remains pending: {error}");
        }
    }
    let due =
        blocking(move || conversation_lifecycle::list_due_archive_candidates(now_ms())).await?;
    for input in due {
        if let Err(error) = archive_conversation(app, input).await {
            eprintln!("automatic conversation archive skipped or deferred: {error}");
        }
    }
    Ok(())
}

fn reconcile_previous_process_admissions(process_started_at: i64) {
    let Ok(admissions) = conversation_lifecycle::list_admissions() else {
        return;
    };
    for admission in admissions {
        if admission.updated_at < process_started_at
            && ["turn:", "queue:", "editing:", "inbox:"]
                .iter()
                .any(|prefix| admission.token.starts_with(prefix))
        {
            if let Err(error) = conversation_lifecycle::release(&admission.token, false, now_ms()) {
                eprintln!("failed to reconcile previous desktop admission: {error}");
            }
        }
    }
}

pub fn start_scheduler(app: tauri::AppHandle) {
    // Capture this before spawning so reconciliation cannot remove a gate
    // created by the current process while the startup task is waiting to run.
    let process_started_at = now_ms();
    tauri::async_runtime::spawn(async move {
        let _ = blocking(move || {
            reconcile_previous_process_admissions(process_started_at);
            Ok(())
        })
        .await;
        // Give the Gateway, connector binding snapshot and WebView inbox time
        // to reconcile before the first due-candidate scan.
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            if let Err(error) = run_scheduler_cycle(&app).await {
                eprintln!("conversation archive scheduler cycle failed: {error}");
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

fn parse_args<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    let value = args
        .get(key)
        .cloned()
        .ok_or_else(|| format!("missing_archive_argument: {key}"))?;
    serde_json::from_value(value).map_err(|error| format!("invalid_archive_argument: {error}"))
}

/// Strict Web/Gateway archive domain. This intentionally cannot dispatch an
/// arbitrary Tauri command.
pub async fn handle_gateway_request(
    app: &tauri::AppHandle,
    request: proto::HistoryArchiveRequest,
) -> Result<proto::HistoryArchiveResponse, String> {
    let args: Value = if request.args_json.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&request.args_json)
            .map_err(|error| format!("invalid_archive_args_json: {error}"))?
    };
    let result = match request.command.as_str() {
        "query" => serde_json::to_value(
            chat_history::chat_history_query_inner(parse_args(&args, "input")?).await?,
        ),
        "facets" => {
            let state = args
                .get("archiveState")
                .and_then(Value::as_str)
                .map(str::to_string);
            serde_json::to_value(chat_history::chat_history_archive_facets_inner(state).await?)
        }
        "snapshot" => serde_json::to_value(
            chat_history::chat_history_archive_snapshot_inner(parse_args(&args, "input")?).await?,
        ),
        "delete" => {
            let deleted =
                chat_history::chat_history_delete_archived_inner(parse_args(&args, "input")?)
                    .await?;
            let controller = app.state::<Arc<GatewayController>>().inner().clone();
            for id in &deleted.deleted_ids {
                controller
                    .publish_history_sync(build_history_sync_delete(id.clone()))
                    .await;
            }
            serde_json::to_value(deleted)
        }
        "archive" => {
            let mut input: ArchiveMutationInput = parse_args(&args, "input")?;
            input.reason = Some("manual".into());
            input.policy_revision = None;
            input.scheduled_for_at = None;
            serde_json::to_value(archive_conversation(app, input).await?)
        }
        "unarchive" => {
            let summary =
                chat_history::chat_history_unarchive_inner(parse_args(&args, "input")?).await?;
            app.state::<Arc<GatewayController>>()
                .publish_history_sync(build_history_sync_upsert(&summary))
                .await;
            serde_json::to_value(summary)
        }
        "policy_get" => {
            serde_json::to_value(chat_history::chat_history_archive_policy_get().await?)
        }
        "policy_set" => serde_json::to_value(
            chat_history::chat_history_archive_policy_set(parse_args(&args, "input")?).await?,
        ),
        "metadata" => {
            let id: String = parse_args(&args, "id")?;
            serde_json::to_value(blocking(move || conversation_lifecycle::metadata(&id)).await?)
        }
        "editing" => {
            let input: crate::commands::conversation_archive::ConversationEditingInput =
                parse_args(&args, "input")?;
            crate::commands::conversation_archive::conversation_lifecycle_editing(input).await?;
            Ok(serde_json::Value::Null)
        }
        _ => return Err("unsupported_history_archive_command".into()),
    }
    .map_err(|error| error.to_string())?;
    Ok(proto::HistoryArchiveResponse {
        result_json: serde_json::to_string(&result).map_err(|error| error.to_string())?,
    })
}
