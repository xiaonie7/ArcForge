import type { LiveTranscriptStore } from "../../lib/chat/conversation/liveTranscriptStore";
import type { AppSettings } from "../../lib/settings";
import type { SettingsSaveState } from "../../lib/settings/storage";
import type { SidebarStore } from "../../lib/sidebar/store";

export type SettingsRuntimeSources = {
  sidebar: SidebarStore;
  transcript: (conversationId: string) => LiveTranscriptStore;
};

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "system"
  | "archived"
  | "shortcuts"
  | "systemTools"
  | "providers"
  | "agents"
  | "skills"
  | "mcp"
  | "database"
  | "ssh"
  | "memory"
  | "remote"
  | "wecom"
  | "about";

export type SettingsPageProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState: SettingsSaveState;
  onBack: () => void;
  onOpenConversation?: (conversationId: string) => void;
  initialSection?: SectionId;
  hiddenSections?: SectionId[];
  runtimeSources?: SettingsRuntimeSources | null;
};

export type SettingsSectionProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
};
