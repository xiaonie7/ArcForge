import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import {
  CheckCircle2,
  Database,
  Key,
  Loader2,
  Pencil,
  Play,
  Plus,
  Shield,
  Trash2,
  X,
  XCircle,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useLocale } from "../../i18n";
import { createUuid } from "../../lib/shared/id";
import { AgentActivationSwitch, ConfirmDeletePopover, PromptTag } from "./shared";

export type DatabaseDriver = "sqlite" | "postgresql" | "mysql";

export type DatabaseProfile = {
  id: string;
  name: string;
  driver: DatabaseDriver;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  sslMode: string;
  sqlitePath: string;
  enabled: boolean;
  allowWrites: boolean;
  queryTimeoutMs: number;
  maxRows: number;
  maxAffectedRows: number;
  passwordConfigured: boolean;
};

type DatabaseProfileDraft = DatabaseProfile & {
  password: string;
  clearPassword: boolean;
};

type OperationStatus = {
  kind: "success" | "error" | "info";
  message: string;
};

const DEFAULT_PROFILE: Omit<DatabaseProfile, "id"> = {
  name: "",
  driver: "postgresql",
  host: "127.0.0.1",
  port: 5432,
  databaseName: "",
  username: "",
  sslMode: "prefer",
  sqlitePath: "",
  enabled: true,
  allowWrites: false,
  queryTimeoutMs: 15_000,
  maxRows: 200,
  maxAffectedRows: 100,
  passwordConfigured: false,
};

function newDraft(profile?: DatabaseProfile): DatabaseProfileDraft {
  return {
    ...(profile ?? { id: createUuid(), ...DEFAULT_PROFILE }),
    password: "",
    clearPassword: false,
  };
}

function backendErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      /^DB_[A-Z_]+$/.test(code) &&
      typeof message === "string" &&
      message.trim()
    ) {
      return `${code}: ${message}`;
    }
  }
  if (typeof error === "string") {
    try {
      return backendErrorMessage(JSON.parse(error));
    } catch {
      return "DB_INTERNAL";
    }
  }
  return "DB_INTERNAL";
}

function profileEndpoint(profile: DatabaseProfile) {
  if (profile.driver === "sqlite") return profile.sqlitePath;
  return `${profile.host}:${profile.port}/${profile.databaseName}`;
}

function driverLabel(driver: DatabaseDriver) {
  if (driver === "postgresql") return "PostgreSQL";
  if (driver === "mysql") return "MySQL";
  return "SQLite";
}

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="space-y-1.5">
      <span className="text-xs font-medium text-foreground">{props.label}</span>
      <Input
        id={id}
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

function DatabaseProfileModal(props: {
  profile?: DatabaseProfile;
  saving: boolean;
  onSave: (draft: DatabaseProfileDraft) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(() => newDraft(props.profile));
  const [validationError, setValidationError] = useState("");

  function patch(values: Partial<DatabaseProfileDraft>) {
    setDraft((current) => ({ ...current, ...values }));
  }

  function setDriver(driver: DatabaseDriver) {
    const previousDefault =
      draft.driver === "postgresql" ? 5432 : draft.driver === "mysql" ? 3306 : 0;
    const nextDefault = driver === "postgresql" ? 5432 : driver === "mysql" ? 3306 : 0;
    patch({
      driver,
      port: draft.port === previousDefault || draft.port === 0 ? nextDefault : draft.port,
    });
  }

  function submit() {
    if (!draft.name.trim()) {
      setValidationError(t("settings.databaseRequired"));
      return;
    }
    if (draft.driver === "sqlite") {
      if (!draft.sqlitePath.trim()) {
        setValidationError(t("settings.databaseRequired"));
        return;
      }
    } else if (
      !draft.host.trim() ||
      !draft.databaseName.trim() ||
      !draft.username.trim() ||
      (draft.enabled && !draft.passwordConfigured && !draft.password.trim()) ||
      draft.port < 1 ||
      draft.port > 65_535
    ) {
      setValidationError(t("settings.databaseRequired"));
      return;
    }
    if (
      draft.queryTimeoutMs < 1_000 ||
      draft.queryTimeoutMs > 60_000 ||
      draft.maxRows < 1 ||
      draft.maxRows > 1_000 ||
      draft.maxAffectedRows < 1 ||
      draft.maxAffectedRows > 1_000
    ) {
      setValidationError(t("settings.databaseLimitsInvalid"));
      return;
    }
    setValidationError("");
    props.onSave(draft);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-5 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.profile ? t("settings.databaseEdit") : t("settings.databaseAdd")}
        className="settings-modal-panel flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h3 className="text-sm font-semibold">
              {props.profile ? t("settings.databaseEdit") : t("settings.databaseAdd")}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.databaseCredentialsHint")}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onClose}
            aria-label={t("settings.cancel")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-5 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label htmlFor="database-profile-name" className="space-y-1.5">
              <span className="text-xs font-medium">{t("settings.databaseName")}</span>
              <Input
                id="database-profile-name"
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder={t("settings.databaseNamePlaceholder")}
                autoFocus
              />
            </label>
            <label htmlFor="database-profile-driver" className="space-y-1.5">
              <span className="text-xs font-medium">{t("settings.databaseDriver")}</span>
              <select
                id="database-profile-driver"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={draft.driver}
                onChange={(event) => setDriver(event.target.value as DatabaseDriver)}
              >
                <option value="postgresql">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="sqlite">SQLite</option>
              </select>
            </label>
          </div>

          {draft.driver === "sqlite" ? (
            <label htmlFor="database-profile-sqlite-path" className="block space-y-1.5">
              <span className="text-xs font-medium">{t("settings.databaseSqlitePath")}</span>
              <Input
                id="database-profile-sqlite-path"
                value={draft.sqlitePath}
                onChange={(event) => patch({ sqlitePath: event.target.value })}
                placeholder="C:\\data\\app.sqlite"
              />
              <span className="block text-[11px] text-muted-foreground">
                {t("settings.databaseSqlitePathHint")}
              </span>
            </label>
          ) : (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-4">
                <label htmlFor="database-profile-host" className="space-y-1.5">
                  <span className="text-xs font-medium">{t("settings.databaseHost")}</span>
                  <Input
                    id="database-profile-host"
                    value={draft.host}
                    onChange={(event) => patch({ host: event.target.value })}
                  />
                </label>
                <NumberField
                  label={t("settings.databasePort")}
                  value={draft.port}
                  min={1}
                  max={65_535}
                  onChange={(port) => patch({ port })}
                />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label htmlFor="database-profile-database" className="space-y-1.5">
                  <span className="text-xs font-medium">{t("settings.databaseDatabase")}</span>
                  <Input
                    id="database-profile-database"
                    value={draft.databaseName}
                    onChange={(event) => patch({ databaseName: event.target.value })}
                  />
                </label>
                <label htmlFor="database-profile-username" className="space-y-1.5">
                  <span className="text-xs font-medium">{t("settings.databaseUsername")}</span>
                  <Input
                    id="database-profile-username"
                    value={draft.username}
                    onChange={(event) => patch({ username: event.target.value })}
                    autoComplete="off"
                  />
                </label>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label htmlFor="database-profile-password" className="space-y-1.5">
                  <span className="text-xs font-medium">{t("settings.databasePassword")}</span>
                  <Input
                    id="database-profile-password"
                    type="password"
                    value={draft.password}
                    disabled={draft.clearPassword}
                    onChange={(event) => patch({ password: event.target.value })}
                    placeholder={
                      draft.passwordConfigured
                        ? t("settings.databasePasswordKeep")
                        : t("settings.databasePasswordOptional")
                    }
                    autoComplete="new-password"
                  />
                </label>
                <label htmlFor="database-profile-ssl" className="space-y-1.5">
                  <span className="text-xs font-medium">SSL</span>
                  <select
                    id="database-profile-ssl"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={draft.sslMode}
                    onChange={(event) => patch({ sslMode: event.target.value })}
                  >
                    <option value="disable">{t("settings.databaseSslDisable")}</option>
                    <option value="prefer">{t("settings.databaseSslPrefer")}</option>
                    <option value="require">{t("settings.databaseSslRequire")}</option>
                    <option value="verify_ca">Verify CA</option>
                    <option value="verify_full">Verify Full</option>
                  </select>
                </label>
              </div>
              {draft.passwordConfigured ? (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={draft.clearPassword}
                    onChange={(event) =>
                      patch({ clearPassword: event.target.checked, password: "" })
                    }
                  />
                  {t("settings.databasePasswordClear")}
                </label>
              ) : null}
            </>
          )}

          <div className="grid grid-cols-1 gap-4 rounded-xl border border-border/60 bg-muted/20 p-4 sm:grid-cols-3">
            <NumberField
              label={t("settings.databaseTimeout")}
              value={draft.queryTimeoutMs / 1_000}
              min={1}
              max={60}
              onChange={(seconds) => patch({ queryTimeoutMs: Math.round(seconds * 1_000) })}
            />
            <NumberField
              label={t("settings.databaseMaxRows")}
              value={draft.maxRows}
              min={1}
              max={1_000}
              onChange={(maxRows) => patch({ maxRows })}
            />
            <NumberField
              label={t("settings.databaseMaxAffectedRows")}
              value={draft.maxAffectedRows}
              min={1}
              max={1_000}
              onChange={(maxAffectedRows) => patch({ maxAffectedRows })}
            />
          </div>

          <div className="space-y-3 rounded-xl border border-border/60 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-medium">{t("settings.databaseEnabled")}</div>
                <div className="text-[11px] text-muted-foreground">
                  {t("settings.databaseEnabledHint")}
                </div>
              </div>
              <AgentActivationSwitch
                checked={draft.enabled}
                title={t("settings.databaseEnabled")}
                onToggle={() => patch({ enabled: !draft.enabled })}
              />
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border/50 pt-3">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <Shield className="h-3.5 w-3.5 text-amber-500" />
                  {t("settings.databaseAllowWrites")}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {t("settings.databaseAllowWritesHint")}
                </div>
              </div>
              <AgentActivationSwitch
                checked={draft.allowWrites}
                title={t("settings.databaseAllowWrites")}
                onToggle={() => patch({ allowWrites: !draft.allowWrites })}
              />
            </div>
          </div>

          {validationError ? <p className="text-xs text-destructive">{validationError}</p> : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <Button variant="outline" onClick={props.onClose} disabled={props.saving}>
            {t("settings.cancel")}
          </Button>
          <Button onClick={submit} disabled={props.saving} className="gap-1.5">
            {props.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t("settings.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusLine({ status }: { status?: OperationStatus }) {
  if (!status) return null;
  const Icon = status.kind === "success" ? CheckCircle2 : status.kind === "error" ? XCircle : Key;
  return (
    <div
      className={`mt-3 flex items-start gap-1.5 text-xs ${
        status.kind === "error"
          ? "text-destructive"
          : status.kind === "success"
            ? "text-emerald-500"
            : "text-muted-foreground"
      }`}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{status.message}</span>
    </div>
  );
}

export function DatabaseSection() {
  const { t } = useLocale();
  const [profiles, setProfiles] = useState<DatabaseProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<DatabaseProfile | "new" | null>(null);
  const [status, setStatus] = useState<Record<string, OperationStatus>>({});
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    void invoke<DatabaseProfile[]>("database_profiles_list")
      .then((value) => {
        if (active) setProfiles(value);
      })
      .catch((error) => {
        if (active) setLoadError(backendErrorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function saveProfile(draft: DatabaseProfileDraft) {
    setSaving(true);
    try {
      const { password, clearPassword, ...profile } = draft;
      const saved = await invoke<DatabaseProfile>("database_profile_save", {
        input: {
          profile,
          passwordUpdate:
            profile.driver === "sqlite"
              ? undefined
              : clearPassword
                ? null
                : password
                  ? password
                  : undefined,
        },
      });
      setProfiles((current) => {
        const exists = current.some((item) => item.id === saved.id);
        return exists
          ? current.map((item) => (item.id === saved.id ? saved : item))
          : [...current, saved];
      });
      setStatus((current) => ({
        ...current,
        [saved.id]: { kind: "success", message: t("settings.databaseSaved") },
      }));
      setEditing(null);
    } catch (error) {
      setStatus((current) => ({
        ...current,
        [draft.id]: { kind: "error", message: backendErrorMessage(error) },
      }));
    } finally {
      setSaving(false);
    }
  }

  async function testProfile(profile: DatabaseProfile) {
    setTestingId(profile.id);
    setStatus((current) => ({
      ...current,
      [profile.id]: { kind: "info", message: t("settings.databaseTesting") },
    }));
    try {
      await invoke("database_profile_test", { profileId: profile.id });
      setStatus((current) => ({
        ...current,
        [profile.id]: { kind: "success", message: t("settings.databaseTestSuccess") },
      }));
    } catch (error) {
      setStatus((current) => ({
        ...current,
        [profile.id]: {
          kind: "error",
          message: t("settings.databaseTestFailed").replace("{error}", backendErrorMessage(error)),
        },
      }));
    } finally {
      setTestingId((current) => (current === profile.id ? null : current));
    }
  }

  async function deleteProfile(profile: DatabaseProfile) {
    try {
      await invoke("database_profile_delete", { profileId: profile.id });
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
      setStatus((current) => {
        const next = { ...current };
        delete next[profile.id];
        return next;
      });
    } catch (error) {
      setStatus((current) => ({
        ...current,
        [profile.id]: { kind: "error", message: backendErrorMessage(error) },
      }));
    }
  }

  return (
    <>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10">
              <Database className="h-[18px] w-[18px] text-cyan-500" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">{t("settings.databaseTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("settings.databaseDesc")}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditing("new")}>
            <Plus className="h-3.5 w-3.5" />
            {t("settings.databaseAdd")}
          </Button>
        </div>

        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">{t("settings.databaseSecurityTitle")}</span>{" "}
          {t("settings.databaseSecurityDesc")}
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("settings.databaseLoading")}
          </div>
        ) : loadError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        ) : profiles.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 bg-muted/20 py-14 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-500/10">
              <Database className="h-6 w-6 text-cyan-500" />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">{t("settings.databaseEmpty")}</p>
              <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                {t("settings.databaseEmptyHint")}
              </p>
            </div>
            <Button size="sm" className="gap-1.5" onClick={() => setEditing("new")}>
              <Plus className="h-3.5 w-3.5" />
              {t("settings.databaseAdd")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className="group rounded-xl border border-border/60 bg-card px-4 py-3 transition-colors hover:border-cyan-500/35"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10">
                    <Database className="h-4 w-4 text-cyan-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{profile.name}</span>
                      <PromptTag label={driverLabel(profile.driver)} />
                      <PromptTag
                        label={
                          profile.enabled
                            ? t("settings.databaseEnabled")
                            : t("settings.databaseDisabled")
                        }
                        muted={!profile.enabled}
                      />
                      {profile.allowWrites ? (
                        <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                          {t("settings.databaseWritesEnabled")}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {profileEndpoint(profile)}
                    </div>
                    <StatusLine status={status[profile.id]} />
                  </div>
                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title={t("settings.databaseTest")}
                      disabled={testingId === profile.id}
                      onClick={() => void testProfile(profile)}
                    >
                      {testingId === profile.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title={t("settings.edit")}
                      onClick={() => setEditing(profile)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <ConfirmDeletePopover
                      name={profile.name}
                      onConfirm={() => void deleteProfile(profile)}
                    >
                      {(open) => (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          title={t("settings.delete")}
                          onClick={open}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </ConfirmDeletePopover>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <DatabaseProfileModal
          profile={editing === "new" ? undefined : editing}
          saving={saving}
          onSave={(draft) => void saveProfile(draft)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
