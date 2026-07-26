use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use uuid::Uuid;

use crate::commands::execution_broker::{BrokerValidationBinding, ExecutionBrokerState};
use crate::runtime::process::configure_child_process_group;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn git_command(cwd: &Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(cwd);
    configure_child_process_group(&mut command);
    command
}

const DEFAULT_MAX_DIFF_CHARS: usize = 20_000;
const MAX_DIFF_CHARS: usize = 80_000;
const CREATE_WORKTREE_MAX_ATTEMPTS: usize = 8;
const MAX_CANDIDATE_FILES: usize = 2_000;
const MAX_CANDIDATE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCreateResponse {
    workspace_id: String,
    repo_root: String,
    worktree_root: String,
    workdir: String,
    branch_name: String,
    base_revision: String,
    #[serde(skip_serializing)]
    parent_workdir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeStatusResponse {
    changed: bool,
    status: String,
    diff_stat: String,
    diff: String,
    diff_truncated: bool,
    untracked_files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubagentWorktreeValidateInput {
    pub run_id: String,
    pub run_spec_hash: String,
    pub max_diff_chars: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateBundleResponse {
    pub kind: &'static str,
    pub candidate_id: String,
    pub task_id: String,
    pub run_id: String,
    pub run_spec_hash: String,
    pub candidate_hash: String,
    pub base_revision: String,
    pub changed_paths: Vec<String>,
    pub status: String,
    pub diff_stat: String,
    pub diff: String,
    pub diff_truncated: bool,
    pub untracked_files: Vec<String>,
    pub created_at: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationCheckResponse {
    pub id: &'static str,
    pub status: &'static str,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReportResponse {
    pub kind: &'static str,
    pub report_id: String,
    pub report_hash: String,
    pub task_id: String,
    pub run_id: String,
    pub run_spec_hash: String,
    pub candidate_hash: String,
    pub base_revision: String,
    pub status: &'static str,
    pub scope: &'static str,
    pub checks: Vec<ValidationCheckResponse>,
    pub test_status: &'static str,
    pub created_at: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeValidateResponse {
    pub candidate: CandidateBundleResponse,
    pub validation: ValidationReportResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeApplyResponse {
    applied: bool,
    changed: bool,
    status: String,
    patch_bytes: usize,
    skipped_reason: Option<String>,
    apply_method: Option<String>,
    fallback_reason: Option<String>,
    copied_files: Vec<String>,
    deleted_files: Vec<String>,
    conflict_files: Vec<String>,
}

#[derive(Debug)]
struct FileCopyFallbackResult {
    copied_files: Vec<String>,
    deleted_files: Vec<String>,
    conflict_files: Vec<String>,
    already_applied_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCreateInput {
    pub workdir: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeStatusInput {
    pub worktree_root: String,
    pub max_diff_chars: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeApplyInput {
    pub parent_workdir: String,
    pub worktree_root: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCleanupInput {
    pub worktree_root: String,
    pub branch_name: Option<String>,
    pub dry_run: Option<bool>,
    pub force: Option<bool>,
    pub delete_branch: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCleanupTarget {
    pub run_id: Option<String>,
    pub worktree_root: String,
    pub branch_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCleanupItem {
    pub run_id: Option<String>,
    pub worktree_root: String,
    pub branch_name: Option<String>,
    pub removed: bool,
    pub branch_deleted: bool,
    pub skipped_reason: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCleanupBatchResponse {
    pub cleaned_count: usize,
    pub branch_deleted_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub items: Vec<SubagentWorktreeCleanupItem>,
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command(cwd)
        .args(args)
        .output()
        .map_err(|err| format!("failed to run git: {err}"))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        message
    })
}

fn run_git_raw(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command(cwd)
        .args(args)
        .output()
        .map_err(|err| format!("failed to run git: {err}"))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        message
    })
}

fn run_git_with_input(cwd: &Path, args: &[&str], input: &str) -> Result<String, String> {
    let mut child = git_command(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to run git: {err}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|err| format!("failed to write git stdin: {err}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|err| format!("failed to wait for git: {err}"))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        message
    })
}

fn run_git_with_input_output(cwd: &Path, args: &[&str], input: &str) -> Result<String, String> {
    let mut child = git_command(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to run git: {err}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|err| format!("failed to write git stdin: {err}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|err| format!("failed to wait for git: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{stdout}\n{stderr}"),
    };

    if output.status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        Err(format!("git exited with status {}", output.status))
    } else {
        Err(combined)
    }
}

fn run_git_owned_bytes(cwd: &Path, args: Vec<String>) -> Result<Vec<u8>, String> {
    let output = git_command(cwd)
        .args(args)
        .output()
        .map_err(|err| format!("failed to run git: {err}"))?;

    if output.status.success() {
        return Ok(output.stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        message
    })
}

fn run_git_owned(cwd: &Path, args: Vec<String>) -> Result<String, String> {
    let output = git_command(cwd)
        .args(args)
        .output()
        .map_err(|err| format!("failed to run git: {err}"))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        message
    })
}

fn canonicalize_git_path(cwd: &Path, raw: &str, label: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    let absolute = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    fs::canonicalize(&absolute).map_err(|_| {
        format!(
            "{label} must resolve to an existing path: {}",
            display_path(&absolute)
        )
    })
}

fn canonicalize_existing_dir(input: &str, label: &str) -> Result<PathBuf, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(format!("{label} is required"));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path: {raw}"));
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|_| format!("{label} must be an existing directory: {raw}"))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|_| format!("{label} must be an existing directory: {raw}"))?;
    if !metadata.is_dir() {
        return Err(format!("{label} must be a directory: {raw}"));
    }
    Ok(canonical)
}

fn sanitize_path_component(input: &str, fallback: &str) -> String {
    let mut out = String::new();
    for ch in input.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let compact = out
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let trimmed = compact
        .trim_matches(|ch| ch == '-' || ch == '.')
        .to_string();
    let candidate = if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(80).collect()
    };
    avoid_windows_reserved_path_component(candidate)
}

fn is_windows_reserved_path_component(input: &str) -> bool {
    let stem = input
        .split('.')
        .next()
        .unwrap_or(input)
        .trim_matches(|ch| ch == ' ' || ch == '.')
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

fn avoid_windows_reserved_path_component(candidate: String) -> String {
    if !is_windows_reserved_path_component(&candidate) {
        return candidate;
    }
    if let Some(dot_index) = candidate.find('.') {
        return format!(
            "{}-item{}",
            &candidate[..dot_index],
            &candidate[dot_index..]
        );
    }
    format!("{candidate}-item")
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn unique_worktree_suffix() -> String {
    format!("{}-{}", unix_millis(), Uuid::new_v4().simple())
}

fn is_worktree_name_collision(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("reference already exists")
        || lower.contains("already exists")
        || lower.contains("already checked out")
        || lower.contains("is a missing but already registered worktree")
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn truncate_chars(input: String, max_chars: usize) -> (String, bool) {
    if input.chars().count() <= max_chars {
        return (input, false);
    }
    let truncated = input.chars().take(max_chars).collect::<String>();
    (format!("{truncated}\n... [truncated]"), true)
}

fn split_nul_paths(raw: &str) -> impl Iterator<Item = &str> {
    raw.split('\0').filter(|path| !path.is_empty())
}

fn validate_git_relative_path(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("empty git path".to_string());
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err(format!("git path must be relative: {raw}"));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(format!("git path contains unsafe component: {raw}")),
        }
    }
    Ok(raw.to_string())
}

fn should_ignore_apply_path(path: &str) -> bool {
    let file_name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    matches!(file_name, ".DS_Store" | "Thumbs.db" | "Desktop.ini")
}

fn collect_apply_paths(worktree_root: &Path) -> Result<Vec<String>, String> {
    let mut paths = BTreeSet::new();
    let tracked_raw = run_git_raw(
        worktree_root,
        &["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"],
    )?;
    let untracked_raw = run_git_raw(
        worktree_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;

    for raw in split_nul_paths(&tracked_raw).chain(split_nul_paths(&untracked_raw)) {
        if should_ignore_apply_path(raw) {
            continue;
        }
        paths.insert(validate_git_relative_path(raw)?);
    }

    Ok(paths.into_iter().collect())
}

fn collect_candidate_paths(
    worktree_root: &Path,
    base_revision: &str,
) -> Result<Vec<String>, String> {
    let mut paths = BTreeSet::new();
    let tracked_raw = run_git_raw(
        worktree_root,
        &[
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            base_revision,
            "--",
        ],
    )?;
    let untracked_raw = run_git_raw(
        worktree_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    for raw in split_nul_paths(&tracked_raw).chain(split_nul_paths(&untracked_raw)) {
        if should_ignore_apply_path(raw) {
            continue;
        }
        paths.insert(validate_git_relative_path(raw)?);
    }
    Ok(paths.into_iter().collect())
}

struct AllowedOutputMatcher {
    allow_all: bool,
    exact_or_directories: Vec<String>,
    globs: Vec<Regex>,
}

impl AllowedOutputMatcher {
    fn is_match(&self, path: &str) -> bool {
        self.allow_all
            || self
                .exact_or_directories
                .iter()
                .any(|allowed| path == allowed || path.starts_with(&format!("{allowed}/")))
            || self.globs.iter().any(|glob| glob.is_match(path))
    }
}

fn allowed_output_glob_regex(pattern: &str) -> Result<Regex, String> {
    let chars = pattern.chars().collect::<Vec<_>>();
    let mut source = String::from("^");
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        let next = chars.get(index + 1).copied();
        if current == '*' && next == Some('*') {
            if chars.get(index + 2) == Some(&'/') {
                source.push_str("(?:.*/)?");
                index += 3;
            } else {
                source.push_str(".*");
                index += 2;
            }
            continue;
        }
        if current == '*' {
            source.push_str("[^/]*");
        } else if current == '?' {
            source.push_str("[^/]");
        } else {
            source.push_str(&regex::escape(&current.to_string()));
        }
        index += 1;
    }
    source.push('$');
    Regex::new(&source).map_err(|error| format!("invalid allowed output glob {pattern}: {error}"))
}

fn build_allowed_output_matcher(patterns: &[String]) -> Result<AllowedOutputMatcher, String> {
    let mut globs = Vec::new();
    let mut exact_or_directories = Vec::new();
    let mut allow_all = patterns.is_empty();
    for raw in patterns {
        let pattern = raw.trim().replace('\\', "/");
        if pattern.is_empty() {
            return Err("allowed output path must not be empty".to_string());
        }
        if pattern == "." {
            allow_all = true;
            continue;
        }
        if pattern.starts_with('/') || pattern.contains(':') {
            return Err(format!("unsafe allowed output path: {raw}"));
        }
        validate_git_relative_path(&pattern)?;
        if pattern.contains('*') || pattern.contains('?') || pattern.contains('[') {
            globs.push(allowed_output_glob_regex(&pattern)?);
        } else {
            exact_or_directories.push(pattern);
        }
    }
    Ok(AllowedOutputMatcher {
        allow_all,
        exact_or_directories,
        globs,
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn finalize_sha256(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn compute_candidate_hash(
    worktree_root: &Path,
    base_revision: &str,
    changed_paths: &[String],
) -> Result<(String, u64, Option<String>), String> {
    let mut hasher = Sha256::new();
    hasher.update(b"arcforge-candidate-v1\0");
    hasher.update(base_revision.as_bytes());
    hasher.update([0]);

    if changed_paths.len() > MAX_CANDIDATE_FILES {
        hasher.update(format!("too-many-files:{}", changed_paths.len()).as_bytes());
        return Ok((
            finalize_sha256(hasher),
            0,
            Some(format!(
                "candidate has {} files; maximum is {MAX_CANDIDATE_FILES}",
                changed_paths.len()
            )),
        ));
    }

    let tracked_patch = run_git_raw(worktree_root, &["diff", "--binary", base_revision, "--"])?;
    hasher.update((tracked_patch.len() as u64).to_le_bytes());
    hasher.update(tracked_patch.as_bytes());

    let mut total_bytes = 0_u64;
    for raw_path in changed_paths {
        let path = validate_git_relative_path(raw_path)?;
        hasher.update((path.len() as u64).to_le_bytes());
        hasher.update(path.as_bytes());
        let candidate_path = worktree_root.join(&path);
        let metadata = match fs::symlink_metadata(&candidate_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let object = format!("{base_revision}:{path}");
                let existed_at_base = git_command(worktree_root)
                    .args(["cat-file", "-e", &object])
                    .status()
                    .map_err(|error| {
                        format!("failed to inspect deleted candidate path {path}: {error}")
                    })?
                    .success();
                if !existed_at_base {
                    return Err(format!(
                        "candidate path disappeared while it was being captured: {path}"
                    ));
                }
                hasher.update(b"\0deleted\0");
                continue;
            }
            Err(error) => {
                return Err(format!("failed to inspect candidate path {path}: {error}"));
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "candidate path must be a regular file and not a symlink: {path}"
            ));
        }
        #[cfg(unix)]
        let file_mode = metadata.permissions().mode() & 0o7777;
        #[cfg(not(unix))]
        let file_mode = if metadata.permissions().readonly() {
            0o444_u32
        } else {
            0o666_u32
        };
        hasher.update(b"\0regular\0");
        hasher.update(file_mode.to_le_bytes());
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > MAX_CANDIDATE_BYTES {
            hasher.update(format!("\0limit-exceeded:{total_bytes}\0").as_bytes());
            return Ok((
                finalize_sha256(hasher),
                total_bytes,
                Some(format!(
                    "candidate content exceeds the {} byte limit",
                    MAX_CANDIDATE_BYTES
                )),
            ));
        }
        let bytes = fs::read(&candidate_path)
            .map_err(|error| format!("failed to read candidate path {path}: {error}"))?;
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok((finalize_sha256(hasher), total_bytes, None))
}

fn validation_report_hash(
    run_spec_hash: &str,
    candidate_hash: &str,
    base_revision: &str,
    status: &str,
    checks: &[ValidationCheckResponse],
) -> String {
    let mut bytes = Vec::new();
    for value in [run_spec_hash, candidate_hash, base_revision, status] {
        bytes.extend_from_slice(&(value.len() as u64).to_le_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    for check in checks {
        for value in [check.id, check.status, check.summary.as_str()] {
            bytes.extend_from_slice(&(value.len() as u64).to_le_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
    }
    sha256_hex(&bytes)
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn collect_worktree_paths(cwd: &Path) -> Result<Vec<PathBuf>, String> {
    let raw = run_git_raw(cwd, &["worktree", "list", "--porcelain"])?;
    let mut paths = Vec::new();
    for line in raw.lines() {
        let Some(path) = line.strip_prefix("worktree ") else {
            continue;
        };
        let path = PathBuf::from(path.trim());
        if path.is_absolute() {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn is_arcforge_subagent_worktree(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name == ".arcforge-subagents",
        _ => false,
    })
}

fn normalize_arcforge_subagent_branch(branch_name: Option<&str>) -> Option<String> {
    let branch = branch_name?.trim();
    if branch.starts_with("arcforge/subagent/") {
        Some(branch.to_string())
    } else {
        None
    }
}

fn collect_nul_git_paths(cwd: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    let raw = run_git_raw(cwd, args)?;
    split_nul_paths(&raw)
        .map(validate_git_relative_path)
        .collect()
}

fn worktree_status_blocking(
    worktree_root: String,
    max_diff_chars: Option<usize>,
) -> Result<SubagentWorktreeStatusResponse, String> {
    let worktree_root = canonicalize_existing_dir(&worktree_root, "worktreeRoot")?;
    let max_diff_chars = max_diff_chars
        .unwrap_or(DEFAULT_MAX_DIFF_CHARS)
        .clamp(1_000, MAX_DIFF_CHARS);

    let status = run_git(
        &worktree_root,
        &[
            "-c",
            "core.quotePath=false",
            "status",
            "--short",
            "--untracked-files=all",
        ],
    )?;
    let diff_stat = run_git_raw(&worktree_root, &["diff", "HEAD", "--stat"])?;
    let diff_raw = run_git_raw(&worktree_root, &["diff", "HEAD", "--"])?;
    let (diff, diff_truncated) = truncate_chars(diff_raw, max_diff_chars);
    let untracked_files = collect_nul_git_paths(
        &worktree_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    let changed = !status.trim().is_empty();

    Ok(SubagentWorktreeStatusResponse {
        changed,
        status,
        diff_stat,
        diff,
        diff_truncated,
        untracked_files,
    })
}

fn validate_worktree_candidate_blocking(
    binding: BrokerValidationBinding,
    max_diff_chars: Option<usize>,
) -> Result<SubagentWorktreeValidateResponse, String> {
    let task_id = binding.task_id.trim().to_string();
    let run_id = binding.run_id.trim().to_string();
    let run_spec_hash = binding.run_spec_hash.trim().to_ascii_lowercase();
    let base_revision = binding.base_revision.trim().to_ascii_lowercase();
    if task_id.is_empty() || run_id.is_empty() {
        return Err("taskId and runId must not be empty".to_string());
    }
    if run_spec_hash.len() != 64 || !run_spec_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("runSpecHash must be a SHA-256 hex digest".to_string());
    }
    if !(base_revision.len() == 40 || base_revision.len() == 64)
        || !base_revision.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("broker baseRevision must be a full git object id".to_string());
    }

    let worktree_root =
        canonicalize_existing_dir(&display_path(&binding.worktree_root), "broker worktreeRoot")?;
    if worktree_root != binding.worktree_root {
        return Err("broker worktree binding is stale".to_string());
    }
    if !is_arcforge_subagent_worktree(&worktree_root) {
        return Err("worktreeRoot is not an ArcForge-owned task workspace".to_string());
    }

    let head_before = run_git(&worktree_root, &["rev-parse", "HEAD"])?.to_ascii_lowercase();
    let changed_paths = collect_candidate_paths(&worktree_root, &base_revision)?;
    let matcher = build_allowed_output_matcher(&binding.allowed_output_paths)?;
    let disallowed_paths = changed_paths
        .iter()
        .filter(|path| !matcher.is_match(path))
        .cloned()
        .collect::<Vec<_>>();
    let (candidate_hash, candidate_bytes, limit_error) =
        compute_candidate_hash(&worktree_root, &base_revision, &changed_paths)?;
    let status = {
        let max_diff_chars = max_diff_chars
            .unwrap_or(DEFAULT_MAX_DIFF_CHARS)
            .clamp(1_000, MAX_DIFF_CHARS);
        let status = run_git(
            &worktree_root,
            &[
                "-c",
                "core.quotePath=false",
                "status",
                "--short",
                "--untracked-files=all",
            ],
        )?;
        let diff_stat = run_git_raw(&worktree_root, &["diff", "--stat", &base_revision, "--"])?;
        let diff_raw = run_git_raw(&worktree_root, &["diff", &base_revision, "--"])?;
        let (diff, diff_truncated) = truncate_chars(diff_raw, max_diff_chars);
        let untracked_files = collect_nul_git_paths(
            &worktree_root,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )?;
        SubagentWorktreeStatusResponse {
            changed: !changed_paths.is_empty(),
            status,
            diff_stat,
            diff,
            diff_truncated,
            untracked_files,
        }
    };
    let diff_check = run_git(&worktree_root, &["diff", "--check", &base_revision, "--"]);

    // Capture twice around the human-readable status/diff collection. Any
    // concurrent commit, path addition/removal, content or mode drift makes
    // the attestation fail instead of silently describing a mixed snapshot.
    let head_after = run_git(&worktree_root, &["rev-parse", "HEAD"])?.to_ascii_lowercase();
    let rechecked_paths = collect_candidate_paths(&worktree_root, &base_revision)?;
    let (rechecked_hash, rechecked_bytes, rechecked_limit_error) =
        compute_candidate_hash(&worktree_root, &base_revision, &rechecked_paths)?;
    let candidate_stable = head_before == head_after
        && changed_paths == rechecked_paths
        && candidate_hash == rechecked_hash
        && candidate_bytes == rechecked_bytes
        && limit_error == rechecked_limit_error;

    let mut checks = Vec::new();
    if head_before == base_revision && head_after == base_revision {
        checks.push(ValidationCheckResponse {
            id: "base_revision",
            status: "passed",
            summary: format!("candidate is based on {base_revision}"),
        });
    } else {
        checks.push(ValidationCheckResponse {
            id: "base_revision",
            status: "failed",
            summary: format!(
                "worktree HEAD drifted from frozen base {base_revision} (before={head_before}, after={head_after})"
            ),
        });
    }

    if disallowed_paths.is_empty() {
        checks.push(ValidationCheckResponse {
            id: "candidate_paths",
            status: "passed",
            summary: format!("{} changed path(s) are within policy", changed_paths.len()),
        });
    } else {
        checks.push(ValidationCheckResponse {
            id: "candidate_paths",
            status: "failed",
            summary: format!(
                "changed path(s) outside policy: {}",
                disallowed_paths.join(", ")
            ),
        });
    }

    if let Some(error) = limit_error {
        checks.push(ValidationCheckResponse {
            id: "candidate_limits",
            status: "failed",
            summary: error,
        });
    } else {
        checks.push(ValidationCheckResponse {
            id: "candidate_limits",
            status: "passed",
            summary: format!(
                "{} file(s), {} content byte(s)",
                changed_paths.len(),
                candidate_bytes
            ),
        });
    }

    if candidate_stable {
        checks.push(ValidationCheckResponse {
            id: "candidate_stability",
            status: "passed",
            summary: "candidate paths, contents, modes and HEAD were stable across capture"
                .to_string(),
        });
    } else {
        checks.push(ValidationCheckResponse {
            id: "candidate_stability",
            status: "failed",
            summary: "candidate changed while the validator was capturing it".to_string(),
        });
    }

    match diff_check {
        Ok(_) => checks.push(ValidationCheckResponse {
            id: "git_diff_check",
            status: "passed",
            summary: "git diff --check passed".to_string(),
        }),
        Err(error) => checks.push(ValidationCheckResponse {
            id: "git_diff_check",
            status: "failed",
            summary: error,
        }),
    }

    let validation_status = if checks.iter().all(|check| check.status == "passed") {
        "passed"
    } else {
        "failed"
    };
    let created_at = unix_timestamp_millis();
    let report_hash = validation_report_hash(
        &run_spec_hash,
        &candidate_hash,
        &base_revision,
        validation_status,
        &checks,
    );

    Ok(SubagentWorktreeValidateResponse {
        candidate: CandidateBundleResponse {
            kind: "candidate_bundle",
            candidate_id: format!("{}:{}", binding.workspace_id, Uuid::new_v4()),
            task_id: task_id.clone(),
            run_id: run_id.clone(),
            run_spec_hash: run_spec_hash.clone(),
            candidate_hash: candidate_hash.clone(),
            base_revision: base_revision.clone(),
            changed_paths,
            status: status.status,
            diff_stat: status.diff_stat,
            diff: status.diff,
            diff_truncated: status.diff_truncated,
            untracked_files: status.untracked_files,
            created_at,
        },
        validation: ValidationReportResponse {
            kind: "validation_report",
            report_id: Uuid::new_v4().to_string(),
            report_hash,
            task_id,
            run_id,
            run_spec_hash,
            candidate_hash,
            base_revision,
            status: validation_status,
            scope: "structural",
            checks,
            test_status: "not_run",
            created_at,
        },
    })
}

fn stage_apply_paths(worktree_root: &Path, paths: &[String]) -> Result<(), String> {
    run_git(worktree_root, &["reset", "-q", "HEAD", "--"])?;
    if paths.is_empty() {
        return Ok(());
    }

    let mut args = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    run_git_owned(worktree_root, args)?;
    Ok(())
}

fn head_file_bytes(repo_root: &Path, rel_path: &str) -> Result<Option<Vec<u8>>, String> {
    let head_spec = format!("HEAD:{rel_path}");
    if run_git_owned(
        repo_root,
        vec!["cat-file".to_string(), "-e".to_string(), head_spec.clone()],
    )
    .is_err()
    {
        return Ok(None);
    }
    run_git_owned_bytes(repo_root, vec!["show".to_string(), head_spec]).map(Some)
}

enum FileCopyFallbackOp {
    Copy {
        rel_path: String,
        source: PathBuf,
        target: PathBuf,
    },
    Delete {
        rel_path: String,
        target: PathBuf,
    },
}

fn apply_file_copy_fallback(
    parent_repo_root: &Path,
    worktree_root: &Path,
    paths: &[String],
) -> Result<FileCopyFallbackResult, String> {
    let mut plan: Vec<FileCopyFallbackOp> = Vec::new();
    let mut conflicts = Vec::new();
    let mut already_applied_count = 0;

    for rel_path in paths {
        let rel_path = validate_git_relative_path(rel_path)?;
        let source = worktree_root.join(&rel_path);
        let target = parent_repo_root.join(&rel_path);

        if !source.exists() {
            let head_bytes = head_file_bytes(worktree_root, &rel_path)?;
            let Some(base_bytes) = head_bytes else {
                already_applied_count += 1;
                continue;
            };
            if !target.exists() {
                already_applied_count += 1;
                continue;
            }
            let target_meta = fs::symlink_metadata(&target)
                .map_err(|err| format!("failed to inspect fallback target {rel_path}: {err}"))?;
            if !target_meta.is_file() {
                conflicts.push(format!("{rel_path} (parent target is not a regular file)"));
                continue;
            }
            let target_bytes = fs::read(&target)
                .map_err(|err| format!("failed to read fallback target {rel_path}: {err}"))?;
            if target_bytes == base_bytes {
                plan.push(FileCopyFallbackOp::Delete { rel_path, target });
            } else {
                conflicts.push(format!("{rel_path} (parent file changed since HEAD)"));
            }
            continue;
        }

        let source_meta = fs::symlink_metadata(&source)
            .map_err(|err| format!("failed to inspect fallback source {rel_path}: {err}"))?;
        if !source_meta.is_file() {
            conflicts.push(format!("{rel_path} (non-file fallback is not supported)"));
            continue;
        }

        let source_bytes = fs::read(&source)
            .map_err(|err| format!("failed to read fallback source {rel_path}: {err}"))?;
        let head_bytes = head_file_bytes(worktree_root, &rel_path)?;

        if target.exists() {
            let target_meta = fs::symlink_metadata(&target)
                .map_err(|err| format!("failed to inspect fallback target {rel_path}: {err}"))?;
            if !target_meta.is_file() {
                conflicts.push(format!("{rel_path} (parent target is not a regular file)"));
                continue;
            }
            let target_bytes = fs::read(&target)
                .map_err(|err| format!("failed to read fallback target {rel_path}: {err}"))?;
            if target_bytes == source_bytes {
                already_applied_count += 1;
                continue;
            }
            match head_bytes {
                Some(base_bytes) if target_bytes == base_bytes => {
                    plan.push(FileCopyFallbackOp::Copy {
                        rel_path,
                        source,
                        target,
                    });
                }
                Some(_) => {
                    conflicts.push(format!("{rel_path} (parent file changed since HEAD)"));
                }
                None => {
                    conflicts.push(format!("{rel_path} (parent already has an untracked file)"));
                }
            }
        } else if head_bytes.is_some() {
            conflicts.push(format!(
                "{rel_path} (parent file is missing but exists in HEAD)"
            ));
        } else {
            plan.push(FileCopyFallbackOp::Copy {
                rel_path,
                source,
                target,
            });
        }
    }

    if !conflicts.is_empty() {
        return Err(conflicts.join("\n"));
    }

    let mut copied_files = Vec::new();
    let mut deleted_files = Vec::new();
    for operation in plan {
        match operation {
            FileCopyFallbackOp::Copy {
                rel_path,
                source,
                target,
            } => {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|err| {
                        format!("failed to create fallback target directory: {err}")
                    })?;
                }
                fs::copy(&source, &target)
                    .map_err(|err| format!("failed to copy fallback file {rel_path}: {err}"))?;
                copied_files.push(rel_path);
            }
            FileCopyFallbackOp::Delete { rel_path, target } => {
                fs::remove_file(&target)
                    .map_err(|err| format!("failed to delete fallback file {rel_path}: {err}"))?;
                deleted_files.push(rel_path);
            }
        }
    }

    Ok(FileCopyFallbackResult {
        copied_files,
        deleted_files,
        conflict_files: Vec::new(),
        already_applied_count,
    })
}

fn run_git_apply_with_options(cwd: &Path, patch: &str, options: &[&str]) -> Result<(), String> {
    let mut check_args = vec!["apply", "--check", "--whitespace=nowarn", "--binary"];
    check_args.extend(options.iter().copied());
    let mut apply_args = vec!["apply", "--whitespace=nowarn", "--binary"];
    apply_args.extend(options.iter().copied());
    run_git_with_input(cwd, &check_args, patch)
        .and_then(|_| run_git_with_input(cwd, &apply_args, patch))
        .map(|_| ())
}

fn run_git_apply_3way(cwd: &Path, patch: &str) -> Result<(), String> {
    let check_output = run_git_with_input_output(
        cwd,
        &[
            "apply",
            "--check",
            "--whitespace=nowarn",
            "--binary",
            "--3way",
        ],
        patch,
    )?;
    if check_output.to_ascii_lowercase().contains("with conflicts") {
        return Err(format!(
            "git apply --3way would leave conflicts:\n{check_output}"
        ));
    }
    run_git_with_input(
        cwd,
        &["apply", "--whitespace=nowarn", "--binary", "--3way"],
        patch,
    )
    .map(|_| ())
}

fn apply_worktree_changes_blocking(
    parent_workdir: String,
    worktree_root: String,
) -> Result<SubagentWorktreeApplyResponse, String> {
    let parent_workdir = canonicalize_existing_dir(&parent_workdir, "parentWorkdir")?;
    let worktree_root = canonicalize_existing_dir(&worktree_root, "worktreeRoot")?;

    let parent_repo_root_raw = run_git(&parent_workdir, &["rev-parse", "--show-toplevel"])?;
    let parent_repo_root =
        canonicalize_existing_dir(&parent_repo_root_raw, "parent git repo root")?;

    let parent_common_raw = run_git(&parent_workdir, &["rev-parse", "--git-common-dir"])?;
    let worktree_common_raw = run_git(&worktree_root, &["rev-parse", "--git-common-dir"])?;
    let parent_common =
        canonicalize_git_path(&parent_workdir, &parent_common_raw, "parent git common dir")?;
    let worktree_common = canonicalize_git_path(
        &worktree_root,
        &worktree_common_raw,
        "worktree git common dir",
    )?;
    if parent_common != worktree_common {
        return Err(
            "worktreeRoot does not belong to the same git repository as parentWorkdir".to_string(),
        );
    }

    let status = run_git(&worktree_root, &["status", "--short"])?;
    if status.trim().is_empty() {
        return Ok(SubagentWorktreeApplyResponse {
            applied: false,
            changed: false,
            status,
            patch_bytes: 0,
            skipped_reason: Some("no_changes".to_string()),
            apply_method: None,
            fallback_reason: None,
            copied_files: Vec::new(),
            deleted_files: Vec::new(),
            conflict_files: Vec::new(),
        });
    }

    let apply_paths = collect_apply_paths(&worktree_root)?;
    if apply_paths.is_empty() {
        return Ok(SubagentWorktreeApplyResponse {
            applied: false,
            changed: true,
            status,
            patch_bytes: 0,
            skipped_reason: Some("no_applyable_changes".to_string()),
            apply_method: None,
            fallback_reason: None,
            copied_files: Vec::new(),
            deleted_files: Vec::new(),
            conflict_files: Vec::new(),
        });
    }

    stage_apply_paths(&worktree_root, &apply_paths)?;
    let patch = run_git_raw(
        &worktree_root,
        &["diff", "--cached", "--binary", "HEAD", "--"],
    )?;
    let patch_bytes = patch.as_bytes().len();
    if patch.trim().is_empty() {
        return Ok(SubagentWorktreeApplyResponse {
            applied: false,
            changed: true,
            status,
            patch_bytes,
            skipped_reason: Some("empty_patch".to_string()),
            apply_method: None,
            fallback_reason: None,
            copied_files: Vec::new(),
            deleted_files: Vec::new(),
            conflict_files: Vec::new(),
        });
    }

    let direct_apply_result = run_git_apply_with_options(&parent_repo_root, &patch, &[]);

    match direct_apply_result {
        Ok(_) => Ok(SubagentWorktreeApplyResponse {
            applied: true,
            changed: true,
            status,
            patch_bytes,
            skipped_reason: None,
            apply_method: Some("git_apply".to_string()),
            fallback_reason: None,
            copied_files: Vec::new(),
            deleted_files: Vec::new(),
            conflict_files: Vec::new(),
        }),
        Err(apply_error) => {
            let three_way_apply_result = run_git_apply_3way(&parent_repo_root, &patch);
            if three_way_apply_result.is_ok() {
                return Ok(SubagentWorktreeApplyResponse {
                    applied: true,
                    changed: true,
                    status,
                    patch_bytes,
                    skipped_reason: None,
                    apply_method: Some("git_apply_3way".to_string()),
                    fallback_reason: Some(apply_error),
                    copied_files: Vec::new(),
                    deleted_files: Vec::new(),
                    conflict_files: Vec::new(),
                });
            }
            let three_way_error = three_way_apply_result
                .err()
                .unwrap_or_else(|| "unknown 3-way apply failure".to_string());
            let fallback = apply_file_copy_fallback(
                &parent_repo_root,
                &worktree_root,
                &apply_paths,
            )
            .map_err(|fallback_error| {
                format!(
                    "git apply failed: {apply_error}; git apply --3way failed: {three_way_error}; file copy fallback failed:\n{fallback_error}"
                )
            })?;
            let copied_or_deleted =
                !fallback.copied_files.is_empty() || !fallback.deleted_files.is_empty();
            Ok(SubagentWorktreeApplyResponse {
                applied: copied_or_deleted,
                changed: true,
                status,
                patch_bytes,
                skipped_reason: if copied_or_deleted {
                    None
                } else if fallback.already_applied_count > 0 {
                    Some("already_applied".to_string())
                } else {
                    Some("fallback_noop".to_string())
                },
                apply_method: Some("file_copy_fallback".to_string()),
                fallback_reason: Some(format!(
                    "git apply failed: {apply_error}; git apply --3way failed: {three_way_error}"
                )),
                copied_files: fallback.copied_files,
                deleted_files: fallback.deleted_files,
                conflict_files: fallback.conflict_files,
            })
        }
    }
}

fn cleanup_worktree_target_blocking(
    target: SubagentWorktreeCleanupTarget,
    dry_run: bool,
    force: bool,
    delete_branch: bool,
) -> SubagentWorktreeCleanupItem {
    let worktree_root_text = target.worktree_root.trim().to_string();
    let branch_name = target
        .branch_name
        .as_deref()
        .map(str::trim)
        .and_then(|branch| {
            if branch.is_empty() {
                None
            } else {
                Some(branch.to_string())
            }
        });
    let run_id = target.run_id.as_deref().map(str::trim).and_then(|run_id| {
        if run_id.is_empty() {
            None
        } else {
            Some(run_id.to_string())
        }
    });

    let mut item = SubagentWorktreeCleanupItem {
        run_id,
        worktree_root: worktree_root_text.clone(),
        branch_name: branch_name.clone(),
        removed: false,
        branch_deleted: false,
        skipped_reason: None,
        error: None,
    };

    if worktree_root_text.is_empty() {
        item.error = Some("worktreeRoot is required".to_string());
        return item;
    }

    let raw_path = PathBuf::from(&worktree_root_text);
    if !raw_path.is_absolute() {
        item.error = Some(format!(
            "worktreeRoot must be an absolute path: {worktree_root_text}"
        ));
        return item;
    }
    if !raw_path.exists() {
        item.skipped_reason = Some("missing_worktree".to_string());
        return item;
    }

    let worktree_root = match fs::canonicalize(&raw_path) {
        Ok(path) => path,
        Err(err) => {
            item.error = Some(format!("failed to canonicalize worktreeRoot: {err}"));
            return item;
        }
    };
    if !is_arcforge_subagent_worktree(&worktree_root) {
        item.error = Some(format!(
            "refusing to cleanup non-ArcForge subagent worktree: {}",
            display_path(&worktree_root)
        ));
        return item;
    }
    if dry_run {
        item.skipped_reason = Some("dry_run".to_string());
        return item;
    }

    let repo_cwd = collect_worktree_paths(&worktree_root)
        .ok()
        .and_then(|paths| {
            paths.into_iter().find(|candidate| {
                fs::canonicalize(candidate)
                    .map(|canonical| canonical != worktree_root)
                    .unwrap_or(false)
            })
        });

    let mut remove_args = vec!["worktree".to_string(), "remove".to_string()];
    if force {
        remove_args.push("--force".to_string());
    }
    remove_args.push(display_path(&worktree_root));

    match run_git_owned(&worktree_root, remove_args) {
        Ok(_) => {
            item.removed = true;
        }
        Err(git_error) => {
            if !force {
                item.error = Some(format!("git worktree remove failed: {git_error}"));
                return item;
            }
            if worktree_root.exists() {
                match fs::remove_dir_all(&worktree_root) {
                    Ok(_) => {
                        item.removed = true;
                        item.skipped_reason = Some("git_remove_failed_removed_dir".to_string());
                    }
                    Err(remove_err) => {
                        item.error = Some(format!(
                            "git worktree remove failed: {git_error}; remove_dir_all failed: {remove_err}"
                        ));
                        return item;
                    }
                }
            } else {
                item.removed = true;
            }
        }
    }

    if delete_branch {
        if let Some(branch) = normalize_arcforge_subagent_branch(branch_name.as_deref()) {
            if let Some(repo_cwd) = repo_cwd {
                match run_git_owned(
                    &repo_cwd,
                    vec!["branch".to_string(), "-D".to_string(), branch.clone()],
                ) {
                    Ok(_) => {
                        item.branch_deleted = true;
                    }
                    Err(err) => {
                        let lower = err.to_ascii_lowercase();
                        if lower.contains("not found") {
                            item.skipped_reason
                                .get_or_insert_with(|| "branch_delete_skipped".to_string());
                        } else if lower.contains("checked out") {
                            item.skipped_reason
                                .get_or_insert_with(|| "branch_delete_checked_out".to_string());
                        } else {
                            item.error = Some(format!(
                                "worktree removed, but branch delete failed for {branch}: {err}"
                            ));
                        }
                    }
                }
            } else {
                item.skipped_reason
                    .get_or_insert_with(|| "branch_delete_no_repo_worktree".to_string());
            }
        } else if branch_name.is_some() {
            item.skipped_reason
                .get_or_insert_with(|| "branch_delete_not_arcforge_branch".to_string());
        }
    }

    item
}

pub(crate) fn cleanup_worktree_targets_blocking(
    targets: Vec<SubagentWorktreeCleanupTarget>,
    dry_run: bool,
    force: bool,
    delete_branch: bool,
) -> SubagentWorktreeCleanupBatchResponse {
    let items = targets
        .into_iter()
        .map(|target| cleanup_worktree_target_blocking(target, dry_run, force, delete_branch))
        .collect::<Vec<_>>();
    let cleaned_count = items.iter().filter(|item| item.removed).count();
    let branch_deleted_count = items.iter().filter(|item| item.branch_deleted).count();
    let skipped_count = items
        .iter()
        .filter(|item| item.skipped_reason.is_some() && item.error.is_none())
        .count();
    let failed_count = items.iter().filter(|item| item.error.is_some()).count();
    SubagentWorktreeCleanupBatchResponse {
        cleaned_count,
        branch_deleted_count,
        skipped_count,
        failed_count,
        items,
    }
}

#[tauri::command]
pub async fn subagent_worktree_create(
    state: State<'_, ExecutionBrokerState>,
    input: SubagentWorktreeCreateInput,
) -> Result<SubagentWorktreeCreateResponse, String> {
    let mut response = tauri::async_runtime::spawn_blocking(move || {
        let SubagentWorktreeCreateInput { workdir, label } = input;
        let requested_workdir = canonicalize_existing_dir(&workdir, "workdir")?;
        let repo_root_raw = run_git(&requested_workdir, &["rev-parse", "--show-toplevel"])?;
        let repo_root = canonicalize_existing_dir(&repo_root_raw, "git repo root")?;
        let relative_workdir = requested_workdir
            .strip_prefix(&repo_root)
            .map_err(|_| "workdir must be inside the git repository root".to_string())?;

        let repo_name = repo_root
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| sanitize_path_component(name, "repo"))
            .unwrap_or_else(|| "repo".to_string());
        let label = sanitize_path_component(label.as_deref().unwrap_or("agent"), "agent");
        let target_parent = repo_root
            .parent()
            .unwrap_or_else(|| repo_root.as_path())
            .join(".arcforge-subagents")
            .join(&repo_name);
        fs::create_dir_all(&target_parent)
            .map_err(|err| format!("failed to create worktree parent: {err}"))?;

        let mut last_error: Option<String> = None;
        let (target, branch_name) = {
            let mut created: Option<(PathBuf, String)> = None;
            for _ in 0..CREATE_WORKTREE_MAX_ATTEMPTS {
                let suffix = unique_worktree_suffix();
                let target = target_parent.join(format!("{label}-{suffix}"));
                let branch_name = format!("arcforge/subagent/{label}-{suffix}");
                match run_git_owned(
                    &repo_root,
                    vec![
                        "worktree".to_string(),
                        "add".to_string(),
                        "-b".to_string(),
                        branch_name.clone(),
                        display_path(&target),
                        "HEAD".to_string(),
                    ],
                ) {
                    Ok(_) => {
                        created = Some((target, branch_name));
                        break;
                    }
                    Err(err) if is_worktree_name_collision(&err) => {
                        last_error = Some(err);
                    }
                    Err(err) => return Err(err),
                }
            }
            created.ok_or_else(|| {
                format!(
                    "failed to create a unique delegated worktree after {CREATE_WORKTREE_MAX_ATTEMPTS} attempts: {}",
                    last_error.unwrap_or_else(|| "unknown git worktree error".to_string())
                )
            })?
        };

        let worktree_root = fs::canonicalize(&target)
            .map_err(|err| format!("failed to canonicalize worktree: {err}"))?;
        let child_workdir = worktree_root.join(relative_workdir);
        let child_metadata = fs::metadata(&child_workdir).map_err(|_| {
            format!(
                "worktree workdir does not exist: {}",
                display_path(&child_workdir)
            )
        })?;
        if !child_metadata.is_dir() {
            return Err(format!(
                "worktree workdir is not a directory: {}",
                display_path(&child_workdir)
            ));
        }
        let base_revision = run_git(&worktree_root, &["rev-parse", "HEAD"])?;

        Ok(SubagentWorktreeCreateResponse {
            workspace_id: String::new(),
            repo_root: display_path(&repo_root),
            worktree_root: display_path(&worktree_root),
            workdir: display_path(&child_workdir),
            branch_name,
            base_revision,
            parent_workdir: display_path(&requested_workdir),
        })
    })
    .await
    .map_err(|err| format!("subagent_worktree_create join failed: {err}"))??;
    response.workspace_id = state.register_task_workspace(
        Path::new(&response.parent_workdir),
        Path::new(&response.worktree_root),
        Path::new(&response.workdir),
        &response.base_revision,
    )?;
    Ok(response)
}

#[tauri::command]
pub async fn subagent_worktree_status(
    input: SubagentWorktreeStatusInput,
) -> Result<SubagentWorktreeStatusResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        worktree_status_blocking(input.worktree_root, input.max_diff_chars)
    })
    .await
    .map_err(|err| format!("subagent_worktree_status join failed: {err}"))?
}

#[tauri::command]
pub async fn subagent_worktree_validate(
    state: State<'_, ExecutionBrokerState>,
    input: SubagentWorktreeValidateInput,
) -> Result<SubagentWorktreeValidateResponse, String> {
    let binding = state.validation_binding(&input.run_id, &input.run_spec_hash)?;
    tauri::async_runtime::spawn_blocking(move || {
        validate_worktree_candidate_blocking(binding, input.max_diff_chars)
    })
    .await
    .map_err(|err| format!("subagent_worktree_validate join failed: {err}"))?
}

#[tauri::command]
pub async fn subagent_worktree_apply(
    input: SubagentWorktreeApplyInput,
) -> Result<SubagentWorktreeApplyResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        apply_worktree_changes_blocking(input.parent_workdir, input.worktree_root)
    })
    .await
    .map_err(|err| format!("subagent_worktree_apply join failed: {err}"))?
}

#[tauri::command]
pub async fn subagent_worktree_cleanup(
    input: SubagentWorktreeCleanupInput,
) -> Result<SubagentWorktreeCleanupItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cleanup_worktree_target_blocking(
            SubagentWorktreeCleanupTarget {
                run_id: None,
                worktree_root: input.worktree_root,
                branch_name: input.branch_name,
            },
            input.dry_run.unwrap_or(false),
            input.force.unwrap_or(true),
            input.delete_branch.unwrap_or(true),
        )
    })
    .await
    .map_err(|err| format!("subagent_worktree_cleanup join failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "arcforge-subagent-worktree-{label}-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ))
    }

    fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
        run_git_owned(cwd, args.iter().map(|arg| (*arg).to_string()).collect())
    }

    fn init_repo(root: &Path) -> Result<(), String> {
        fs::create_dir_all(root).map_err(|err| format!("failed to create repo: {err}"))?;
        git(root, &["init"])?;
        git(root, &["config", "core.autocrlf", "false"])?;
        git(root, &["config", "user.email", "arcforge-test@example.com"])?;
        git(root, &["config", "user.name", "ArcForge Test"])?;
        fs::write(root.join("README.md"), "base\n")
            .map_err(|err| format!("failed to write README: {err}"))?;
        git(root, &["add", "README.md"])?;
        git(root, &["commit", "-m", "init"])?;
        Ok(())
    }

    #[test]
    fn sanitize_path_component_avoids_windows_reserved_names() {
        assert_eq!(sanitize_path_component("repo name", "repo"), "repo-name");
        assert_eq!(sanitize_path_component("CON", "repo"), "CON-item");
        assert_eq!(sanitize_path_component("aux.txt", "repo"), "aux-item.txt");
        assert_eq!(sanitize_path_component("LPT9", "repo"), "LPT9-item");
        assert_eq!(sanitize_path_component("COM0", "repo"), "COM0");
    }

    fn add_worktree(repo: &Path, worktree: &Path) -> Result<(), String> {
        let branch = format!("arcforge-test-{}", Uuid::new_v4().simple());
        add_worktree_with_branch(repo, worktree, &branch)
    }

    fn add_worktree_with_branch(repo: &Path, worktree: &Path, branch: &str) -> Result<(), String> {
        if let Some(parent) = worktree.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create worktree parent: {err}"))?;
        }
        run_git_owned(
            repo,
            vec![
                "worktree".to_string(),
                "add".to_string(),
                "-b".to_string(),
                branch.to_string(),
                display_path(worktree),
                "HEAD".to_string(),
            ],
        )?;
        Ok(())
    }

    fn validation_binding(
        worktree: &Path,
        base_revision: String,
        allowed_output_paths: Vec<String>,
    ) -> BrokerValidationBinding {
        BrokerValidationBinding {
            task_id: "task-1".to_string(),
            run_id: "run-1".to_string(),
            run_spec_hash: "a".repeat(64),
            workspace_id: "workspace-1".to_string(),
            worktree_root: fs::canonicalize(worktree).expect("canonical worktree"),
            base_revision,
            allowed_output_paths,
        }
    }

    #[test]
    fn subagent_worktree_validation_hashes_tracked_and_untracked_content() -> Result<(), String> {
        let root = temp_root("validate-candidate");
        let repo = root.join("repo");
        let worktree = root
            .join(".arcforge-subagents")
            .join("repo")
            .join("candidate");
        init_repo(&repo)?;
        add_worktree(&repo, &worktree)?;
        let base_revision = git(&worktree, &["rev-parse", "HEAD"])?;
        fs::write(worktree.join("README.md"), "changed\n")
            .map_err(|error| format!("failed to change tracked file: {error}"))?;
        fs::create_dir_all(worktree.join("src"))
            .map_err(|error| format!("failed to create src: {error}"))?;
        fs::write(worktree.join("src/new.txt"), b"new\0binary\n")
            .map_err(|error| format!("failed to write untracked file: {error}"))?;

        let first = validate_worktree_candidate_blocking(
            validation_binding(&worktree, base_revision.clone(), Vec::new()),
            Some(20_000),
        )?;
        assert_eq!(first.validation.status, "passed");
        assert_eq!(first.validation.test_status, "not_run");
        assert_eq!(
            first.candidate.changed_paths,
            vec!["README.md".to_string(), "src/new.txt".to_string()]
        );
        assert_eq!(first.candidate.candidate_hash.len(), 64);

        fs::write(worktree.join("src/new.txt"), b"different\0binary\n")
            .map_err(|error| format!("failed to update untracked file: {error}"))?;
        let second = validate_worktree_candidate_blocking(
            validation_binding(&worktree, base_revision, Vec::new()),
            Some(20_000),
        )?;
        assert_ne!(
            first.candidate.candidate_hash,
            second.candidate.candidate_hash
        );

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_validation_fails_closed_on_path_policy_mismatch() -> Result<(), String> {
        let root = temp_root("validate-path-policy");
        let repo = root.join("repo");
        let worktree = root
            .join(".arcforge-subagents")
            .join("repo")
            .join("candidate");
        init_repo(&repo)?;
        add_worktree(&repo, &worktree)?;
        let base_revision = git(&worktree, &["rev-parse", "HEAD"])?;
        fs::write(worktree.join("README.md"), "changed\n")
            .map_err(|error| format!("failed to change tracked file: {error}"))?;

        let result = validate_worktree_candidate_blocking(
            validation_binding(&worktree, base_revision, vec!["src/**".to_string()]),
            Some(20_000),
        )?;
        assert_eq!(result.validation.status, "failed");
        assert!(result
            .validation
            .checks
            .iter()
            .any(|check| check.id == "candidate_paths" && check.status == "failed"));

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn allowed_output_globs_do_not_let_single_star_cross_directories() -> Result<(), String> {
        let matcher = build_allowed_output_matcher(&["src/*.ts".to_string()])?;
        assert!(matcher.is_match("src/app.ts"));
        assert!(!matcher.is_match("src/nested/app.ts"));

        let recursive = build_allowed_output_matcher(&["src/**".to_string()])?;
        assert!(recursive.is_match("src/nested/app.ts"));

        let literal_brackets = build_allowed_output_matcher(&["src/[draft].ts".to_string()])?;
        assert!(literal_brackets.is_match("src/[draft].ts"));
        assert!(!literal_brackets.is_match("src/d.ts"));
        Ok(())
    }

    #[test]
    fn validation_anchors_diff_to_broker_base_when_worktree_head_drifted() -> Result<(), String> {
        let root = temp_root("validate-base-drift");
        let repo = root.join("repo");
        let worktree = root
            .join(".arcforge-subagents")
            .join("repo")
            .join("candidate");
        init_repo(&repo)?;
        add_worktree(&repo, &worktree)?;
        let base_revision = git(&worktree, &["rev-parse", "HEAD"])?;
        fs::write(worktree.join("README.md"), "committed by candidate\n")
            .map_err(|error| format!("failed to change tracked file: {error}"))?;
        git(&worktree, &["add", "README.md"])?;
        git(&worktree, &["commit", "-m", "candidate commit"])?;

        let result = validate_worktree_candidate_blocking(
            validation_binding(&worktree, base_revision, Vec::new()),
            Some(20_000),
        )?;
        assert_eq!(result.validation.status, "failed");
        assert_eq!(
            result.candidate.changed_paths,
            vec!["README.md".to_string()]
        );
        assert!(result
            .validation
            .checks
            .iter()
            .any(|check| check.id == "base_revision" && check.status == "failed"));

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn candidate_hash_covers_both_sides_of_rename_and_deletion() -> Result<(), String> {
        let root = temp_root("validate-rename-delete");
        let repo = root.join("repo");
        let worktree = root
            .join(".arcforge-subagents")
            .join("repo")
            .join("candidate");
        init_repo(&repo)?;
        add_worktree(&repo, &worktree)?;
        let base_revision = git(&worktree, &["rev-parse", "HEAD"])?;
        fs::rename(worktree.join("README.md"), worktree.join("NOTES.md"))
            .map_err(|error| format!("failed to rename tracked file: {error}"))?;

        let renamed = validate_worktree_candidate_blocking(
            validation_binding(&worktree, base_revision.clone(), Vec::new()),
            Some(20_000),
        )?;
        assert_eq!(
            renamed.candidate.changed_paths,
            vec!["NOTES.md".to_string(), "README.md".to_string()]
        );

        fs::remove_file(worktree.join("NOTES.md"))
            .map_err(|error| format!("failed to delete renamed file: {error}"))?;
        let deleted = validate_worktree_candidate_blocking(
            validation_binding(&worktree, base_revision, Vec::new()),
            Some(20_000),
        )?;
        assert_eq!(
            deleted.candidate.changed_paths,
            vec!["README.md".to_string()]
        );
        assert_ne!(
            renamed.candidate.candidate_hash,
            deleted.candidate.candidate_hash
        );

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn validation_rejects_dangling_symlink_candidates() -> Result<(), String> {
        let root = temp_root("validate-dangling-symlink");
        let repo = root.join("repo");
        let worktree = root
            .join(".arcforge-subagents")
            .join("repo")
            .join("candidate");
        init_repo(&repo)?;
        add_worktree(&repo, &worktree)?;
        let base_revision = git(&worktree, &["rev-parse", "HEAD"])?;
        std::os::unix::fs::symlink("missing-target", worktree.join("dangling"))
            .map_err(|error| format!("failed to create dangling symlink: {error}"))?;

        let error = validate_worktree_candidate_blocking(
            validation_binding(&worktree, base_revision, Vec::new()),
            Some(20_000),
        )
        .expect_err("dangling symlink must be rejected");
        assert!(error.contains("not a symlink"));

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_apply_preserves_patch_trailing_newline() -> Result<(), String> {
        let root = temp_root("patch-new-file");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        add_worktree(&repo, &worktree)?;

        fs::create_dir_all(worktree.join("test"))
            .map_err(|err| format!("failed to create test dir: {err}"))?;
        fs::write(
            worktree.join("test/agent.md"),
            "# Agent CRUD Test\n\n- status: done\n",
        )
        .map_err(|err| format!("failed to write worktree file: {err}"))?;

        let result = apply_worktree_changes_blocking(display_path(&repo), display_path(&worktree))?;
        assert!(result.applied);
        assert_eq!(result.apply_method.as_deref(), Some("git_apply"));
        assert_eq!(
            fs::read_to_string(repo.join("test/agent.md"))
                .map_err(|err| format!("failed to read parent file: {err}"))?,
            "# Agent CRUD Test\n\n- status: done\n"
        );

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_apply_falls_back_when_file_is_already_present() -> Result<(), String> {
        let root = temp_root("fallback-already-present");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        add_worktree(&repo, &worktree)?;

        let content = "# Agent CRUD Test\n\n- status: done\n";
        fs::create_dir_all(worktree.join("test"))
            .map_err(|err| format!("failed to create worktree test dir: {err}"))?;
        fs::write(worktree.join("test/agent.md"), content)
            .map_err(|err| format!("failed to write worktree file: {err}"))?;
        fs::create_dir_all(repo.join("test"))
            .map_err(|err| format!("failed to create parent test dir: {err}"))?;
        fs::write(repo.join("test/agent.md"), content)
            .map_err(|err| format!("failed to write parent file: {err}"))?;

        let result = apply_worktree_changes_blocking(display_path(&repo), display_path(&worktree))?;
        assert!(!result.applied);
        assert_eq!(result.apply_method.as_deref(), Some("file_copy_fallback"));
        assert_eq!(result.skipped_reason.as_deref(), Some("already_applied"));
        assert!(result.copied_files.is_empty());
        assert!(result
            .fallback_reason
            .as_deref()
            .unwrap_or("")
            .contains("already exists"));

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_apply_applies_deleted_files() -> Result<(), String> {
        let root = temp_root("apply-delete");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        fs::write(repo.join("obsolete.md"), "delete me\n")
            .map_err(|err| format!("failed to write tracked file: {err}"))?;
        git(&repo, &["add", "obsolete.md"])?;
        git(&repo, &["commit", "-m", "add obsolete"])?;
        add_worktree(&repo, &worktree)?;

        fs::remove_file(worktree.join("obsolete.md"))
            .map_err(|err| format!("failed to delete worktree file: {err}"))?;

        let result = apply_worktree_changes_blocking(display_path(&repo), display_path(&worktree))?;
        assert!(result.applied);
        assert!(!repo.join("obsolete.md").exists());

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_apply_applies_renamed_files() -> Result<(), String> {
        let root = temp_root("apply-rename");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        fs::create_dir_all(repo.join("docs"))
            .map_err(|err| format!("failed to create docs dir: {err}"))?;
        fs::write(repo.join("docs/old.md"), "rename me\n")
            .map_err(|err| format!("failed to write old file: {err}"))?;
        git(&repo, &["add", "docs/old.md"])?;
        git(&repo, &["commit", "-m", "add old doc"])?;
        add_worktree(&repo, &worktree)?;

        fs::rename(worktree.join("docs/old.md"), worktree.join("docs/new.md"))
            .map_err(|err| format!("failed to rename worktree file: {err}"))?;

        let result = apply_worktree_changes_blocking(display_path(&repo), display_path(&worktree))?;
        assert!(result.applied);
        assert!(!repo.join("docs/old.md").exists());
        assert_eq!(
            fs::read_to_string(repo.join("docs/new.md"))
                .map_err(|err| format!("failed to read renamed file: {err}"))?,
            "rename me\n"
        );

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_apply_does_not_overwrite_parent_head_after_3way_conflict(
    ) -> Result<(), String> {
        let root = temp_root("apply-3way-conflict");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        fs::write(repo.join("file.txt"), "line1\nline2\nline3\n")
            .map_err(|err| format!("failed to write base file: {err}"))?;
        git(&repo, &["add", "file.txt"])?;
        git(&repo, &["commit", "-m", "add file"])?;
        add_worktree(&repo, &worktree)?;

        fs::write(worktree.join("file.txt"), "line1\nagent-line2\nline3\n")
            .map_err(|err| format!("failed to write worktree file: {err}"))?;
        fs::write(repo.join("file.txt"), "parent-line1\nline2\nline3\n")
            .map_err(|err| format!("failed to write parent file: {err}"))?;
        git(&repo, &["add", "file.txt"])?;
        git(&repo, &["commit", "-m", "parent update"])?;

        let error = apply_worktree_changes_blocking(display_path(&repo), display_path(&worktree))
            .expect_err("conflicting 3-way apply should fail");
        assert!(error.contains("git apply --3way failed"));
        assert_eq!(
            fs::read_to_string(repo.join("file.txt"))
                .map_err(|err| format!("failed to read parent file: {err}"))?,
            "parent-line1\nline2\nline3\n"
        );

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_cleanup_removes_arcforge_worktree_and_branch() -> Result<(), String> {
        let root = temp_root("cleanup-worktree");
        let repo = root.join("repo");
        let worktree = root
            .join(".arcforge-subagents")
            .join("repo")
            .join("agent-a");
        let branch = "arcforge/subagent/test-cleanup";
        init_repo(&repo)?;
        add_worktree_with_branch(&repo, &worktree, branch)?;

        let result = cleanup_worktree_target_blocking(
            SubagentWorktreeCleanupTarget {
                run_id: Some("run-cleanup".to_string()),
                worktree_root: display_path(&worktree),
                branch_name: Some(branch.to_string()),
            },
            false,
            true,
            true,
        );

        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(result.removed);
        assert!(result.branch_deleted);
        assert!(!worktree.exists());
        let branch_list = git(&repo, &["branch", "--list", branch])?;
        assert!(branch_list.trim().is_empty());

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_cleanup_respects_force_false() -> Result<(), String> {
        let root = temp_root("cleanup-worktree-no-force");
        let repo = root.join("repo");
        let worktree = root
            .join(".arcforge-subagents")
            .join("repo")
            .join("agent-dirty");
        let branch = "arcforge/subagent/test-cleanup-no-force";
        init_repo(&repo)?;
        add_worktree_with_branch(&repo, &worktree, branch)?;
        fs::write(worktree.join("README.md"), "dirty\n")
            .map_err(|err| format!("failed to dirty worktree file: {err}"))?;

        let result = cleanup_worktree_target_blocking(
            SubagentWorktreeCleanupTarget {
                run_id: Some("run-cleanup-no-force".to_string()),
                worktree_root: display_path(&worktree),
                branch_name: Some(branch.to_string()),
            },
            false,
            false,
            true,
        );

        assert!(result.error.is_some(), "{result:?}");
        assert!(!result.removed);
        assert!(worktree.exists());

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_status_preserves_unicode_untracked_paths() -> Result<(), String> {
        let root = temp_root("unicode-status");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        add_worktree(&repo, &worktree)?;

        fs::create_dir_all(worktree.join("docs"))
            .map_err(|err| format!("failed to create docs dir: {err}"))?;
        fs::write(
            worktree.join("docs/可控核聚变的经济可行性分析.md"),
            "# 可控核聚变的经济可行性分析\n",
        )
        .map_err(|err| format!("failed to write unicode file: {err}"))?;

        let result = worktree_status_blocking(display_path(&worktree), Some(20_000))?;
        assert!(result.changed);
        assert!(result.status.contains("docs/可控核聚变的经济可行性分析.md"));
        assert_eq!(
            result.untracked_files,
            vec!["docs/可控核聚变的经济可行性分析.md".to_string()]
        );

        let _ = fs::remove_dir_all(root);
        Ok(())
    }
}
