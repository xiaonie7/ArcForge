---
name: arcforge-spreadsheets
description: Create, inspect, validate, and safely update Excel XLSX workbooks and CSV or TSV deliverables with deterministic local tooling. Use when the user asks for spreadsheets, Excel reports, formulas, workbook formatting, tables, or charts.
---

# ArcForge Spreadsheets

Produce reviewable spreadsheet deliverables with ArcForge's bundled Office Runtime. Use structured JSON by default and the constrained `SpreadsheetCode` tool only for transformations the JSON format cannot express. Do not invoke system Python.

## Workflow

1. Derive the requested workbook structure, formulas, formatting, charts, and output path from the request. Do not ask again when enough detail is already present.
2. For an existing workbook, inspect it first with the `OfficeRuntime` tool using `document=spreadsheet`, `action=inspect`, and `input_path=<workspace-workbook-path>`.
3. Prefer a structured operation. Read `references/spec.md`, write a workspace JSON specification, and call `OfficeRuntime` with one of:

   - Create: `document=spreadsheet`, `action=create`, `spec_path=<workspace-json-path>`, `output_path=<workspace-output.xlsx>`.
   - Modify: `document=spreadsheet`, `action=patch`, `input_path=<workspace-input.xlsx>`, `spec_path=<workspace-json-path>`, `output_path=<workspace-output.xlsx>`.

4. Use `SpreadsheetCode` only when the requested algorithm, layout, or openpyxl feature cannot be represented cleanly by the JSON schema. Read `references/code-api.md`, write a reviewable workspace `.py` file that uses the injected `workbook` name, then call `SpreadsheetCode` with its path, an optional input workbook, and the output workbook. Never introduce `wb` in newly generated scripts; it exists only as a runtime compatibility alias for older scripts.
5. Inspect the generated workbook with `OfficeRuntime` using `action=inspect`, then inspect it with ArcForge's Read tool.
6. Report the output path, sheet names, dimensions, formula count, chart count, script hash when applicable, and any validation limitation.

Keep source data, specifications, scripts, and deliverables in the workspace unless the user explicitly approves another destination.

## Safety

- Never set "force=true" unless the user explicitly authorized overwriting that exact output path.
- Prefer a new output filename when patching an existing workbook.
- Keep generated spreadsheet code focused on workbook mutations. Do not attempt imports, filesystem access, process execution, network access, dynamic evaluation, or workbook loading/saving; the constrained runtime rejects them.
- The Office Runtime already includes Python and openpyxl. If it is unavailable, report an ArcForge installation-integrity problem; do not install packages or fall back to system Python.
- Treat inspection as structural verification. Formula results are calculated by Excel or another spreadsheet application, not by "openpyxl".
- Preserve macro-enabled files only through a separately reviewed workflow; this helper intentionally writes ".xlsx" files only.
