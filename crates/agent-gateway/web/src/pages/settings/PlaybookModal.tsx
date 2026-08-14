import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, FolderOpen, Sparkles, X } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useLocale } from "../../i18n";
import type { Playbook, PlaybookDelivery, SelectedModelRef } from "../../lib/automation";
import { parseModelValue, toModelValue } from "../../lib/providers/llm";
import { useModalMotion } from "../../lib/shared/modalMotion";
import { ModelPicker, type ModelPickerOption } from "./modelPicker";
import { AgentActivationSwitch } from "./shared";

const FOLLOW_ACTIVE_WORKSPACE = "__follow-active_workspace__";
const CUSTOM_WORKSPACE = "__custom_workspace__";
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MAX_WECOM_TARGET_CHARACTERS = 256;

export type PlaybookCapabilityOption = { id: string; label: string; description?: string };

export type PlaybookFormData = Omit<
  Playbook,
  "id" | "createdAt" | "updatedAt" | "workdir" | "delivery"
> & {
  workdir: string;
  delivery: PlaybookDelivery | null;
};

export type PlaybookFormField = keyof PlaybookFormData;

type PlaybookModalProps = {
  mode: "add" | "edit";
  initialData?: Playbook;
  defaultModel?: SelectedModelRef;
  defaultReasoning: string;
  defaultSkills: string[];
  defaultSystemTools: string[];
  defaultMcpServers: string[];
  modelOptions: ModelPickerOption[];
  workspaceOptions: Array<{ path: string; name: string }>;
  defaultWorkdir: string;
  skillOptions: PlaybookCapabilityOption[];
  systemToolOptions: PlaybookCapabilityOption[];
  mcpServerOptions: PlaybookCapabilityOption[];
  onPickWorkdir?: (initialWorkdir: string) => Promise<string | null>;
  onSave: (
    data: PlaybookFormData,
    dirtyFields: readonly PlaybookFormField[],
  ) => void | Promise<void>;
  onClose: () => void;
};

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function isValidDeliveryTarget(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    Array.from(normalized).length <= MAX_WECOM_TARGET_CHARACTERS &&
    !hasControlCharacter(normalized)
  );
}

function withMissingOptions(
  options: PlaybookCapabilityOption[],
  selected: string[],
): PlaybookCapabilityOption[] {
  const known = new Set(options.map((option) => option.id));
  return [...options, ...selected.filter((id) => !known.has(id)).map((id) => ({ id, label: id }))];
}

function CapabilityGroup(props: {
  title: string;
  emptyLabel: string;
  options: PlaybookCapabilityOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { title, emptyLabel, options, selected, onChange } = props;
  const selectedSet = new Set(selected);
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-xs font-medium text-muted-foreground">{title}</legend>
      <div className="max-h-36 overflow-y-auto rounded-lg border border-border/60 bg-muted/15 p-2">
        {options.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground/70">{emptyLabel}</p>
        ) : (
          <div className="space-y-1">
            {options.map((option) => {
              const checked = selectedSet.has(option.id);
              return (
                <label
                  key={option.id}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/60"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      onChange(
                        checked
                          ? selected.filter((id) => id !== option.id)
                          : [...selected, option.id],
                      )
                    }
                    className="peer sr-only"
                  />
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border bg-background peer-focus-visible:ring-2 peer-focus-visible:ring-primary/30 peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground">
                    {checked ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span className="min-w-0 truncate">{option.label}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </fieldset>
  );
}

export function PlaybookModal(props: PlaybookModalProps) {
  const {
    initialData,
    defaultModel,
    defaultReasoning,
    defaultSkills,
    defaultSystemTools,
    defaultMcpServers,
    modelOptions,
    workspaceOptions,
    defaultWorkdir,
    skillOptions,
    systemToolOptions,
    mcpServerOptions,
    onPickWorkdir,
    onSave,
    onClose,
  } = props;
  const { t } = useLocale();
  const initialModel = initialData?.selectedModel ?? defaultModel;
  const initialWorkdir = initialData ? (initialData.workdir ?? "") : defaultWorkdir;
  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [prompt, setPrompt] = useState(initialData?.prompt ?? "");
  const [modelValue, setModelValue] = useState(() =>
    initialModel ? toModelValue(initialModel.customProviderId, initialModel.model) : "",
  );
  const [reasoning, setReasoning] = useState(
    initialData?.reasoning || defaultReasoning || "medium",
  );
  const [workdir, setWorkdir] = useState(initialWorkdir);
  const [customWorkdir, setCustomWorkdir] = useState(() => {
    const initial = initialWorkdir.trim();
    return Boolean(initial && !workspaceOptions.some((option) => option.path === initial));
  });
  const [selectedSkills, setSelectedSkills] = useState(
    initialData?.selectedSkills ?? defaultSkills,
  );
  const [selectedSystemTools, setSelectedSystemTools] = useState(
    initialData?.selectedSystemTools ?? defaultSystemTools,
  );
  const [mcpServerIds, setMcpServerIds] = useState(initialData?.mcpServerIds ?? defaultMcpServers);
  const [deliveryEnabled, setDeliveryEnabled] = useState(Boolean(initialData?.delivery));
  const [deliveryTarget, setDeliveryTarget] = useState(initialData?.delivery?.targetId ?? "");
  const [deliveryOnlyOn, setDeliveryOnlyOn] = useState<"always" | "success" | "failure">(
    initialData?.delivery?.onlyOn ?? "always",
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const dirtyFieldsRef = useRef(new Set<PlaybookFormField>());
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);
  const parsedModel = parseModelValue(modelValue);
  const deliveryTargetInvalid =
    deliveryEnabled && deliveryTarget.trim().length > 0 && !isValidDeliveryTarget(deliveryTarget);
  const formReady = Boolean(
    name.trim() &&
      prompt.trim() &&
      parsedModel &&
      (!deliveryEnabled || isValidDeliveryTarget(deliveryTarget)),
  );

  function markDirty(field: PlaybookFormField) {
    dirtyFieldsRef.current.add(field);
  }

  function requestCloseIfIdle() {
    if (!savingRef.current) requestClose();
  }

  const effectiveModelOptions = useMemo(() => {
    if (!modelValue || modelOptions.some((option) => option.value === modelValue)) {
      return modelOptions;
    }
    const parsed = parseModelValue(modelValue);
    return parsed
      ? [
          ...modelOptions,
          {
            value: modelValue,
            label: parsed.model,
            providerName: parsed.customProviderId,
            providerId: parsed.customProviderId,
          },
        ]
      : modelOptions;
  }, [modelOptions, modelValue]);

  const displayedSkills = useMemo(
    () => withMissingOptions(skillOptions, selectedSkills),
    [selectedSkills, skillOptions],
  );
  const displayedSystemTools = useMemo(
    () => withMissingOptions(systemToolOptions, selectedSystemTools),
    [selectedSystemTools, systemToolOptions],
  );
  const displayedMcp = useMemo(
    () => withMissingOptions(mcpServerOptions, mcpServerIds),
    [mcpServerOptions, mcpServerIds],
  );

  async function browseWorkdir() {
    if (!onPickWorkdir) return;
    const picked = await onPickWorkdir(workdir);
    if (picked) {
      markDirty("workdir");
      setCustomWorkdir(true);
      setWorkdir(picked);
    }
  }

  async function handleSave() {
    if (savingRef.current || isClosing) return;
    setFormError(null);
    if (!name.trim()) {
      setFormError(t("scheduled.playbooksNameRequired"));
      return;
    }
    if (!prompt.trim()) {
      setFormError(t("scheduled.playbooksPromptRequired"));
      return;
    }
    if (!parsedModel) {
      setFormError(t("scheduled.playbooksModelRequired"));
      return;
    }
    if (deliveryEnabled && !deliveryTarget.trim()) {
      setFormError(t("scheduled.playbooksDeliveryTargetRequired"));
      return;
    }
    if (deliveryEnabled && !isValidDeliveryTarget(deliveryTarget)) {
      setFormError(t("scheduled.playbooksDeliveryTargetInvalid"));
      return;
    }

    try {
      savingRef.current = true;
      setSaving(true);
      await onSave(
        {
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
          selectedModel: parsedModel,
          reasoning,
          // Explicit clear values survive JSON serialization in update patches.
          workdir: workdir.trim(),
          selectedSkills,
          selectedSystemTools,
          mcpServerIds,
          delivery: deliveryEnabled
            ? { channel: "wecom", targetId: deliveryTarget.trim(), onlyOn: deliveryOnlyOn }
            : null,
        },
        Array.from(dirtyFieldsRef.current),
      );
      requestClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("settings.cancel")}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        disabled={saving}
        onClick={requestCloseIfIdle}
      />
      <div
        data-state={isClosing ? "closing" : "open"}
        className="settings-modal-panel relative z-10 flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">
              {props.mode === "edit"
                ? t("scheduled.playbooksModalEdit")
                : t("scheduled.playbooksModalAdd")}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("scheduled.playbooksModalHint")}
            </p>
          </div>
          <button
            type="button"
            onClick={requestCloseIfIdle}
            disabled={saving}
            title={t("settings.cancel")}
            aria-label={t("settings.cancel")}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <section className="space-y-4">
            <h3 className="text-sm font-semibold">{t("scheduled.playbooksBasic")}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="playbook-name">{t("scheduled.playbooksName")}</Label>
                <Input
                  id="playbook-name"
                  value={name}
                  onChange={(event) => {
                    markDirty("name");
                    setFormError(null);
                    setName(event.currentTarget.value);
                  }}
                  placeholder={t("scheduled.playbooksNamePlaceholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="playbook-description">{t("scheduled.playbooksDescription")}</Label>
                <Input
                  id="playbook-description"
                  value={description}
                  onChange={(event) => {
                    markDirty("description");
                    setFormError(null);
                    setDescription(event.currentTarget.value);
                  }}
                  placeholder={t("scheduled.playbooksDescriptionPlaceholder")}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="playbook-prompt">{t("scheduled.playbooksPrompt")}</Label>
              <Textarea
                id="playbook-prompt"
                value={prompt}
                onChange={(event) => {
                  markDirty("prompt");
                  setFormError(null);
                  setPrompt(event.currentTarget.value);
                }}
                placeholder={t("scheduled.playbooksPromptPlaceholder")}
                className="min-h-36 resize-y font-mono leading-relaxed"
              />
            </div>
          </section>

          <section className="space-y-4 border-t border-border/40 pt-5">
            <h3 className="text-sm font-semibold">{t("scheduled.playbooksExecution")}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("scheduled.playbooksModel")}</Label>
                <ModelPicker
                  options={effectiveModelOptions}
                  value={modelValue}
                  onChange={(value) => {
                    markDirty("selectedModel");
                    setFormError(null);
                    setModelValue(value);
                  }}
                  placeholder={t("scheduled.playbooksModelPlaceholder")}
                  ariaLabel={t("scheduled.playbooksModel")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("scheduled.playbooksReasoning")}</Label>
                <Select
                  value={reasoning}
                  onValueChange={(value) => {
                    markDirty("reasoning");
                    setReasoning(value);
                  }}
                >
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REASONING_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {t(`settings.reasoning.${level}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("scheduled.playbooksWorkdir")}</Label>
              <div className="flex gap-2">
                <Select
                  value={customWorkdir ? CUSTOM_WORKSPACE : workdir || FOLLOW_ACTIVE_WORKSPACE}
                  onValueChange={(value) => {
                    markDirty("workdir");
                    if (value === FOLLOW_ACTIVE_WORKSPACE) {
                      setCustomWorkdir(false);
                      setWorkdir("");
                    } else if (value === CUSTOM_WORKSPACE) {
                      setCustomWorkdir(true);
                    } else {
                      setCustomWorkdir(false);
                      setWorkdir(value);
                    }
                  }}
                >
                  <SelectTrigger className="h-10 min-w-0 flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={FOLLOW_ACTIVE_WORKSPACE}>
                      {t("scheduled.playbooksWorkdirFollow")}
                    </SelectItem>
                    <SelectItem value={CUSTOM_WORKSPACE}>
                      {t("scheduled.playbooksWorkdirCustom")}
                    </SelectItem>
                    {workspaceOptions.map((option) => (
                      <SelectItem key={option.path} value={option.path} description={option.path}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {onPickWorkdir ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void browseWorkdir()}
                    title={t("settings.cronWorkdirBrowse")}
                    aria-label={t("settings.cronWorkdirBrowse")}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
              {customWorkdir ? (
                <Input
                  value={workdir}
                  onChange={(event) => {
                    markDirty("workdir");
                    setWorkdir(event.currentTarget.value);
                  }}
                  placeholder={t("settings.cronWorkdirCustomPlaceholder")}
                />
              ) : null}
            </div>
          </section>

          <section className="space-y-4 border-t border-border/40 pt-5">
            <div>
              <h3 className="text-sm font-semibold">{t("scheduled.playbooksCapabilities")}</h3>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <CapabilityGroup
                title={t("scheduled.playbooksSkills")}
                emptyLabel={t("scheduled.playbooksSkillsEmpty")}
                options={displayedSkills}
                selected={selectedSkills}
                onChange={(ids) => {
                  markDirty("selectedSkills");
                  setSelectedSkills(ids);
                }}
              />
              <CapabilityGroup
                title={t("scheduled.playbooksSystemTools")}
                emptyLabel={t("scheduled.playbooksSystemToolsEmpty")}
                options={displayedSystemTools}
                selected={selectedSystemTools}
                onChange={(ids) => {
                  markDirty("selectedSystemTools");
                  setSelectedSystemTools(ids);
                }}
              />
              <CapabilityGroup
                title={t("scheduled.playbooksMcpServers")}
                emptyLabel={t("scheduled.playbooksMcpServersEmpty")}
                options={displayedMcp}
                selected={mcpServerIds}
                onChange={(ids) => {
                  markDirty("mcpServerIds");
                  setMcpServerIds(ids);
                }}
              />
            </div>
          </section>

          <section className="space-y-4 border-t border-border/40 pt-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold">{t("scheduled.playbooksDelivery")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("scheduled.playbooksWecomHint")}
                </p>
              </div>
              <AgentActivationSwitch
                checked={deliveryEnabled}
                title={t("scheduled.playbooksDelivery")}
                onToggle={() => {
                  markDirty("delivery");
                  setFormError(null);
                  setDeliveryEnabled((enabled) => !enabled);
                }}
              />
            </div>
            {deliveryEnabled ? (
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                <div className="space-y-1.5">
                  <Label htmlFor="playbook-wecom-target">
                    {t("scheduled.playbooksDeliveryTarget")}
                  </Label>
                  <Input
                    id="playbook-wecom-target"
                    value={deliveryTarget}
                    maxLength={MAX_WECOM_TARGET_CHARACTERS}
                    onChange={(event) => {
                      markDirty("delivery");
                      setFormError(null);
                      setDeliveryTarget(event.currentTarget.value);
                    }}
                    placeholder={t("scheduled.playbooksDeliveryTargetPlaceholder")}
                  />
                  {deliveryTargetInvalid ? (
                    <p className="text-xs text-destructive">
                      {t("scheduled.playbooksDeliveryTargetInvalid")}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Label>{t("scheduled.playbooksDeliveryOnlyOn")}</Label>
                  <Select
                    value={deliveryOnlyOn}
                    onValueChange={(value) => {
                      markDirty("delivery");
                      setDeliveryOnlyOn(value as "always" | "success" | "failure");
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="always">
                        {t("scheduled.playbooksDeliveryAlways")}
                      </SelectItem>
                      <SelectItem value="success">
                        {t("scheduled.playbooksDeliverySuccess")}
                      </SelectItem>
                      <SelectItem value="failure">
                        {t("scheduled.playbooksDeliveryFailure")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}
          </section>

          {formError ? (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{formError}</span>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border/50 px-6 py-4">
          <Button type="button" variant="outline" onClick={requestCloseIfIdle} disabled={saving}>
            {t("settings.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={!formReady || saving || isClosing}
          >
            {saving ? t("settings.saving") : t("settings.save")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
