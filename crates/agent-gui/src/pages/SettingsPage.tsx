import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Info, Loader2, XCircle } from "../components/icons";
import { MacOsTitleBarSpacer } from "../components/MacOsTitleBarSpacer";
import { useLocale } from "../i18n";
import { isAgentExecutionMode } from "../lib/settings";
import { McpHubPage } from "./mcp-hub/McpHubPage";
import { AboutSection } from "./settings/AboutSection";
import { AgentsSection } from "./settings/AgentsSection";
import { ArchivedChatsSection } from "./settings/ArchivedChatsSection";
import { DatabaseSection } from "./settings/DatabaseSection";
import { GlobalShortcutsSection } from "./settings/GlobalShortcutsSection";
import { MemoryPanel } from "./settings/memory/MemoryPanel";
import { type SettingsDestination, visibleSettingsCategories } from "./settings/overviewModel";
import { ProvidersSection } from "./settings/ProvidersSection";
import { RemoteSection } from "./settings/RemoteSection";
import { SettingsOverview, SettingsSearch } from "./settings/SettingsOverview";
import { SshSection } from "./settings/SshSection";
import { SystemSettingsForm } from "./settings/SystemSettingsForm";
import { SystemToolsSection } from "./settings/SystemToolsSection";
import type { SectionId, SettingsPageProps } from "./settings/types";
import { WecomSection } from "./settings/WecomSection";
import { SkillsHubPage } from "./skills-hub/SkillsHubPage";
import "./settings/settings.css";

const NO_HIDDEN_SECTIONS: SectionId[] = [];

export function SettingsPage(props: SettingsPageProps) {
  const {
    settings,
    setSettings,
    saveState,
    onBack,
    initialSection,
    hiddenSections = NO_HIDDEN_SECTIONS,
  } = props;
  const { t } = useLocale();
  const [section, setSection] = useState<SectionId | null>(initialSection ?? null);
  const [anchor, setAnchor] = useState<string>();
  const [navigationVersion, setNavigationVersion] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const shouldFocus = useRef(false);
  const categories = useMemo(() => visibleSettingsCategories(hiddenSections), [hiddenSections]);
  const sectionLabels: Record<SectionId, string> = {
    system: t("settings.overview.preferences"),
    providers: t("settings.overview.models"),
    agents: t("settings.overview.instructions"),
    memory: t("settings.overview.memory"),
    skills: t("settings.navSkills"),
    mcp: "MCP",
    systemTools: t("settings.navSystemTools"),
    ssh: t("settings.navSsh"),
    database: t("settings.navDatabase"),
    remote: t("settings.overview.remote"),
    wecom: t("settings.navWecom"),
    shortcuts: t("settings.navShortcuts"),
    about: t("settings.navAbout"),
    archived: t("archive.title"),
  };
  const activeCategory = categories.find((category) =>
    category.entries.some(
      (entry) => entry.section === section && (!anchor || entry.anchor === anchor),
    ),
  );

  useEffect(() => {
    setSection(initialSection ?? null);
    setAnchor(undefined);
  }, [initialSection]);
  useEffect(() => {
    if (section && hiddenSections.includes(section)) setSection(null);
  }, [hiddenSections, section]);
  useEffect(() => {
    if (navigationVersion === 0 || !shouldFocus.current) return;
    shouldFocus.current = false;
    const target =
      section && anchor
        ? body.current?.querySelector<HTMLElement>(`[data-setting-anchor="${anchor}"]`)
        : null;
    if (target) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start", behavior: "instant" });
      target.dataset.settingHighlight = "true";
      const timeout = setTimeout(() => {
        delete target.dataset.settingHighlight;
      }, 1800);
      return () => {
        clearTimeout(timeout);
        delete target.dataset.settingHighlight;
      };
    }
    heading.current?.focus({ preventScroll: true });
  }, [section, anchor, navigationVersion]);

  const navigate = (destination: SettingsDestination) => {
    if (hiddenSections.includes(destination.section)) return;
    shouldFocus.current = true;
    setNavigationVersion((version) => version + 1);
    setAnchor(destination.anchor);
    setSection(destination.section);
  };
  const showOverview = () => {
    shouldFocus.current = true;
    setNavigationVersion((version) => version + 1);
    setAnchor(undefined);
    setSection(null);
  };
  const sectionContent = (() => {
    switch (section) {
      case "archived":
        return (
          <ArchivedChatsSection
            onOpenConversation={props.onOpenConversation}
            projects={settings.system.workspaceProjects}
          />
        );
      case "providers":
        return <ProvidersSection settings={settings} setSettings={setSettings} />;
      case "system":
        return <SystemSettingsForm settings={settings} setSettings={setSettings} />;
      case "shortcuts":
        return <GlobalShortcutsSection />;
      case "systemTools":
        return <SystemToolsSection settings={settings} setSettings={setSettings} />;
      case "skills":
        return (
          <SkillsHubPage
            settings={settings}
            setSettings={setSettings}
            isAgentMode={isAgentExecutionMode(settings.system.executionMode)}
            sidebarOpen
            onOpenSidebar={() => undefined}
            embedded
          />
        );
      case "mcp":
        return (
          <McpHubPage
            settings={settings}
            setSettings={setSettings}
            isAgentMode={isAgentExecutionMode(settings.system.executionMode)}
            sidebarOpen
            onOpenSidebar={() => undefined}
            embedded
          />
        );
      case "agents":
        return <AgentsSection settings={settings} setSettings={setSettings} />;
      case "ssh":
        return <SshSection settings={settings} setSettings={setSettings} />;
      case "database":
        return <DatabaseSection />;
      case "remote":
        return <RemoteSection settings={settings} setSettings={setSettings} />;
      case "wecom":
        return (
          <WecomSection
            settings={settings}
            setSettings={setSettings}
            onOpenRemote={() => setSection("remote")}
          />
        );
      case "memory":
        return (
          <MemoryPanel
            workdir={settings.system.workdir}
            settings={settings}
            setSettings={setSettings}
          />
        );
      case "about":
        return <AboutSection />;
      case null:
        return null;
    }
  })();

  const contained =
    section === "providers" || section === "memory" || section === "skills" || section === "mcp";
  const title = section ? sectionLabels[section] : t("settings.title");
  const saveLabel = t(
    saveState.status === "saving"
      ? "settings.saving"
      : saveState.status === "error"
        ? "settings.saveError"
        : "settings.saved",
  );

  return (
    <div className="arc-settings">
      <MacOsTitleBarSpacer />
      <header className="settings-toolbar">
        <nav className="settings-breadcrumb" aria-label={t("settings.title")}>
          <button type="button" className="settings-toolbar-button" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
            {t("settings.backToChat")}
          </button>
          <span aria-hidden="true">/</span>
          <button
            type="button"
            className="settings-toolbar-button"
            onClick={showOverview}
            aria-current={section === null ? "page" : undefined}
          >
            {t("settings.title")}
          </button>
        </nav>
        {!hiddenSections.includes("about") && (
          <button
            type="button"
            className="settings-toolbar-button"
            onClick={() => navigate({ section: "about" })}
          >
            <Info aria-hidden="true" />
            {t("settings.overview.about")}
          </button>
        )}
      </header>
      <main className="settings-scroll" key={section ?? "overview"}>
        <div className={`settings-content${section ? " settings-detail-content" : ""}`}>
          <div className="settings-page-heading">
            <div>
              <h1 className="settings-page-title" ref={heading} tabIndex={-1}>
                {title}
              </h1>
              <p className="settings-page-description">
                {section
                  ? t(activeCategory?.descriptionKey ?? "settings.overview.subtitle")
                  : t("settings.overview.subtitle")}
              </p>
            </div>
            <SettingsSearch categories={categories} onNavigate={navigate} />
          </div>
          {section === null ? (
            <SettingsOverview {...props} categories={categories} onNavigate={navigate} />
          ) : (
            <>
              {activeCategory && (
                <nav className="settings-detail-tabs" aria-label={t(activeCategory.titleKey)}>
                  {activeCategory.entries.map((entry) => (
                    <button
                      type="button"
                      key={`${entry.section}-${entry.anchor ?? ""}`}
                      aria-current={
                        entry.section === section && entry.anchor === anchor ? "page" : undefined
                      }
                      onClick={() => navigate(entry)}
                    >
                      {t(entry.labelKey)}
                    </button>
                  ))}
                </nav>
              )}
              <div
                ref={body}
                className={`settings-detail-body${contained ? " settings-detail-body-contained" : ""}`}
              >
                {sectionContent}
              </div>
            </>
          )}
        </div>
      </main>
      <footer className="settings-footer">
        <span
          className="settings-save-status"
          data-state={saveState.status}
          role={saveState.status === "error" ? "alert" : "status"}
        >
          {saveState.status === "saving" ? (
            <Loader2 className="settings-spinner" aria-hidden="true" />
          ) : saveState.status === "error" ? (
            <XCircle aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          {saveLabel}
          {saveState.status === "error" && (
            <span className="settings-save-error" title={saveState.message}>
              {saveState.message}
            </span>
          )}
        </span>
        <span>{t("settings.overview.localSettings")}</span>
      </footer>
    </div>
  );
}
