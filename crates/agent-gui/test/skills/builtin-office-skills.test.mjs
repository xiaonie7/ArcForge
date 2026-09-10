import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const spreadsheetSkill = readFileSync(
  new URL("../../src-tauri/prompt/skills/arcforge-spreadsheets/SKILL.md", import.meta.url),
  "utf8",
);
const spreadsheetScript = readFileSync(
  new URL(
    "../../src-tauri/prompt/skills/arcforge-spreadsheets/scripts/spreadsheet.py",
    import.meta.url,
  ),
  "utf8",
);
const slidesSkill = readFileSync(
  new URL("../../src-tauri/prompt/skills/arcforge-slides/SKILL.md", import.meta.url),
  "utf8",
);
const presentationScript = readFileSync(
  new URL(
    "../../src-tauri/prompt/skills/arcforge-slides/scripts/presentation.py",
    import.meta.url,
  ),
  "utf8",
);
const documentsSkill = readFileSync(
  new URL("../../src-tauri/prompt/skills/arcforge-documents/SKILL.md", import.meta.url),
  "utf8",
);
const documentsSpec = readFileSync(
  new URL(
    "../../src-tauri/prompt/skills/arcforge-documents/references/spec.md",
    import.meta.url,
  ),
  "utf8",
);
const builtinRegistrySource = readFileSync(
  new URL("../../src-tauri/src/services/skills/builtin.rs", import.meta.url),
  "utf8",
);

test("built-in spreadsheet skill is registered with deterministic helpers", () => {
  assert.match(spreadsheetSkill, /^---\r?\nname: arcforge-spreadsheets\r?\n/m);
  assert.match(spreadsheetSkill, /`OfficeRuntime` tool/);
  assert.match(spreadsheetSkill, /action=patch/);
  assert.match(spreadsheetSkill, /action=inspect/);
  assert.match(spreadsheetSkill, /`SpreadsheetCode`/);
  assert.match(spreadsheetSkill, /references\/code-api\.md/);
  assert.match(spreadsheetSkill, /Never set "force=true"/);
  assert.doesNotMatch(spreadsheetSkill, /python spreadsheet\.py/);
  assert.match(spreadsheetScript, /from openpyxl import Workbook, load_workbook/);
  assert.match(spreadsheetScript, /def atomic_save/);
  assert.match(spreadsheetScript, /class SpreadsheetCodeValidator/);
  assert.match(spreadsheetScript, /def execute_spreadsheet_code/);
  assert.match(spreadsheetScript, /FORBIDDEN_CODE_NODES/);
  assert.match(spreadsheetScript, /formula_results_calculated/);
  assert.match(builtinRegistrySource, /name: "arcforge-spreadsheets"/);
  assert.match(
    builtinRegistrySource,
    /prompt\/skills\/arcforge-spreadsheets\/scripts\/spreadsheet\.py/,
  );
  assert.match(builtinRegistrySource, /references\/code-api\.md/);
});

test("built-in slides skill is registered with structural and visual verification paths", () => {
  assert.match(slidesSkill, /^---\r?\nname: arcforge-slides\r?\n/m);
  assert.match(slidesSkill, /`OfficeRuntime` tool/);
  assert.match(slidesSkill, /action=create/);
  assert.match(slidesSkill, /action=inspect/);
  assert.match(slidesSkill, /action=validate/);
  assert.match(slidesSkill, /action=render/);
  assert.match(slidesSkill, /schema_version: 3/);
  assert.match(slidesSkill, /mode: "template"/);
  assert.match(slidesSkill, /data-asset/);
  assert.match(slidesSkill, /SVG assets/);
  assert.match(slidesSkill, /data-fill/);
  assert.match(slidesSkill, /\.arcforge-assets\/<asset id>\/raster\.png/);
  assert.match(slidesSkill, /references\/prompts\.md/);
  assert.doesNotMatch(slidesSkill, /python presentation\.py/);
  assert.match(slidesSkill, /only a rendered preview counts as visual verification/);
  assert.match(presentationScript, /from pptx import Presentation/);
  assert.match(presentationScript, /def inspect_presentation/);
  assert.match(presentationScript, /def render_pdf/);
  assert.match(presentationScript, /class SvgSlideConverter/);
  assert.match(presentationScript, /def create_svg_deck/);
  assert.match(presentationScript, /def run_validate/);
  assert.match(presentationScript, /def place_vector_shapes/);
  assert.match(presentationScript, /"--asset-cache"/);
  assert.match(presentationScript, /DECK_SCHEMA_VERSION = 3/);
  assert.match(builtinRegistrySource, /name: "arcforge-slides"/);
  assert.match(
    builtinRegistrySource,
    /prompt\/skills\/arcforge-slides\/scripts\/presentation\.py/,
  );
  assert.match(builtinRegistrySource, /arcforge-slides\/references\/prompts\.md/);
  assert.match(builtinRegistrySource, /arcforge-slides\/references\/example-cover\.svg/);
});

test("built-in document skill uses the controlled Word OfficeRuntime workflow", () => {
  assert.match(documentsSkill, /^---\r?\nname: arcforge-documents\r?\n/m);
  assert.match(documentsSkill, /document=word/);
  assert.match(documentsSkill, /action=create/);
  assert.match(documentsSkill, /action=patch/);
  assert.match(documentsSkill, /action=inspect/);
  assert.match(documentsSkill, /action=validate/);
  assert.match(documentsSkill, /action=render/);
  assert.match(documentsSkill, /\.html/);
  assert.match(documentsSkill, /\.png/);
  assert.match(documentsSkill, /arbitrary shell command/);
  assert.doesNotMatch(documentsSkill, /officecli\s+(create|batch|set|raw)/i);
  assert.match(documentsSpec, /"command": "add"/);
  assert.match(documentsSpec, /top-level value must be an array/);
  assert.match(documentsSpec, /Do not embed arbitrary XML/);
  assert.match(builtinRegistrySource, /name: "arcforge-documents"/);
  assert.match(
    builtinRegistrySource,
    /prompt\/skills\/arcforge-documents\/references\/spec\.md/,
  );
  assert.match(builtinRegistrySource, /DOCUMENTS_OWNERSHIP_MARKER_CONTENT/);
});

test("ArcForge Office skills use ownership markers to preserve user collisions", () => {
  assert.match(builtinRegistrySource, /_arcforge_builtin\.json/);
  assert.match(builtinRegistrySource, /SPREADSHEETS_OWNERSHIP_MARKER_CONTENT/);
  assert.match(builtinRegistrySource, /SLIDES_OWNERSHIP_MARKER_CONTENT/);
  assert.match(builtinRegistrySource, /DOCUMENTS_OWNERSHIP_MARKER_CONTENT/);
  assert.match(builtinRegistrySource, /\\"owner\\":\\"ArcForge\\"/);
});
