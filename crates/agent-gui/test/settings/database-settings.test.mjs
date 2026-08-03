import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

const sectionSource = source("src/pages/settings/DatabaseSection.tsx");
const settingsPageSource = source("src/pages/SettingsPage.tsx");
const settingsTypesSource = source("src/pages/settings/types.ts");
const toolSource = source("src/lib/tools/databaseTools.ts");
const settingsModelSource = source("src/lib/settings/index.ts");
const i18nSource = source("src/i18n/config.ts");

test("database profiles use dedicated Tauri commands and do not enter AppSettings", () => {
  assert.match(sectionSource, /invoke<DatabaseProfile\[\]>\("database_profiles_list"\)/);
  assert.match(sectionSource, /invoke<DatabaseProfile>\("database_profile_save"/);
  assert.match(sectionSource, /"database_profile_test"/);
  assert.match(sectionSource, /"database_profile_delete"/);
  assert.doesNotMatch(settingsModelSource, /databaseProfiles|databaseConnections/);
});

test("database password editing is write-only and supports retain, replace, and clear", () => {
  assert.match(sectionSource, /type="password"/);
  assert.match(sectionSource, /autoComplete="new-password"/);
  assert.match(sectionSource, /const \{ password, clearPassword, \.\.\.profile \} = draft/);
  assert.match(
    sectionSource,
    /clearPassword\s*\?\s*null\s*:\s*password\s*\?\s*password\s*:\s*undefined/,
  );
  assert.match(sectionSource, /passwordConfigured: boolean/);
  assert.doesNotMatch(sectionSource, /profile\.password\b/);
});

test("database profile modal opts into the visible settings modal state", () => {
  assert.match(sectionSource, /className="settings-modal-overlay [^"]*"/);
  assert.match(sectionSource, /data-state="open"/);
});

test("database settings are navigable and explain transient user or Skill connections", () => {
  assert.match(settingsTypesSource, /\| "database"/);
  assert.match(settingsPageSource, /id: "database"/);
  assert.match(settingsPageSource, /<DatabaseSection \/>/);
  assert.match(i18nSource, /用户消息或 Skill 明确提供的临时连接只用于当次只读调用/);
  assert.match(i18nSource, /temporary connection explicitly supplied in a user message or Skill/);
});

test("database tools accept one-call connection details without echoing them in safe summaries", () => {
  assert.match(toolSource, /const DATABASE_CONNECTION = Type\.Object/);
  assert.match(toolSource, /password: Type\.Optional/);
  assert.match(toolSource, /writeOnly: true/);
  assert.match(toolSource, /connection: Type\.Optional\(DATABASE_CONNECTION\)/);
  assert.match(toolSource, /Temporary user or Skill connections are read-only/);
  assert.doesNotMatch(
    toolSource,
    /map\(\(\{ id, name, driver, databaseName, allowWrites, (host|username|password)/,
  );
});
