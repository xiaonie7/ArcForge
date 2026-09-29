import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { WindowsTitleBar } from "../../src/components/WindowsTitleBar";
import { LocaleContext, t } from "../../src/i18n";
import { createLiveTranscriptStore } from "../../src/lib/chat/conversation/liveTranscriptStore";
import { type AppSettings, createProviderModelConfig, getDefaultSettings, normalizeSettings, normalizeSshHostConfig } from "../../src/lib/settings";
import type { SettingsSaveState } from "../../src/lib/settings/storage";
import { createSidebarStore } from "../../src/lib/sidebar/store";
import { SettingsPage } from "../../src/pages/SettingsPage";
import { useSettingsFocus } from "../../src/pages/settings/useSettingsFocus";
import "../../src/index.css";

// Isolated visual QA fixture. IPC is mocked before rendering; no user configuration is read or written.
const scenario = new URLSearchParams(location.search).get("state") ?? "ready";
Object.assign(window, { isTauri: true });
mockWindows("main");
mockIPC(async (command, args) => {
  if (command === "mcp_runtime_status") {
    if (scenario === "loading") await new Promise((resolve) => setTimeout(resolve, 60000));
    if (scenario === "error") throw new Error("Mock disconnected transport");
    const serverId = (args as { server_id?: string })?.server_id;
    return { serverId, running: true, initialized: true };
  }
  if (command === "plugin:window|is_focused") return true;
  if (command === "plugin:window|is_maximized") return false;
  if (command === "gateway_status") {
    if (scenario === "remote-unavailable") return null;
    if (scenario === "remote-error") throw new Error("Mock unavailable gateway runtime");
    return { online: false, enabled: true, configured: false, gatewayUrl: "" };
  }
  if (command === "database_profiles_list") return scenario === "empty" ? [] : [{ id: "demo", name: "Demo database", enabled: true }];
  if (command === "chat_history_archive_policy_get") return { enabled: false, idleMinutes: 10080, sourceIds: [], projectPaths: [] };
  if (command === "chat_history_archive_facets") return { sources: [], projects: [] };
  if (command === "skills_list") return [];
  if (command === "chat_history_query") return { items: [], totalCount: 0, page: 1, pageSize: 50 };
  return null;
}, { shouldMockEvents: true });

const initial = getDefaultSettings();
initial.customProviders = initial.customProviders.slice(0, 2).map((provider) => {
  const models = ["demo-fast", "demo-balanced", "demo-reasoning"].map((id) => createProviderModelConfig(provider.type, id));
  return { ...provider, models, activeModels: models.map((model) => model.id) };
});
initial.mcp.servers = ["workspace", "docs"].map((id) => ({ id, enabled: true, transport: "stdio", command: "demo", args: [], url: "", timeoutMs: 30000 }));
initial.ssh.hosts = [normalizeSshHostConfig({ id: "local", name: "Development", host: "localhost", port: 22 })];
initial.remote.enabled = true;
if (scenario === "empty") {
  initial.customProviders = [];
  initial.mcp.servers = [];
  initial.ssh.hosts = [];
  initial.remote.enabled = false;
}
if (scenario === "english") initial.locale = "en-US";
if (scenario === "dark") initial.theme = "dark";
if (scenario === "debug") initial.system.executionMode = "agent-dev";

const transcript = createLiveTranscriptStore();
const unsupportedMutation = async (): Promise<never> => { throw new Error("Not part of the settings visual fixture"); };
const sidebar = createSidebarStore({
  listConversations: async () => ({ items: [], totalCount: 0 }),
  listWorkdirs: async () => [],
  subscribeEvents: () => () => {},
  getProtectedConversationIds: () => [],
  renameConversation: unsupportedMutation,
  setConversationPinned: unsupportedMutation,
  archiveConversation: unsupportedMutation,
  deleteConversation: unsupportedMutation,
});
const sources = { sidebar, transcript: () => transcript };
if (scenario === "running") {
  sidebar.applyRunningPatch({ conversationId: "demo", running: true });
  transcript.updateLiveRounds(() => [{ round: 1, key: "r1", blocks: [], runningToolCallIds: ["tool1"], thinkingOpen: false }]);
}

declare global {
  interface Window {
    __wentBack?: boolean;
    __settingsQA: {
      settings: AppSettings;
      setSettings: Dispatch<SetStateAction<AppSettings>>;
      setSaveState: Dispatch<SetStateAction<SettingsSaveState>>;
      sidebar: typeof sidebar;
      transcript: typeof transcript;
      removeOpener: () => void;
    };
  }
}

function Preview() {
  const [open, setOpen] = useState(scenario !== "focus");
  const [showOpener, setShowOpener] = useState(true);
  const { backgroundRef, settingsSurfaceRef } = useSettingsFocus(open);
  const [settings, setSettings] = useState(() => normalizeSettings(initial));
  const [saveState, setSaveState] = useState<SettingsSaveState>({ status: scenario === "save-error" ? "error" : "saved", message: "保存失败，请重试。" });
  const locale = useMemo(() => ({ locale: settings.locale, t: (key: string) => t(key, settings.locale) }), [settings.locale]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", settings.theme === "dark");
    window.__settingsQA = { settings, setSettings, setSaveState, sidebar, transcript, removeOpener: () => setShowOpener(false) };
  }, [settings]);
  return (
    <LocaleContext.Provider value={locale}>
      <div className="flex h-full flex-col">
        <WindowsTitleBar />
        <div className="relative min-h-0 flex-1">
          <div ref={backgroundRef} className="h-full outline-none" tabIndex={-1} data-testid="chat-background">
            {showOpener && <button type="button" onClick={() => setOpen(true)}>打开设置</button>}
            <input aria-label="聊天输入" />
          </div>
          {open && <div ref={settingsSurfaceRef} className="absolute inset-0" tabIndex={-1}>
            <SettingsPage settings={settings} setSettings={setSettings} saveState={saveState} runtimeSources={sources} onBack={() => { window.__wentBack = true; setOpen(false); }} />
          </div>}
        </div>
      </div>
    </LocaleContext.Provider>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
