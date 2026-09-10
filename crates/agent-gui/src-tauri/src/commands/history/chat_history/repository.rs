fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatHistorySummary> {
    Ok(ChatHistorySummary {
        id: row.get("id")?,
        title: row.get("title")?,
        provider_id: row.get("provider_id")?,
        model: row.get("model")?,
        session_id: row.get("session_id")?,
        cwd: row.get("cwd")?,
        selected_model_json: row.get("selected_model_json")?,
        message_count: row.get("total_message_count")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        is_pinned: row.get::<_, i64>("is_pinned")? != 0,
        pinned_at: row.get("pinned_at")?,
        is_shared: row.get::<_, i64>("is_shared")? != 0,
        archived_at: row.get("archived_at")?,
        archive_reason: row.get("archive_reason")?,
        unarchived_at: row.get("unarchived_at")?,
        lifecycle_version: row.get("lifecycle_version")?,
        last_user_message_at: row.get("last_user_message_at")?,
        last_turn_finished_at: row.get("last_turn_finished_at")?,
        activity_version: row.get("activity_version")?,
        auto_archive_exempt: row.get::<_, i64>("auto_archive_exempt")? != 0,
        origin_source_id: row.get("origin_source_id")?,
    })
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatHistoryRecord> {
    Ok(ChatHistoryRecord {
        id: row.get("id")?,
        title: row.get("title")?,
        provider_id: row.get("provider_id")?,
        model: row.get("model")?,
        session_id: row.get("session_id")?,
        cwd: row.get("cwd")?,
        selected_model_json: row.get("selected_model_json")?,
        context_meta_json: row.get("context_meta_json")?,
        active_segment_index: row.get("active_segment_index")?,
        total_segment_count: row.get("total_segment_count")?,
        total_message_count: row.get("total_message_count")?,
        segments: Vec::new(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        is_pinned: row.get::<_, i64>("is_pinned")? != 0,
        pinned_at: row.get("pinned_at")?,
        is_shared: row.get::<_, i64>("is_shared")? != 0,
        redact_tool_content: row.get::<_, i64>("redact_tool_content")? != 0,
        archived_at: row.get("archived_at")?,
        archive_reason: row.get("archive_reason")?,
        unarchived_at: row.get("unarchived_at")?,
        lifecycle_version: row.get("lifecycle_version")?,
        last_user_message_at: row.get("last_user_message_at")?,
        last_turn_finished_at: row.get("last_turn_finished_at")?,
        activity_version: row.get("activity_version")?,
        auto_archive_exempt: row.get::<_, i64>("auto_archive_exempt")? != 0,
        origin_source_id: row.get("origin_source_id")?,
    })
}

fn row_to_segment(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatHistorySegmentRecord> {
    Ok(ChatHistorySegmentRecord {
        segment_index: row.get("segment_index")?,
        segment_id: row.get("segment_id")?,
        summary_json: row.get("summary_json")?,
        messages_json: row.get("messages_json")?,
        message_count: row.get("message_count")?,
        start_message_id: row.get("start_message_id")?,
        end_message_id: row.get("end_message_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn get_summary_by_id(conn: &Connection, id: &str) -> Result<ChatHistorySummary, String> {
    conn.query_row(
        "
        SELECT
            h.id AS id,
            h.title AS title,
            h.provider_id AS provider_id,
            h.model AS model,
            h.session_id AS session_id,
            h.cwd AS cwd,
            h.selected_model_json AS selected_model_json,
            h.total_message_count AS total_message_count,
            h.created_at AS created_at,
            h.updated_at AS updated_at,
            h.is_pinned AS is_pinned,
            h.pinned_at AS pinned_at,
            h.archived_at, h.archive_reason, h.unarchived_at, h.lifecycle_version,
            h.last_user_message_at, h.last_turn_finished_at, h.activity_version,
            h.auto_archive_exempt, h.origin_source_id,
            CASE
                WHEN share.enabled = 1 AND share.token IS NOT NULL THEN 1
                ELSE 0
            END AS is_shared,
            CASE
                WHEN share.enabled = 1 AND share.token IS NOT NULL AND share.redact_tool_content = 1 THEN 1
                ELSE 0
            END AS redact_tool_content
        FROM chatHistory h
        LEFT JOIN chatHistoryShare share ON share.conversation_id = h.id
        WHERE h.id = ?1
        ",
        params![id],
        row_to_summary,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => "未找到对应的历史对话".to_string(),
        _ => format!("读取历史对话摘要失败：{e}"),
    })
}

fn get_record_by_id(conn: &Connection, id: &str) -> Result<ChatHistoryRecord, String> {
    conn.query_row(
        "
        SELECT
            h.id AS id,
            h.title AS title,
            h.provider_id AS provider_id,
            h.model AS model,
            h.session_id AS session_id,
            h.cwd AS cwd,
            h.selected_model_json AS selected_model_json,
            h.context_meta_json AS context_meta_json,
            h.active_segment_index AS active_segment_index,
            h.total_segment_count AS total_segment_count,
            h.total_message_count AS total_message_count,
            h.created_at AS created_at,
            h.updated_at AS updated_at,
            h.is_pinned AS is_pinned,
            h.pinned_at AS pinned_at,
            h.archived_at, h.archive_reason, h.unarchived_at, h.lifecycle_version,
            h.last_user_message_at, h.last_turn_finished_at, h.activity_version,
            h.auto_archive_exempt, h.origin_source_id,
            CASE
                WHEN share.enabled = 1 AND share.token IS NOT NULL THEN 1
                ELSE 0
            END AS is_shared,
            CASE
                WHEN share.enabled = 1 AND share.token IS NOT NULL AND share.redact_tool_content = 1 THEN 1
                ELSE 0
            END AS redact_tool_content
        FROM chatHistory h
        LEFT JOIN chatHistoryShare share ON share.conversation_id = h.id
        WHERE h.id = ?1
        ",
        params![id],
        row_to_record,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => "未找到对应的历史对话".to_string(),
        _ => format!("读取历史对话失败：{e}"),
    })
}

fn ensure_chat_history_mutable(conn: &Connection, id: &str) -> Result<String, String> {
    let chat_id = id.trim();
    if chat_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }

    let archived_at = conn
        .query_row(
            "SELECT archived_at FROM chatHistory WHERE id = ?1",
            params![chat_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .map_err(|e| format!("检查历史对话归档状态失败：{e}"))?
        .ok_or_else(|| "未找到对应的历史对话".to_string())?;
    if archived_at.is_some() {
        return Err("conversation_archived: 已归档会话为只读，请先取消归档".to_string());
    }

    Ok(chat_id.to_string())
}

fn read_message_timestamp_with_fallback(value: &Value, fallback: i64) -> i64 {
    value
        .as_object()
        .and_then(|object| object.get("timestamp"))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|number| number as i64))
        })
        .unwrap_or(fallback)
}

fn read_message_timestamp(value: &Value) -> i64 {
    read_message_timestamp_with_fallback(value, now_ms())
}

fn resolve_history_list_page_size(page_size: i64) -> Result<i64, String> {
    if page_size <= 0 {
        Err("历史列表 pageSize 必须大于 0".to_string())
    } else {
        Ok(page_size.min(MAX_HISTORY_LIST_LIMIT))
    }
}

#[cfg(test)]
pub(crate) fn list_chat_history_sync(
    conn: &Connection,
    page: i64,
    page_size: i64,
) -> Result<ChatHistoryListResponse, String> {
    list_chat_history_sync_with_filter(conn, page, page_size, ChatHistoryListFilter::default())
}

pub(crate) fn list_chat_history_sync_with_filter(
    conn: &Connection,
    page: i64,
    page_size: i64,
    filter: ChatHistoryListFilter,
) -> Result<ChatHistoryListResponse, String> {
    let page = resolve_history_list_page(page)?;
    let limit = resolve_history_list_page_size(page_size)?;
    let offset = (page - 1).saturating_mul(limit);
    let (where_clause, mut bindings) = build_history_list_filter(&filter)?;
    let total_query = format!("SELECT COUNT(*) FROM chatHistory h {where_clause}");
    let total = conn.query_row(&total_query, rusqlite::params_from_iter(bindings.iter()), |row| row.get::<_, i64>(0))
        .map_err(|e| format!("统计历史列表失败：{e}"))?;
    let order = if filter.archive_state.as_deref() == Some("archived") {
        "h.archived_at DESC, h.id ASC"
    } else {
        "h.is_pinned DESC, h.pinned_at DESC, h.updated_at DESC, h.id ASC"
    };
    let limit_param = bindings.len() + 1;
    let offset_param = bindings.len() + 2;
    bindings.push(rusqlite::types::Value::Integer(limit));
    bindings.push(rusqlite::types::Value::Integer(offset));

    let mut stmt = conn
        .prepare(&format!(
            "\
            SELECT
                h.id AS id,
                h.title AS title,
                h.provider_id AS provider_id,
                h.model AS model,
                h.session_id AS session_id,
                h.cwd AS cwd,
                h.selected_model_json AS selected_model_json,
                h.total_message_count AS total_message_count,
                h.created_at AS created_at,
                h.updated_at AS updated_at,
                h.is_pinned AS is_pinned,
                h.pinned_at AS pinned_at,
                h.archived_at, h.archive_reason, h.unarchived_at, h.lifecycle_version,
                h.last_user_message_at, h.last_turn_finished_at, h.activity_version,
                h.auto_archive_exempt, h.origin_source_id,
                CASE
                    WHEN share.enabled = 1 AND share.token IS NOT NULL THEN 1
                    ELSE 0
                END AS is_shared
            FROM chatHistory h
            LEFT JOIN chatHistoryShare share ON share.conversation_id = h.id
            {where_clause}
            ORDER BY {order}
            LIMIT ?{limit_param} OFFSET ?{offset_param}
            ",
        ))
        .map_err(|e| format!("准备历史列表查询失败：{e}"))?;

    let mut out = Vec::new();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(bindings.iter()), row_to_summary)
        .map_err(|e| format!("查询历史列表失败：{e}"))?;
    for row in rows {
        out.push(row.map_err(|e| format!("读取历史列表行失败：{e}"))?);
    }
    Ok(ChatHistoryListResponse {
        items: out,
        total_count: total,
    })
}

pub(crate) fn list_chat_history_workdirs_sync(
    conn: &Connection,
) -> Result<ChatHistoryWorkdirsResponse, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT TRIM(cwd) AS path, COUNT(*) AS conversation_count, MAX(updated_at) AS updated_at
            FROM chatHistory
            WHERE archived_at IS NULL AND TRIM(COALESCE(cwd, '')) != ''
            GROUP BY TRIM(cwd)
            ORDER BY MAX(updated_at) DESC, TRIM(cwd) ASC
            ",
        )
        .map_err(|e| format!("准备历史工作目录查询失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ChatHistoryWorkdirSummary {
                path: row.get("path")?,
                conversation_count: row.get("conversation_count")?,
                updated_at: row.get("updated_at")?,
            })
        })
        .map_err(|e| format!("查询历史工作目录失败：{e}"))?;

    let mut out = Vec::new();
    for row in rows {
        let item = row.map_err(|e| format!("读取历史工作目录行失败：{e}"))?;
        if item.path.trim().is_empty() {
            continue;
        }
        out.push(item);
    }
    Ok(ChatHistoryWorkdirsResponse { workdirs: out })
}

pub(crate) fn list_shared_chat_history_sync(
    conn: &Connection,
    page: i64,
    page_size: i64,
) -> Result<ChatHistoryListResponse, String> {
    let page = resolve_history_list_page(page)?;
    let limit = resolve_history_list_page_size(page_size)?;
    let offset = (page - 1).saturating_mul(limit);
    let total = conn
        .query_row(
            "
            SELECT COUNT(*)
            FROM chatHistory h
            INNER JOIN chatHistoryShare share ON share.conversation_id = h.id
            WHERE share.enabled = 1 AND share.token IS NOT NULL
            ",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("count shared history list failed: {e}"))?;

    let mut stmt = conn
        .prepare(
            "
            SELECT
                h.id AS id,
                h.title AS title,
                h.provider_id AS provider_id,
                h.model AS model,
                h.session_id AS session_id,
                h.cwd AS cwd,
                h.selected_model_json AS selected_model_json,
                h.total_message_count AS total_message_count,
                h.created_at AS created_at,
                h.updated_at AS updated_at,
                h.is_pinned AS is_pinned,
                h.pinned_at AS pinned_at,
                h.archived_at, h.archive_reason, h.unarchived_at, h.lifecycle_version,
                h.last_user_message_at, h.last_turn_finished_at, h.activity_version,
                h.auto_archive_exempt, h.origin_source_id,
                1 AS is_shared
            FROM chatHistory h
            INNER JOIN chatHistoryShare share ON share.conversation_id = h.id
            WHERE share.enabled = 1 AND share.token IS NOT NULL
            ORDER BY h.is_pinned DESC, h.pinned_at DESC, h.updated_at DESC, h.id ASC
            LIMIT ?1 OFFSET ?2
            ",
        )
        .map_err(|e| format!("prepare shared history list query failed: {e}"))?;

    let rows = stmt
        .query_map(params![limit, offset], row_to_summary)
        .map_err(|e| format!("query shared history list failed: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("read shared history list row failed: {e}"))?);
    }

    Ok(ChatHistoryListResponse {
        items: out,
        total_count: total,
    })
}

pub(crate) fn list_shared_chat_history_page_sync(
    page: i64,
    page_size: i64,
) -> Result<ChatHistoryListResponse, String> {
    let conn = open_db()?;
    list_shared_chat_history_sync(&conn, page, page_size)
}
/// Lexical normalization also works when an artifact was temporarily removed by a rebuild.
fn review_path_key(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    let windows = path.as_bytes().get(1) == Some(&b':') || path.starts_with("//");
    let prefix = if path.starts_with("//") { "//" } else if path.starts_with('/') { "/" } else { "" };
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last: &&str| *last != ".." && !last.ends_with(':')) => { parts.pop(); }
            ".." if !prefix.is_empty() || parts.last().is_some_and(|last: &&str| last.ends_with(':')) => {}
            _ => parts.push(part),
        }
    }
    let key = format!("{prefix}{}", parts.join("/"));
    if windows { key.to_lowercase() } else { key }
}

fn review_binding_key(workdir: &str, artifact: &str) -> Option<(String, String)> {
    if workdir.trim().is_empty() || artifact.trim().is_empty() {
        return None;
    }
    let workspace = review_path_key(workdir);
    let artifact = artifact.trim().replace('\\', "/");
    let absolute = artifact.starts_with('/') || artifact.as_bytes().get(1) == Some(&b':');
    let artifact = if absolute { artifact } else { format!("{workspace}/{artifact}") };
    Some((workspace, review_path_key(&artifact)))
}

fn find_review_chat_history_sync(
    conn: &Connection,
    workdir: &str,
    artifact_path: &str,
) -> Result<Option<String>, String> {
    let key = review_binding_key(workdir, artifact_path)
        .ok_or_else(|| "workdir and artifactPath are required".to_string())?;
    let mut statement = conn.prepare(
        "SELECT id, context_meta_json FROM chatHistory WHERE archived_at IS NULL AND context_meta_json IS NOT NULL AND context_meta_json != '{}' ORDER BY updated_at DESC, id ASC",
    ).map_err(|error| format!("Review conversation lookup failed: {error}"))?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("Review conversation lookup failed: {error}"))?;
    for row in rows {
        let (id, metadata) = row.map_err(|error| format!("Review conversation read failed: {error}"))?;
        let Ok(metadata) = serde_json::from_str::<Value>(&metadata) else { continue };
        let Some(review) = metadata.get("review") else { continue };
        let (Some(workdir), Some(artifact)) = (review.get("workdir").and_then(Value::as_str), review.get("artifactPath").and_then(Value::as_str)) else { continue };
        if review_binding_key(workdir, artifact).as_ref() == Some(&key) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}
