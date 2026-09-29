import { MessageSquare, Terminal } from "../../components/icons";
import { useLocale } from "../../i18n";
import { isAgentExecutionMode, updateSystem } from "../../lib/settings";
import type { SettingsSectionProps } from "./types";

export function SettingsModeSelector({ settings, setSettings }: SettingsSectionProps) {
  const { t } = useLocale();
  const agent = isAgentExecutionMode(settings.system.executionMode);
  return (
    <div className="settings-mode">
      <div className="settings-mode-heading">{t("settings.overview.mode")}</div>
      <div className="settings-mode-content">
        <fieldset className="settings-mode-options" aria-label={t("settings.executionMode")}>
          <button
            type="button"
            className="settings-mode-option"
            aria-pressed={!agent}
            onClick={() => setSettings((prev) => updateSystem(prev, { executionMode: "text" }))}
          >
            <MessageSquare aria-hidden="true" />
            <span>Chat</span>
          </button>
          <button
            type="button"
            className="settings-mode-option"
            aria-pressed={agent}
            onClick={() =>
              setSettings((prev) =>
                updateSystem(prev, {
                  executionMode: prev.system.executionMode === "agent-dev" ? "agent-dev" : "tools",
                }),
              )
            }
          >
            <Terminal aria-hidden="true" />
            <span>Agent</span>
            {settings.system.executionMode === "agent-dev" && (
              <span className="settings-dev-badge">DEV</span>
            )}
          </button>
        </fieldset>
        <p className="settings-mode-description">
          {t(agent ? "settings.overview.agentModeDesc" : "settings.overview.chatModeDesc")}
        </p>
      </div>
    </div>
  );
}
