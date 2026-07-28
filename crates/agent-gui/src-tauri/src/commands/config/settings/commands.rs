#[tauri::command]
pub async fn settings_load_all() -> Result<SettingsLoadResponse, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let conn = open_db()?;
        let default_workdir = default_project_workdir()?;
        Ok(SettingsLoadResponse {
            providers: load_providers(&conn)?,
            system: Some(load_system_with_defaults(&conn, &default_workdir)?),
            mcp: load_mcp(&conn)?,
            agents: load_agents(&conn)?,
            ssh: load_ssh(&conn)?,
            remote: load_remote(&conn)?,
            wecom: Some(
                serde_json::to_value(load_wecom_settings(&conn)?)
                    .map_err(|e| format!("serialize WeCom settings failed: {e}"))?,
            ),
            memory: load_memory(&conn)?,
            default_workdir,
        })
    })
    .await
    .map_err(|e| format!("settings_load_all join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_providers(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_providers(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_providers join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_system(
    payload: Value,
    automation_scheduler: tauri::State<'_, Arc<AutomationScheduler>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_system(&mut conn, payload)?;
        // 保存成功后刷新全局代理状态，让 shell env 注入与出网代理即时生效。
        refresh_system_proxy_state(&conn)
    })
    .await
    .map_err(|e| format!("settings_save_system join 失败：{e}"))??;
    // Bash cron tasks execute in the system workdir; reschedule so the new
    // workdir takes effect without an app restart.
    automation_scheduler.request_reload();
    Ok(())
}

#[tauri::command]
pub async fn settings_save_mcp(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_mcp(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_mcp join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_remote(
    payload: Value,
    wecom_supervisor: tauri::State<'_, Arc<LocalWecomSupervisor>>,
) -> Result<(), String> {
    let normalized = parse_remote_settings_payload(payload)?;
    let persisted = serde_json::to_value(&normalized)
        .map_err(|e| format!("序列化 {REMOTE_SETTINGS_TABLE} 失败：{e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_remote(&mut conn, persisted)
    })
    .await
    .map_err(|e| format!("settings_save_remote join 失败：{e}"))??;
    wecom_supervisor.inner().clone().reload_from_db().await
}

/// Save non-secret WeCom settings, or apply an explicit write-only secret
/// update supplied by the desktop settings panel. The response is always
/// redacted and safe to keep in webview state.
#[tauri::command]
pub async fn settings_save_wecom(
    payload: Value,
    wecom_supervisor: tauri::State<'_, Arc<LocalWecomSupervisor>>,
) -> Result<WecomSettingsPayload, String> {
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_wecom(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_wecom join failed: {e}"))??;
    wecom_supervisor.inner().clone().reload_from_db().await?;
    Ok(saved)
}

#[tauri::command]
pub async fn settings_save_memory(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_memory(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_memory join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_agents(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_agents(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_agents join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_ssh(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_ssh(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_ssh join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_apply_ssh_patch(payload: Value) -> Result<SshPatchApplyResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        apply_ssh_patch_with_conn(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_apply_ssh_patch join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_reset_ssh_known_host(
    host: String,
    port: u16,
) -> Result<SshKnownHostResetResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let deleted = reset_runtime_ssh_known_host(&host, port)?;
        Ok(SshKnownHostResetResponse { deleted })
    })
    .await
    .map_err(|e| format!("settings_reset_ssh_known_host join 失败：{e}"))?
}
