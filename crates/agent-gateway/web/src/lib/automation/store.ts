// Client mirror of the desktop-authoritative automation store. State only
// ever changes by feeding authoritative snapshots (initial fetch, change
// events, apply responses); there is no whole-list write-back path.

import { useSyncExternalStore } from "react";

import { backend } from "./backend";
import type {
  AutomationOp,
  AutomationSnapshot,
  CreatePlaybookCronInput,
  CronSnapshot,
  HooksSnapshot,
  PlaybooksSnapshot,
} from "./types";

export type AutomationState = {
  ready: boolean;
  playbooksCapabilityKnown: boolean;
  supportsPlaybooks: boolean;
  cron: CronSnapshot;
  hooks: HooksSnapshot;
  playbooks: PlaybooksSnapshot;
};

const EMPTY_STATE: AutomationState = {
  ready: false,
  playbooksCapabilityKnown: false,
  supportsPlaybooks: false,
  cron: { revision: 0, tasks: [] },
  hooks: { revision: 0, hooks: [] },
  playbooks: { revision: 0, items: [] },
};

const MAX_APPLY_ATTEMPTS = 3;

let state: AutomationState = EMPTY_STATE;
const listeners = new Set<() => void>();
let initPromise: Promise<void> | null = null;
let backendUnsubscribe: (() => void) | null = null;
let authorityGeneration = 0;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function getAutomationState(): AutomationState {
  return state;
}

export function subscribeAutomation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Start a new desktop-authority generation. The first snapshot from the new
 * authority must be allowed to replace higher revisions cached from the old
 * one, while late events and requests from the old generation are ignored.
 */
export function resetAutomation() {
  authorityGeneration += 1;
  backendUnsubscribe?.();
  backendUnsubscribe = null;
  initPromise = null;
  state = {
    ready: false,
    playbooksCapabilityKnown: false,
    supportsPlaybooks: false,
    cron: { revision: 0, tasks: [] },
    hooks: { revision: 0, hooks: [] },
    playbooks: { revision: 0, items: [] },
  };
  emit();
}

function assertCurrentAuthority(generation: number) {
  if (generation !== authorityGeneration) {
    throw new Error("Automation authority changed while the request was in flight.");
  }
}

export function feedCronSnapshot(snapshot: CronSnapshot) {
  if (state.ready && snapshot.revision < state.cron.revision) return;
  state = { ...state, ready: true, cron: snapshot };
  emit();
}

export function feedHooksSnapshot(snapshot: HooksSnapshot) {
  if (state.ready && snapshot.revision < state.hooks.revision) return;
  state = { ...state, ready: true, hooks: snapshot };
  emit();
}

export function feedPlaybooksSnapshot(snapshot: PlaybooksSnapshot) {
  if (state.ready && snapshot.revision < state.playbooks.revision) return;
  state = {
    ...state,
    ready: true,
    playbooksCapabilityKnown: true,
    supportsPlaybooks: true,
    playbooks: snapshot,
  };
  emit();
}

export function feedAutomationSnapshot(snapshot: AutomationSnapshot) {
  feedCronSnapshot(snapshot.cron);
  feedHooksSnapshot(snapshot.hooks);
  if (snapshot.playbooks) {
    feedPlaybooksSnapshot(snapshot.playbooks);
  } else {
    state = {
      ...state,
      playbooksCapabilityKnown: true,
      supportsPlaybooks: false,
      playbooks: { revision: 0, items: [] },
    };
    emit();
  }
}

/** Idempotent: subscribes to backend change events and loads the initial snapshot. */
export function initAutomation(): Promise<void> {
  if (!initPromise) {
    const generation = authorityGeneration;
    let unsubscribe: (() => void) | null = null;
    const run = (async () => {
      unsubscribe = backend.subscribe({
        onCron: (snapshot) => {
          if (generation === authorityGeneration) feedCronSnapshot(snapshot);
        },
        onHooks: (snapshot) => {
          if (generation === authorityGeneration) feedHooksSnapshot(snapshot);
        },
        onPlaybooks: (snapshot) => {
          if (generation === authorityGeneration) feedPlaybooksSnapshot(snapshot);
        },
      });
      if (generation !== authorityGeneration) {
        unsubscribe();
        return;
      }
      backendUnsubscribe = unsubscribe;
      const snapshot = await backend.fetchSnapshot();
      if (generation === authorityGeneration) feedAutomationSnapshot(snapshot);
    })();
    const guardedRun = run.catch((error) => {
      if (generation === authorityGeneration) {
        if (backendUnsubscribe === unsubscribe) {
          unsubscribe?.();
          backendUnsubscribe = null;
        }
        if (initPromise === guardedRun) initPromise = null;
      }
      throw error;
    });
    initPromise = guardedRun;
  }
  return initPromise;
}

export async function refreshAutomationSnapshot(): Promise<void> {
  const generation = authorityGeneration;
  const snapshot = await backend.fetchSnapshot();
  if (generation === authorityGeneration) feedAutomationSnapshot(snapshot);
}

export class AutomationConflictError extends Error {
  constructor() {
    super("Automation state changed concurrently; retry with the refreshed snapshot.");
    this.name = "AutomationConflictError";
  }
}

export class AutomationUnsupportedError extends Error {
  constructor() {
    super("Playbooks require a newer desktop version.");
    this.name = "AutomationUnsupportedError";
  }
}

/**
 * Apply ops with optimistic concurrency: on a revision conflict the local
 * mirror is refreshed from the returned snapshot and the ops are rebased
 * (they are field-level patches, so a plain retry is safe).
 */
export async function applyCronOps(ops: AutomationOp[]): Promise<CronSnapshot> {
  const generation = authorityGeneration;
  await initAutomation();
  assertCurrentAuthority(generation);
  for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt += 1) {
    const response = await backend.cronApply({
      baseRevision: state.cron.revision,
      ops,
    });
    assertCurrentAuthority(generation);
    feedCronSnapshot(response.cron);
    if (response.status === "ok") {
      return response.cron;
    }
  }
  throw new AutomationConflictError();
}

export async function applyHookOps(ops: AutomationOp[]): Promise<HooksSnapshot> {
  const generation = authorityGeneration;
  await initAutomation();
  assertCurrentAuthority(generation);
  for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt += 1) {
    const response = await backend.hooksApply({
      baseRevision: state.hooks.revision,
      ops,
    });
    assertCurrentAuthority(generation);
    feedHooksSnapshot(response.hooks);
    if (response.status === "ok") {
      return response.hooks;
    }
  }
  throw new AutomationConflictError();
}

export async function applyPlaybookOps(ops: AutomationOp[]): Promise<PlaybooksSnapshot> {
  const generation = authorityGeneration;
  await initAutomation();
  assertCurrentAuthority(generation);
  if (!state.supportsPlaybooks) throw new AutomationUnsupportedError();
  for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt += 1) {
    const response = await backend.playbooksApply({
      baseRevision: state.playbooks.revision,
      ops,
    });
    assertCurrentAuthority(generation);
    feedPlaybooksSnapshot(response.playbooks);
    if (response.status === "ok") {
      return response.playbooks;
    }
  }
  throw new AutomationConflictError();
}

/** Materialize a Playbook into a prompt cron task, rebasing Cron conflicts. */
export async function createCronFromPlaybook(
  input: Omit<CreatePlaybookCronInput, "cronBaseRevision">,
): Promise<CronSnapshot> {
  const generation = authorityGeneration;
  await initAutomation();
  assertCurrentAuthority(generation);
  if (!state.supportsPlaybooks) throw new AutomationUnsupportedError();
  for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt += 1) {
    const response = await backend.createPlaybookCron({
      ...input,
      cronBaseRevision: state.cron.revision,
    });
    assertCurrentAuthority(generation);
    feedCronSnapshot(response.cron);
    if (response.status === "ok") {
      return response.cron;
    }
  }
  throw new AutomationConflictError();
}

export function useAutomation(): AutomationState {
  return useSyncExternalStore(subscribeAutomation, getAutomationState, getAutomationState);
}

export const listCronRuns = backend.listRuns;
export const clearCronRuns = backend.clearRuns;
export const runCronNow = backend.runNow;
export const validateCronExpression = backend.validateCronExpression;
