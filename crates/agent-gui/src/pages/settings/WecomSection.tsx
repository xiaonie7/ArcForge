import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Check,
  Cloud,
  Eye,
  EyeOff,
  FileText,
  Key,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Save,
  Send,
  Server,
  Shield,
  Terminal,
  Trash2,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useLocale } from "../../i18n";
import type { WeComAccessRule, WeComAccessScope } from "../../lib/security/wecomAccessPolicy";
import type { AppSettings, WecomGatewayMode, WecomSettings } from "../../lib/settings";
import { isSupportedGatewayUrl } from "../../lib/settings/normalize";
import { AgentActivationSwitch } from "./shared";
import type { SettingsSectionProps } from "./types";
import {
  commitWeComAccessRuleDraft,
  createWeComAccessRuleDraft,
  editWeComAccessRuleDraft,
  isCompleteWeComAccessRuleDraft,
  type WeComAccessRuleDraft,
} from "./wecomAccessDraft";

type WecomWritePayload = WecomSettings & {
  secretUpdate?: string | null;
  channelTokenUpdate?: string | null;
};

type WecomRuntimeStatus = {
  mode: WecomGatewayMode;
  overall: string;
  gatewayState: string;
  connectorState: string;
  localGatewayUrl?: string | null;
  gatewayUrl?: string | null;
  gatewayPid?: number | null;
  connectorPid?: number | null;
  gatewayRestarts?: number;
  connectorRestarts?: number;
  lastError?: string | null;
  updatedAt?: number;
};

type WecomRuntimeLogs = {
  gateway: string[];
  connector: string[];
};

type WecomRuntimeLogsResponse = {
  gateway: string[] | string;
  connector: string[] | string;
};

type DatabaseProfileOption = {
  id: string;
  name: string;
  driver: string;
  enabled: boolean;
};

type WecomRuntimeSendMessageResponse = {
  requestId: string;
  chatId: string;
  sentAt: number;
};

type Translate = (key: string) => string;

type WecomSectionProps = SettingsSectionProps & {
  onOpenRemote: () => void;
};

type MissingConfiguration = {
  fieldId?: string;
  label: string;
  openRemote?: boolean;
};

const RUNTIME_STATE_KEYS: Record<string, string> = {
  stopped: "settings.wecomRuntimeStopped",
  disabled: "settings.wecomRuntimeStopped",
  starting: "settings.wecomRuntimeStarting",
  waiting: "settings.wecomRuntimeWaiting",
  running: "settings.wecomRuntimeRunning",
  connected: "settings.wecomRuntimeRunning",
  restarting: "settings.wecomRuntimeRestarting",
  backoff: "settings.wecomRuntimeBackoff",
  degraded: "settings.wecomRuntimeDegraded",
  failed: "settings.wecomRuntimeFailed",
  error: "settings.wecomRuntimeFailed",
};

function runtimeStateLabel(state: string | null | undefined, t: Translate) {
  const normalized = state?.trim().toLowerCase() ?? "";
  return normalized
    ? t(RUNTIME_STATE_KEYS[normalized] ?? normalized)
    : t("settings.wecomRuntimeUnknown");
}

function runtimeStateClasses(state: string | null | undefined) {
  const normalized = state?.trim().toLowerCase();
  if (normalized === "running" || normalized === "connected") {
    return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  if (
    normalized === "starting" ||
    normalized === "waiting" ||
    normalized === "restarting" ||
    normalized === "backoff"
  ) {
    return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
  }
  if (normalized === "failed" || normalized === "error" || normalized === "degraded") {
    return "bg-destructive/10 text-destructive";
  }
  return "bg-muted/50 text-muted-foreground";
}

function isRuntimeReadyState(state: string | null | undefined) {
  const normalized = state?.trim().toLowerCase();
  return normalized === "running" || normalized === "connected";
}

function formatRuntimeTimestamp(value?: number | null) {
  if (!value) return "N/A";
  return new Date(value > 1_000_000_000_000 ? value : value * 1000).toLocaleString();
}

function normalizeRuntimeLogLines(value: string[] | string | null | undefined) {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" && value ? value.split(/\r?\n/) : [];
}

function parseAccessList(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function formatAccessList(value: readonly string[]) {
  return value.join(", ");
}

function updateWecomSettings(
  setSettings: SettingsSectionProps["setSettings"],
  patch: Partial<AppSettings["wecom"]>,
) {
  setSettings((prev) => ({
    ...prev,
    wecom: {
      ...prev.wecom,
      ...patch,
    },
  }));
}

function SecretInput(props: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        id={props.id}
        type={visible ? "text" : "password"}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        autoComplete="new-password"
        className="pr-10 font-mono text-[13px]"
      />
      <button
        type="button"
        title={visible ? "Hide secret" : "Show secret"}
        aria-label={visible ? "Hide secret" : "Show secret"}
        onClick={() => setVisible((previous) => !previous)}
        className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function generateChannelToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function WecomSection(props: WecomSectionProps) {
  const { settings, setSettings, onOpenRemote } = props;
  const { t } = useLocale();
  const [secretDraft, setSecretDraft] = useState("");
  const [channelTokenDraft, setChannelTokenDraft] = useState("");
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<WecomRuntimeStatus | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [runtimeActionError, setRuntimeActionError] = useState<string | null>(null);
  const [restartingRuntime, setRestartingRuntime] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [runtimeLogs, setRuntimeLogs] = useState<WecomRuntimeLogs | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [sendPanelOpen, setSendPanelOpen] = useState(false);
  const [sendChatId, setSendChatId] = useState("");
  const [sendContent, setSendContent] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [sendMessageError, setSendMessageError] = useState<string | null>(null);
  const [sendMessageResult, setSendMessageResult] =
    useState<WecomRuntimeSendMessageResponse | null>(null);
  const [accessRuleDraft, setAccessRuleDraft] = useState<WeComAccessRuleDraft | null>(null);
  const [databaseProfiles, setDatabaseProfiles] = useState<DatabaseProfileOption[]>([]);
  const [databaseProfilesLoading, setDatabaseProfilesLoading] = useState(true);

  const gatewayUrl = settings.remote.gatewayUrl.trim();
  const isLocalMode = settings.wecom.gatewayMode === "local";
  const runtimeGatewayUrl =
    runtimeStatus?.localGatewayUrl?.trim() || runtimeStatus?.gatewayUrl?.trim();
  const localGatewayUrl =
    runtimeStatus?.mode === "local" && runtimeGatewayUrl
      ? runtimeGatewayUrl
      : `http://127.0.0.1:${settings.wecom.localGatewayPort}`;
  const runtimeCanSendMessage =
    !runtimeLoading &&
    isRuntimeReadyState(runtimeStatus?.overall) &&
    isRuntimeReadyState(runtimeStatus?.gatewayState) &&
    isRuntimeReadyState(runtimeStatus?.connectorState);
  const missingConfiguration = useMemo<MissingConfiguration | null>(() => {
    if (!settings.wecom.botId.trim()) {
      return { fieldId: "wecom-bot-id", label: t("settings.wecomMissingBotId") };
    }
    if (!settings.wecom.secretConfigured) {
      return { fieldId: "wecom-secret", label: t("settings.wecomMissingSecret") };
    }
    if (!isLocalMode) {
      if (!settings.remote.enabled) {
        return {
          label: t("settings.wecomRemoteDisabled"),
          openRemote: true,
        };
      }
      if (!gatewayUrl) {
        return { fieldId: "wecom-gateway-url", label: t("settings.wecomMissingGateway") };
      }
      if (!isSupportedGatewayUrl(gatewayUrl)) {
        return { fieldId: "wecom-gateway-url", label: t("settings.wecomInvalidGateway") };
      }
      if (!settings.remote.token.trim()) {
        return {
          label: t("settings.wecomMissingAgentToken"),
          openRemote: true,
        };
      }
      if (!settings.wecom.channelTokenConfigured) {
        return { fieldId: "wecom-channel-token", label: t("settings.wecomMissingChannelToken") };
      }
    }
    return null;
  }, [
    gatewayUrl,
    isLocalMode,
    settings.remote.enabled,
    settings.remote.token,
    settings.wecom.botId,
    settings.wecom.channelTokenConfigured,
    settings.wecom.secretConfigured,
    t,
  ]);
  const connectorReady = missingConfiguration === null;

  const replaceAccessRules = useCallback(
    (rules: readonly WeComAccessRule[]) => {
      updateWecomSettings(setSettings, { accessPolicy: { rules } });
    },
    [setSettings],
  );

  const addAccessRule = useCallback(() => {
    setAccessRuleDraft(createWeComAccessRuleDraft(settings.wecom.tenantId, settings.wecom.botId));
  }, [settings.wecom.botId, settings.wecom.tenantId]);

  const updateAccessRuleDraft = useCallback((patch: Partial<WeComAccessRuleDraft>) => {
    setAccessRuleDraft((current) => (current ? editWeComAccessRuleDraft(current, patch) : current));
  }, []);

  const saveAccessRuleDraft = useCallback(() => {
    if (!accessRuleDraft) return;
    const accessPolicy = commitWeComAccessRuleDraft(settings.wecom.accessPolicy, accessRuleDraft);
    if (!accessPolicy) return;
    updateWecomSettings(setSettings, { accessPolicy });
    setAccessRuleDraft(null);
  }, [accessRuleDraft, setSettings, settings.wecom.accessPolicy]);

  const updateAccessRule = useCallback(
    (index: number, patch: Partial<WeComAccessRule>) => {
      replaceAccessRules(
        settings.wecom.accessPolicy.rules.map((rule, ruleIndex) =>
          ruleIndex === index ? { ...rule, ...patch } : rule,
        ),
      );
    },
    [replaceAccessRules, settings.wecom.accessPolicy.rules],
  );

  const removeAccessRule = useCallback(
    (index: number) => {
      replaceAccessRules(
        settings.wecom.accessPolicy.rules.filter((_, ruleIndex) => ruleIndex !== index),
      );
    },
    [replaceAccessRules, settings.wecom.accessPolicy.rules],
  );

  const toggleAccessScope = useCallback(
    (index: number, scope: WeComAccessScope) => {
      const rule = settings.wecom.accessPolicy.rules[index];
      if (!rule) return;
      const scopes = rule.scopes.includes(scope)
        ? rule.scopes.filter((item) => item !== scope)
        : [...rule.scopes, scope];
      updateAccessRule(index, { scopes });
    },
    [settings.wecom.accessPolicy.rules, updateAccessRule],
  );

  const toggleAccessDatabaseProfile = useCallback(
    (index: number, profileId: string) => {
      const rule = settings.wecom.accessPolicy.rules[index];
      if (!rule) return;
      const allowedDatabaseProfileIds = rule.allowedDatabaseProfileIds.includes(profileId)
        ? rule.allowedDatabaseProfileIds.filter((item) => item !== profileId)
        : [...rule.allowedDatabaseProfileIds, profileId];
      updateAccessRule(index, { allowedDatabaseProfileIds });
    },
    [settings.wecom.accessPolicy.rules, updateAccessRule],
  );

  const refreshRuntimeStatus = useCallback(async () => {
    setRuntimeLoading(true);
    try {
      const status = await invoke<WecomRuntimeStatus>("wecom_runtime_status");
      setRuntimeStatus(status);
      setRuntimeActionError(null);
    } catch (error) {
      setRuntimeActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshRuntimeStatus();
  }, [refreshRuntimeStatus]);

  useEffect(() => {
    let active = true;
    void invoke<DatabaseProfileOption[]>("database_profiles_list")
      .then((profiles) => {
        if (active) setDatabaseProfiles(profiles);
      })
      .catch(() => {
        if (active) setDatabaseProfiles([]);
      })
      .finally(() => {
        if (active) setDatabaseProfilesLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;
    void listen<WecomRuntimeStatus>("wecom-runtime:status", (event) => {
      if (cancelled) return;
      setRuntimeStatus(event.payload);
      setRuntimeLoading(false);
      setRuntimeActionError(null);
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        dispose = unlisten;
      })
      .catch((error) => {
        if (!cancelled) {
          setRuntimeActionError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  const restartRuntime = useCallback(async () => {
    setRestartingRuntime(true);
    setRuntimeActionError(null);
    try {
      const status = await invoke<WecomRuntimeStatus | null>("wecom_runtime_restart");
      if (status) {
        setRuntimeStatus(status);
      } else {
        await refreshRuntimeStatus();
      }
    } catch (error) {
      setRuntimeActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setRestartingRuntime(false);
    }
  }, [refreshRuntimeStatus]);

  const loadRuntimeLogs = useCallback(async () => {
    setLogsLoading(true);
    setRuntimeActionError(null);
    try {
      const logs = await invoke<WecomRuntimeLogsResponse>("wecom_runtime_logs");
      setRuntimeLogs({
        gateway: normalizeRuntimeLogLines(logs.gateway),
        connector: normalizeRuntimeLogLines(logs.connector),
      });
    } catch (error) {
      setRuntimeActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const toggleRuntimeLogs = useCallback(() => {
    setLogsOpen((previous) => {
      const next = !previous;
      if (next) void loadRuntimeLogs();
      return next;
    });
  }, [loadRuntimeLogs]);

  const sendRuntimeMessage = useCallback(async () => {
    const chatId = sendChatId.trim();
    const content = sendContent.trim();
    if (!runtimeCanSendMessage || !chatId || !content || sendingMessage) return;

    setSendingMessage(true);
    setSendMessageError(null);
    setSendMessageResult(null);
    try {
      const result = await invoke<WecomRuntimeSendMessageResponse>("wecom_runtime_send_message", {
        request: { chatId, content },
      });
      setSendMessageResult(result);
      setSendContent("");
    } catch (error) {
      setSendMessageError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingMessage(false);
    }
  }, [runtimeCanSendMessage, sendChatId, sendContent, sendingMessage]);

  const closeSendPanel = useCallback(() => {
    if (sendingMessage) return;
    setSendPanelOpen(false);
    setSendChatId("");
    setSendContent("");
    setSendMessageError(null);
    setSendMessageResult(null);
  }, [sendingMessage]);

  const setGatewayMode = useCallback(
    (gatewayMode: WecomGatewayMode) => {
      if (gatewayMode === "local") setChannelTokenDraft("");
      updateWecomSettings(setSettings, { gatewayMode });
    },
    [setSettings],
  );

  const focusMissingConfiguration = useCallback(() => {
    if (!missingConfiguration) return;
    if (missingConfiguration.openRemote) {
      onOpenRemote();
      return;
    }
    if (!missingConfiguration.fieldId) return;
    const element = document.getElementById(missingConfiguration.fieldId);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (element instanceof HTMLInputElement) element.focus();
  }, [missingConfiguration, onOpenRemote]);

  const handleActivationToggle = useCallback(() => {
    if (settings.wecom.enabled) {
      updateWecomSettings(setSettings, { enabled: false });
      return;
    }
    if (!connectorReady) {
      focusMissingConfiguration();
      return;
    }
    updateWecomSettings(setSettings, { enabled: true });
  }, [connectorReady, focusMissingConfiguration, setSettings, settings.wecom.enabled]);

  const saveCredentials = useCallback(async () => {
    const secretUpdate = secretDraft.trim();
    const channelTokenUpdate = isLocalMode ? "" : channelTokenDraft.trim();
    if (!secretUpdate && !channelTokenUpdate) return;

    setSavingCredentials(true);
    setCredentialError(null);
    try {
      const payload: WecomWritePayload = {
        ...settings.wecom,
        ...(secretUpdate ? { secretUpdate } : {}),
        ...(channelTokenUpdate ? { channelTokenUpdate } : {}),
      };
      const saved = await invoke<WecomSettings>("settings_save_wecom", { payload });
      updateWecomSettings(setSettings, saved);
      setSecretDraft("");
      setChannelTokenDraft("");
    } catch (error) {
      setCredentialError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingCredentials(false);
    }
  }, [channelTokenDraft, isLocalMode, secretDraft, setSettings, settings.wecom]);

  const clearCredential = useCallback(
    async (kind: "secret" | "channelToken") => {
      setSavingCredentials(true);
      setCredentialError(null);
      try {
        const payload: WecomWritePayload = {
          ...settings.wecom,
          ...(kind === "secret" ? { secretUpdate: null } : { channelTokenUpdate: null }),
        };
        const saved = await invoke<WecomSettings>("settings_save_wecom", { payload });
        updateWecomSettings(setSettings, saved);
        if (kind === "secret") setSecretDraft("");
        if (kind === "channelToken") setChannelTokenDraft("");
      } catch (error) {
        setCredentialError(error instanceof Error ? error.message : String(error));
      } finally {
        setSavingCredentials(false);
      }
    },
    [setSettings, settings.wecom],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10">
            <Bot className="h-[18px] w-[18px] text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t("settings.wecomTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("settings.wecomDesc")}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            disabled={connectorReady}
            onClick={focusMissingConfiguration}
            title={connectorReady ? t("settings.wecomReady") : missingConfiguration?.label}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
              connectorReady
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
          >
            {connectorReady ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Shield className="h-3.5 w-3.5" />
            )}
            <span>
              {connectorReady
                ? t("settings.wecomReady")
                : (missingConfiguration?.label ?? t("settings.wecomNotReady"))}
            </span>
          </button>
          <AgentActivationSwitch
            checked={settings.wecom.enabled}
            title={
              settings.wecom.enabled
                ? t("settings.wecomDisable")
                : connectorReady
                  ? t("settings.wecomEnable")
                  : (missingConfiguration?.label ?? t("settings.wecomNotReady"))
            }
            onToggle={handleActivationToggle}
          />
        </div>
      </div>

      {
        <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
              <Activity className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t("settings.wecomRuntime")}
              <span
                className={`rounded-md px-2 py-1 text-[11px] font-medium ${runtimeStateClasses(
                  runtimeLoading ? "starting" : runtimeStatus?.overall,
                )}`}
              >
                {runtimeLoading
                  ? t("settings.wecomRuntimeLoading")
                  : runtimeStateLabel(runtimeStatus?.overall, t)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!runtimeCanSendMessage}
                aria-expanded={sendPanelOpen}
                title={
                  runtimeCanSendMessage
                    ? t("settings.wecomSendMessage")
                    : t("settings.wecomSendMessageUnavailable")
                }
                onClick={() => {
                  setSendPanelOpen(true);
                  setSendMessageError(null);
                  setSendMessageResult(null);
                }}
              >
                <Send className="h-3.5 w-3.5" />
                {t("settings.wecomSendMessage")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={toggleRuntimeLogs}>
                <FileText className="h-3.5 w-3.5" />
                {logsOpen ? t("settings.wecomHideLogs") : t("settings.wecomShowLogs")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={restartingRuntime}
                onClick={() => void restartRuntime()}
              >
                {restartingRuntime ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {restartingRuntime
                  ? t("settings.wecomRuntimeRestarting")
                  : t("settings.wecomRestartRuntime")}
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {[
              {
                key: "gateway",
                label: isLocalMode
                  ? t("settings.wecomLocalGatewayProcess")
                  : t("settings.wecomExternalGatewayConnection"),
                icon: Server,
                state: runtimeStatus?.gatewayState,
                pid: runtimeStatus?.gatewayPid,
                restarts: runtimeStatus?.gatewayRestarts ?? 0,
              },
              {
                key: "connector",
                label: t("settings.wecomConnectorProcess"),
                icon: Terminal,
                state: runtimeStatus?.connectorState,
                pid: runtimeStatus?.connectorPid,
                restarts: runtimeStatus?.connectorRestarts ?? 0,
              },
            ].map((process) => {
              const ProcessIcon = process.icon;
              return (
                <div key={process.key} className="min-w-0 rounded-lg bg-muted/30 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
                      <ProcessIcon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{process.label}</span>
                    </div>
                    <span
                      className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium ${runtimeStateClasses(
                        process.state,
                      )}`}
                    >
                      {runtimeStateLabel(process.state, t)}
                    </span>
                  </div>
                  <div className="mt-2 flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground/80">
                    {process.pid ? <span>PID {process.pid}</span> : null}
                    {process.restarts > 0 ? (
                      <span>
                        {t("settings.wecomRuntimeRestartCount").replace(
                          "{count}",
                          String(process.restarts),
                        )}
                      </span>
                    ) : null}
                    {!process.pid && process.restarts === 0 ? (
                      <span>{t("settings.wecomRuntimeNoProcessDetails")}</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground/70">
            <span>
              {isLocalMode
                ? t("settings.wecomRuntimeEndpoint").replace("{url}", localGatewayUrl)
                : t("settings.wecomRuntimeExternalHint")}
            </span>
            <span>
              {t("settings.wecomRuntimeUpdatedAt").replace(
                "{time}",
                formatRuntimeTimestamp(runtimeStatus?.updatedAt),
              )}
            </span>
          </div>

          {runtimeActionError || runtimeStatus?.lastError ? (
            <p className="whitespace-pre-wrap break-words rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {runtimeActionError || runtimeStatus?.lastError}
            </p>
          ) : null}

          {sendPanelOpen ? (
            <div className="space-y-3 border-t border-border/60 pt-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Send className="h-3.5 w-3.5" />
                {t("settings.wecomSendPanelTitle")}
              </div>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
                <div className="space-y-1.5">
                  <label
                    htmlFor="wecom-send-chat-id"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("settings.wecomSendTargetId")}
                  </label>
                  <Input
                    id="wecom-send-chat-id"
                    value={sendChatId}
                    disabled={sendingMessage}
                    autoComplete="off"
                    placeholder={t("settings.wecomSendTargetIdPlaceholder")}
                    onChange={(event) => {
                      setSendChatId(event.target.value);
                      setSendMessageError(null);
                      setSendMessageResult(null);
                    }}
                    className="font-mono text-[13px]"
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                    {t("settings.wecomSendTargetIdHint")}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="wecom-send-content"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("settings.wecomSendMarkdown")}
                  </label>
                  <Textarea
                    id="wecom-send-content"
                    value={sendContent}
                    disabled={sendingMessage}
                    rows={4}
                    placeholder={t("settings.wecomSendMarkdownPlaceholder")}
                    onChange={(event) => {
                      setSendContent(event.target.value);
                      setSendMessageError(null);
                      setSendMessageResult(null);
                    }}
                    className="min-h-24 resize-y text-[13px]"
                  />
                </div>
              </div>

              {sendMessageError ? (
                <p className="whitespace-pre-wrap break-words rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {sendMessageError}
                </p>
              ) : null}
              {sendMessageResult ? (
                <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                  <p>
                    {t("settings.wecomSendSuccess").replace("{chatId}", sendMessageResult.chatId)}
                  </p>
                  <p className="mt-1 font-mono text-[11px] opacity-80">
                    {t("settings.wecomSendSuccessDetails")
                      .replace("{requestId}", sendMessageResult.requestId)
                      .replace("{time}", formatRuntimeTimestamp(sendMessageResult.sentAt))}
                  </p>
                </div>
              ) : null}

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={sendingMessage}
                  onClick={closeSendPanel}
                >
                  {t("settings.wecomSendCancel")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    sendingMessage ||
                    !runtimeCanSendMessage ||
                    !sendChatId.trim() ||
                    !sendContent.trim()
                  }
                  onClick={() => void sendRuntimeMessage()}
                >
                  {sendingMessage ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  {sendingMessage
                    ? t("settings.wecomSendingMessage")
                    : t("settings.wecomSendSubmit")}
                </Button>
              </div>
            </div>
          ) : null}

          {logsOpen ? (
            <div className="space-y-3 border-t border-border/60 pt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-medium text-muted-foreground">
                  {t("settings.wecomRuntimeLogs")}
                </div>
                <button
                  type="button"
                  disabled={logsLoading}
                  title={t("settings.wecomRefreshLogs")}
                  aria-label={t("settings.wecomRefreshLogs")}
                  onClick={() => void loadRuntimeLogs()}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  {logsLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {[
                  {
                    key: "gateway",
                    label: t("settings.wecomGatewayLog"),
                    lines: runtimeLogs?.gateway ?? [],
                  },
                  {
                    key: "connector",
                    label: t("settings.wecomConnectorLog"),
                    lines: runtimeLogs?.connector ?? [],
                  },
                ].map((log) => (
                  <div key={log.key} className="min-w-0 space-y-1.5">
                    <div className="text-[11px] font-medium text-muted-foreground">{log.label}</div>
                    <pre className="h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-[11px] leading-5 text-muted-foreground">
                      {logsLoading && !runtimeLogs
                        ? t("settings.wecomRuntimeLogsLoading")
                        : log.lines.join("\n") || t("settings.wecomRuntimeLogsEmpty")}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      }

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Bot className="h-4 w-4 text-muted-foreground" />
          {t("settings.wecomConnection")}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-muted-foreground">
            {t("settings.wecomGatewayMode")}
          </legend>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/50 p-1">
            {(["local", "external"] as const).map((mode) => {
              const active = settings.wecom.gatewayMode === mode;
              const ModeIcon = mode === "local" ? Server : Cloud;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setGatewayMode(mode)}
                  className={`flex min-h-9 min-w-0 items-center justify-center gap-2 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <ModeIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    {t(`settings.wecomGatewayMode${mode === "local" ? "Local" : "External"}`)}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {isLocalMode
              ? t("settings.wecomGatewayModeLocalHint")
              : t("settings.wecomGatewayModeExternalHint")}
          </p>
        </fieldset>

        <div className="space-y-1.5">
          <label
            htmlFor="wecom-bot-id"
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
          >
            <Key className="h-3 w-3" />
            {t("settings.wecomBotId")}
          </label>
          <Input
            value={settings.wecom.botId}
            id="wecom-bot-id"
            onChange={(event) => updateWecomSettings(setSettings, { botId: event.target.value })}
            placeholder={t("settings.wecomBotIdPlaceholder")}
            autoComplete="off"
            className="font-mono text-[13px]"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {t("settings.wecomBotIdHint")}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="wecom-tenant-id" className="text-xs font-medium text-muted-foreground">
              {t("settings.wecomTenantId")}
            </label>
            <Input
              value={settings.wecom.tenantId}
              id="wecom-tenant-id"
              onChange={(event) =>
                updateWecomSettings(setSettings, { tenantId: event.target.value })
              }
              placeholder={t("settings.wecomTenantIdPlaceholder")}
              autoComplete="off"
              className="font-mono text-[13px]"
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="wecom-connector-id"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.wecomConnectorId")}
            </label>
            <Input
              value={settings.wecom.connectorId}
              id="wecom-connector-id"
              onChange={(event) =>
                updateWecomSettings(setSettings, { connectorId: event.target.value })
              }
              placeholder={t("settings.wecomConnectorIdPlaceholder")}
              autoComplete="off"
              className="font-mono text-[13px]"
            />
          </div>
        </div>

        {isLocalMode ? (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Server className="h-3 w-3" />
                {t("settings.wecomLocalGatewayAddress")}
              </div>
              <div className="flex h-9 items-center rounded-md border border-input bg-muted/30 px-3 font-mono text-[13px] text-muted-foreground">
                <span className="truncate">{localGatewayUrl}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                {t("settings.wecomLocalGatewayAddressHint")}
              </p>
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="wecom-local-gateway-port"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("settings.wecomLocalGatewayPort")}
              </label>
              <Input
                id="wecom-local-gateway-port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65_535}
                value={settings.wecom.localGatewayPort}
                onChange={(event) => {
                  const localGatewayPort = Number.parseInt(event.target.value, 10);
                  if (localGatewayPort >= 1 && localGatewayPort <= 65_535) {
                    updateWecomSettings(setSettings, { localGatewayPort });
                  }
                }}
                className="font-mono text-[13px]"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                {t("settings.wecomLocalGatewayPortHint")}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <label
              htmlFor="wecom-gateway-url"
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
            >
              <Cloud className="h-3 w-3" />
              {t("settings.wecomGateway")}
            </label>
            <Input
              id="wecom-gateway-url"
              type="url"
              value={settings.remote.gatewayUrl}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  remote: {
                    ...prev.remote,
                    gatewayUrl: event.target.value,
                  },
                }))
              }
              placeholder={t("settings.wecomGatewayPlaceholder")}
              autoComplete="url"
              className="font-mono text-[13px]"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground/70">
              {t("settings.wecomGatewayHint")}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Shield className="h-4 w-4 text-muted-foreground" />
          {t("settings.wecomCredentials")}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.wecomCredentialsHint")}
        </p>

        <div className="space-y-1.5">
          <label
            htmlFor="wecom-secret"
            className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground"
          >
            <span>{t("settings.wecomSecret")}</span>
            {settings.wecom.secretConfigured ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                {t("settings.wecomConfigured")}
              </span>
            ) : null}
          </label>
          <div className="flex items-center gap-2">
            <SecretInput
              id="wecom-secret"
              value={secretDraft}
              onChange={setSecretDraft}
              placeholder={
                settings.wecom.secretConfigured
                  ? t("settings.wecomSecretReplacePlaceholder")
                  : t("settings.wecomSecretPlaceholder")
              }
              ariaLabel={t("settings.wecomSecret")}
            />
            {settings.wecom.secretConfigured ? (
              <button
                type="button"
                title={t("settings.wecomClearSecret")}
                aria-label={t("settings.wecomClearSecret")}
                disabled={savingCredentials}
                onClick={() => void clearCredential("secret")}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>

        {!isLocalMode ? (
          <div className="space-y-1.5">
            <label
              htmlFor="wecom-channel-token"
              className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground"
            >
              <span>{t("settings.wecomChannelToken")}</span>
              {settings.wecom.channelTokenConfigured ? (
                <span className="text-emerald-600 dark:text-emerald-400">
                  {t("settings.wecomConfigured")}
                </span>
              ) : null}
            </label>
            <div className="flex items-center gap-2">
              <SecretInput
                id="wecom-channel-token"
                value={channelTokenDraft}
                onChange={setChannelTokenDraft}
                placeholder={
                  settings.wecom.channelTokenConfigured
                    ? t("settings.wecomChannelTokenReplacePlaceholder")
                    : t("settings.wecomChannelTokenPlaceholder")
                }
                ariaLabel={t("settings.wecomChannelToken")}
              />
              <button
                type="button"
                title={t("settings.wecomGenerateChannelToken")}
                aria-label={t("settings.wecomGenerateChannelToken")}
                onClick={() => setChannelTokenDraft(generateChannelToken())}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              {settings.wecom.channelTokenConfigured ? (
                <button
                  type="button"
                  title={t("settings.wecomClearChannelToken")}
                  aria-label={t("settings.wecomClearChannelToken")}
                  disabled={savingCredentials}
                  onClick={() => void clearCredential("channelToken")}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground/70">
              {t("settings.wecomChannelTokenHint")}
            </p>
          </div>
        ) : null}

        {credentialError ? (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {credentialError}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={
              savingCredentials ||
              (!secretDraft.trim() && (isLocalMode || !channelTokenDraft.trim()))
            }
            onClick={() => void saveCredentials()}
          >
            <Save className="h-3.5 w-3.5" />
            {savingCredentials ? t("settings.wecomSaving") : t("settings.wecomSaveCredentials")}
          </Button>
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          {t("settings.wecomMessagePolicy")}
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t("settings.wecomAllowGroupMessages")}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t("settings.wecomAllowGroupMessagesHint")}
            </p>
          </div>
          <AgentActivationSwitch
            checked={settings.wecom.allowGroupMessages}
            title={t("settings.wecomAllowGroupMessages")}
            onToggle={() =>
              updateWecomSettings(setSettings, {
                allowGroupMessages: !settings.wecom.allowGroupMessages,
              })
            }
          />
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Shield className="h-4 w-4 text-muted-foreground" />
            {t("settings.wecomAccessControl")}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={accessRuleDraft !== null}
            onClick={addAccessRule}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("settings.wecomAddAccessRule")}
          </Button>
        </div>

        {settings.wecom.accessPolicy.rules.length === 0 && accessRuleDraft === null ? (
          <div className="border-t border-border/60 py-6 text-center text-xs text-muted-foreground">
            {t("settings.wecomAccessControlEmpty")}
          </div>
        ) : (
          <div className="divide-y divide-border/60 border-t border-border/60">
            {accessRuleDraft ? (
              <div className="space-y-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("settings.wecomAccessRule").replace(
                      "{index}",
                      String(settings.wecom.accessPolicy.rules.length + 1),
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!isCompleteWeComAccessRuleDraft(accessRuleDraft)}
                      onClick={saveAccessRuleDraft}
                    >
                      <Save className="h-3.5 w-3.5" />
                      {t("settings.save")}
                    </Button>
                    <button
                      type="button"
                      title={t("settings.wecomRemoveAccessRule")}
                      aria-label={t("settings.wecomRemoveAccessRule")}
                      onClick={() => setAccessRuleDraft(null)}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-3">
                  {[
                    {
                      key: "tenantId",
                      label: t("settings.wecomAccessTenantId"),
                      value: accessRuleDraft.tenantId,
                    },
                    {
                      key: "botId",
                      label: t("settings.wecomAccessBotId"),
                      value: accessRuleDraft.botId,
                    },
                    {
                      key: "externalUserId",
                      label: t("settings.wecomAccessUserId"),
                      value: accessRuleDraft.externalUserId,
                    },
                  ].map((field) => (
                    <div key={field.key} className="space-y-1.5">
                      <label
                        htmlFor={`wecom-access-draft-${field.key}`}
                        className="text-xs font-medium text-muted-foreground"
                      >
                        {field.label}
                      </label>
                      <Input
                        id={`wecom-access-draft-${field.key}`}
                        value={field.value}
                        onChange={(event) =>
                          updateAccessRuleDraft({ [field.key]: event.target.value })
                        }
                        autoComplete="off"
                        className="font-mono text-[13px]"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {settings.wecom.accessPolicy.rules.map((rule, index) => (
              <div
                // Policy rows have no persisted UI identity and are replaced as a complete list.
                // biome-ignore lint/suspicious/noArrayIndexKey: the index disambiguates duplicate exact-match grants
                key={`${rule.tenantId}:${rule.botId}:${rule.externalUserId}:${index}`}
                className="space-y-4 py-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("settings.wecomAccessRule").replace("{index}", String(index + 1))}
                  </span>
                  <div className="flex items-center gap-2">
                    <AgentActivationSwitch
                      checked={rule.enabled}
                      title={t("settings.wecomAccessRuleEnabled")}
                      onToggle={() => updateAccessRule(index, { enabled: !rule.enabled })}
                    />
                    <button
                      type="button"
                      title={t("settings.wecomRemoveAccessRule")}
                      aria-label={t("settings.wecomRemoveAccessRule")}
                      onClick={() => removeAccessRule(index)}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-3">
                  {[
                    {
                      key: "tenantId",
                      label: t("settings.wecomAccessTenantId"),
                      value: rule.tenantId,
                    },
                    {
                      key: "botId",
                      label: t("settings.wecomAccessBotId"),
                      value: rule.botId,
                    },
                    {
                      key: "externalUserId",
                      label: t("settings.wecomAccessUserId"),
                      value: rule.externalUserId,
                    },
                  ].map((field) => (
                    <div key={field.key} className="space-y-1.5">
                      <label
                        htmlFor={`wecom-access-${field.key}-${index}`}
                        className="text-xs font-medium text-muted-foreground"
                      >
                        {field.label}
                      </label>
                      <Input
                        id={`wecom-access-${field.key}-${index}`}
                        value={field.value}
                        onChange={(event) =>
                          updateAccessRule(index, { [field.key]: event.target.value })
                        }
                        autoComplete="off"
                        className="font-mono text-[13px]"
                      />
                    </div>
                  ))}
                </div>

                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium text-muted-foreground">
                    {t("settings.wecomAccessScopes")}
                  </legend>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {[
                      ["tool:read", "settings.wecomAccessScopeTools"],
                      ["skill:use", "settings.wecomAccessScopeSkills"],
                      ["database:read", "settings.wecomAccessScopeDatabase"],
                      ["mcp:invoke", "settings.wecomAccessScopeMcp"],
                    ].map(([scope, label]) => (
                      <label
                        key={scope}
                        className="flex items-center gap-2 text-xs text-foreground"
                      >
                        <input
                          type="checkbox"
                          checked={rule.scopes.includes(scope as WeComAccessScope)}
                          onChange={() => toggleAccessScope(index, scope as WeComAccessScope)}
                          className="h-4 w-4 rounded border-input accent-primary"
                        />
                        {t(label)}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    {
                      key: "allowedToolNames",
                      label: t("settings.wecomAllowedTools"),
                      value: rule.allowedToolNames,
                    },
                    {
                      key: "allowedSkillNames",
                      label: t("settings.wecomAllowedSkills"),
                      value: rule.allowedSkillNames,
                    },
                    {
                      key: "allowedSkillBaseDirs",
                      label: t("settings.wecomAllowedSkillDirs"),
                      value: rule.allowedSkillBaseDirs,
                    },
                    {
                      key: "allowedMcpServerIds",
                      label: t("settings.wecomAllowedMcpServers"),
                      value: rule.allowedMcpServerIds,
                    },
                  ].map((field) => (
                    <div key={field.key} className="space-y-1.5">
                      <label
                        htmlFor={`wecom-access-${field.key}-${index}`}
                        className="text-xs font-medium text-muted-foreground"
                      >
                        {field.label}
                      </label>
                      <Input
                        id={`wecom-access-${field.key}-${index}`}
                        value={formatAccessList(field.value)}
                        onChange={(event) => {
                          const values = parseAccessList(event.target.value);
                          updateAccessRule(index, {
                            [field.key]: values,
                            ...(field.key === "allowedSkillNames" &&
                            !values.includes(rule.defaultSkillName)
                              ? { defaultSkillName: "" }
                              : {}),
                          });
                        }}
                        placeholder={t("settings.wecomAccessListPlaceholder")}
                        autoComplete="off"
                        className="font-mono text-[13px]"
                      />
                    </div>
                  ))}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="space-y-1.5" htmlFor={`wecom-default-skill-${index}`}>
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("settings.wecomDefaultSkill")}
                    </span>
                    <select
                      id={`wecom-default-skill-${index}`}
                      value={rule.defaultSkillName}
                      onChange={(event) =>
                        updateAccessRule(index, { defaultSkillName: event.target.value })
                      }
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-[13px] text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <option value="">{t("settings.wecomDefaultSkillNone")}</option>
                      {rule.allowedSkillNames.map((skillName) => (
                        <option key={skillName} value={skillName}>
                          {skillName}
                        </option>
                      ))}
                    </select>
                    <span className="block text-[11px] leading-relaxed text-muted-foreground">
                      {t("settings.wecomDefaultSkillHint")}
                    </span>
                  </label>

                  <fieldset className="space-y-2">
                    <legend className="text-xs font-medium text-muted-foreground">
                      {t("settings.wecomAllowedDatabaseProfiles")}
                    </legend>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {t("settings.wecomAllowedDatabaseProfilesHint")}
                    </p>
                    {databaseProfilesLoading ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t("settings.wecomDatabaseProfilesLoading")}
                      </div>
                    ) : databaseProfiles.some((profile) => profile.enabled) ? (
                      <div className="max-h-36 space-y-2 overflow-y-auto rounded-md border border-border/60 p-2.5">
                        {databaseProfiles
                          .filter((profile) => profile.enabled)
                          .map((profile) => (
                            <label
                              key={profile.id}
                              className="flex items-start gap-2 text-xs text-foreground"
                            >
                              <input
                                type="checkbox"
                                checked={rule.allowedDatabaseProfileIds.includes(profile.id)}
                                onChange={() => toggleAccessDatabaseProfile(index, profile.id)}
                                className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                              />
                              <span className="min-w-0">
                                <span className="block truncate">{profile.name}</span>
                                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                                  {profile.driver} · {profile.id}
                                </span>
                              </span>
                            </label>
                          ))}
                        {rule.allowedDatabaseProfileIds
                          .filter(
                            (profileId) =>
                              !databaseProfiles.some(
                                (profile) => profile.enabled && profile.id === profileId,
                              ),
                          )
                          .map((profileId) => (
                            <label
                              key={profileId}
                              className="flex items-start gap-2 text-xs text-muted-foreground"
                            >
                              <input
                                type="checkbox"
                                checked
                                onChange={() => toggleAccessDatabaseProfile(index, profileId)}
                                className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                              />
                              <span className="min-w-0 truncate font-mono">
                                {profileId} ({t("settings.wecomDatabaseProfileUnavailable")})
                              </span>
                            </label>
                          ))}
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <Input
                          id={`wecom-access-allowedDatabaseProfileIds-${index}`}
                          value={formatAccessList(rule.allowedDatabaseProfileIds)}
                          onChange={(event) =>
                            updateAccessRule(index, {
                              allowedDatabaseProfileIds: parseAccessList(event.target.value),
                            })
                          }
                          placeholder={t("settings.wecomAccessListPlaceholder")}
                          autoComplete="off"
                          className="font-mono text-[13px]"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          {t("settings.wecomDatabaseProfilesEmpty")}
                        </p>
                      </div>
                    )}
                  </fieldset>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
