use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;

const EXECUTION_PROTOCOL_VERSION: &str = "1.0";
const EXECUTION_SCHEMA_VERSION: u32 = 1;
const NATIVE_PI_BACKEND_ID: &str = "native-pi";

#[derive(Debug, Clone)]
struct BrokerTaskWorkspace {
    parent_root: PathBuf,
    worktree_root: PathBuf,
    task_workspace_root: PathBuf,
    base_revision: String,
}

#[derive(Debug, Clone)]
struct BrokerRunBinding {
    binding_id: String,
    task_id: String,
    workspace_id: String,
    task_workspace_root: PathBuf,
    worktree_root: PathBuf,
    base_revision: String,
    allowed_output_paths: Vec<String>,
    mode: String,
    capabilities: HashSet<String>,
    last_source_sequence: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct BrokerValidationBinding {
    pub task_id: String,
    pub run_id: String,
    pub run_spec_hash: String,
    pub workspace_id: String,
    pub worktree_root: PathBuf,
    pub base_revision: String,
    pub allowed_output_paths: Vec<String>,
}

#[derive(Default)]
struct BrokerRegistry {
    pending_workspaces: HashMap<String, BrokerTaskWorkspace>,
    runs: HashMap<(String, String), BrokerRunBinding>,
}

#[derive(Default)]
pub struct ExecutionBrokerState {
    registry: Mutex<BrokerRegistry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerRunRegistrationInput {
    run_spec: Value,
    run_spec_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrokerRunSpecInput {
    schema_version: u32,
    protocol_version: String,
    task_id: String,
    run_id: String,
    backend_id: String,
    mode: String,
    workspace: BrokerRunWorkspaceInput,
    capabilities: Vec<String>,
    validation_plan: BrokerValidationPlanInput,
    candidate_policy: BrokerCandidatePolicyInput,
    created_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrokerRunWorkspaceInput {
    workspace_id: String,
    parent_root: String,
    task_root: String,
    base_revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrokerValidationPlanInput {
    required_checks: Vec<String>,
    commands: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrokerCandidatePolicyInput {
    allowed_output_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerRunRegistrationResponse {
    binding_id: String,
    isolation_level: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolIntentProposalInput {
    schema_version: u32,
    protocol_version: String,
    task_id: String,
    run_id: String,
    run_spec_hash: String,
    workspace_id: String,
    source_sequence: u64,
    tool_call_id: String,
    tool_name: String,
    effect: String,
    arguments: Value,
    submitted_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerAuthorizationResponse {
    authorized: bool,
    authorization_id: Option<String>,
    isolation_level: Option<&'static str>,
    reason: Option<String>,
}

impl ExecutionBrokerState {
    pub(crate) fn register_task_workspace(
        &self,
        parent_root: &Path,
        worktree_root: &Path,
        task_workspace_root: &Path,
        base_revision: &str,
    ) -> Result<String, String> {
        let parent_root = canonicalize_existing_dir(parent_root, "parent workspace")?;
        let worktree_root = canonicalize_owned_worktree(worktree_root)?;
        let task_workspace_root = canonicalize_existing_dir(task_workspace_root, "task workspace")?;
        if !task_workspace_root.starts_with(&worktree_root) {
            return Err("task workspace must be inside its ArcForge worktree".to_string());
        }
        let base_revision = validate_git_object_id(base_revision, "baseRevision")?;
        let workspace_id = Uuid::new_v4().to_string();
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "execution broker state is poisoned".to_string())?;
        registry.pending_workspaces.insert(
            workspace_id.clone(),
            BrokerTaskWorkspace {
                parent_root,
                worktree_root,
                task_workspace_root,
                base_revision,
            },
        );
        Ok(workspace_id)
    }

    pub(crate) fn validation_binding(
        &self,
        run_id: &str,
        run_spec_hash: &str,
    ) -> Result<BrokerValidationBinding, String> {
        let run_id = validate_identifier(run_id, "runId")?;
        let run_spec_hash = validate_sha256(run_spec_hash, "runSpecHash")?;
        let registry = self
            .registry
            .lock()
            .map_err(|_| "execution broker state is poisoned".to_string())?;
        let binding = registry
            .runs
            .get(&(run_id.clone(), run_spec_hash.clone()))
            .ok_or_else(|| "run is not active in the execution broker".to_string())?;
        Ok(BrokerValidationBinding {
            task_id: binding.task_id.clone(),
            run_id,
            run_spec_hash,
            workspace_id: binding.workspace_id.clone(),
            worktree_root: binding.worktree_root.clone(),
            base_revision: binding.base_revision.clone(),
            allowed_output_paths: binding.allowed_output_paths.clone(),
        })
    }

    fn register_run(
        &self,
        registration: BrokerRunRegistrationInput,
    ) -> Result<BrokerRunRegistrationResponse, String> {
        let run_spec_hash = validate_sha256(&registration.run_spec_hash, "runSpecHash")?;
        let canonical_spec = canonical_json(&registration.run_spec)?;
        let computed_hash = sha256_hex(canonical_spec.as_bytes());
        if computed_hash != run_spec_hash {
            return Err("runSpecHash does not match the canonical RunSpec".to_string());
        }
        let spec: BrokerRunSpecInput = serde_json::from_value(registration.run_spec)
            .map_err(|error| format!("invalid RunSpec: {error}"))?;
        validate_run_spec(&spec)?;

        let task_id = validate_identifier(&spec.task_id, "taskId")?;
        let run_id = validate_identifier(&spec.run_id, "runId")?;
        let workspace_id = validate_identifier(&spec.workspace.workspace_id, "workspaceId")?;
        let key = (run_id, run_spec_hash);
        let capabilities = validate_capabilities(spec.capabilities)?;
        let allowed_output_paths =
            validate_allowed_output_paths(spec.candidate_policy.allowed_output_paths)?;

        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "execution broker state is poisoned".to_string())?;
        if registry.runs.contains_key(&key) {
            return Err("run is already registered with the execution broker".to_string());
        }
        let workspace = registry
            .pending_workspaces
            .get(&workspace_id)
            .cloned()
            .ok_or_else(|| "RunSpec workspaceId was not issued by ArcForge".to_string())?;
        let claimed_parent = canonicalize_existing_dir(
            Path::new(&spec.workspace.parent_root),
            "RunSpec parentRoot",
        )?;
        let claimed_task =
            canonicalize_existing_dir(Path::new(&spec.workspace.task_root), "RunSpec taskRoot")?;
        if claimed_parent != workspace.parent_root
            || claimed_task != workspace.task_workspace_root
            || spec.workspace.base_revision.to_ascii_lowercase() != workspace.base_revision
        {
            return Err(
                "RunSpec workspace paths or base revision do not match the Rust-issued workspace"
                    .to_string(),
            );
        }

        let binding_id = Uuid::new_v4().to_string();
        registry.pending_workspaces.remove(&workspace_id);
        registry.runs.insert(
            key,
            BrokerRunBinding {
                binding_id: binding_id.clone(),
                task_id,
                workspace_id,
                task_workspace_root: workspace.task_workspace_root,
                worktree_root: workspace.worktree_root,
                base_revision: workspace.base_revision,
                allowed_output_paths,
                mode: spec.mode,
                capabilities,
                last_source_sequence: 0,
            },
        );
        Ok(BrokerRunRegistrationResponse {
            binding_id,
            isolation_level: "workspace_only",
        })
    }

    fn authorize_intent(&self, proposal: ToolIntentProposalInput) -> BrokerAuthorizationResponse {
        if proposal.schema_version != EXECUTION_SCHEMA_VERSION
            || proposal.protocol_version != EXECUTION_PROTOCOL_VERSION
        {
            return denied("unsupported execution protocol");
        }
        if proposal.submitted_at == 0 {
            return denied("submittedAt must be non-zero");
        }
        if proposal.tool_call_id.trim().is_empty() {
            return denied("toolCallId must not be empty");
        }
        let run_spec_hash = match validate_sha256(&proposal.run_spec_hash, "runSpecHash") {
            Ok(value) => value,
            Err(error) => return denied(error),
        };
        let key = (proposal.run_id.trim().to_string(), run_spec_hash);
        let mut registry = match self.registry.lock() {
            Ok(registry) => registry,
            Err(_) => return denied("execution broker state is poisoned"),
        };
        let Some(binding) = registry.runs.get_mut(&key) else {
            return denied("run is not registered with the execution broker");
        };
        if binding.task_id != proposal.task_id.trim()
            || binding.workspace_id != proposal.workspace_id.trim()
        {
            return denied("tool intent does not match the registered task workspace");
        }
        if binding.mode != "execute" {
            return denied("registered run is not in execute mode");
        }
        if proposal.source_sequence != binding.last_source_sequence.saturating_add(1) {
            return denied("tool intent sourceSequence is stale or out of order");
        }

        // A well-bound source event is consumed whether policy allows or denies
        // it. Otherwise one rejected call would make every later sequence stale.
        binding.last_source_sequence = proposal.source_sequence;

        let Some(expected_effect) = expected_effect(proposal.tool_name.trim()) else {
            return denied("tool is not available in NativePiBackend candidate mode");
        };
        if expected_effect != proposal.effect {
            return denied("tool intent effect classification does not match the tool");
        }
        let Some(required_capability) = required_capability(&proposal.effect) else {
            return denied("tool intent uses an unknown effect classification");
        };
        if !binding.capabilities.contains(required_capability) {
            return denied(format!("missing capability {required_capability}"));
        }
        if let Err(error) = validate_tool_arguments(&proposal) {
            return denied(error);
        }
        if fs::canonicalize(&binding.task_workspace_root).ok().as_ref()
            != Some(&binding.task_workspace_root)
        {
            return denied("task workspace binding is stale");
        }

        BrokerAuthorizationResponse {
            authorized: true,
            authorization_id: Some(format!(
                "{}:{}",
                binding.binding_id, proposal.source_sequence
            )),
            isolation_level: Some("workspace_only"),
            reason: None,
        }
    }

    fn close_run(&self, run_id: &str, run_spec_hash: &str) -> Result<(), String> {
        let run_id = validate_identifier(run_id, "runId")?;
        let run_spec_hash = validate_sha256(run_spec_hash, "runSpecHash")?;
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "execution broker state is poisoned".to_string())?;
        registry.runs.remove(&(run_id, run_spec_hash));
        Ok(())
    }
}

fn canonicalize_existing_dir(path: &Path, label: &str) -> Result<PathBuf, String> {
    let path =
        fs::canonicalize(path).map_err(|error| format!("failed to resolve {label}: {error}"))?;
    if !path.is_dir() {
        return Err(format!("{label} must be an existing directory"));
    }
    Ok(path)
}

fn canonicalize_owned_worktree(path: &Path) -> Result<PathBuf, String> {
    let path = canonicalize_existing_dir(path, "worktree")?;
    if !path.components().any(
        |component| matches!(component, Component::Normal(name) if name == ".arcforge-subagents"),
    ) {
        return Err("worktree is not owned by ArcForge".to_string());
    }
    Ok(path)
}

fn validate_identifier(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if trimmed.len() > 256 {
        return Err(format!("{label} is too long"));
    }
    Ok(trimmed.to_string())
}

fn validate_sha256(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.len() != 64 || !trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{label} must be a 64-character SHA-256 hex digest"));
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn validate_git_object_id(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if !(trimmed.len() == 40 || trimmed.len() == 64)
        || !trimmed.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!("{label} must be a full Git object id"));
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn validate_run_spec(spec: &BrokerRunSpecInput) -> Result<(), String> {
    if spec.schema_version != EXECUTION_SCHEMA_VERSION
        || spec.protocol_version != EXECUTION_PROTOCOL_VERSION
    {
        return Err("unsupported RunSpec protocol".to_string());
    }
    if spec.backend_id != NATIVE_PI_BACKEND_ID {
        return Err("RunSpec backendId must be native-pi".to_string());
    }
    if spec.mode != "execute" {
        return Err("NativePiBackend candidate runs must use execute mode".to_string());
    }
    if spec.created_at == 0 {
        return Err("RunSpec createdAt must be non-zero".to_string());
    }
    validate_git_object_id(&spec.workspace.base_revision, "RunSpec baseRevision")?;
    if !spec.validation_plan.commands.is_empty() {
        return Err("Phase 1 validation commands must be empty".to_string());
    }
    let required = spec
        .validation_plan
        .required_checks
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let expected = [
        "base_revision",
        "candidate_paths",
        "candidate_limits",
        "candidate_stability",
        "git_diff_check",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    if required != expected {
        return Err("RunSpec requiredChecks do not match the Phase 1 validator".to_string());
    }
    Ok(())
}

fn validate_capabilities(values: Vec<String>) -> Result<HashSet<String>, String> {
    let capabilities = values
        .into_iter()
        .map(|capability| capability.trim().to_string())
        .filter(|capability| !capability.is_empty())
        .collect::<HashSet<_>>();
    let allowed = [
        "workspace.read",
        "workspace.write",
        "process.execute",
        "coordination.send",
    ];
    if capabilities
        .iter()
        .any(|capability| !allowed.contains(&capability.as_str()))
    {
        return Err("RunSpec contains an unknown capability".to_string());
    }
    Ok(capabilities)
}

fn validate_allowed_output_paths(values: Vec<String>) -> Result<Vec<String>, String> {
    values
        .into_iter()
        .map(|value| {
            let value = value.trim().replace('\\', "/");
            validate_relative_path(&value, "allowed output path")?;
            Ok(value)
        })
        .collect()
}

fn canonical_json(value: &Value) -> Result<String, String> {
    fn append(value: &Value, output: &mut String) -> Result<(), String> {
        match value {
            Value::Null => output.push_str("null"),
            Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            Value::Number(value) => output.push_str(&value.to_string()),
            Value::String(value) => output.push_str(
                &serde_json::to_string(value)
                    .map_err(|error| format!("failed to encode RunSpec string: {error}"))?,
            ),
            Value::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    append(value, output)?;
                }
                output.push(']');
            }
            Value::Object(values) => {
                output.push('{');
                let mut keys = values.keys().collect::<Vec<_>>();
                keys.sort();
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str(
                        &serde_json::to_string(key)
                            .map_err(|error| format!("failed to encode RunSpec key: {error}"))?,
                    );
                    output.push(':');
                    append(&values[key], output)?;
                }
                output.push('}');
            }
        }
        Ok(())
    }

    let mut output = String::new();
    append(value, &mut output)?;
    Ok(output)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn required_capability(effect: &str) -> Option<&'static str> {
    match effect {
        "workspace_read" => Some("workspace.read"),
        "workspace_draft_mutation" => Some("workspace.write"),
        "process_execution" => Some("process.execute"),
        "coordination_message" => Some("coordination.send"),
        _ => None,
    }
}

fn expected_effect(tool_name: &str) -> Option<&'static str> {
    match tool_name {
        "Read" | "List" | "Glob" | "Grep" => Some("workspace_read"),
        "Write" | "Edit" | "Delete" => Some("workspace_draft_mutation"),
        "Bash" => Some("process_execution"),
        "SendMessage" => Some("coordination_message"),
        _ => None,
    }
}

fn validate_relative_path(raw: &str, label: &str) -> Result<(), String> {
    let value = raw.trim();
    if value.is_empty() || value.contains('\0') {
        return Err(format!("{label} must not be empty or contain NUL"));
    }
    if value.contains("://") || value.starts_with("~/") || value.starts_with("~\\") {
        return Err(format!("{label} must be task-workspace relative"));
    }
    if cfg!(windows) && value.contains(':') {
        return Err(format!("{label} must not contain a drive or ADS separator"));
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(format!("{label} must be task-workspace relative"));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("{label} contains an unsafe path component")),
        }
    }
    Ok(())
}

fn validate_optional_path(arguments: &Value, required: bool) -> Result<(), String> {
    let Some(arguments) = arguments.as_object() else {
        return Err("tool arguments must be an object".to_string());
    };
    match arguments.get("path") {
        Some(Value::String(path)) => validate_relative_path(path, "path"),
        Some(_) => Err("path must be a string".to_string()),
        None if required => Err("path is required".to_string()),
        None => Ok(()),
    }
}

fn validate_tool_arguments(proposal: &ToolIntentProposalInput) -> Result<(), String> {
    match proposal.tool_name.as_str() {
        "Read" | "Write" | "Edit" | "Delete" => validate_optional_path(&proposal.arguments, true),
        "List" | "Glob" | "Grep" => validate_optional_path(&proposal.arguments, false),
        "Bash" => {
            let arguments = proposal
                .arguments
                .as_object()
                .ok_or_else(|| "Bash arguments must be an object".to_string())?;
            let command = arguments
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Bash.command is required".to_string())?;
            if command.len() > 128 * 1024 {
                return Err("Bash.command exceeds the broker limit".to_string());
            }
            if let Some(cwd) = arguments.get("cwd") {
                let cwd = cwd
                    .as_str()
                    .ok_or_else(|| "Bash.cwd must be a string".to_string())?;
                validate_relative_path(cwd, "Bash.cwd")?;
            }
            Ok(())
        }
        "SendMessage" => {
            if proposal.arguments.is_object() {
                Ok(())
            } else {
                Err("SendMessage arguments must be an object".to_string())
            }
        }
        _ => Err("tool is not available in NativePiBackend candidate mode".to_string()),
    }
}

fn denied(reason: impl Into<String>) -> BrokerAuthorizationResponse {
    BrokerAuthorizationResponse {
        authorized: false,
        authorization_id: None,
        isolation_level: None,
        reason: Some(reason.into()),
    }
}

#[tauri::command]
pub fn execution_broker_register_run(
    state: State<'_, ExecutionBrokerState>,
    registration: BrokerRunRegistrationInput,
) -> Result<BrokerRunRegistrationResponse, String> {
    state.register_run(registration)
}

#[tauri::command]
pub fn execution_broker_authorize(
    state: State<'_, ExecutionBrokerState>,
    proposal: ToolIntentProposalInput,
) -> BrokerAuthorizationResponse {
    state.authorize_intent(proposal)
}

#[tauri::command]
pub fn execution_broker_close_run(
    state: State<'_, ExecutionBrokerState>,
    run_id: String,
    run_spec_hash: String,
) -> Result<(), String> {
    state.close_run(&run_id, &run_spec_hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_owned_workspace() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("arcforge-broker-{}", Uuid::new_v4()));
        let parent = root.join("repo");
        let worktree = root
            .join(".arcforge-subagents")
            .join("repo")
            .join("candidate");
        let task = worktree.join("nested");
        fs::create_dir_all(&parent).expect("create parent");
        fs::create_dir_all(&task).expect("create task");
        (
            fs::canonicalize(parent).expect("canonical parent"),
            fs::canonicalize(worktree).expect("canonical worktree"),
            fs::canonicalize(task).expect("canonical task"),
        )
    }

    fn binding_for(task_workspace_root: PathBuf, worktree_root: PathBuf) -> BrokerRunBinding {
        BrokerRunBinding {
            binding_id: "binding-1".to_string(),
            task_id: "task-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            task_workspace_root,
            worktree_root,
            base_revision: "a".repeat(40),
            allowed_output_paths: vec!["src/**".to_string()],
            mode: "execute".to_string(),
            capabilities: ["workspace.write".to_string()].into_iter().collect(),
            last_source_sequence: 0,
        }
    }

    fn write_proposal(sequence: u64, path: &str) -> ToolIntentProposalInput {
        ToolIntentProposalInput {
            schema_version: 1,
            protocol_version: "1.0".to_string(),
            task_id: "task-1".to_string(),
            run_id: "run-1".to_string(),
            run_spec_hash: "b".repeat(64),
            workspace_id: "workspace-1".to_string(),
            source_sequence: sequence,
            tool_call_id: format!("tool-{sequence}"),
            tool_name: "Write".to_string(),
            effect: "workspace_draft_mutation".to_string(),
            arguments: serde_json::json!({ "path": path, "content": "next" }),
            submitted_at: 1,
        }
    }

    #[test]
    fn relative_path_validation_rejects_escape_and_absolute_forms() {
        for path in [
            "../secret",
            "C:\\secret",
            "\\\\server\\share",
            "file://secret",
        ] {
            assert!(validate_relative_path(path, "path").is_err(), "{path}");
        }
        assert!(validate_relative_path("src/app.ts", "path").is_ok());
    }

    #[test]
    fn tool_effects_are_fail_closed() {
        assert_eq!(expected_effect("Write"), Some("workspace_draft_mutation"));
        assert_eq!(expected_effect("Bash"), Some("process_execution"));
        assert_eq!(expected_effect("McpManager"), None);
    }

    #[test]
    fn a_policy_denial_consumes_its_bound_source_sequence() {
        let (_, worktree, task) = temp_owned_workspace();
        let state = ExecutionBrokerState::default();
        state.registry.lock().expect("registry").runs.insert(
            ("run-1".to_string(), "b".repeat(64)),
            binding_for(task, worktree),
        );

        let denied = state.authorize_intent(write_proposal(1, "../escape"));
        assert!(!denied.authorized);
        let allowed = state.authorize_intent(write_proposal(2, "src/app.ts"));
        assert!(allowed.authorized, "{:?}", allowed.reason);
    }

    #[test]
    fn canonical_json_sorts_object_keys_recursively() {
        let value = serde_json::json!({"z": 1, "nested": {"b": true, "a": [2, 1]}});
        assert_eq!(
            canonical_json(&value).expect("canonical json"),
            r#"{"nested":{"a":[2,1],"b":true},"z":1}"#
        );
    }

    #[test]
    fn run_spec_hash_matches_the_frontend_canonical_fixture() {
        let spec = serde_json::json!({
            "schemaVersion": 1,
            "protocolVersion": "1.0",
            "taskId": "task-1",
            "runId": "run-1",
            "backendId": "native-pi",
            "mode": "execute",
            "workspace": {
                "workspaceId": "workspace-1",
                "parentRoot": "C:/repo",
                "taskRoot": "C:/repo-worktree",
                "baseRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            "capabilities": ["workspace.read"],
            "validationPlan": {
                "requiredChecks": ["base_revision"],
                "commands": [],
            },
            "candidatePolicy": { "allowedOutputPaths": [] },
            "createdAt": 1,
        });
        assert_eq!(
            sha256_hex(canonical_json(&spec).expect("canonical RunSpec").as_bytes()),
            "a90e0ea2194df8febad90fd83a841cab52a1fed4b1e7619b2e0be28247411fa0"
        );
    }

    #[test]
    fn run_registration_consumes_a_rust_issued_workspace_and_binds_validation() {
        let (parent, worktree, task) = temp_owned_workspace();
        let state = ExecutionBrokerState::default();
        let base_revision = "a".repeat(40);
        let workspace_id = state
            .register_task_workspace(&parent, &worktree, &task, &base_revision)
            .expect("register task workspace");
        let spec = serde_json::json!({
            "schemaVersion": 1,
            "protocolVersion": "1.0",
            "taskId": "task-1",
            "runId": "run-1",
            "backendId": "native-pi",
            "mode": "execute",
            "workspace": {
                "workspaceId": workspace_id,
                "parentRoot": parent.to_string_lossy(),
                "taskRoot": task.to_string_lossy(),
                "baseRevision": base_revision,
            },
            "capabilities": [
                "workspace.read",
                "workspace.write",
                "process.execute",
                "coordination.send",
            ],
            "validationPlan": {
                "requiredChecks": [
                    "base_revision",
                    "candidate_paths",
                    "candidate_limits",
                    "candidate_stability",
                    "git_diff_check",
                ],
                "commands": [],
            },
            "candidatePolicy": {
                "allowedOutputPaths": ["src/**"],
            },
            "createdAt": 1,
        });
        let hash = sha256_hex(canonical_json(&spec).expect("canonical RunSpec").as_bytes());
        state
            .register_run(BrokerRunRegistrationInput {
                run_spec: spec,
                run_spec_hash: hash.clone(),
            })
            .expect("register run");

        let validation = state
            .validation_binding("run-1", &hash)
            .expect("validation binding");
        assert_eq!(validation.worktree_root, worktree);
        assert_eq!(validation.base_revision, "a".repeat(40));
        assert_eq!(validation.allowed_output_paths, vec!["src/**".to_string()]);
        assert!(state
            .registry
            .lock()
            .expect("registry")
            .pending_workspaces
            .is_empty());
    }
}
