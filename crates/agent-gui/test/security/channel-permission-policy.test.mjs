import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const {
  createChannelMcpSettingsSnapshot,
  createDefaultChannelPermissionPolicy,
  DEFAULT_CHANNEL_BUILTIN_SYSTEM_TOOLS,
  DEFAULT_CHANNEL_MAX_DURATION_SECONDS,
  DEFAULT_CHANNEL_MAX_OUTPUT_CHARS,
  normalizeChannelPermissionPolicy,
} = createTsModuleLoader().loadModule("src/lib/channelPermissionPolicy.ts");

function settings(overrides = {}) {
  return {
    system: {
      executionMode: "tools",
      workdir: " C:/workspace ",
      selectedSystemTools: ["terminal", "terminal", " database "],
      ...(overrides.system ?? {}),
    },
    skills: {
      enabled: true,
      selected: ["docs", " docs ", "review"],
      ...(overrides.skills ?? {}),
    },
    mcp: {
      servers: [
        { id: "github", enabled: true },
        { id: "disabled", enabled: false },
        { id: " github ", enabled: true },
      ],
      ...(overrides.mcp ?? {}),
    },
  };
}

test("installation defaults snapshot current desktop capabilities with compatibility bounds", () => {
  const policy = createDefaultChannelPermissionPolicy(settings());
  assert.deepEqual(policy, {
    executionMode: "tools",
    workdir: "C:/workspace",
    allowEmptyWorkdir: false,
    allowedSkills: ["docs", "review"],
    allowedSystemTools: [...DEFAULT_CHANNEL_BUILTIN_SYSTEM_TOOLS, "terminal", "database"],
    allowedMcpServers: ["github"],
    memoryEnabled: true,
    nativeWebSearchEnabled: false,
    maxDurationSeconds: DEFAULT_CHANNEL_MAX_DURATION_SECONDS,
    maxOutputChars: DEFAULT_CHANNEL_MAX_OUTPUT_CHARS,
  });
  assert.equal(policy.allowedSystemTools.includes("read"), true);
  assert.equal(policy.allowedSystemTools.includes("OfficeRuntime"), true);
  assert.equal(DEFAULT_CHANNEL_MAX_DURATION_SECONDS, 3_600);
  assert.equal(DEFAULT_CHANNEL_MAX_OUTPUT_CHARS, 1_000_000);
});

test("installation defaults preserve empty agent scope and disabled skills explicitly", () => {
  const policy = createDefaultChannelPermissionPolicy(
    settings({
      system: { executionMode: "agent-dev", workdir: "" },
      skills: { enabled: false, selected: ["docs"] },
    }),
  );

  assert.equal(policy.allowEmptyWorkdir, true);
  assert.deepEqual(policy.allowedSkills, []);
});

test("text installation defaults do not grant empty agent scope", () => {
  const policy = createDefaultChannelPermissionPolicy(
    settings({ system: { executionMode: "text", workdir: "" } }),
  );

  assert.equal(policy.allowEmptyWorkdir, false);
});

test("missing optional policy capabilities normalize to fail-closed values", () => {
  assert.deepEqual(normalizeChannelPermissionPolicy({ executionMode: "tools" }), {
    executionMode: "tools",
    workdir: "",
    allowEmptyWorkdir: false,
    allowedSkills: [],
    allowedSystemTools: [],
    allowedMcpServers: [],
    memoryEnabled: false,
    nativeWebSearchEnabled: false,
    maxDurationSeconds: DEFAULT_CHANNEL_MAX_DURATION_SECONDS,
    maxOutputChars: DEFAULT_CHANNEL_MAX_OUTPUT_CHARS,
  });
});

test("provider-native web search requires an explicit channel grant", () => {
  assert.equal(
    normalizeChannelPermissionPolicy({
      executionMode: "text",
      nativeWebSearchEnabled: true,
    }).nativeWebSearchEnabled,
    true,
  );
  assert.equal(
    normalizeChannelPermissionPolicy({ executionMode: "text" }).nativeWebSearchEnabled,
    false,
  );
});

test("channel profiles cannot grant Skills meta-management", () => {
  const policy = normalizeChannelPermissionPolicy({
    executionMode: "tools",
    allowedSkills: ["review", "skills-installer", "skills-creator"],
  });

  assert.deepEqual(policy.allowedSkills, ["review"]);
});

test("MCP authorization is a deep-frozen turn-start snapshot", () => {
  const source = {
    selected: ["docs", "other"],
    servers: [
      {
        id: "docs",
        enabled: true,
        transport: "stdio",
        command: "docs",
        args: ["serve"],
        url: "",
        env: { TOKEN: "secret" },
        headers: { Authorization: "secret" },
        timeoutMs: 1000,
      },
      {
        id: "other",
        enabled: true,
        transport: "stdio",
        command: "other",
        args: [],
        url: "",
        timeoutMs: 1000,
      },
    ],
  };

  const snapshot = createChannelMcpSettingsSnapshot(source, ["docs"]);
  source.servers[0].args.push("changed");
  source.servers[0].env.TOKEN = "changed";

  assert.deepEqual(snapshot.selected, ["docs"]);
  assert.deepEqual(snapshot.servers[0].args, ["serve"]);
  assert.equal(snapshot.servers[0].env.TOKEN, "secret");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.servers), true);
  assert.equal(Object.isFrozen(snapshot.servers[0].env), true);
});

test("WeCom installation ensure uses the connector-compatible identity and frozen defaults", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          return { profile: { id: "profile-1" }, binding: { id: "binding-1" } };
        },
      },
    },
  });
  const { ensureWecomInstallationDefault } = loader.loadModule(
    "src/lib/wecomPermissionProfile.ts",
  );

  await ensureWecomInstallationDefault({
    ...settings(),
    wecom: {
      botId: " bot-1 ",
      tenantId: " tenant-1 ",
      connectorId: " connector-1 ",
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "channel_installation_default_ensure");
  assert.equal(
    calls[0].args.input.installationId,
    '{"bot_id":"bot-1","channel":"wecom","connector_id":"connector-1","tenant_id":"tenant-1"}',
  );
  assert.equal(calls[0].args.input.name, "WeCom bot-1 default");
  assert.equal(calls[0].args.input.policy.maxDurationSeconds, 3_600);
  assert.equal(calls[0].args.input.policy.maxOutputChars, 1_000_000);
});
