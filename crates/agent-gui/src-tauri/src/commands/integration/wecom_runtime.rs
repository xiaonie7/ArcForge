use std::sync::Arc;

use crate::services::local_wecom::{LocalWecomLogs, LocalWecomStatus, LocalWecomSupervisor};

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
