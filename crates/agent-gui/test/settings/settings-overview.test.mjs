import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const model = loader.loadModule("src/pages/settings/overviewModel.ts");
const { t } = loader.loadModule("src/i18n/config.ts");

test("settings search resolves bilingual field aliases and excludes hidden sections", () => {
  const categories = model.visibleSettingsCategories(["mcp", "database"]);
  assert.equal(model.searchSettings("MCP", categories, t).length, 0);
  assert.equal(model.searchSettings("SQL", categories, t).length, 0);
  const font = model.searchSettings("字体", categories, t);
  assert.equal(font[0].section, "system");
  assert.equal(font[0].anchor, "font");
  assert.equal(model.searchSettings("API KEY", categories, t)[0].section, "providers");
  assert.equal(model.searchSettings("网络 代理", categories, t)[0].anchor, "proxy");
  assert.equal(model.searchSettings("   ", categories, t).length, 0);
  assert.equal(model.searchSettings("no-such-setting", categories, t).length, 0);
});

test("MCP only reports connected after runtime initialization, never from enablement alone", () => {
  const ok = (value) => ({ status: "fulfilled", value });
  const result = model.summarizeMcpStatus([
    ok({ serverId: "ready", running: true, initialized: true }),
    ok({ serverId: "starting", running: true, initialized: false }),
    ok({ serverId: "stopped", running: false, initialized: true }),
    ok({ serverId: "failed", running: true, initialized: true, lastError: "disconnected" }),
    { status: "rejected", reason: new Error("IPC unavailable") },
  ]);
  assert.equal(result.connected, 1);
  assert.equal(result.unavailable, true);
  assert.equal(result.error, true);
});

test("inventory counts configured items, unique active models, and enabled integrations", () => {
  const settings = {
    customProviders: [{ activeModels: ["a", "a", "b"] }, { activeModels: ["a"] }],
    system: { selectedSystemTools: ["x", "x"] },
    mcp: { servers: [{ enabled: false }, { enabled: true }] },
    ssh: { hosts: [{}, {}] }, remote: { enabled: true }, wecom: { enabled: false },
  };
  const result = model.settingsInventory(settings);
  assert.equal(result.providers, 2);
  assert.equal(result.models, 3);
  assert.equal(result.mcp, 2);
  assert.equal(result.connections, 3);
  assert.equal(result.tools, model.settingsInventory({ ...settings, system: { selectedSystemTools: [] } }).tools + 1);
});
