import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const settingsPageSource = readFileSync(
  new URL("../src/pages/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const playbooksSectionSource = readFileSync(
  new URL("../src/pages/settings/PlaybooksSection.tsx", import.meta.url),
  "utf8",
);
const playbookModalSource = readFileSync(
  new URL("../src/pages/settings/PlaybookModal.tsx", import.meta.url),
  "utf8",
);
const playbookScheduleModalSource = readFileSync(
  new URL("../src/pages/settings/PlaybookScheduleModal.tsx", import.meta.url),
  "utf8",
);
const settingsSyncSource = readFileSync(
  new URL("../src/app/hooks/useGatewaySettingsSync.ts", import.meta.url),
  "utf8",
);

function automationSnapshot(overrides = {}) {
  return {
    cron: { revision: 4, tasks: [] },
    hooks: { revision: 2, hooks: [] },
    playbooks: { revision: 1, items: [] },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("web automation backend sends Playbook operations through cron.manage", async () => {
  const calls = [];
  const client = {
    async cronManage(payload) {
      calls.push(payload);
      if (payload.action === "playbooks_apply") {
        return {
          result_json: JSON.stringify({
            status: "ok",
            playbooks: { revision: 2, items: [] },
          }),
        };
      }
      if (payload.action === "playbook_create_cron") {
        return {
          result_json: JSON.stringify({
            status: "ok",
            cron: { revision: 5, tasks: [] },
          }),
        };
      }
      throw new Error(`Unexpected action: ${payload.action}`);
    },
  };
  const loader = createWebModuleLoader({
    rootDir,
    mocks: {
      "../gatewaySocket": { getGatewayWebSocketClient: () => client },
      "../storage": { loadToken: () => " token " },
    },
  });
  const { backend } = loader.loadModule("src/lib/automation/backend.ts");

  await backend.playbooksApply({
    baseRevision: 1,
    ops: [{ op: "delete", id: "weekly-report" }],
  });
  await backend.createPlaybookCron({
    playbookId: "weekly-report",
    cronBaseRevision: 4,
    cron: "0 0 9 * * 5",
  });

  assert.deepEqual(calls, [
    {
      action: "playbooks_apply",
      task_id: undefined,
      task_json: JSON.stringify({
        baseRevision: 1,
        ops: [{ op: "delete", id: "weekly-report" }],
      }),
    },
    {
      action: "playbook_create_cron",
      task_id: undefined,
      task_json: JSON.stringify({
        playbookId: "weekly-report",
        cronBaseRevision: 4,
        cron: "0 0 9 * * 5",
      }),
    },
  ]);
});

test("Playbook store rebases apply conflicts and cron creation conflicts independently", async () => {
  const applyRevisions = [];
  const cronRevisions = [];
  let applyAttempt = 0;
  let cronAttempt = 0;
  const backend = {
    async fetchSnapshot() {
      return automationSnapshot();
    },
    subscribe() {
      return () => {};
    },
    async playbooksApply(input) {
      applyRevisions.push(input.baseRevision);
      applyAttempt += 1;
      return applyAttempt === 1
        ? { status: "conflict", playbooks: { revision: 2, items: [] } }
        : { status: "ok", playbooks: { revision: 3, items: [] } };
    },
    async createPlaybookCron(input) {
      cronRevisions.push(input.cronBaseRevision);
      cronAttempt += 1;
      return cronAttempt === 1
        ? { status: "conflict", cron: { revision: 5, tasks: [] } }
        : { status: "ok", cron: { revision: 6, tasks: [] } };
    },
  };
  const loader = createWebModuleLoader({
    rootDir,
    mocks: { "./backend": { backend } },
  });
  const store = loader.loadModule("src/lib/automation/store.ts");

  await store.applyPlaybookOps([{ op: "create", item: { name: "Weekly report" } }]);
  assert.deepEqual(applyRevisions, [1, 2]);
  assert.equal(store.getAutomationState().supportsPlaybooks, true);
  assert.equal(store.getAutomationState().playbooks.revision, 3);

  await store.createCronFromPlaybook({
    playbookId: "weekly-report",
    cron: "0 0 9 * * 5",
  });
  assert.deepEqual(cronRevisions, [4, 5]);
  assert.equal(store.getAutomationState().cron.revision, 6);

  store.feedPlaybooksSnapshot({ revision: 2, items: [{ id: "stale" }] });
  assert.equal(store.getAutomationState().playbooks.revision, 3);
  assert.deepEqual(store.getAutomationState().playbooks.items, []);
});

test("automation snapshots remain compatible with desktops that predate Playbooks", async () => {
  let playbookRequestCount = 0;
  const backend = {
    async fetchSnapshot() {
      return {
        cron: { revision: 1, tasks: [] },
        hooks: { revision: 1, hooks: [] },
      };
    },
    subscribe() {
      return () => {};
    },
    async playbooksApply() {
      playbookRequestCount += 1;
      throw new Error("unsupported request should not be sent");
    },
    async createPlaybookCron() {
      playbookRequestCount += 1;
      throw new Error("unsupported request should not be sent");
    },
  };
  const loader = createWebModuleLoader({
    rootDir,
    mocks: { "./backend": { backend } },
  });
  const store = loader.loadModule("src/lib/automation/store.ts");

  await store.initAutomation();
  assert.equal(store.getAutomationState().playbooksCapabilityKnown, true);
  assert.equal(store.getAutomationState().supportsPlaybooks, false);
  assert.deepEqual(store.getAutomationState().playbooks, { revision: 0, items: [] });
  await assert.rejects(
    store.applyPlaybookOps([{ op: "delete", id: "weekly-report" }]),
    { name: "AutomationUnsupportedError" },
  );
  await assert.rejects(
    store.createCronFromPlaybook({
      playbookId: "weekly-report",
      cron: "0 0 9 * * 5",
    }),
    { name: "AutomationUnsupportedError" },
  );
  assert.equal(playbookRequestCount, 0);
});

test("partial automation snapshots keep Playbook capability unknown until it arrives", () => {
  const loader = createWebModuleLoader({
    rootDir,
    mocks: { "./backend": { backend: {} } },
  });
  const store = loader.loadModule("src/lib/automation/store.ts");

  store.resetAutomation();
  store.feedCronSnapshot({ revision: 1, tasks: [] });
  assert.equal(store.getAutomationState().ready, true);
  assert.equal(store.getAutomationState().playbooksCapabilityKnown, false);
  assert.equal(store.getAutomationState().supportsPlaybooks, false);

  store.feedPlaybooksSnapshot({ revision: 1, items: [] });
  assert.equal(store.getAutomationState().playbooksCapabilityKnown, true);
  assert.equal(store.getAutomationState().supportsPlaybooks, true);
});

test("automation reset accepts lower revisions from a new authority", async () => {
  const authorityA = automationSnapshot({
    cron: { revision: 12, tasks: [{ id: "cron-a" }] },
    hooks: { revision: 11, hooks: [{ id: "hook-a" }] },
    playbooks: { revision: 10, items: [{ id: "playbook-a" }] },
  });
  const authorityB = automationSnapshot({
    cron: { revision: 2, tasks: [] },
    hooks: { revision: 1, hooks: [] },
    playbooks: { revision: 1, items: [{ id: "playbook-b" }] },
  });
  let current = authorityA;
  let fetchCount = 0;
  let unsubscribeCount = 0;
  const applyBases = [];
  const backend = {
    async fetchSnapshot() {
      fetchCount += 1;
      return current;
    },
    subscribe() {
      return () => {
        unsubscribeCount += 1;
      };
    },
    async playbooksApply(input) {
      applyBases.push(input.baseRevision);
      return { status: "ok", playbooks: { revision: 2, items: [] } };
    },
  };
  const loader = createWebModuleLoader({
    rootDir,
    mocks: { "./backend": { backend } },
  });
  const store = loader.loadModule("src/lib/automation/store.ts");

  await store.initAutomation();
  assert.equal(store.getAutomationState().playbooks.revision, 10);

  current = authorityB;
  store.resetAutomation();
  assert.equal(unsubscribeCount, 1);
  assert.deepEqual(store.getAutomationState(), {
    ready: false,
    playbooksCapabilityKnown: false,
    supportsPlaybooks: false,
    cron: { revision: 0, tasks: [] },
    hooks: { revision: 0, hooks: [] },
    playbooks: { revision: 0, items: [] },
  });
  await store.initAutomation();
  assert.equal(fetchCount, 2);
  assert.deepEqual(store.getAutomationState(), {
    ready: true,
    playbooksCapabilityKnown: true,
    supportsPlaybooks: true,
    ...authorityB,
  });

  await store.applyPlaybookOps([{ op: "delete", id: "playbook-b" }]);
  assert.deepEqual(applyBases, [1]);
});

test("automation reset clears Playbook support for a legacy authority", async () => {
  const snapshots = [
    automationSnapshot({ playbooks: { revision: 8, items: [{ id: "playbook-a" }] } }),
    { cron: { revision: 0, tasks: [] }, hooks: { revision: 0, hooks: [] } },
  ];
  let fetchIndex = 0;
  let playbookRequestCount = 0;
  const backend = {
    async fetchSnapshot() {
      return snapshots[fetchIndex++];
    },
    subscribe() {
      return () => {};
    },
    async playbooksApply() {
      playbookRequestCount += 1;
      throw new Error("unexpected Playbook request");
    },
  };
  const loader = createWebModuleLoader({
    rootDir,
    mocks: { "./backend": { backend } },
  });
  const store = loader.loadModule("src/lib/automation/store.ts");

  await store.initAutomation();
  assert.equal(store.getAutomationState().supportsPlaybooks, true);
  store.resetAutomation();
  await store.initAutomation();

  assert.equal(fetchIndex, 2);
  assert.equal(store.getAutomationState().supportsPlaybooks, false);
  assert.deepEqual(store.getAutomationState().playbooks, { revision: 0, items: [] });
  await assert.rejects(
    store.applyPlaybookOps([{ op: "delete", id: "playbook-a" }]),
    { name: "AutomationUnsupportedError" },
  );
  assert.equal(playbookRequestCount, 0);
});

test("stale automation initialization cannot overwrite the current authority", async () => {
  const staleFetch = deferred();
  const authorityA = automationSnapshot({
    cron: { revision: 12, tasks: [{ id: "cron-a" }] },
    playbooks: { revision: 10, items: [{ id: "playbook-a" }] },
  });
  const authorityB = automationSnapshot({
    cron: { revision: 2, tasks: [] },
    playbooks: { revision: 1, items: [{ id: "playbook-b" }] },
  });
  let fetchCount = 0;
  const backend = {
    fetchSnapshot() {
      fetchCount += 1;
      return fetchCount === 1 ? staleFetch.promise : Promise.resolve(authorityB);
    },
    subscribe() {
      return () => {};
    },
  };
  const loader = createWebModuleLoader({
    rootDir,
    mocks: { "./backend": { backend } },
  });
  const store = loader.loadModule("src/lib/automation/store.ts");

  const staleInit = store.initAutomation();
  store.resetAutomation();
  await store.initAutomation();
  assert.equal(store.getAutomationState().playbooks.items[0].id, "playbook-b");

  staleFetch.resolve(authorityA);
  await staleInit;
  assert.deepEqual(store.getAutomationState(), {
    ready: true,
    playbooksCapabilityKnown: true,
    supportsPlaybooks: true,
    ...authorityB,
  });
  await store.initAutomation();
  assert.equal(fetchCount, 2);
});

test("stale automation initialization failure cannot clear the current init cache", async () => {
  const staleFetch = deferred();
  let fetchCount = 0;
  const backend = {
    fetchSnapshot() {
      fetchCount += 1;
      return fetchCount === 1
        ? staleFetch.promise
        : Promise.resolve(automationSnapshot({ playbooks: { revision: 1, items: [] } }));
    },
    subscribe() {
      return () => {};
    },
  };
  const loader = createWebModuleLoader({
    rootDir,
    mocks: { "./backend": { backend } },
  });
  const store = loader.loadModule("src/lib/automation/store.ts");

  const staleInit = store.initAutomation();
  const staleRejection = assert.rejects(staleInit, /stale authority failed/);
  store.resetAutomation();
  await store.initAutomation();
  staleFetch.reject(new Error("stale authority failed"));
  await staleRejection;
  await store.initAutomation();
  assert.equal(fetchCount, 2);
});

test("web settings hide and gate Playbooks until capability support is known", () => {
  assert.match(
    settingsPageSource,
    /item\.id !== "playbooks" \|\| \(playbooksCapabilityKnown && supportsPlaybooks\)/,
  );
  assert.match(
    settingsPageSource,
    /section === "playbooks" && !playbooksCapabilityKnown/,
  );
  assert.match(settingsPageSource, /const effectiveSection =/);
  assert.match(settingsPageSource, /switch \(effectiveSection\)/);
  assert.match(
    playbooksSectionSource,
    /if \(!playbooksCapabilityKnown \|\| !supportsPlaybooks\)/,
  );
});

test("Gateway Playbook forms preserve inherited fields and lock closing while saving", () => {
  assert.match(
    playbookModalSource,
    /const initialWorkdir = initialData \? \(initialData\.workdir \?\? ""\) : defaultWorkdir/,
  );
  assert.match(playbookModalSource, /dirtyFieldsRef = useRef\(new Set<PlaybookFormField>\(\)\)/);
  assert.match(playbooksSectionSource, /Object\.fromEntries\(dirtyFields\.map/);
  assert.match(playbooksSectionSource, /playbook\.selectedSkills \?\? settings\.skills\.selected/);
  assert.match(playbookModalSource, /maxLength=\{MAX_WECOM_TARGET_CHARACTERS\}/);
  assert.match(playbookModalSource, /scheduled\.playbooksDeliveryTargetInvalid/);
  assert.ok((playbookModalSource.match(/onClick=\{requestCloseIfIdle\}/g) ?? []).length >= 3);
  assert.ok((playbookScheduleModalSource.match(/onClick=\{requestCloseIfIdle\}/g) ?? []).length >= 3);
  assert.match(playbookScheduleModalSource, /description: description\.trim\(\),/);
});

test("Gateway settings sync resets and feeds a complete automation authority snapshot", () => {
  assert.match(settingsSyncSource, /resetAutomation\(\);\s*if \(!api\)/);
  assert.match(
    settingsSyncSource,
    /feedAutomationSnapshot\(\{\s*cron: automation\.automationCron,\s*hooks: automation\.automationHooks,\s*playbooks: automation\.automationPlaybooks,/,
  );
});
