#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySummary {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub selected_model_json: Option<String>,
    pub message_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_pinned: bool,
    pub pinned_at: Option<i64>,
    pub is_shared: bool,
    pub archived_at: Option<i64>,
    pub archive_reason: Option<String>,
    pub unarchived_at: Option<i64>,
    pub lifecycle_version: i64,
    pub last_user_message_at: Option<i64>,
    pub last_turn_finished_at: Option<i64>,
    pub activity_version: i64,
    pub auto_archive_exempt: bool,
    pub origin_source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryListResponse {
    pub items: Vec<ChatHistorySummary>,
    pub total_count: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatHistoryListFilter {
    pub cwd: Option<String>,
    pub cwd_empty: bool,
    pub archive_state: Option<String>,
    pub search: Option<String>,
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryQueryInput {
    pub page: i64,
    pub page_size: i64,
    #[serde(flatten)]
    pub filter: ChatHistoryListFilter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedChatCandidate {
    pub id: String,
    pub lifecycle_version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedChatSnapshot {
    pub candidates: Vec<ArchivedChatCandidate>,
    pub total_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteArchivedChatInput {
    pub candidates: Vec<ArchivedChatCandidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteArchivedChatSkipped {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteArchivedChatResult {
    pub deleted_ids: Vec<String>,
    pub skipped: Vec<DeleteArchivedChatSkipped>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySourceFacet {
    pub id: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryProjectFacet {
    pub path: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryArchiveFacets {
    pub sources: Vec<ChatHistorySourceFacet>,
    pub projects: Vec<ChatHistoryProjectFacet>,
}

pub use crate::services::conversation_lifecycle::ArchiveMutationInput as ChatHistoryArchiveInput;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryWorkdirSummary {
    pub path: String,
    pub conversation_count: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryWorkdirsResponse {
    pub workdirs: Vec<ChatHistoryWorkdirSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySegmentRecord {
    pub segment_index: i64,
    pub segment_id: String,
    pub summary_json: Option<String>,
    pub messages_json: String,
    pub message_count: i64,
    pub start_message_id: Option<String>,
    pub end_message_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryRecord {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub selected_model_json: Option<String>,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub segments: Vec<ChatHistorySegmentRecord>,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_pinned: bool,
    pub pinned_at: Option<i64>,
    pub is_shared: bool,
    pub redact_tool_content: bool,
    pub archived_at: Option<i64>,
    pub archive_reason: Option<String>,
    pub unarchived_at: Option<i64>,
    pub lifecycle_version: i64,
    pub last_user_message_at: Option<i64>,
    pub last_turn_finished_at: Option<i64>,
    pub activity_version: i64,
    pub auto_archive_exempt: bool,
    pub origin_source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryShareStatus {
    pub conversation_id: String,
    pub enabled: bool,
    pub token: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub redact_tool_content: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryActiveSegmentRecord {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub selected_model_json: Option<String>,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub active_segment: ChatHistorySegmentRecord,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_pinned: bool,
    pub pinned_at: Option<i64>,
    pub is_shared: bool,
    pub archived_at: Option<i64>,
    pub archive_reason: Option<String>,
    pub unarchived_at: Option<i64>,
    pub lifecycle_version: i64,
    pub last_user_message_at: Option<i64>,
    pub last_turn_finished_at: Option<i64>,
    pub activity_version: i64,
    pub auto_archive_exempt: bool,
    pub origin_source_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySegmentInput {
    pub segment_index: i64,
    pub segment_id: String,
    pub summary_json: Option<String>,
    pub messages_json: String,
    pub message_count: i64,
    pub start_message_id: Option<String>,
    pub end_message_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryUpsertInput {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub selected_model_json: Option<String>,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub segments: Vec<ChatHistorySegmentInput>,
    pub created_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryConversationInput {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub selected_model_json: Option<String>,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub created_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySegmentMutationInput {
    pub conversation: ChatHistoryConversationInput,
    pub segment: ChatHistorySegmentInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySearchArgs {
    pub query: String,
    pub limit: Option<usize>,
    pub history_since: Option<i64>,
    pub history_until: Option<i64>,
    pub history_date_local: Option<String>,
    pub history_time_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySearchResponse {
    pub matches: Vec<MemoryHistorySearchMatch>,
}

#[derive(Debug, Clone)]
struct ChatHistoryFtsConversationInfo {
    id: String,
    title: String,
    cwd: Option<String>,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct ChatHistoryFtsSegmentRecord {
    conversation: ChatHistoryFtsConversationInfo,
    segment: ChatHistorySegmentInput,
}

#[derive(Debug, Clone)]
struct SearchableHistoryMessage {
    message_index: i64,
    message_id: Option<String>,
    role: Option<String>,
    text: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistorySearchTimeMode {
    Message,
    Updated,
    Conversation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HistorySearchFilter {
    since: Option<i64>,
    until: Option<i64>,
    time_mode: HistorySearchTimeMode,
}
