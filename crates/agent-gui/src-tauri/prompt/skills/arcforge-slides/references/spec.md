# Presentation Specification

`OfficeRuntime` with `document=presentation` accepts a UTF-8 JSON manifest. New decks use the **SVG deck manifest** (`schema_version: 3`). The older `slides[]` layout specification is still accepted for `create` and is summarized at the end.

## Deck manifest (schema_version 3)

```json
{
  "schema_version": 3,
  "mode": "template",
  "stage": "design",
  "template": "assets/company-template.pptx",
  "metadata": { "title": "Product introduction", "author": "ArcForge" },
  "style": {
    "palette": { "primary": "#1F3A93", "accent": "#2EC4B6", "background": "#F4F6FA", "surface": "#FFFFFF", "text": "#1B1F29", "muted": "#6B7280" },
    "fonts": { "heading": ["Microsoft YaHei", "SimHei"], "body": ["Microsoft YaHei", "SimHei"] },
    "layout": "Blank"
  },
  "assets": { "asset-hero": "assets/hero.png" },
  "slides": [
    { "slide_id": "p-01", "svg": "design/p-01.svg" },
    { "slide_id": "p-02", "svg": "design/p-02.svg", "notes": "Speaker notes" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `mode` | `blank` (default) starts from an empty 16:9 deck; `template` starts from the `.pptx` in `template` (or the tool's `input_path`), keeps its masters, layouts, and theme, and removes its sample slides. |
| `stage` | `plan` accepts only grayscale colors and no gradients (wireframe); `design` accepts the full subset. |
| `template` | Workspace `.pptx` path relative to the manifest. Required when `mode` is `template`. |
| `style.fonts` | Font families used for text measurement and chart fonts; fallbacks are appended automatically. |
| `style.layout` | Optional layout name inside the template. Otherwise the `Blank` layout or the layout with the fewest placeholders is used. |
| `assets` | Asset id → workspace path relative to the manifest. Raster pictures: PNG, JPEG, GIF, BMP, WebP. Vector drawings: SVG (icons, logos, illustrations you draw or the user supplies). SVG pages reference assets only through these ids. |
| `slides[]` | Ordered pages. `slide_id` is a stable id (letters, digits, `_`, `-`, `.`), `svg` is the page file, `notes` is optional speaker text. |

Paths are resolved relative to the manifest file and must stay inside the workspace. Rust rejects any SVG **page** that contains `href`, `xlink`, `<use>`, `<style>`, `<script>`, `<foreignObject>`, data URIs, or remote URLs before the runtime parses it.

## SVG assets

An SVG asset is a normal drawing, not a page: ArcForge normalizes it with a full SVG engine before the runtime sees it, so curves, arcs, relative path commands, nested transforms, `<use>`, `<style>`, text (outlined with system fonts), and linear gradients are all fine. Forbidden inside an asset: `<script>`, `<foreignObject>`, DOCTYPE or entity declarations, `@import`, and any `href` that is not `#id` or `data:image/…`. Assets are limited to 2 MiB.

`create` and `validate` write the normalized result into `.arcforge-assets/<asset id>/` next to the manifest:

| File | Purpose |
| --- | --- |
| `shapes.json` | Flattened absolute-coordinate paths with fills and strokes, or the reasons why native shapes are impossible. |
| `raster.png` | Transparent rasterization, 1536 px on the long side. Read it to check what you drew, and it is the picture used for fallbacks. |

Placement rules for `<image data-asset="…">` when the asset is an SVG:

- The drawing becomes a group of native freeform shapes (one per path, curves preserved) scaled to fit the box (`meet`, centered). Every shape stays editable and recolorable in PowerPoint.
- `data-fill="#RRGGBB"` is the asset color: it recolors every fill and, unless `data-stroke` is also given, every stroke. Use it for monochrome icons drawn with `currentColor`; without it such icons are black. `data-stroke` recolors strokes only.
- `data-render="raster"` forces the PNG; `data-render="shapes"` makes a fallback a hard error; `preserveAspectRatio="… slice"` always uses the PNG (shapes cannot be cropped).
- Automatic fallback to the PNG happens when the SVG uses filters, masks, clip paths, patterns, radial gradients, gradient strokes, blend modes, embedded raster images, or more than 800 paths. The reason is listed in `asset_renders` and `warnings`.
- In `stage: plan` vector assets are drawn in `#8C8C8C` and PNG fallbacks are converted to grayscale automatically, so a plan page may reference colored assets.

## SVG page subset

Every page is one SVG with `viewBox="0 0 1280 720"` (13.333 × 7.5 in; 1 px = 9525 EMU; 1 px of font size = 0.75 pt). When the template is not 16:9 the canvas is still 1280 × 720 and is scaled onto the slide.

Allowed elements: `svg`, `g` (only `transform="translate(x y)"`), `defs` containing `linearGradient` and `stop`, `rect` (with `rx`), `circle`, `ellipse`, `line`, `polygon`, `path` (commands M, L, H, V, Z only), `text` with `tspan` (each `tspan` is one line positioned by `x`, `y`, or `dy`), `image`, `title`, `desc`.

Allowed attributes: `id`, geometry (`x`, `y`, `width`, `height`, `cx`, `cy`, `r`, `rx`, `ry`, `x1`…`y2`, `d`, `points`, `dx`, `dy`), `fill`, `fill-opacity`, `stroke`, `stroke-width`, `font-size`, `font-weight`, `font-family`, `text-anchor`, `transform`, `preserveAspectRatio`, gradient `offset`, `stop-color`, `stop-opacity`, and the ArcForge data attributes below. Inline `style="..."` is rejected.

| Marker | Effect |
| --- | --- |
| `<rect data-arcforge="background" .../>` | Slide background. A solid fill becomes the slide background; a gradient fill becomes a full-bleed rectangle. |
| `<rect data-arcforge="chart" data-chart='{...}'/>` | Native chart in that box. `data-chart`: `{"type":"column|bar|line|area|pie|doughnut","categories":[...],"series":[{"name":"...","values":[...]}],"colors":["#1F3A93"]}`. |
| `<image data-asset="asset-hero" x y width height preserveAspectRatio="xMidYMid meet|slice"/>` | Picture from the manifest assets. `meet` fits inside the box (use for screenshots and diagrams); `slice` fills and crops the box. |
| `<image data-asset="icon-check" data-fill="#2EC4B6" x y width height/>` | SVG asset placed as native shapes (see *SVG assets*); optional `data-stroke` and `data-render="raster|shapes"`. |
| `data-width="680"` on `<text>` | Text box width in px with automatic wrapping. Lines that need more than the width are reported as `text_overflows`. |

Conversion rules: rectangles become (rounded) rectangles, circles and ellipses become ovals, lines become connectors, polygons and paths become freeform shapes, each `<text>` becomes one text box whose paragraphs are the `tspan` lines, and SVG assets become groups of freeform shapes. Fonts are written for Latin, East Asian, and complex scripts so Chinese text keeps the requested family. Theme shadows are disabled. Gradients keep their stops and angle.

Every `create` or `validate` result reports `text_overflows`, `out_of_bounds` (elements leaving the canvas; intentional bleed decorations show up here), `protected_collisions` (elements overlapping template logos, footers, or bars), `missing_fonts`, `element_counts`, and `asset_renders` (per placed SVG asset: `shapes` with the shape count, or `raster` with the reasons). Subset violations, unknown assets, and non-grayscale colors in `stage: plan` are hard errors that name the page and element.

## Semantic blocks for review

Add `data-role="title|subtitle|text_block|image|chart|table|footer"` and a stable `id` to each block the user should be able to select. All explicit ids must be unique within the SVG page, including ids on groups and text spans; ids cannot contain whitespace. Reuse the same ids when rebuilding or editing a page. Unknown/empty roles and roles without ids are validation errors.

A `<g id="metrics-table" data-role="table">…</g>` becomes one PPTX group and one selectable block. Its child shapes are not separate selections. Unmarked `<g>` nodes remain layout containers. Use a semantic group for a composed chart, table, or card whose children should be modified together; decorative backgrounds do not have roles. Raster and vector asset placements keep the placement id and role on the resulting picture or group. The role is persisted in the PPTX shape's `cNvPr descr` as `arcforge:role=<role>`; the SVG id is its shape name.

The review API returns boxes in a normalized 1280×720 coordinate space. It exposes only semantic blocks, never arbitrary unmarked paths or connectors. Selecting a block provides context to the agent; it does not enable dragging, resizing, or editing text in the preview.

## Layout and typography ladder

- Canvas 1280 × 720; side margins 60, top and bottom margins 48; card gap at least 20.
- Titles 28–36 px, card headings 18–22 px, body 14–18 px, captions 11–12 px (px × 0.75 = pt). Split the page before shrinking below these sizes.
- Cover, section, and closing pages use free composition; content pages use Bento cards (single focus, 50/50, 2/3 + 1/3, three columns, main plus two details, hero plus small cards, mixed grid).
- In `stage: plan`, use `#FFFFFF`, `#F2F2F2`, `#D9D9D9`, `#8C8C8C`, `#404040` only.

## Render options

`action=render` with a `.png` output produces a contact sheet of all pages. Pass a JSON file as `spec_path` to select pages: `{"pages": "2"}`, `{"pages": "1-3"}`, or `{"pages": [1, 3], "grid": true}`. A `.pdf` output uses LibreOffice when it is installed.

## Legacy layout specification (schema_version 1)

Still accepted by `create`: a JSON object with `metadata`, `theme`, `footer`, and a `slides` array whose items have `type` `title`, `section`, `bullets`, `two-column`, `metrics`, `table`, `chart`, `image`, `quote`, or `closing`. Colors are six-digit hex values; image paths resolve from the specification directory. Prefer the SVG manifest for all new decks.
