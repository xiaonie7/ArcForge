use std::sync::Arc;

use serde::Deserialize;

use crate::services::local_wecom::{
    LocalWecomLogs, LocalWecomSendReceipt, LocalWecomStatus, LocalWecomSupervisor,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WecomRuntimeSendMessageRequest {
    chat_id: String,
    content: String,
}

#[tauri::command]
pub fn wecom_runtime_status(
    supervisor: tauri::State<'_, Arc<LocalWecomSupervisor>>,
) -> Result<LocalWecomStatus, String> {
    Ok(supervisor.status())
}

#[tauri::command]
pub fn wecom_runtime_restart(
    supervisor: tauri::State<'_, Arc<LocalWecomSupervisor>>,
) -> Result<LocalWecomStatus, String> {
    supervisor.restart()
}

#[tauri::command]
pub fn wecom_runtime_logs(
    supervisor: tauri::State<'_, Arc<LocalWecomSupervisor>>,
) -> Result<LocalWecomLogs, String> {
    Ok(supervisor.logs())
}

#[tauri::command]
pub async fn wecom_runtime_send_message(
    request: WecomRuntimeSendMessageRequest,
    supervisor: tauri::State<'_, Arc<LocalWecomSupervisor>>,
) -> Result<LocalWecomSendReceipt, String> {
    supervisor
        .inner()
        .send_markdown(request.chat_id, request.content)
        .await
}
