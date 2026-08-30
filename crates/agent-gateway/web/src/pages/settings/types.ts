import type { AppSettings } from "../../lib/settings";
import type { WebSettingsSaveState } from "../../lib/webSettings";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "system"
  | "archived"
  | "systemTools"
  | "providers"
  | "agents"
  | "ssh"
  | "memory"
  | "playbooks"
  | "hooks"
  | "cron"
  | "remote";

export type SettingsPageProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState: WebSettingsSaveState;
  onBack: () => void;
  onOpenConversation?: (conversationId: string) => void;
  initialSection?: SectionId;
  hiddenSections?: SectionId[];
};

export type SettingsSectionProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
};
