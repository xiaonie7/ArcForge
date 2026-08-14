import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const invokeCalls = [];
const snapshot = {
  cron: { revision: 7, tasks: [] },
  hooks: { revision: 2, hooks: [] },
  playbooks: { revision: 4, items: [] },
};

const loader = createTsModuleLoader({
  mocks: {
    react: {
      useSyncExternalStore() {
        return undefined;
      },
    },
    "@tauri-apps/api/core": {
      async invoke(command, args) {
        invokeCalls.push({ command, args });
        if (command === "automation_snapshot") return snapshot;
        if (command === "automation_playbooks_apply") {
          return { status: "ok", playbooks: { revision: 5, items: [] } };
        }
        if (command === "automation_playbook_create_cron") {
          return { status: "ok", cron: { revision: 8, tasks: [] } };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    },
    "@tauri-apps/api/event": {
      async listen() {
        return () => {};
      },
    },
  },
});

const { backend } = loader.loadModule("src/lib/automation/backend.ts");
const { applyPlaybookOps, createCronFromPlaybook, getAutomationState } = loader.loadModule(
  "src/lib/automation/store.ts",
);
const uiLoader = createTsModuleLoader();
const { buildPlaybookEditPatch, resolvePlaybookCapabilityCount } = uiLoader.loadModule(
  "src/pages/scheduled/PlaybooksSection.tsx",
);
const { isPlaybookDeliveryTargetValid } = uiLoader.loadModule(
  "src/pages/scheduled/PlaybookModal.tsx",
);

const typesSource = readFileSync(
  new URL("../../src/lib/automation/types.ts", import.meta.url),
  "utf8",
);
const scheduledPageSource = readFileSync(
  new URL("../../src/pages/scheduled/ScheduledPage.tsx", import.meta.url),
  "utf8",
);
const playbookModalSource = readFileSync(
  new URL("../../src/pages/scheduled/PlaybookModal.tsx", import.meta.url),
  "utf8",
);
const playbooksSectionSource = readFileSync(
  new URL("../../src/pages/scheduled/PlaybooksSection.tsx", import.meta.url),
  "utf8",
);
const playbookScheduleModalSource = readFileSync(
  new URL("../../src/pages/scheduled/PlaybookScheduleModal.tsx", import.meta.url),
  "utf8",
);
const translationsSource = readFileSync(
  new URL("../../src/i18n/config.ts", import.meta.url),
  "utf8",
);

test.beforeEach(() => {
  invokeCalls.length = 0;
});

test("Playbook apply uses the desktop command and current playbook revision", async () => {
  const ops = [{ op: "delete", id: "playbook-1" }];
  await applyPlaybookOps(ops);

  assert.deepEqual(invokeCalls, [
    { command: "automation_snapshot", args: undefined },
    {
      command: "automation_playbooks_apply",
      args: { input: { baseRevision: 4, ops } },
    },
  ]);
  assert.equal(getAutomationState().supportsPlaybooks, true);
});

test("Creating a Cron task from a Playbook uses the current Cron revision", async () => {
  await createCronFromPlaybook({
    playbookId: "playbook-1",
    cron: "0 9 * * 1",
    enabled: true,
  });

  assert.deepEqual(invokeCalls, [
    {
      command: "automation_playbook_create_cron",
      args: {
        input: {
          playbookId: "playbook-1",
          cron: "0 9 * * 1",
          enabled: true,
          cronBaseRevision: 7,
        },
      },
    },
  ]);
});

test("Playbook backend exposes direct transport helpers", async () => {
  const input = { baseRevision: 5, ops: [] };
  await backend.playbooksApply(input);

  assert.deepEqual(invokeCalls, [
    { command: "automation_playbooks_apply", args: { input } },
  ]);
});

test("Playbook wire contract includes capabilities and WeCom delivery", () => {
  assert.match(typesSource, /export type PlaybooksSnapshot = \{\s*revision: number;\s*items: Playbook\[\];/);
  assert.match(typesSource, /channel: "wecom";\s*targetId: string;\s*onlyOn: PlaybookDeliveryOnlyOn;/);
  assert.match(typesSource, /selectedSkills\?: string\[\];/);
  assert.match(typesSource, /selectedSystemTools\?: string\[\];/);
  assert.match(typesSource, /mcpServerIds\?: string\[\];/);
  assert.match(typesSource, /cronBaseRevision: number;/);
});

test("Scheduled opens on Playbooks and the editor preserves inherited workdir", () => {
  assert.match(scheduledPageSource, /type ScheduledView = "playbooks" \| "cron" \| "hooks"/);
  assert.match(scheduledPageSource, /useState<ScheduledView>\("playbooks"\)/);
  assert.match(
    scheduledPageSource,
    /const effectiveView =[\s\S]*?playbooksCapabilityKnown && !supportsPlaybooks && view === "playbooks" \? "cron" : view/,
  );
  assert.match(scheduledPageSource, /const active = effectiveView === item\.id/);
  assert.match(scheduledPageSource, /key=\{effectiveView\}/);
  assert.match(scheduledPageSource, /<PlaybooksSection settings=\{settings\}/);
  assert.match(
    playbooksSectionSource,
    /if \(!playbooksCapabilityKnown \|\| !supportsPlaybooks\)/,
  );
  assert.match(playbookModalSource, /defaultWorkdir: string;/);
  assert.match(
    playbookModalSource,
    /mode === "edit" \? \(initialData\?\.workdir \?\? ""\) : defaultWorkdir/,
  );
  assert.match(playbooksSectionSource, /defaultWorkdir=\{settings\.system\.workdir\}/);
});

test("Playbook editor requires a model and validates WeCom recipient policy", () => {
  assert.match(playbookModalSource, /if \(!parsedModel\)/);
  assert.match(playbookModalSource, /deliveryEnabled && !deliveryTargetId\.trim\(\)/);
  assert.match(playbookModalSource, /targetId: deliveryTargetId\.trim\(\)/);
  assert.match(playbookModalSource, /onlyOn: deliveryOnlyOn/);
  assert.match(playbookModalSource, /Array\.from\(normalized\)\.length <= DELIVERY_TARGET_MAX_CHARACTERS/);
  assert.match(playbookModalSource, /function hasControlCharacters/);
  assert.match(playbookModalSource, /maxLength=\{256\}/);
  assert.match(playbookModalSource, /model && deliveryTargetValid/);
  assert.equal(isPlaybookDeliveryTargetValid("room-1"), true);
  assert.equal(isPlaybookDeliveryTargetValid("😀".repeat(256)), true);
  assert.equal(isPlaybookDeliveryTargetValid("😀".repeat(257)), false);
  assert.equal(isPlaybookDeliveryTargetValid("room\u0000id"), false);
  assert.match(playbookModalSource, /: null,/);
  assert.match(
    playbooksSectionSource,
    /settings\.mcp\.servers\s*\.filter\(\(server\) => server\.enabled\)/,
  );
});

test("Playbook edits send only fields changed from the opened snapshot", () => {
  const initial = {
    id: "playbook-1",
    name: "Weekly report",
    description: "Summarize the week",
    prompt: "Build the report",
    selectedModel: { customProviderId: "openai", model: "gpt-5" },
    createdAt: 10,
    updatedAt: 20,
  };
  const unchangedForm = {
    name: initial.name,
    description: initial.description,
    prompt: initial.prompt,
    selectedModel: { ...initial.selectedModel },
    reasoning: undefined,
    workdir: undefined,
    selectedSkills: undefined,
    selectedSystemTools: undefined,
    mcpServerIds: undefined,
    delivery: null,
  };

  assert.deepEqual(buildPlaybookEditPatch(initial, unchangedForm), {});
  assert.deepEqual(
    buildPlaybookEditPatch(
      {
        ...initial,
        delivery: { channel: "wecom", targetId: "room-1", onlyOn: "success" },
      },
      unchangedForm,
    ),
    { delivery: null },
  );
  assert.match(playbooksSectionSource, /if \(Object\.keys\(patch\)\.length === 0\)/);
});

test("Playbook editor keeps untouched optional settings inherited", () => {
  for (const [field, touched] of [
    ["reasoning", "reasoningTouched"],
    ["workdir", "workdirTouched"],
    ["selectedSkills", "selectedSkillsTouched"],
    ["selectedSystemTools", "selectedSystemToolsTouched"],
    ["mcpServerIds", "mcpServerIdsTouched"],
  ]) {
    assert.match(
      playbookModalSource,
      new RegExp(`mode === "edit" && !${touched}[\\s\\S]*?initialData\\?\\.${field}`),
      field,
    );
  }
  assert.match(playbookModalSource, /initialData\?\.selectedSkills \?\? defaultSkills/);
  assert.match(playbookModalSource, /initialData\?\.selectedSystemTools \?\? defaultSystemTools/);
  assert.match(playbookModalSource, /initialData\?\.mcpServerIds \?\? defaultMcpServers/);
});

test("Playbook capability badges resolve current inherited settings", () => {
  const playbook = {
    id: "playbook-1",
    name: "Inherited",
    description: "",
    prompt: "Run",
    selectedModel: { customProviderId: "openai", model: "gpt-5" },
    createdAt: 10,
    updatedAt: 20,
  };
  const defaults = {
    skills: ["skill-a", "skill-b"],
    systemTools: ["shell"],
    mcpServers: ["repo", "docs"],
  };

  assert.equal(resolvePlaybookCapabilityCount(playbook, defaults), 5);
  assert.equal(
    resolvePlaybookCapabilityCount(
      {
        ...playbook,
        selectedSkills: [],
        selectedSystemTools: [],
        mcpServerIds: [],
      },
      defaults,
    ),
    0,
  );
  assert.match(playbooksSectionSource, /defaultMcpServers=\{defaultMcpServers\}/);
});

test("Playbook modals cannot close while a save is pending", () => {
  for (const source of [playbookModalSource, playbookScheduleModalSource]) {
    assert.match(source, /const savingRef = useRef\(false\)/);
    assert.match(source, /if \(savingRef\.current\) return;/);
    assert.equal(source.split("disabled={isSaving}").length - 1, 3);
    assert.equal(source.split("onClick={requestModalClose}").length - 1, 3);
  }
});

test("Scheduling a Playbook can explicitly clear its description", () => {
  assert.match(playbookScheduleModalSource, /description: description\.trim\(\),/);
  assert.doesNotMatch(playbookScheduleModalSource, /description: description\.trim\(\) \|\| undefined/);
});

test("desktop Playbook editor keeps stale capability references visible for cleanup", () => {
  assert.match(playbookModalSource, /function withMissingOptions/);
  assert.match(playbookModalSource, /options=\{displayedSkills\}/);
  assert.match(playbookModalSource, /options=\{displayedSystemTools\}/);
  assert.match(playbookModalSource, /options=\{displayedMcpServers\}/);
  assert.match(playbookModalSource, /options=\{effectiveModelOptions\}/);
});

test("Playbook labels are present in both desktop locales", () => {
  for (const key of [
    "scheduled.playbooksTab",
    "scheduled.playbooksTitle",
    "scheduled.playbooksLoading",
    "scheduled.playbooksUnsupported",
    "scheduled.playbooksDeliveryTarget",
    "scheduled.playbooksDeliveryTargetInvalid",
    "scheduled.playbooksDeliveryAlways",
    "scheduled.playbooksDeliverySuccess",
    "scheduled.playbooksDeliveryFailure",
    "scheduled.playbooksCreateSchedule",
  ]) {
    assert.equal(translationsSource.split(`\"${key}\"`).length - 1, 2, key);
  }
});
