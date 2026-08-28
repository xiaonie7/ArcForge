use std::sync::Arc;

use serde::Deserialize;

use crate::services::channel_control::{
    AdoptInstallationDefault, ChannelControlStore, ClaimedDelivery, DeliveryOutboxEntry,
    DeliveryTarget, EnqueueDelivery, EnsureInstallationDefault, InstallationDefault,
    PermissionProfile, PrincipalBinding, SaveDeliveryTarget, SavePermissionProfile,
    SavePrincipalBinding,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveProfileRequest {
    installation_id: String,
    principal_type: String,
    principal_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveEffectiveProfileRequest {
    installation_id: String,
    user_id: String,
    conversation_id: Option<String>,
    // Backward-compatible alias for the first WeCom-specific caller.
    group_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkOutboxRequest {
    id: String,
    status: String,
    error: Option<String>,
}

#[tauri::command]
pub async fn channel_profiles_list(
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<Vec<PermissionProfile>, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.list_profiles())
        .await
        .map_err(|e| format!("channel_profiles_list join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_profile_save(
    input: SavePermissionProfile,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<PermissionProfile, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.save_profile(input))
        .await
        .map_err(|e| format!("channel_profile_save join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_installation_default_ensure(
    input: EnsureInstallationDefault,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<InstallationDefault, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.ensure_installation_default(input))
        .await
        .map_err(|e| format!("channel_installation_default_ensure join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_installation_default_adopt(
    input: AdoptInstallationDefault,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<InstallationDefault, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.adopt_installation_default(input))
        .await
        .map_err(|e| format!("channel_installation_default_adopt join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_principal_bind(
    input: SavePrincipalBinding,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<PrincipalBinding, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.bind_principal(input))
        .await
        .map_err(|e| format!("channel_principal_bind join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_profile_resolve(
    input: ResolveProfileRequest,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<Option<PermissionProfile>, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || {
        store.resolve_profile(
            &input.installation_id,
            &input.principal_type,
            &input.principal_id,
        )
    })
    .await
    .map_err(|e| format!("channel_profile_resolve join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_profile_resolve_effective(
    input: ResolveEffectiveProfileRequest,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<Option<PermissionProfile>, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || {
        store.resolve_effective_profile(
            &input.installation_id,
            &input.user_id,
            input
                .conversation_id
                .as_deref()
                .or(input.group_id.as_deref()),
        )
    })
    .await
    .map_err(|e| format!("channel_profile_resolve_effective join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_delivery_targets_list(
    channel: Option<String>,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<Vec<DeliveryTarget>, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.list_targets(channel.as_deref()))
        .await
        .map_err(|e| format!("channel_delivery_targets_list join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_delivery_target_save(
    input: SaveDeliveryTarget,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<DeliveryTarget, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.upsert_target(input))
        .await
        .map_err(|e| format!("channel_delivery_target_save join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_delivery_outbox_enqueue(
    input: EnqueueDelivery,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<DeliveryOutboxEntry, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.enqueue(input))
        .await
        .map_err(|e| format!("channel_delivery_outbox_enqueue join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_delivery_outbox_claim(
    limit: Option<u32>,
    lease_ms: Option<i64>,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<Vec<DeliveryOutboxEntry>, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || {
        store.claim_outbox(limit.unwrap_or(20).min(100), lease_ms.unwrap_or(30_000))
    })
    .await
    .map_err(|e| format!("channel_delivery_outbox_claim join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_delivery_outbox_claim_for_run(
    run_id: String,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<Option<ClaimedDelivery>, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.claim_outbox_for_run(&run_id))
        .await
        .map_err(|e| format!("channel_delivery_outbox_claim_for_run join failed: {e}"))?
}

#[tauri::command]
pub async fn channel_delivery_outbox_mark(
    input: MarkOutboxRequest,
    store: tauri::State<'_, Arc<ChannelControlStore>>,
) -> Result<(), String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || {
        store.mark_outbox(&input.id, &input.status, input.error.as_deref())
    })
    .await
    .map_err(|e| format!("channel_delivery_outbox_mark join failed: {e}"))?
}
