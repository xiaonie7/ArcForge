---
name: arcforge-documents
description: Create, inspect, validate, safely update, and render Word DOCX documents with ArcForge's bundled Office Runtime.
---

# ArcForge Documents

Produce reviewable Word deliverables with the structured `OfficeRuntime` tool. The tool is backed by ArcForge's local Office provider; do not invoke `officecli` directly, run an arbitrary shell command, or use the OfficeCLI MCP endpoint.

## Workflow

1. Derive the document structure, audience, language, typography, tables, and output path from the request. Keep source specifications, previews, and deliverables in the workspace. External image and media assets are intentionally out of scope for this first provider release.
2. For an existing document, inspect it first with `OfficeRuntime` using `document=word`, `action=inspect`, and `input_path=<workspace-document.docx>`.
3. Read `references/spec.md`, write a reviewable workspace JSON specification, and call `OfficeRuntime` with one of:

   - Create a blank base: `document=word`, `action=create`, `output_path=<workspace-base.docx>`, then populate it with the patch call below using a different final output path.
   - Modify: `document=word`, `action=patch`, `input_path=<workspace-input.docx>`, `spec_path=<workspace-json-path>`, `output_path=<workspace-output.docx>`.

4. Validate every generated or patched document with `OfficeRuntime` using `document=word`, `action=validate`, and `input_path=<workspace-output.docx>`.
5. When layout matters, render a review artifact with `document=word`, `action=render`, `input_path=<workspace-output.docx>`, and an `.html` or `.png` `output_path`. Use the image reader for PNG output when available; HTML is a portable visual artifact.
6. Report the DOCX path, validation result, page or block summary when available, and the preview path or rendering limitation. Do not claim visual verification when rendering was not requested or failed.

## Quality bar

- Use semantic Word structure: headings, paragraphs, lists, tables, headers, footers, and page breaks instead of positioning text with spaces.
- Keep heading levels ordered, table columns consistent, and long text wrapped. Use explicit font and locale properties when the request requires Chinese, Arabic, RTL, or mixed-script output.
- Use text and structured native Word elements only. External image, media, OLE, and template references are not supported by this first provider release.
- Prefer a new output filename when patching an existing document. Never overwrite an exact destination unless the user explicitly approved it and `force=true` is therefore justified.
- Treat structural inspection and validation as mandatory; treat rendering as the visual check for overflow, clipping, broken images, and page breaks.

## Safety

- Never set `force=true` unless the user explicitly authorized overwriting that exact output path.
- Use only the batch operations documented in `references/spec.md`. Do not put executable commands, `raw`, `raw-set`, plugin requests, external URLs, or paths outside the workspace in a specification.
- Do not use system Word, system Python, temporary internet downloads, or a user-installed OfficeCLI binary. If the bundled Office Runtime is unavailable, report an ArcForge installation-integrity problem.
- A failed, timed-out, or cancelled operation must not be treated as a deliverable. Inspect the final output only after the tool reports success.
