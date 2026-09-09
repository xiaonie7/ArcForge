---
name: arcforge-slides
description: Plan, design, create, validate, and preview PowerPoint PPTX decks with ArcForge's bundled Office Runtime. Pages are described as constrained SVG and converted into native, editable PPTX objects; a user-provided PPTX can serve as the brand template. Use when the user asks for slides, a presentation, a pitch deck, a report deck, speaker material, or PowerPoint output.
---

# ArcForge Slides

Produce reviewable, editable PowerPoint deliverables with the structured `OfficeRuntime` tool. Do not invoke system Python, `officecli`, or arbitrary shell commands for deck work. Every page is an SVG page description (see `references/spec.md`) that ArcForge converts into native shapes, text boxes, pictures, and charts.

## Workflow

Work through five stages. Each stage writes one reviewable file into the workspace `deck/` folder so the user can step in at any point.

1. **Brief.** Read attached materials with `Read`. Use enterprise data skills or MCP tools when the request depends on internal facts. When audience, purpose, page count or duration, visual style, or must-include content is still unknown, ask once with `AskUserQuestion` (at most four questions). Skip the questions when the request already answers them. Write `deck/brief.md`.
2. **Outline.** Apply the pyramid principle (`references/prompts.md`, section A) and write `deck/outline.json`: cover, table of contents, parts with pages, closing page. Give every page a stable `page_id`, one message, its key points, `evidence` sources, and a `visual_intent`. Show the page list to the user as a short sticky-note summary and continue unless they ask for changes.
3. **Evidence.** Fill every key point with facts from the brief materials. Record the source path, query, or URL in `evidence`. Never place a number on a slide that has no source.
4. **Planning draft.** For each page write a grayscale SVG into `deck/plan/<page_id>.svg` (section B of the prompts; `stage: plan` forbids color and gradients). Write `deck/plan.json` with `schema_version: 3` and `stage: "plan"`, then run `OfficeRuntime` `document=presentation`, `action=validate`, `spec_path=deck/plan.json`. Fix every reported error, create `deck/plan.pptx`, render `deck/plan-preview.png`, and look at it with `Read`. Adjust content and layout here; this is the cheap place to change structure.
5. **Design.** Copy each plan page to `deck/design/<page_id>.svg` and apply the style pack (section C): colors, rounded cards, accents, icons, and decorations. Card positions must stay where the plan put them. Write `deck/deck.json` with `stage: "design"`, validate, then create the final PPTX, render the preview, and review it visually. Redraw only the pages with problems, at most two rounds, then report.

## Tool calls

- Validate a manifest: `document=presentation`, `action=validate`, `spec_path=deck/deck.json`, optional `input_path=<template.pptx>`.
- Create: `document=presentation`, `action=create`, `spec_path=deck/deck.json`, `output_path=deck/<name>.pptx`, optional `input_path=<template.pptx>`.
- Inspect any PPTX (including a user template): `action=inspect`, `input_path=<file.pptx>`. The result lists slide sizes, layouts, protected regions in 1280×720 canvas pixels, and theme colors and fonts.
- Preview: `action=render`, `input_path=deck/<name>.pptx`, `output_path=deck/preview.png` renders a contact sheet of every page. Put `{"pages": "2"}` or `{"pages": "1-3", "grid": false}` into a small JSON file and pass it as `spec_path` to render specific pages. A `.pdf` output uses LibreOffice when it is installed.
- Legacy `slides[]` JSON specifications are still accepted by `create`, but new work must use the SVG manifest.

## Two modes

- **No template.** Use `mode: "blank"` and design freely on the 16:9 canvas with one of the built-in style packs or a palette the user describes.
- **Template provided.** When the user attaches a `.pptx`, first `inspect` it. Use `mode: "template"` with `template` pointing at the workspace copy (or pass it as `input_path`). Masters, layouts, logos, and footers carry over; the template's sample slides are removed. Take the palette and fonts from the inspect result, keep every element out of the reported `protected_regions`, and treat the template's own slides (visible through `Read`) as the visual reference. If the user only wants the company colors, extract the palette and stay in blank mode.

## Assets

User pictures must live inside the workspace. If an attachment path is outside the workspace, copy it into `deck/assets/` first, declare it in the manifest `assets` map, and reference it only through `data-asset` on an `<image>`. Screenshots, dimension drawings, diagrams, and anything with text must use `preserveAspectRatio="xMidYMid meet"` so nothing is cropped. Never embed base64 data or file paths inside an SVG.

## Quality bar

- One message per page. Titles under roughly 60 characters. Split dense pages instead of shrinking text below the size ladder in `references/spec.md`.
- Use the Bento card principles: card count follows content, size expresses hierarchy, gaps of at least 20 px, generous whitespace.
- Data charts and tables must be native (`data-arcforge="chart"`), never drawn from rectangles.
- Give every important element an `id` so later single-page edits can address it.
- Treat `validate` and `inspect` as structural checks; only a rendered preview counts as visual verification. Report `text_overflows`, `out_of_bounds`, and `protected_collisions` from the create result honestly.

## Safety

- Never set `force=true` unless the user explicitly authorized overwriting that exact output path.
- Keep manifests, SVG pages, assets, previews, and the deck inside the workspace unless the user explicitly approves another destination.
- The Office Runtime bundles Python, python-pptx, Pillow, and OfficeCLI. If it is unavailable, report an ArcForge installation-integrity problem; do not install packages or fall back to system tools.
- Do not fetch remote images or fonts. If a font is reported missing, say so and keep the fallback.
- A failed, timed-out, or cancelled operation is not a deliverable. Inspect the output only after the tool reports success.
