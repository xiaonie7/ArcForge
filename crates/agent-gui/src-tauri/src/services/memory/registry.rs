//! WeCom memory roots are derived exclusively from durable, authenticated
//! channel bindings. Local memory continues to use the original MemoryStore.
use super::*;
use crate::{
    commands::settings::open_db,
    services::{
        channel_control::ChannelControlStore,
        gateway::{list_channel_bindings, ChannelConversationBinding},
    },
};
use std::sync::Arc;

const MAX_OPEN_SPACES: usize = 64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryAccessContext {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySpaceInfo {
    pub space_id: String,
    pub conversation_id: String,
    pub label: String,
    pub workdir: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct InstallationIdentity {
    bot_id: String,
    channel: String,
    connector_id: String,
    tenant_id: String,
}

#[derive(Debug, PartialEq, Eq)]
struct SpaceIdentity {
    space_id: String,
    installation_id: String,
    external_user_id: String,
    chat_id: Option<String>,
    label: String,
}

pub struct MemoryStoreRegistry {
    root: PathBuf,
    stores: Mutex<HashMap<String, Arc<MemoryStore>>>,
}

impl MemoryStoreRegistry {
    pub fn open() -> Result<Self, String> {
        let local_root = memory_root_dir()?;
        let root = local_root
            .parent()
            .ok_or("memory root has no parent")?
            .join("channel-memory");
        Ok(Self::at(root))
    }

    fn at(root: PathBuf) -> Self {
        Self {
            root,
            stores: Mutex::new(HashMap::new()),
        }
    }

    pub fn execute(
        &self,
        context: MemoryAccessContext,
        command: &str,
        mut payload: Value,
    ) -> Result<Value, String> {
        let control = ChannelControlStore::open()?;
        let store = self.resolve(&context, &control, &mut payload)?;
        dispatch_scoped(&store, command, payload)
    }

    /// Serializing open/eviction preserves one mutation lock per live space.
    /// Only cache-exclusive Arcs can be evicted; in-flight jobs keep theirs.
    fn store_for(&self, identity: &SpaceIdentity) -> Result<Arc<MemoryStore>, String> {
        let mut stores = self
            .stores
            .lock()
            .map_err(|_| "memory registry lock poisoned")?;
        if let Some(store) = stores.get(&identity.space_id) {
            return Ok(Arc::clone(store));
        }
        if stores.len() >= MAX_OPEN_SPACES {
            let unused = stores
                .iter()
                .find(|(_, store)| Arc::strong_count(store) == 1)
                .map(|(id, _)| id.clone());
            match unused {
                Some(id) => {
                    stores.remove(&id);
                }
                None => return Err("memory_spaces_busy: all memory stores are in use".into()),
            }
        }
        let store = Arc::new(MemoryStore::open_at(self.root.join(&identity.space_id))?);
        stores.insert(identity.space_id.clone(), Arc::clone(&store));
        Ok(store)
    }

    pub fn resolve(
        &self,
        context: &MemoryAccessContext,
        control: &ChannelControlStore,
        payload: &mut Value,
    ) -> Result<Arc<MemoryStore>, String> {
        self.resolve_bound(
            context,
            &list_channel_bindings(&context.conversation_id)?,
            control,
            payload,
        )
    }

    fn resolve_bound(
        &self,
        context: &MemoryAccessContext,
        bindings: &[ChannelConversationBinding],
        control: &ChannelControlStore,
        payload: &mut Value,
    ) -> Result<Arc<MemoryStore>, String> {
        let conversation_id = &context.conversation_id;
        if !valid_id(conversation_id, 512) {
            return Err("memory_context_invalid: conversation id is required".into());
        }
        let identity = resolve_identity(conversation_id, bindings)?;
        let profile = control
            .resolve_effective_profile(
                &identity.installation_id,
                &identity.external_user_id,
                Some(conversation_id),
            )?
            .ok_or("memory_disabled: no effective channel permission profile")?;
        constrain_payload(payload, &profile.policy, conversation_id)?;
        self.store_for(&identity)
    }

    /// Durable bindings, rather than this process's cache, discover spaces
    /// after restart. This is a desktop management endpoint, not a model tool.
    pub fn list_spaces(&self) -> Result<Vec<MemorySpaceInfo>, String> {
        let conn = open_db()?;
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_conversation_bindings')",
            [], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !exists {
            return Ok(Vec::new());
        }
        let mut stmt = conn.prepare(
            "SELECT DISTINCT conversation_id FROM channel_conversation_bindings WHERE closed_at IS NULL ORDER BY conversation_id"
        ).map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        drop(conn);
        let mut spaces = BTreeMap::new();
        let control = ChannelControlStore::open()?;
        for conversation_id in ids {
            let bindings = list_channel_bindings(&conversation_id)?;
            // Legacy/other-channel rows are never treated as local memory.
            let Ok(identity) = resolve_identity(&conversation_id, &bindings) else {
                continue;
            };
            let Some(profile) = control.resolve_effective_profile(
                &identity.installation_id,
                &identity.external_user_id,
                Some(&conversation_id),
            )?
            else {
                continue;
            };
            if profile.policy.get("memoryEnabled").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let workdir = profile
                .policy
                .get("workdir")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string);
            spaces
                .entry(identity.space_id.clone())
                .or_insert(MemorySpaceInfo {
                    space_id: identity.space_id,
                    conversation_id,
                    label: identity.label,
                    workdir,
                });
        }
        Ok(spaces.into_values().collect())
    }
}

fn dispatch_scoped(store: &MemoryStore, command: &str, payload: Value) -> Result<Value, String> {
    fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
        serde_json::from_value(value).map_err(|e| format!("memory_args_invalid: {e}"))
    }
    fn encode<T: Serialize>(value: T) -> Result<Value, String> {
        serde_json::to_value(value).map_err(|e| format!("memory_response_invalid: {e}"))
    }
    let args = payload.get("args").cloned().unwrap_or_else(|| json!({}));
    // Keep this allowlist explicit. Scoped dispatch must never invoke the
    // legacy local commands or their unrestricted chat-history search.
    match command {
        "memory_list" => encode(store.list(decode(args)?)?),
        "memory_read" => encode(store.read(decode(args)?)?),
        "memory_search" => {
            let mut args: MemorySearchArgs = decode(args)?;
            args.include_history = Some(false);
            encode(store.search(args)?)
        }
        "memory_write" => encode(store.write(decode(args)?)?),
        "memory_update" => encode(store.update(decode(args)?)?),
        "memory_delete" => encode(store.delete(decode(args)?)?),
        "memory_delete_project" => encode(store.delete_project(decode(args)?)?),
        "memory_accept" => encode(store.accept(decode(args)?)?),
        "memory_apply_batch" => encode(store.apply_batch(decode(args)?)?),
        "memory_organize_run_create" => encode(store.organize_run_create(decode(args)?)?),
        "memory_organize_run_update" => encode(store.organize_run_update(decode(args)?)?),
        "memory_organize_run_list" => encode(store.organize_run_list(decode(args)?)?),
        "memory_organize_run_read" => encode(store.organize_run_read(decode(args)?)?),
        "memory_organize_run_clear_history" => encode(store.organize_run_clear_history()?),
        "memory_organize_due_claim" => encode(store.organize_due_claim(decode(args)?)?),
        "memory_organize_due_complete" => encode(store.organize_due_complete(decode(args)?)?),
        "memory_index_overview" => encode(store.overview(decode(
            payload.get("workdir").cloned().unwrap_or(Value::Null),
        )?)?),
        "memory_paths_info" => encode(store.paths_info()?),
        "memory_recent_rejections" => encode(store.recent_rejections(decode(args)?)?),
        "memory_today_local_date" => encode(store.today_local_date(decode(
            payload.get("rolloverHour").cloned().unwrap_or(Value::Null),
        )?)),
        "memory_today_daily" => encode(store.today_daily(decode(
            payload.get("rolloverHour").cloned().unwrap_or(Value::Null),
        )?)?),
        "memory_quota_summary" => encode(store.quota_summary(decode(args)?)?),
        "memory_wipe_all" => encode(store.wipe_all()?),
        _ => Err(format!("memory_command_unsupported: {command}")),
    }
}

fn valid_id(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= max_bytes
        && !value.chars().any(char::is_control)
}

fn identity_from_binding(binding: &ChannelConversationBinding) -> Result<SpaceIdentity, String> {
    let invalid = || "memory_context_invalid: malformed WeCom binding".to_string();
    if binding.lifecycle_version != 1
        || binding.generation == 0
        || binding.generation > 9_007_199_254_740_991
        || !valid_id(&binding.session_id, 128)
        || binding.installation_id.len() > 4096
        || binding.scope_key.len() > 2048
    {
        return Err(invalid());
    }
    let installation: InstallationIdentity =
        serde_json::from_str(&binding.installation_id).map_err(|_| invalid())?;
    if installation.channel != "wecom"
        || [
            &installation.bot_id,
            &installation.connector_id,
            &installation.tenant_id,
        ]
        .iter()
        .any(|id| !valid_id(id, 512))
        || serde_json::to_string(&installation).map_err(|_| invalid())? != binding.installation_id
    {
        return Err(invalid());
    }
    let encoded = binding.scope_key.strip_prefix("v1:").ok_or_else(invalid)?;
    let parts: [String; 3] = serde_json::from_str(encoded).map_err(|_| invalid())?;
    if serde_json::to_string(&parts).map_err(|_| invalid())? != encoded
        || !valid_id(&parts[2], 512)
        || match parts[0].as_str() {
            "single" => parts[1] != "direct",
            "group" => !valid_id(&parts[1], 512),
            _ => true,
        }
    {
        return Err(invalid());
    }
    let chat_id = (parts[0] == "group").then(|| parts[1].clone());
    let bytes = serde_json::to_vec(&json!(["wecom-memory-v1", binding.installation_id, parts]))
        .map_err(|_| invalid())?;
    let space_id = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let label = match &chat_id {
        Some(group) => format!(
            "企业微信 · {} · 群 {} · {}",
            parts[2], group, installation.bot_id
        ),
        None => format!("企业微信 · {} · 个人 · {}", parts[2], installation.bot_id),
    };
    Ok(SpaceIdentity {
        space_id,
        installation_id: binding.installation_id.clone(),
        external_user_id: parts[2].clone(),
        chat_id,
        label,
    })
}

fn resolve_identity(
    conversation_id: &str,
    bindings: &[ChannelConversationBinding],
) -> Result<SpaceIdentity, String> {
    let mut identity: Option<SpaceIdentity> = None;
    for binding in bindings {
        if binding.conversation_id != conversation_id {
            return Err("memory_context_invalid: conversation binding mismatch".into());
        }
        let candidate = identity_from_binding(binding)?;
        if identity
            .as_ref()
            .is_some_and(|current| current != &candidate)
        {
            return Err("memory_context_invalid: ambiguous conversation owner".into());
        }
        identity = Some(candidate);
    }
    identity.ok_or_else(|| {
        "memory_context_unbound: no trusted WeCom binding; local memory is unavailable".into()
    })
}

/// Recheck current channel policy at each operation, including delayed jobs.
/// Scope arguments may narrow to global memory, but cannot select another
/// project by path/hash or use the management-only all-projects switch.
fn constrain_payload(
    payload: &mut Value,
    policy: &Value,
    conversation_id: &str,
) -> Result<(), String> {
    if policy.get("memoryEnabled").and_then(Value::as_bool) != Some(true) {
        return Err("memory_disabled: channel policy disables memory".into());
    }
    let workdir = policy
        .get("workdir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let allowed_hash = optional_workdir_hash(workdir)?;
    let outer = payload
        .as_object_mut()
        .ok_or("memory_args_invalid: payload must be an object")?;
    if let Some(requested) = outer.get("workdir").filter(|value| !value.is_null()) {
        validate_requested_workdir(requested, allowed_hash.as_deref())?;
    }
    outer.insert(
        "workdir".into(),
        workdir.map(Value::from).unwrap_or(Value::Null),
    );
    if !outer.contains_key("args") || outer["args"].is_null() {
        outer.insert("args".into(), json!({}));
    }
    let args = outer
        .get_mut("args")
        .and_then(Value::as_object_mut)
        .ok_or("memory_args_invalid: args must be an object")?;
    if let Some(requested) = args.get("workdir").filter(|value| !value.is_null()) {
        validate_requested_workdir(requested, allowed_hash.as_deref())?;
    }
    validate_project_hash(args.get("workdirHash"), allowed_hash.as_deref())?;
    if let Some(decisions) = args.get("decisions").and_then(Value::as_array) {
        for decision in decisions {
            validate_project_hash(decision.get("workdirHash"), allowed_hash.as_deref())?;
        }
    }
    args.insert(
        "workdir".into(),
        workdir.map(Value::from).unwrap_or(Value::Null),
    );
    args.insert("includeAllProjects".into(), Value::Bool(false));
    args.insert("includeHistory".into(), Value::Bool(false));
    args.insert("conversationId".into(), Value::from(conversation_id));
    Ok(())
}

fn validate_requested_workdir(value: &Value, allowed_hash: Option<&str>) -> Result<(), String> {
    let workdir = value
        .as_str()
        .ok_or("memory_workdir_denied: invalid workdir")?;
    if !workdir.trim().is_empty()
        && optional_workdir_hash(Some(workdir))?.as_deref() != allowed_hash
    {
        return Err("memory_workdir_denied: project is outside channel policy".into());
    }
    Ok(())
}

fn validate_project_hash(value: Option<&Value>, allowed_hash: Option<&str>) -> Result<(), String> {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        let hash = value
            .as_str()
            .ok_or("memory_workdir_denied: invalid project hash")?;
        if !hash.is_empty() && Some(hash) != allowed_hash {
            return Err("memory_workdir_denied: project hash is outside channel policy".into());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
