//! Conversation lifecycle IPC. All decisions are made in the history database.

use serde::Deserialize;
use tauri::AppHandle;

use crate::commands::chat_history::ChatHistorySummary;
use crate::services::conversation_lifecycle::{
    self, ArchiveMutationInput, ConversationLifecycleMeta,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAdmissionInput {
    pub conversation_id: String,
    pub token: String,
    pub phase: String,
    pub origin_source_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationReleaseInput {
    pub token: String,
    #[serde(default)]
    pub finished: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEditingInput {
    pub conversation_id: String,
    pub token: String,
    pub editing: bool,
}

#[tauri::command]
pub async fn chat_history_archive(
    app: AppHandle,
    mut input: ArchiveMutationInput,
) -> Result<ChatHistorySummary, String> {
    // Scheduled operations are created by the native scheduler, never by IPC.
    input.reason = Some("manual".into());
    input.policy_revision = None;
    input.scheduled_for_at = None;
    crate::services::conversation_archive::archive_conversation(&app, input).await
}

#[tauri::command]
pub async fn conversation_lifecycle_metadata(
    id: String,
) -> Result<Option<ConversationLifecycleMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || conversation_lifecycle::metadata(&id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn conversation_lifecycle_admit(input: ConversationAdmissionInput) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        conversation_lifecycle::admit(
            &input.conversation_id,
            &input.token,
            &input.phase,
            input.origin_source_id.as_deref(),
            chrono::Utc::now().timestamp_millis(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn conversation_lifecycle_release(input: ConversationReleaseInput) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        conversation_lifecycle::release(
            &input.token,
            input.finished,
            chrono::Utc::now().timestamp_millis(),
        )
        .map(|_| ())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn conversation_lifecycle_editing(input: ConversationEditingInput) -> Result<(), String> {
    if !input.token.starts_with("editing:") || input.token.len() > 1024 {
        return Err("invalid_editing_token".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let now = chrono::Utc::now().timestamp_millis();
        if input.editing {
            conversation_lifecycle::admit(
                &input.conversation_id,
                &input.token,
                "editing",
                None,
                now,
            )
        } else {
            conversation_lifecycle::release(&input.token, false, now).map(|_| ())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}
