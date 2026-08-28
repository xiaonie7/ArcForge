import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function settings(overrides = {}) {
  return {
    system: {
      executionMode: "tools",
      workdir: "C:/workspace",
      selectedSystemTools: ["terminal"],
      ...(overrides.system ?? {}),
    },
    skills: {
      enabled: true,
      selected: ["review"],
      ...(overrides.skills ?? {}),
    },
    mcp: {
      servers: [],
      ...(overrides.mcp ?? {}),
    },
    wecom: {
      enabled: true,
      botId: "bot-1",
      tenantId: "tenant-1",
      connectorId: "connector-1",
      ...(overrides.wecom ?? {}),
    },
  };
}

function installationDefault(input) {
  return {
    profile: {
      id: "profile-1",
      name: input.name,
      revision: 2,
      policy: input.policy,
      policyHash: "hash-2",
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
    },
    binding: {
      id: "binding-1",
      installationId: input.installationId,
      principalType: "installation",
      principalId: "*",
      profileId: "profile-1",
      profileRevision: 2,
      updatedAt: 2,
    },
    followsDesktop: true,
    profileCurrentRevision: 2,
  };
}

function createHarness(invoke = async (_command, { input }) => installationDefault(input)) {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        invoke(command, args) {
          calls.push({ command, args });
          return invoke(command, args);
        },
      },
    },
  });
  return {
    ...loader.loadModule("src/lib/wecomPermissionProfile.ts"),
    calls,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

function principal(installationId) {
  return {
    principalId: "principal-1",
    installationId,
    channel: "wecom",
    tenantId: "tenant-1",
    botId: "bot-1",
    externalUserId: "user-1",
    chatId: "group-1",
    chatType: "group",
    externalMessageId: "message-1",
    connectorId: "connector-1",
    channelSessionId: "session-1",
    channelCommand: "",
    authTime: 1,
    requestId: "request-1",
  };
}

test("WeCom sync keys use normalized identity and the complete desktop policy", () => {
  const { buildWecomInstallationDefaultSyncKey: key } = createHarness();
  const original = settings();
  assert.equal(
    key(original),
    key(settings({
      system: { workdir: " C:/workspace ", selectedSystemTools: [" terminal ", "terminal"] },
      skills: { selected: [" review ", "review"] },
      wecom: { botId: " bot-1 ", tenantId: " tenant-1 ", connectorId: " connector-1 " },
    })),
  );
  assert.equal(key(original), key({ ...original, theme: "dark", locale: "en" }));
  assert.equal(
    key(settings({ wecom: { tenantId: "", connectorId: "" } })),
    key(settings({ wecom: { tenantId: "bot-1", connectorId: "wecom-desktop" } })),
  );
  for (const changed of [
    { skills: { selected: ["new-skill"] } },
    { skills: { enabled: false } },
    { system: { executionMode: "agent-dev" } },
    { system: { workdir: "C:/other" } },
    { system: { selectedSystemTools: ["new-tool"] } },
    { mcp: { servers: [{ id: "server-1", enabled: true }] } },
    { wecom: { botId: "bot-2" } },
  ]) {
    assert.notEqual(key(original), key(settings(changed)));
  }
});

test("identical in-flight WeCom ensures share a promise without caching completed writes", async () => {
  const waiting = deferred();
  let attempts = 0;
  const harness = createHarness(async (_command, { input }) => {
    attempts += 1;
    if (attempts === 1) await waiting.promise;
    return { ...installationDefault(input), followsDesktop: attempts === 1 };
  });
  const first = harness.ensureWecomInstallationDefault(settings());
  const second = harness.ensureWecomInstallationDefault(settings());
  assert.equal(first, second);
  await flushPromises();
  assert.equal(harness.calls.length, 1);
  waiting.resolve();
  assert.equal(await first, await second);

  const third = harness.ensureWecomInstallationDefault(settings());
  assert.notEqual(third, first);
  assert.equal((await third).followsDesktop, false);
  assert.equal(harness.calls.length, 2, "settled calls must recheck manual profile changes");
});

test("WeCom writes preserve A to B to A order and snapshot queued settings", async () => {
  const waiting = [deferred(), deferred(), deferred()];
  let nextIndex = 0;
  const harness = createHarness(async (_command, { input }) => {
    await waiting[nextIndex++].promise;
    return installationDefault(input);
  });
  const next = settings({ skills: { selected: ["B"] } });
  const first = harness.ensureWecomInstallationDefault(settings({ skills: { selected: ["A"] } }));
  const second = harness.ensureWecomInstallationDefault(next);
  assert.equal(harness.ensureWecomInstallationDefault(next), second);
  const third = harness.ensureWecomInstallationDefault(settings({ skills: { selected: ["A"] } }));
  next.skills.selected.push("changed-after-queueing");
  assert.notEqual(third, first);
  await flushPromises();
  assert.deepEqual(harness.calls.map(({ args }) => args.input.policy.allowedSkills), [["A"]]);

  waiting[0].resolve();
  await first;
  await flushPromises();
  assert.deepEqual(harness.calls.map(({ args }) => args.input.policy.allowedSkills), [["A"], ["B"]]);
  waiting[1].resolve();
  await second;
  await flushPromises();
  assert.deepEqual(harness.calls.map(({ args }) => args.input.policy.allowedSkills), [["A"], ["B"], ["A"]]);
  waiting[2].resolve();
  await third;
});

test("independent WeCom installations do not block one another", async () => {
  const waiting = deferred();
  const harness = createHarness(async (_command, { input }) => {
    if (input.name === "WeCom bot-1 default") await waiting.promise;
    return installationDefault(input);
  });
  const first = harness.ensureWecomInstallationDefault(settings());
  const second = harness.ensureWecomInstallationDefault(settings({ wecom: { botId: "bot-2" } }));
  await second;
  assert.equal(harness.calls.length, 2);
  waiting.resolve();
  await first;
});

test("a failed WeCom ensure can be retried with the same settings", async () => {
  let attempts = 0;
  const failure = new Error("policy write failed");
  const harness = createHarness(async (_command, { input }) => {
    if (++attempts === 1) throw failure;
    return installationDefault(input);
  });
  await assert.rejects(harness.ensureWecomInstallationDefault(settings()), (error) => error === failure);
  await harness.ensureWecomInstallationDefault(settings());
  assert.equal(harness.calls.length, 2);
});

test("a failed WeCom write does not prevent the next queued policy from running", async () => {
  const waiting = deferred();
  let attempts = 0;
  const failure = new Error("policy write failed");
  const harness = createHarness(async (_command, { input }) => {
    if (++attempts === 1) await waiting.promise;
    return installationDefault(input);
  });
  const first = harness.ensureWecomInstallationDefault(settings());
  const rejection = assert.rejects(first, (error) => error === failure);
  const second = harness.ensureWecomInstallationDefault(settings({ skills: { selected: ["next"] } }));
  waiting.reject(failure);
  await rejection;
  assert.deepEqual((await second).profile.policy.allowedSkills, ["next"]);
  assert.equal(harness.calls.length, 2);
});

test("WeCom permission resolution waits for shared sync and preserves effective overrides", async () => {
  const waiting = deferred();
  const effectiveProfile = { id: "manual-user-profile", policy: { allowedSkills: ["restricted"] } };
  const harness = createHarness(async (command, { input }) => {
    if (command === "channel_installation_default_ensure") {
      await waiting.promise;
      return installationDefault(input);
    }
    assert.equal(command, "channel_profile_resolve_effective");
    return effectiveProfile;
  });
  const input = harness.buildWecomInstallationDefaultInput(settings());
  const startup = harness.ensureWecomInstallationDefault(settings());
  const resolved = harness.resolveWecomPermissionProfile(settings(), principal(input.installationId), "group-1");
  await flushPromises();
  assert.deepEqual(harness.calls.map(({ command }) => command), ["channel_installation_default_ensure"]);
  waiting.resolve();
  await startup;
  assert.equal(await resolved, effectiveProfile);
  assert.deepEqual(harness.calls[1], {
    command: "channel_profile_resolve_effective",
    args: { input: { installationId: input.installationId, userId: "user-1", conversationId: "group-1" } },
  });
});

for (const [name, overrides, otherInstallation] of [
  ["another installation", {}, true],
  ["disabled WeCom", { wecom: { enabled: false } }, false],
  ["an unconfigured bot", { wecom: { botId: "" } }, false],
]) {
  test(`WeCom permission resolution does not create or sync a default for ${name}`, async () => {
    const harness = createHarness(async () => null);
    const installationId = otherInstallation
      ? harness.buildWecomInstallationDefaultInput(settings({ wecom: { botId: "another-bot" } })).installationId
      : harness.buildWecomInstallationDefaultInput(settings()).installationId;
    const result = await harness.resolveWecomPermissionProfile(settings(overrides), principal(installationId));
    assert.equal(result, null);
    assert.deepEqual(harness.calls, [{
      command: "channel_profile_resolve_effective",
      args: { input: { installationId, userId: "user-1", conversationId: undefined } },
    }]);
  });
}

test("WeCom sync failure rejects resolution without using a stale profile", async () => {
  const failure = new Error("sync failed");
  const harness = createHarness(async () => { throw failure; });
  const { installationId } = harness.buildWecomInstallationDefaultInput(settings());
  await assert.rejects(
    harness.resolveWecomPermissionProfile(settings(), principal(installationId)),
    (error) => error === failure,
  );
  assert.deepEqual(harness.calls.map(({ command }) => command), ["channel_installation_default_ensure"]);
});

test("WeCom effective profile resolution errors propagate after successful sync", async () => {
  const failure = new Error("profile resolution failed");
  const harness = createHarness(async (command, { input }) => {
    if (command === "channel_installation_default_ensure") return installationDefault(input);
    throw failure;
  });
  const { installationId } = harness.buildWecomInstallationDefaultInput(settings());
  await assert.rejects(
    harness.resolveWecomPermissionProfile(settings(), principal(installationId)),
    (error) => error === failure,
  );
  assert.deepEqual(harness.calls.map(({ command }) => command), [
    "channel_installation_default_ensure",
    "channel_profile_resolve_effective",
  ]);
});

test("WeCom adoption serializes with ensure and sends the observed binding and profile versions", async () => {
  const waiting = deferred();
  const harness = createHarness(async (command, { input }) => {
    if (command === "channel_installation_default_ensure") await waiting.promise;
    return installationDefault(input);
  });
  const input = harness.buildWecomInstallationDefaultInput(settings());
  const existing = { ...installationDefault(input), followsDesktop: false, profileCurrentRevision: 7 };
  const startup = harness.ensureWecomInstallationDefault(settings());
  const adopted = harness.adoptWecomInstallationDefault(settings(), existing);
  const duplicate = harness.adoptWecomInstallationDefault(settings(), existing);
  assert.equal(adopted, duplicate);
  await flushPromises();
  assert.deepEqual(harness.calls.map(({ command }) => command), ["channel_installation_default_ensure"]);
  waiting.resolve();
  await startup;
  await adopted;
  assert.deepEqual(harness.calls[1], {
    command: "channel_installation_default_adopt",
    args: {
      input: {
        ...input,
        expected: {
          bindingId: "binding-1",
          profileId: "profile-1",
          profileRevision: 2,
          profileCurrentRevision: 7,
          policyHash: "hash-2",
        },
      },
    },
  });
});

test("WeCom adoption does not merge calls with different observed profile versions", async () => {
  const waiting = deferred();
  let attempts = 0;
  const failure = new Error("installation default changed");
  const harness = createHarness(async (_command, { input }) => {
    if (++attempts === 1) await waiting.promise;
    else throw failure;
    return installationDefault(input);
  });
  const input = harness.buildWecomInstallationDefaultInput(settings());
  const existing = installationDefault(input);
  const first = harness.adoptWecomInstallationDefault(settings(), existing);
  const second = harness.adoptWecomInstallationDefault(settings(), {
    ...existing,
    profileCurrentRevision: existing.profileCurrentRevision + 1,
  });
  const rejection = assert.rejects(second, (error) => error === failure);
  assert.notEqual(first, second);
  await flushPromises();
  assert.equal(harness.calls.length, 1);
  waiting.resolve();
  await first;
  await rejection;
  assert.deepEqual(harness.calls.map(({ args }) => args.input.expected.profileCurrentRevision), [2, 3]);
});
