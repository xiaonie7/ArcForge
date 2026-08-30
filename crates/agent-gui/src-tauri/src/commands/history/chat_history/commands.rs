#[tauri::command]
pub async fn chat_history_list(
    page: i64,
    page_size: i64,
    cwd: Option<String>,
    cwd_empty: Option<bool>,
) -> Result<ChatHistoryListResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        list_chat_history_sync_with_filter(
            &conn,
            page,
            page_size,
            ChatHistoryListFilter {
                cwd,
                cwd_empty: cwd_empty.unwrap_or(false),
                ..Default::default()
            },
        )
    })
    .await
    .map_err(|e| format!("chat_history_list join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_workdirs() -> Result<ChatHistoryWorkdirsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        list_chat_history_workdirs_sync(&conn)
    })
    .await
    .map_err(|e| format!("chat_history_workdirs join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_shared_list(
    page: i64,
    page_size: i64,
) -> Result<ChatHistoryListResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_shared_chat_history_page_sync(page, page_size)
    })
    .await
    .map_err(|e| format!("chat_history_shared_list join failed: {e}"))?
}

#[tauri::command]
pub async fn chat_history_search(
    args: ChatHistorySearchArgs,
) -> Result<ChatHistorySearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || search_chat_history_sync(args))
        .await
        .map_err(|e| format!("chat_history_search join 失败：{e}"))?
}

pub(crate) async fn chat_history_get_summary_inner(
    id: String,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        get_summary_by_id(&conn, &id)
    })
    .await
    .map_err(|e| format!("chat_history_get_summary join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_get(id: String) -> Result<ChatHistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        if chat_id.is_empty() {
            return Err("历史对话 id 不能为空".to_string());
        }

        let conn = open_db()?;
        let mut record = get_record_by_id(&conn, &chat_id)?;
        record.segments = load_segments(&conn, &record.id)?;
        if record.segments.is_empty() {
            return Err("历史对话缺少分段数据".to_string());
        }

        Ok(record)
    })
    .await
    .map_err(|e| format!("chat_history_get join 失败：{e}"))?
}

pub(crate) async fn chat_history_get_tail(
    id: String,
    max_messages: i64,
) -> Result<ChatHistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        if chat_id.is_empty() {
            return Err("历史对话 id 不能为空".to_string());
        }

        let conn = open_db()?;
        let mut record = get_record_by_id(&conn, &chat_id)?;
        record.segments = load_tail_segments(&conn, &record.id, max_messages)?;
        if record.segments.is_empty() {
            return Err("历史对话缺少分段数据".to_string());
        }

        Ok(record)
    })
    .await
    .map_err(|e| format!("chat_history_get_tail join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_get_active_segment(
    id: String,
) -> Result<ChatHistoryActiveSegmentRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        if chat_id.is_empty() {
            return Err("历史对话 id 不能为空".to_string());
        }

        let conn = open_db()?;
        let record = get_record_by_id(&conn, &chat_id)?;
        let context_meta_json = record.context_meta_json.clone();
        let active_segment_index = record.active_segment_index;
        let total_segment_count = record.total_segment_count;
        let active_segment = load_segment_by_index(&conn, &record.id, active_segment_index)?;
        let total_message_count = record.total_message_count;

        Ok(ChatHistoryActiveSegmentRecord {
            id: record.id,
            title: record.title,
            provider_id: record.provider_id,
            model: record.model,
            session_id: record.session_id,
            cwd: record.cwd,
            selected_model_json: record.selected_model_json,
            context_meta_json,
            active_segment_index,
            total_segment_count,
            total_message_count,
            active_segment,
            created_at: record.created_at,
            updated_at: record.updated_at,
            is_pinned: record.is_pinned,
            pinned_at: record.pinned_at,
            is_shared: record.is_shared,
            archived_at: record.archived_at,
            archive_reason: record.archive_reason,
            unarchived_at: record.unarchived_at,
            lifecycle_version: record.lifecycle_version,
            last_user_message_at: record.last_user_message_at,
            last_turn_finished_at: record.last_turn_finished_at,
            activity_version: record.activity_version,
            auto_archive_exempt: record.auto_archive_exempt,
            origin_source_id: record.origin_source_id,
        })
    })
    .await
    .map_err(|e| format!("chat_history_get_active_segment join 失败：{e}"))?
}

pub(crate) async fn chat_history_upsert_inner(
    input: ChatHistoryUpsertInput,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_upsert_input(&input)?;
        let conversation = ChatHistoryConversationInput {
            id: input.id.clone(),
            title: input.title.clone(),
            provider_id: input.provider_id.clone(),
            model: input.model.clone(),
            session_id: input.session_id.clone(),
            cwd: input.cwd.clone(),
            selected_model_json: input.selected_model_json.clone(),
            context_meta_json: input.context_meta_json.clone(),
            active_segment_index: input.active_segment_index,
            total_segment_count: input.total_segment_count,
            total_message_count: input.total_message_count,
            created_at: input.created_at,
            updated_at: input.updated_at,
        };

        let mut conn = open_db()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启聊天历史事务失败：{e}"))?;
        upsert_chat_history_header(&tx, &conversation)?;

        sync_segments(
            &tx,
            input.id.trim(),
            &input.segments,
            input.total_segment_count,
        )?;
        verify_chat_history_consistency(&tx, input.id.trim())?;

        tx.commit()
            .map_err(|e| format!("提交聊天历史事务失败：{e}"))?;

        get_summary_by_id(&conn, input.id.trim())
    })
    .await
    .map_err(|e| format!("chat_history_upsert join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_upsert(
    input: ChatHistoryUpsertInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_upsert_inner(input).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_upsert_active_segment_inner(
    input: ChatHistorySegmentMutationInput,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_segment_mutation_input(&input)?;
        let mut conn = open_db()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启 active segment 事务失败：{e}"))?;

        upsert_chat_history_header(&tx, &input.conversation)?;
        upsert_single_segment(&tx, input.conversation.id.trim(), &input.segment)?;
        verify_chat_history_consistency(&tx, input.conversation.id.trim())?;

        tx.commit()
            .map_err(|e| format!("提交 active segment 事务失败：{e}"))?;

        get_summary_by_id(&conn, input.conversation.id.trim())
    })
    .await
    .map_err(|e| format!("chat_history_upsert_active_segment join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_upsert_active_segment(
    input: ChatHistorySegmentMutationInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_upsert_active_segment_inner(input).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_append_segment_inner(
    input: ChatHistorySegmentMutationInput,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_segment_mutation_input(&input)?;
        let mut conn = open_db()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启 append segment 事务失败：{e}"))?;

        validate_append_segment_preconditions(&tx, &input)?;
        upsert_chat_history_header(&tx, &input.conversation)?;
        insert_single_segment(&tx, input.conversation.id.trim(), &input.segment)?;
        verify_chat_history_consistency(&tx, input.conversation.id.trim())?;

        tx.commit()
            .map_err(|e| format!("提交 append segment 事务失败：{e}"))?;

        get_summary_by_id(&conn, input.conversation.id.trim())
    })
    .await
    .map_err(|e| format!("chat_history_append_segment join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_append_segment(
    input: ChatHistorySegmentMutationInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_append_segment_inner(input).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_rename_inner(
    id: String,
    title: String,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        rename_chat_history_sync(&conn, &id, &title)
    })
    .await
    .map_err(|e| format!("chat_history_rename join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_rename(
    id: String,
    title: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_rename_inner(id, title).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_set_pinned_inner(
    id: String,
    is_pinned: bool,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        set_chat_history_pinned_sync(&conn, &id, is_pinned)
    })
    .await
    .map_err(|e| format!("chat_history_set_pinned join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_set_pinned(
    id: String,
    is_pinned: bool,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_set_pinned_inner(id, is_pinned).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_set_model_inner(
    id: String,
    selected_model_json: String,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        set_chat_history_model_sync(&conn, &id, &selected_model_json)
    })
    .await
    .map_err(|e| format!("chat_history_set_model join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_set_model(
    id: String,
    selected_model_json: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_set_model_inner(id, selected_model_json).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_share_get_inner(
    id: String,
) -> Result<ChatHistoryShareStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        get_chat_history_share_status_sync(&conn, &id)
    })
    .await
    .map_err(|e| format!("chat_history_share_get join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_share_get(id: String) -> Result<ChatHistoryShareStatus, String> {
    chat_history_share_get_inner(id).await
}

pub(crate) async fn chat_history_share_set_inner(
    id: String,
    enabled: bool,
    redact_tool_content: Option<bool>,
) -> Result<ChatHistoryShareStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        set_chat_history_share_enabled_sync(&conn, &id, enabled, redact_tool_content)
    })
    .await
    .map_err(|e| format!("chat_history_share_set join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_share_set(
    id: String,
    enabled: bool,
    redact_tool_content: Option<bool>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistoryShareStatus, String> {
    let status = chat_history_share_set_inner(id, enabled, redact_tool_content).await?;
    match chat_history_get_summary_inner(status.conversation_id.clone()).await {
        Ok(summary) => {
            gateway_controller
                .publish_history_sync(build_history_sync_upsert(&summary))
                .await;
        }
        Err(error) => eprintln!("publish history share sync event failed: {error}"),
    }
    Ok(status)
}

pub(crate) async fn chat_history_share_resolve_inner(
    token: String,
) -> Result<ChatHistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        resolve_chat_history_share_sync(&conn, &token)
    })
    .await
    .map_err(|e| format!("chat_history_share_resolve join 失败：{e}"))?
}
