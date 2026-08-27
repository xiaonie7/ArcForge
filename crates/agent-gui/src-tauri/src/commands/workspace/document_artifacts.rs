use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

use crate::runtime::app_paths::app_storage_dir;

const SCHEMA_VERSION: u32 = 1;
const WORKSPACES_DIR: &str = "workspaces";
const ARTIFACTS_DIR: &str = "artifacts";
const MANIFEST_FILE: &str = "manifest.json";
const VALIDATION_REPORT_LIMIT_BYTES: usize = 256 * 1024;

static ARTIFACT_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone)]
pub(crate) struct OfficeArtifactRecordInput {
    pub request_id: String,
    pub workdir: String,
    pub document_type: String,
    pub action: String,
    pub provider: String,
    pub input_path: Option<String>,
    pub spec_path: Option<String>,
    pub script_path: Option<String>,
    pub output_path: Option<String>,
    pub parent_revision: Option<DocumentArtifactRevisionRef>,
    pub source_revision: Option<DocumentArtifactRevisionRef>,
    pub source_snapshot_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifactSourcePaths {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifactPreview {
    pub preview_id: String,
    pub created_at: String,
    pub request_id: String,
    pub provider: String,
    pub format: String,
    pub workspace_path: String,
    pub storage_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifactRevisionRef {
    pub artifact_id: String,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifactValidation {
    pub validation_id: String,
    pub created_at: String,
    pub request_id: String,
    pub provider: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub report_format: String,
    pub report: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifactVersion {
    pub version: u64,
    pub created_at: String,
    pub request_id: String,
    pub action: String,
    pub provider: String,
    pub workspace_path: String,
    pub storage_path: String,
    pub format: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<DocumentArtifactRevisionRef>,
    pub sources: DocumentArtifactSourcePaths,
    #[serde(default)]
    pub previews: Vec<DocumentArtifactPreview>,
    #[serde(default)]
    pub validations: Vec<DocumentArtifactValidation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifactManifest {
    pub schema_version: u32,
    pub artifact_id: String,
    pub artifact_kind: String,
    pub document_type: String,
    pub output_path: String,
    pub current_version: u64,
    pub created_at: String,
    pub updated_at: String,
    pub versions: Vec<DocumentArtifactVersion>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifactSummary {
    pub artifact_id: String,
    pub artifact_kind: String,
    pub document_type: String,
    pub output_path: String,
    pub current_version: u64,
    pub created_at: String,
    pub updated_at: String,
    pub format: String,
    pub mime_type: String,
    pub action: String,
    pub provider: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub preview_count: usize,
    pub validation_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_validation_status: Option<String>,
    pub artifact_role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_version: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifactListResponse {
    pub artifacts: Vec<DocumentArtifactSummary>,
}

/// Public artifact detail returned through the Tauri IPC boundary.
///
/// The persisted manifest intentionally carries private storage locations so the runtime can
/// find immutable snapshots. This DTO retains workspace-facing metadata but never exposes those
/// internal locations to the frontend.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifactDetails {
    pub schema_version: u32,
    pub artifact_id: String,
    pub artifact_kind: String,
    pub document_type: String,
    pub output_path: String,
    pub current_version: u64,
    pub created_at: String,
    pub updated_at: String,
    pub versions: Vec<DocumentArtifactVersionDetails>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifactVersionDetails {
    pub version: u64,
    pub created_at: String,
    pub request_id: String,
    pub action: String,
    pub provider: String,
    pub workspace_path: String,
    pub format: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<DocumentArtifactRevisionRef>,
    pub sources: DocumentArtifactSourcePaths,
    pub previews: Vec<DocumentArtifactPreviewDetails>,
    pub validations: Vec<DocumentArtifactValidation>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifactPreviewDetails {
    pub preview_id: String,
    pub created_at: String,
    pub request_id: String,
    pub provider: String,
    pub format: String,
    pub workspace_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn workspace_key(workdir: &Path) -> String {
    let normalized = if cfg!(windows) {
        workdir.to_string_lossy().replace('\\', "/").to_lowercase()
    } else {
        workdir.to_string_lossy().into_owned()
    };
    to_hex(&Sha256::digest(normalized.as_bytes()))
}

fn canonical_workdir(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw.trim());
    if raw.trim().is_empty() || !path.is_absolute() {
        return Err("workdir must be an existing absolute directory".to_string());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("workdir must be an existing absolute directory: {error}"))?;
    if !canonical.is_dir() {
        return Err("workdir must be an existing absolute directory".to_string());
    }
    Ok(canonical)
}

fn resolve_existing_workspace_file(
    workdir: &Path,
    raw: &str,
    label: &str,
) -> Result<(PathBuf, String), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(format!("{label} is required"));
    }
    let path = Path::new(raw);
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!("{label} must not contain '..' path components"));
    }
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        workdir.join(path)
    };
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| format!("{label} does not identify an existing file: {error}"))?;
    if !canonical.is_file() {
        return Err(format!("{label} must identify a file"));
    }
    let relative = canonical
        .strip_prefix(workdir)
        .map_err(|_| format!("{label} must stay inside the configured workspace"))
        .map(logical_path)?;
    Ok((canonical, relative))
}

fn optional_workspace_path(workdir: &Path, raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    resolve_existing_workspace_file(workdir, raw, "source path")
        .ok()
        .map(|(_, relative)| relative)
}

fn logical_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase()
}

fn mime_type(format: &str) -> String {
    match format {
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Failed to open artifact output {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| {
            format!("Failed to read artifact output {}: {error}", path.display())
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        size = size.saturating_add(count as u64);
    }
    Ok((to_hex(&hasher.finalize()), size))
}

fn truncate_utf8(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[validation report truncated]", &value[..end])
}

fn artifacts_root(app_root: &Path, workdir: &Path) -> PathBuf {
    app_root
        .join(WORKSPACES_DIR)
        .join(workspace_key(workdir))
        .join(ARTIFACTS_DIR)
}

fn manifest_path(artifacts_root: &Path, artifact_id: &str) -> PathBuf {
    artifacts_root.join(artifact_id).join(MANIFEST_FILE)
}

fn load_manifest(path: &Path) -> Result<DocumentArtifactManifest, String> {
    let bytes = fs::read(path).map_err(|error| {
        format!(
            "Failed to read artifact manifest {}: {error}",
            path.display()
        )
    })?;
    let manifest: DocumentArtifactManifest = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "Failed to parse artifact manifest {}: {error}",
            path.display()
        )
    })?;
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "Unsupported artifact manifest schema version {} in {}",
            manifest.schema_version,
            path.display()
        ));
    }
    Ok(manifest)
}

fn load_manifests(root: &Path) -> Result<Vec<DocumentArtifactManifest>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut manifests = Vec::new();
    for entry in
        fs::read_dir(root).map_err(|error| format!("Failed to list document artifacts: {error}"))?
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!("Skipping unreadable document artifact entry: {error}");
                continue;
            }
        };
        let is_directory = match entry.file_type() {
            Ok(file_type) => file_type.is_dir(),
            Err(error) => {
                eprintln!(
                    "Skipping document artifact entry {} because its type could not be read: {error}",
                    entry.path().display()
                );
                continue;
            }
        };
        if !is_directory {
            continue;
        }
        let path = entry.path().join(MANIFEST_FILE);
        if path.is_file() {
            match load_manifest(&path) {
                Ok(manifest) => manifests.push(manifest),
                Err(error) => {
                    eprintln!("Skipping invalid document artifact manifest: {error}");
                }
            }
        }
    }
    Ok(manifests)
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Artifact manifest has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create artifact directory: {error}"))?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to serialize artifact manifest: {error}"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create temporary artifact manifest: {error}"))?;
    temp.write_all(&bytes)
        .map_err(|error| format!("Failed to write temporary artifact manifest: {error}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| format!("Failed to sync temporary artifact manifest: {error}"))?;
    temp.persist(path)
        .map_err(|error| format!("Failed to publish artifact manifest: {}", error.error))?;
    Ok(())
}

fn snapshot_file(source: &Path, destination: &Path) -> Result<(String, u64), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "Artifact snapshot has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create artifact snapshot directory: {error}"))?;
    let mut source_file = File::open(source).map_err(|error| {
        format!(
            "Failed to open artifact output {}: {error}",
            source.display()
        )
    })?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create temporary artifact snapshot: {error}"))?;
    std::io::copy(&mut source_file, &mut temp)
        .map_err(|error| format!("Failed to copy artifact snapshot: {error}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| format!("Failed to sync artifact snapshot: {error}"))?;
    temp.persist(destination)
        .map_err(|error| format!("Failed to publish artifact snapshot: {}", error.error))?;
    hash_file(destination)
}

fn snapshot_stable_file(source: &Path, destination: &Path) -> Result<(String, u64), String> {
    let snapshot_state = snapshot_file(source, destination)?;
    let live_state = hash_file(source)?;
    if snapshot_state != live_state {
        let _ = fs::remove_file(destination);
        return Err(format!(
            "Artifact output {} changed while it was being snapshotted; retry the operation",
            source.display()
        ));
    }
    Ok(snapshot_state)
}

fn summary_with_role(
    manifest: &DocumentArtifactManifest,
    artifact_role: &str,
    source_version: Option<u64>,
) -> Result<DocumentArtifactSummary, String> {
    let described_version = source_version.unwrap_or(manifest.current_version);
    let version = manifest
        .versions
        .iter()
        .find(|version| version.version == described_version)
        .or_else(|| manifest.versions.last())
        .ok_or_else(|| format!("Artifact {} has no versions", manifest.artifact_id))?;
    Ok(DocumentArtifactSummary {
        artifact_id: manifest.artifact_id.clone(),
        artifact_kind: manifest.artifact_kind.clone(),
        document_type: manifest.document_type.clone(),
        output_path: manifest.output_path.clone(),
        current_version: manifest.current_version,
        created_at: manifest.created_at.clone(),
        updated_at: manifest.updated_at.clone(),
        format: version.format.clone(),
        mime_type: version.mime_type.clone(),
        action: version.action.clone(),
        provider: version.provider.clone(),
        size_bytes: version.size_bytes,
        sha256: version.sha256.clone(),
        preview_count: version.previews.len(),
        validation_count: version.validations.len(),
        latest_validation_status: version
            .validations
            .last()
            .map(|validation| validation.status.clone()),
        artifact_role: artifact_role.to_string(),
        source_version,
    })
}

fn summary(manifest: &DocumentArtifactManifest) -> Result<DocumentArtifactSummary, String> {
    summary_with_role(manifest, "primary", None)
}

fn artifact_details(manifest: &DocumentArtifactManifest) -> DocumentArtifactDetails {
    DocumentArtifactDetails {
        schema_version: manifest.schema_version,
        artifact_id: manifest.artifact_id.clone(),
        artifact_kind: manifest.artifact_kind.clone(),
        document_type: manifest.document_type.clone(),
        output_path: manifest.output_path.clone(),
        current_version: manifest.current_version,
        created_at: manifest.created_at.clone(),
        updated_at: manifest.updated_at.clone(),
        versions: manifest
            .versions
            .iter()
            .map(|version| DocumentArtifactVersionDetails {
                version: version.version,
                created_at: version.created_at.clone(),
                request_id: version.request_id.clone(),
                action: version.action.clone(),
                provider: version.provider.clone(),
                workspace_path: version.workspace_path.clone(),
                format: version.format.clone(),
                mime_type: version.mime_type.clone(),
                size_bytes: version.size_bytes,
                sha256: version.sha256.clone(),
                parent: version.parent.clone(),
                sources: version.sources.clone(),
                previews: version
                    .previews
                    .iter()
                    .map(|preview| DocumentArtifactPreviewDetails {
                        preview_id: preview.preview_id.clone(),
                        created_at: preview.created_at.clone(),
                        request_id: preview.request_id.clone(),
                        provider: preview.provider.clone(),
                        format: preview.format.clone(),
                        workspace_path: preview.workspace_path.clone(),
                        size_bytes: preview.size_bytes,
                        sha256: preview.sha256.clone(),
                    })
                    .collect(),
                validations: version.validations.clone(),
            })
            .collect(),
    }
}

fn record_primary_output(
    app_root: &Path,
    workdir: &Path,
    input: &OfficeArtifactRecordInput,
    output: &Path,
    output_path: &str,
) -> Result<DocumentArtifactSummary, String> {
    let root = artifacts_root(app_root, workdir);
    let manifests = load_manifests(&root)?;
    let existing = manifests
        .iter()
        .find(|manifest| manifest.output_path == output_path)
        .cloned();
    if let Some(existing) = existing.as_ref() {
        let live_state = hash_file(output)?;
        if existing
            .versions
            .iter()
            .find(|version| version.version == existing.current_version)
            .is_some_and(|version| {
                version.request_id == input.request_id.trim()
                    && version.action.eq_ignore_ascii_case(input.action.trim())
                    && version.sha256 == live_state.0
                    && version.size_bytes == live_state.1
            })
        {
            return summary(existing);
        }
    }
    let parent = input.parent_revision.clone().or_else(|| {
        existing
            .as_ref()
            .filter(|manifest| manifest.current_version > 0)
            .map(|manifest| DocumentArtifactRevisionRef {
                artifact_id: manifest.artifact_id.clone(),
                version: manifest.current_version,
            })
            .or_else(|| {
                input.input_path.as_deref().and_then(|raw_input| {
                    resolve_existing_workspace_file(workdir, raw_input, "inputPath")
                        .ok()
                        .and_then(|(_, input_path)| {
                            manifests
                                .iter()
                                .find(|manifest| manifest.output_path == input_path)
                                .filter(|manifest| manifest.current_version > 0)
                                .map(|manifest| DocumentArtifactRevisionRef {
                                    artifact_id: manifest.artifact_id.clone(),
                                    version: manifest.current_version,
                                })
                        })
                })
            })
    });
    let now = timestamp();
    let mut manifest = existing.unwrap_or_else(|| DocumentArtifactManifest {
        schema_version: SCHEMA_VERSION,
        artifact_id: Uuid::new_v4().to_string(),
        artifact_kind: "document".to_string(),
        document_type: input.document_type.trim().to_ascii_lowercase(),
        output_path: output_path.to_string(),
        current_version: 0,
        created_at: now.clone(),
        updated_at: now.clone(),
        versions: Vec::new(),
    });
    let version = manifest.current_version.saturating_add(1);
    let format = extension(output);
    let relative_snapshot = format!("versions/{version}.{format}");
    let artifact_dir = root.join(&manifest.artifact_id);
    let snapshot = artifact_dir.join(Path::new(&relative_snapshot));
    let (sha256, size_bytes) = snapshot_stable_file(output, &snapshot)?;

    manifest.document_type = input.document_type.trim().to_ascii_lowercase();
    manifest.output_path = output_path.to_string();
    manifest.current_version = version;
    manifest.updated_at = now.clone();
    manifest.versions.push(DocumentArtifactVersion {
        version,
        created_at: now,
        request_id: input.request_id.trim().to_string(),
        action: input.action.trim().to_ascii_lowercase(),
        provider: input.provider.trim().to_string(),
        workspace_path: output_path.to_string(),
        storage_path: relative_snapshot,
        mime_type: mime_type(&format),
        format,
        size_bytes,
        sha256,
        parent,
        sources: DocumentArtifactSourcePaths {
            input_path: optional_workspace_path(workdir, input.input_path.as_deref()),
            spec_path: optional_workspace_path(workdir, input.spec_path.as_deref()),
            script_path: optional_workspace_path(workdir, input.script_path.as_deref()),
        },
        previews: Vec::new(),
        validations: Vec::new(),
    });
    atomic_write_json(&manifest_path(&root, &manifest.artifact_id), &manifest)?;
    summary(&manifest)
}

fn load_or_import_source_manifest(
    app_root: &Path,
    workdir: &Path,
    input: &OfficeArtifactRecordInput,
    source: &Path,
    source_path: &str,
) -> Result<DocumentArtifactManifest, String> {
    let root = artifacts_root(app_root, workdir);
    let existing = load_manifests(&root)?
        .into_iter()
        .find(|manifest| manifest.output_path == source_path);
    if let Some(manifest) = existing.as_ref() {
        let version = manifest
            .versions
            .iter()
            .find(|version| version.version == manifest.current_version)
            .ok_or_else(|| "Artifact current version is missing".to_string())?;
        let (sha256, size_bytes) = hash_file(source)?;
        if version.sha256 == sha256 && version.size_bytes == size_bytes {
            return Ok(manifest.clone());
        }
    }

    let import = OfficeArtifactRecordInput {
        request_id: format!("{}-source", input.request_id),
        workdir: input.workdir.clone(),
        document_type: input.document_type.clone(),
        action: if existing.is_some() {
            "external-edit"
        } else {
            "import"
        }
        .to_string(),
        provider: "workspace".to_string(),
        input_path: None,
        spec_path: None,
        script_path: None,
        output_path: Some(source_path.to_string()),
        parent_revision: None,
        source_revision: None,
        source_snapshot_path: None,
    };
    record_primary_output(app_root, workdir, &import, source, source_path)?;
    load_manifests(&root)?
        .into_iter()
        .find(|manifest| manifest.output_path == source_path)
        .ok_or_else(|| "Imported artifact manifest could not be loaded".to_string())
}

fn current_revision_ref(
    manifest: &DocumentArtifactManifest,
) -> Result<DocumentArtifactRevisionRef, String> {
    if manifest.current_version == 0
        || !manifest
            .versions
            .iter()
            .any(|version| version.version == manifest.current_version)
    {
        return Err(format!(
            "Artifact {} current version is missing",
            manifest.artifact_id
        ));
    }
    Ok(DocumentArtifactRevisionRef {
        artifact_id: manifest.artifact_id.clone(),
        version: manifest.current_version,
    })
}

fn revision_snapshot_path(
    root: &Path,
    manifest: &DocumentArtifactManifest,
    revision: &DocumentArtifactRevisionRef,
) -> Result<PathBuf, String> {
    let version = manifest
        .versions
        .iter()
        .find(|version| version.version == revision.version)
        .ok_or_else(|| {
            format!(
                "Artifact {} version {} is missing",
                revision.artifact_id, revision.version
            )
        })?;
    let relative = Path::new(&version.storage_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Artifact revision has an invalid storage path".to_string());
    }
    let snapshot = root.join(&manifest.artifact_id).join(relative);
    if !snapshot.is_file() {
        return Err(format!(
            "Artifact revision snapshot is missing: {}",
            snapshot.display()
        ));
    }
    Ok(snapshot)
}

fn load_revision_manifest(
    root: &Path,
    source_path: &str,
    revision: &DocumentArtifactRevisionRef,
) -> Result<DocumentArtifactManifest, String> {
    let manifest = load_manifest(&manifest_path(root, &revision.artifact_id))?;
    if manifest.output_path != source_path {
        return Err("Artifact source revision does not match inputPath".to_string());
    }
    if !manifest
        .versions
        .iter()
        .any(|version| version.version == revision.version)
    {
        return Err(format!(
            "Artifact {} version {} is missing",
            revision.artifact_id, revision.version
        ));
    }
    Ok(manifest)
}

fn resolve_workspace_file_if_present(
    workdir: &Path,
    raw: &str,
    label: &str,
) -> Result<Option<(PathBuf, String)>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let path = Path::new(raw);
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!("{label} must not contain '..' path components"));
    }
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        workdir.join(path)
    };
    match fs::metadata(&candidate) {
        Ok(_) => resolve_existing_workspace_file(workdir, raw, label).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to inspect {label}: {error}")),
    }
}

fn prepare_record_at(
    app_root: &Path,
    mut input: OfficeArtifactRecordInput,
) -> Result<OfficeArtifactRecordInput, String> {
    let workdir = canonical_workdir(&input.workdir)?;
    let lock = ARTIFACT_WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "Document artifact store is unavailable".to_string())?;
    let action = input.action.trim().to_ascii_lowercase();

    let source_manifest = if matches!(action.as_str(), "patch" | "code" | "render" | "validate") {
        match input.input_path.as_deref() {
            Some(raw_input) => {
                let (source, source_path) =
                    resolve_existing_workspace_file(&workdir, raw_input, "inputPath")?;
                Some((
                    source_path.clone(),
                    load_or_import_source_manifest(
                        app_root,
                        &workdir,
                        &input,
                        &source,
                        &source_path,
                    )?,
                ))
            }
            None => None,
        }
    } else {
        None
    };
    input.source_revision = source_manifest
        .as_ref()
        .map(|(_, manifest)| current_revision_ref(manifest))
        .transpose()?;
    input.source_snapshot_path = match (source_manifest.as_ref(), input.source_revision.as_ref()) {
        (Some((_, manifest)), Some(revision)) => Some(revision_snapshot_path(
            &artifacts_root(app_root, &workdir),
            manifest,
            revision,
        )?),
        _ => None,
    };

    if matches!(action.as_str(), "create" | "patch" | "code") {
        let target_manifest = match input.output_path.as_deref() {
            Some(raw_output) => {
                match resolve_workspace_file_if_present(&workdir, raw_output, "outputPath")? {
                    Some((target, target_path)) => {
                        if source_manifest
                            .as_ref()
                            .is_some_and(|(source_path, _)| source_path == &target_path)
                        {
                            source_manifest
                                .as_ref()
                                .map(|(_, manifest)| manifest.clone())
                        } else {
                            Some(load_or_import_source_manifest(
                                app_root,
                                &workdir,
                                &input,
                                &target,
                                &target_path,
                            )?)
                        }
                    }
                    None => None,
                }
            }
            None => None,
        };
        input.parent_revision = target_manifest
            .as_ref()
            .map(current_revision_ref)
            .transpose()?
            .or_else(|| input.source_revision.clone());
    }

    Ok(input)
}

fn record_preview_output(
    app_root: &Path,
    workdir: &Path,
    input: &OfficeArtifactRecordInput,
    source: &Path,
    source_path: &str,
    output: &Path,
    output_path: &str,
) -> Result<DocumentArtifactSummary, String> {
    let root = artifacts_root(app_root, workdir);
    let (mut manifest, source_version) = if let Some(revision) = input.source_revision.as_ref() {
        (
            load_revision_manifest(&root, source_path, revision)?,
            revision.version,
        )
    } else {
        let manifest =
            load_or_import_source_manifest(app_root, workdir, input, source, source_path)?;
        let source_version = manifest.current_version;
        (manifest, source_version)
    };
    let format = extension(output);
    if manifest
        .versions
        .iter()
        .find(|version| version.version == source_version)
        .is_some_and(|version| {
            version
                .previews
                .iter()
                .any(|preview| preview.request_id == input.request_id)
        })
    {
        return summary_with_role(&manifest, "preview", Some(source_version));
    }
    let preview_id = Uuid::new_v4().to_string();
    let relative_snapshot = format!("previews/{}/{}.{}", source_version, preview_id, format);
    let artifact_dir = root.join(&manifest.artifact_id);
    let snapshot = artifact_dir.join(Path::new(&relative_snapshot));
    let (sha256, size_bytes) = snapshot_stable_file(output, &snapshot)?;
    let now = timestamp();
    let current_version = manifest
        .versions
        .iter_mut()
        .find(|version| version.version == source_version)
        .ok_or_else(|| "Artifact current version is missing".to_string())?;
    current_version.previews.push(DocumentArtifactPreview {
        preview_id,
        created_at: now.clone(),
        request_id: input.request_id.trim().to_string(),
        provider: input.provider.trim().to_string(),
        format,
        workspace_path: output_path.to_string(),
        storage_path: relative_snapshot,
        size_bytes,
        sha256,
    });
    manifest.updated_at = now;
    atomic_write_json(&manifest_path(&root, &manifest.artifact_id), &manifest)?;
    summary_with_role(&manifest, "preview", Some(source_version))
}

fn record_validation(
    app_root: &Path,
    workdir: &Path,
    input: &OfficeArtifactRecordInput,
    source: &Path,
    source_path: &str,
    success: bool,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
) -> Result<DocumentArtifactSummary, String> {
    let root = artifacts_root(app_root, workdir);
    let (mut manifest, source_version) = if let Some(revision) = input.source_revision.as_ref() {
        (
            load_revision_manifest(&root, source_path, revision)?,
            revision.version,
        )
    } else {
        let manifest =
            load_or_import_source_manifest(app_root, workdir, input, source, source_path)?;
        let source_version = manifest.current_version;
        (manifest, source_version)
    };
    let current_version = manifest
        .versions
        .iter_mut()
        .find(|version| version.version == source_version)
        .ok_or_else(|| "Artifact current version is missing".to_string())?;
    if current_version
        .validations
        .iter()
        .any(|validation| validation.request_id == input.request_id)
    {
        return summary(&manifest);
    }
    let raw_report = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    let report = truncate_utf8(raw_report, VALIDATION_REPORT_LIMIT_BYTES);
    let report_format = if serde_json::from_str::<serde_json::Value>(&report).is_ok() {
        "json"
    } else {
        "text"
    };
    current_version
        .validations
        .push(DocumentArtifactValidation {
            validation_id: Uuid::new_v4().to_string(),
            created_at: timestamp(),
            request_id: input.request_id.clone(),
            provider: input.provider.clone(),
            status: if success { "passed" } else { "failed" }.to_string(),
            exit_code,
            report_format: report_format.to_string(),
            report,
        });
    manifest.updated_at = timestamp();
    atomic_write_json(&manifest_path(&root, &manifest.artifact_id), &manifest)?;
    summary(&manifest)
}

fn record_result_at(
    app_root: &Path,
    input: OfficeArtifactRecordInput,
    success: bool,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
) -> Result<Option<DocumentArtifactSummary>, String> {
    let workdir = canonical_workdir(&input.workdir)?;
    let lock = ARTIFACT_WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "Document artifact store is unavailable".to_string())?;

    if input.action.trim().eq_ignore_ascii_case("validate") {
        let input_raw = input
            .input_path
            .as_deref()
            .ok_or_else(|| "inputPath is required for artifact validation".to_string())?;
        let (source, source_path) = if let Some(revision) = input.source_revision.as_ref() {
            let root = artifacts_root(app_root, &workdir);
            let manifest = load_manifest(&manifest_path(&root, &revision.artifact_id))?;
            let source_path = manifest.output_path.clone();
            (workdir.join(Path::new(&source_path)), source_path)
        } else {
            resolve_existing_workspace_file(&workdir, input_raw, "inputPath")?
        };
        return record_validation(
            app_root,
            &workdir,
            &input,
            &source,
            &source_path,
            success,
            exit_code,
            stdout,
            stderr,
        )
        .map(Some);
    }
    if !success {
        return Ok(None);
    }
    record_success_output_at(app_root, input)
}

#[cfg(test)]
fn record_at(
    app_root: &Path,
    input: OfficeArtifactRecordInput,
) -> Result<Option<DocumentArtifactSummary>, String> {
    record_result_at(app_root, input, true, Some(0), "", "")
}

fn record_success_output_at(
    app_root: &Path,
    input: OfficeArtifactRecordInput,
) -> Result<Option<DocumentArtifactSummary>, String> {
    let Some(output_raw) = input.output_path.as_deref() else {
        return Ok(None);
    };
    let workdir = canonical_workdir(&input.workdir)?;
    let (output, output_path) =
        resolve_existing_workspace_file(&workdir, output_raw, "outputPath")?;

    if input.action.trim().eq_ignore_ascii_case("render") {
        let input_raw = input
            .input_path
            .as_deref()
            .ok_or_else(|| "inputPath is required for a rendered artifact preview".to_string())?;
        let (source, source_path) = if let Some(revision) = input.source_revision.as_ref() {
            let root = artifacts_root(app_root, &workdir);
            let manifest = load_manifest(&manifest_path(&root, &revision.artifact_id))?;
            let source_path = manifest.output_path.clone();
            (workdir.join(Path::new(&source_path)), source_path)
        } else {
            resolve_existing_workspace_file(&workdir, input_raw, "inputPath")?
        };
        record_preview_output(
            app_root,
            &workdir,
            &input,
            &source,
            &source_path,
            &output,
            &output_path,
        )
        .map(Some)
    } else {
        record_primary_output(app_root, &workdir, &input, &output, &output_path).map(Some)
    }
}

pub(crate) fn record_office_runtime_result(
    input: OfficeArtifactRecordInput,
    success: bool,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
) -> Result<Option<DocumentArtifactSummary>, String> {
    let app_root = app_storage_dir()?;
    record_result_at(&app_root, input, success, exit_code, stdout, stderr)
}

pub(crate) fn prepare_office_runtime_artifacts(
    input: OfficeArtifactRecordInput,
) -> Result<OfficeArtifactRecordInput, String> {
    let app_root = app_storage_dir()?;
    prepare_record_at(&app_root, input)
}

fn list_at(app_root: &Path, workdir: &str) -> Result<DocumentArtifactListResponse, String> {
    let workdir = canonical_workdir(workdir)?;
    let root = artifacts_root(app_root, &workdir);
    let mut artifacts = load_manifests(&root)?
        .iter()
        .map(summary)
        .collect::<Result<Vec<_>, _>>()?;
    artifacts.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.output_path.cmp(&right.output_path))
    });
    Ok(DocumentArtifactListResponse { artifacts })
}

fn get_at(
    app_root: &Path,
    workdir: &str,
    artifact_id: &str,
) -> Result<DocumentArtifactManifest, String> {
    let workdir = canonical_workdir(workdir)?;
    let artifact_id = Uuid::parse_str(artifact_id.trim())
        .map_err(|_| "artifactId must be a UUID".to_string())?
        .to_string();
    let root = artifacts_root(app_root, &workdir);
    let manifest = load_manifest(&manifest_path(&root, &artifact_id))?;
    if manifest.artifact_id != artifact_id {
        return Err("Artifact manifest identity does not match artifactId".to_string());
    }
    Ok(manifest)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn document_artifact_list(
    workdir: String,
) -> Result<DocumentArtifactListResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app_root = app_storage_dir()?;
        list_at(&app_root, &workdir)
    })
    .await
    .map_err(|error| format!("document_artifact_list worker failed: {error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn document_artifact_get(
    workdir: String,
    artifact_id: String,
) -> Result<DocumentArtifactDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app_root = app_storage_dir()?;
        get_at(&app_root, &workdir, &artifact_id).map(|manifest| artifact_details(&manifest))
    })
    .await
    .map_err(|error| format!("document_artifact_get worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_input(
        workdir: &Path,
        request_id: &str,
        action: &str,
        input_path: Option<&str>,
        output_path: &str,
    ) -> OfficeArtifactRecordInput {
        OfficeArtifactRecordInput {
            request_id: request_id.to_string(),
            workdir: workdir.to_string_lossy().into_owned(),
            document_type: "word".to_string(),
            action: action.to_string(),
            provider: "officecli".to_string(),
            input_path: input_path.map(ToString::to_string),
            spec_path: None,
            script_path: None,
            output_path: Some(output_path.to_string()),
            parent_revision: None,
            source_revision: None,
            source_snapshot_path: None,
        }
    }

    #[test]
    fn primary_outputs_append_immutable_versions() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        let output = workspace.path().join("report.docx");
        fs::write(&output, b"version one").expect("write v1");

        let first = record_at(
            app.path(),
            record_input(workspace.path(), "request-1", "create", None, "report.docx"),
        )
        .expect("record first")
        .expect("first summary");
        fs::write(&output, b"version two").expect("write v2");
        let second = record_at(
            app.path(),
            record_input(
                workspace.path(),
                "request-2",
                "patch",
                Some("report.docx"),
                "report.docx",
            ),
        )
        .expect("record second")
        .expect("second summary");

        assert_eq!(first.artifact_id, second.artifact_id);
        assert_eq!(second.current_version, 2);
        let manifest = get_at(
            app.path(),
            workspace.path().to_str().unwrap(),
            &first.artifact_id,
        )
        .expect("manifest");
        assert_eq!(manifest.versions.len(), 2);
        assert_ne!(manifest.versions[0].sha256, manifest.versions[1].sha256);
        assert_eq!(manifest.versions[0].parent, None);
        assert_eq!(
            manifest.versions[1].parent,
            Some(DocumentArtifactRevisionRef {
                artifact_id: first.artifact_id.clone(),
                version: 1,
            })
        );
        let root = artifacts_root(
            app.path(),
            &fs::canonicalize(workspace.path()).expect("canonical workspace"),
        )
        .join(&first.artifact_id);
        assert_eq!(
            fs::read(root.join(&manifest.versions[0].storage_path)).expect("v1 snapshot"),
            b"version one"
        );
        assert_eq!(
            fs::read(root.join(&manifest.versions[1].storage_path)).expect("v2 snapshot"),
            b"version two"
        );
    }

    #[test]
    fn public_artifact_details_do_not_expose_private_storage_paths() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        fs::write(workspace.path().join("report.docx"), b"document").expect("document");
        let created = record_at(
            app.path(),
            record_input(
                workspace.path(),
                "request-create",
                "create",
                None,
                "report.docx",
            ),
        )
        .expect("record document")
        .expect("artifact summary");
        let manifest = get_at(
            app.path(),
            workspace.path().to_str().expect("workspace path"),
            &created.artifact_id,
        )
        .expect("manifest");

        let serialized =
            serde_json::to_string(&artifact_details(&manifest)).expect("serialize public details");
        assert!(!serialized.contains("storagePath"));
        assert!(!serialized.contains("versions/1.docx"));
    }

    #[test]
    fn repeated_request_only_deduplicates_unchanged_content() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        let output = workspace.path().join("report.docx");
        let input = record_input(
            workspace.path(),
            "same-request",
            "create",
            None,
            "report.docx",
        );
        fs::write(&output, b"version one").expect("write v1");
        let first = record_at(app.path(), input.clone())
            .expect("record first")
            .expect("first summary");
        let unchanged = record_at(app.path(), input.clone())
            .expect("record unchanged retry")
            .expect("unchanged summary");
        assert_eq!(unchanged.current_version, 1);

        fs::write(&output, b"version two").expect("write v2");
        let changed = record_at(app.path(), input)
            .expect("record changed retry")
            .expect("changed summary");
        assert_eq!(changed.artifact_id, first.artifact_id);
        assert_eq!(changed.current_version, 2);
        let manifest = get_at(
            app.path(),
            workspace.path().to_str().unwrap(),
            &first.artifact_id,
        )
        .expect("manifest");
        assert_eq!(manifest.versions.len(), 2);
        assert_eq!(manifest.versions[1].request_id, "same-request");
    }

    #[test]
    fn preparation_preserves_an_untracked_in_place_patch_source() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        let document = workspace.path().join("legacy.docx");
        fs::write(&document, b"original").expect("write original");
        let prepared = prepare_record_at(
            app.path(),
            record_input(
                workspace.path(),
                "patch-request",
                "patch",
                Some("legacy.docx"),
                "legacy.docx",
            ),
        )
        .expect("prepare patch");
        assert_eq!(prepared.parent_revision, prepared.source_revision);
        let source_revision = prepared.source_revision.clone().expect("source revision");

        fs::write(&document, b"patched").expect("write patched");
        let summary = record_at(app.path(), prepared)
            .expect("record patch")
            .expect("patch summary");
        assert_eq!(summary.current_version, 2);
        let manifest = get_at(
            app.path(),
            workspace.path().to_str().unwrap(),
            &summary.artifact_id,
        )
        .expect("manifest");
        assert_eq!(manifest.versions[0].action, "import");
        assert_eq!(manifest.versions[1].parent, Some(source_revision));
        let root = artifacts_root(
            app.path(),
            &fs::canonicalize(workspace.path()).expect("canonical workspace"),
        )
        .join(&summary.artifact_id);
        assert_eq!(
            fs::read(root.join(&manifest.versions[0].storage_path)).expect("original snapshot"),
            b"original"
        );
    }

    #[test]
    fn preparation_uses_an_imported_input_as_a_new_output_parent() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        fs::write(workspace.path().join("source.docx"), b"source").expect("source");
        let prepared = prepare_record_at(
            app.path(),
            record_input(
                workspace.path(),
                "patch-request",
                "patch",
                Some("source.docx"),
                "derived.docx",
            ),
        )
        .expect("prepare patch");
        let source_revision = prepared.source_revision.clone().expect("source revision");
        assert_eq!(prepared.parent_revision, Some(source_revision.clone()));

        fs::write(workspace.path().join("derived.docx"), b"derived").expect("derived");
        let derived = record_at(app.path(), prepared)
            .expect("record derived")
            .expect("derived summary");
        let manifest = get_at(
            app.path(),
            workspace.path().to_str().unwrap(),
            &derived.artifact_id,
        )
        .expect("derived manifest");
        assert_eq!(manifest.versions[0].parent, Some(source_revision));
    }

    #[test]
    fn render_attaches_preview_without_creating_a_document_version() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        fs::write(workspace.path().join("report.docx"), b"document").expect("document");
        record_at(
            app.path(),
            record_input(workspace.path(), "request-1", "create", None, "report.docx"),
        )
        .expect("record document");
        fs::write(workspace.path().join("report.png"), b"preview").expect("preview");

        let rendered = record_at(
            app.path(),
            record_input(
                workspace.path(),
                "request-2",
                "render",
                Some("report.docx"),
                "report.png",
            ),
        )
        .expect("record preview")
        .expect("preview summary");

        assert_eq!(rendered.current_version, 1);
        assert_eq!(rendered.preview_count, 1);
        assert_eq!(rendered.artifact_role, "preview");
        assert_eq!(rendered.source_version, Some(1));
        let manifest = get_at(
            app.path(),
            workspace.path().to_str().unwrap(),
            &rendered.artifact_id,
        )
        .expect("manifest");
        assert_eq!(manifest.versions.len(), 1);
        assert_eq!(
            manifest.versions[0].previews[0].workspace_path,
            "report.png"
        );
    }

    #[test]
    fn render_and_validation_stay_attached_to_the_prepared_source_revision() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        let document = workspace.path().join("report.docx");
        fs::write(&document, b"version one").expect("document v1");
        let created = record_at(
            app.path(),
            record_input(workspace.path(), "create", "create", None, "report.docx"),
        )
        .expect("record v1")
        .expect("v1 summary");

        let render = prepare_record_at(
            app.path(),
            record_input(
                workspace.path(),
                "render",
                "render",
                Some("report.docx"),
                "report.png",
            ),
        )
        .expect("prepare render");
        let mut validate = record_input(
            workspace.path(),
            "validate",
            "validate",
            Some("report.docx"),
            "report.docx",
        );
        validate.output_path = None;
        let validate = prepare_record_at(app.path(), validate).expect("prepare validate");

        fs::write(&document, b"version two").expect("document v2");
        record_at(
            app.path(),
            record_input(
                workspace.path(),
                "external",
                "patch",
                Some("report.docx"),
                "report.docx",
            ),
        )
        .expect("record v2");
        fs::write(workspace.path().join("report.png"), b"preview v1").expect("preview");

        let rendered = record_at(app.path(), render)
            .expect("record anchored preview")
            .expect("preview summary");
        assert_eq!(rendered.current_version, 2);
        assert_eq!(rendered.source_version, Some(1));
        record_result_at(app.path(), validate, true, Some(0), r#"{"valid":true}"#, "")
            .expect("record anchored validation");

        let manifest = get_at(
            app.path(),
            workspace.path().to_str().unwrap(),
            &created.artifact_id,
        )
        .expect("manifest");
        assert_eq!(manifest.versions[0].previews.len(), 1);
        assert_eq!(manifest.versions[0].validations.len(), 1);
        assert!(manifest.versions[1].previews.is_empty());
        assert!(manifest.versions[1].validations.is_empty());
    }

    #[test]
    fn render_versions_an_external_source_edit_before_attaching_the_preview() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        let document = workspace.path().join("report.docx");
        fs::write(&document, b"version one").expect("document v1");
        let original = record_at(
            app.path(),
            record_input(workspace.path(), "request-1", "create", None, "report.docx"),
        )
        .expect("record document")
        .expect("artifact summary");
        fs::write(&document, b"external version two").expect("document v2");
        fs::write(workspace.path().join("report.png"), b"preview v2").expect("preview");

        let rendered = record_at(
            app.path(),
            record_input(
                workspace.path(),
                "request-render",
                "render",
                Some("report.docx"),
                "report.png",
            ),
        )
        .expect("record preview")
        .expect("preview summary");

        assert_eq!(rendered.artifact_id, original.artifact_id);
        assert_eq!(rendered.current_version, 2);
        assert_eq!(rendered.preview_count, 1);
        let manifest = get_at(
            app.path(),
            workspace.path().to_str().unwrap(),
            &original.artifact_id,
        )
        .expect("manifest");
        assert_eq!(manifest.versions[0].previews.len(), 0);
        assert_eq!(manifest.versions[1].action, "external-edit");
        assert_eq!(manifest.versions[1].previews.len(), 1);
        assert_eq!(
            manifest.versions[1].parent,
            Some(DocumentArtifactRevisionRef {
                artifact_id: original.artifact_id,
                version: 1,
            })
        );
    }

    #[test]
    fn render_imports_an_untracked_workspace_document() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        fs::write(workspace.path().join("legacy.docx"), b"legacy").expect("document");
        fs::write(workspace.path().join("legacy.html"), b"<p>legacy</p>").expect("preview");

        let rendered = record_at(
            app.path(),
            record_input(
                workspace.path(),
                "request-render",
                "render",
                Some("legacy.docx"),
                "legacy.html",
            ),
        )
        .expect("record preview")
        .expect("preview summary");
        let manifest = get_at(
            app.path(),
            workspace.path().to_str().unwrap(),
            &rendered.artifact_id,
        )
        .expect("manifest");

        assert_eq!(manifest.versions[0].action, "import");
        assert_eq!(manifest.versions[0].provider, "workspace");
        assert_eq!(manifest.versions[0].previews.len(), 1);
    }

    #[test]
    fn validation_results_attach_to_the_current_version_idempotently() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        fs::write(workspace.path().join("report.docx"), b"document").expect("document");
        let created = record_at(
            app.path(),
            record_input(
                workspace.path(),
                "request-create",
                "create",
                None,
                "report.docx",
            ),
        )
        .expect("record document")
        .expect("artifact summary");

        let mut passed = record_input(
            workspace.path(),
            "request-validate-pass",
            "validate",
            Some("report.docx"),
            "report.docx",
        );
        passed.output_path = None;
        let summary = record_result_at(
            app.path(),
            passed.clone(),
            true,
            Some(0),
            r#"{"valid":true,"errors":[]}"#,
            "",
        )
        .expect("record validation")
        .expect("validation summary");
        record_result_at(
            app.path(),
            passed,
            true,
            Some(0),
            r#"{"valid":true,"errors":[]}"#,
            "",
        )
        .expect("repeat validation");

        let mut failed = record_input(
            workspace.path(),
            "request-validate-fail",
            "validate",
            Some("report.docx"),
            "report.docx",
        );
        failed.output_path = None;
        let failed_summary = record_result_at(
            app.path(),
            failed,
            false,
            Some(2),
            "",
            "invalid relationship",
        )
        .expect("record failed validation")
        .expect("failed validation summary");

        assert_eq!(summary.artifact_id, created.artifact_id);
        assert_eq!(summary.validation_count, 1);
        assert_eq!(failed_summary.validation_count, 2);
        assert_eq!(
            failed_summary.latest_validation_status.as_deref(),
            Some("failed")
        );
        let manifest = get_at(
            app.path(),
            workspace.path().to_str().unwrap(),
            &created.artifact_id,
        )
        .expect("manifest");
        let validations = &manifest.versions[0].validations;
        assert_eq!(validations.len(), 2);
        assert_eq!(validations[0].report_format, "json");
        assert_eq!(validations[1].exit_code, Some(2));
        assert_eq!(validations[1].report, "invalid relationship");
    }

    #[test]
    fn list_is_scoped_to_the_canonical_workspace() {
        let app = tempfile::tempdir().expect("app root");
        let first_workspace = tempfile::tempdir().expect("workspace one");
        let second_workspace = tempfile::tempdir().expect("workspace two");
        fs::write(first_workspace.path().join("same.docx"), b"first").expect("first output");
        fs::write(second_workspace.path().join("same.docx"), b"second").expect("second output");
        record_at(
            app.path(),
            record_input(first_workspace.path(), "first", "create", None, "same.docx"),
        )
        .expect("first record");
        record_at(
            app.path(),
            record_input(
                second_workspace.path(),
                "second",
                "create",
                None,
                "same.docx",
            ),
        )
        .expect("second record");

        let first = list_at(app.path(), first_workspace.path().to_str().unwrap()).expect("list");
        assert_eq!(first.artifacts.len(), 1);
        assert_eq!(first.artifacts[0].sha256, to_hex(&Sha256::digest(b"first")));
    }

    #[test]
    fn invalid_manifests_do_not_block_valid_artifacts() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        fs::write(workspace.path().join("report.docx"), b"valid").expect("valid output");
        let valid = record_at(
            app.path(),
            record_input(workspace.path(), "valid", "create", None, "report.docx"),
        )
        .expect("record valid")
        .expect("valid summary");
        let root = artifacts_root(
            app.path(),
            &fs::canonicalize(workspace.path()).expect("canonical workspace"),
        );
        let corrupt_dir = root.join(Uuid::new_v4().to_string());
        fs::create_dir_all(&corrupt_dir).expect("corrupt dir");
        fs::write(corrupt_dir.join(MANIFEST_FILE), b"not json").expect("corrupt manifest");
        let future_dir = root.join(Uuid::new_v4().to_string());
        fs::create_dir_all(&future_dir).expect("future dir");
        let mut future = get_at(
            app.path(),
            workspace.path().to_str().unwrap(),
            &valid.artifact_id,
        )
        .expect("valid manifest");
        future.schema_version = SCHEMA_VERSION + 1;
        fs::write(
            future_dir.join(MANIFEST_FILE),
            serde_json::to_vec(&future).expect("serialize future manifest"),
        )
        .expect("future manifest");

        let listed = list_at(app.path(), workspace.path().to_str().unwrap()).expect("list");
        assert_eq!(listed.artifacts.len(), 1);
        assert_eq!(listed.artifacts[0].artifact_id, valid.artifact_id);
    }

    #[test]
    fn output_must_stay_inside_the_workspace() {
        let app = tempfile::tempdir().expect("app root");
        let workspace = tempfile::tempdir().expect("workspace");
        let outside = tempfile::NamedTempFile::new().expect("outside output");
        let error = record_at(
            app.path(),
            record_input(
                workspace.path(),
                "outside",
                "create",
                None,
                outside.path().to_str().unwrap(),
            ),
        )
        .expect_err("outside output rejected");
        assert!(error.contains("inside the configured workspace"));
    }
}
