import { Popover } from "@base-ui/react";
import { memo, useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ClaudeIcon,
  GeminiIcon,
  OpenaiChatgptIcon,
  Search,
  Sparkle,
  Sparkles,
} from "../../../components/icons";
import { Button } from "../../../components/ui/button";
import { useLocale } from "../../../i18n";
import { groupModelOptionsByProvider } from "../../../lib/chat/page/chatPageHelpers";
import { type ModelOption, parseModelValue } from "../../../lib/providers/llm";
import {
  type ExecutionMode,
  isAgentDevMode,
  isAgentExecutionMode,
  type ProviderId,
  type ReasoningLevel,
  type SelectedModel,
} from "../../../lib/settings";
import { cn } from "../../../lib/shared/utils";

const REASONING_I18N_KEYS: Record<ReasoningLevel, string> = {
  off: "settings.reasoning.off",
  minimal: "settings.reasoning.minimal",
  low: "settings.reasoning.low",
  medium: "settings.reasoning.medium",
  high: "settings.reasoning.high",
  xhigh: "settings.reasoning.xhigh",
  max: "settings.reasoning.max",
};

function ProviderBrandIcon({ type, className }: { type: ProviderId; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  if (type === "claude_code") return <ClaudeIcon className={cls} />;
  if (type === "gemini") return <GeminiIcon className={cls} />;
  if (type === "zhipu") {
    return <Sparkles className={cn(cls, "text-sky-600 dark:text-sky-400")} />;
  }
  return <OpenaiChatgptIcon className={cn(cls, "fill-current dark:text-white")} />;
}

export const ChatModelPicker = memo(function ChatModelPicker(props: {
  hasModels: boolean;
  currentModelLabel: string;
  modelOptions: ModelOption[];
  selectedValue?: string;
  executionMode: ExecutionMode;
  reasoningOptions: ReasoningLevel[];
  selectedReasoning: ReasoningLevel;
  thinkingEnabled: boolean;
  controlsDisabled?: boolean;
  onSelectModel: (selection: SelectedModel) => void;
  onSelectExecutionMode: (mode: "text" | "tools") => void;
  onSelectReasoning: (reasoning: ReasoningLevel) => void;
}) {
  const {
    hasModels,
    currentModelLabel,
    modelOptions,
    selectedValue,
    executionMode,
    reasoningOptions,
    selectedReasoning,
    thinkingEnabled,
    controlsDisabled,
    onSelectModel,
    onSelectExecutionMode,
    onSelectReasoning,
  } = props;
  const { t } = useLocale();
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const searchInputRef = useRef<HTMLInputElement>(null);
  const executionModeRadioName = useId();
  const reasoningRadioName = useId();

  useEffect(() => {
    if (isModelPickerOpen) {
      setModelSearch("");
      setExpandedGroups({});
    }
  }, [isModelPickerOpen]);

  const normalizedSearch = modelSearch.trim().toLowerCase();
  const groups = groupModelOptionsByProvider(modelOptions);
  const selectedOption = modelOptions.find((option) => option.value === selectedValue);
  const selectedGroupId = selectedOption?.providerId;
  const isGroupExpanded = (id: string) =>
    normalizedSearch.length > 0 || (expandedGroups[id] ?? id === selectedGroupId);
  const toggleGroup = (id: string) =>
    setExpandedGroups((previous) => ({
      ...previous,
      [id]: !(previous[id] ?? id === selectedGroupId),
    }));
  const isAgent = isAgentExecutionMode(executionMode);
  const isDev = isAgentDevMode(executionMode);

  return (
    <Popover.Root open={isModelPickerOpen} onOpenChange={setIsModelPickerOpen}>
      <Popover.Trigger
        render={
          <Button
            variant="ghost"
            disabled={!hasModels}
            className={cn(
              "composer-model-trigger h-8 min-w-0 max-w-[min(15rem,45vw)] shrink-0 justify-between gap-1.5 rounded-full border-0 bg-foreground/[0.045] px-2.5 text-xs font-medium text-foreground shadow-none transition-colors hover:bg-foreground/[0.075] disabled:opacity-45 dark:bg-white/[0.065] dark:hover:bg-white/[0.10]",
              isModelPickerOpen && "bg-foreground/[0.075] dark:bg-white/[0.10]",
            )}
          />
        }
      >
        <span className="flex min-w-0 items-center gap-1.5 text-left">
          {selectedOption ? (
            <ProviderBrandIcon
              type={selectedOption.providerType}
              className="h-3.5 w-3.5 opacity-80"
            />
          ) : null}
          <span className="min-w-0 truncate">{currentModelLabel}</span>
        </span>
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-200",
            isModelPickerOpen && "rotate-180",
          )}
        />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-[9999]"
        >
          <Popover.Popup
            initialFocus={searchInputRef}
            aria-label={t("chat.selectModel")}
            className="model-selector-dropdown w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-border/70 bg-popover/95 p-0 text-xs text-popover-foreground shadow-[0_18px_55px_-18px_rgba(15,23,42,0.38)] outline-none backdrop-blur-2xl dark:border-white/[0.10] dark:bg-zinc-900/95"
          >
            <div className="px-2.5 pt-2.5">
              <div className="flex items-center justify-between gap-2 rounded-xl bg-muted/45 px-2.5 py-2">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t("settings.executionMode")}
                </span>
                <div
                  role="radiogroup"
                  aria-label={t("settings.executionMode")}
                  className="flex rounded-lg bg-background/85 p-0.5 shadow-sm ring-1 ring-border/40"
                >
                  <label
                    className={cn(
                      "relative cursor-pointer rounded-[7px] px-3 py-1 text-[11px] font-medium transition-colors has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                      isAgent
                        ? "text-muted-foreground hover:text-foreground"
                        : "bg-foreground/[0.08] text-foreground",
                    )}
                  >
                    <input
                      type="radio"
                      name={executionModeRadioName}
                      value="text"
                      checked={!isAgent}
                      onChange={() => onSelectExecutionMode("text")}
                      className="sr-only"
                    />
                    Chat
                  </label>
                  <label
                    className={cn(
                      "relative cursor-pointer rounded-[7px] px-3 py-1 text-[11px] font-medium transition-colors has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                      isAgent
                        ? "bg-foreground/[0.08] text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <input
                      type="radio"
                      name={executionModeRadioName}
                      value="tools"
                      checked={isAgent}
                      onChange={() => onSelectExecutionMode("tools")}
                      className="sr-only"
                    />
                    {isDev ? "Agent·dev" : "Agent"}
                  </label>
                </div>
              </div>
            </div>

            <div className="px-2.5 py-2">
              <div className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/35 px-2.5 py-1.5">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                <input
                  ref={searchInputRef}
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder={t("chat.searchModel")}
                  className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                  onKeyDown={(event) => event.stopPropagation()}
                />
              </div>
            </div>

            <div className="max-h-[min(16rem,var(--available-height,16rem))] overflow-y-auto overscroll-contain px-1.5 pb-1.5 [scrollbar-gutter:stable]">
              {(() => {
                let animationIndex = 0;
                const filteredGroups = normalizedSearch
                  ? groups
                      .map((group) => ({
                        ...group,
                        opts: group.opts.filter(
                          (option) =>
                            option.model.toLowerCase().includes(normalizedSearch) ||
                            option.providerName.toLowerCase().includes(normalizedSearch),
                        ),
                      }))
                      .filter((group) => group.opts.length > 0)
                  : groups;

                if (filteredGroups.length === 0) {
                  return (
                    <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                      {t("chat.noModelFound")}
                    </div>
                  );
                }

                return filteredGroups.map((group, groupIndex) => {
                  const expanded = isGroupExpanded(group.id);
                  return (
                    <div key={group.id} className="flex flex-col gap-0.5">
                      {groupIndex > 0 ? <hr className="my-1 h-px border-0 bg-border/30" /> : null}
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.id)}
                        aria-expanded={expanded}
                        title={expanded ? t("chat.collapseProvider") : t("chat.expandProvider")}
                        className="model-selector-group-label sticky top-0 z-10 flex h-[30px] w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-popover/75 px-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground/80 backdrop-blur-xl transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:text-white/80"
                      >
                        <ProviderBrandIcon
                          type={group.providerType}
                          className="h-3.5 w-3.5 opacity-90"
                        />
                        <span className="min-w-0 flex-1 truncate normal-case tracking-normal">
                          {group.name}
                        </span>
                        <span className="inline-flex h-4 min-w-[1.1rem] shrink-0 items-center justify-center rounded-full bg-muted/70 px-1 text-[10px] tabular-nums tracking-normal">
                          {group.opts.length}
                        </span>
                        <ChevronDown
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                            expanded && "rotate-180",
                          )}
                        />
                      </button>
                      {expanded
                        ? group.opts.map((option) => {
                            const isSelected = option.value === selectedValue;
                            const itemAnimationDelay = `${Math.min(animationIndex, 5) * 0.025}s`;
                            animationIndex += 1;
                            return (
                              <button
                                type="button"
                                key={option.value}
                                aria-pressed={isSelected}
                                onClick={() => {
                                  const parsed = parseModelValue(option.value);
                                  if (!parsed) return;
                                  onSelectModel(parsed);
                                  setIsModelPickerOpen(false);
                                }}
                                className={cn(
                                  "model-selector-item flex h-[32px] w-full max-w-full shrink-0 cursor-pointer items-center justify-between gap-3 overflow-hidden rounded-lg px-2 text-left text-xs font-normal leading-5 text-foreground transition-none hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:text-white",
                                  isSelected &&
                                    "bg-foreground/[0.075] font-medium hover:bg-foreground/[0.095]",
                                )}
                                style={{ animationDelay: itemAnimationDelay }}
                              >
                                <span className="flex min-w-0 items-center gap-2">
                                  <ProviderBrandIcon
                                    type={option.providerType}
                                    className={cn("opacity-70", isSelected && "opacity-100")}
                                  />
                                  <span className="min-w-0 truncate">{option.model}</span>
                                </span>
                                {isSelected ? (
                                  <Check className="h-4 w-4 shrink-0 text-primary" />
                                ) : null}
                              </button>
                            );
                          })
                        : null}
                    </div>
                  );
                });
              })()}
            </div>

            {reasoningOptions.length > 0 ? (
              <div className="border-t border-border/60 px-2.5 pb-2.5 pt-2">
                <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <Sparkle className="h-3.5 w-3.5 text-violet-500 dark:text-violet-400" />
                    {t("chat.runtime.reasoning")}
                  </span>
                  <span className="text-[10px] text-muted-foreground/75">
                    {thinkingEnabled
                      ? t(REASONING_I18N_KEYS[selectedReasoning])
                      : t(REASONING_I18N_KEYS.off)}
                  </span>
                </div>
                <div
                  role="radiogroup"
                  aria-label={t("chat.runtime.reasoning")}
                  className="flex flex-wrap gap-1 rounded-xl bg-muted/35 p-1"
                >
                  {reasoningOptions.map((reasoning) => {
                    const isSelected = thinkingEnabled && reasoning === selectedReasoning;
                    return (
                      <label
                        key={reasoning}
                        className={cn(
                          "relative min-w-[3.25rem] flex-1 cursor-pointer rounded-lg px-2 py-1.5 text-center text-[11px] font-medium text-muted-foreground transition-colors has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                          isSelected
                            ? "bg-background text-foreground shadow-sm ring-1 ring-border/40"
                            : "hover:bg-background/60 hover:text-foreground",
                          controlsDisabled && "pointer-events-none opacity-45",
                        )}
                      >
                        <input
                          type="radio"
                          name={reasoningRadioName}
                          value={reasoning}
                          checked={isSelected}
                          disabled={controlsDisabled}
                          onChange={() => onSelectReasoning(reasoning)}
                          className="sr-only"
                        />
                        {t(REASONING_I18N_KEYS[reasoning])}
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
