use std::sync::Arc;

use crate::services::workspace_watch::WorkspaceWatchService;

#[tauri::command]
pub fn workspace_watch_set(
    workdirs: Vec<String>,
    workspace_watch: tauri::State<'_, Arc<WorkspaceWatchService>>,
) -> Result<(), String> {
    workspace_watch.set_desired(workdirs);
    Ok(())
}
