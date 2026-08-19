import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const settings = createTsModuleLoader().loadModule("src/lib/settings/index.ts");
const { isSupportedGatewayUrl } = createTsModuleLoader().loadModule(
  "src/lib/settings/normalize.ts",
);
const wecomSectionSource = readFileSync(
  new URL("../../src/pages/settings/WecomSection.tsx", import.meta.url),
  "utf8",
);
const settingsStorageSource = readFileSync(
  new URL("../../src/lib/settings/storage.ts", import.meta.url),
  "utf8",
);
const settingsPageSource = readFileSync(
  new URL("../../src/pages/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const i18nSource = readFileSync(new URL("../../src/i18n/config.ts", import.meta.url), "utf8");

test("WeCom settings default to a private-message connector identity", () => {
  const normalized = settings.normalizeWecomSettings({});

  assert.deepEqual(normalized, {
    enabled: false,
    gatewayMode: "local",
    localGatewayPort: 18780,
    botId: "",
    secretConfigured: false,
    channelTokenConfigured: false,
    tenantId: "",
    connectorId: "wecom-desktop",
    allowGroupMessages: false,
  });
});

test("WeCom settings normalize identity fields and never retain write-only secrets", () => {
  const normalized = settings.normalizeWecomSettings({
    enabled: true,
    gatewayMode: "external",
    localGatewayPort: "70000",
    botId: " bot-a ",
    tenantId: " ",
    connectorId: " connector-a ",
    secret: "should-not-be-retained",
    channelToken: "should-not-be-retained",
    secretConfigured: true,
    channelTokenConfigured: true,
    allowGroupMessages: "yes",
  });

  assert.deepEqual(normalized, {
    enabled: true,
    gatewayMode: "external",
    localGatewayPort: 65535,
    botId: "bot-a",
    secretConfigured: true,
    channelTokenConfigured: true,
    tenantId: "bot-a",
    connectorId: "connector-a",
    allowGroupMessages: false,
  });
  assert.equal(Object.hasOwn(normalized, "secret"), false);
  assert.equal(Object.hasOwn(normalized, "channelToken"), false);
});

test("WeCom local runtime settings normalize mode and loopback port safely", () => {
  assert.equal(settings.normalizeWecomSettings({ gatewayMode: "unknown" }).gatewayMode, "local");
  assert.equal(settings.normalizeWecomSettings({ localGatewayPort: 0 }).localGatewayPort, 18780);
  assert.equal(settings.normalizeWecomSettings({ localGatewayPort: "8080" }).localGatewayPort, 8080);
});

test("WeCom setup keeps a missing Gateway URL actionable", () => {
  assert.match(wecomSectionSource, /id="wecom-gateway-url"/);
  assert.match(wecomSectionSource, /settings\.remote\.gatewayUrl/);
  assert.match(wecomSectionSource, /focusMissingConfiguration/);
  assert.doesNotMatch(wecomSectionSource, /disabled=\{!connectorReady\}/);
});

test("WeCom setup accepts only Gateway URL schemes supported by the Connector", () => {
  for (const value of [
    "http://gateway.example",
    "https://gateway.example/root/",
    "ws://127.0.0.1:8080",
    "wss://gateway.example/ws/v2/channel",
    "https:/gateway.example",
  ]) {
    assert.equal(isSupportedGatewayUrl(value), true, value);
  }
  for (const value of ["", "gateway.example", "ftp://gateway.example", "https://", "not a url"]) {
    assert.equal(isSupportedGatewayUrl(value), false, value);
  }
  assert.match(wecomSectionSource, /settings\.wecomInvalidGateway/);
});

test("external WeCom setup requires an enabled authenticated Remote connection", () => {
  assert.match(wecomSectionSource, /if \(!settings\.remote\.enabled\)/);
  assert.match(wecomSectionSource, /settings\.wecomRemoteDisabled/);
  assert.match(wecomSectionSource, /if \(!settings\.remote\.token\.trim\(\)\)/);
  assert.match(wecomSectionSource, /settings\.wecomMissingAgentToken/);
  assert.match(wecomSectionSource, /if \(missingConfiguration\.openRemote\)/);
  assert.match(wecomSectionSource, /onOpenRemote\(\)/);
  assert.match(settingsPageSource, /onOpenRemote=\{\(\) => setSection\("remote"\)\}/);
});

test("WeCom settings expose managed local runtime controls without exposing local tokens", () => {
  assert.match(wecomSectionSource, /gatewayMode === "local"/);
  assert.match(wecomSectionSource, /id="wecom-local-gateway-port"/);
  assert.match(wecomSectionSource, /if \(!isLocalMode\)/);
  assert.match(wecomSectionSource, /channelTokenUpdate = isLocalMode \? ""/);
  assert.match(wecomSectionSource, /invoke<WecomRuntimeStatus>\("wecom_runtime_status"\)/);
  assert.match(wecomSectionSource, /"wecom_runtime_restart"/);
  assert.match(wecomSectionSource, /"wecom_runtime_logs"/);
  assert.match(wecomSectionSource, /"wecom-runtime:status"/);
});

test("external Gateway mode still exposes the managed Connector runtime", () => {
  assert.match(
    wecomSectionSource,
    /label: isLocalMode\s*\?\s*t\("settings\.wecomLocalGatewayProcess"\)\s*:\s*t\("settings\.wecomExternalGatewayConnection"\)/,
  );
  assert.match(wecomSectionSource, /label: t\("settings\.wecomConnectorProcess"\)/);
  assert.match(wecomSectionSource, /connectorState/);
  assert.match(wecomSectionSource, /connectorPid/);
  assert.match(wecomSectionSource, /connectorRestarts/);
  assert.match(wecomSectionSource, /t\("settings\.wecomRuntimeExternalHint"\)/);
  assert.match(wecomSectionSource, /invoke<WecomRuntimeStatus \| null>\("wecom_runtime_restart"\)/);
  assert.match(wecomSectionSource, /invoke<WecomRuntimeLogsResponse>\("wecom_runtime_logs"\)/);
});

test("WeCom proactive send panel requires a fully connected runtime", () => {
  assert.match(wecomSectionSource, /function isRuntimeReadyState/);
  assert.match(
    wecomSectionSource,
    /normalized === "running" \|\| normalized === "connected"/,
  );
  assert.match(
    wecomSectionSource,
    /isRuntimeReadyState\(runtimeStatus\?\.overall\)[\s\S]*isRuntimeReadyState\(runtimeStatus\?\.gatewayState\)[\s\S]*isRuntimeReadyState\(runtimeStatus\?\.connectorState\)/,
  );
  assert.match(wecomSectionSource, /disabled=\{!runtimeCanSendMessage\}/);
  assert.match(wecomSectionSource, /id="wecom-send-chat-id"/);
  assert.match(wecomSectionSource, /<Textarea[\s\S]*id="wecom-send-content"/);
});

test("WeCom proactive send uses the runtime command without persisting message content", () => {
  assert.match(
    wecomSectionSource,
    /type WecomRuntimeSendMessageResponse = \{[\s\S]*requestId: string;[\s\S]*chatId: string;[\s\S]*sentAt: number;/,
  );
  assert.match(
    wecomSectionSource,
    /invoke<WecomRuntimeSendMessageResponse>\(\s*"wecom_runtime_send_message",\s*\{\s*request:\s*\{ chatId, content \},/,
  );
  assert.match(wecomSectionSource, /setSendContent\(""\)/);

  const handlerStart = wecomSectionSource.indexOf("const sendRuntimeMessage");
  const handlerEnd = wecomSectionSource.indexOf("const closeSendPanel", handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);
  const handlerSource = wecomSectionSource.slice(handlerStart, handlerEnd);
  assert.doesNotMatch(handlerSource, /settings_save_wecom|updateWecomSettings/);
});

test("WeCom proactive send strings are localized in Chinese and English", () => {
  for (const key of [
    "settings.wecomSendMessage",
    "settings.wecomSendMessageUnavailable",
    "settings.wecomSendPanelTitle",
    "settings.wecomSendTargetId",
    "settings.wecomSendTargetIdPlaceholder",
    "settings.wecomSendTargetIdHint",
    "settings.wecomSendMarkdown",
    "settings.wecomSendMarkdownPlaceholder",
    "settings.wecomSendSubmit",
    "settings.wecomSendingMessage",
    "settings.wecomSendCancel",
    "settings.wecomSendSuccess",
    "settings.wecomSendSuccessDetails",
  ]) {
    assert.equal(i18nSource.split(`"${key}"`).length - 1, 2, key);
  }
});

test("WeCom settings do not expose a per-user permission editor", () => {
  const normalized = settings.normalizeWecomSettings({
    accessPolicy: {
      rules: [{ tenantId: "tenant-1", botId: "bot-1", externalUserId: "alice" }],
    },
  });

  assert.equal(Object.hasOwn(normalized, "accessPolicy"), false);
  assert.doesNotMatch(wecomSectionSource, /accessPolicy|allowedToolNames|allowedSkillNames/);
  assert.doesNotMatch(wecomSectionSource, /allowedDatabaseProfileIds|allowedMcpServerIds/);
  assert.doesNotMatch(i18nSource, /settings\.wecomAccessControl|settings\.wecomAddAccessRule/);
});

test("WeCom activation persists an immutable installation default before enabling", () => {
  assert.match(
    wecomSectionSource,
    /await ensureInstallationDefaultForCurrentSettings\(\)[\s\S]*updateWecomSettings\(setSettings, \{ enabled: true \}\)/,
  );
  assert.match(wecomSectionSource, /if \(activatingRef\.current\) return;/);
  assert.match(wecomSectionSource, /disabled=\{activating\}/);
  assert.match(wecomSectionSource, /setActivationError/);
  assert.match(wecomSectionSource, /defaultProfileEnsuredRef/);
  assert.match(
    wecomSectionSource,
    /!settings\.wecom\.enabled[\s\S]*defaultProfileEnsuredRef\.current[\s\S]*ensureInstallationDefaultForCurrentSettings/,
  );
  assert.match(appSource, /if \(!settingsReady \|\| !settings\.wecom\.enabled/);
  assert.match(appSource, /ensureWecomInstallationDefault\(settings\)/);
  assert.match(appSource, /ensuredWecomInstallationRef\.current === installationId/);
});

test("WeCom autosave waits for Remote Gateway settings before validating WeCom", async () => {
  const events = [];
  let finishRemoteSave;
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        invoke(command, args) {
          events.push(`${command}:start`);
          if (command === "settings_save_remote") {
            return new Promise((resolve) => {
              finishRemoteSave = () => {
                events.push(`${command}:done`);
                resolve(undefined);
              };
            });
          }
          if (command === "settings_save_wecom") {
            return Promise.resolve(args.payload);
          }
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    },
  });
  const { persistSettings } = loader.loadModule("src/lib/settings/storage.ts");
  const defaults = settings.getDefaultSettings();
  const next = {
    ...defaults,
    remote: {
      ...defaults.remote,
      gatewayUrl: "https://gateway.example",
    },
    wecom: {
      ...defaults.wecom,
      gatewayMode: "external",
      botId: "bot-1",
      tenantId: "tenant-1",
      channelTokenConfigured: true,
    },
  };

  const saving = persistSettings(defaults, next);
  await Promise.resolve();
  assert.deepEqual(events, ["settings_save_remote:start"]);

  finishRemoteSave();
  const result = await saving;
  assert.deepEqual(events, [
    "settings_save_remote:start",
    "settings_save_remote:done",
    "settings_save_wecom:start",
  ]);
  assert.equal(result.wecom.gatewayMode, "external");
});

test("WeCom autosave reconciles the backend public settings response", () => {
  assert.match(settingsStorageSource, /invoke<AppSettings\["wecom"\]>\("settings_save_wecom"/);
  assert.match(settingsStorageSource, /result\.wecom = wecom/);
  assert.match(appSource, /persistResult\.wecom/);
});
