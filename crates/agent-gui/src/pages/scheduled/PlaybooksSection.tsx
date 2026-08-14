import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Clock3,
  MessageCircle,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Wrench,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { ConfirmDeletePopover } from "../../components/ui/confirm-action-popover";
import { useLocale } from "../../i18n";
import {
  applyPlaybookOps,
  createCronFromPlaybook,
  type Playbook,
  type PlaybookDelivery,
  useAutomation,
} from "../../lib/automation";
import { buildModelOptions } from "../../lib/chat/page/chatPageHelpers";
import { workspaceProjectPathKey } from "../../lib/settings";
import { discoverSkills, isUserSelectableSkill, type SkillSummary } from "../../lib/skills";
import { SYSTEM_TOOL_OPTIONS } from "../../lib/tools/systemToolOptions";
import type { SettingsSectionProps } from "../settings/types";
import {
  type PlaybookCapabilityOption,
  type PlaybookFormData,
  PlaybookModal,
} from "./PlaybookModal";
import { type PlaybookScheduleData, PlaybookScheduleModal } from "./PlaybookScheduleModal";

type ModalState =
  | { open: false }
  | { open: true; mode: "add" }
  | { open: true; mode: "edit"; playbook: Playbook }
  | { open: true; mode: "schedule"; playbook: Playbook };

function deliveryLabel(t: (key: string) => string, playbook: Playbook) {
  if (!playbook.delivery) return null;
  const condition = t(
    `scheduled.playbooksDelivery${
      playbook.delivery.onlyOn === "always"
        ? "Always"
        : playbook.delivery.onlyOn === "success"
          ? "Success"
          : "Failure"
    }`,
  );
  return `${playbook.delivery.targetId} - ${condition}`;
}

function sameSelectedModel(left: Playbook["selectedModel"], right: Playbook["selectedModel"]) {
  return left.customProviderId === right.customProviderId && left.model === right.model;
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameDelivery(
  left: PlaybookDelivery | null | undefined,
  right: PlaybookDelivery | null | undefined,
) {
  if (!left || !right) return !left && !right;
  return (
    left.channel === right.channel &&
    left.targetId === right.targetId &&
    left.onlyOn === right.onlyOn
  );
}

export function buildPlaybookEditPatch(
  initial: Playbook,
  data: PlaybookFormData,
): Partial<PlaybookFormData> {
  const patch: Partial<PlaybookFormData> = {};

  if (initial.name !== data.name) patch.name = data.name;
  if (initial.description !== data.description) patch.description = data.description;
  if (initial.prompt !== data.prompt) patch.prompt = data.prompt;
  if (!sameSelectedModel(initial.selectedModel, data.selectedModel)) {
    patch.selectedModel = data.selectedModel;
  }
  if (initial.reasoning !== data.reasoning) patch.reasoning = data.reasoning;
  if (initial.workdir !== data.workdir) patch.workdir = data.workdir;
  if (!sameStringArray(initial.selectedSkills, data.selectedSkills)) {
    patch.selectedSkills = data.selectedSkills;
  }
  if (!sameStringArray(initial.selectedSystemTools, data.selectedSystemTools)) {
    patch.selectedSystemTools = data.selectedSystemTools;
  }
  if (!sameStringArray(initial.mcpServerIds, data.mcpServerIds)) {
    patch.mcpServerIds = data.mcpServerIds;
  }
  if (!sameDelivery(initial.delivery, data.delivery)) patch.delivery = data.delivery;

  return patch;
}

export function resolvePlaybookCapabilityCount(
  playbook: Playbook,
  defaults: {
    skills: readonly string[];
    systemTools: readonly string[];
    mcpServers: readonly string[];
  },
) {
  return (
    (playbook.selectedSkills ?? defaults.skills).length +
    (playbook.selectedSystemTools ?? defaults.systemTools).length +
    (playbook.mcpServerIds ?? defaults.mcpServers).length
  );
}

export function PlaybooksSection({ settings }: SettingsSectionProps) {
  const { t } = useLocale();
  const { playbooks, playbooksCapabilityKnown, supportsPlaybooks } = useAutomation();
  const [modal, setModal] = useState<ModalState>({ open: false });
  const [availableSkills, setAvailableSkills] = useState<SkillSummary[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void discoverSkills()
      .then((discovery) => {
        if (!cancelled) setAvailableSkills(discovery.skills.filter(isUserSelectableSkill));
      })
      .catch(() => {
        if (!cancelled) setAvailableSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const modelOptions = useMemo(
    () =>
      buildModelOptions(settings).map((option) => ({
        value: option.value,
        label: option.label,
        providerName: option.providerName,
        providerId: option.providerId,
        providerType: option.providerType,
      })),
    [settings],
  );

  const workspaceOptions = useMemo(() => {
    const excluded = new Set(
      [
        ...settings.system.archivedWorkspaceProjectPaths,
        ...settings.system.hiddenWorkspaceProjectPaths,
      ].map(workspaceProjectPathKey),
    );
    return settings.system.workspaceProjects
      .filter((project) => !excluded.has(workspaceProjectPathKey(project.path)))
      .map((project) => ({ path: project.path, name: project.name || project.path }));
  }, [settings]);

  const skillOptions = useMemo<PlaybookCapabilityOption[]>(
    () =>
      availableSkills.map((skill) => ({
        id: skill.name,
        label: skill.name,
        description: skill.description,
      })),
    [availableSkills],
  );

  const systemToolOptions = useMemo<PlaybookCapabilityOption[]>(
    () =>
      SYSTEM_TOOL_OPTIONS.filter((option) => option.runtimeScopes.includes("cron_auto_prompt")).map(
        (option) => ({
          id: option.id,
          label: option.label,
          description: option.description,
        }),
      ),
    [],
  );

  const defaultMcpServers = useMemo(
    () => settings.mcp.servers.filter((server) => server.enabled).map((server) => server.id),
    [settings.mcp.servers],
  );

  const mcpServerOptions = useMemo<PlaybookCapabilityOption[]>(
    () =>
      settings.mcp.servers
        .filter((server) => server.enabled)
        .map((server) => ({
          id: server.id,
          label: server.id,
          description:
            server.transport === "stdio"
              ? [server.command, ...server.args].filter(Boolean).join(" ")
              : server.url,
        })),
    [settings.mcp.servers],
  );

  function runAction(action: () => Promise<unknown>) {
    setActionError(null);
    void action().catch((error) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  }

  async function handleAdd(data: PlaybookFormData) {
    setActionError(null);
    await applyPlaybookOps([{ op: "create", item: data }]);
    setModal({ open: false });
  }

  async function handleEdit(data: PlaybookFormData) {
    if (!modal.open || modal.mode !== "edit") return;
    setActionError(null);
    const patch = buildPlaybookEditPatch(modal.playbook, data);
    if (Object.keys(patch).length === 0) {
      setModal({ open: false });
      return;
    }
    await applyPlaybookOps([{ op: "update", id: modal.playbook.id, patch }]);
    setModal({ open: false });
  }

  async function handleSchedule(data: PlaybookScheduleData) {
    if (!modal.open || modal.mode !== "schedule") return;
    setActionError(null);
    await createCronFromPlaybook({ playbookId: modal.playbook.id, ...data });
    setModal({ open: false });
  }

  async function pickWorkdir(initialWorkdir: string) {
    return await invoke<string | null>("system_pick_folder", {
      initial_workdir: initialWorkdir || undefined,
    });
  }

  const deliveredCount = playbooks.items.filter((playbook) => playbook.delivery).length;

  if (!playbooksCapabilityKnown || !supportsPlaybooks) {
    return (
      <div
        role="status"
        className="flex min-h-48 items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/20 px-6 py-12 text-center"
      >
        <div className="max-w-md">
          <BookOpen className="mx-auto h-8 w-8 text-muted-foreground/35" />
          <p className="mt-3 text-sm font-medium text-muted-foreground">
            {t(
              playbooksCapabilityKnown
                ? "scheduled.playbooksUnsupported"
                : "scheduled.playbooksLoading",
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="settings-section-heading-row flex items-center justify-between gap-4">
        <div className="settings-section-title-group flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/10">
            <BookOpen className="h-[18px] w-[18px] text-violet-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("scheduled.playbooksTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("scheduled.playbooksDesc")}</p>
          </div>
        </div>
        <div className="settings-section-actions flex items-center gap-2">
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
            <span className="tabular-nums font-medium text-foreground">
              {playbooks.items.length}
            </span>
            {t("scheduled.playbooksCount")}
            <span className="text-border">|</span>
            <MessageCircle className="h-3 w-3 text-emerald-500" />
            <span className="tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
              {deliveredCount}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setModal({ open: true, mode: "add" })}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("scheduled.playbooksAdd")}
          </Button>
        </div>
      </div>

      {actionError ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{actionError}</span>
        </div>
      ) : null}

      {playbooks.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 bg-muted/20 py-12 text-center">
          <BookOpen className="mx-auto h-8 w-8 text-muted-foreground/30" />
          <p className="mt-3 text-sm font-medium text-muted-foreground">
            {t("scheduled.playbooksEmpty")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            {t("scheduled.playbooksEmptyDesc")}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {playbooks.items.map((playbook) => {
            const capabilityCount = resolvePlaybookCapabilityCount(playbook, {
              skills: settings.skills.selected,
              systemTools: settings.system.selectedSystemTools,
              mcpServers: defaultMcpServers,
            });
            const delivery = deliveryLabel(t, playbook);
            return (
              <article
                key={playbook.id}
                className="group flex min-h-44 flex-col rounded-xl border border-border/60 bg-card p-4 transition-all hover:border-border hover:shadow-sm"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
                    <Sparkles className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {playbook.name}
                      </h4>
                      <span className="shrink-0 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">
                        {playbook.selectedModel.model}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">
                      {playbook.description || t("scheduled.playbooksNoDescription")}
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground">
                    <Wrench className="h-3 w-3" />
                    {capabilityCount} {t("scheduled.playbooksCapabilitiesShort")}
                  </span>
                  {playbook.workdir ? (
                    <span
                      className="max-w-52 truncate rounded-full bg-amber-500/10 px-2 py-1 font-mono text-[10px] text-amber-700 dark:text-amber-300"
                      title={playbook.workdir}
                    >
                      {playbook.workdir}
                    </span>
                  ) : null}
                  {delivery ? (
                    <span
                      className="inline-flex max-w-64 items-center gap-1 truncate rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-700 dark:text-emerald-300"
                      title={delivery}
                    >
                      <MessageCircle className="h-3 w-3 shrink-0" />
                      <span className="truncate">{delivery}</span>
                    </span>
                  ) : null}
                </div>

                <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/30 pt-3">
                  <p className="line-clamp-1 min-w-0 flex-1 text-[11px] text-muted-foreground/70">
                    {playbook.prompt}
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 px-2.5"
                      title={t("scheduled.playbooksSchedule")}
                      onClick={() => setModal({ open: true, mode: "schedule", playbook })}
                    >
                      <Clock3 className="h-3.5 w-3.5" />
                      {t("scheduled.playbooksSchedule")}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setModal({ open: true, mode: "edit", playbook })}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                      title={t("scheduled.playbooksEdit")}
                      aria-label={t("scheduled.playbooksEdit")}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <ConfirmDeletePopover
                      name={playbook.name}
                      onConfirm={() =>
                        runAction(() => applyPlaybookOps([{ op: "delete", id: playbook.id }]))
                      }
                    >
                      {(open) => (
                        <button
                          type="button"
                          onClick={open}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          title={t("scheduled.playbooksDelete")}
                          aria-label={t("scheduled.playbooksDelete")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </ConfirmDeletePopover>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {modal.open && (modal.mode === "add" || modal.mode === "edit") ? (
        <PlaybookModal
          mode={modal.mode}
          initialData={modal.mode === "edit" ? modal.playbook : undefined}
          defaultModel={settings.selectedModel}
          defaultReasoning={settings.chatRuntimeControls.reasoning}
          defaultWorkdir={settings.system.workdir}
          defaultSkills={settings.skills.selected}
          defaultSystemTools={settings.system.selectedSystemTools}
          defaultMcpServers={defaultMcpServers}
          modelOptions={modelOptions}
          workspaceOptions={workspaceOptions}
          skillOptions={skillOptions}
          systemToolOptions={systemToolOptions}
          mcpServerOptions={mcpServerOptions}
          onPickWorkdir={pickWorkdir}
          onSave={modal.mode === "add" ? handleAdd : handleEdit}
          onClose={() => setModal({ open: false })}
        />
      ) : null}

      {modal.open && modal.mode === "schedule" ? (
        <PlaybookScheduleModal
          playbook={modal.playbook}
          onSave={handleSchedule}
          onClose={() => setModal({ open: false })}
        />
      ) : null}
    </div>
  );
}
