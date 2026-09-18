use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::State;

use super::document_artifacts::{
    prepare_office_runtime_artifacts, DocumentArtifactSummary, OfficeArtifactRecordInput,
};
use super::svg_assets;

const SIDECAR_STEM: &str = "arcforge-office-runtime";
const OFFICECLI_STEM: &str = "arcforge-officecli";
const DEFAULT_TIMEOUT_MS: u64 = 180_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const STDOUT_LIMIT_BYTES: usize = 4 * 1024 * 1024;
const STDERR_LIMIT_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub struct OfficeRuntimeRegistry {
    requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl OfficeRuntimeRegistry {
    fn register(&self, request_id: &str, cancelled: Arc<AtomicBool>) -> Result<(), String> {
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "Office Runtime cancellation registry is unavailable".to_string())?;
        if requests.contains_key(request_id) {
            return Err("Office Runtime request_id is already active".to_string());
        }
        requests.insert(request_id.to_string(), cancelled);
        Ok(())
    }

    fn cancel(&self, request_id: &str) -> bool {
        let Ok(requests) = self.requests.lock() else {
            return false;
        };
        let Some(cancelled) = requests.get(request_id) else {
            return false;
        };
        cancelled.store(true, Ordering::SeqCst);
        true
    }

    fn finish(&self, request_id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(request_id);
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeRuntimeRequest {
    request_id: String,
    workdir: String,
    document_type: String,
    action: String,
    spec_path: Option<String>,
    script_path: Option<String>,
    input_path: Option<String>,
    output_path: Option<String>,
    #[serde(default)]
    force: bool,
    timeout_ms: Option<u64>,
    /// Presentation patch: the one page/element to replace, or the edit to revert.
    #[serde(default)]
    edit: Option<PresentationEditRequest>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationEditRequest {
    slide_id: Option<String>,
    element_id: Option<String>,
    /// Replacement markup or JSON passed inline; the bridge stages it as a file for the runtime.
    replacement: Option<String>,
    edit_id: Option<String>,
    /// Edit id to undo instead of applying a replacement.
    revert: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeRuntimeResponse {
    success: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
    timed_out: bool,
    cancelled: bool,
    duration_ms: u64,
    runtime: String,
    runtime_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    artifact: Option<DocumentArtifactSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artifact_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeRuntimeCancelResponse {
    cancelled: bool,
}

#[derive(Debug)]
struct PreparedInvocation {
    request_id: String,
    workdir: PathBuf,
    arguments: Vec<OsString>,
    timeout: Duration,
    backend: RuntimeBackend,
    officecli_output: Option<OfficeCliOutput>,
    input_target: Option<PathBuf>,
    artifact_record: OfficeArtifactRecordInput,
    /// Files staged for this invocation only (for example an inline patch replacement); removed on drop.
    scratch_files: Vec<CleanupFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeBackend {
    ArcForge,
    OfficeCli,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OfficeCliOutput {
    New {
        target: PathBuf,
        expected: TargetState,
    },
    Copy {
        source: PathBuf,
        target: PathBuf,
        expected: TargetState,
    },
}

impl OfficeCliOutput {
    fn target(&self) -> &Path {
        match self {
            Self::New { target, .. } | Self::Copy { target, .. } => target,
        }
    }

    fn expected(&self) -> &TargetState {
        match self {
            Self::New { expected, .. } | Self::Copy { expected, .. } => expected,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TargetState {
    exists: bool,
    size_bytes: u64,
    modified_ns: u128,
    sha256: Option<String>,
    allow_replace: bool,
}

struct RuntimeProgram {
    program: PathBuf,
    prefix_arguments: Vec<OsString>,
    label: String,
}

struct CapturedOutput {
    text: String,
    truncated: bool,
}

#[derive(Debug)]
struct CleanupFile(PathBuf);

impl Drop for CleanupFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn trimmed_required<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(trimmed)
    }
}

fn required_path<'a>(value: &'a Option<String>, label: &str) -> Result<&'a str, String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{label} is required for this Office Runtime action"))
}

fn reject_path(value: &Option<String>, label: &str) -> Result<(), String> {
    if value
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        Err(format!(
            "{label} is not valid for this Office Runtime action"
        ))
    } else {
        Ok(())
    }
}

fn reject_parent_components(raw: &str, label: &str) -> Result<(), String> {
    if Path::new(raw)
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!("{label} must not contain '..' path components"));
    }
    Ok(())
}

fn ensure_extension(path: &Path, expected: &str, label: &str) -> Result<(), String> {
    let actual = path.extension().and_then(OsStr::to_str).unwrap_or_default();
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!("{label} must end with .{expected}"))
    }
}

fn ensure_within_workspace(path: &Path, workspace: &Path, label: &str) -> Result<(), String> {
    if path.starts_with(workspace) {
        Ok(())
    } else {
        Err(format!("{label} must stay inside the configured workspace"))
    }
}

fn absolute_candidate(base: &Path, raw: &str, label: &str) -> Result<PathBuf, String> {
    let raw = trimmed_required(raw, label)?;
    reject_parent_components(raw, label)?;
    let path = Path::new(raw);
    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    })
}

fn resolve_existing_path(
    workspace: &Path,
    base: &Path,
    raw: &str,
    expected_extension: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let candidate = absolute_candidate(base, raw, label)?;
    ensure_extension(&candidate, expected_extension, label)?;
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|error| format!("{label} does not exist or cannot be opened: {error}"))?;
    if !canonical.is_file() {
        return Err(format!("{label} must identify a file"));
    }
    ensure_within_workspace(&canonical, workspace, label)?;
    Ok(canonical)
}

fn resolve_output_path(
    workspace: &Path,
    raw: &str,
    expected_extension: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let candidate = absolute_candidate(workspace, raw, label)?;
    ensure_extension(&candidate, expected_extension, label)?;

    let mut ancestor = candidate.clone();
    let mut missing_segments = Vec::<OsString>::new();
    while !ancestor.exists() {
        let segment = ancestor
            .file_name()
            .ok_or_else(|| format!("{label} has no existing parent directory"))?
            .to_os_string();
        missing_segments.push(segment);
        if !ancestor.pop() {
            return Err(format!("{label} has no existing parent directory"));
        }
    }

    let mut resolved = std::fs::canonicalize(&ancestor)
        .map_err(|error| format!("{label} parent cannot be opened: {error}"))?;
    ensure_within_workspace(&resolved, workspace, label)?;
    if missing_segments.is_empty() && !resolved.is_file() {
        return Err(format!("{label} must identify a file path"));
    }
    if !missing_segments.is_empty() && !resolved.is_dir() {
        return Err(format!("{label} parent must be a directory"));
    }
    for segment in missing_segments.iter().rev() {
        resolved.push(segment);
    }
    ensure_within_workspace(&resolved, workspace, label)?;
    Ok(resolved)
}

fn resolve_word_render_output_path(workspace: &Path, raw: &str) -> Result<PathBuf, String> {
    let candidate = absolute_candidate(workspace, raw, "outputPath")?;
    let extension = candidate
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("html") && !extension.eq_ignore_ascii_case("png") {
        return Err("outputPath must end with .html or .png for Word render".to_string());
    }

    let mut ancestor = candidate.clone();
    let mut missing_segments = Vec::<OsString>::new();
    while !ancestor.exists() {
        let segment = ancestor
            .file_name()
            .ok_or_else(|| "outputPath has no existing parent directory".to_string())?
            .to_os_string();
        missing_segments.push(segment);
        if !ancestor.pop() {
            return Err("outputPath has no existing parent directory".to_string());
        }
    }
    let mut resolved = std::fs::canonicalize(&ancestor)
        .map_err(|error| format!("outputPath parent cannot be opened: {error}"))?;
    ensure_within_workspace(&resolved, workspace, "outputPath")?;
    if missing_segments.is_empty() && !resolved.is_file() {
        return Err("outputPath must identify a file path".to_string());
    }
    if !missing_segments.is_empty() && !resolved.is_dir() {
        return Err("outputPath parent must be a directory".to_string());
    }
    for segment in missing_segments.iter().rev() {
        resolved.push(segment);
    }
    ensure_within_workspace(&resolved, workspace, "outputPath")?;
    Ok(resolved)
}

fn modified_ns(metadata: &std::fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn hash_path(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open OfficeCLI target state: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read OfficeCLI target state: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn capture_target_state(target: &Path, allow_replace: bool) -> Result<TargetState, String> {
    let before = match std::fs::metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TargetState {
                exists: false,
                size_bytes: 0,
                modified_ns: 0,
                sha256: None,
                allow_replace,
            });
        }
        Err(error) => return Err(format!("Failed to inspect OfficeCLI outputPath: {error}")),
    };
    if !before.is_file() {
        return Err("OfficeCLI outputPath must identify a file".to_string());
    }
    let sha256 = hash_path(target)?;
    let after = std::fs::metadata(target)
        .map_err(|error| format!("OfficeCLI outputPath changed while it was inspected: {error}"))?;
    if before.len() != after.len() || modified_ns(&before) != modified_ns(&after) {
        return Err(
            "OfficeCLI outputPath changed while it was inspected; retry the operation".to_string(),
        );
    }
    Ok(TargetState {
        exists: true,
        size_bytes: after.len(),
        modified_ns: modified_ns(&after),
        sha256: Some(sha256),
        allow_replace,
    })
}

const PRESENTATION_MAX_SVG_BYTES: u64 = 2 * 1024 * 1024;
const PRESENTATION_MAX_SLIDES: usize = 200;
const PRESENTATION_MAX_ASSETS: usize = 500;

fn is_image_asset_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp"
    )
}

/// Reject SVG pages that could pull in external data or scripts before the runtime parses
/// them. The Python converter enforces the full element subset; this is the outer gate.
fn reject_unsafe_svg_markup(svg: &str, label: &str) -> Result<(), String> {
    let lowered = svg.to_ascii_lowercase();
    for (needle, reason) in [
        ("href=", "href attributes (use data-asset for pictures)"),
        ("xlink:", "xlink references"),
        ("<foreignobject", "foreignObject"),
        ("<script", "script"),
        ("<style", "style sheets"),
        ("<use", "use references"),
        ("<!doctype", "DOCTYPE declarations"),
        ("<!entity", "entity declarations"),
        ("data:", "data URIs"),
        ("url(http", "remote URLs"),
        ("url('http", "remote URLs"),
        ("url(\"http", "remote URLs"),
    ] {
        if lowered.contains(needle) {
            return Err(format!("{label} must not contain {reason}"));
        }
    }
    Ok(())
}

fn is_valid_asset_id(asset_id: &str) -> bool {
    !asset_id.is_empty()
        && asset_id.len() <= 64
        && asset_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        && asset_id != "."
        && asset_id != ".."
}

fn validate_template_slide_edits(slide: &serde_json::Value, index: usize) -> Result<(), String> {
    for field in ["text_edits", "table_edits"] {
        let Some(edits) = slide.get(field) else { continue };
        let label = format!("specPath slides[{index}].{field}");
        if slide.get("source_slide").is_none() {
            return Err(format!("{label} requires source_slide"));
        }
        let edits = edits.as_array().ok_or_else(|| format!("{label} must be an array"))?;
        for (edit_index, edit) in edits.iter().enumerate() {
            let label = format!("{label}[{edit_index}]");
            let shape_id = edit.get("shape_id").and_then(serde_json::Value::as_u64)
                .filter(|id| *id > 0)
                .ok_or_else(|| format!("{label}.shape_id must be a positive integer from inspect"))?;
            if let Some(path) = edit.get("shape_path") {
                let valid = path.as_array().is_some_and(|parts| {
                    !parts.is_empty()
                        && parts.iter().all(|part| part.as_u64().is_some_and(|id| id > 0))
                        && parts.last().and_then(serde_json::Value::as_u64) == Some(shape_id)
                });
                if !valid {
                    return Err(format!("{label}.shape_path must be a non-empty array of positive ids ending in shape_id"));
                }
            }
            if field == "text_edits" {
                if !edit.get("text").is_some_and(serde_json::Value::is_string) {
                    return Err(format!("{label}.text must be a string"));
                }
            } else {
                let rows = edit.get("rows").and_then(serde_json::Value::as_array)
                    .filter(|rows| !rows.is_empty())
                    .ok_or_else(|| format!("{label}.rows must be a non-empty rectangular array of strings"))?;
                let width = rows[0].as_array().map_or(0, Vec::len);
                if width == 0 || !rows.iter().all(|row| {
                    row.as_array().is_some_and(|cells| {
                        cells.len() == width && cells.iter().all(serde_json::Value::is_string)
                    })
                }) {
                    return Err(format!("{label}.rows must be a non-empty rectangular array of strings"));
                }
            }
        }
    }
    Ok(())
}

/// Validate a schema_version 3 manifest. SVG assets are normalized into
/// `<manifest dir>/.arcforge-assets/` on the way; the cache directory is returned so it can be
/// handed to the runtime with `--asset-cache`.
fn validate_svg_deck_manifest(
    value: &serde_json::Value,
    spec_dir: &Path,
    workspace: &Path,
    template_override: bool,
) -> Result<Option<PathBuf>, String> {
    let mut asset_cache: Option<PathBuf> = None;
    if let Some(mode) = value.get("mode").and_then(serde_json::Value::as_str) {
        if !matches!(mode, "blank" | "template") {
            return Err("specPath mode must be blank or template".to_string());
        }
    }
    if let Some(stage) = value.get("stage").and_then(serde_json::Value::as_str) {
        if !matches!(stage, "plan" | "design") {
            return Err("specPath stage must be plan or design".to_string());
        }
    }
    if let Some(template) = value.get("template") {
        let Some(template) = template.as_str() else {
            return Err("specPath template must be a workspace .pptx path".to_string());
        };
        resolve_existing_path(workspace, spec_dir, template, "pptx", "specPath template")?;
    }
    if let Some(assets) = value.get("assets").filter(|value| !value.is_null()) {
        let Some(assets) = assets.as_object() else {
            return Err(
                "specPath assets must be an object mapping ids to workspace image paths"
                    .to_string(),
            );
        };
        if assets.len() > PRESENTATION_MAX_ASSETS {
            return Err(format!(
                "specPath declares more than {PRESENTATION_MAX_ASSETS} assets"
            ));
        }
        for (asset_id, raw) in assets {
            let Some(raw) = raw.as_str() else {
                return Err(format!(
                    "specPath assets.{asset_id} must be a workspace image or SVG path"
                ));
            };
            let extension = Path::new(raw)
                .extension()
                .and_then(OsStr::to_str)
                .unwrap_or_default();
            let label = format!("specPath assets.{asset_id}");
            if extension.eq_ignore_ascii_case("svg") {
                if !is_valid_asset_id(asset_id) {
                    return Err(format!(
                        "{label}: asset ids must use letters, digits, '_', '-' or '.' (max 64 chars)"
                    ));
                }
                let path = resolve_existing_path(workspace, spec_dir, raw, extension, &label)?;
                let cache_root = spec_dir.join(svg_assets::ASSET_CACHE_DIR_NAME);
                svg_assets::prepare_svg_asset(asset_id, &path, &cache_root, &label)?;
                asset_cache = Some(cache_root);
                continue;
            }
            if !is_image_asset_extension(extension) {
                return Err(format!(
                    "{label} must point to a PNG, JPEG, GIF, BMP, WebP, or SVG file"
                ));
            }
            resolve_existing_path(workspace, spec_dir, raw, extension, &label)?;
        }
    }
    let Some(slides) = value.get("slides").and_then(serde_json::Value::as_array) else {
        return Err(
            "specPath slides must be a non-empty array of entries with slide_id and svg or source_slide".to_string(),
        );
    };
    if slides.is_empty() {
        return Err("specPath slides must not be empty".to_string());
    }
    if slides.len() > PRESENTATION_MAX_SLIDES {
        return Err(format!(
            "specPath declares more than {PRESENTATION_MAX_SLIDES} slides"
        ));
    }
    for (index, slide) in slides.iter().enumerate() {
        if !slide.is_object() {
            return Err(format!("specPath slides[{index}] must be an object"));
        }
        if let Some(source_slide) = slide.get("source_slide") {
            if !source_slide.as_u64().is_some_and(|number| number > 0) {
                return Err(format!("specPath slides[{index}].source_slide must be a positive integer (1-based template page)"));
            }
            if !template_override && value.get("mode").and_then(serde_json::Value::as_str) != Some("template") {
                return Err(format!("specPath slides[{index}].source_slide requires template mode or inputPath"));
            }
        }
        if let Some(layout) = slide.get("layout") {
            if !(layout.as_str().is_some_and(|name| !name.trim().is_empty()) || layout.as_u64().is_some()) {
                return Err(format!("specPath slides[{index}].layout must be a non-empty name or a zero-based layout index"));
            }
        }
        validate_template_slide_edits(slide, index)?;
        let svg = match slide.get("svg") {
            None if slide.get("source_slide").is_some() => continue,
            Some(svg) => svg.as_str().filter(|path| !path.trim().is_empty())
                .ok_or_else(|| format!("specPath slides[{index}].svg must be a non-empty workspace SVG path"))?,
            None => return Err(format!("specPath slides[{index}].svg is required without source_slide")),
        };
        let label = format!("slides[{index}].svg");
        let path = resolve_existing_path(workspace, spec_dir, svg, "svg", &label)?;
        let metadata = std::fs::metadata(&path)
            .map_err(|error| format!("{label} could not be read: {error}"))?;
        if metadata.len() > PRESENTATION_MAX_SVG_BYTES {
            return Err(format!("{label} exceeds the 2 MiB SVG page limit"));
        }
        let svg_text = std::fs::read_to_string(&path)
            .map_err(|error| format!("{label} must be UTF-8 text: {error}"))?;
        reject_unsafe_svg_markup(&svg_text, &label)?;
    }
    Ok(asset_cache)
}

fn validate_presentation_assets(
    spec_path: &Path,
    workspace: &Path,
    template_override: bool,
) -> Result<Option<PathBuf>, String> {
    let raw = std::fs::read_to_string(spec_path)
        .map_err(|error| format!("specPath could not be read: {error}"))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("specPath is not valid JSON: {error}"))?;
    let spec_dir = spec_path.parent().unwrap_or(workspace);
    let schema_version = value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1);
    if schema_version >= 3 {
        return validate_svg_deck_manifest(&value, spec_dir, workspace, template_override);
    }
    let Some(slides) = value.get("slides").and_then(serde_json::Value::as_array) else {
        return Ok(None);
    };
    for (index, slide) in slides.iter().enumerate() {
        let Some(image) = slide.get("image").and_then(serde_json::Value::as_str) else {
            continue;
        };
        resolve_existing_path(
            workspace,
            spec_dir,
            image,
            Path::new(image)
                .extension()
                .and_then(OsStr::to_str)
                .unwrap_or_default(),
            &format!("slides[{index}].image"),
        )?;
    }
    Ok(None)
}

fn presentation_spec_is_svg_deck(spec_path: &Path) -> bool {
    std::fs::read_to_string(spec_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| {
            value
                .get("schema_version")
                .and_then(serde_json::Value::as_u64)
        })
        .is_some_and(|version| version >= 3)
}

/// Count `ppt/slides/slideN.xml` parts so a PNG preview can request every page explicitly.
fn count_pptx_slides(path: &Path) -> Result<usize, String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("inputPath could not be opened: {error}"))?;
    let archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("inputPath is not a valid PPTX package: {error}"))?;
    let count = archive
        .file_names()
        .filter(|name| {
            name.strip_prefix("ppt/slides/slide")
                .and_then(|rest| rest.strip_suffix(".xml"))
                .is_some_and(|digits| {
                    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
                })
        })
        .count();
    if count == 0 {
        return Err("inputPath does not contain any slides".to_string());
    }
    Ok(count)
}

#[derive(Debug, Default)]
struct PresentationRenderOptions {
    pages: Option<String>,
    grid: bool,
}

fn parse_presentation_render_options(
    spec_path: &Path,
) -> Result<PresentationRenderOptions, String> {
    let raw = std::fs::read_to_string(spec_path)
        .map_err(|error| format!("specPath could not be read: {error}"))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("specPath is not valid JSON: {error}"))?;
    let Some(object) = value.as_object() else {
        return Err("specPath render options must be a JSON object".to_string());
    };
    for key in object.keys() {
        if !matches!(key.as_str(), "pages" | "grid") {
            return Err(format!("specPath render option '{key}' is not supported"));
        }
    }
    let mut options = PresentationRenderOptions::default();
    if let Some(pages) = object.get("pages") {
        let pages = match pages {
            serde_json::Value::String(value) => value.trim().to_string(),
            serde_json::Value::Number(value) => value.to_string(),
            serde_json::Value::Array(values) => values
                .iter()
                .map(|value| {
                    value
                        .as_u64()
                        .filter(|page| *page >= 1)
                        .map(|page| page.to_string())
                        .ok_or_else(|| {
                            "specPath pages entries must be positive integers".to_string()
                        })
                })
                .collect::<Result<Vec<_>, _>>()?
                .join(","),
            _ => {
                return Err(
                    "specPath pages must be a page range string or an array of page numbers"
                        .to_string(),
                )
            }
        };
        if pages.is_empty()
            || !pages.split(',').all(|part| {
                let mut bounds = part.split('-');
                let start = bounds.next().unwrap_or_default();
                let end = bounds.next();
                bounds.next().is_none()
                    && !start.is_empty()
                    && start.bytes().all(|byte| byte.is_ascii_digit())
                    && start != "0"
                    && end.is_none_or(|end| {
                        !end.is_empty()
                            && end.bytes().all(|byte| byte.is_ascii_digit())
                            && end != "0"
                    })
            })
        {
            return Err("specPath pages must look like \"2\", \"1-3\", or \"1,3,5\"".to_string());
        }
        options.pages = Some(pages);
    }
    if let Some(grid) = object.get("grid") {
        options.grid = grid
            .as_bool()
            .ok_or_else(|| "specPath grid must be true or false".to_string())?;
    }
    Ok(options)
}

fn resolve_officecli_input(
    workspace: &Path,
    raw: &str,
    expected_extension: &str,
    label: &str,
) -> Result<PathBuf, String> {
    resolve_existing_path(workspace, workspace, raw, expected_extension, label)
}

fn push_officecli_json(arguments: &mut Vec<OsString>) {
    arguments.push(OsString::from("--json"));
}

fn officecli_batch_field_allowed(command: &str, field: &str) -> bool {
    if field.eq_ignore_ascii_case("command") || field.eq_ignore_ascii_case("op") {
        return true;
    }
    match command {
        "set" => matches!(field, "path" | "props"),
        "add" => matches!(
            field,
            "path" | "parent" | "type" | "props" | "index" | "after" | "before"
        ),
        "remove" => field == "path",
        "move" => matches!(field, "path" | "to" | "index" | "after" | "before"),
        "swap" => matches!(field, "path" | "path2" | "to"),
        "get" => matches!(field, "path" | "depth"),
        "query" => matches!(field, "selector" | "path" | "text"),
        _ => false,
    }
}

fn officecli_prop_can_read_external_data(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "src"
            | "source"
            | "file"
            | "filename"
            | "filepath"
            | "path"
            | "from"
            | "image"
            | "picture"
            | "video"
            | "audio"
            | "ole"
            | "model3d"
            | "template"
            | "url"
            | "uri"
    )
}

fn validate_officecli_props(props: &serde_json::Value, index: usize) -> Result<(), String> {
    let keys = match props {
        serde_json::Value::Object(values) => values.keys().map(String::as_str).collect::<Vec<_>>(),
        serde_json::Value::Array(values) => {
            let mut keys = Vec::with_capacity(values.len());
            for value in values {
                let entry = value.as_str().ok_or_else(|| {
                    format!("specPath operation {index} props entries must be key=value strings")
                })?;
                let (key, _) = entry.split_once('=').ok_or_else(|| {
                    format!("specPath operation {index} props entries must be key=value strings")
                })?;
                keys.push(key);
            }
            keys
        }
        _ => {
            return Err(format!(
                "specPath operation {index} props must be an object or key=value array"
            ))
        }
    };
    for key in keys {
        if officecli_prop_can_read_external_data(key) {
            return Err(format!(
                "specPath operation {index} property '{key}' may read external data and is not allowed"
            ));
        }
    }
    Ok(())
}

fn validate_officecli_batch_spec(spec_path: &Path) -> Result<(), String> {
    const MAX_BATCH_BYTES: u64 = 4 * 1024 * 1024;
    let metadata = std::fs::metadata(spec_path)
        .map_err(|error| format!("specPath metadata could not be read: {error}"))?;
    if metadata.len() > MAX_BATCH_BYTES {
        return Err("specPath exceeds the 4 MiB OfficeCLI batch limit".to_string());
    }
    let raw = std::fs::read_to_string(spec_path)
        .map_err(|error| format!("specPath could not be read: {error}"))?;
    if raw.contains('\0') {
        return Err("specPath contains a NUL byte".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("specPath is not valid JSON: {error}"))?;
    let Some(items) = value.as_array() else {
        return Err("specPath must contain an OfficeCLI batch JSON array".to_string());
    };
    if items.len() > 10_000 {
        return Err("specPath contains too many OfficeCLI batch operations".to_string());
    }
    for (index, item) in items.iter().enumerate() {
        let Some(object) = item.as_object() else {
            return Err(format!("specPath operation {index} must be an object"));
        };
        if object.contains_key("command") && object.contains_key("op") {
            return Err(format!(
                "specPath operation {index} must not provide both command and op"
            ));
        }
        let command = object
            .get("command")
            .or_else(|| object.get("op"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("specPath operation {index} requires command"))?;
        let command = command.to_ascii_lowercase();
        if !matches!(
            command.as_str(),
            "set" | "add" | "remove" | "move" | "swap" | "get" | "query"
        ) {
            return Err(format!(
                "specPath operation {index} uses unsupported or unsafe OfficeCLI command '{command}'"
            ));
        }
        for field in object.keys() {
            let normalized_field = field.to_ascii_lowercase();
            if field != &normalized_field {
                return Err(format!(
                    "specPath operation {index} field '{field}' must use canonical lowercase spelling"
                ));
            }
            if !officecli_batch_field_allowed(&command, &normalized_field) {
                return Err(format!(
                    "specPath operation {index} field '{field}' is not allowed for OfficeCLI {command}"
                ));
            }
        }
        if object.get("from").is_some_and(|value| !value.is_null()) {
            return Err(format!(
                "specPath operation {index} field 'from' may read external data and is not allowed"
            ));
        }
        if let Some(element_type) = object.get("type").and_then(serde_json::Value::as_str) {
            if matches!(
                element_type.trim().to_ascii_lowercase().as_str(),
                "image" | "picture" | "ole" | "video" | "audio" | "model3d" | "diagram"
            ) {
                return Err(format!(
                    "specPath operation {index} type '{element_type}' may read external data and is not allowed"
                ));
            }
        }
        if let Some(props) = object.get("props") {
            validate_officecli_props(props, index)?;
        }
    }
    Ok(())
}

fn push_path_argument(arguments: &mut Vec<OsString>, flag: &str, path: PathBuf) {
    arguments.push(OsString::from(flag));
    arguments.push(path.into_os_string());
}

fn prepare_invocation(input: OfficeRuntimeRequest) -> Result<PreparedInvocation, String> {
    let request_id = trimmed_required(&input.request_id, "requestId")?;
    if request_id.len() > 128
        || !request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("requestId must contain only letters, digits, '-' or '_'".to_string());
    }

    let workdir_raw = trimmed_required(&input.workdir, "workdir")?;
    let workspace = std::fs::canonicalize(workdir_raw)
        .map_err(|error| format!("workdir does not exist or cannot be opened: {error}"))?;
    if !workspace.is_dir() {
        return Err("workdir must identify a directory".to_string());
    }

    let document_type = trimmed_required(&input.document_type, "documentType")?.to_lowercase();
    let action = trimmed_required(&input.action, "action")?.to_lowercase();
    let mut backend = RuntimeBackend::ArcForge;
    let mut arguments = vec![OsString::from(&document_type), OsString::from(&action)];
    let mut officecli_output = None;
    let mut input_target = None;
    let mut scratch_files = Vec::new();
    let mut artifact_input_path = input.input_path.clone();

    match (document_type.as_str(), action.as_str()) {
        ("spreadsheet", "create") => {
            reject_path(&input.input_path, "inputPath")?;
            reject_path(&input.script_path, "scriptPath")?;
            let spec = resolve_existing_path(
                &workspace,
                &workspace,
                required_path(&input.spec_path, "specPath")?,
                "json",
                "specPath",
            )?;
            let output = resolve_output_path(
                &workspace,
                required_path(&input.output_path, "outputPath")?,
                "xlsx",
                "outputPath",
            )?;
            push_path_argument(&mut arguments, "--spec", spec);
            push_path_argument(&mut arguments, "--output", output);
        }
        ("spreadsheet", "patch") => {
            reject_path(&input.script_path, "scriptPath")?;
            let workbook = resolve_existing_path(
                &workspace,
                &workspace,
                required_path(&input.input_path, "inputPath")?,
                "xlsx",
                "inputPath",
            )?;
            let spec = resolve_existing_path(
                &workspace,
                &workspace,
                required_path(&input.spec_path, "specPath")?,
                "json",
                "specPath",
            )?;
            let output = resolve_output_path(
                &workspace,
                required_path(&input.output_path, "outputPath")?,
                "xlsx",
                "outputPath",
            )?;
            input_target = Some(workbook.clone());
            push_path_argument(&mut arguments, "--input", workbook);
            push_path_argument(&mut arguments, "--spec", spec);
            push_path_argument(&mut arguments, "--output", output);
        }
        ("spreadsheet", "code") => {
            reject_path(&input.spec_path, "specPath")?;
            if let Some(raw_input) = input
                .input_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let workbook =
                    resolve_existing_path(&workspace, &workspace, raw_input, "xlsx", "inputPath")?;
                input_target = Some(workbook.clone());
                push_path_argument(&mut arguments, "--input", workbook);
            }
            let script = resolve_existing_path(
                &workspace,
                &workspace,
                required_path(&input.script_path, "scriptPath")?,
                "py",
                "scriptPath",
            )?;
            let output = resolve_output_path(
                &workspace,
                required_path(&input.output_path, "outputPath")?,
                "xlsx",
                "outputPath",
            )?;
            push_path_argument(&mut arguments, "--script", script);
            push_path_argument(&mut arguments, "--output", output);
        }
        ("spreadsheet", "inspect") => {
            reject_path(&input.spec_path, "specPath")?;
            reject_path(&input.script_path, "scriptPath")?;
            reject_path(&input.output_path, "outputPath")?;
            if input.force {
                return Err("force is not valid for inspect".to_string());
            }
            let workbook = resolve_existing_path(
                &workspace,
                &workspace,
                required_path(&input.input_path, "inputPath")?,
                "xlsx",
                "inputPath",
            )?;
            push_path_argument(&mut arguments, "--input", workbook);
        }
        ("presentation", "create") => {
            reject_path(&input.script_path, "scriptPath")?;
            let spec = resolve_existing_path(
                &workspace,
                &workspace,
                required_path(&input.spec_path, "specPath")?,
                "json",
                "specPath",
            )?;
            let asset_cache = validate_presentation_assets(&spec, &workspace,
                input.input_path.as_deref().is_some_and(|path| !path.trim().is_empty()))?;
            let output = resolve_output_path(
                &workspace,
                required_path(&input.output_path, "outputPath")?,
                "pptx",
                "outputPath",
            )?;
            push_path_argument(&mut arguments, "--spec", spec.clone());
            push_path_argument(&mut arguments, "--output", output);
            if let Some(asset_cache) = asset_cache {
                push_path_argument(&mut arguments, "--asset-cache", asset_cache);
            }
            if let Some(raw_template) = input
                .input_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if !presentation_spec_is_svg_deck(&spec) {
                    return Err(
                        "inputPath (template PPTX) is only supported with a schema_version 3 SVG deck manifest"
                            .to_string(),
                    );
                }
                let template = resolve_existing_path(
                    &workspace,
                    &workspace,
                    raw_template,
                    "pptx",
                    "inputPath",
                )?;
                input_target = Some(template.clone());
                push_path_argument(&mut arguments, "--template", template);
            }
        }
        ("presentation", "patch") => {
            reject_path(&input.script_path, "scriptPath")?;
            let spec = resolve_existing_path(
                &workspace,
                &workspace,
                required_path(&input.spec_path, "specPath")?,
                "json",
                "specPath",
            )?;
            if !presentation_spec_is_svg_deck(&spec) {
                return Err(
                    "Presentation patch requires a schema_version 3 SVG deck manifest".to_string(),
                );
            }
            let template_override = input
                .input_path
                .as_deref()
                .is_some_and(|path| !path.trim().is_empty());
            let asset_cache = validate_presentation_assets(&spec, &workspace, template_override)?;
            // A patch rewrites the deck that was built from this manifest; it never creates a new file.
            let output = resolve_existing_path(
                &workspace,
                &workspace,
                required_path(&input.output_path, "outputPath")?,
                "pptx",
                "outputPath",
            )?;
            let edit = input.edit.as_ref().ok_or_else(|| {
                "presentation patch requires edit.slideId with edit.replacement, or edit.revert".to_string()
            })?;
            let link = find_deck_manifest(&workspace, &output, None)?;
            if !same_file(&link.spec, &spec) {
                return Err("Presentation patch must use the manifest linked to this output deck".to_string());
            }
            push_path_argument(&mut arguments, "--workspace", workspace.clone());
            push_path_argument(&mut arguments, "--spec", spec);
            push_path_argument(&mut arguments, "--output", output);
            if let Some(asset_cache) = asset_cache {
                push_path_argument(&mut arguments, "--asset-cache", asset_cache);
            }
            if let Some(raw_template) = input
                .input_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let template = resolve_existing_path(
                    &workspace,
                    &workspace,
                    raw_template,
                    "pptx",
                    "inputPath",
                )?;
                if !link.template.as_deref().is_some_and(|original| same_file(original, &template)) {
                    return Err("Presentation patch must use the original linked template".to_string());
                }
                push_path_argument(&mut arguments, "--template", template);
            } else if let Some(template) = link.template {
                push_path_argument(&mut arguments, "--template", template);
            }
            // The template is a read-only base, not the document being revised.
            artifact_input_path = None;
            let revert = edit.revert.as_deref().map(str::trim).filter(|value| !value.is_empty());
            let replacement = edit.replacement.as_deref().filter(|value| !value.trim().is_empty());
            let slide_id = edit.slide_id.as_deref().map(str::trim).filter(|value| !value.is_empty());
            if let Some(slide_id) = slide_id {
                validate_edit_identifier(slide_id, "edit.slideId", true)?;
                arguments.push(OsString::from("--slide-id"));
                arguments.push(OsString::from(slide_id));
            }
            if let Some(edit_id) = edit.edit_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                validate_edit_identifier(edit_id, "edit.editId", false)?;
                arguments.push(OsString::from("--edit-id"));
                arguments.push(OsString::from(edit_id));
            }
            match (revert, replacement) {
                (Some(revert_id), None) => {
                    validate_edit_identifier(revert_id, "edit.revert", false)?;
                    if edit.element_id.as_deref().is_some_and(|value| !value.trim().is_empty()) {
                        return Err("edit.elementId is not valid together with edit.revert".to_string());
                    }
                    arguments.push(OsString::from("--revert"));
                    arguments.push(OsString::from(revert_id));
                }
                (None, Some(replacement)) => {
                    if slide_id.is_none() {
                        return Err("presentation patch requires edit.slideId".to_string());
                    }
                    if let Some(element_id) = edit.element_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                        validate_element_identifier(element_id)?;
                        arguments.push(OsString::from("--element-id"));
                        arguments.push(OsString::from(element_id));
                    }
                    if replacement.len() as u64 > PRESENTATION_MAX_SVG_BYTES {
                        return Err("edit.replacement exceeds the 2 MiB page limit".to_string());
                    }
                    if replacement.trim_start().starts_with('<') {
                        reject_unsafe_svg_markup(replacement, "edit.replacement")?;
                    }
                    let staged = stage_patch_replacement(request_id, replacement)?;
                    push_path_argument(&mut arguments, "--replacement", staged.0.clone());
                    scratch_files.push(staged);
                }
                (Some(_), Some(_)) => {
                    return Err("edit.replacement and edit.revert are mutually exclusive".to_string())
                }
                (None, None) => {
                    return Err("presentation patch requires edit.replacement or edit.revert".to_string())
                }
            }
        }
        ("presentation", "validate") => {
            reject_path(&input.script_path, "scriptPath")?;
            reject_path(&input.output_path, "outputPath")?;
            if input.force {
                return Err("force is not valid for validate".to_string());
            }
            let spec = resolve_existing_path(
                &workspace,
                &workspace,
                required_path(&input.spec_path, "specPath")?,
                "json",
                "specPath",
            )?;
            if !presentation_spec_is_svg_deck(&spec) {
                return Err(
                    "Presentation validate requires a schema_version 3 SVG deck manifest"
                        .to_string(),
                );
            }
            let asset_cache = validate_presentation_assets(&spec, &workspace,
                input.input_path.as_deref().is_some_and(|path| !path.trim().is_empty()))?;
            push_path_argument(&mut arguments, "--spec", spec);
            if let Some(asset_cache) = asset_cache {
                push_path_argument(&mut arguments, "--asset-cache", asset_cache);
            }
            if let Some(raw_template) = input
                .input_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let template = resolve_existing_path(
                    &workspace,
                    &workspace,
                    raw_template,
                    "pptx",
                    "inputPath",
                )?;
                input_target = Some(template.clone());
                push_path_argument(&mut arguments, "--template", template);
            }
        }
        ("presentation", "inspect") => {
            reject_path(&input.spec_path, "specPath")?;
            reject_path(&input.script_path, "scriptPath")?;
            reject_path(&input.output_path, "outputPath")?;
            if input.force {
                return Err("force is not valid for inspect".to_string());
            }
            let presentation = resolve_existing_path(
                &workspace,
                &workspace,
                required_path(&input.input_path, "inputPath")?,
                "pptx",
                "inputPath",
            )?;
            input_target = Some(presentation.clone());
            push_path_argument(&mut arguments, "--input", presentation);
        }
        ("presentation", "render") => {
            reject_path(&input.script_path, "scriptPath")?;
            let presentation = resolve_existing_path(
                &workspace,
                &workspace,
                required_path(&input.input_path, "inputPath")?,
                "pptx",
                "inputPath",
            )?;
            let output_raw = required_path(&input.output_path, "outputPath")?;
            let output_extension = Path::new(output_raw)
                .extension()
                .and_then(OsStr::to_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            input_target = Some(presentation.clone());
            match output_extension.as_str() {
                "pdf" => {
                    reject_path(&input.spec_path, "specPath")?;
                    let output = resolve_output_path(&workspace, output_raw, "pdf", "outputPath")?;
                    push_path_argument(&mut arguments, "--input", presentation);
                    push_path_argument(&mut arguments, "--output", output);
                }
                "png" => {
                    let output = resolve_output_path(&workspace, output_raw, "png", "outputPath")?;
                    if output.exists() && !input.force {
                        return Err(
                            "outputPath already exists; set force=true to overwrite it".to_string(),
                        );
                    }
                    let options = match input
                        .spec_path
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        Some(raw_spec) => {
                            let spec = resolve_existing_path(
                                &workspace,
                                &workspace,
                                raw_spec,
                                "json",
                                "specPath",
                            )?;
                            parse_presentation_render_options(&spec)?
                        }
                        None => PresentationRenderOptions::default(),
                    };
                    let slide_count = count_pptx_slides(&presentation)?;
                    let (pages, grid) = match options.pages {
                        Some(pages) => (pages, options.grid),
                        None => (format!("1-{slide_count}"), slide_count > 1 || options.grid),
                    };
                    officecli_output = Some(OfficeCliOutput::New {
                        expected: capture_target_state(&output, input.force)?,
                        target: output.clone(),
                    });
                    arguments = vec![
                        OsString::from("presentation"),
                        OsString::from("render-png"),
                        OsString::from("--input"),
                        presentation.into_os_string(),
                        OsString::from("--pages"),
                        OsString::from(pages),
                    ];
                    if grid {
                        arguments.push(OsString::from("--grid"));
                    }
                    push_path_argument(&mut arguments, "--output", output);
                }
                _ => {
                    return Err(
                        "outputPath must end with .pdf (LibreOffice) or .png (OfficeCLI page preview) for presentation render"
                            .to_string(),
                    )
                }
            }
        }
        ("word", "create") => {
            backend = RuntimeBackend::OfficeCli;
            reject_path(&input.spec_path, "specPath")?;
            reject_path(&input.script_path, "scriptPath")?;
            reject_path(&input.input_path, "inputPath")?;
            let output = resolve_output_path(
                &workspace,
                required_path(&input.output_path, "outputPath")?,
                "docx",
                "outputPath",
            )?;
            if output.exists() && !input.force {
                return Err("outputPath already exists; set force=true to overwrite it".to_string());
            }
            officecli_output = Some(OfficeCliOutput::New {
                expected: capture_target_state(&output, input.force)?,
                target: output.clone(),
            });
            arguments = vec![OsString::from("create"), output.into_os_string()];
            push_officecli_json(&mut arguments);
        }
        ("word", "patch") => {
            backend = RuntimeBackend::OfficeCli;
            reject_path(&input.script_path, "scriptPath")?;
            let input_doc = resolve_officecli_input(
                &workspace,
                required_path(&input.input_path, "inputPath")?,
                "docx",
                "inputPath",
            )?;
            let batch = resolve_officecli_input(
                &workspace,
                required_path(&input.spec_path, "specPath")?,
                "json",
                "specPath",
            )?;
            validate_officecli_batch_spec(&batch)?;
            let output = resolve_output_path(
                &workspace,
                required_path(&input.output_path, "outputPath")?,
                "docx",
                "outputPath",
            )?;
            if output.exists() && !input.force && output != input_doc {
                return Err("outputPath already exists; set force=true to overwrite it".to_string());
            }
            if output == input_doc && !input.force {
                return Err("patching inputPath in place requires force=true".to_string());
            }
            input_target = Some(input_doc.clone());
            officecli_output = Some(OfficeCliOutput::Copy {
                source: input_doc,
                expected: capture_target_state(&output, input.force)?,
                target: output.clone(),
            });
            arguments = vec![OsString::from("batch"), output.into_os_string()];
            push_path_argument(&mut arguments, "--input", batch);
            push_officecli_json(&mut arguments);
        }
        ("word", "inspect") => {
            backend = RuntimeBackend::OfficeCli;
            reject_path(&input.spec_path, "specPath")?;
            reject_path(&input.script_path, "scriptPath")?;
            reject_path(&input.output_path, "outputPath")?;
            if input.force {
                return Err("force is not valid for inspect".to_string());
            }
            let document = resolve_officecli_input(
                &workspace,
                required_path(&input.input_path, "inputPath")?,
                "docx",
                "inputPath",
            )?;
            input_target = Some(document.clone());
            arguments = vec![
                OsString::from("view"),
                document.into_os_string(),
                OsString::from("outline"),
            ];
            push_officecli_json(&mut arguments);
        }
        ("word", "validate") => {
            backend = RuntimeBackend::OfficeCli;
            reject_path(&input.spec_path, "specPath")?;
            reject_path(&input.script_path, "scriptPath")?;
            reject_path(&input.output_path, "outputPath")?;
            if input.force {
                return Err("force is not valid for validate".to_string());
            }
            let document = resolve_officecli_input(
                &workspace,
                required_path(&input.input_path, "inputPath")?,
                "docx",
                "inputPath",
            )?;
            input_target = Some(document.clone());
            arguments = vec![OsString::from("validate"), document.into_os_string()];
            push_officecli_json(&mut arguments);
        }
        ("word", "render") => {
            backend = RuntimeBackend::OfficeCli;
            reject_path(&input.spec_path, "specPath")?;
            reject_path(&input.script_path, "scriptPath")?;
            let document = resolve_officecli_input(
                &workspace,
                required_path(&input.input_path, "inputPath")?,
                "docx",
                "inputPath",
            )?;
            let output_raw = required_path(&input.output_path, "outputPath")?;
            let output = resolve_word_render_output_path(&workspace, output_raw)?;
            if output.exists() && !input.force {
                return Err("outputPath already exists; set force=true to overwrite it".to_string());
            }
            officecli_output = Some(OfficeCliOutput::New {
                expected: capture_target_state(&output, input.force)?,
                target: output.clone(),
            });
            let mode = if output
                .extension()
                .and_then(OsStr::to_str)
                .is_some_and(|value| value.eq_ignore_ascii_case("png"))
            {
                "screenshot"
            } else {
                "html"
            };
            input_target = Some(document.clone());
            arguments = vec![
                OsString::from("view"),
                document.into_os_string(),
                OsString::from(mode),
                OsString::from("-o"),
                output.into_os_string(),
            ];
            push_officecli_json(&mut arguments);
        }
        ("spreadsheet", _) => {
            return Err("Spreadsheet action must be create, patch, code, or inspect".to_string())
        }
        ("presentation", _) => {
            return Err(
                "Presentation action must be create, patch, inspect, validate, or render".to_string(),
            )
        }
        ("word", _) => {
            return Err(
                "Word action must be create, patch, inspect, validate, or render".to_string(),
            )
        }
        _ => return Err("documentType must be spreadsheet, presentation, or word".to_string()),
    }

    if input.force && backend == RuntimeBackend::ArcForge {
        arguments.push(OsString::from("--force"));
    }
    let timeout_ms = input.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&timeout_ms) {
        return Err(format!(
            "timeoutMs must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS}"
        ));
    }

    Ok(PreparedInvocation {
        request_id: request_id.to_string(),
        workdir: workspace.clone(),
        arguments,
        timeout: Duration::from_millis(timeout_ms),
        backend,
        officecli_output,
        input_target,
        artifact_record: OfficeArtifactRecordInput {
            request_id: request_id.to_string(),
            workdir: workspace.to_string_lossy().into_owned(),
            document_type: document_type.clone(),
            action: action.clone(),
            provider: match backend {
                RuntimeBackend::ArcForge => "arcforge".to_string(),
                RuntimeBackend::OfficeCli => "officecli".to_string(),
            },
            input_path: artifact_input_path,
            spec_path: input.spec_path.clone(),
            script_path: input.script_path.clone(),
            output_path: input.output_path.clone(),
            parent_revision: None,
            source_revision: None,
            source_snapshot_path: None,
        },
        scratch_files,
    })
}

fn validate_edit_identifier(value: &str, label: &str, allow_dot: bool) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-') || (allow_dot && byte == b'.')
        })
    {
        return Err(format!(
            "{label} must use letters, digits, '_'{} or '-' (max 64 chars)",
            if allow_dot { ", '.'" } else { "" }
        ));
    }
    Ok(())
}

/// SVG ids carry no whitespace, but template shape names ("Title 1") do; both are valid targets.
fn validate_element_identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.chars().count() > 128
        || value.chars().any(|character| character.is_control() || matches!(character, '<' | '>' | '"' | '\''))
    {
        return Err("edit.elementId must be 1-128 printable characters without quotes or angle brackets".to_string());
    }
    Ok(())
}

fn stage_patch_replacement(request_id: &str, replacement: &str) -> Result<CleanupFile, String> {
    let path = std::env::temp_dir().join(format!("arcforge-patch-{request_id}.replacement"));
    if path.exists() {
        return Err("Patch staging path already exists; use a new requestId".to_string());
    }
    std::fs::write(&path, replacement)
        .map_err(|error| format!("Failed to stage the patch replacement: {error}"))?;
    Ok(CleanupFile(path))
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const SOURCE_SIDECAR_NAME: &str = "arcforge-office-runtime-x86_64-pc-windows-msvc.exe";
#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
const SOURCE_SIDECAR_NAME: &str = "arcforge-office-runtime-aarch64-pc-windows-msvc.exe";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const SOURCE_SIDECAR_NAME: &str = "arcforge-office-runtime-x86_64-apple-darwin";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const SOURCE_SIDECAR_NAME: &str = "arcforge-office-runtime-aarch64-apple-darwin";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const SOURCE_SIDECAR_NAME: &str = "arcforge-office-runtime-x86_64-unknown-linux-gnu";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const SOURCE_SIDECAR_NAME: &str = "arcforge-office-runtime-aarch64-unknown-linux-gnu";

fn bundled_sidecar_name() -> String {
    if cfg!(target_os = "windows") {
        format!("{SIDECAR_STEM}.exe")
    } else {
        SIDECAR_STEM.to_string()
    }
}

fn resolve_runtime_program() -> Result<RuntimeProgram, String> {
    if let Some(override_path) = std::env::var_os("ARCFORGE_OFFICE_RUNTIME_PATH") {
        let path = PathBuf::from(override_path);
        let canonical = std::fs::canonicalize(&path).map_err(|error| {
            format!("ARCFORGE_OFFICE_RUNTIME_PATH does not identify a file: {error}")
        })?;
        if !canonical.is_file() {
            return Err("ARCFORGE_OFFICE_RUNTIME_PATH must identify a file".to_string());
        }
        return Ok(RuntimeProgram {
            program: canonical,
            prefix_arguments: Vec::new(),
            label: "path-override".to_string(),
        });
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(executable_dir) = current_exe.parent() {
            let bundled = executable_dir.join(bundled_sidecar_name());
            if bundled.is_file() {
                return Ok(RuntimeProgram {
                    program: bundled,
                    prefix_arguments: Vec::new(),
                    label: "bundled-sidecar".to_string(),
                });
            }
        }
    }

    let source_sidecar = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(SOURCE_SIDECAR_NAME);
    if source_sidecar.is_file() {
        return Ok(RuntimeProgram {
            program: source_sidecar,
            prefix_arguments: Vec::new(),
            label: "development-sidecar".to_string(),
        });
    }

    let allow_python_fallback = cfg!(debug_assertions)
        || std::env::var("ARCFORGE_OFFICE_RUNTIME_ALLOW_PYTHON_FALLBACK")
            .is_ok_and(|value| value == "1");
    if allow_python_fallback {
        let wrapper = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "Could not locate the Office Runtime source wrapper".to_string())?
            .join("scripts")
            .join("office_runtime.py");
        if wrapper.is_file() {
            let python = std::env::var_os("ARCFORGE_OFFICE_RUNTIME_PYTHON")
                .unwrap_or_else(|| OsString::from("python"));
            return Ok(RuntimeProgram {
                program: PathBuf::from(python),
                prefix_arguments: vec![wrapper.into_os_string()],
                label: "development-python-fallback".to_string(),
            });
        }
    }

    Err(
        "ArcForge Office Runtime is missing. Reinstall ArcForge or run pnpm sidecar:build before starting the desktop app."
            .to_string(),
    )
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const SOURCE_OFFICECLI_NAME: &str = "arcforge-officecli-x86_64-pc-windows-msvc.exe";
#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
const SOURCE_OFFICECLI_NAME: &str = "arcforge-officecli-aarch64-pc-windows-msvc.exe";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const SOURCE_OFFICECLI_NAME: &str = "arcforge-officecli-x86_64-apple-darwin";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const SOURCE_OFFICECLI_NAME: &str = "arcforge-officecli-aarch64-apple-darwin";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const SOURCE_OFFICECLI_NAME: &str = "arcforge-officecli-x86_64-unknown-linux-gnu";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const SOURCE_OFFICECLI_NAME: &str = "arcforge-officecli-aarch64-unknown-linux-gnu";

fn bundled_officecli_name() -> String {
    if cfg!(target_os = "windows") {
        format!("{OFFICECLI_STEM}.exe")
    } else {
        OFFICECLI_STEM.to_string()
    }
}

fn resolve_officecli_program() -> Result<RuntimeProgram, String> {
    if let Some(override_path) = std::env::var_os("ARCFORGE_OFFICECLI_PATH") {
        let path = PathBuf::from(override_path);
        let canonical = std::fs::canonicalize(&path).map_err(|error| {
            format!("ARCFORGE_OFFICECLI_PATH does not identify a file: {error}")
        })?;
        if !canonical.is_file() {
            return Err("ARCFORGE_OFFICECLI_PATH must identify a file".to_string());
        }
        return Ok(RuntimeProgram {
            program: canonical,
            prefix_arguments: Vec::new(),
            label: "officecli-path-override".to_string(),
        });
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(executable_dir) = current_exe.parent() {
            let bundled = executable_dir.join(bundled_officecli_name());
            if bundled.is_file() {
                return Ok(RuntimeProgram {
                    program: bundled,
                    prefix_arguments: Vec::new(),
                    label: "officecli-bundled-sidecar".to_string(),
                });
            }
        }
    }

    let source_sidecar = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(SOURCE_OFFICECLI_NAME);
    if source_sidecar.is_file() {
        return Ok(RuntimeProgram {
            program: source_sidecar,
            prefix_arguments: Vec::new(),
            label: "officecli-development-sidecar".to_string(),
        });
    }

    Err(
        "OfficeCLI is missing. Set ARCFORGE_OFFICECLI_PATH or reinstall ArcForge with the OfficeCLI sidecar."
            .to_string(),
    )
}

fn read_capped<R: Read>(mut reader: R, limit: usize) -> CapturedOutput {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 8192];
    let mut total = 0_usize;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                total = total.saturating_add(count);
                if bytes.len() < limit {
                    let keep = count.min(limit - bytes.len());
                    bytes.extend_from_slice(&buffer[..keep]);
                }
            }
            Err(error) => {
                let message = format!("\n[output read error: {error}]");
                let remaining = limit.saturating_sub(bytes.len());
                bytes.extend_from_slice(&message.as_bytes()[..message.len().min(remaining)]);
                break;
            }
        }
    }
    CapturedOutput {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated: total > bytes.len(),
    }
}

fn wait_for_child(
    child: &mut std::process::Child,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<(ExitStatus, bool, bool), String> {
    let started = Instant::now();
    loop {
        if cancelled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let status = child
                .wait()
                .map_err(|error| format!("Failed to reap cancelled Office Runtime: {error}"))?;
            return Ok((status, false, true));
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let status = child
                .wait()
                .map_err(|error| format!("Failed to reap timed-out Office Runtime: {error}"))?;
            return Ok((status, true, false));
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok((status, false, false)),
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed while waiting for Office Runtime: {error}"));
            }
        }
    }
}

fn officecli_staging_path(
    target: &Path,
    request_id: &str,
    marker: &str,
) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "OfficeCLI outputPath has no parent directory".to_string())?;
    let extension = target
        .extension()
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "OfficeCLI outputPath must have a file extension".to_string())?;
    Ok(parent.join(format!(
        ".arcforge-officecli-{marker}-{}-{request_id}.{extension}",
        std::process::id(),
    )))
}

fn artifact_input_staging_path(input: &Path, request_id: &str) -> Result<PathBuf, String> {
    let parent = input
        .parent()
        .ok_or_else(|| "Document inputPath has no parent directory".to_string())?;
    let extension = input
        .extension()
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Document inputPath must have a file extension".to_string())?;
    Ok(parent.join(format!(
        ".arcforge-document-source-{}-{request_id}.{extension}",
        std::process::id(),
    )))
}

fn stage_artifact_input(
    arguments: &mut [OsString],
    input: Option<&Path>,
    snapshot: Option<&Path>,
    request_id: &str,
) -> Result<Option<CleanupFile>, String> {
    let (Some(live_input), Some(snapshot_path)) = (input, snapshot) else {
        return Ok(None);
    };
    if !arguments
        .iter()
        .any(|argument| argument.as_os_str() == live_input.as_os_str())
    {
        return Ok(None);
    }
    let staged_path = artifact_input_staging_path(live_input, request_id)?;
    if staged_path.exists() {
        return Err("Document source staging path already exists; use a new requestId".to_string());
    }
    std::fs::copy(snapshot_path, &staged_path)
        .map_err(|error| format!("Failed to stage document source snapshot: {error}"))?;
    for argument in arguments {
        if argument.as_os_str() == live_input.as_os_str() {
            *argument = staged_path.clone().into_os_string();
        }
    }
    Ok(Some(CleanupFile(staged_path)))
}

fn publish_without_replace(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    publish_without_replace_with_cleanup(source, target, |path| std::fs::remove_file(path))
}

fn publish_without_replace_with_cleanup<F>(
    source: &Path,
    target: &Path,
    cleanup: F,
) -> Result<(), std::io::Error>
where
    F: FnOnce(&Path) -> Result<(), std::io::Error>,
{
    std::fs::hard_link(source, target)?;
    if let Err(error) = cleanup(source) {
        eprintln!(
            "Published {} but could not remove staging file {}: {error}",
            target.display(),
            source.display()
        );
    }
    Ok(())
}

fn restore_officecli_backup(backup: &Path, target: &Path) -> Result<(), String> {
    publish_without_replace(backup, target).map_err(|error| {
        format!(
            "Failed to restore the previous OfficeCLI output from {}: {error}",
            backup.display()
        )
    })
}

fn commit_officecli_output(
    temp: &Path,
    target: &Path,
    expected: &TargetState,
    request_id: &str,
) -> Result<(), String> {
    let current = capture_target_state(target, expected.allow_replace)?;
    if &current != expected {
        return Err(
            "OfficeCLI outputPath changed while the operation was running; the new output was not published"
                .to_string(),
        );
    }

    if !expected.exists {
        return publish_without_replace(temp, target).map_err(|error| {
            format!(
                "Failed to publish OfficeCLI output without replacing a concurrent file: {error}"
            )
        });
    }
    if !expected.allow_replace {
        return Err("OfficeCLI outputPath exists and force was not authorized".to_string());
    }

    let backup = officecli_staging_path(target, request_id, "backup")?;
    if backup.exists() {
        return Err("OfficeCLI backup path already exists; use a new requestId".to_string());
    }
    std::fs::rename(target, &backup)
        .map_err(|error| format!("Failed to preserve the previous OfficeCLI output: {error}"))?;

    let moved = match capture_target_state(&backup, expected.allow_replace) {
        Ok(state) => state,
        Err(error) => {
            let restore = restore_officecli_backup(&backup, target);
            return Err(match restore {
                Ok(()) => error,
                Err(restore_error) => format!("{error}; {restore_error}"),
            });
        }
    };
    if &moved != expected {
        let restore = restore_officecli_backup(&backup, target);
        return Err(match restore {
            Ok(()) => {
                "OfficeCLI outputPath changed during publication; the previous file was restored"
                    .to_string()
            }
            Err(restore_error) => {
                format!("OfficeCLI outputPath changed during publication; {restore_error}")
            }
        });
    }

    if let Err(error) = publish_without_replace(temp, target) {
        let restore = restore_officecli_backup(&backup, target);
        return Err(match restore {
            Ok(()) => format!("Failed to publish OfficeCLI output: {error}"),
            Err(restore_error) => {
                format!("Failed to publish OfficeCLI output ({error}); {restore_error}")
            }
        });
    }
    let _ = std::fs::remove_file(backup);
    Ok(())
}

fn prepare_presentation_render_input(
    input: &Path,
    workdir: &Path,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<(tempfile::TempDir, PathBuf), String> {
    let directory = tempfile::Builder::new().prefix("arcforge-ppt-preview-").tempdir()
        .map_err(|error| format!("Failed to prepare presentation preview directory: {error}"))?;
    let output = directory.path().join("preview.pptx");
    let runtime = resolve_runtime_program()?;
    let mut command = Command::new(&runtime.program);
    command.args(&runtime.prefix_arguments)
        .args(["presentation", "prepare-preview", "--input"])
        .arg(input).arg("--output").arg(&output)
        .current_dir(workdir)
        .env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn()
        .map_err(|error| format!("Failed to start presentation preview preparation: {error}"))?;
    let stdout = child.stdout.take().ok_or("Failed to capture preview preparation output")?;
    let stderr = child.stderr.take().ok_or("Failed to capture preview preparation errors")?;
    let stdout_reader = thread::spawn(move || read_capped(stdout, STDOUT_LIMIT_BYTES));
    let stderr_reader = thread::spawn(move || read_capped(stderr, STDERR_LIMIT_BYTES));
    let result = wait_for_child(&mut child, timeout, cancelled);
    let _ = stdout_reader.join();
    let error = stderr_reader.join().map(|output| output.text).unwrap_or_default();
    let (status, timed_out, was_cancelled) = result?;
    if timed_out || was_cancelled || !status.success() || !output.is_file() {
        return Err(if timed_out { "Presentation preview preparation timed out".to_string() }
            else if was_cancelled { "Presentation preview preparation was cancelled".to_string() }
            else { format!("Presentation preview preparation failed: {}", error.trim()) });
    }
    Ok((directory, output))
}

fn published_output_report(stdout: &str, staged: &Path, target: &Path) -> String {
    fn rewrite(value: &mut serde_json::Value, staged: &Path, target: &Path) {
        match value {
            serde_json::Value::String(path) if Path::new(path) == staged => {
                *path = target.to_string_lossy().into_owned();
            }
            serde_json::Value::Array(items) => {
                for item in items { rewrite(item, staged, target); }
            }
            serde_json::Value::Object(items) => {
                for item in items.values_mut() { rewrite(item, staged, target); }
            }
            _ => {}
        }
    }
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(stdout) else { return stdout.to_string() };
    rewrite(&mut value, staged, target);
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| stdout.to_string())
}

fn run_office_runtime(
    invocation: PreparedInvocation,
    cancelled: Arc<AtomicBool>,
) -> Result<OfficeRuntimeResponse, String> {
    let operation_started = Instant::now();
    let (artifact_record, preparation_error) =
        match prepare_office_runtime_artifacts(invocation.artifact_record.clone()) {
            Ok(record) => (record, None),
            Err(error) => (invocation.artifact_record.clone(), Some(error)),
        };
    let runtime = match invocation.backend {
        RuntimeBackend::ArcForge => resolve_runtime_program()?,
        RuntimeBackend::OfficeCli => resolve_officecli_program()?,
    };
    let mut arguments = invocation.arguments.clone();
    if invocation.backend == RuntimeBackend::ArcForge
        && arguments.first().is_some_and(|argument| argument == "presentation")
        && arguments.get(1).is_some_and(|argument| argument == "render-png")
    {
        push_path_argument(&mut arguments, "--officecli", resolve_officecli_program()?.program);
    }
    let _staged_input = if matches!(
        artifact_record.action.as_str(),
        "patch" | "code" | "render" | "validate"
    ) {
        stage_artifact_input(
            &mut arguments,
            invocation.input_target.as_deref(),
            artifact_record.source_snapshot_path.as_deref(),
            &invocation.request_id,
        )?
    } else {
        None
    };
    let staged_output = if let Some(output) = &invocation.officecli_output {
        let target = output.target();
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!("Failed to prepare OfficeCLI output directory: {error}")
            })?;
        }
        let temp = officecli_staging_path(target, &invocation.request_id, "output")?;
        if temp.exists() {
            return Err("OfficeCLI staging path already exists; use a new requestId".to_string());
        }
        if let OfficeCliOutput::Copy { source, .. } = output {
            let staged_source = artifact_record
                .source_snapshot_path
                .as_deref()
                .unwrap_or(source);
            std::fs::copy(staged_source, &temp)
                .map_err(|error| format!("Failed to stage OfficeCLI input document: {error}"))?;
        }
        for argument in &mut arguments {
            if argument.as_os_str() == target.as_os_str() {
                *argument = temp.clone().into_os_string();
            }
        }
        Some((temp, target.to_path_buf(), output.expected().clone()))
    } else {
        None
    };
    let runtime_path = runtime.program.to_string_lossy().into_owned();
    let mut command = Command::new(&runtime.program);
    command
        .args(&runtime.prefix_arguments)
        .args(&arguments)
        .current_dir(&invocation.workdir)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if invocation.backend == RuntimeBackend::OfficeCli {
        command
            .env("OFFICECLI_NO_AUTO_INSTALL", "1")
            .env("OFFICECLI_SKIP_UPDATE", "1")
            .env("OFFICECLI_NO_AUTO_RESIDENT", "1");
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let started = Instant::now();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Some((temp, ..)) = &staged_output {
                let _ = std::fs::remove_file(temp);
            }
            return Err(match invocation.backend {
                RuntimeBackend::ArcForge => {
                    format!("Failed to start ArcForge Office Runtime: {error}")
                }
                RuntimeBackend::OfficeCli => format!("Failed to start OfficeCLI: {error}"),
            });
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture Office Runtime stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture Office Runtime stderr".to_string())?;
    let stdout_reader = thread::spawn(move || read_capped(stdout, STDOUT_LIMIT_BYTES));
    let stderr_reader = thread::spawn(move || read_capped(stderr, STDERR_LIMIT_BYTES));

    let status_result = wait_for_child(&mut child,
        invocation.timeout.saturating_sub(operation_started.elapsed()), &cancelled);
    let mut captured_stdout = match stdout_reader.join() {
        Ok(output) => output,
        Err(_) => {
            if let Some((temp, ..)) = &staged_output {
                let _ = std::fs::remove_file(temp);
            }
            return Err("Office Runtime stdout reader failed".to_string());
        }
    };
    let mut captured_stderr = match stderr_reader.join() {
        Ok(output) => output,
        Err(_) => {
            if let Some((temp, ..)) = &staged_output {
                let _ = std::fs::remove_file(temp);
            }
            return Err("Office Runtime stderr reader failed".to_string());
        }
    };
    let (status, timed_out, was_cancelled) = match status_result {
        Ok(result) => result,
        Err(error) => {
            if let Some((temp, ..)) = &staged_output {
                let _ = std::fs::remove_file(temp);
            }
            return Err(error);
        }
    };
    let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;

    let succeeded = status.success() && !timed_out && !was_cancelled;
    // Killing Python bypasses its exception handlers. Restore a pending journal before
    // publishing cancellation/failure so sources, the PPTX and undo history stay consistent.
    if !succeeded && invocation.backend == RuntimeBackend::ArcForge
        && arguments.first().is_some_and(|argument| argument == "presentation")
        && arguments.get(1).is_some_and(|argument| argument == "patch")
    {
        let value_after = |flag: &str| arguments.windows(2)
            .find(|pair| pair[0] == flag).map(|pair| pair[1].clone());
        if let (Some(spec), Some(output)) = (value_after("--spec"), value_after("--output")) {
            let recovery = vec!["presentation".into(), "recover-patch".into(), "--spec".into(), spec, "--output".into(), output, "--workspace".into(), invocation.workdir.as_os_str().to_owned()];
            if let Err(error) = run_presentation_runtime_json(&invocation.workdir, &recovery, Duration::from_secs(30)) {
                captured_stderr.text.push_str(&format!("\nPatch recovery failed: {error}"));
            }
        }
    }
    if let Some((temp, target, expected)) = &staged_output {
        if succeeded {
            if let Err(error) =
                commit_officecli_output(temp, target, expected, &invocation.request_id)
            {
                let _ = std::fs::remove_file(temp);
                return Err(error);
            }
            captured_stdout.text = published_output_report(&captured_stdout.text, temp, target);
        } else {
            let _ = std::fs::remove_file(temp);
        }
    }

    let exit_code = status.code();
    let should_record = !timed_out && !was_cancelled;
    let (artifact, record_error) = if should_record {
        match super::document_artifacts::record_office_runtime_result(
            artifact_record,
            succeeded,
            exit_code,
            &captured_stdout.text,
            &captured_stderr.text,
        ) {
            Ok(summary) => (summary, None),
            Err(error) => (None, Some(error)),
        }
    } else {
        (None, None)
    };
    let artifact_error = match (preparation_error, record_error) {
        (Some(preparation), Some(record)) => Some(format!(
            "Failed to capture the pre-operation document revision: {preparation}; failed to record the operation result: {record}"
        )),
        (Some(preparation), None) => Some(format!(
            "Failed to capture the pre-operation document revision: {preparation}"
        )),
        (None, Some(record)) => Some(record),
        (None, None) => None,
    };

    Ok(OfficeRuntimeResponse {
        success: succeeded,
        exit_code,
        stdout: captured_stdout.text,
        stderr: captured_stderr.text,
        stdout_truncated: captured_stdout.truncated,
        stderr_truncated: captured_stderr.truncated,
        timed_out,
        cancelled: was_cancelled,
        duration_ms,
        runtime: runtime.label,
        runtime_path,
        artifact,
        artifact_error,
    })
}

#[tauri::command]
pub async fn office_runtime_execute(
    registry: State<'_, Arc<OfficeRuntimeRegistry>>,
    input: OfficeRuntimeRequest,
) -> Result<OfficeRuntimeResponse, String> {
    let invocation = prepare_invocation(input)?;
    let request_id = invocation.request_id.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    registry.register(&request_id, Arc::clone(&cancelled))?;
    let result = tokio::task::spawn_blocking(move || run_office_runtime(invocation, cancelled))
        .await
        .map_err(|error| format!("Office Runtime worker failed: {error}"));
    registry.finish(&request_id);
    result?
}

#[tauri::command]
pub fn office_runtime_cancel(
    registry: State<'_, Arc<OfficeRuntimeRegistry>>,
    request_id: String,
) -> OfficeRuntimeCancelResponse {
    OfficeRuntimeCancelResponse {
        cancelled: registry.cancel(request_id.trim()),
    }
}

// ---------------------------------------------------------------------------
// Slide previews for the workspace file viewer
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationPreviewPageResponse {
    path: String,
    slide_count: usize,
    page: usize,
    mime_type: String,
    data: String,
    size_bytes: u64,
    cached: bool,
}

const PRESENTATION_PREVIEW_TIMEOUT: Duration = Duration::from_secs(120);

fn presentation_preview_cache_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("arcforge-presentation-preview");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create the slide preview cache: {error}"))?;
    Ok(dir)
}

/// Render one slide of a workspace PPTX to PNG through OfficeCLI. Results are cached in the
/// temp directory keyed by file path, modification time, size, and page.
fn presentation_preview_page_sync(
    workdir: String,
    path: String,
    page: Option<usize>,
    width: Option<u32>,
) -> Result<PresentationPreviewPageResponse, String> {
    let (file, display) = resolve_presentation_for_review(&workdir, &path)?;
    let parts = pptx_slide_parts(&file)?;
    let slide_count = parts.len();
    let page = page.unwrap_or(1).clamp(1, slide_count);
    let width = width.unwrap_or(1600).clamp(160, 3200);
    let workspace = file
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    // The cache key follows the slide content, not the file: re-creating a deck only
    // invalidates the slides whose XML (or shared masters/media) actually changed.
    let mut hasher = Sha256::new();
    hasher.update(b"inherited-artwork-preview-v1");
    hasher.update(parts[page - 1].fingerprint.as_bytes());
    hasher.update((page as u64).to_le_bytes());
    hasher.update(u64::from(width).to_le_bytes());
    let key: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let cache_dir = presentation_preview_cache_dir()?;
    let target = cache_dir.join(format!("{key}.png"));
    let mut cached = true;

    if !target.is_file() {
        cached = false;
        let started = Instant::now();
        let cancelled = AtomicBool::new(false);
        let (_prepared_directory, prepared_input) = prepare_presentation_render_input(
            &file, &workspace, PRESENTATION_PREVIEW_TIMEOUT, &cancelled)?;
        let runtime = resolve_officecli_program()?;
        let temp = cache_dir.join(format!("{key}.{}.tmp.png", std::process::id()));
        let _ = std::fs::remove_file(&temp);
        let mut command = Command::new(&runtime.program);
        command
            .args(&runtime.prefix_arguments)
            .arg("view")
            .arg(&prepared_input)
            .arg("screenshot")
            .arg("--render")
            .arg("html")
            .arg("--page")
            .arg(page.to_string())
            .arg("--screenshot-width")
            .arg(width.to_string())
            .arg("-o")
            .arg(&temp)
            .arg("--json")
            .current_dir(&workspace)
            .env("OFFICECLI_NO_AUTO_INSTALL", "1")
            .env("OFFICECLI_SKIP_UPDATE", "1")
            .env("OFFICECLI_NO_AUTO_RESIDENT", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to start OfficeCLI: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture OfficeCLI stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture OfficeCLI stderr".to_string())?;
        let stdout_reader = thread::spawn(move || read_capped(stdout, STDOUT_LIMIT_BYTES));
        let stderr_reader = thread::spawn(move || read_capped(stderr, STDERR_LIMIT_BYTES));
        let (status, timed_out, _) =
            wait_for_child(&mut child, PRESENTATION_PREVIEW_TIMEOUT.saturating_sub(started.elapsed()), &cancelled)?;
        let _ = stdout_reader.join();
        let stderr_text = stderr_reader
            .join()
            .map(|captured| captured.text)
            .unwrap_or_default();
        if timed_out {
            let _ = std::fs::remove_file(&temp);
            return Err("Rendering the slide preview timed out".to_string());
        }
        if !status.success() || !temp.is_file() {
            let _ = std::fs::remove_file(&temp);
            let detail = stderr_text.trim();
            return Err(if detail.is_empty() {
                "OfficeCLI could not render the slide".to_string()
            } else {
                format!("OfficeCLI could not render the slide: {detail}")
            });
        }
        if std::fs::rename(&temp, &target).is_err() {
            // A concurrent render already produced the same page.
            let _ = std::fs::remove_file(&temp);
            if !target.is_file() {
                return Err("Failed to store the slide preview".to_string());
            }
        }
    }

    let bytes = std::fs::read(&target)
        .map_err(|error| format!("Failed to read the slide preview: {error}"))?;
    Ok(PresentationPreviewPageResponse {
        path: display,
        slide_count,
        page,
        mime_type: "image/png".to_string(),
        size_bytes: bytes.len() as u64,
        data: BASE64_STANDARD.encode(&bytes),
        cached,
    })
}


// ---------------------------------------------------------------------------
// Artifact review: slide enumeration for the workspace review panel
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationUnit {
    /// 1-based position in presentation order.
    index: usize,
    /// Stable id: the slide name written by ArcForge (`slide_id`) or `slide-N`.
    id: String,
    name: String,
    title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationUnitsResponse {
    path: String,
    slide_count: usize,
    units: Vec<PresentationUnit>,
}

struct SlidePart {
    index: usize,
    entry_name: String,
    unit: PresentationUnit,
    /// Fingerprint of everything that renders this slide: its XML, its rels, and the shared
    /// parts (masters, layouts, theme, media).
    fingerprint: String,
}

fn xml_attribute(tag: &str, name: &str) -> Option<String> {
    let pattern = format!(r#"(?i)\b{name}\s*=\s*"([^"]*)""#);
    regex::Regex::new(&pattern)
        .ok()?
        .captures(tag)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_string())
}

fn unescape_xml_text(value: &str) -> String {
    quick_xml::escape::unescape(value)
        .map(|cow| cow.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

fn read_zip_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<Vec<u8>> {
    let mut entry = archive.by_name(name).ok()?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// Enumerate slides in presentation order with stable ids and render fingerprints.
fn pptx_slide_parts(path: &Path) -> Result<Vec<SlidePart>, String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("path could not be opened: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("path is not a valid PPTX package: {error}"))?;

    // Shared parts digest: every entry that is not a slide or slide rels.
    let mut shared = Sha256::new();
    let mut names: Vec<String> = archive.file_names().map(str::to_string).collect();
    names.sort();
    for name in &names {
        let is_slide_part = name.starts_with("ppt/slides/slide") && name.ends_with(".xml");
        let is_slide_rels = name.starts_with("ppt/slides/_rels/slide") && name.ends_with(".rels");
        if is_slide_part || is_slide_rels {
            continue;
        }
        if let Ok(entry) = archive.by_name(name) {
            shared.update(name.as_bytes());
            shared.update(entry.crc32().to_le_bytes());
            shared.update(entry.size().to_le_bytes());
        }
    }
    let shared_digest = shared.finalize();

    let presentation_xml = read_zip_entry(&mut archive, "ppt/presentation.xml")
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .ok_or_else(|| "path does not contain ppt/presentation.xml".to_string())?;
    let rels_xml = read_zip_entry(&mut archive, "ppt/_rels/presentation.xml.rels")
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();

    let relationship_tag = regex::Regex::new(r"(?is)<Relationship\b[^>]*>").expect("static regex");
    let mut targets_by_id: HashMap<String, String> = HashMap::new();
    for tag in relationship_tag.find_iter(&rels_xml) {
        let tag = tag.as_str();
        if let (Some(id), Some(target)) = (xml_attribute(tag, "Id"), xml_attribute(tag, "Target"))
        {
            let target = target.trim_start_matches("/ppt/").trim_start_matches('/').to_string();
            targets_by_id.insert(id, target);
        }
    }

    let slide_id_tag = regex::Regex::new(r"(?is)<p:sldId\b[^>]*>").expect("static regex");
    let mut slide_entries: Vec<String> = slide_id_tag
        .find_iter(&presentation_xml)
        .filter_map(|tag| xml_attribute(tag.as_str(), "r:id"))
        .filter_map(|rid| targets_by_id.get(&rid).cloned())
        .map(|target| {
            if target.starts_with("ppt/") {
                target
            } else {
                format!("ppt/{target}")
            }
        })
        .collect();
    if slide_entries.is_empty() {
        // Fall back to numeric order for packages without a usable sldIdLst.
        let mut numbered: Vec<(usize, String)> = names
            .iter()
            .filter_map(|name| {
                name.strip_prefix("ppt/slides/slide")
                    .and_then(|rest| rest.strip_suffix(".xml"))
                    .and_then(|digits| digits.parse::<usize>().ok())
                    .map(|number| (number, name.clone()))
            })
            .collect();
        numbered.sort();
        slide_entries = numbered.into_iter().map(|(_, name)| name).collect();
    }
    if slide_entries.is_empty() {
        return Err("path does not contain any slides".to_string());
    }

    let name_tag = regex::Regex::new(r"(?is)<p:cSld\b[^>]*>").expect("static regex");
    let text_run = regex::Regex::new(r"(?is)<a:t>([^<]*)</a:t>").expect("static regex");
    let mut parts = Vec::with_capacity(slide_entries.len());
    for (position, entry_name) in slide_entries.iter().enumerate() {
        let index = position + 1;
        let xml_bytes = read_zip_entry(&mut archive, entry_name)
            .ok_or_else(|| format!("slide part {entry_name} is missing"))?;
        let xml = String::from_utf8_lossy(&xml_bytes).into_owned();
        let rels_name = entry_name
            .rsplit_once('/')
            .map(|(dir, file)| format!("{dir}/_rels/{file}.rels"))
            .unwrap_or_default();
        let rels_bytes = read_zip_entry(&mut archive, &rels_name).unwrap_or_default();

        let name = name_tag
            .find(&xml)
            .and_then(|tag| xml_attribute(tag.as_str(), "name"))
            .map(|value| unescape_xml_text(&value))
            .unwrap_or_default();
        let title = text_run
            .captures_iter(&xml)
            .map(|captures| unescape_xml_text(captures.get(1).map_or("", |m| m.as_str())))
            .map(|text| text.trim().to_string())
            .find(|text| !text.is_empty())
            .map(|text| text.chars().take(80).collect::<String>())
            .unwrap_or_default();
        let id = if !name.trim().is_empty() {
            name.trim().to_string()
        } else {
            format!("slide-{index}")
        };

        let mut hasher = Sha256::new();
        hasher.update(&xml_bytes);
        hasher.update(&rels_bytes);
        hasher.update(shared_digest);
        let fingerprint: String = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        parts.push(SlidePart {
            index,
            entry_name: entry_name.clone(),
            unit: PresentationUnit {
                index,
                id,
                name,
                title,
            },
            fingerprint,
        });
    }
    Ok(parts)
}

fn resolve_presentation_for_review(workdir: &str, path: &str) -> Result<(PathBuf, String), String> {
    let workdir_raw = workdir.trim();
    if workdir_raw.is_empty() {
        return Err("workdir is required".to_string());
    }
    let workspace = std::fs::canonicalize(workdir_raw)
        .map_err(|error| format!("workdir cannot be opened: {error}"))?;
    let raw = path.trim();
    let extension = Path::new(raw)
        .extension()
        .and_then(OsStr::to_str)
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(extension.as_str(), "pptx" | "pptm" | "potx") {
        return Err("Only .pptx, .pptm, and .potx files can be previewed as slides".to_string());
    }
    let file = resolve_existing_path(&workspace, &workspace, raw, &extension, "path")?;
    Ok((file, raw.replace('\\', "/")))
}

fn presentation_units_sync(workdir: String, path: String) -> Result<PresentationUnitsResponse, String> {
    let (file, display) = resolve_presentation_for_review(&workdir, &path)?;
    let parts = pptx_slide_parts(&file)?;
    Ok(PresentationUnitsResponse {
        path: display,
        slide_count: parts.len(),
        units: parts.into_iter().map(|part| part.unit).collect(),
    })
}

#[tauri::command]
pub async fn presentation_units(
    workdir: String,
    path: String,
) -> Result<PresentationUnitsResponse, String> {
    tokio::task::spawn_blocking(move || presentation_units_sync(workdir, path))
        .await
        .map_err(|error| format!("Slide enumeration worker failed: {error}"))?
}


// ---------------------------------------------------------------------------
// Artifact review: semantic blocks inside one slide (overlay hit-testing)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationElement {
    /// Unique SVG/shape name, or an id based on DrawingML cNvPr id for unnamed/duplicate shapes.
    id: String,
    /// title | subtitle | text_block | image | chart | table | footer
    element_type: String,
    label: String,
    /// x, y, width, height in the 1280×720 review canvas.
    bbox: [f64; 4],
    /// Underlying DrawingML node: sp | pic | graphicFrame | grpSp
    kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationElementsResponse {
    path: String,
    page: usize,
    slide_id: String,
    canvas: [f64; 2],
    elements: Vec<PresentationElement>,
}

const REVIEW_CANVAS_WIDTH: f64 = 1280.0;
const REVIEW_CANVAS_HEIGHT: f64 = 720.0;
const SEMANTIC_ELEMENT_TYPES: [&str; 7] = [
    "title",
    "subtitle",
    "text_block",
    "image",
    "chart",
    "table",
    "footer",
];

fn presentation_slide_size(archive: &mut zip::ZipArchive<std::fs::File>) -> (f64, f64) {
    let xml = read_zip_entry(archive, "ppt/presentation.xml")
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    let tag = regex::Regex::new(r"(?is)<p:sldSz\b[^>]*>").expect("static regex");
    let size = tag
        .find(&xml)
        .map(|found| found.as_str().to_string())
        .unwrap_or_default();
    let cx = xml_attribute(&size, "cx")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(12_192_000.0);
    let cy = xml_attribute(&size, "cy")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(6_858_000.0);
    (cx, cy)
}

/// Split `<p:spTree>` into its direct children (sp, pic, graphicFrame, grpSp, cxnSp) with
/// their full XML, ignoring nested group members.
fn top_level_shape_bodies(slide_xml: &str) -> Vec<(String, String)> {
    let tree_start = match slide_xml.find("<p:spTree") {
        Some(index) => index,
        None => return Vec::new(),
    };
    let tree = &slide_xml[tree_start..];
    let tree = tree.split("</p:spTree>").next().unwrap_or(tree);
    let tag = regex::Regex::new(r"(?s)<(/?)(p:sp|p:pic|p:graphicFrame|p:grpSp|p:cxnSp)\b[^>]*?(/?)>")
        .expect("static regex");
    let mut bodies = Vec::new();
    let mut depth = 0usize;
    let mut open_at: Option<(usize, String)> = None;
    for capture in tag.captures_iter(tree) {
        let whole = capture.get(0).unwrap();
        let closing = capture.get(1).map_or(false, |m| m.as_str() == "/");
        let name = capture.get(2).map_or("", |m| m.as_str()).to_string();
        let self_closing = capture.get(3).map_or(false, |m| m.as_str() == "/");
        if !closing && self_closing {
            if depth == 0 {
                bodies.push((name, whole.as_str().to_string()));
            }
            continue;
        }
        if !closing {
            if depth == 0 {
                open_at = Some((whole.start(), name));
            }
            depth += 1;
        } else {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                if let Some((start, open_name)) = open_at.take() {
                    bodies.push((open_name, tree[start..whole.end()].to_string()));
                }
            }
        }
    }
    bodies
}

fn first_tag(body: &str, pattern: &str) -> Option<String> {
    regex::Regex::new(pattern)
        .ok()?
        .find(body)
        .map(|found| found.as_str().to_string())
}

fn classify_element(kind: &str, name: &str, descr: &str, placeholder: &str, body: &str, bbox: [f64; 4]) -> Option<&'static str> {
    if let Some(role) = descr
        .split(';')
        .find_map(|part| part.trim().strip_prefix("arcforge:role="))
    {
        let role = role.trim();
        if let Some(found) = SEMANTIC_ELEMENT_TYPES.iter().find(|candidate| **candidate == role) {
            return Some(found);
        }
    }
    let lowered_name = name.to_ascii_lowercase();
    let has_text = regex::Regex::new(r"(?s)<a:t>[^<]*\S[^<]*</a:t>")
        .map(|re| re.is_match(body))
        .unwrap_or(false);
    let graphic_uri = first_tag(body, r#"(?is)<a:graphicData\b[^>]*>"#)
        .and_then(|tag| xml_attribute(&tag, "uri"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    match kind {
        "p:pic" => return Some("image"),
        "p:grpSp" => return Some("image"),
        "p:graphicFrame" => {
            if graphic_uri.contains("/chart") {
                return Some("chart");
            }
            if graphic_uri.contains("/table") {
                return Some("table");
            }
            if graphic_uri.contains("/picture") {
                return Some("image");
            }
            return None;
        }
        "p:cxnSp" => return None,
        _ => {}
    }
    match placeholder {
        "title" | "ctrTitle" => return Some("title"),
        "subTitle" => return Some("subtitle"),
        "ftr" => return Some("footer"),
        "pic" => return Some("image"),
        "chart" => return Some("chart"),
        "tbl" => return Some("table"),
        "sldNum" | "dt" => return None,
        _ => {}
    }
    if !has_text {
        return None;
    }
    if lowered_name.starts_with("title") || lowered_name == "heading" {
        return Some("title");
    }
    if lowered_name.starts_with("subtitle") || lowered_name.starts_with("sub-title") {
        return Some("subtitle");
    }
    let bottom = bbox[1] + bbox[3];
    if lowered_name.contains("footer") || (bottom > REVIEW_CANVAS_HEIGHT * 0.92 && bbox[3] < REVIEW_CANVAS_HEIGHT * 0.1) {
        return Some("footer");
    }
    Some("text_block")
}

fn presentation_elements_from_xml(
    slide_xml: &str,
    slide_cx: f64,
    slide_cy: f64,
    inherited_shapes: &[(String, String)],
) -> Vec<PresentationElement> {
    let scale_x = REVIEW_CANVAS_WIDTH / slide_cx;
    let scale_y = REVIEW_CANVAS_HEIGHT / slide_cy;
    let text_run = regex::Regex::new(r"(?is)<a:t>([^<]*)</a:t>").expect("static regex");
    let mut elements = Vec::new();
    let shapes = top_level_shape_bodies(slide_xml);
    let shape_name = |body: &str| {
        first_tag(body, r"(?is)<p:cNvPr\b[^>]*>")
            .and_then(|tag| xml_attribute(&tag, "name"))
            .map(|name| unescape_xml_text(&name).trim().to_string())
            .unwrap_or_default()
    };
    let mut name_counts: HashMap<String, usize> = HashMap::new();
    for (_, body) in &shapes {
        *name_counts.entry(shape_name(body)).or_default() += 1;
    }
    let mut used_ids = std::collections::HashSet::new();
    let default_name = regex::Regex::new(r"(?i)^(?:Text|Rect|Oval|Freeform|Line|Picture|TextBox|Group)(?: \d+)?$").expect("static regex");
    for (kind, body) in shapes {
        let cnv = first_tag(&body, r"(?is)<p:cNvPr\b[^>]*>").unwrap_or_default();
        let raw_name = xml_attribute(&cnv, "name")
            .map(|value| unescape_xml_text(&value))
            .unwrap_or_default();
        let descr = xml_attribute(&cnv, "descr")
            .map(|value| unescape_xml_text(&value))
            .unwrap_or_default();
        let placeholder_tag = first_tag(&body, r"(?is)<p:ph\b[^>]*>");
        let placeholder = placeholder_tag.as_deref()
            .and_then(|tag| xml_attribute(tag, "type"))
            .unwrap_or_else(|| {
                if body.contains("<p:ph") {
                    "body".to_string()
                } else {
                    String::new()
                }
            });
        let inherited = placeholder_tag.as_deref().and_then(|tag| {
            let index = xml_attribute(tag, "idx").unwrap_or_else(|| "0".to_string());
            inherited_shapes.iter().find(|(_, candidate)| {
                first_tag(candidate, r"(?is)<p:ph\b[^>]*>").is_some_and(|candidate| {
                    xml_attribute(&candidate, "idx").unwrap_or_else(|| "0".to_string()) == index
                }) && shape_transform(&kind, candidate).is_some()
            })
        });
        let Some(xfrm) = shape_transform(&kind, &body)
            .or_else(|| inherited.and_then(|(_, body)| shape_transform(&kind, body))) else {
            continue;
        };
        let off = first_tag(&xfrm, r"(?is)<a:off\b[^>]*>").unwrap_or_default();
        let ext = first_tag(&xfrm, r"(?is)<a:ext\b[^>]*>").unwrap_or_default();
        let read = |tag: &str, attribute: &str| {
            xml_attribute(tag, attribute)
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite())
                .unwrap_or(0.0)
        };
        let mut bbox = [
            (read(&off, "x") * scale_x * 10.0).round() / 10.0,
            (read(&off, "y") * scale_y * 10.0).round() / 10.0,
            (read(&ext, "cx") * scale_x * 10.0).round() / 10.0,
            (read(&ext, "cy") * scale_y * 10.0).round() / 10.0,
        ];
        if bbox[2] <= 0.0 || bbox[3] <= 0.0 {
            continue;
        }
        // The preview is an axis-aligned overlay even for an imported rotated shape.
        let rotation = read(&xfrm, "rot") / 60000.0;
        if rotation != 0.0 {
            let (sin, cos) = rotation.to_radians().sin_cos();
            let width = bbox[2] * cos.abs() + bbox[3] * sin.abs() * scale_x / scale_y;
            let height = bbox[2] * sin.abs() * scale_y / scale_x + bbox[3] * cos.abs();
            bbox[0] += (bbox[2] - width) / 2.0;
            bbox[1] += (bbox[3] - height) / 2.0;
            bbox[2] = width;
            bbox[3] = height;
        }
        let Some(element_type) = classify_element(&kind, &raw_name, &descr, &placeholder, &body, bbox)
        else {
            continue;
        };
        let name = raw_name.trim();
        let mut id = name.to_string();
        if name.is_empty() || name_counts.get(name).copied().unwrap_or(0) > 1
            || (descr.is_empty() && default_name.is_match(name)) {
            let Some(shape_id) = xml_attribute(&cnv, "id").filter(|id| !id.is_empty()) else { continue };
            id = format!("shape-{shape_id}");
            // Explicit SVG names win, even if one happens to look like our fallback id.
            while name_counts.contains_key(&id) {
                id = format!("shape-{id}");
            }
        }
        if !used_ids.insert(id.clone()) {
            continue;
        }
        let label = text_run
            .captures_iter(&body)
            .map(|captures| unescape_xml_text(captures.get(1).map_or("", |m| m.as_str())))
            .map(|text| text.trim().to_string())
            .find(|text| !text.is_empty())
            .map(|text| text.chars().take(60).collect::<String>())
            .unwrap_or_else(|| id.clone());
        elements.push(PresentationElement {
            id,
            element_type: element_type.to_string(),
            label,
            bbox,
            kind: kind.trim_start_matches("p:").to_string(),
        });
    }

    elements
}

fn shape_transform(kind: &str, body: &str) -> Option<String> {
    let (properties, transform) = match kind {
        "p:graphicFrame" => return first_tag(body, r"(?is)<p:xfrm\b[^>]*>.*?</p:xfrm>"),
        "p:grpSp" => (r"(?is)<p:grpSpPr\b[^>]*>.*?</p:grpSpPr>", r"(?is)<a:xfrm\b[^>]*>.*?</a:xfrm>"),
        _ => (r"(?is)<p:spPr\b[^>]*>.*?</p:spPr>", r"(?is)<a:xfrm\b[^>]*>.*?</a:xfrm>"),
    };
    first_tag(body, properties).and_then(|properties| first_tag(&properties, transform))
}

fn presentation_layout_shapes(archive: &mut zip::ZipArchive<std::fs::File>, slide_part: &str) -> Vec<(String, String)> {
    let Some((directory, filename)) = slide_part.rsplit_once('/') else { return Vec::new() };
    let Some(rels) = read_zip_entry(archive, &format!("{directory}/_rels/{filename}.rels")) else { return Vec::new() };
    let rels = String::from_utf8_lossy(&rels);
    let relation = regex::Regex::new(r"(?is)<Relationship\b[^>]*>").expect("static regex");
    let target = relation.find_iter(&rels).find_map(|tag| {
        let tag = tag.as_str();
        if !xml_attribute(tag, "Type")?.ends_with("/slideLayout") || xml_attribute(tag, "TargetMode").as_deref() == Some("External") { return None }
        xml_attribute(tag, "Target")
    });
    let Some(target) = target else { return Vec::new() };
    let path = if target.starts_with('/') { target.trim_start_matches('/').to_string() } else { format!("{directory}/{target}") };
    let mut components = Vec::new();
    for component in path.split('/') {
        match component { ".." => { components.pop(); }, "." | "" => {}, _ => components.push(component) }
    }
    read_zip_entry(archive, &components.join("/"))
        .map(|xml| top_level_shape_bodies(&String::from_utf8_lossy(&xml)))
        .unwrap_or_default()
}

fn presentation_elements_sync(workdir: String, path: String, page: usize) -> Result<PresentationElementsResponse, String> {
    let (file, display) = resolve_presentation_for_review(&workdir, &path)?;
    let parts = pptx_slide_parts(&file)?;
    if page == 0 || page > parts.len() {
        return Err(format!("page must be between 1 and {}", parts.len()));
    }
    let part = &parts[page - 1];
    let handle = std::fs::File::open(&file).map_err(|error| format!("path could not be opened: {error}"))?;
    let mut archive = zip::ZipArchive::new(handle).map_err(|error| format!("path is not a valid PPTX package: {error}"))?;
    let (slide_cx, slide_cy) = presentation_slide_size(&mut archive);
    let slide_xml = read_zip_entry(&mut archive, &part.entry_name)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).ok_or_else(|| "slide part is missing".to_string())?;
    let inherited = presentation_layout_shapes(&mut archive, &part.entry_name);
    let elements = presentation_elements_from_xml(&slide_xml, slide_cx, slide_cy, &inherited);
    Ok(PresentationElementsResponse {
        path: display,
        page,
        slide_id: part.unit.id.clone(),
        canvas: [REVIEW_CANVAS_WIDTH, REVIEW_CANVAS_HEIGHT],
        elements,
    })
}

#[tauri::command]
pub async fn presentation_elements(
    workdir: String,
    path: String,
    page: usize,
) -> Result<PresentationElementsResponse, String> {
    tokio::task::spawn_blocking(move || presentation_elements_sync(workdir, path, page))
        .await
        .map_err(|error| format!("Slide element worker failed: {error}"))?
}

#[tauri::command]
pub async fn presentation_preview_page(
    workdir: String,
    path: String,
    page: Option<usize>,
    width: Option<u32>,
) -> Result<PresentationPreviewPageResponse, String> {
    tokio::task::spawn_blocking(move || presentation_preview_page_sync(workdir, path, page, width))
        .await
        .map_err(|error| format!("Slide preview worker failed: {error}"))?
}

// ---------------------------------------------------------------------------
// Artifact review: scoped-edit context and edit history for a built deck
// ---------------------------------------------------------------------------

const PRESENTATION_CONTEXT_TIMEOUT: Duration = Duration::from_secs(90);
const MANIFEST_SEARCH_MAX_DEPTH: usize = 6;
const MANIFEST_SEARCH_MAX_ENTRIES: usize = 20_000;
const BUILD_STAMP_FILE_NAME: &str = ".arcforge-build.json";
const EDIT_HISTORY_DIR_NAME: &str = ".arcforge-history";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationSelectionContextResponse {
    path: String,
    /// Workspace-relative manifest path with forward slashes.
    manifest_path: String,
    manifest_dir: String,
    template_path: Option<String>,
    svg_path: Option<String>,
    /// The runtime's `selection-context` report (snake_case keys).
    context: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationEditRecord {
    edit_id: String,
    slide_id: String,
    element_id: Option<String>,
    scope: String,
    kind: String,
    target: String,
    created_at: String,
    reverted: bool,
    reverted_at: Option<String>,
    before_text: String,
    after_text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationEditHistoryResponse {
    path: String,
    manifest_path: String,
    edits: Vec<PresentationEditRecord>,
}

struct DeckManifestLink {
    spec: PathBuf,
    template: Option<PathBuf>,
}

fn workspace_relative(workspace: &Path, path: &Path) -> String {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let relative = canonical
        .strip_prefix(workspace)
        .map(Path::to_path_buf)
        .unwrap_or(canonical);
    relative.to_string_lossy().replace('\\', "/")
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn manifest_declares_slide(spec: &Path, slide_id: Option<&str>) -> bool {
    let Ok(raw) = std::fs::read_to_string(spec) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    if value.get("schema_version").and_then(serde_json::Value::as_u64) != Some(3) {
        return false;
    }
    let Some(slides) = value.get("slides").and_then(serde_json::Value::as_array) else {
        return false;
    };
    match slide_id {
        Some(slide_id) => slides.iter().any(|entry| {
            entry.get("slide_id").and_then(serde_json::Value::as_str) == Some(slide_id)
        }),
        None => true,
    }
}

/// A build record links one output deck to the manifest that produced it.
fn manifest_from_stamp(stamp_path: &Path, deck: &Path, slide_id: Option<&str>) -> Option<DeckManifestLink> {
    let raw = std::fs::read_to_string(stamp_path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let output = value.get("output").and_then(serde_json::Value::as_str)?;
    if !same_file(Path::new(output), deck) {
        return None;
    }
    let stamp_dir = stamp_path.parent()?;
    let template = value
        .get("template")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    if let Some(spec) = value.get("spec").and_then(serde_json::Value::as_str) {
        let spec = PathBuf::from(spec);
        if spec.is_file() && manifest_declares_slide(&spec, slide_id) {
            return Some(DeckManifestLink { spec, template });
        }
        return None;
    }
    // Records written before the manifest name was stored: any schema 3 manifest in that
    // directory which declares the requested page.
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(stamp_dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(OsStr::to_str)
                .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
                && path.file_name().and_then(OsStr::to_str) != Some(BUILD_STAMP_FILE_NAME)
        })
        .collect();
    candidates.sort();
    candidates
        .into_iter()
        .find(|path| manifest_declares_slide(path, slide_id))
        .map(|spec| DeckManifestLink { spec, template })
}

fn find_deck_manifest(workspace: &Path, deck: &Path, slide_id: Option<&str>) -> Result<DeckManifestLink, String> {
    let checked = |mut link: DeckManifestLink| -> Result<DeckManifestLink, String> {
        link.spec = std::fs::canonicalize(&link.spec).map_err(|error| error.to_string())?;
        ensure_within_workspace(&link.spec, workspace, "linked manifest")?;
        if let Some(template) = link.template.as_mut() {
            *template = std::fs::canonicalize(&template).map_err(|error| error.to_string())?;
            ensure_within_workspace(template, workspace, "linked template")?;
        }
        Ok(link)
    };
    let mut visited = std::collections::HashSet::new();
    if let Some(parent) = deck.parent() {
        let stamp = parent.join(BUILD_STAMP_FILE_NAME);
        visited.insert(stamp.clone());
        if stamp.is_file() {
            if let Some(link) = manifest_from_stamp(&stamp, deck, slide_id) {
                return checked(link);
            }
        }
    }
    let skipped = [
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        "__pycache__",
        svg_assets::ASSET_CACHE_DIR_NAME,
        EDIT_HISTORY_DIR_NAME,
    ];
    let walker = walkdir::WalkDir::new(workspace)
        .max_depth(MANIFEST_SEARCH_MAX_DEPTH)
        .into_iter()
        .filter_entry(|entry| {
            !(entry.file_type().is_dir()
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| skipped.contains(&name)))
        });
    for entry in walker.filter_map(|entry| entry.ok()).take(MANIFEST_SEARCH_MAX_ENTRIES) {
        if entry.file_type().is_file()
            && entry.file_name().to_str() == Some(BUILD_STAMP_FILE_NAME)
            && visited.insert(entry.path().to_path_buf())
        {
            if let Some(link) = manifest_from_stamp(entry.path(), deck, slide_id) {
                return checked(link);
            }
        }
    }
    Err(
        "This deck is not linked to an ArcForge manifest in the workspace (no build record names it as output). Scoped edits need a deck created from a schema_version 3 manifest; rebuild it with OfficeRuntime create first."
            .to_string(),
    )
}

/// Run one read-only runtime command and parse its JSON report.
fn run_presentation_runtime_json(
    workdir: &Path,
    arguments: &[OsString],
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let runtime = resolve_runtime_program()?;
    let mut command = Command::new(&runtime.program);
    command
        .args(&runtime.prefix_arguments)
        .args(arguments)
        .current_dir(workdir)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start the ArcForge Office Runtime: {error}"))?;
    let stdout = child.stdout.take().ok_or("Failed to capture Office Runtime stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture Office Runtime stderr")?;
    let stdout_reader = thread::spawn(move || read_capped(stdout, STDOUT_LIMIT_BYTES));
    let stderr_reader = thread::spawn(move || read_capped(stderr, STDERR_LIMIT_BYTES));
    let cancelled = AtomicBool::new(false);
    let result = wait_for_child(&mut child, timeout, &cancelled);
    let output = stdout_reader.join().map(|captured| captured.text).unwrap_or_default();
    let errors = stderr_reader.join().map(|captured| captured.text).unwrap_or_default();
    let (status, timed_out, _) = result?;
    if timed_out {
        return Err("The Office Runtime timed out".to_string());
    }
    if !status.success() {
        let detail = errors.trim().trim_start_matches("error: ").trim();
        return Err(if detail.is_empty() {
            "The Office Runtime failed".to_string()
        } else {
            detail.to_string()
        });
    }
    serde_json::from_str(&output)
        .map_err(|error| format!("The Office Runtime returned invalid JSON: {error}"))
}

fn presentation_selection_context_sync(
    workdir: String,
    path: String,
    unit_id: Option<String>,
    element_id: Option<String>,
) -> Result<PresentationSelectionContextResponse, String> {
    let (file, display) = resolve_presentation_for_review(&workdir, &path)?;
    let workspace = std::fs::canonicalize(workdir.trim())
        .map_err(|error| format!("workdir cannot be opened: {error}"))?;
    let unit_id = unit_id.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let element_id = element_id.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    if let Some(unit_id) = unit_id.as_deref() {
        validate_edit_identifier(unit_id, "unitId", true)?;
    }
    if let Some(element_id) = element_id.as_deref() {
        validate_element_identifier(element_id)?;
    }
    let link = find_deck_manifest(&workspace, &file, unit_id.as_deref())?;
    let mut arguments = vec![OsString::from("presentation"), OsString::from("selection-context")];
    push_path_argument(&mut arguments, "--workspace", workspace.clone());
    push_path_argument(&mut arguments, "--spec", link.spec.clone());
    if let Some(unit_id) = &unit_id {
        arguments.push(OsString::from("--slide-id"));
        arguments.push(OsString::from(unit_id));
    }
    if let Some(element_id) = &element_id {
        arguments.push(OsString::from("--element-id"));
        arguments.push(OsString::from(element_id));
    }
    if let Some(template) = &link.template {
        push_path_argument(&mut arguments, "--template", template.clone());
    }
    let context = run_presentation_runtime_json(&workspace, &arguments, PRESENTATION_CONTEXT_TIMEOUT)?;
    let svg_path = context
        .get("slide")
        .and_then(|slide| slide.get("svg"))
        .and_then(serde_json::Value::as_str)
        .map(|svg| workspace_relative(&workspace, Path::new(svg)));
    Ok(PresentationSelectionContextResponse {
        path: display,
        manifest_path: workspace_relative(&workspace, &link.spec),
        manifest_dir: workspace_relative(&workspace, link.spec.parent().unwrap_or(&workspace)),
        template_path: link
            .template
            .as_deref()
            .map(|template| workspace_relative(&workspace, template)),
        svg_path,
        context,
    })
}

fn presentation_edit_history_sync(workdir: String, path: String) -> Result<PresentationEditHistoryResponse, String> {
    let (file, display) = resolve_presentation_for_review(&workdir, &path)?;
    let workspace = std::fs::canonicalize(workdir.trim())
        .map_err(|error| format!("workdir cannot be opened: {error}"))?;
    let link = find_deck_manifest(&workspace, &file, None)?;
    let mut edits = Vec::new();
    let history = link.spec.parent().map(|dir| dir.join(EDIT_HISTORY_DIR_NAME));
    if let Some(directory) = history.filter(|dir| dir.is_dir()) {
        let directory = std::fs::canonicalize(directory).map_err(|error| error.to_string())?;
        ensure_within_workspace(&directory, &workspace, "edit history")?;
        let entries = std::fs::read_dir(&directory)
            .map_err(|error| format!("Edit history cannot be read: {error}"))?;
        for entry in entries.flatten() {
            let record_path = entry.path();
            let is_json = record_path
                .extension()
                .and_then(OsStr::to_str)
                .is_some_and(|extension| extension.eq_ignore_ascii_case("json"));
            if !is_json {
                continue;
            }
            let Ok(record_path) = std::fs::canonicalize(record_path) else { continue; };
            ensure_within_workspace(&record_path, &workspace, "edit history record")?;
            let Ok(raw) = std::fs::read_to_string(&record_path) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let text = |key: &str| {
                value
                    .get(key)
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            };
            let (Some(edit_id), Some(slide_id)) = (text("edit_id"), text("slide_id")) else {
                continue;
            };
            if !text("output").is_some_and(|output| same_file(Path::new(&output), &file))
                || text("spec").is_some_and(|spec| !same_file(Path::new(&spec), &link.spec)) {
                continue;
            }
            edits.push(PresentationEditRecord {
                edit_id,
                slide_id,
                element_id: text("element_id"),
                scope: text("scope").unwrap_or_else(|| "unit".to_string()),
                kind: text("kind").unwrap_or_default(),
                target: text("target").unwrap_or_default(),
                created_at: text("created_at").unwrap_or_default(),
                reverted: value
                    .get("reverted")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                reverted_at: text("reverted_at"),
                before_text: text("before_text").unwrap_or_default(),
                after_text: text("after_text").unwrap_or_default(),
            });
        }
    }
    edits.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.edit_id.cmp(&a.edit_id))
    });
    Ok(PresentationEditHistoryResponse {
        path: display,
        manifest_path: workspace_relative(&workspace, &link.spec),
        edits,
    })
}

#[tauri::command]
pub async fn presentation_selection_context(
    workdir: String,
    path: String,
    unit_id: Option<String>,
    element_id: Option<String>,
) -> Result<PresentationSelectionContextResponse, String> {
    tokio::task::spawn_blocking(move || {
        presentation_selection_context_sync(workdir, path, unit_id, element_id)
    })
    .await
    .map_err(|error| format!("Selection context worker failed: {error}"))?
}

#[tauri::command]
pub async fn presentation_edit_history(
    workdir: String,
    path: String,
) -> Result<PresentationEditHistoryResponse, String> {
    tokio::task::spawn_blocking(move || presentation_edit_history_sync(workdir, path))
        .await
        .map_err(|error| format!("Edit history worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review_shape(id: usize, name: &str, role: &str, content: &str) -> String {
        format!(r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{name}" descr="{role}"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="80"/><a:ext cx="200" cy="50"/></a:xfrm></p:spPr>{content}</p:sp>"#)
    }

    #[test]
    fn presentation_elements_exposes_seven_roles_and_keeps_groups_atomic() {
        let mut shapes = SEMANTIC_ELEMENT_TYPES.iter().enumerate().map(|(index, role)| {
            review_shape(index + 1, role, &format!("arcforge:role={role}"), "")
        }).collect::<String>();
        let child = review_shape(20, "icon/1", "arcforge:role=title", "<p:txBody><a:t>child</a:t></p:txBody>");
        shapes.push_str(&format!(r#"<p:grpSp><p:nvGrpSpPr><p:cNvPr id="19" name="icon"/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="400" y="200"/><a:ext cx="80" cy="80"/><a:chOff x="0" y="0"/><a:chExt cx="24" cy="24"/></a:xfrm></p:grpSpPr>{child}</p:grpSp>"#));
        shapes.push_str(&review_shape(21, "decoration", "", ""));
        let elements = presentation_elements_from_xml(&format!("<p:spTree>{shapes}</p:spTree>"), 1280.0, 720.0, &[]);
        assert_eq!(elements.len(), 8);
        assert_eq!(elements.iter().take(7).map(|element| element.element_type.as_str()).collect::<Vec<_>>(), SEMANTIC_ELEMENT_TYPES);
        assert_eq!(elements[0].bbox, [100.0, 80.0, 200.0, 50.0]);
        assert_eq!(elements[7].id, "icon");
        assert_eq!(elements[7].bbox, [400.0, 200.0, 80.0, 80.0]);
        assert!(!elements.iter().any(|element| element.id == "icon/1"));
    }

    #[test]
    fn presentation_elements_duplicate_and_default_names_use_stable_shape_ids() {
        let text = "<p:txBody><a:t>Hello &amp; world</a:t></p:txBody>";
        let a = review_shape(10, "Text", "", text);
        let b = review_shape(11, "Text", "", text);
        let explicit = review_shape(12, "shape-10", "arcforge:role=title", text);
        let read = |shapes: String| presentation_elements_from_xml(&format!("<p:spTree>{shapes}</p:spTree>"), 1280.0, 720.0, &[]);
        let first = read(format!("{a}{b}{explicit}"));
        let second = read(format!("{b}{a}{explicit}"));
        assert_eq!(first[0].id, "shape-shape-10");
        assert_eq!(first[1].id, "shape-11");
        assert_eq!(first[2].id, "shape-10");
        assert_eq!(first[0].id, second[1].id);
        assert_eq!(first[1].id, second[0].id);
        assert_eq!(read(b)[0].id, "shape-11");
        assert_eq!(first[0].label, "Hello & world");
    }

    #[test]
    fn presentation_elements_reads_native_media_and_inherited_placeholder_boxes() {
        let transform = r#"<a:off x="10" y="20"/><a:ext cx="100" cy="50"/>"#;
        let picture = format!(r#"<p:pic><p:nvPicPr><p:cNvPr id="1" name="hero"/></p:nvPicPr><p:spPr><a:xfrm rot="5400000">{transform}</a:xfrm></p:spPr></p:pic>"#);
        let graphic = |id, kind| format!(r#"<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{id}" name="{kind}"/></p:nvGraphicFramePr><p:xfrm>{transform}</p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/{kind}"/></a:graphic></p:graphicFrame>"#);
        let placeholder = r#"<p:sp><p:nvSpPr><p:cNvPr id="4" name="Heading"/><p:nvPr><p:ph type="title" idx="2"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:t>Title</a:t></p:txBody></p:sp>"#;
        let layout = placeholder.replace("<p:spPr/>", &format!("<p:spPr><a:xfrm>{transform}</a:xfrm></p:spPr>"));
        let xml = format!("<p:spTree>{picture}{}{}{placeholder}</p:spTree>", graphic(2, "chart"), graphic(3, "table"));
        let elements = presentation_elements_from_xml(&xml, 1280.0, 720.0, &[("p:sp".to_string(), layout)]);
        assert_eq!(elements.len(), 4);
        assert_eq!(elements.iter().map(|element| element.element_type.as_str()).collect::<Vec<_>>(), ["image", "chart", "table", "title"]);
        assert!((elements[0].bbox[2] - 50.0).abs() < 0.01);
        assert!((elements[0].bbox[3] - 100.0).abs() < 0.01);
        assert_eq!(elements[3].bbox, [10.0, 20.0, 100.0, 50.0]);
    }

    fn word_request(workspace: &Path, action: &str) -> OfficeRuntimeRequest {
        OfficeRuntimeRequest {
            request_id: format!("word-{action}-test"),
            workdir: workspace.to_string_lossy().into_owned(),
            document_type: "word".to_string(),
            action: action.to_string(),
            spec_path: None,
            script_path: None,
            input_path: None,
            output_path: None,
            force: false,
            timeout_ms: Some(5_000),
            edit: None,
        }
    }

    fn argument_strings(invocation: &PreparedInvocation) -> Vec<String> {
        invocation
            .arguments
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn output_path_stays_in_workspace() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = std::fs::canonicalize(temp.path()).expect("canonical workspace");
        let output = resolve_output_path(&workspace, "reports/book.xlsx", "xlsx", "outputPath")
            .expect("valid output");
        assert!(output.starts_with(&workspace));
        assert!(output.ends_with("reports/book.xlsx"));
    }

    #[test]
    fn output_path_rejects_parent_escape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = std::fs::canonicalize(temp.path()).expect("canonical workspace");
        let error = resolve_output_path(&workspace, "../book.xlsx", "xlsx", "outputPath")
            .expect_err("parent path must be rejected");
        assert!(error.contains("must not contain '..'"));
    }

    #[test]
    fn spreadsheet_code_prepares_a_workspace_script_and_output() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            temp.path().join("transform.py"),
            "sheet = workbook.active\n",
        )
        .expect("write script");
        let invocation = prepare_invocation(OfficeRuntimeRequest {
            request_id: "spreadsheet-code-test".to_string(),
            workdir: temp.path().to_string_lossy().into_owned(),
            document_type: "spreadsheet".to_string(),
            action: "code".to_string(),
            spec_path: None,
            script_path: Some("transform.py".to_string()),
            input_path: None,
            output_path: Some("result.xlsx".to_string()),
            force: false,
            timeout_ms: Some(5_000),
            edit: None,
        })
        .expect("prepare SpreadsheetCode invocation");
        let arguments = invocation
            .arguments
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(arguments[0], "spreadsheet");
        assert_eq!(arguments[1], "code");
        assert!(arguments.iter().any(|value| value == "--script"));
        assert!(arguments
            .iter()
            .any(|value| value.ends_with("transform.py")));
        assert!(arguments.iter().any(|value| value == "--output"));
        assert!(arguments.iter().any(|value| value.ends_with("result.xlsx")));
    }

    #[test]
    fn spreadsheet_code_rejects_a_script_parent_escape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let error = prepare_invocation(OfficeRuntimeRequest {
            request_id: "spreadsheet-code-escape-test".to_string(),
            workdir: temp.path().to_string_lossy().into_owned(),
            document_type: "spreadsheet".to_string(),
            action: "code".to_string(),
            spec_path: None,
            script_path: Some("../transform.py".to_string()),
            input_path: None,
            output_path: Some("result.xlsx".to_string()),
            force: false,
            timeout_ms: None,
            edit: None,
        })
        .expect_err("parent path must be rejected");
        assert!(error.contains("scriptPath must not contain '..'"));
    }

    #[test]
    fn word_create_maps_to_officecli_create() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut request = word_request(temp.path(), "create");
        request.output_path = Some("reports/report.docx".to_string());
        let invocation = prepare_invocation(request).expect("prepare word create");
        let arguments = argument_strings(&invocation);

        assert_eq!(invocation.backend, RuntimeBackend::OfficeCli);
        assert_eq!(arguments[0], "create");
        assert!(
            arguments[1].ends_with("reports\\report.docx")
                || arguments[1].ends_with("reports/report.docx")
        );
        assert_eq!(arguments[2], "--json");
        assert!(matches!(
            invocation.officecli_output,
            Some(OfficeCliOutput::New { target, .. }) if target.ends_with("reports/report.docx")
        ));
    }

    #[test]
    fn provider_reads_a_disposable_copy_of_the_revision_snapshot() {
        let temp = tempfile::tempdir().expect("tempdir");
        let input = temp.path().join("report.docx");
        let snapshot = temp.path().join("snapshot.docx");
        std::fs::write(&input, b"live").expect("live input");
        std::fs::write(&snapshot, b"immutable version").expect("snapshot");
        let mut arguments = vec![
            OsString::from("validate"),
            input.clone().into_os_string(),
            OsString::from("--json"),
        ];

        let staged = stage_artifact_input(
            &mut arguments,
            Some(&input),
            Some(&snapshot),
            "snapshot-test",
        )
        .expect("stage snapshot")
        .expect("staged copy");
        let staged_path = PathBuf::from(&arguments[1]);
        assert_ne!(staged_path, snapshot);
        assert_eq!(
            std::fs::read(&staged_path).expect("staged content"),
            b"immutable version"
        );
        std::fs::write(&staged_path, b"provider mutation").expect("modify staged copy");
        assert_eq!(
            std::fs::read(&snapshot).expect("snapshot content"),
            b"immutable version"
        );
        drop(staged);
        assert!(!staged_path.exists());
    }

    #[test]
    fn publication_remains_successful_when_staging_cleanup_fails() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("staged.docx");
        let target = temp.path().join("published.docx");
        std::fs::write(&source, b"published").expect("staged output");

        publish_without_replace_with_cleanup(&source, &target, |_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "simulated cleanup failure",
            ))
        })
        .expect("publication must succeed");
        assert_eq!(
            std::fs::read(&target).expect("published target"),
            b"published"
        );
        assert!(
            source.exists(),
            "failed cleanup should leave the staging link"
        );
    }

    #[test]
    fn word_create_rejects_a_batch_spec() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("operations.json"), "[]").expect("write spec");
        let mut request = word_request(temp.path(), "create");
        request.spec_path = Some("operations.json".to_string());
        request.output_path = Some("report.docx".to_string());

        let error = prepare_invocation(request).expect_err("create spec must be rejected");
        assert!(error.contains("specPath is not valid"));
    }

    #[test]
    fn word_force_controls_arcforge_commit_without_bypassing_document_protection() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("source.docx"), b"docx").expect("write document");
        std::fs::write(
            temp.path().join("operations.json"),
            r#"[{"command":"set","path":"/body/p[1]","props":{"text":"Updated"}}]"#,
        )
        .expect("write spec");
        let mut request = word_request(temp.path(), "patch");
        request.input_path = Some("source.docx".to_string());
        request.spec_path = Some("operations.json".to_string());
        request.output_path = Some("source.docx".to_string());
        request.force = true;

        let invocation = prepare_invocation(request).expect("prepare in-place patch");
        let arguments = argument_strings(&invocation);
        assert!(!arguments.iter().any(|argument| argument == "--force"));
    }

    #[test]
    fn word_patch_maps_to_atomic_officecli_batch() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("source.docx"), b"docx").expect("write document");
        std::fs::write(
            temp.path().join("operations.json"),
            r#"[{"command":"set","path":"/body/p[1]","props":{"text":"Updated"}}]"#,
        )
        .expect("write spec");
        let mut request = word_request(temp.path(), "patch");
        request.input_path = Some("source.docx".to_string());
        request.spec_path = Some("operations.json".to_string());
        request.output_path = Some("result.docx".to_string());
        let invocation = prepare_invocation(request).expect("prepare word patch");
        let arguments = argument_strings(&invocation);

        assert_eq!(invocation.backend, RuntimeBackend::OfficeCli);
        assert_eq!(arguments[0], "batch");
        assert!(arguments[1].ends_with("result.docx"));
        assert_eq!(arguments[2], "--input");
        assert!(arguments[3].ends_with("operations.json"));
        assert_eq!(arguments[4], "--json");
        let Some(OfficeCliOutput::Copy { source, target, .. }) = invocation.officecli_output else {
            panic!("expected staged copy");
        };
        assert!(source.ends_with("source.docx"));
        assert!(target.ends_with("result.docx"));
    }

    #[test]
    fn word_patch_rejects_unsafe_batch_commands() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("source.docx"), b"docx").expect("write document");
        std::fs::write(
            temp.path().join("operations.json"),
            r#"[{"command":"raw-set","path":"document","xml":"<w:p/>"}]"#,
        )
        .expect("write spec");
        let mut request = word_request(temp.path(), "patch");
        request.input_path = Some("source.docx".to_string());
        request.spec_path = Some("operations.json".to_string());
        request.output_path = Some("result.docx".to_string());

        let error = prepare_invocation(request).expect_err("raw-set must be rejected");
        assert!(error.contains("unsupported or unsafe OfficeCLI command 'raw-set'"));
    }

    #[test]
    fn word_patch_rejects_unknown_fields_and_external_assets() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("source.docx"), b"docx").expect("write document");

        for (spec, expected) in [
            (
                r#"[{"command":"set","path":"/body/p[1]","shell":"open"}]"#,
                "field 'shell' is not allowed",
            ),
            (
                r#"[{"command":"add","parent":"/body","type":"picture","props":{"src":"asset.png"}}]"#,
                "may read external data",
            ),
            (
                r#"[{"command":"set","path":"/body/p[1]","props":{"file":"outside.bin"}}]"#,
                "may read external data",
            ),
        ] {
            std::fs::write(temp.path().join("operations.json"), spec).expect("write spec");
            let mut request = word_request(temp.path(), "patch");
            request.input_path = Some("source.docx".to_string());
            request.spec_path = Some("operations.json".to_string());
            request.output_path = Some("result.docx".to_string());
            let error = prepare_invocation(request).expect_err("unsafe spec must be rejected");
            assert!(error.contains(expected), "unexpected error: {error}");
        }
    }

    #[test]
    fn word_patch_rejects_mixed_case_batch_field_names() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("source.docx"), b"docx").expect("write document");
        for spec in [
            r#"[{"command":"add","parent":"/body","Type":"paragraph"}]"#,
            r#"[{"command":"set","path":"/body/p[1]","Props":{"text":"Updated"}}]"#,
        ] {
            std::fs::write(temp.path().join("operations.json"), spec).expect("write spec");
            let mut request = word_request(temp.path(), "patch");
            request.input_path = Some("source.docx".to_string());
            request.spec_path = Some("operations.json".to_string());
            request.output_path = Some("result.docx".to_string());
            let error = prepare_invocation(request).expect_err("mixed-case field must be rejected");
            assert!(
                error.contains("canonical lowercase spelling"),
                "unexpected error: {error}"
            );
        }
    }

    #[test]
    fn word_inspect_and_validate_are_read_only_officecli_commands() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("report.docx"), b"docx").expect("write document");

        let mut inspect = word_request(temp.path(), "inspect");
        inspect.input_path = Some("report.docx".to_string());
        let inspect_invocation = prepare_invocation(inspect).expect("prepare inspect");
        let inspect_arguments = argument_strings(&inspect_invocation);
        assert_eq!(inspect_arguments[0], "view");
        assert_eq!(inspect_arguments[2], "outline");
        assert_eq!(inspect_arguments[3], "--json");

        let mut validate = word_request(temp.path(), "validate");
        validate.input_path = Some("report.docx".to_string());
        let validate_invocation = prepare_invocation(validate).expect("prepare validate");
        let validate_arguments = argument_strings(&validate_invocation);
        assert_eq!(validate_arguments[0], "validate");
        assert!(validate_arguments[1].ends_with("report.docx"));
        assert_eq!(validate_arguments[2], "--json");
    }

    #[test]
    fn word_render_selects_html_or_screenshot_and_rejects_other_extensions() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("report.docx"), b"docx").expect("write document");

        for (output, expected_mode) in [("preview.html", "html"), ("preview.png", "screenshot")] {
            let mut request = word_request(temp.path(), "render");
            request.input_path = Some("report.docx".to_string());
            request.output_path = Some(output.to_string());
            let invocation = prepare_invocation(request).expect("prepare render");
            let arguments = argument_strings(&invocation);
            assert_eq!(arguments[0], "view");
            assert_eq!(arguments[2], expected_mode);
            assert_eq!(arguments[3], "-o");
            assert!(arguments[4].ends_with(output));
            assert_eq!(arguments[5], "--json");
            assert!(matches!(
                invocation.officecli_output,
                Some(OfficeCliOutput::New { target, .. }) if target.ends_with(output)
            ));
        }

        let mut invalid = word_request(temp.path(), "render");
        invalid.input_path = Some("report.docx".to_string());
        invalid.output_path = Some("preview.pdf".to_string());
        let error = prepare_invocation(invalid).expect_err("PDF must be rejected");
        assert!(error.contains(".html or .png"));
    }

    #[test]
    fn commit_officecli_output_preserves_then_replaces_existing_target() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("report.docx");
        let staged = temp.path().join("staged.docx");
        std::fs::write(&target, b"old").expect("write target");
        std::fs::write(&staged, b"new").expect("write staged");
        let expected = capture_target_state(&target, true).expect("target state");

        commit_officecli_output(&staged, &target, &expected, "commit-test").expect("commit output");

        assert_eq!(std::fs::read(&target).expect("read target"), b"new");
        assert!(!staged.exists());
        let backup = officecli_staging_path(&target, "commit-test", "backup").expect("backup path");
        assert!(!backup.exists());
    }

    #[test]
    fn commit_officecli_output_never_replaces_a_concurrent_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("report.docx");
        let staged = temp.path().join("staged.docx");
        let expected = capture_target_state(&target, false).expect("missing target state");
        std::fs::write(&staged, b"generated").expect("write staged");
        std::fs::write(&target, b"concurrent").expect("write concurrent target");

        let error = commit_officecli_output(&staged, &target, &expected, "race-test")
            .expect_err("concurrent target must be preserved");

        assert!(error.contains("changed while the operation was running"));
        assert_eq!(std::fs::read(&target).expect("read target"), b"concurrent");
        assert_eq!(std::fs::read(&staged).expect("read staged"), b"generated");
    }

    #[test]
    fn commit_officecli_output_rejects_changes_after_force_authorization() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("report.docx");
        let staged = temp.path().join("staged.docx");
        std::fs::write(&target, b"authorized old content").expect("write target");
        let expected = capture_target_state(&target, true).expect("authorized target state");
        std::fs::write(&staged, b"generated").expect("write staged");
        std::fs::write(&target, b"new external content").expect("change target");

        let error = commit_officecli_output(&staged, &target, &expected, "force-race-test")
            .expect_err("external change must be preserved");

        assert!(error.contains("changed while the operation was running"));
        assert_eq!(
            std::fs::read(&target).expect("read target"),
            b"new external content"
        );
    }

    fn presentation_request(workspace: &Path, action: &str) -> OfficeRuntimeRequest {
        OfficeRuntimeRequest {
            request_id: format!("presentation-{action}-test"),
            workdir: workspace.to_string_lossy().into_owned(),
            document_type: "presentation".to_string(),
            action: action.to_string(),
            spec_path: None,
            script_path: None,
            input_path: None,
            output_path: None,
            force: false,
            timeout_ms: Some(5_000),
            edit: None,
        }
    }

    const SAFE_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><rect data-arcforge="background" x="0" y="0" width="1280" height="720" fill="#F4F6FA"/><text x="60" y="118" font-size="34" font-weight="bold">标题</text><image data-asset="hero" x="60" y="150" width="400" height="300"/></svg>"##;

    fn write_svg_deck(workspace: &Path, svg: &str) {
        std::fs::create_dir_all(workspace.join("pages")).expect("pages dir");
        std::fs::write(workspace.join("pages/p-01.svg"), svg).expect("write svg");
        std::fs::write(workspace.join("hero.png"), b"\x89PNG\r\n\x1a\n").expect("write asset");
        std::fs::write(
            workspace.join("deck.json"),
            r#"{"schema_version":3,"stage":"design","assets":{"hero":"hero.png"},"slides":[{"slide_id":"p-01","svg":"pages/p-01.svg"}]}"#,
        )
        .expect("write manifest");
    }

    fn write_test_pptx(path: &Path, slide_count: usize) {
        use std::io::Write as _;
        let mut writer = zip::ZipWriter::new(std::fs::File::create(path).expect("create pptx"));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer
            .start_file("[Content_Types].xml", options)
            .expect("start content types");
        writer.write_all(b"<Types/>").expect("write content types");
        for index in 1..=slide_count {
            writer
                .start_file(format!("ppt/slides/slide{index}.xml"), options)
                .expect("start slide");
            writer.write_all(b"<p:sld/>").expect("write slide");
        }
        writer
            .start_file("ppt/slides/_rels/slide1.xml.rels", options)
            .expect("start rels");
        writer.write_all(b"<Relationships/>").expect("write rels");
        writer.finish().expect("finish pptx");
    }

    #[test]
    fn presentation_create_accepts_an_svg_deck_manifest_with_a_template() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_svg_deck(temp.path(), SAFE_SVG);
        write_test_pptx(&temp.path().join("brand.pptx"), 2);

        let mut request = presentation_request(temp.path(), "create");
        request.spec_path = Some("deck.json".to_string());
        request.input_path = Some("brand.pptx".to_string());
        request.output_path = Some("out/deck.pptx".to_string());
        let invocation = prepare_invocation(request).expect("prepare presentation create");
        let arguments = argument_strings(&invocation);

        assert_eq!(invocation.backend, RuntimeBackend::ArcForge);
        assert_eq!(arguments[0], "presentation");
        assert_eq!(arguments[1], "create");
        assert!(arguments.iter().any(|value| value == "--template"));
        assert!(arguments.iter().any(|value| value.ends_with("brand.pptx")));
        assert!(invocation
            .input_target
            .as_deref()
            .is_some_and(|path| path.ends_with("brand.pptx")));
    }

    #[test]
    fn presentation_template_pages_accept_edits_without_svg_via_input_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_test_pptx(&temp.path().join("brand.pptx"), 2);
        std::fs::write(temp.path().join("deck.json"), serde_json::json!({
            "schema_version": 3,
            "slides": [{"slide_id": "cover", "source_slide": 1,
                "text_edits": [{"shape_id": 14, "text": "Quarterly report"}],
                "table_edits": [{"shape_id": 34, "shape_path": [12, 34],
                    "rows": [["Item", "Value"], ["Revenue", "100"]]}]}]
        }).to_string()).expect("manifest");
        for action in ["create", "validate"] {
            let mut request = presentation_request(temp.path(), action);
            request.spec_path = Some("deck.json".to_string());
            request.input_path = Some("brand.pptx".to_string());
            if action == "create" { request.output_path = Some("out.pptx".to_string()); }
            let invocation = prepare_invocation(request).expect("template page without SVG");
            assert!(argument_strings(&invocation).iter().any(|argument| argument == "--template"));
        }
    }

    #[test]
    fn presentation_template_manifest_rejects_invalid_selectors_and_edits() {
        let temp = tempfile::tempdir().expect("tempdir");
        let cases = [
            (serde_json::json!({"source_slide": 0}), "source_slide"),
            (serde_json::json!({"source_slide": true}), "source_slide"),
            (serde_json::json!({"source_slide": 1, "svg": ""}), "svg"),
            (serde_json::json!({"source_slide": 1, "layout": -1}), "layout"),
            (serde_json::json!({"source_slide": 1, "text_edits": [{"shape_id": 14, "text": 5}]}), ".text"),
            (serde_json::json!({"source_slide": 1, "text_edits": [{"shape_id": 14, "shape_path": [12, 13], "text": "x"}]}), "shape_path"),
            (serde_json::json!({"source_slide": 1, "table_edits": [{"shape_id": 34, "rows": [["x"], ["y", "z"]]}]}), ".rows"),
            (serde_json::json!({"text_edits": []}), "requires source_slide"),
        ];
        for (slide, expected) in cases {
            let value = serde_json::json!({"schema_version": 3, "mode": "template", "slides": [slide]});
            let error = validate_svg_deck_manifest(&value, temp.path(), temp.path(), false)
                .expect_err("invalid template selector/edit");
            assert!(error.contains(expected), "expected {expected}, got {error}");
        }
        let value = serde_json::json!({"schema_version": 3, "slides": [{"source_slide": 1}]});
        assert!(validate_svg_deck_manifest(&value, temp.path(), temp.path(), false)
            .expect_err("template missing").contains("requires template mode"));
    }

    #[test]
    fn presentation_template_overlay_keeps_svg_workspace_validation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let value = serde_json::json!({"schema_version": 3, "mode": "template", "slides": [
            {"slide_id": "cover", "source_slide": 1, "svg": "../outside.svg"}
        ]});
        assert!(validate_svg_deck_manifest(&value, temp.path(), temp.path(), false)
            .expect_err("overlay must remain in workspace").contains("must not contain '..'"));
    }

    #[test]
    fn presentation_create_rejects_a_template_for_legacy_specs() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            temp.path().join("legacy.json"),
            r#"{"slides":[{"type":"title","title":"Hello"}]}"#,
        )
        .expect("write legacy spec");
        write_test_pptx(&temp.path().join("brand.pptx"), 1);

        let mut request = presentation_request(temp.path(), "create");
        request.spec_path = Some("legacy.json".to_string());
        request.input_path = Some("brand.pptx".to_string());
        request.output_path = Some("deck.pptx".to_string());
        let error = prepare_invocation(request).expect_err("legacy spec must reject template");
        assert!(
            error.contains("schema_version 3"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn svg_deck_manifest_rejects_external_references_and_missing_assets() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_svg_deck(
            temp.path(),
            r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1280 720"><image xlink:href="file:///C:/secret.png" x="0" y="0" width="10" height="10"/></svg>"##,
        );
        let mut request = presentation_request(temp.path(), "create");
        request.spec_path = Some("deck.json".to_string());
        request.output_path = Some("deck.pptx".to_string());
        let error = prepare_invocation(request).expect_err("href must be rejected");
        assert!(error.contains("href"), "unexpected error: {error}");

        std::fs::write(
            temp.path().join("deck.json"),
            r#"{"schema_version":3,"assets":{"hero":"../outside.png"},"slides":[{"slide_id":"p-01","svg":"pages/p-01.svg"}]}"#,
        )
        .expect("rewrite manifest");
        std::fs::write(temp.path().join("pages/p-01.svg"), SAFE_SVG).expect("safe svg");
        let mut request = presentation_request(temp.path(), "create");
        request.spec_path = Some("deck.json".to_string());
        request.output_path = Some("deck.pptx".to_string());
        let error = prepare_invocation(request).expect_err("asset escape must be rejected");
        assert!(
            error.contains("must not contain '..'"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn svg_assets_in_the_manifest_are_prepared_and_passed_to_the_runtime() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("deck/pages")).expect("pages dir");
        std::fs::create_dir_all(temp.path().join("deck/assets")).expect("assets dir");
        std::fs::write(
            temp.path().join("deck/assets/icon.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>"##,
        )
        .expect("write icon");
        std::fs::write(
            temp.path().join("deck/pages/p-01.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><image id="icon-check" data-asset="icon" data-fill="#2563EB" x="60" y="60" width="96" height="96"/></svg>"##,
        )
        .expect("write page");
        std::fs::write(
            temp.path().join("deck/deck.json"),
            r#"{"schema_version":3,"stage":"design","assets":{"icon":"assets/icon.svg"},"slides":[{"slide_id":"p-01","svg":"pages/p-01.svg"}]}"#,
        )
        .expect("write manifest");

        let mut request = presentation_request(temp.path(), "create");
        request.spec_path = Some("deck/deck.json".to_string());
        request.output_path = Some("deck/out.pptx".to_string());
        let invocation = prepare_invocation(request).expect("prepare presentation create");
        let arguments = argument_strings(&invocation);
        let cache_index = arguments
            .iter()
            .position(|value| value == "--asset-cache")
            .expect("asset cache argument");
        let cache_dir = PathBuf::from(&arguments[cache_index + 1]);
        assert!(cache_dir.ends_with(".arcforge-assets"), "{}", cache_dir.display());
        let shapes = std::fs::read_to_string(cache_dir.join("icon/shapes.json"))
            .expect("normalized shapes.json");
        assert!(shapes.contains("\"mode\":\"shapes\""), "{shapes}");
        assert!(cache_dir.join("icon/raster.png").is_file());

        std::fs::write(
            temp.path().join("deck/assets/icon.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///C:/secret.png" width="1" height="1"/></svg>"##,
        )
        .expect("rewrite icon");
        let mut request = presentation_request(temp.path(), "validate");
        request.spec_path = Some("deck/deck.json".to_string());
        let error = prepare_invocation(request).expect_err("external href must be rejected");
        assert!(error.contains("assets.icon"), "{error}");
    }

    /// Manual probe helper: `ARCFORGE_SVG_ASSET_PROBE_SPEC=<manifest> cargo test -- --ignored
    /// probe_prepare_manifest_assets_from_env` normalizes the SVG assets of a real manifest so the
    /// Python runtime can be exercised outside the desktop app.
    #[test]
    #[ignore]
    fn probe_prepare_manifest_assets_from_env() {
        let Some(spec) = std::env::var_os("ARCFORGE_SVG_ASSET_PROBE_SPEC") else {
            return;
        };
        let spec = std::fs::canonicalize(PathBuf::from(spec)).expect("manifest path");
        let workspace = spec
            .parent()
            .and_then(Path::parent)
            .expect("manifest inside <workspace>/<deck>/")
            .to_path_buf();
        let cache = validate_presentation_assets(&spec, &workspace, false).expect("prepare assets");
        println!("asset cache: {:?}", cache);
    }

    fn write_review_pptx(path: &Path) {
        use std::io::Write as _;
        let mut writer = zip::ZipWriter::new(std::fs::File::create(path).expect("create pptx"));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let mut put = |name: &str, body: &str| {
            writer.start_file(name, options).expect("start entry");
            writer.write_all(body.as_bytes()).expect("write entry");
        };
        put("[Content_Types].xml", "<Types/>");
        // sldIdLst lists the second part first, so presentation order must win over numbering.
        put(
            "ppt/presentation.xml",
            r#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>"#,
        );
        put(
            "ppt/_rels/presentation.xml.rels",
            r#"<Relationships><Relationship Id="rId2" Type="slide" Target="slides/slide1.xml"/><Relationship Target="slides/slide2.xml" Type="slide" Id="rId3"/><Relationship Id="rId1" Type="theme" Target="theme/theme1.xml"/></Relationships>"#,
        );
        put(
            "ppt/slides/slide1.xml",
            r#"<p:sld xmlns:p="p" xmlns:a="a"><p:cSld name="p-01"><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>封面 &amp; 标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#,
        );
        put(
            "ppt/slides/slide2.xml",
            r#"<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree/></p:cSld></p:sld>"#,
        );
        put("ppt/slides/_rels/slide1.xml.rels", "<Relationships/>");
        put("ppt/theme/theme1.xml", "<a:theme/>");
        writer.finish().expect("finish pptx");
    }

    #[test]
    fn scoped_edit_context_finds_the_manifest_through_the_build_record() {
        let temp = tempfile::tempdir().expect("tempdir");
        let deck_dir = temp.path().join("deck");
        std::fs::create_dir_all(deck_dir.join("out")).unwrap();
        write_review_pptx(&deck_dir.join("out").join("final.pptx"));
        std::fs::write(
            deck_dir.join("deck.json"),
            r#"{"schema_version":3,"slides":[{"slide_id":"p-01","svg":"p-01.svg"}]}"#,
        )
        .unwrap();
        std::fs::write(
            deck_dir.join("other.json"),
            r#"{"schema_version":3,"slides":[{"slide_id":"zzz","svg":"zzz.svg"}]}"#,
        )
        .unwrap();
        let workspace = std::fs::canonicalize(temp.path()).unwrap();
        let deck = std::fs::canonicalize(deck_dir.join("out").join("final.pptx")).unwrap();
        let json = |path: &Path| serde_json::to_string(&path.to_string_lossy()).unwrap();
        assert!(find_deck_manifest(&workspace, &deck, Some("p-01")).is_err());

        // A legacy record without a manifest name: scan its directory for a manifest naming the page.
        std::fs::write(
            deck_dir.join(".arcforge-build.json"),
            format!(r#"{{"schema":1,"output":{},"slides":{{}}}}"#, json(&deck)),
        )
        .unwrap();
        let link = find_deck_manifest(&workspace, &deck, Some("p-01")).expect("legacy link");
        assert!(link.spec.ends_with("deck.json"));
        assert!(link.template.is_none());
        assert!(find_deck_manifest(&workspace, &deck, Some("missing")).is_err());

        // A schema 2 record names the manifest and the template directly.
        std::fs::write(deck_dir.join("template.pptx"), b"x").unwrap();
        std::fs::write(
            deck_dir.join(".arcforge-build.json"),
            format!(
                r#"{{"schema":2,"output":{},"spec":{},"template":{},"slides":{{}}}}"#,
                json(&deck),
                json(&deck_dir.join("deck.json")),
                json(&deck_dir.join("template.pptx"))
            ),
        )
        .unwrap();
        let link = find_deck_manifest(&workspace, &deck, Some("p-01")).expect("schema 2 link");
        assert!(link.spec.ends_with("deck.json"));
        assert!(link.template.as_deref().is_some_and(|template| template.ends_with("template.pptx")));
        assert_eq!(workspace_relative(&workspace, &link.spec), "deck/deck.json");

        let history_dir = deck_dir.join(".arcforge-history");
        std::fs::create_dir_all(&history_dir).unwrap();
        std::fs::write(
            history_dir.join("e-1.json"),
            r#"{"edit_id":"e-1","slide_id":"p-01","element_id":"title","scope":"element","kind":"svg_element","target":"p-01.svg","created_at":"2026-09-16T10:00:00+00:00","reverted":false,"before_text":"a","after_text":"b"}"#,
        )
        .unwrap();
        std::fs::write(
            history_dir.join("e-2.json"),
            r#"{"edit_id":"e-2","slide_id":"p-01","element_id":null,"scope":"unit","kind":"svg_page","target":"p-01.svg","created_at":"2026-09-16T11:00:00+00:00","reverted":true,"reverted_at":"2026-09-16T12:00:00+00:00","before_text":"","after_text":""}"#,
        )
        .unwrap();
        for name in ["e-1.json", "e-2.json"] {
            let path = history_dir.join(name);
            let mut record: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            record["output"] = serde_json::json!(deck);
            std::fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
        }
        std::fs::write(history_dir.join("other.json"), r#"{"edit_id":"other","slide_id":"p-01","output":"other.pptx"}"#).unwrap();
        std::fs::write(history_dir.join("junk.json"), "not json").unwrap();
        let history = presentation_edit_history_sync(
            temp.path().to_string_lossy().into_owned(),
            "deck/out/final.pptx".to_string(),
        )
        .expect("history");
        assert_eq!(history.manifest_path, "deck/deck.json");
        assert_eq!(
            history.edits.iter().map(|edit| edit.edit_id.as_str()).collect::<Vec<_>>(),
            ["e-2", "e-1"]
        );
        assert!(history.edits[0].reverted);
        assert_eq!(history.edits[1].element_id.as_deref(), Some("title"));
    }

    #[test]
    fn presentation_patch_stages_the_replacement_and_validates_the_edit() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("deck")).unwrap();
        std::fs::write(
            temp.path().join("deck").join("p-01.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><text id="title">x</text></svg>"#,
        )
        .unwrap();
        std::fs::write(
            temp.path().join("deck").join("deck.json"),
            r#"{"schema_version":3,"slides":[{"slide_id":"p-01","svg":"p-01.svg"}]}"#,
        )
        .unwrap();
        write_review_pptx(&temp.path().join("deck").join("final.pptx"));
        std::fs::write(temp.path().join("deck/.arcforge-build.json"), serde_json::to_vec(&serde_json::json!({
            "schema": 2, "spec": temp.path().join("deck/deck.json"), "output": temp.path().join("deck/final.pptx"), "slides": {}
        })).unwrap()).unwrap();
        let request = |edit: PresentationEditRequest| OfficeRuntimeRequest {
            spec_path: Some("deck/deck.json".to_string()),
            output_path: Some("deck/final.pptx".to_string()),
            edit: Some(edit),
            ..presentation_request(temp.path(), "patch")
        };
        let invocation = prepare_invocation(request(PresentationEditRequest {
            slide_id: Some("p-01".to_string()),
            element_id: Some("title".to_string()),
            replacement: Some(r#"<text id="title">y</text>"#.to_string()),
            edit_id: Some("e-1".to_string()),
            revert: None,
        }))
        .expect("prepare patch");
        let arguments = argument_strings(&invocation);
        assert_eq!(&arguments[..2], ["presentation", "patch"]);
        for flag in ["--spec", "--output", "--slide-id", "--element-id", "--edit-id", "--replacement"] {
            assert!(arguments.iter().any(|value| value == flag), "missing {flag}");
        }
        assert!(invocation.artifact_record.input_path.is_none());
        let staged = invocation.scratch_files[0].0.clone();
        assert_eq!(std::fs::read_to_string(&staged).unwrap(), r#"<text id="title">y</text>"#);
        drop(invocation);
        assert!(!staged.exists(), "staged replacement is removed with the invocation");

        let revert = prepare_invocation(request(PresentationEditRequest {
            revert: Some("e-1".to_string()),
            ..PresentationEditRequest::default()
        }))
        .expect("prepare revert");
        assert!(argument_strings(&revert).windows(2).any(|pair| pair == ["--revert", "e-1"]));

        for (edit, expected) in [
            (PresentationEditRequest::default(), "replacement or edit.revert"),
            (
                PresentationEditRequest {
                    slide_id: Some("p-01".to_string()),
                    replacement: Some("<script>x</script>".to_string()),
                    ..PresentationEditRequest::default()
                },
                "must not contain script",
            ),
            (
                PresentationEditRequest {
                    slide_id: Some("p 01".to_string()),
                    replacement: Some("<text id=\"title\">y</text>".to_string()),
                    ..PresentationEditRequest::default()
                },
                "edit.slideId must use",
            ),
            (
                PresentationEditRequest {
                    slide_id: Some("p-01".to_string()),
                    replacement: Some("<text/>".to_string()),
                    revert: Some("e-1".to_string()),
                    ..PresentationEditRequest::default()
                },
                "mutually exclusive",
            ),
        ] {
            let error = prepare_invocation(request(edit)).expect_err("invalid patch");
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn presentation_units_follow_presentation_order_and_expose_stable_ids() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_review_pptx(&temp.path().join("deck.pptx"));
        let response = presentation_units_sync(
            temp.path().to_string_lossy().into_owned(),
            "deck.pptx".to_string(),
        )
        .expect("units");
        assert_eq!(response.slide_count, 2);
        // slide2.xml comes first in sldIdLst and has no name → positional id.
        assert_eq!(response.units[0].index, 1);
        assert_eq!(response.units[0].id, "slide-1");
        assert_eq!(response.units[0].title, "");
        assert_eq!(response.units[1].index, 2);
        assert_eq!(response.units[1].id, "p-01");
        assert_eq!(response.units[1].name, "p-01");
        assert_eq!(response.units[1].title, "封面 & 标题");

        let parts = pptx_slide_parts(&temp.path().join("deck.pptx")).expect("parts");
        let before: Vec<String> = parts.iter().map(|part| part.fingerprint.clone()).collect();
        // Rewriting one slide changes only that slide's fingerprint.
        {
            use std::io::Write as _;
            let mut writer =
                zip::ZipWriter::new(std::fs::File::create(temp.path().join("deck2.pptx")).unwrap());
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            let source = std::fs::File::open(temp.path().join("deck.pptx")).unwrap();
            let mut archive = zip::ZipArchive::new(source).unwrap();
            let names: Vec<String> = archive.file_names().map(str::to_string).collect();
            for name in names {
                let mut entry = archive.by_name(&name).unwrap();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                writer.start_file(&name, options).unwrap();
                if name == "ppt/slides/slide1.xml" {
                    writer
                        .write_all(bytes.as_slice())
                        .and_then(|_| writer.write_all(b"<!-- edited -->"))
                        .unwrap();
                } else {
                    writer.write_all(&bytes).unwrap();
                }
            }
            writer.finish().unwrap();
        }
        let after: Vec<String> = pptx_slide_parts(&temp.path().join("deck2.pptx"))
            .expect("parts")
            .iter()
            .map(|part| part.fingerprint.clone())
            .collect();
        assert_eq!(before[0], after[0], "untouched slide keeps its fingerprint");
        assert_ne!(before[1], after[1], "edited slide gets a new fingerprint");
    }

    #[test]
    fn presentation_preview_rejects_non_pptx_and_missing_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("notes.txt"), "x").expect("write");
        let error = presentation_preview_page_sync(
            temp.path().to_string_lossy().into_owned(),
            "notes.txt".to_string(),
            None,
            None,
        )
        .expect_err("txt must be rejected");
        assert!(error.contains(".pptx"), "{error}");
        let error = presentation_preview_page_sync(
            temp.path().to_string_lossy().into_owned(),
            "missing.pptx".to_string(),
            Some(2),
            None,
        )
        .expect_err("missing file must be rejected");
        assert!(error.contains("does not exist"), "{error}");
    }

    /// Manual probe: `ARCFORGE_PPTX_PREVIEW_PROBE=<workspace>/<deck.pptx> cargo test -- --ignored
    /// probe_presentation_preview_from_env` renders page 1 through OfficeCLI and writes it next
    /// to the deck as `<deck>.preview-page1.png`.
    #[test]
    #[ignore]
    fn probe_presentation_preview_from_env() {
        let Some(raw) = std::env::var_os("ARCFORGE_PPTX_PREVIEW_PROBE") else {
            return;
        };
        let file = std::fs::canonicalize(PathBuf::from(raw)).expect("deck path");
        let workspace = file.parent().expect("workspace").to_path_buf();
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        let first = presentation_preview_page_sync(
            workspace.to_string_lossy().into_owned(),
            name.clone(),
            Some(1),
            None,
        )
        .expect("render page 1");
        assert_eq!(first.mime_type, "image/png");
        assert!(first.slide_count >= 1);
        let bytes = BASE64_STANDARD.decode(&first.data).expect("base64");
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        std::fs::write(file.with_extension("preview-page1.png"), &bytes).expect("write png");
        let second = presentation_preview_page_sync(
            workspace.to_string_lossy().into_owned(),
            name,
            Some(1),
            None,
        )
        .expect("render again");
        assert!(second.cached, "second render must come from the cache");
        println!("slides={} bytes={} cached_first={}", first.slide_count, bytes.len(), first.cached);
    }

    #[test]
    #[ignore]
    fn probe_presentation_template_workflow_from_env() {
        let Some(raw) = std::env::var_os("ARCFORGE_PPTX_PREVIEW_PROBE") else { return };
        let temp = tempfile::tempdir().expect("workspace");
        std::fs::copy(PathBuf::from(raw), temp.path().join("template.pptx")).expect("copy template");
        std::fs::write(temp.path().join("deck.json"), serde_json::json!({
            "schema_version": 3,
            "slides": [{"slide_id": "cover", "source_slide": 1}]
        }).to_string()).expect("manifest");
        for action in ["validate", "create", "render"] {
            let mut request = presentation_request(temp.path(), action);
            request.timeout_ms = Some(120_000);
            if action == "render" {
                request.input_path = Some("deck.pptx".to_string());
                request.output_path = Some("preview.png".to_string());
            } else {
                request.spec_path = Some("deck.json".to_string());
                request.input_path = Some("template.pptx".to_string());
                if action == "create" { request.output_path = Some("deck.pptx".to_string()); }
            }
            let result = run_office_runtime(prepare_invocation(request).expect("prepare"), Arc::new(AtomicBool::new(false))).expect("run");
            assert!(result.success, "{action}: {} {}", result.stdout, result.stderr);
            if action == "render" {
                let report: serde_json::Value = serde_json::from_str(&result.stdout).expect("render JSON");
                let reported_path = PathBuf::from(report["png"].as_str().expect("output path"));
                assert_eq!(
                    reported_path.canonicalize().expect("published preview exists"),
                    temp.path().join("preview.png").canonicalize().expect("expected preview exists")
                );
            }
        }
        assert!(std::fs::read(temp.path().join("preview.png")).expect("PNG").starts_with(b"\x89PNG\r\n\x1a\n"));
        println!("template validate/create/render passed with the bundled runtime");
    }

    #[test]
    fn presentation_validate_runs_the_runtime_against_the_manifest() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_svg_deck(temp.path(), SAFE_SVG);
        let mut request = presentation_request(temp.path(), "validate");
        request.spec_path = Some("deck.json".to_string());
        let invocation = prepare_invocation(request).expect("prepare validate");
        let arguments = argument_strings(&invocation);
        assert_eq!(invocation.backend, RuntimeBackend::ArcForge);
        assert_eq!(arguments[1], "validate");
        assert!(arguments.iter().any(|value| value == "--spec"));
        assert!(!arguments.iter().any(|value| value == "--template"));
    }

    #[test]
    fn presentation_render_selects_pdf_or_complete_png_runtime() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_test_pptx(&temp.path().join("deck.pptx"), 3);

        let mut pdf = presentation_request(temp.path(), "render");
        pdf.input_path = Some("deck.pptx".to_string());
        pdf.output_path = Some("preview.pdf".to_string());
        let pdf_invocation = prepare_invocation(pdf).expect("prepare pdf render");
        assert_eq!(pdf_invocation.backend, RuntimeBackend::ArcForge);
        assert!(argument_strings(&pdf_invocation)
            .iter()
            .any(|value| value.ends_with("preview.pdf")));

        let mut png = presentation_request(temp.path(), "render");
        png.input_path = Some("deck.pptx".to_string());
        png.output_path = Some("previews/deck.png".to_string());
        let png_invocation = prepare_invocation(png).expect("prepare png render");
        let arguments = argument_strings(&png_invocation);
        assert_eq!(png_invocation.backend, RuntimeBackend::ArcForge);
        assert_eq!(arguments[0], "presentation");
        assert_eq!(arguments[1], "render-png");
        assert_eq!(arguments[2], "--input");
        assert_eq!(arguments[4], "--pages");
        assert_eq!(arguments[5], "1-3");
        assert_eq!(arguments[6], "--grid");
        assert_eq!(arguments[7], "--output");
        assert!(arguments[8].ends_with("deck.png"));
        assert!(!arguments.iter().any(|value| value == "--officecli"), "trusted renderer is injected at execution, not accepted from the spec");
        assert!(matches!(
            png_invocation.officecli_output,
            Some(OfficeCliOutput::New { target, .. }) if target.ends_with("previews/deck.png")
        ));

        std::fs::write(temp.path().join("render.json"), r#"{"pages":"2"}"#).expect("render spec");
        let mut single = presentation_request(temp.path(), "render");
        single.input_path = Some("deck.pptx".to_string());
        single.spec_path = Some("render.json".to_string());
        single.output_path = Some("previews/p2.png".to_string());
        let single_arguments = argument_strings(&prepare_invocation(single).expect("single page"));
        assert_eq!(single_arguments[5], "2");
        assert!(!single_arguments.iter().any(|value| value == "--grid"));

        std::fs::write(temp.path().join("bad.json"), r#"{"pages":"2;rm"}"#).expect("bad spec");
        let mut bad = presentation_request(temp.path(), "render");
        bad.input_path = Some("deck.pptx".to_string());
        bad.spec_path = Some("bad.json".to_string());
        bad.output_path = Some("previews/bad.png".to_string());
        let error = prepare_invocation(bad).expect_err("bad page range must be rejected");
        assert!(
            error.contains("pages must look like"),
            "unexpected error: {error}"
        );

        let mut other = presentation_request(temp.path(), "render");
        other.input_path = Some("deck.pptx".to_string());
        other.output_path = Some("preview.html".to_string());
        let error = prepare_invocation(other).expect_err("html must be rejected");
        assert!(error.contains(".pdf") && error.contains(".png"));
    }
}
