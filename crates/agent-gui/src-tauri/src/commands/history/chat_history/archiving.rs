const MAX_ARCHIVED_DELETE_CANDIDATES: usize = 10_000;

fn build_history_list_filter(filter: &ChatHistoryListFilter) -> Result<(String, Vec<rusqlite::types::Value>), String> {
    let mut predicates = Vec::new();
    let mut values = Vec::new();
    match filter.archive_state.as_deref().unwrap_or("active") {
        "active" => predicates.push("h.archived_at IS NULL".to_string()),
        "archived" => predicates.push("h.archived_at IS NOT NULL".to_string()),
        "all" => {},
        _ => return Err("invalid_archive_state".into()),
    }
    if filter.cwd_empty {
        predicates.push("h.cwd_key = ''".into());
    } else if let Some(cwd) = filter.cwd.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        values.push(rusqlite::types::Value::Text(crate::runtime::project_path::project_path_key(cwd)));
        predicates.push(format!("h.cwd_key = ?{}", values.len()));
    }
    if let Some(source) = filter.source_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        if source.len() > 128 { return Err("invalid_source_id".into()); }
        values.push(rusqlite::types::Value::Text(source.to_string()));
        predicates.push(format!("COALESCE(h.origin_source_id, 'unknown') = ?{}", values.len()));
    }
    if let Some(search) = filter.search.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        if search.chars().count() > 500 { return Err("archive_search_too_long".into()); }
        let escaped = search.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        values.push(rusqlite::types::Value::Text(format!("%{escaped}%")));
        let parameter = values.len();
        // Search actual textual content, not JSON field names or model metadata.
        // The history FTS index is lazily filled, so a bare FTS query could omit
        // untouched archived messages after an upgrade.
        predicates.push(format!(
            "(h.title LIKE ?{parameter} ESCAPE '\\' OR EXISTS (
                SELECT 1 FROM chatHistorySegment s,
                  json_tree(CASE WHEN json_valid(s.messages_json) THEN s.messages_json ELSE '[]' END) text_value
                WHERE s.conversation_id = h.id AND text_value.type = 'text'
                  AND text_value.key IN ('text','content')
                  AND CAST(text_value.atom AS TEXT) LIKE ?{parameter} ESCAPE '\\'))"
        ));
    }
    Ok((if predicates.is_empty() { String::new() } else { format!("WHERE {}", predicates.join(" AND ")) }, values))
}

pub(crate) async fn chat_history_query_inner(input: ChatHistoryQueryInput) -> Result<ChatHistoryListResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_chat_history_sync_with_filter(&open_db()?, input.page, input.page_size, input.filter)
    }).await.map_err(|e| format!("chat_history_query join failed: {e}"))?
}

#[tauri::command]
pub async fn chat_history_query(input: ChatHistoryQueryInput) -> Result<ChatHistoryListResponse, String> {
    chat_history_query_inner(input).await
}

fn archive_facets_on(conn: &Connection, archive_state: Option<String>) -> Result<ChatHistoryArchiveFacets, String> {
    let (filter, values) = build_history_list_filter(&ChatHistoryListFilter {
        archive_state: Some(archive_state.unwrap_or_else(|| "archived".into())),
        ..Default::default()
    })?;
    let sources = {
        let mut stmt = conn.prepare(&format!("SELECT COALESCE(h.origin_source_id,'unknown') AS source_id, COUNT(*) AS count FROM chatHistory h {filter} GROUP BY COALESCE(h.origin_source_id,'unknown') ORDER BY source_id"))
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| Ok(ChatHistorySourceFacet { id: row.get(0)?, count: row.get(1)? }))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let projects = {
        let mut stmt = conn.prepare(&format!("SELECT MIN(TRIM(COALESCE(h.cwd,''))) AS path, COUNT(*) AS count FROM chatHistory h {filter} GROUP BY h.cwd_key ORDER BY path"))
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| Ok(ChatHistoryProjectFacet { path: row.get(0)?, count: row.get(1)? }))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    Ok(ChatHistoryArchiveFacets { sources, projects })
}

pub(crate) async fn chat_history_archive_facets_inner(archive_state: Option<String>) -> Result<ChatHistoryArchiveFacets, String> {
    tauri::async_runtime::spawn_blocking(move || archive_facets_on(&open_db()?, archive_state))
        .await.map_err(|e| format!("chat_history_archive_facets join failed: {e}"))?
}

#[tauri::command]
pub async fn chat_history_archive_facets(archive_state: Option<String>) -> Result<ChatHistoryArchiveFacets, String> {
    chat_history_archive_facets_inner(archive_state).await
}

fn archive_snapshot_on(conn: &Connection, mut input: ChatHistoryListFilter) -> Result<ArchivedChatSnapshot, String> {
    // No request can expand a destructive archive snapshot to active history.
    input.archive_state = Some("archived".into());
    let (filter, values) = build_history_list_filter(&input)?;
    let mut stmt = conn.prepare(&format!("SELECT h.id,h.lifecycle_version FROM chatHistory h {filter} ORDER BY h.archived_at DESC,h.id LIMIT {}", MAX_ARCHIVED_DELETE_CANDIDATES + 1))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| Ok(ArchivedChatCandidate { id: row.get(0)?, lifecycle_version: row.get(1)? }))
        .map_err(|e| e.to_string())?;
    let candidates = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if candidates.len() > MAX_ARCHIVED_DELETE_CANDIDATES {
        return Err("archive_delete_scope_too_large: 请缩小筛选范围，每次最多删除 10000 个已归档会话".into());
    }
    Ok(ArchivedChatSnapshot { total_count: candidates.len() as i64, candidates })
}

pub(crate) async fn chat_history_archive_snapshot_inner(input: ChatHistoryListFilter) -> Result<ArchivedChatSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || archive_snapshot_on(&open_db()?, input))
        .await.map_err(|e| format!("chat_history_archive_snapshot join failed: {e}"))?
}

#[tauri::command]
pub async fn chat_history_archive_snapshot(input: ChatHistoryListFilter) -> Result<ArchivedChatSnapshot, String> {
    chat_history_archive_snapshot_inner(input).await
}

pub(crate) fn delete_archived_on(conn: &mut Connection, input: DeleteArchivedChatInput) -> Result<(DeleteArchivedChatResult, Vec<subagent_store::SubagentPruneResult>), String> {
    if input.candidates.len() > MAX_ARCHIVED_DELETE_CANDIDATES { return Err("archive_delete_scope_too_large".into()); }
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let mut result = DeleteArchivedChatResult { deleted_ids: Vec::new(), skipped: Vec::new() };
    let mut prunes = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for candidate in input.candidates {
        let id = candidate.id.trim().to_string();
        if !seen.insert(id.clone()) { continue; }
        let meta = crate::services::conversation_lifecycle::metadata_on(&tx, &id)?;
        let reason = match meta.as_ref() {
            None => Some("not_found"),
            Some(meta) if meta.archived_at.is_none() => Some("not_archived"),
            Some(meta) if meta.lifecycle_version != candidate.lifecycle_version => Some("version_changed"),
            Some(_) if crate::services::conversation_lifecycle::has_pending_operation(&tx, &id)? => Some("lifecycle_pending"),
            Some(_) if crate::services::conversation_lifecycle::has_blocking_admission(&tx, &id, true, now_ms())? => Some("busy"),
            Some(_) => None,
        };
        if let Some(reason) = reason {
            result.skipped.push(DeleteArchivedChatSkipped { id, reason: reason.into() });
            continue;
        }
        prunes.push(delete_chat_history_in_transaction(&tx, &id)?);
        result.deleted_ids.push(id);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok((result, prunes))
}

pub(crate) async fn chat_history_delete_archived_inner(input: DeleteArchivedChatInput) -> Result<DeleteArchivedChatResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (result, prunes) = delete_archived_on(&mut open_db()?, input)?;
        for mut prune in prunes { subagent_store::cleanup_pruned_worktrees(&mut prune); }
        Ok(result)
    }).await.map_err(|e| format!("chat_history_delete_archived join failed: {e}"))?
}

#[tauri::command]
pub async fn chat_history_delete_archived(input: DeleteArchivedChatInput, gateway_controller: tauri::State<'_, Arc<GatewayController>>) -> Result<DeleteArchivedChatResult, String> {
    let result = chat_history_delete_archived_inner(input).await?;
    for id in &result.deleted_ids {
        gateway_controller.publish_history_sync(build_history_sync_delete(id.clone())).await;
    }
    Ok(result)
}

pub(crate) async fn chat_history_unarchive_inner(mut input: ChatHistoryArchiveInput) -> Result<ChatHistorySummary, String> {
    input.reason = Some("manual".into());
    input.policy_revision = None;
    input.scheduled_for_at = None;
    tauri::async_runtime::spawn_blocking(move || crate::services::conversation_lifecycle::unarchive(&input, now_ms()))
        .await.map_err(|e| format!("chat_history_unarchive join failed: {e}"))?
}

#[tauri::command]
pub async fn chat_history_unarchive(input: ChatHistoryArchiveInput, gateway_controller: tauri::State<'_, Arc<GatewayController>>) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_unarchive_inner(input).await?;
    gateway_controller.publish_history_sync(build_history_sync_upsert(&summary)).await;
    Ok(summary)
}

#[tauri::command]
pub async fn chat_history_archive_policy_get() -> Result<crate::services::conversation_lifecycle::ArchivePolicy, String> {
    tauri::async_runtime::spawn_blocking(crate::services::conversation_lifecycle::get_policy)
        .await.map_err(|e| format!("chat_history_archive_policy_get join failed: {e}"))?
}

#[tauri::command]
pub async fn chat_history_archive_policy_set(input: crate::services::conversation_lifecycle::ArchivePolicy) -> Result<crate::services::conversation_lifecycle::ArchivePolicy, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::conversation_lifecycle::save_policy(&input, now_ms()))
        .await.map_err(|e| format!("chat_history_archive_policy_set join failed: {e}"))?
}
