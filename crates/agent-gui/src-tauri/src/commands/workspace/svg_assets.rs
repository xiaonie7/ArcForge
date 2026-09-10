//! Vector asset preparation for SVG deck manifests.
//!
//! The Office runtime (Python) never parses a raw `.svg` asset. ArcForge normalizes every SVG
//! asset with `usvg` first: CSS, `<use>`, nested transforms, arcs, relative path commands, and
//! text are all resolved into absolute-coordinate paths. The result is written next to the
//! manifest into `.arcforge-assets/<asset id>/`:
//!
//! * `shapes.json` — the flattened paths with fills and strokes when the drawing can become
//!   native PowerPoint shapes, otherwise the reasons why it cannot;
//! * `raster.png` — a transparent rasterization (via `resvg`) that serves as the picture
//!   fallback and as the preview the model can look at with `Read`.
//!
//! `usvg` performs no network access; file references are disabled through a custom
//! `ImageHrefResolver`, so an asset can only ever pull in data it embeds itself.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use sha2::{Digest, Sha256};

use resvg::tiny_skia;
use resvg::usvg;
use usvg::tiny_skia_path::PathSegment;

/// Hard cap for a single SVG asset file.
pub(crate) const MAX_SVG_ASSET_BYTES: u64 = 2 * 1024 * 1024;
/// Long side of the transparent PNG fallback/preview.
const RASTER_LONG_SIDE: f32 = 1536.0;
/// Pixel budget for the raster fallback (width × height).
const RASTER_MAX_PIXELS: f32 = 6_000_000.0;
/// Above this many paths a drawing is embedded as a picture instead of native shapes.
const MAX_NATIVE_PATHS: usize = 800;
/// Schema version of `shapes.json`; the Python runtime checks it. Bump whenever the emitted
/// geometry changes so stale cache entries are rebuilt.
const SHAPES_SCHEMA: u64 = 2;
/// Name of the cache directory created next to a manifest.
pub(crate) const ASSET_CACHE_DIR_NAME: &str = ".arcforge-assets";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedSvgAsset {
    /// `shapes` when every path maps to native geometry, otherwise `raster`.
    pub mode: &'static str,
    pub path_count: usize,
    pub reasons: Vec<String>,
    pub directory: PathBuf,
}

/// Reject markup that could execute or reach outside the file. `usvg` ignores scripts and never
/// touches the network, but the error message tells the model what to remove.
pub(crate) fn reject_unsafe_svg_asset_markup(svg: &str, label: &str) -> Result<(), String> {
    let lowered = svg.to_ascii_lowercase();
    for (needle, reason) in [
        ("<script", "script"),
        ("<foreignobject", "foreignObject"),
        ("<!doctype", "DOCTYPE declarations"),
        ("<!entity", "entity declarations"),
        ("@import", "CSS imports"),
        ("url(http", "remote URLs"),
        ("url('http", "remote URLs"),
        ("url(\"http", "remote URLs"),
        ("url(//", "remote URLs"),
    ] {
        if lowered.contains(needle) {
            return Err(format!("{label} must not contain {reason}"));
        }
    }
    static HREF: OnceLock<regex::Regex> = OnceLock::new();
    let href = HREF.get_or_init(|| {
        regex::Regex::new(r#"(?i)href\s*=\s*["']([^"']*)["']"#).expect("static href regex")
    });
    for capture in href.captures_iter(svg) {
        let value = capture.get(1).map(|m| m.as_str().trim()).unwrap_or_default();
        let lowered = value.to_ascii_lowercase();
        if value.is_empty() || lowered.starts_with('#') || lowered.starts_with("data:image/") {
            continue;
        }
        return Err(format!(
            "{label} may only reference its own elements (#id) or embedded data:image/ URIs, found href=\"{value}\""
        ));
    }
    Ok(())
}

fn shared_fontdb() -> Arc<usvg::fontdb::Database> {
    static FONTDB: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    FONTDB
        .get_or_init(|| {
            let mut database = usvg::fontdb::Database::new();
            database.load_system_fonts();
            database.set_serif_family("Times New Roman");
            database.set_sans_serif_family("Arial");
            database.set_monospace_family("Consolas");
            Arc::new(database)
        })
        .clone()
}

fn parse_options() -> usvg::Options<'static> {
    let mut options = usvg::Options::default();
    options.resources_dir = None;
    options.dpi = 96.0;
    options.font_family = "Arial".to_string();
    options.fontdb = shared_fontdb();
    options.image_href_resolver = usvg::ImageHrefResolver {
        resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
        // Never open files or URLs referenced from an asset.
        resolve_string: Box::new(|_, _| None),
    };
    options
}

fn round3(value: f32) -> f64 {
    (f64::from(value) * 1000.0).round() / 1000.0
}

fn color_hex(color: usvg::Color) -> String {
    format!("{:02X}{:02X}{:02X}", color.red, color.green, color.blue)
}

fn transform_scale(transform: usvg::Transform) -> f32 {
    let determinant = transform.sx * transform.sy - transform.kx * transform.ky;
    let scale = determinant.abs().sqrt();
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn linear_gradient_json(
    gradient: &usvg::LinearGradient,
    path_transform: usvg::Transform,
    paint_opacity: f32,
) -> serde_json::Value {
    // usvg bakes objectBoundingBox units into the gradient transform; the absolute vector is the
    // path transform applied on top of it.
    let transform = path_transform.pre_concat(gradient.transform());
    let mut start = usvg::tiny_skia_path::Point::from_xy(gradient.x1(), gradient.y1());
    let mut end = usvg::tiny_skia_path::Point::from_xy(gradient.x2(), gradient.y2());
    transform.map_point(&mut start);
    transform.map_point(&mut end);
    let angle = (end.y - start.y)
        .atan2(end.x - start.x)
        .to_degrees()
        .rem_euclid(360.0);
    let stops: Vec<serde_json::Value> = gradient
        .stops()
        .iter()
        .map(|stop| {
            serde_json::json!({
                "offset": round3(stop.offset().get()),
                "color": color_hex(stop.color()),
                "opacity": round3(stop.opacity().get() * paint_opacity),
            })
        })
        .collect();
    serde_json::json!({
        "type": "linear",
        "angle": round3(angle),
        "stops": stops,
    })
}

type P = (f32, f32);

/// One drawing command after quadratic curves have been lifted to cubics.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Seg {
    Line(P),
    Cubic(P, P, P),
}

/// A subpath: `start`, the segments that follow it, and whether the source closed it.
#[derive(Debug, Clone)]
struct Contour {
    start: P,
    segs: Vec<Seg>,
    closed: bool,
}

impl Contour {
    fn end(&self) -> P {
        match self.segs.last() {
            Some(Seg::Line(p)) | Some(Seg::Cubic(_, _, p)) => *p,
            None => self.start,
        }
    }

    /// Append the explicit closing line so the outline is geometrically closed even for
    /// renderers that ignore `a:close`.
    fn ensure_closing_line(&mut self) {
        let end = self.end();
        if !points_close(end, self.start) {
            self.segs.push(Seg::Line(self.start));
        }
        self.closed = true;
    }

    /// Reverse the winding direction. Only meaningful for closed contours.
    fn reversed(&self) -> Contour {
        let mut points = vec![self.start];
        for seg in &self.segs {
            match seg {
                Seg::Line(p) | Seg::Cubic(_, _, p) => points.push(*p),
            }
        }
        let mut segs = Vec::with_capacity(self.segs.len());
        for (index, seg) in self.segs.iter().enumerate().rev() {
            let previous = points[index];
            segs.push(match seg {
                Seg::Line(_) => Seg::Line(previous),
                Seg::Cubic(c1, c2, _) => Seg::Cubic(*c2, *c1, previous),
            });
        }
        Contour {
            start: *points.last().unwrap_or(&self.start),
            segs,
            closed: self.closed,
        }
    }

    fn polyline(&self) -> Vec<P> {
        let mut points = vec![self.start];
        let mut current = self.start;
        for seg in &self.segs {
            match seg {
                Seg::Line(p) => {
                    points.push(*p);
                    current = *p;
                }
                Seg::Cubic(c1, c2, p) => {
                    for step in 1..=8 {
                        let t = step as f32 / 8.0;
                        points.push(cubic_point(current, *c1, *c2, *p, t));
                    }
                    current = *p;
                }
            }
        }
        points
    }

    fn all_points(&self) -> Vec<P> {
        let mut points = vec![self.start];
        for seg in &self.segs {
            match seg {
                Seg::Line(p) => points.push(*p),
                Seg::Cubic(c1, c2, p) => points.extend([*c1, *c2, *p]),
            }
        }
        points
    }
}

fn points_close(a: P, b: P) -> bool {
    (a.0 - b.0).abs() < 1e-3 && (a.1 - b.1).abs() < 1e-3
}

fn cubic_point(p0: P, c1: P, c2: P, p3: P, t: f32) -> P {
    let mt = 1.0 - t;
    let a = mt * mt * mt;
    let b = 3.0 * mt * mt * t;
    let c = 3.0 * mt * t * t;
    let d = t * t * t;
    (
        a * p0.0 + b * c1.0 + c * c2.0 + d * p3.0,
        a * p0.1 + b * c1.1 + c * c2.1 + d * p3.1,
    )
}

fn signed_area(polyline: &[P]) -> f32 {
    let mut area = 0.0;
    for index in 0..polyline.len() {
        let a = polyline[index];
        let b = polyline[(index + 1) % polyline.len()];
        area += a.0 * b.1 - b.0 * a.1;
    }
    area / 2.0
}

fn polygon_contains(polyline: &[P], point: P) -> bool {
    let mut inside = false;
    let mut j = polyline.len() - 1;
    for i in 0..polyline.len() {
        let (xi, yi) = polyline[i];
        let (xj, yj) = polyline[j];
        if (yi > point.1) != (yj > point.1) {
            let x = (xj - xi) * (point.1 - yi) / (yj - yi) + xi;
            if point.0 < x {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

fn split_contours(segments: &[PathSegment]) -> Vec<Contour> {
    let mut contours: Vec<Contour> = Vec::new();
    let mut current: Option<Contour> = None;
    let mut cursor: P = (0.0, 0.0);
    let mut subpath_start: P = (0.0, 0.0);
    for segment in segments {
        match *segment {
            PathSegment::MoveTo(p) => {
                if let Some(contour) = current.take() {
                    contours.push(contour);
                }
                cursor = (p.x, p.y);
                subpath_start = cursor;
                current = Some(Contour {
                    start: cursor,
                    segs: Vec::new(),
                    closed: false,
                });
            }
            PathSegment::LineTo(p) => {
                let target = (p.x, p.y);
                let contour = current.get_or_insert_with(|| Contour {
                    start: cursor,
                    segs: Vec::new(),
                    closed: false,
                });
                contour.segs.push(Seg::Line(target));
                cursor = target;
            }
            PathSegment::QuadTo(c, p) => {
                let target = (p.x, p.y);
                let c1 = (
                    cursor.0 + 2.0 / 3.0 * (c.x - cursor.0),
                    cursor.1 + 2.0 / 3.0 * (c.y - cursor.1),
                );
                let c2 = (p.x + 2.0 / 3.0 * (c.x - p.x), p.y + 2.0 / 3.0 * (c.y - p.y));
                let contour = current.get_or_insert_with(|| Contour {
                    start: cursor,
                    segs: Vec::new(),
                    closed: false,
                });
                contour.segs.push(Seg::Cubic(c1, c2, target));
                cursor = target;
            }
            PathSegment::CubicTo(c1, c2, p) => {
                let target = (p.x, p.y);
                let contour = current.get_or_insert_with(|| Contour {
                    start: cursor,
                    segs: Vec::new(),
                    closed: false,
                });
                contour
                    .segs
                    .push(Seg::Cubic((c1.x, c1.y), (c2.x, c2.y), target));
                cursor = target;
            }
            PathSegment::Close => {
                if let Some(mut contour) = current.take() {
                    contour.closed = true;
                    contours.push(contour);
                }
                cursor = subpath_start;
            }
        }
    }
    if let Some(contour) = current.take() {
        contours.push(contour);
    }
    contours.retain(|contour| !contour.segs.is_empty());
    contours
}

/// Nesting depth of every contour: how many other contours enclose it.
fn contour_depths(polylines: &[Vec<P>]) -> Vec<usize> {
    polylines
        .iter()
        .enumerate()
        .map(|(index, polyline)| {
            let probe = if polyline.len() >= 2 {
                (
                    (polyline[0].0 + polyline[1].0) / 2.0,
                    (polyline[0].1 + polyline[1].1) / 2.0,
                )
            } else {
                polyline[0]
            };
            polylines
                .iter()
                .enumerate()
                .filter(|(other_index, other)| {
                    *other_index != index && other.len() >= 3 && polygon_contains(other, probe)
                })
                .count()
        })
        .collect()
}

fn segments_json(commands: &[(char, Vec<P>)]) -> Vec<serde_json::Value> {
    commands
        .iter()
        .map(|(command, points)| {
            let mut value = vec![serde_json::Value::String(command.to_string())];
            for point in points {
                value.push(serde_json::json!(round3(point.0)));
                value.push(serde_json::json!(round3(point.1)));
            }
            serde_json::Value::Array(value)
        })
        .collect()
}

fn push_contour_commands(commands: &mut Vec<(char, Vec<P>)>, contour: &Contour, with_move: bool) {
    if with_move {
        commands.push(('M', vec![contour.start]));
    } else {
        commands.push(('L', vec![contour.start]));
    }
    for seg in &contour.segs {
        match seg {
            Seg::Line(p) => commands.push(('L', vec![*p])),
            Seg::Cubic(c1, c2, p) => commands.push(('C', vec![*c1, *c2, *p])),
        }
    }
}

fn bounds_of(points: &[P]) -> (f32, f32, f32, f32) {
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN;
    let mut max_y = f32::MIN;
    for point in points {
        min_x = min_x.min(point.0);
        min_y = min_y.min(point.1);
        max_x = max_x.max(point.0);
        max_y = max_y.max(point.1);
    }
    (min_x, min_y, (max_x - min_x).max(0.0), (max_y - min_y).max(0.0))
}

fn bounds_json(bounds: (f32, f32, f32, f32), inflate: f32) -> serde_json::Value {
    serde_json::json!([
        round3(bounds.0 - inflate),
        round3(bounds.1 - inflate),
        round3(bounds.2 + 2.0 * inflate),
        round3(bounds.3 + 2.0 * inflate)
    ])
}

/// One entry of `shapes.json.paths`: a geometry sequence plus the paint it inherits.
struct EmittedGeometry {
    commands: Vec<(char, Vec<P>)>,
    points: Vec<P>,
    note: Option<&'static str>,
}

/// Turn the contours of one SVG path into DrawingML-friendly geometry.
///
/// * Fill-only paths become a single subpath: every contour is closed explicitly and joined
///   to the first one with out-and-back bridges. The bridges have no area, so the fill is the
///   same under any winding rule, and renderers that ignore `a:close`/`a:moveTo` inside a
///   path (the HTML previewer) still draw the correct silhouette.
/// * Stroked paths keep their contours separate: one shape per contour unless a fill with
///   nested contours forces a genuine multi-subpath path.
/// * `evenodd` fills have their contours re-wound by nesting depth so that a nonzero renderer
///   (PowerPoint, WPS) produces the same holes.
fn plan_geometry(
    contours: Vec<Contour>,
    has_fill: bool,
    has_stroke: bool,
    even_odd: bool,
) -> Vec<EmittedGeometry> {
    let mut contours = contours;
    if has_fill {
        for contour in &mut contours {
            contour.ensure_closing_line();
        }
    }
    let polylines: Vec<Vec<P>> = contours.iter().map(Contour::polyline).collect();
    let depths = contour_depths(&polylines);
    if has_fill && even_odd {
        for (index, contour) in contours.iter_mut().enumerate() {
            let area = signed_area(&polylines[index]);
            if area.abs() < 1e-6 {
                continue;
            }
            let wants_positive = depths[index] % 2 == 0;
            if (area > 0.0) != wants_positive {
                *contour = contour.reversed();
            }
        }
    }
    let nested = depths.iter().any(|depth| *depth > 0);

    if has_fill && !has_stroke && contours.len() > 1 {
        let mut order: Vec<usize> = (0..contours.len()).collect();
        order.sort_by_key(|index| (depths[*index], *index));
        let anchor = contours[order[0]].start;
        let mut commands = Vec::new();
        let mut points = Vec::new();
        for (position, index) in order.iter().enumerate() {
            let contour = &contours[*index];
            push_contour_commands(&mut commands, contour, position == 0);
            points.extend(contour.all_points());
            if position > 0 {
                commands.push(('L', vec![anchor]));
            }
        }
        commands.push(('Z', Vec::new()));
        return vec![EmittedGeometry {
            commands,
            points,
            note: None,
        }];
    }

    if has_stroke && contours.len() > 1 && has_fill && nested {
        let mut commands = Vec::new();
        let mut points = Vec::new();
        for contour in &contours {
            push_contour_commands(&mut commands, contour, true);
            points.extend(contour.all_points());
            if contour.closed {
                commands.push(('Z', Vec::new()));
            }
        }
        return vec![EmittedGeometry {
            commands,
            points,
            note: Some("multi-subpath stroke+fill; the HTML preview may draw bridge lines"),
        }];
    }

    contours
        .iter()
        .map(|contour| {
            let mut commands = Vec::new();
            push_contour_commands(&mut commands, contour, true);
            if contour.closed {
                commands.push(('Z', Vec::new()));
            }
            EmittedGeometry {
                commands,
                points: contour.all_points(),
                note: None,
            }
        })
        .collect()
}

struct Collector {
    paths: Vec<serde_json::Value>,
    reasons: Vec<String>,
    notes: Vec<String>,
}

impl Collector {
    fn note(&mut self, reason: &str) {
        if !self.reasons.iter().any(|existing| existing == reason) {
            self.reasons.push(reason.to_string());
        }
    }

    fn collect_group(&mut self, group: &usvg::Group, inherited_opacity: f32) {
        if !group.filters().is_empty() {
            self.note("filter");
        }
        if group.clip_path().is_some() {
            self.note("clip-path");
        }
        if group.mask().is_some() {
            self.note("mask");
        }
        if group.blend_mode() != usvg::BlendMode::Normal {
            self.note("blend-mode");
        }
        let opacity = inherited_opacity * group.opacity().get();
        for child in group.children() {
            match child {
                usvg::Node::Group(child_group) => self.collect_group(child_group, opacity),
                usvg::Node::Path(path) => self.collect_path(path, opacity),
                usvg::Node::Image(_) => self.note("embedded-image"),
                usvg::Node::Text(text) => self.collect_group(text.flattened(), opacity),
            }
        }
    }

    fn collect_path(&mut self, path: &usvg::Path, opacity: f32) {
        if !path.is_visible() {
            return;
        }
        let transform = path.abs_transform();
        let Some(data) = path.data().clone().transform(transform) else {
            return;
        };
        let contours = split_contours(&data.segments().collect::<Vec<_>>());
        if contours.is_empty() {
            return;
        }

        let mut even_odd = false;
        let fill = path.fill().and_then(|fill| {
            let fill_opacity = fill.opacity().get() * opacity;
            let rule = match fill.rule() {
                usvg::FillRule::NonZero => "nonzero",
                usvg::FillRule::EvenOdd => {
                    even_odd = true;
                    "evenodd"
                }
            };
            match fill.paint() {
                usvg::Paint::Color(color) => Some(serde_json::json!({
                    "type": "solid",
                    "color": color_hex(*color),
                    "opacity": round3(fill_opacity),
                    "rule": rule,
                })),
                usvg::Paint::LinearGradient(gradient) => {
                    let mut value = linear_gradient_json(gradient, transform, fill_opacity);
                    value["rule"] = serde_json::Value::String(rule.to_string());
                    Some(value)
                }
                usvg::Paint::RadialGradient(_) => {
                    self.note("radial-gradient");
                    None
                }
                usvg::Paint::Pattern(_) => {
                    self.note("pattern");
                    None
                }
            }
        });

        let scale = transform_scale(transform);
        let mut stroke_width = 0.0_f32;
        let stroke = path.stroke().and_then(|stroke| {
            let color = match stroke.paint() {
                usvg::Paint::Color(color) => color_hex(*color),
                usvg::Paint::LinearGradient(_) | usvg::Paint::RadialGradient(_) => {
                    self.note("gradient-stroke");
                    return None;
                }
                usvg::Paint::Pattern(_) => {
                    self.note("pattern");
                    return None;
                }
            };
            stroke_width = stroke.width().get() * scale;
            let dash = stroke.dasharray().map(|values| {
                values
                    .iter()
                    .map(|value| round3(*value * scale))
                    .collect::<Vec<_>>()
            });
            Some(serde_json::json!({
                "color": color,
                "opacity": round3(stroke.opacity().get() * opacity),
                "width": round3(stroke_width),
                "linecap": match stroke.linecap() {
                    usvg::LineCap::Butt => "butt",
                    usvg::LineCap::Round => "round",
                    usvg::LineCap::Square => "square",
                },
                "linejoin": match stroke.linejoin() {
                    usvg::LineJoin::Miter | usvg::LineJoin::MiterClip => "miter",
                    usvg::LineJoin::Round => "round",
                    usvg::LineJoin::Bevel => "bevel",
                },
                "dash": dash,
            }))
        });

        if fill.is_none() && stroke.is_none() {
            return;
        }
        let stroke_first = matches!(path.paint_order(), usvg::PaintOrder::StrokeAndFill);
        let geometries = plan_geometry(contours, fill.is_some(), stroke.is_some(), even_odd);
        for geometry in geometries {
            if let Some(note) = geometry.note {
                let message = format!("{}: {note}", path.id());
                if !self.notes.contains(&message) {
                    self.notes.push(message);
                }
            }
            let bounds = bounds_of(&geometry.points);
            self.paths.push(serde_json::json!({
                "id": path.id(),
                "segments": segments_json(&geometry.commands),
                "bbox": bounds_json(bounds, 0.0),
                "stroke_bbox": bounds_json(bounds, stroke_width / 2.0),
                "fill": fill,
                "stroke": stroke,
                "stroke_first": stroke_first,
            }));
        }
    }
}

fn rasterize(tree: &usvg::Tree) -> Result<(Vec<u8>, u32, u32), String> {
    let size = tree.size();
    let long_side = size.width().max(size.height());
    let mut scale = RASTER_LONG_SIDE / long_side;
    let pixel_budget = (size.width() * scale) * (size.height() * scale);
    if pixel_budget > RASTER_MAX_PIXELS {
        scale *= (RASTER_MAX_PIXELS / pixel_budget).sqrt();
    }
    let width = (size.width() * scale).ceil().max(1.0) as u32;
    let height = (size.height() * scale).ceil().max(1.0) as u32;
    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| "could not allocate the raster preview".to_string())?;
    resvg::render(
        tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let png = pixmap
        .encode_png()
        .map_err(|error| format!("could not encode the raster preview: {error}"))?;
    Ok((png, width, height))
}

fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = target.with_extension(format!(
        "{}.tmp",
        target
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("bin")
    ));
    std::fs::write(&temp, bytes)
        .map_err(|error| format!("could not write {}: {error}", temp.display()))?;
    if target.exists() {
        std::fs::remove_file(target)
            .map_err(|error| format!("could not replace {}: {error}", target.display()))?;
    }
    std::fs::rename(&temp, target)
        .map_err(|error| format!("could not finish {}: {error}", target.display()))
}

fn cached_summary(directory: &Path, sha256: &str) -> Option<PreparedSvgAsset> {
    let raw = std::fs::read_to_string(directory.join("shapes.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if value.get("schema").and_then(serde_json::Value::as_u64) != Some(SHAPES_SCHEMA) {
        return None;
    }
    if value.get("source_sha256").and_then(serde_json::Value::as_str) != Some(sha256) {
        return None;
    }
    if !directory.join("raster.png").is_file() {
        return None;
    }
    let mode = match value.get("mode").and_then(serde_json::Value::as_str) {
        Some("shapes") => "shapes",
        Some("raster") => "raster",
        _ => return None,
    };
    let path_count = value
        .get("paths")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    let reasons = value
        .get("reasons")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Some(PreparedSvgAsset {
        mode,
        path_count,
        reasons,
        directory: directory.to_path_buf(),
    })
}

/// Normalize one SVG asset into `<cache_root>/<asset_id>/` and report how it will be placed.
/// Unchanged sources reuse the existing cache entry.
pub(crate) fn prepare_svg_asset(
    asset_id: &str,
    source: &Path,
    cache_root: &Path,
    label: &str,
) -> Result<PreparedSvgAsset, String> {
    let metadata = std::fs::metadata(source)
        .map_err(|error| format!("{label} could not be read: {error}"))?;
    if metadata.len() > MAX_SVG_ASSET_BYTES {
        return Err(format!("{label} exceeds the 2 MiB SVG asset limit"));
    }
    let bytes =
        std::fs::read(source).map_err(|error| format!("{label} could not be read: {error}"))?;
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| format!("{label} must be UTF-8 text (SVGZ is not accepted)"))?;
    reject_unsafe_svg_asset_markup(&text, label)?;

    let sha256: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let directory = cache_root.join(asset_id);
    if let Some(cached) = cached_summary(&directory, &sha256) {
        return Ok(cached);
    }
    std::fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "{label}: could not create the asset cache {}: {error}",
            directory.display()
        )
    })?;

    let options = parse_options();
    let tree = usvg::Tree::from_data(&bytes, &options)
        .map_err(|error| format!("{label} is not a usable SVG: {error}"))?;
    let mut collector = Collector {
        paths: Vec::new(),
        reasons: Vec::new(),
        notes: Vec::new(),
    };
    collector.collect_group(tree.root(), 1.0);
    if collector.paths.len() > MAX_NATIVE_PATHS {
        collector.note(&format!(
            "too-many-paths ({} > {MAX_NATIVE_PATHS})",
            collector.paths.len()
        ));
    }
    if collector.paths.is_empty() && collector.reasons.is_empty() {
        return Err(format!("{label} draws nothing visible"));
    }

    let (png, raster_width, raster_height) = rasterize(&tree)?;
    write_atomic(&directory.join("raster.png"), &png)?;

    let mode = if collector.reasons.is_empty() {
        "shapes"
    } else {
        "raster"
    };
    let path_count = collector.paths.len();
    let size = tree.size();
    let document = serde_json::json!({
        "schema": SHAPES_SCHEMA,
        "asset_id": asset_id,
        "source_name": source.file_name().and_then(|value| value.to_str()).unwrap_or_default(),
        "source_sha256": sha256,
        "width": round3(size.width()),
        "height": round3(size.height()),
        "mode": mode,
        "reasons": collector.reasons,
        "notes": collector.notes,
        "raster": "raster.png",
        "raster_size": [raster_width, raster_height],
        "paths": if mode == "shapes" { collector.paths } else { Vec::new() },
    });
    let encoded = serde_json::to_vec(&document)
        .map_err(|error| format!("{label}: could not encode shapes.json: {error}"))?;
    write_atomic(&directory.join("shapes.json"), &encoded)?;

    Ok(PreparedSvgAsset {
        mode,
        path_count,
        reasons: document["reasons"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        directory,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ICON: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>"##;

    fn prepare(svg: &str) -> (tempfile::TempDir, PreparedSvgAsset, serde_json::Value) {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("icon.svg");
        std::fs::write(&source, svg).expect("write svg");
        let cache = temp.path().join(ASSET_CACHE_DIR_NAME);
        let prepared =
            prepare_svg_asset("icon", &source, &cache, "assets.icon").expect("prepare asset");
        let raw = std::fs::read_to_string(prepared.directory.join("shapes.json"))
            .expect("read shapes.json");
        let value = serde_json::from_str(&raw).expect("parse shapes.json");
        (temp, prepared, value)
    }

    #[test]
    fn stroke_icon_becomes_native_paths_with_curves() {
        let (_temp, prepared, value) = prepare(ICON);
        assert_eq!(prepared.mode, "shapes");
        assert_eq!(prepared.path_count, 2);
        assert_eq!(value["width"], 24.0);
        let paths = value["paths"].as_array().expect("paths");
        let circle = &paths[0];
        assert!(
            circle["segments"]
                .as_array()
                .unwrap()
                .iter()
                .any(|segment| segment[0] == "C"),
            "circle must be expressed with cubic curves"
        );
        assert!(circle["fill"].is_null());
        assert_eq!(circle["stroke"]["color"], "000000");
        assert_eq!(circle["stroke"]["width"], 2.0);
        assert_eq!(circle["stroke"]["linecap"], "round");
        let png = std::fs::read(prepared.directory.join("raster.png")).expect("raster");
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn unchanged_sources_reuse_the_cache_entry() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("icon.svg");
        std::fs::write(&source, ICON).expect("write svg");
        let cache = temp.path().join(ASSET_CACHE_DIR_NAME);
        let first = prepare_svg_asset("icon", &source, &cache, "assets.icon").expect("first");
        let stamp = std::fs::metadata(first.directory.join("raster.png"))
            .and_then(|meta| meta.modified())
            .expect("mtime");
        let second = prepare_svg_asset("icon", &source, &cache, "assets.icon").expect("second");
        assert_eq!(first, second);
        let stamp_after = std::fs::metadata(second.directory.join("raster.png"))
            .and_then(|meta| meta.modified())
            .expect("mtime");
        assert_eq!(stamp, stamp_after, "cache entry must not be rewritten");
    }

    #[test]
    fn filters_and_embedded_images_fall_back_to_raster() {
        let filtered = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><filter id="b"><feGaussianBlur stdDeviation="2"/></filter></defs><rect x="4" y="4" width="32" height="32" fill="#2563EB" filter="url(#b)"/></svg>"##;
        let (_temp, prepared, value) = prepare(filtered);
        assert_eq!(prepared.mode, "raster");
        assert!(prepared.reasons.iter().any(|reason| reason == "filter"));
        assert!(value["paths"].as_array().unwrap().is_empty());
        assert!(prepared.directory.join("raster.png").is_file());
    }

    #[test]
    fn use_style_and_gradients_are_resolved() {
        let logo = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 50"><style>.a{fill:#EA580C}</style><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1F3A93"/><stop offset="1" stop-color="#2EC4B6"/></linearGradient><path id="dot" d="M0 0h10v10H0z"/></defs><rect x="0" y="0" width="60" height="50" rx="8" fill="url(#g)"/><g transform="translate(70 20) scale(2)"><use xlink:href="#dot" class="a"/></g></svg>"##;
        let (_temp, prepared, value) = prepare(logo);
        assert_eq!(prepared.mode, "shapes", "reasons: {:?}", prepared.reasons);
        let paths = value["paths"].as_array().expect("paths");
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0]["fill"]["type"], "linear");
        assert_eq!(paths[0]["fill"]["stops"].as_array().unwrap().len(), 2);
        assert_eq!(paths[1]["fill"]["color"], "EA580C");
        // translate(70 20) scale(2) on a 10×10 square → 20×20 at (70, 20)
        assert_eq!(paths[1]["bbox"], serde_json::json!([70.0, 20.0, 20.0, 20.0]));
    }

    #[test]
    fn external_references_and_scripts_are_rejected() {
        let error = reject_unsafe_svg_asset_markup(
            r##"<svg xmlns="http://www.w3.org/2000/svg"><image href="http://example.com/a.png"/></svg>"##,
            "assets.logo",
        )
        .expect_err("remote href");
        assert!(error.contains("href"), "{error}");
        let error = reject_unsafe_svg_asset_markup(
            r##"<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="C:/secret.png"/></svg>"##,
            "assets.logo",
        )
        .expect_err("file href");
        assert!(error.contains("href"), "{error}");
        let error = reject_unsafe_svg_asset_markup(
            r##"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"##,
            "assets.logo",
        )
        .expect_err("script");
        assert!(error.contains("script"), "{error}");
        reject_unsafe_svg_asset_markup(
            r##"<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/><image href="data:image/png;base64,AAAA"/></svg>"##,
            "assets.logo",
        )
        .expect("internal and embedded references are fine");
    }

    #[test]
    fn quadratic_curves_are_lifted_to_cubics() {
        let quad = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 10 Q10 0 20 10 Z" fill="#000"/></svg>"##;
        let (_temp, _prepared, value) = prepare(quad);
        let segments = value["paths"][0]["segments"].as_array().expect("segments");
        let kinds: Vec<&str> = segments
            .iter()
            .map(|segment| segment[0].as_str().unwrap())
            .collect();
        // The closing edge is written out as an explicit line so renderers that ignore
        // `a:close` still see a closed outline.
        assert_eq!(kinds, vec!["M", "C", "L", "Z"]);
        let cubic = &segments[1];
        // Control points of the lifted cubic: P0 + 2/3 (Q - P0) and P2 + 2/3 (Q - P2).
        assert_eq!(cubic[1], 6.667);
        assert_eq!(cubic[2], 3.333);
        assert_eq!(cubic[3], 13.333);
        assert_eq!(cubic[4], 3.333);
        assert_eq!(cubic[5], 20.0);
        assert_eq!(cubic[6], 10.0);
    }

    #[test]
    fn filled_multi_contour_paths_are_bridged_into_one_subpath() {
        // Two nested squares drawn in the same direction with evenodd: a ring.
        let ring = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path fill-rule="evenodd" fill="#000" d="M0 0h40v40H0z M10 10h20v20H10z"/></svg>"##;
        let (_temp, prepared, value) = prepare(ring);
        assert_eq!(prepared.path_count, 1);
        let segments = value["paths"][0]["segments"].as_array().expect("segments");
        let moves = segments.iter().filter(|segment| segment[0] == "M").count();
        assert_eq!(moves, 1, "contours must be joined into one subpath: {segments:?}");
        assert_eq!(segments.last().unwrap()[0], "Z");
        // The hole is re-wound so a nonzero renderer punches it out: outer clockwise in
        // screen space (positive area), inner counter-clockwise (negative area).
        let mut polygons: Vec<Vec<(f64, f64)>> = Vec::new();
        for segment in segments {
            match segment[0].as_str().unwrap() {
                "M" => polygons.push(vec![(segment[1].as_f64().unwrap(), segment[2].as_f64().unwrap())]),
                "L" => polygons
                    .last_mut()
                    .unwrap()
                    .push((segment[1].as_f64().unwrap(), segment[2].as_f64().unwrap())),
                _ => {}
            }
        }
        let points = &polygons[0];
        // Bridged sequence: outer (5 pts incl. closing line), bridge to hole start, hole (5 pts),
        // bridge back to the anchor.
        assert!(points.len() >= 11, "{points:?}");
        let area = |ring: &[(f64, f64)]| {
            let mut sum = 0.0;
            for index in 0..ring.len() {
                let a = ring[index];
                let b = ring[(index + 1) % ring.len()];
                sum += a.0 * b.1 - b.0 * a.1;
            }
            sum / 2.0
        };
        let outer = &points[0..4];
        let hole = &points[5..9];
        assert!(area(outer) > 0.0, "outer must stay positive: {outer:?}");
        assert!(area(hole) < 0.0, "hole must be reversed: {hole:?}");
    }

    #[test]
    fn stroked_paths_keep_one_shape_per_contour() {
        let two_lines = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000"><path d="M2 2 L10 10 M14 14 L22 22"/></svg>"##;
        let (_temp, prepared, value) = prepare(two_lines);
        assert_eq!(prepared.path_count, 2);
        let paths = value["paths"].as_array().unwrap();
        assert_eq!(paths[0]["bbox"], serde_json::json!([2.0, 2.0, 8.0, 8.0]));
        assert_eq!(paths[1]["bbox"], serde_json::json!([14.0, 14.0, 8.0, 8.0]));
        assert!(paths[0]["fill"].is_null());
        assert_eq!(paths[0]["stroke"]["width"], 1.0);
    }

    #[test]
    fn empty_drawings_are_reported() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("empty.svg");
        std::fs::write(
            &source,
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>"##,
        )
        .expect("write svg");
        let error = prepare_svg_asset(
            "empty",
            &source,
            &temp.path().join(ASSET_CACHE_DIR_NAME),
            "assets.empty",
        )
        .expect_err("nothing to draw");
        assert!(error.contains("draws nothing"), "{error}");
    }
}
