---
name: arcforge-slides
description: Plan, design, create, validate, and preview PowerPoint PPTX decks with ArcForge's bundled Office Runtime. Pages are described as constrained SVG and converted into native, editable PPTX objects; a user-provided PPTX can serve as the brand template. Use when the user asks for slides, a presentation, a pitch deck, a report deck, speaker material, or PowerPoint output.
---

# ArcForge Slides

Produce reviewable, editable PowerPoint deliverables with the structured `OfficeRuntime` tool. Do not invoke system Python, `officecli`, or arbitrary shell commands for deck work. Reuse original template pages with targeted text and table edits, or describe new pages as SVG (see `references/spec.md`) that ArcForge converts into native shapes, text boxes, pictures, and charts.

## Workflow

Work through five stages. Each stage writes one reviewable file into the workspace `deck/` folder so the user can step in at any point. With a supplied template, follow the template reuse workflow below for planning and design instead of rebuilding its pages as SVG.

1. **Brief.** Read attached materials with `Read`. Use enterprise data skills or MCP tools when the request depends on internal facts. When audience, purpose, page count or duration, visual style, or must-include content is still unknown, ask once with `AskUserQuestion` (at most four questions). Skip the questions when the request already answers them. Write `deck/brief.md`.
2. **Outline.** Apply the pyramid principle (`references/prompts.md`, section A) and write `deck/outline.json`: cover, table of contents, parts with pages, closing page. Give every page a stable `page_id`, one message, its key points, `evidence` sources, and a `visual_intent`. Show the page list to the user as a short sticky-note summary and continue unless they ask for changes.
3. **Evidence.** Fill every key point with facts from the brief materials. Record the source path, query, or URL in `evidence`. Never place a number on a slide that has no source.
4. **Planning draft.** For each page write a grayscale SVG into `deck/plan/<page_id>.svg` (section B of the prompts; `stage: plan` forbids color and gradients). Write `deck/plan.json` with `schema_version: 3` and `stage: "plan"`, then run `OfficeRuntime` `document=presentation`, `action=validate`, `spec_path=deck/plan.json`. Fix every reported error, create `deck/plan.pptx`, render `deck/plan-preview.png`, and look at it with `Read`. Adjust content and layout here; this is the cheap place to change structure.
5. **Design.** Copy each plan page to `deck/design/<page_id>.svg` and apply the style pack (section C): colors, rounded cards, accents, icons, and decorations. Card positions must stay where the plan put them. Icons and illustrations are SVG assets (section E of the prompts), not page-level drawings. Write `deck/deck.json` with `stage: "design"`, validate, then create the final PPTX, render the preview, and review it visually. Redraw only the pages with problems, at most two rounds, then report.

## Tool calls

- Validate a manifest: `document=presentation`, `action=validate`, `spec_path=deck/deck.json`, optional `input_path=<template.pptx>`.
- Create: `document=presentation`, `action=create`, `spec_path=deck/deck.json`, `output_path=deck/<name>.pptx`, optional `input_path=<template.pptx>`.
- Inspect any PPTX (including a user template): `action=inspect`, `input_path=<file.pptx>`. The result lists slide sizes, layouts, protected regions in 1280×720 canvas pixels, theme colors and fonts, per-page editable elements with `shape_id` / `shape_path`, and `relationship_errors`.
- Preview: `action=render`, `input_path=deck/<name>.pptx`, `output_path=deck/preview.png` renders a contact sheet of every page, up to 50 pages per call. Split larger decks into explicit page batches. Put `{"pages": "2"}` or `{"pages": "1-3", "grid": false}` into a small JSON file and pass it as `spec_path` to render specific pages. A `.pdf` output uses LibreOffice when it is installed.
- Legacy `slides[]` JSON specifications are still accepted by `create`, but new work must use the SVG manifest.

## Two modes

- **No template.** Use `mode: "blank"` and design freely on the 16:9 canvas with one of the built-in style packs or a palette the user describes.
- **Template provided.** When the user attaches a `.pptx`, first copy it into the workspace, `inspect` it, and render the relevant original pages. Use `mode: "template"` with `template` pointing at that copy (or pass it as `input_path`). Prefer `source_slide` to preserve the chosen original page's composition, pictures, groups, native tables, layout and theme. If the user only wants the company colors, extract the palette and stay in blank mode.

## Template reuse workflow

1. Inspect the template, including `relationship_errors`. Choose an original page for each outline page by its content structure: cover, section, text, table, or closing. Record the 1-based page number as `source_slide`; repeated use is supported.
2. Use the returned element ids, text, table cells and `shape_path` to map content. Write `text_edits: [{"shape_id": 14, "text": "Quarterly report"}]` and `table_edits: [{"shape_id": 34, "rows": [["Item", "Value"], ["Revenue", "100"]]}]` into each manifest page. Include `shape_path` when an id is ambiguous in nested groups. Keep tables at their original dimensions; split content across additional pages when it does not fit.
3. For these pages, `svg` is optional. Preserve the original layout by omitting `layout`. An explicit `layout` selects its name or the zero-based index returned by inspect. Add an SVG overlay only for genuinely new content, keeping it clear of existing text and brand elements. Never put a full-page background over the reused design.
4. Validate, create, and render a planning draft from the same template mappings. Review text fit before finalizing. Keep template typography and geometry; shorten text or use a more suitable template page instead of shrinking all fonts.
5. Create the final deck and check the cover, each reused layout and every changed page visually. A resource error is a failed build, not an acceptable blank icon. Do not implement your own slide cloning or rewrite PPTX relationship ids in a shell script. The runtime copies resource relationships and checks them.

The output includes only the manifest's ordered pages. Template source pages are references, not extra pages appended to the deck. A new SVG page in template mode may still select its own `layout`.

## Assets

User pictures must live inside the workspace. If an attachment path is outside the workspace, copy it into `deck/assets/` first, declare it in the manifest `assets` map, and reference it only through `data-asset` on an `<image>`. Screenshots, dimension drawings, diagrams, and anything with text must use `preserveAspectRatio="xMidYMid meet"` so nothing is cropped. Never embed base64 data or file paths inside an SVG.

Icons, illustrations, and logos are **SVG assets** (see `references/spec.md`, *SVG assets*). Draw them yourself as standalone `.svg` files in `deck/assets/`, or use the user's SVG files, and place them with `<image data-asset="…">`. Inside an asset the full static SVG feature set is available (curves, arcs, transforms, `<use>`, `<style>`, text, gradients); scripts and external references are rejected. ArcForge converts each asset into native, recolorable shapes and falls back to a transparent PNG only when that is impossible. Rules:

- Draw monochrome icons on a 24×24 `viewBox` with `currentColor`, and set `data-fill` on the placement so the style pack decides the color. Keep one icon family per deck: the same stroke width, corner style, and optical size; write those values into the style pack and reuse the same asset ids across pages.
- After `validate`, look at `deck/.arcforge-assets/<asset id>/raster.png` with `Read` for every asset you drew. Redraw anything that is not immediately recognizable. Check `asset_renders` in the result to see which assets became shapes and which fell back to pictures.
- Never build an icon or illustration from many tiny rectangles on the page; make it an asset.

## Quality bar

- One message per page. Titles under roughly 60 characters. Split dense pages instead of shrinking text below the size ladder in `references/spec.md`.
- Use the Bento card principles: card count follows content, size expresses hierarchy, gaps of at least 20 px, generous whitespace.
- Data charts and tables must be native (`data-arcforge="chart"`), never drawn from rectangles.
- Give every important element an `id` so later single-page edits can address it.
- Treat `validate` and `inspect` as structural checks; only a rendered preview counts as visual verification. Report `relationship_errors`, `text_overflows`, `out_of_bounds`, and `protected_collisions` from the create result honestly. Compare the original template preview with the output: if both omit the same brand artwork, investigate the preview renderer before changing the deck.

## Looking at previews

- Read the preview PNG. When the Read result contains the picture, review it yourself with the checklist in section D of the prompts.
- When the Read result says the image was omitted because the model does not support images, call `VisualReview` with the same paths and the section D checklist, naming the page ids the images show. Do the same for asset rasters you want checked.
- Keep `deck/review.json` up to date: one entry per page with `page_id`, `rendered` (true/false), `visual_check` (`self`, `VisualReview:<model>`, or `none`), `round`, and `issues` (element ids and what is wrong). A page whose `visual_check` is `none` must be reported as not visually verified in the final summary; never describe it as checked.

## Selection-scoped edits

When a user message carries an "Artifact review selection" block, the user is looking at that unit in the review panel and the request is about it:

- For a deck built from a manifest, the unit id is the page's `slide_id`. Edit only that page's SVG or, for a reused template page, its `text_edits` / `table_edits`. Keep every other page unchanged, then run `create` for the whole manifest. The result's `changed_slide_ids` must contain only the pages you meant to change; if other ids appear, explain why.
- Do not rebuild pages the user did not mention, do not renumber ids, and do not reorder slides unless asked.
- If the deck was not produced by ArcForge (no manifest in the workspace), say that page-level edits require rebuilding it from a manifest and offer to do that.
- When the selection names an element (title, subtitle, text_block, image, chart, table, footer), edit only the SVG node with that id and its children, or the selected template shape using the inspected `shape_id` / `shape_path`. Keep the id and every other element's position, then re-run `create`. If the request cannot be satisfied inside that element, say so instead of touching neighbours.
- Give every semantic element a `data-role` (title, subtitle, text_block, image, chart, table, footer) and a unique `id`; the review overlay uses them, and `validate` rejects duplicate ids.
- Reply with the page id and what changed in one or two sentences; the panel refreshes the changed pages automatically.

## Safety

- Never set `force=true` unless the user explicitly authorized overwriting that exact output path.
- Keep manifests, SVG pages, assets, previews, and the deck inside the workspace unless the user explicitly approves another destination.
- The Office Runtime bundles Python, python-pptx, Pillow, and OfficeCLI. If it is unavailable, report an ArcForge installation-integrity problem; do not install packages or fall back to system tools.
- Do not fetch remote images or fonts. If a font is reported missing, say so and keep the fallback.
- A failed, timed-out, or cancelled operation is not a deliverable. Inspect the output only after the tool reports success.
