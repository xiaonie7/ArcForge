import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  BookOpen,
  Check,
  Folder,
  FolderOpen,
  MessageCircle,
  Sparkles,
  X,
} from "../../components/icons";
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
import type {
  Playbook,
  PlaybookDelivery,
  PlaybookDeliveryOnlyOn,
  SelectedModelRef,
} from "../../lib/automation";
import { parseModelValue, toModelValue } from "../../lib/providers/llm";
import { useModalMotion } from "../../lib/shared/modalMotion";
import { cn } from "../../lib/shared/utils";
import { ModelPicker, type ModelPickerOption } from "../settings/modelPicker";

const FOLLOW_ACTIVE_WORKSPACE_VALUE = "__follow-active-workspace__";
const CUSTOM_WORKDIR_VALUE = "__custom-workdir__";
const DELIVERY_TARGET_MAX_CHARACTERS = 256;
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const REASONING_LABEL_KEYS: Record<(typeof REASONING_LEVELS)[number], string> = {
  off: "settings.reasoning.off",
  minimal: "settings.reasoning.minimal",
  low: "settings.reasoning.low",
  medium: "settings.reasoning.medium",
  high: "settings.reasoning.high",
  xhigh: "settings.reasoning.xhigh",
  max: "settings.reasoning.max",
};

export type PlaybookWorkspaceOption = {
  path: string;
  name: string;
};

export type PlaybookCapabilityOption = {
  id: string;
  label: string;
  description?: string;
};

export type PlaybookFormData = Omit<
  Playbook,
  "id" | "createdAt" | "updatedAt" | "workdir" | "delivery"
> & {
  workdir?: string;
  delivery: PlaybookDelivery | null;
};

type PlaybookModalProps = {
  mode: "add" | "edit";
  initialData?: Playbook;
  defaultModel?: SelectedModelRef;
  defaultReasoning: string;
  defaultWorkdir: string;
  defaultSkills: string[];
  defaultSystemTools: string[];
  defaultMcpServers: string[];
  modelOptions: ModelPickerOption[];
  workspaceOptions: PlaybookWorkspaceOption[];
  skillOptions: PlaybookCapabilityOption[];
  systemToolOptions: PlaybookCapabilityOption[];
  mcpServerOptions: PlaybookCapabilityOption[];
  onPickWorkdir: (initialWorkdir: string) => Promise<string | null>;
  onSave: (data: PlaybookFormData) => void | Promise<void>;
  onClose: () => void;
};

function comparableWorkdirPath(path: string) {
  const normalized = path.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const windowsShape = /^[A-Za-z]:/.test(normalized) || normalized.startsWith("//");
  const comparable = windowsShape ? normalized.toLowerCase() : normalized;
  if (comparable === "/" || /^[a-z]:\/$/.test(comparable)) return comparable;
  return comparable.replace(/\/+$/, "");
}

function findWorkspaceOption(options: PlaybookWorkspaceOption[], path: string) {
  const target = comparableWorkdirPath(path);
  if (!target) return null;
  return options.find((option) => comparableWorkdirPath(option.path) === target) ?? null;
}

function withMissingOptions(
  options: PlaybookCapabilityOption[],
  selected: string[],
): PlaybookCapabilityOption[] {
  const known = new Set(options.map((option) => option.id));
  return [...options, ...selected.filter((id) => !known.has(id)).map((id) => ({ id, label: id }))];
}

function normalizeReasoning(value: string) {
  return (REASONING_LEVELS as readonly string[]).includes(value) ? value : "medium";
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

export function isPlaybookDeliveryTargetValid(value: string) {
  const normalized = value.trim();
  return Boolean(
    normalized &&
      Array.from(normalized).length <= DELIVERY_TARGET_MAX_CHARACTERS &&
      !hasControlCharacters(value),
  );
}

function CapabilityPicker(props: {
  label: string;
  emptyLabel: string;
  options: PlaybookCapabilityOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  const selected = new Set(props.selected);

  function toggle(id: string) {
    const next = selected.has(id)
      ? props.selected.filter((item) => item !== id)
      : [...props.selected, id];
    props.onChange(next);
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium text-muted-foreground">{props.label}</Label>
        <span className="text-[11px] tabular-nums text-muted-foreground/70">
          {props.selected.length}/{props.options.length}
        </span>
      </div>
      {props.options.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 px-3 py-3 text-xs text-muted-foreground/70">
          {props.emptyLabel}
        </div>
      ) : (
        <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-border/50 p-1.5">
          {props.options.map((option) => {
            const checked = selected.has(option.id);
            return (
              <label
                key={option.id}
                className={cn(
                  "flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors",
                  checked
                    ? "bg-primary/[0.08] text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(option.id)}
                  className="sr-only"
                />
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
                  )}
                >
                  {checked ? <Check className="h-3 w-3" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{option.label}</span>
                  {option.description ? (
                    <span className="block truncate text-[10px] text-muted-foreground/70">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function PlaybookModal(props: PlaybookModalProps) {
  const { t } = useLocale();
  const {
    mode,
    initialData,
    defaultModel,
    defaultReasoning,
    defaultWorkdir,
    defaultSkills,
    defaultSystemTools,
    defaultMcpServers,
    modelOptions,
    workspaceOptions,
    skillOptions,
    systemToolOptions,
    mcpServerOptions,
    onPickWorkdir,
    onSave,
    onClose,
  } = props;

  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [prompt, setPrompt] = useState(initialData?.prompt ?? "");
  const [selectedModelValue, setSelectedModelValue] = useState(() => {
    const model = initialData?.selectedModel ?? defaultModel;
    return model ? toModelValue(model.customProviderId, model.model) : "";
  });
  const [reasoning, setReasoning] = useState(() =>
    normalizeReasoning(initialData?.reasoning ?? defaultReasoning),
  );
  const [workdir, setWorkdir] = useState(() => {
    const value = mode === "edit" ? (initialData?.workdir ?? "") : defaultWorkdir;
    return findWorkspaceOption(workspaceOptions, value)?.path ?? value;
  });
  const [customWorkdir, setCustomWorkdir] = useState(() => {
    const value = mode === "edit" ? (initialData?.workdir ?? "") : defaultWorkdir;
    return Boolean(value && !findWorkspaceOption(workspaceOptions, value));
  });
  const [selectedSkills, setSelectedSkills] = useState(
    initialData?.selectedSkills ?? defaultSkills,
  );
  const [selectedSystemTools, setSelectedSystemTools] = useState(
    initialData?.selectedSystemTools ?? defaultSystemTools,
  );
  const [mcpServerIds, setMcpServerIds] = useState(initialData?.mcpServerIds ?? defaultMcpServers);
  const [deliveryEnabled, setDeliveryEnabled] = useState(Boolean(initialData?.delivery));
  const [deliveryTargetId, setDeliveryTargetId] = useState(initialData?.delivery?.targetId ?? "");
  const [deliveryOnlyOn, setDeliveryOnlyOn] = useState<PlaybookDeliveryOnlyOn>(
    initialData?.delivery?.onlyOn ?? "always",
  );
  const [reasoningTouched, setReasoningTouched] = useState(false);
  const [workdirTouched, setWorkdirTouched] = useState(false);
  const [selectedSkillsTouched, setSelectedSkillsTouched] = useState(false);
  const [selectedSystemToolsTouched, setSelectedSystemToolsTouched] = useState(false);
  const [mcpServerIdsTouched, setMcpServerIdsTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const { isClosing, modalState, requestClose: requestMotionClose } = useModalMotion(onClose);

  const selectedWorkspace = customWorkdir ? null : findWorkspaceOption(workspaceOptions, workdir);
  const model = parseModelValue(selectedModelValue);
  const deliveryTargetValid = !deliveryEnabled || isPlaybookDeliveryTargetValid(deliveryTargetId);
  const deliveryTargetInvalid = Boolean(
    deliveryEnabled && deliveryTargetId.trim() && !deliveryTargetValid,
  );
  const formReady = Boolean(name.trim() && prompt.trim() && model && deliveryTargetValid);
  const effectiveModelOptions = useMemo(() => {
    if (!selectedModelValue || modelOptions.some((option) => option.value === selectedModelValue)) {
      return modelOptions;
    }
    const parsed = parseModelValue(selectedModelValue);
    return parsed
      ? [
          ...modelOptions,
          {
            value: selectedModelValue,
            label: parsed.model,
            providerName: parsed.customProviderId,
            providerId: parsed.customProviderId,
          },
        ]
      : modelOptions;
  }, [modelOptions, selectedModelValue]);
  const displayedSkills = useMemo(
    () => withMissingOptions(skillOptions, selectedSkills),
    [selectedSkills, skillOptions],
  );
  const displayedSystemTools = useMemo(
    () => withMissingOptions(systemToolOptions, selectedSystemTools),
    [selectedSystemTools, systemToolOptions],
  );
  const displayedMcpServers = useMemo(
    () => withMissingOptions(mcpServerOptions, mcpServerIds),
    [mcpServerIds, mcpServerOptions],
  );

  function requestModalClose() {
    if (savingRef.current) return;
    requestMotionClose();
  }

  async function handleSave() {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      setIsSaving(true);
      setFormError(null);
      const parsedModel = parseModelValue(selectedModelValue);
      if (!name.trim()) throw new Error(t("scheduled.playbooksNameRequired"));
      if (!prompt.trim()) throw new Error(t("scheduled.playbooksPromptRequired"));
      if (!parsedModel) throw new Error(t("scheduled.playbooksModelRequired"));
      if (deliveryEnabled && !deliveryTargetId.trim()) {
        throw new Error(t("scheduled.playbooksDeliveryTargetRequired"));
      }
      if (deliveryEnabled && !isPlaybookDeliveryTargetValid(deliveryTargetId)) {
        throw new Error(t("scheduled.playbooksDeliveryTargetInvalid"));
      }

      await onSave({
        name: name.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
        selectedModel: parsedModel,
        reasoning:
          mode === "edit" && !reasoningTouched ? initialData?.reasoning : reasoning,
        workdir: mode === "edit" && !workdirTouched ? initialData?.workdir : workdir.trim(),
        selectedSkills:
          mode === "edit" && !selectedSkillsTouched
            ? initialData?.selectedSkills
            : selectedSkills,
        selectedSystemTools:
          mode === "edit" && !selectedSystemToolsTouched
            ? initialData?.selectedSystemTools
            : selectedSystemTools,
        mcpServerIds:
          mode === "edit" && !mcpServerIdsTouched ? initialData?.mcpServerIds : mcpServerIds,
        delivery: deliveryEnabled
          ? {
              channel: "wecom",
              targetId: deliveryTargetId.trim(),
              onlyOn: deliveryOnlyOn,
            }
          : null,
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
    >
      <button
        type="button"
        aria-label={t("settings.cancel")}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        disabled={isSaving}
        onClick={requestModalClose}
      />
      <div className="settings-modal-panel relative z-10 flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
        <div className="settings-modal-header flex items-center gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10 text-violet-500">
            <BookOpen className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">
              {mode === "add"
                ? t("scheduled.playbooksModalAdd")
                : t("scheduled.playbooksModalEdit")}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("scheduled.playbooksModalHint")}
            </p>
          </div>
          <button
            type="button"
            disabled={isSaving}
            onClick={requestModalClose}
            title={t("settings.cancel")}
            aria-label={t("settings.cancel")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="settings-modal-body flex-1 overflow-y-auto">
          <div className="border-b border-border/30 px-6 py-5">
            <div className="mb-4 flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary">
                1
              </span>
              <span className="text-sm font-semibold">{t("scheduled.playbooksBasic")}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  {t("scheduled.playbooksName")}
                </Label>
                <Input
                  value={name}
                  placeholder={t("scheduled.playbooksNamePlaceholder")}
                  onChange={(event) => {
                    setFormError(null);
                    setName(event.currentTarget.value);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  {t("scheduled.playbooksDescription")}
                </Label>
                <Input
                  value={description}
                  placeholder={t("scheduled.playbooksDescriptionPlaceholder")}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
              </div>
            </div>
          </div>

          <div className="border-b border-border/30 px-6 py-5">
            <div className="mb-4 flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary">
                2
              </span>
              <span className="text-sm font-semibold">{t("scheduled.playbooksExecution")}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  {t("scheduled.playbooksModel")}
                </Label>
                <ModelPicker
                  options={effectiveModelOptions}
                  value={selectedModelValue}
                  disabled={effectiveModelOptions.length === 0}
                  placeholder={t("scheduled.playbooksModelPlaceholder")}
                  onChange={(value) => {
                    setFormError(null);
                    setSelectedModelValue(value);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  {t("scheduled.playbooksReasoning")}
                </Label>
                <Select
                  value={reasoning}
                  onValueChange={(value) => {
                    setReasoningTouched(true);
                    setReasoning(value);
                  }}
                >
                  <SelectTrigger className="h-10">
                    <SelectValue>
                      {t(REASONING_LABEL_KEYS[reasoning as keyof typeof REASONING_LABEL_KEYS])}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {REASONING_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {t(REASONING_LABEL_KEYS[level])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-4 space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("scheduled.playbooksWorkdir")}
              </Label>
              <Select
                value={
                  customWorkdir ? CUSTOM_WORKDIR_VALUE : workdir || FOLLOW_ACTIVE_WORKSPACE_VALUE
                }
                onValueChange={(value) => {
                  setWorkdirTouched(true);
                  if (value === FOLLOW_ACTIVE_WORKSPACE_VALUE) {
                    setCustomWorkdir(false);
                    setWorkdir("");
                  } else if (value === CUSTOM_WORKDIR_VALUE) {
                    setCustomWorkdir(true);
                  } else {
                    setCustomWorkdir(false);
                    setWorkdir(value);
                  }
                }}
              >
                <SelectTrigger className="h-10">
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                    <SelectValue>
                      {customWorkdir
                        ? t("scheduled.playbooksWorkdirCustom")
                        : (selectedWorkspace?.name ?? t("scheduled.playbooksWorkdirFollow"))}
                    </SelectValue>
                  </span>
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  <SelectItem value={FOLLOW_ACTIVE_WORKSPACE_VALUE}>
                    {t("scheduled.playbooksWorkdirFollow")}
                  </SelectItem>
                  <SelectItem value={CUSTOM_WORKDIR_VALUE}>
                    {t("scheduled.playbooksWorkdirCustom")}
                  </SelectItem>
                  {workspaceOptions.map((option) => (
                    <SelectItem
                      key={option.path}
                      value={option.path}
                      description={<span className="font-mono">{option.path}</span>}
                    >
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {customWorkdir ? (
                <div className="flex gap-2">
                  <Input
                    value={workdir}
                    className="font-mono text-xs"
                    placeholder={t("scheduled.playbooksWorkdirPlaceholder")}
                    onChange={(event) => {
                      setWorkdirTouched(true);
                      setWorkdir(event.currentTarget.value);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    title={t("settings.cronWorkdirBrowse")}
                    aria-label={t("settings.cronWorkdirBrowse")}
                    onClick={() => {
                      void onPickWorkdir(workdir).then((value) => {
                        if (value?.trim()) {
                          setWorkdirTouched(true);
                          setWorkdir(value.trim());
                        }
                      });
                    }}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="mt-4 space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("scheduled.playbooksPrompt")}
              </Label>
              <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/20">
                <div className="flex items-center gap-1.5 border-b border-border/30 px-3 py-2 text-[11px] text-muted-foreground">
                  <Sparkles className="h-3 w-3" />
                  {t("scheduled.playbooksPromptHint")}
                </div>
                <Textarea
                  value={prompt}
                  placeholder={t("scheduled.playbooksPromptPlaceholder")}
                  className="min-h-44 resize-y rounded-none border-0 bg-transparent text-sm leading-relaxed focus-visible:ring-0"
                  onChange={(event) => {
                    setFormError(null);
                    setPrompt(event.currentTarget.value);
                  }}
                />
              </div>
            </div>
          </div>

          <div className="border-b border-border/30 px-6 py-5">
            <div className="mb-4 flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary">
                3
              </span>
              <span className="text-sm font-semibold">{t("scheduled.playbooksCapabilities")}</span>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <CapabilityPicker
                label={t("scheduled.playbooksSkills")}
                emptyLabel={t("scheduled.playbooksSkillsEmpty")}
                options={displayedSkills}
                selected={selectedSkills}
                onChange={(value) => {
                  setSelectedSkillsTouched(true);
                  setSelectedSkills(value);
                }}
              />
              <CapabilityPicker
                label={t("scheduled.playbooksSystemTools")}
                emptyLabel={t("scheduled.playbooksSystemToolsEmpty")}
                options={displayedSystemTools}
                selected={selectedSystemTools}
                onChange={(value) => {
                  setSelectedSystemToolsTouched(true);
                  setSelectedSystemTools(value);
                }}
              />
              <CapabilityPicker
                label={t("scheduled.playbooksMcpServers")}
                emptyLabel={t("scheduled.playbooksMcpServersEmpty")}
                options={displayedMcpServers}
                selected={mcpServerIds}
                onChange={(value) => {
                  setMcpServerIdsTouched(true);
                  setMcpServerIds(value);
                }}
              />
            </div>
          </div>

          <div className="px-6 py-5">
            <div className="mb-4 flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary">
                4
              </span>
              <span className="text-sm font-semibold">{t("scheduled.playbooksDelivery")}</span>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-xl border border-border/50 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <MessageCircle className="h-5 w-5 shrink-0 text-emerald-500" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t("scheduled.playbooksWecom")}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t("scheduled.playbooksWecomHint")}
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={deliveryEnabled}
                aria-label={t("scheduled.playbooksWecom")}
                onClick={() => setDeliveryEnabled((value) => !value)}
                className={cn(
                  "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors",
                  deliveryEnabled ? "bg-primary" : "bg-muted-foreground/30",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
                    deliveryEnabled ? "translate-x-5" : "translate-x-1",
                  )}
                />
              </button>
            </div>
            {deliveryEnabled ? (
              <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    {t("scheduled.playbooksDeliveryTarget")}
                  </Label>
                  <Input
                    value={deliveryTargetId}
                    maxLength={256}
                    aria-invalid={deliveryTargetInvalid || undefined}
                    placeholder={t("scheduled.playbooksDeliveryTargetPlaceholder")}
                    onChange={(event) => {
                      setFormError(null);
                      setDeliveryTargetId(event.currentTarget.value);
                    }}
                  />
                  {deliveryTargetInvalid ? (
                    <p className="text-xs text-destructive">
                      {t("scheduled.playbooksDeliveryTargetInvalid")}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    {t("scheduled.playbooksDeliveryOnlyOn")}
                  </Label>
                  <Select
                    value={deliveryOnlyOn}
                    onValueChange={(value) => setDeliveryOnlyOn(value as PlaybookDeliveryOnlyOn)}
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
          </div>
        </div>

        <div className="settings-modal-footer flex items-center justify-between gap-4 border-t border-border/40 px-6 py-4">
          <div className="min-w-0 flex-1">
            {formError ? (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{formError}</span>
              </div>
            ) : formReady ? (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                {t("scheduled.playbooksReady")}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" disabled={isSaving} onClick={requestModalClose}>
              {t("settings.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!formReady || isSaving || isClosing}
              onClick={() => void handleSave()}
            >
              {t("settings.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
