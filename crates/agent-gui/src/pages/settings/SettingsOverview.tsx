import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Archive,
  Brain,
  Cable,
  ChevronRight,
  Cpu,
  Info,
  Link2,
  Loader2,
  MonitorSmartphone,
  Search,
  Terminal,
  Wrench,
  X,
} from "../../components/icons";
import { useLocale } from "../../i18n";
import { isAgentExecutionMode } from "../../lib/settings";
import {
  type SettingsCategory,
  type SettingsDestination,
  searchSettings,
  settingsInventory,
} from "./overviewModel";
import { SettingsModeSelector } from "./SettingsModeSelector";
import type { SettingsPageProps } from "./types";
import { useSettingsRuntime } from "./useSettingsRuntime";

const CATEGORY_ICONS = {
  preferences: MonitorSmartphone,
  models: Cpu,
  agent: Terminal,
  extensions: Wrench,
  connections: Link2,
  sessions: Archive,
};

export function SettingsSearch({
  categories,
  onNavigate,
}: {
  categories: SettingsCategory[];
  onNavigate: (destination: SettingsDestination) => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const matches = useMemo(() => searchSettings(query, categories, t), [query, categories, t]);
  const expanded = open && query.trim().length > 0;
  const isMac = /Mac/i.test(navigator.platform);

  useEffect(() => {
    if (expanded)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [expanded, active, listId]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopPropagation();
        input.current?.focus();
        input.current?.select();
        setOpen(true);
      }
    };
    const closeOutside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", handleKey, true);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, []);

  const select = (destination: SettingsDestination) => {
    setOpen(false);
    setQuery("");
    setActive(0);
    onNavigate(destination);
  };

  return (
    <div className="settings-search" ref={root}>
      <div className="settings-search-field">
        <Search aria-hidden="true" />
        <input
          ref={input}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-label={t("settings.overview.search")}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded && matches[active] ? `${listId}-${active}` : undefined}
          placeholder={t("settings.overview.search")}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
              setQuery("");
            }
            if (
              expanded &&
              matches.length &&
              (event.key === "ArrowDown" || event.key === "ArrowUp")
            ) {
              event.preventDefault();
              setActive(
                (index) =>
                  (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length,
              );
            }
            if (expanded && event.key === "Enter" && matches[active]) {
              event.preventDefault();
              select(matches[active]);
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="settings-search-clear"
            aria-label={t("settings.overview.clearSearch")}
            onClick={() => {
              setQuery("");
              input.current?.focus();
            }}
          >
            <X aria-hidden="true" />
          </button>
        ) : (
          <kbd>
            {isMac ? "⌘" : "Ctrl"}
            <span>K</span>
          </kbd>
        )}
      </div>
      {expanded && (
        <div className="settings-search-popover">
          <div id={listId} role="listbox" aria-label={t("settings.overview.searchResults")}>
            {matches.map((entry, index) => (
              <div role="presentation" key={`${entry.section}-${entry.anchor ?? ""}`}>
                <button
                  type="button"
                  role="option"
                  id={`${listId}-${index}`}
                  aria-selected={active === index}
                  tabIndex={-1}
                  onMouseMove={() => setActive(index)}
                  onClick={() => select(entry)}
                >
                  <span>
                    {t(entry.labelKey)}
                    <small>{t(entry.categoryKey)}</small>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
          {!matches.length && (
            <p className="settings-search-empty" role="status">
              {t("settings.overview.noResults")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function SettingsOverview({
  categories,
  onNavigate,
  ...props
}: SettingsPageProps & {
  categories: SettingsCategory[];
  onNavigate: (destination: SettingsDestination) => void;
}) {
  const { settings, setSettings, runtimeSources, hiddenSections = [] } = props;
  const { t } = useLocale();
  const runtime = useSettingsRuntime(settings, runtimeSources);
  const inventory = settingsInventory(settings);
  const agent = isAgentExecutionMode(settings.system.executionMode);
  const enabledMcp = settings.mcp.servers.filter((server) => server.enabled).length;
  const mcpText = runtime.mcp.loading
    ? t("settings.overview.checking")
    : runtime.mcp.unavailable
      ? t("settings.overview.statusUnavailable")
      : runtime.mcp.error
        ? t("settings.overview.connectionError")
        : runtime.mcp.connected > 0
          ? t("settings.overview.connectedCount").replace("{count}", String(runtime.mcp.connected))
          : enabledMcp > 0
            ? t("settings.overview.disconnected")
            : t("settings.overview.notConfigured");
  const summary: Record<string, string> = {
    preferences: `${t(settings.theme === "system" ? "settings.auto" : settings.theme === "dark" ? "settings.dark" : "settings.light")} · ${settings.locale === "zh-CN" ? "简体中文" : "English"}`,
    models: `${inventory.providers} Providers · ${inventory.models} Models`,
    // Desktop memory is enabled in Chat and Agent; channel permissions are separate.
    agent: t("settings.overview.memoryOn"),
    extensions: `${inventory.tools} Tools · ${inventory.mcp} MCP`,
    connections:
      runtime.databaseCount === null
        ? `${settings.ssh.hosts.length} SSH · ${t("settings.overview.connectionsSummary")}`
        : `${inventory.connections + runtime.databaseCount} Connections`,
    sessions: t("settings.overview.sessionsSummary"),
  };
  return (
    <>
      <section className="settings-runtime" aria-label={t("settings.overview.runtime")}>
        <SettingsModeSelector settings={settings} setSettings={setSettings} />
        <div className="settings-capabilities" aria-live="polite">
          {!hiddenSections.includes("systemTools") && (
            <button
              className="settings-capability"
              type="button"
              data-state={runtime.toolsRunning ? "running" : "idle"}
              onClick={() => onNavigate({ section: "systemTools" })}
            >
              {runtime.toolsRunning ? (
                <Loader2 className="settings-spinner" aria-hidden="true" />
              ) : (
                <Wrench aria-hidden="true" />
              )}
              <span>
                <strong>Tools</strong>
                <small>
                  <i className="settings-status-dot" />
                  {t(
                    runtime.toolsRunning
                      ? "settings.overview.running"
                      : agent
                        ? "settings.overview.available"
                        : "settings.overview.agentOnly",
                  )}
                </small>
              </span>
            </button>
          )}
          {!hiddenSections.includes("mcp") && (
            <button
              className="settings-capability"
              type="button"
              aria-busy={runtime.mcp.loading}
              data-state={
                runtime.mcp.loading
                  ? "loading"
                  : runtime.mcp.unavailable
                    ? "unavailable"
                    : runtime.mcp.error
                      ? "error"
                      : runtime.mcp.connected > 0
                        ? "connected"
                        : "idle"
              }
              onClick={() => onNavigate({ section: "mcp" })}
            >
              {runtime.mcp.loading ? (
                <Loader2 className="settings-spinner" aria-hidden="true" />
              ) : (
                <Cable aria-hidden="true" />
              )}
              <span>
                <strong>MCP</strong>
                <small>
                  <i className="settings-status-dot" />
                  {mcpText}
                </small>
              </span>
            </button>
          )}
          {!hiddenSections.includes("memory") && (
            <button
              className="settings-capability"
              type="button"
              onClick={() => onNavigate({ section: "memory" })}
            >
              <Brain aria-hidden="true" />
              <span>
                <strong>Memory</strong>
                <small>
                  <i className="settings-status-dot" />
                  {t("settings.overview.enabled")}
                </small>
              </span>
            </button>
          )}
        </div>
        <div className="settings-runtime-end">
          <span
            className="settings-runtime-status"
            data-state={runtime.running ? "running" : "ready"}
            role="status"
          >
            {runtime.running ? (
              <Loader2 className="settings-spinner" aria-hidden="true" />
            ) : (
              <i className="settings-status-dot" />
            )}
            {runtime.running ? t("settings.overview.running") : "Ready"}
          </span>
          {!hiddenSections.includes("systemTools") && (
            <button
              type="button"
              className="settings-runtime-configure"
              onClick={() => onNavigate({ section: "systemTools" })}
            >
              {t("settings.overview.configure")}
              <ChevronRight aria-hidden="true" />
            </button>
          )}
        </div>
      </section>
      <section className="settings-directory" aria-labelledby="settings-directory-label">
        <h2 id="settings-directory-label" className="settings-section-label">
          {t("settings.overview.configuration")}
        </h2>
        <div className="settings-directory-grid">
          {categories.map((category) => {
            const Icon = CATEGORY_ICONS[category.id as keyof typeof CATEGORY_ICONS] ?? Info;
            return (
              <article className="settings-directory-item" key={category.id}>
                <button
                  type="button"
                  className="settings-directory-main"
                  onClick={() => onNavigate(category.entries[0])}
                >
                  <Icon className="settings-directory-icon" aria-hidden="true" />
                  <span className="settings-directory-text">
                    <span className="settings-directory-title">{t(category.titleKey)}</span>
                    <span className="settings-directory-description">
                      {t(category.descriptionKey)}
                    </span>
                    <span className="settings-directory-meta">{summary[category.id]}</span>
                  </span>
                  <ChevronRight className="settings-directory-arrow" aria-hidden="true" />
                </button>
                <div className="settings-directory-links">
                  {category.entries.map((entry) => (
                    <button
                      type="button"
                      key={`${entry.section}-${entry.anchor ?? ""}`}
                      aria-label={t(entry.labelKey)}
                      onClick={() => onNavigate(entry)}
                    >
                      {t(entry.labelKey)}
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}
