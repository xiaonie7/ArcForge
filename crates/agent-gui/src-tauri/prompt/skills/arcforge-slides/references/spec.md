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
| `assets` | Asset id → workspace image path (PNG, JPEG, GIF, BMP, WebP). SVG pages reference pictures only through these ids. |
| `slides[]` | Ordered pages. `slide_id` is a stable id (letters, digits, `_`, `-`, `.`), `svg` is the page file, `notes` is optional speaker text. |

Paths are resolved relative to the manifest file and must stay inside the workspace. Rust rejects any SVG that contains `href`, `xlink`, `<use>`, `<style>`, `<script>`, `<foreignObject>`, data URIs, or remote URLs before the runtime parses it.

## SVG page subset

Every page is one SVG with `viewBox="0 0 1280 720"` (13.333 × 7.5 in; 1 px = 9525 EMU; 1 px of font size = 0.75 pt). When the template is not 16:9 the canvas is still 1280 × 720 and is scaled onto the slide.

Allowed elements: `svg`, `g` (only `transform="translate(x y)"`), `defs` containing `linearGradient` and `stop`, `rect` (with `rx`), `circle`, `ellipse`, `line`, `polygon`, `path` (commands M, L, H, V, Z only), `text` with `tspan` (each `tspan` is one line positioned by `x`, `y`, or `dy`), `image`, `title`, `desc`.

Allowed attributes: `id`, geometry (`x`, `y`, `width`, `height`, `cx`, `cy`, `r`, `rx`, `ry`, `x1`…`y2`, `d`, `points`, `dx`, `dy`), `fill`, `fill-opacity`, `stroke`, `stroke-width`, `font-size`, `font-weight`, `font-family`, `text-anchor`, `transform`, `preserveAspectRatio`, gradient `offset`, `stop-color`, `stop-opacity`, and the ArcForge data attributes below. Inline `style="..."` is rejected.

| Marker | Effect |
| --- | --- |
| `<rect data-arcforge="background" .../>` | Slide background. A solid fill becomes the slide background; a gradient fill becomes a full-bleed rectangle. |
| `<rect data-arcforge="chart" data-chart='{...}'/>` | Native chart in that box. `data-chart`: `{"type":"column|bar|line|area|pie|doughnut","categories":[...],"series":[{"name":"...","values":[...]}],"colors":["#1F3A93"]}`. |
| `<image data-asset="asset-hero" x y width height preserveAspectRatio="xMidYMid meet|slice"/>` | Picture from the manifest assets. `meet` fits inside the box (use for screenshots and diagrams); `slice` fills and crops the box. |
| `data-width="680"` on `<text>` | Text box width in px with automatic wrapping. Lines that need more than the width are reported as `text_overflows`. |

Conversion rules: rectangles become (rounded) rectangles, circles and ellipses become ovals, lines become connectors, polygons and paths become freeform shapes, and each `<text>` becomes one text box whose paragraphs are the `tspan` lines. Fonts are written for Latin, East Asian, and complex scripts so Chinese text keeps the requested family. Theme shadows are disabled. Gradients keep their stops and angle.

Every `create` or `validate` result reports `text_overflows`, `out_of_bounds` (elements leaving the canvas; intentional bleed decorations show up here), `protected_collisions` (elements overlapping template logos, footers, or bars), `missing_fonts`, and `element_counts`. Subset violations, unknown assets, and non-grayscale colors in `stage: plan` are hard errors that name the page and element.

## Layout and typography ladder

- Canvas 1280 × 720; side margins 60, top and bottom margins 48; card gap at least 20.
- Titles 28–36 px, card headings 18–22 px, body 14–18 px, captions 11–12 px (px × 0.75 = pt). Split the page before shrinking below these sizes.
- Cover, section, and closing pages use free composition; content pages use Bento cards (single focus, 50/50, 2/3 + 1/3, three columns, main plus two details, hero plus small cards, mixed grid).
- In `stage: plan`, use `#FFFFFF`, `#F2F2F2`, `#D9D9D9`, `#8C8C8C`, `#404040` only.

## Render options

`action=render` with a `.png` output produces a contact sheet of all pages. Pass a JSON file as `spec_path` to select pages: `{"pages": "2"}`, `{"pages": "1-3"}`, or `{"pages": [1, 3], "grid": true}`. A `.pdf` output uses LibreOffice when it is installed.

## Legacy layout specification (schema_version 1)

Still accepted by `create`: a JSON object with `metadata`, `theme`, `footer`, and a `slides` array whose items have `type` `title`, `section`, `bullets`, `two-column`, `metrics`, `table`, `chart`, `image`, `quote`, or `closing`. Colors are six-digit hex values; image paths resolve from the specification directory. Prefer the SVG manifest for all new decks.
