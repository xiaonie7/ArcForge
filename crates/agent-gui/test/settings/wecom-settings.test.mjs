import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const settings = createTsModuleLoader().loadModule("src/lib/settings/index.ts");
const { isSupportedGatewayUrl } = createTsModuleLoader().loadModule(
  "src/lib/settings/normalize.ts",
);
const { resolveWeComGrant } = createTsModuleLoader().loadModule(
  "src/lib/security/wecomAccessPolicy.ts",
);
const {
  commitWeComAccessRuleDraft,
  createWeComAccessRuleDraft,
  editWeComAccessRuleDraft,
} = createTsModuleLoader().loadModule("src/pages/settings/wecomAccessDraft.ts");
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
    accessPolicy: { rules: [] },
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
    accessPolicy: { rules: [] },
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

test("WeCom permission editor exposes exact user identity and resource allowlists", () => {
  assert.match(wecomSectionSource, /settings\.wecom\.accessPolicy\.rules\.length === 0/);
  assert.match(wecomSectionSource, /updateWecomSettings\(setSettings, \{ accessPolicy: \{ rules \} \}\)/);

  for (const field of ["tenantId", "botId", "externalUserId"]) {
    assert.match(wecomSectionSource, new RegExp(`key: "${field}"`));
  }
  for (const scope of ["tool:read", "skill:use", "database:read", "mcp:invoke"]) {
    assert.match(wecomSectionSource, new RegExp(`\\["${scope}",`));
  }
  for (const field of [
    "allowedToolNames",
    "allowedSkillNames",
    "allowedSkillBaseDirs",
    "allowedMcpServerIds",
  ]) {
    assert.match(wecomSectionSource, new RegExp(`key: "${field}"`));
  }
  assert.match(wecomSectionSource, /defaultSkillName/);
  assert.match(wecomSectionSource, /allowedDatabaseProfileIds/);
  assert.match(wecomSectionSource, /invoke<DatabaseProfileOption\[\]>\("database_profiles_list"\)/);
});

test("WeCom database and default Skill permission labels are localized", () => {
  for (const key of [
    "settings.wecomAccessScopeDatabase",
    "settings.wecomDefaultSkill",
    "settings.wecomDefaultSkillNone",
    "settings.wecomDefaultSkillHint",
    "settings.wecomAllowedDatabaseProfiles",
    "settings.wecomAllowedDatabaseProfilesHint",
    "settings.wecomDatabaseProfilesLoading",
    "settings.wecomDatabaseProfilesEmpty",
    "settings.wecomDatabaseProfileUnavailable",
  ]) {
    assert.equal(i18nSource.split(`"${key}"`).length - 1, 2, key);
  }
});

test("WeCom permission editor keeps an incomplete user rule as a local draft", () => {
  const draft = createWeComAccessRuleDraft("tenant-1", "bot-1");
  assert.equal(draft.externalUserId, "");
  assert.equal(draft.defaultSkillName, "");
  assert.deepEqual(draft.allowedDatabaseProfileIds, []);
  assert.equal(commitWeComAccessRuleDraft({ rules: [] }, draft), null);

  const completed = editWeComAccessRuleDraft(draft, { externalUserId: " alice " });
  const policy = commitWeComAccessRuleDraft({ rules: [] }, completed);
  assert.equal(policy.rules.length, 1);
  assert.equal(policy.rules[0].externalUserId, "alice");

  assert.match(wecomSectionSource, /useState<WeComAccessRuleDraft \| null>/);
  assert.match(wecomSectionSource, /commitWeComAccessRuleDraft/);
  assert.match(wecomSectionSource, /disabled=\{!isCompleteWeComAccessRuleDraft\(accessRuleDraft\)\}/);
});

test("WeCom permissions default to deny when no exact user rule matches", () => {
  const accessPolicy = settings.normalizeWecomSettings({
    accessPolicy: {
      rules: [
        {
          tenantId: "tenant-1",
          botId: "bot-1",
          externalUserId: "alice",
          scopes: ["tool:read"],
          allowedToolNames: ["Read"],
        },
      ],
    },
  }).accessPolicy;

  const unmatched = resolveWeComGrant(
    { tenantId: "tenant-1", botId: "bot-1", externalUserId: "bob" },
    accessPolicy,
  );
  assert.equal(unmatched.matched, false);
  assert.deepEqual(unmatched.scopes, []);
  assert.deepEqual(unmatched.allowedToolNames, []);
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
