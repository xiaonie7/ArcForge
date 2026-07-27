//! 安装编排：stage-then-swap 原子安装、备份与 install payload 处理。
//!
//! 写入纪律：新内容先在 `<root>/.staging/` 下完整构建（同一文件系统，`.` 前缀
//! 对发现/list 不可见），最后在 [`skills_write_guard`] 保护下用 `fs::rename`
//! 原子入位。读者永远只会看到旧目录或新目录，不存在半成品窗口。

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Utc;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;
use walkdir::WalkDir;

use super::*;

const MAX_LOCAL_SKILL_UPLOAD_BYTES: usize = 40 * 1024 * 1024;

fn local_upload_file_name(value: &str) -> Result<&str, String> {
    let file_name = Path::new(value)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Local Skill upload requires a valid fileName".to_string())?;
    if file_name != value || file_name.is_empty() {
        return Err("Local Skill upload fileName must not contain a path".to_string());
    }
    let supported = matches!(
        file_name.to_ascii_lowercase().as_str(),
        "skill.md" | "skill.json"
    ) || matches!(
        Path::new(file_name)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("zip") | Some("skill")
    );
    if !supported {
        return Err(
            "Local Skill uploads must be .zip/.skill archives, SKILL.md, or skill.json".to_string(),
        );
    }
    Ok(file_name)
}

pub(crate) fn install_uploaded_skill_from_payload(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
) -> Result<Vec<SystemSkillInstallResult>, String> {
    let file_name = local_upload_file_name(
        object_string(payload, "fileName")
            .or_else(|| object_string(payload, "file_name"))
            .ok_or_else(|| "SkillsManager install_upload requires fileName".to_string())?,
    )?;
    let content_base64 = object_string(payload, "contentBase64")
        .or_else(|| object_string(payload, "content_base64"))
        .ok_or_else(|| "SkillsManager install_upload requires contentBase64".to_string())?;
    let max_encoded_len = MAX_LOCAL_SKILL_UPLOAD_BYTES.div_ceil(3) * 4;
    if content_base64.len() > max_encoded_len {
        return Err(format!(
            "Local Skill upload is too large, over {} bytes",
            MAX_LOCAL_SKILL_UPLOAD_BYTES
        ));
    }
    let content = BASE64_STANDARD
        .decode(content_base64)
        .map_err(|error| format!("Local Skill upload is not valid base64: {error}"))?;
    if content.is_empty() {
        return Err("Local Skill upload is empty".to_string());
    }
    if content.len() > MAX_LOCAL_SKILL_UPLOAD_BYTES {
        return Err(format!(
            "Local Skill upload is too large, over {} bytes",
            MAX_LOCAL_SKILL_UPLOAD_BYTES
        ));
    }

    let upload = TempDir::new("arcforge-skill-upload")?;
    let source = upload.path().join(file_name);
    fs::write(&source, content)
        .map_err(|error| format!("Failed to stage local Skill upload: {error}"))?;

    let mut install_payload = payload
        .iter()
        .filter(|(key, _)| {
            !matches!(
                key.as_str(),
                "action" | "fileName" | "file_name" | "contentBase64" | "content_base64"
            )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<serde_json::Map<String, Value>>();
    install_payload.insert(
        "source".to_string(),
        Value::String(source.to_string_lossy().into_owned()),
    );
    install_source_from_payload(root, &install_payload)
}

const STAGING_DIR_NAME: &str = ".staging";
const STAGING_MAX_AGE_MS: u128 = 24 * 60 * 60 * 1000;

pub(crate) const INSTALL_CANCELLED_ERROR: &str = "Skill install cancelled";

static UNIQUE_SUFFIX_SEQ: AtomicU64 = AtomicU64::new(0);

/// Nanosecond timestamp + process-wide counter: unique even for concurrent
/// callers within the same clock tick.
fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{nanos}-{}",
        UNIQUE_SUFFIX_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

fn staging_root(dest_root: &Path) -> PathBuf {
    dest_root.join(STAGING_DIR_NAME)
}

fn remove_path_best_effort(path: &Path) {
    let is_dir = fs::symlink_metadata(path)
        .map(|meta| meta.is_dir())
        .unwrap_or(false);
    let _ = if is_dir {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
}

fn cleanup_stale_staging(staging: &Path) {
    let Ok(entries) = fs::read_dir(staging) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .map(|age| age.as_millis() > STAGING_MAX_AGE_MS)
            .unwrap_or(false);
        if stale {
            remove_path_best_effort(&entry.path());
        }
    }
}

pub(crate) fn unique_backup_path(dest_root: &Path, skill_name: &str) -> Result<PathBuf, String> {
    let backups_root = dest_root.join(".backups");
    fs::create_dir_all(&backups_root)
        .map_err(|e| format!("Failed to create Skills backup directory: {e}"))?;
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    Ok(backups_root.join(format!("{skill_name}-{stamp}-{}", unique_suffix())))
}

pub(crate) fn backup_existing_path(
    dest_root: &Path,
    target: &Path,
    skill_name: &str,
) -> Result<PathBuf, String> {
    let backup = unique_backup_path(dest_root, skill_name)?;
    fs::rename(target, &backup).map_err(|e| {
        format!(
            "Failed to move existing Skill to backup {}: {e}",
            backup.display()
        )
    })?;
    Ok(backup)
}

pub(crate) fn copy_dir_safely(source_dir: &Path, target: &Path) -> Result<(), String> {
    for entry in WalkDir::new(source_dir).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|e| format!("Failed to inspect source Skill: {e}"))?;
        let source_path = entry.path();
        let rel = source_path
            .strip_prefix(source_dir)
            .map_err(|e| format!("Failed to compute relative Skill path: {e}"))?;
        let target_path = target.join(rel);
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            return Err(format!(
                "Skill source contains a symlink, which is not supported: {}",
                source_path.display()
            ));
        }
        if file_type.is_dir() {
            fs::create_dir_all(&target_path)
                .map_err(|e| format!("Failed to create Skill directory: {e}"))?;
            continue;
        }
        if file_type.is_file() {
            let size = entry
                .metadata()
                .map_err(|e| format!("Failed to read source Skill file metadata: {e}"))?
                .len();
            if size > MAX_SKILL_FILE_BYTES {
                return Err(format!(
                    "Skill file is too large: {} ({} bytes)",
                    source_path.display(),
                    size
                ));
            }
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create Skill parent directory: {e}"))?;
            }
            fs::copy(source_path, &target_path).map_err(|e| {
                format!(
                    "Failed to copy Skill file {} to {}: {e}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

/// Builds the complete skill (content + optional `_meta.json`) in a private
/// staging directory and validates it there, so nothing ever mutates the live
/// target until the atomic swap.
fn stage_skill_dir(
    dest_root: &Path,
    source_dir: &Path,
    skill_name: &str,
    source_meta: Option<&[u8]>,
) -> Result<(PathBuf, SkillMetadata), String> {
    let staging = staging_root(dest_root);
    fs::create_dir_all(&staging)
        .map_err(|e| format!("Failed to create Skills staging directory: {e}"))?;
    cleanup_stale_staging(&staging);

    let staged = staging.join(format!("{skill_name}-{}", unique_suffix()));
    fs::create_dir_all(&staged)
        .map_err(|e| format!("Failed to create staged Skill directory: {e}"))?;

    let staged_result = copy_dir_safely(source_dir, &staged)
        .and_then(|()| {
            if let Some(bytes) = source_meta {
                fs::write(staged.join("_meta.json"), bytes)
                    .map_err(|e| format!("Failed to write Skill source metadata: {e}"))?;
            }
            read_skill_metadata_from_dir(&staged)
        })
        .and_then(|metadata| {
            if metadata.name != skill_name {
                return Err(format!(
                    "Installed Skill metadata name '{}' does not match target directory '{}'",
                    metadata.name, skill_name
                ));
            }
            Ok(metadata)
        });

    match staged_result {
        Ok(metadata) => Ok((staged, metadata)),
        Err(error) => {
            remove_path_best_effort(&staged);
            Err(error)
        }
    }
}

/// Atomically replaces the live target with the staged directory. The caller
/// must hold [`skills_write_guard`]; every step is a rename, so readers never
/// observe partial content.
fn swap_skill_into_place(
    dest_root: &Path,
    staged: &Path,
    skill_name: &str,
    conflict: &str,
) -> Result<Option<PathBuf>, String> {
    let target = dest_root.join(skill_name);
    let mut backup = None;
    if target.exists() {
        match conflict {
            "fail" => return Err(format!("Destination already exists: {}", target.display())),
            "overwrite" => {
                // Rename aside before deleting so a failing delete never
                // leaves a half-removed live target.
                let trash = staging_root(dest_root).join(format!("trash-{}", unique_suffix()));
                fs::rename(&target, &trash)
                    .map_err(|e| format!("Failed to remove existing Skill: {e}"))?;
                remove_path_best_effort(&trash);
            }
            "backup" => {
                backup = Some(backup_existing_path(dest_root, &target, skill_name)?);
            }
            other => return Err(format!("Unsupported conflict mode: {other}")),
        }
    }
    fs::rename(staged, &target).map_err(|e| {
        format!(
            "Failed to move staged Skill into place {}: {e}",
            target.display()
        )
    })?;
    Ok(backup)
}

pub(crate) fn install_skill_dir(
    dest_root: &Path,
    source_dir: &Path,
    skill_name: &str,
    conflict: &str,
    source_meta: Option<&[u8]>,
) -> Result<SystemSkillInstallResult, String> {
    let skill_name = sanitize_skill_name(skill_name)?;
    fs::create_dir_all(dest_root)
        .map_err(|e| format!("Failed to create Skills root directory: {e}"))?;
    let target = dest_root.join(&skill_name);

    // Self-install short-circuit: the source already is the live target.
    if target.exists() && source_dir.canonicalize().ok() == target.canonicalize().ok() {
        let metadata = read_skill_metadata_from_dir(&target)?;
        return Ok(SystemSkillInstallResult {
            name: skill_name,
            target: display_path(&target),
            backup: None,
            skill_file: rel_to_root_str(dest_root, &metadata.metadata_file),
        });
    }

    let (staged, metadata) = stage_skill_dir(dest_root, source_dir, &skill_name, source_meta)?;
    let rel_metadata_file = metadata
        .metadata_file
        .strip_prefix(&staged)
        .map_err(|e| format!("Failed to compute staged Skill metadata path: {e}"))?
        .to_path_buf();

    let swap = {
        let _guard = skills_write_guard();
        swap_skill_into_place(dest_root, &staged, &skill_name, conflict)
    };
    let backup = match swap {
        Ok(backup) => backup,
        Err(error) => {
            remove_path_best_effort(&staged);
            return Err(error);
        }
    };

    Ok(SystemSkillInstallResult {
        name: skill_name,
        target: display_path(&target),
        backup: backup.map(|path| display_path(&path)),
        skill_file: rel_to_root_str(dest_root, &target.join(rel_metadata_file)),
    })
}

pub(crate) fn normalize_conflict(
    value: Option<&str>,
    default_value: &str,
) -> Result<String, String> {
    let raw = value.unwrap_or(default_value).trim();
    match raw {
        "backup" | "fail" | "overwrite" => Ok(raw.to_string()),
        _ => Err(format!("Unsupported conflict mode: {raw}")),
    }
}

pub(crate) fn normalize_method(value: Option<&str>) -> Result<String, String> {
    let raw = value.unwrap_or("auto").trim();
    match raw {
        "auto" | "download" | "git" => Ok(raw.to_string()),
        _ => Err(format!("Unsupported GitHub method: {raw}")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SkillNameCompatibilityTransform {
    pub(crate) original_name: String,
    pub(crate) normalized_name: String,
}

fn is_clawhub_download_source(source: &str) -> bool {
    reqwest::Url::parse(source)
        .ok()
        .map(|url| url.host_str() == Some("clawhub.ai") && url.path() == "/api/v1/download")
        .unwrap_or(false)
}

fn registry_skill_slug(value: &str) -> &str {
    value
        .trim()
        .trim_start_matches('@')
        .rsplit('/')
        .next()
        .unwrap_or("")
}

fn rewrite_skill_metadata_name(metadata_file: &Path, normalized_name: &str) -> Result<(), String> {
    if is_skill_json(metadata_file) {
        let content = fs::read_to_string(metadata_file)
            .map_err(|e| format!("Failed to read {}: {e}", metadata_file.display()))?;
        let mut value = serde_json::from_str::<Value>(&content)
            .map_err(|e| format!("Failed to parse {}: {e}", metadata_file.display()))?;
        let object = value.as_object_mut().ok_or_else(|| {
            format!(
                "Skill metadata must be an object: {}",
                metadata_file.display()
            )
        })?;
        object.insert(
            "name".to_string(),
            Value::String(normalized_name.to_string()),
        );
        let next = serde_json::to_vec_pretty(&value)
            .map_err(|e| format!("Failed to serialize {}: {e}", metadata_file.display()))?;
        return fs::write(metadata_file, next)
            .map_err(|e| format!("Failed to update {}: {e}", metadata_file.display()));
    }

    let content = fs::read_to_string(metadata_file)
        .map_err(|e| format!("Failed to read {}: {e}", metadata_file.display()))?;
    let (yaml, body) = split_frontmatter(&content)?;
    if yaml.lines().count() == 1 && frontmatter_keys(&yaml).len() > 1 {
        return Err("Cannot safely normalize an inline Skill frontmatter name".to_string());
    }

    let mut replaced = false;
    let mut lines = Vec::new();
    for line in yaml.lines() {
        let is_top_level = !line
            .chars()
            .next()
            .map(char::is_whitespace)
            .unwrap_or(false);
        let is_name = is_top_level
            && line
                .split_once(':')
                .map(|(key, _)| key.trim() == "name")
                .unwrap_or(false);
        if is_name {
            lines.push(format!("name: {normalized_name}"));
            replaced = true;
        } else {
            lines.push(line.to_string());
        }
    }
    if !replaced {
        return Err(format!(
            "Missing top-level Skill name in {}",
            metadata_file.display()
        ));
    }

    let next = format!("---\n{}\n---\n{}", lines.join("\n"), body);
    fs::write(metadata_file, next)
        .map_err(|e| format!("Failed to update {}: {e}", metadata_file.display()))
}

pub(crate) fn normalize_clawhub_candidate_name(
    candidate: &Path,
    slug: &str,
) -> Result<Option<SkillNameCompatibilityTransform>, String> {
    let metadata_file = metadata_file_for(candidate).ok_or_else(|| {
        format!(
            "No SKILL.md, skill.md, skill.json, or README.md found in {}",
            candidate.display()
        )
    })?;
    let metadata = read_skill_metadata_file(&metadata_file)?;
    let Some(original_name) = metadata.name else {
        return Ok(None);
    };
    if sanitize_skill_name(&original_name).is_ok() {
        return Ok(None);
    }

    let normalized_name = normalize_skill_name(&original_name);
    let expected_name = registry_skill_slug(slug);
    if normalized_name != expected_name || sanitize_skill_name(expected_name).is_err() {
        return Ok(None);
    }

    rewrite_skill_metadata_name(&metadata_file, expected_name)?;
    Ok(Some(SkillNameCompatibilityTransform {
        original_name,
        normalized_name,
    }))
}

fn build_skill_source_metadata(
    payload: &serde_json::Map<String, Value>,
    compatibility: Option<&SkillNameCompatibilityTransform>,
) -> Result<Option<Vec<u8>>, String> {
    let Some(slug) = object_string(payload, "slug") else {
        return Ok(None);
    };
    let metadata = serde_json::json!({
        "registry": "clawhub",
        "slug": slug,
        "ownerHandle": object_string(payload, "ownerHandle")
            .or_else(|| object_string(payload, "owner")),
        "version": object_string(payload, "version"),
        "publishedAt": payload.get("publishedAt").and_then(Value::as_u64),
        "originalName": compatibility.map(|value| value.original_name.as_str()),
        "normalizedName": compatibility.map(|value| value.normalized_name.as_str()),
        "compatibilityTransform": compatibility.map(|_| "normalize-agent-skill-name"),
    });
    serde_json::to_vec_pretty(&metadata)
        .map(Some)
        .map_err(|e| format!("Failed to serialize Skill source metadata: {e}"))
}

pub(crate) fn install_source_from_payload(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
) -> Result<Vec<SystemSkillInstallResult>, String> {
    install_source_from_payload_with_progress(root, payload, |_| {}, &|| false)
}

pub(crate) fn install_source_from_payload_with_progress<F>(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
    mut on_progress: F,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<SystemSkillInstallResult>, String>
where
    F: FnMut(SkillInstallProgressUpdate),
{
    let source = object_string(payload, "source")
        .ok_or_else(|| "SkillsManager install requires source".to_string())?;
    let conflict = normalize_conflict(object_string(payload, "conflict"), "backup")?;
    let method = normalize_method(object_string(payload, "method"))?;
    let git_ref = object_string(payload, "ref").unwrap_or(DEFAULT_GITHUB_REF);
    let name_override = object_string(payload, "name")
        .map(sanitize_skill_name)
        .transpose()?;
    if should_cancel() {
        return Err(INSTALL_CANCELLED_ERROR.to_string());
    }

    let tmp = TempDir::new("arcforge-skill-install")?;
    let stage_root = if is_github_source(source) {
        on_progress(SkillInstallProgressUpdate {
            phase: "downloading",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some("Preparing GitHub Skill source".to_string()),
        });
        prepare_github_source(source, &method, git_ref, tmp.path(), should_cancel)?
    } else if is_http_source(source) {
        prepare_http_source_with_progress(
            source,
            tmp.path(),
            |update| on_progress(update),
            should_cancel,
        )?
    } else {
        on_progress(SkillInstallProgressUpdate {
            phase: "validating",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some("Preparing local Skill source".to_string()),
        });
        prepare_local_or_archive_source(source, tmp.path())?
    };

    on_progress(SkillInstallProgressUpdate {
        phase: "validating",
        downloaded_bytes: None,
        total_bytes: None,
        message: Some("Validating Skill metadata".to_string()),
    });
    let candidates = discover_skill_dirs(&stage_root);
    if candidates.is_empty() {
        return Err(
            "No skill directories found. Expected SKILL.md, skill.md, skill.json, or README.md."
                .to_string(),
        );
    }
    if name_override.is_some() && candidates.len() != 1 {
        return Err("name can only be used when exactly one skill is installed".to_string());
    }
    let normalize_clawhub_name = candidates.len() == 1 && is_clawhub_download_source(source);
    let registry_slug = object_string(payload, "slug").map(ToOwned::to_owned);

    let mut results = Vec::new();
    for candidate in candidates {
        if should_cancel() {
            return Err(INSTALL_CANCELLED_ERROR.to_string());
        }
        let compatibility = if normalize_clawhub_name {
            registry_slug
                .as_deref()
                .map(|slug| normalize_clawhub_candidate_name(&candidate, slug))
                .transpose()?
                .flatten()
        } else {
            None
        };
        if let Some(transform) = compatibility.as_ref() {
            on_progress(SkillInstallProgressUpdate {
                phase: "validating",
                downloaded_bytes: None,
                total_bytes: None,
                message: Some(format!(
                    "Normalizing Skill name '{}' to '{}' for Agent Skills compatibility",
                    transform.original_name, transform.normalized_name
                )),
            });
        }
        let metadata = read_skill_metadata_from_dir(&candidate)?;
        let skill_name = name_override.as_deref().unwrap_or(&metadata.name);
        let source_meta = build_skill_source_metadata(payload, compatibility.as_ref())?;
        ensure_not_builtin_skill_management_target(root, skill_name, "install")?;
        on_progress(SkillInstallProgressUpdate {
            phase: "installing",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some(format!("Installing Skill {skill_name}")),
        });
        results.push(install_skill_dir(
            root,
            &candidate,
            skill_name,
            &conflict,
            source_meta.as_deref(),
        )?);
    }
    Ok(results)
}
