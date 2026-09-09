use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

fn validate_svg_deck_manifest(
    value: &serde_json::Value,
    spec_dir: &Path,
    workspace: &Path,
) -> Result<(), String> {
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
                    "specPath assets.{asset_id} must be a workspace image path"
                ));
            };
            let extension = Path::new(raw)
                .extension()
                .and_then(OsStr::to_str)
                .unwrap_or_default();
            if !is_image_asset_extension(extension) {
                return Err(format!(
                    "specPath assets.{asset_id} must point to a PNG, JPEG, GIF, BMP, or WebP image"
                ));
            }
            resolve_existing_path(
                workspace,
                spec_dir,
                raw,
                extension,
                &format!("specPath assets.{asset_id}"),
            )?;
        }
    }
    let Some(slides) = value.get("slides").and_then(serde_json::Value::as_array) else {
        return Err(
            "specPath slides must be a non-empty array of {slide_id, svg} entries".to_string(),
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
        let Some(svg) = slide.get("svg").and_then(serde_json::Value::as_str) else {
            return Err(format!("specPath slides[{index}].svg is required"));
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
    Ok(())
}

fn validate_presentation_assets(spec_path: &Path, workspace: &Path) -> Result<(), String> {
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
        return validate_svg_deck_manifest(&value, spec_dir, workspace);
    }
    let Some(slides) = value.get("slides").and_then(serde_json::Value::as_array) else {
        return Ok(());
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
    Ok(())
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
            validate_presentation_assets(&spec, &workspace)?;
            let output = resolve_output_path(
                &workspace,
                required_path(&input.output_path, "outputPath")?,
                "pptx",
                "outputPath",
            )?;
            push_path_argument(&mut arguments, "--spec", spec.clone());
            push_path_argument(&mut arguments, "--output", output);
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
            validate_presentation_assets(&spec, &workspace)?;
            push_path_argument(&mut arguments, "--spec", spec);
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
                    backend = RuntimeBackend::OfficeCli;
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
                        OsString::from("view"),
                        presentation.into_os_string(),
                        OsString::from("screenshot"),
                        OsString::from("--render"),
                        OsString::from("html"),
                        OsString::from("--page"),
                        OsString::from(pages),
                    ];
                    if grid {
                        arguments.push(OsString::from("--grid"));
                    }
                    arguments.push(OsString::from("-o"));
                    arguments.push(output.into_os_string());
                    push_officecli_json(&mut arguments);
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
                "Presentation action must be create, inspect, validate, or render".to_string(),
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
            input_path: input.input_path.clone(),
            spec_path: input.spec_path.clone(),
            script_path: input.script_path.clone(),
            output_path: input.output_path.clone(),
            parent_revision: None,
            source_revision: None,
            source_snapshot_path: None,
        },
    })
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

fn run_office_runtime(
    invocation: PreparedInvocation,
    cancelled: Arc<AtomicBool>,
) -> Result<OfficeRuntimeResponse, String> {
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

    let status_result = wait_for_child(&mut child, invocation.timeout, &cancelled);
    let captured_stdout = match stdout_reader.join() {
        Ok(output) => output,
        Err(_) => {
            if let Some((temp, ..)) = &staged_output {
                let _ = std::fs::remove_file(temp);
            }
            return Err("Office Runtime stdout reader failed".to_string());
        }
    };
    let captured_stderr = match stderr_reader.join() {
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
    if let Some((temp, target, expected)) = &staged_output {
        if succeeded {
            if let Err(error) =
                commit_officecli_output(temp, target, expected, &invocation.request_id)
            {
                let _ = std::fs::remove_file(temp);
                return Err(error);
            }
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn presentation_render_selects_pdf_runtime_or_png_screenshot() {
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
        assert_eq!(png_invocation.backend, RuntimeBackend::OfficeCli);
        assert_eq!(arguments[0], "view");
        assert_eq!(arguments[2], "screenshot");
        assert_eq!(arguments[3], "--render");
        assert_eq!(arguments[4], "html");
        assert_eq!(arguments[5], "--page");
        assert_eq!(arguments[6], "1-3");
        assert_eq!(arguments[7], "--grid");
        assert_eq!(arguments[8], "-o");
        assert!(arguments[9].ends_with("deck.png"));
        assert_eq!(arguments[10], "--json");
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
        assert_eq!(single_arguments[6], "2");
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
