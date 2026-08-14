use std::sync::Arc;

use crate::services::automation::{
    validate_cron_expression, AutomationApplyInput, AutomationScheduler, AutomationSnapshot,
    AutomationStore, CompletePromptRunInput, CronApplyResponse, CronRunNowResponse, CronRunRecord,
    HooksApplyResponse, PlaybookCreateCronInput, PlaybooksApplyResponse, PromptCompletionResponse,
    PromptRunRequest,
};

#[tauri::command(rename_all = "snake_case")]
pub async fn cron_validate_expression(expression: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || validate_cron_expression(&expression))
        .await
        .map_err(|e| format!("cron_validate_expression join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_snapshot(
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<AutomationSnapshot, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.snapshot())
        .await
        .map_err(|e| format!("automation_snapshot join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_cron_apply(
    input: AutomationApplyInput,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<CronApplyResponse, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.cron_apply(input))
        .await
        .map_err(|e| format!("automation_cron_apply join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_hooks_apply(
    input: AutomationApplyInput,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<HooksApplyResponse, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.hooks_apply(input))
        .await
        .map_err(|e| format!("automation_hooks_apply join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_playbooks_apply(
    input: AutomationApplyInput,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<PlaybooksApplyResponse, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.playbooks_apply(input))
        .await
        .map_err(|e| format!("automation_playbooks_apply join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_playbook_create_cron(
    input: PlaybookCreateCronInput,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<CronApplyResponse, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.create_cron_from_playbook(input))
        .await
        .map_err(|e| format!("automation_playbook_create_cron join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_list_runs(
    task_id: String,
    limit: Option<usize>,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<Vec<CronRunRecord>, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.list_runs(&task_id, limit.unwrap_or(100)))
        .await
        .map_err(|e| format!("automation_list_runs join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_clear_runs(
    task_id: String,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<usize, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.clear_runs(&task_id))
        .await
        .map_err(|e| format!("automation_clear_runs join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_run_cron_now(
    task_id: String,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<CronRunNowResponse, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.run_cron_task_now(&task_id))
        .await
        .map_err(|e| format!("automation_run_cron_now join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_claim_prompt_runs(
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<Vec<PromptRunRequest>, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.claim_prompt_runs())
        .await
        .map_err(|e| format!("automation_claim_prompt_runs join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_release_prompt_run(
    execution_id: String,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<(), String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.release_prompt_run(&execution_id))
        .await
        .map_err(|e| format!("automation_release_prompt_run join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_complete_prompt_run(
    input: CompletePromptRunInput,
    store: tauri::State<'_, Arc<AutomationStore>>,
    scheduler: tauri::State<'_, Arc<AutomationScheduler>>,
) -> Result<PromptCompletionResponse, String> {
    let store = Arc::clone(store.inner());
    let (response, delivery) = tauri::async_runtime::spawn_blocking(move || {
        store.complete_prompt_run_with_delivery(input)
    })
    .await
    .map_err(|e| format!("automation_complete_prompt_run join failed: {e}"))??;
    if let Some(delivery) = delivery {
        scheduler.deliver(delivery).await;
    }
    Ok(response)
}
