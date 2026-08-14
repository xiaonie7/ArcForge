import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Clock3, X } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { useLocale } from "../../i18n";
import {
  DEFAULT_CRON_TIMEOUT_SECONDS,
  MAX_CRON_TIMEOUT_SECONDS,
  MIN_CRON_TIMEOUT_SECONDS,
  type Playbook,
  validateCronExpression,
} from "../../lib/automation";
import { useModalMotion } from "../../lib/shared/modalMotion";
import { cn } from "../../lib/shared/utils";

export type PlaybookScheduleData = {
  cron: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  remainingExecutions?: number;
  timeoutSeconds?: number;
};

export function PlaybookScheduleModal(props: {
  playbook: Playbook;
  onSave: (data: PlaybookScheduleData) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState(props.playbook.name);
  const [description, setDescription] = useState(props.playbook.description);
  const [cron, setCron] = useState("");
  const [remainingExecutions, setRemainingExecutions] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(DEFAULT_CRON_TIMEOUT_SECONDS));
  const [enabled, setEnabled] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [validatedCron, setValidatedCron] = useState<string | null>(null);
  const savingRef = useRef(false);
  const { isClosing, modalState, requestClose } = useModalMotion(props.onClose);

  function requestCloseIfIdle() {
    if (!savingRef.current) requestClose();
  }

  async function handleSave() {
    if (savingRef.current || isClosing) return;
    savingRef.current = true;
    try {
      setSaving(true);
      setFormError(null);
      const expression = cron.trim();
      if (!expression) throw new Error(t("scheduled.playbooksScheduleCronRequired"));
      await validateCronExpression(expression);
      setValidatedCron(expression);

      const remainingText = remainingExecutions.trim();
      const remaining = remainingText ? Number(remainingText) : undefined;
      if (remaining !== undefined && (!Number.isSafeInteger(remaining) || remaining < 0)) {
        throw new Error(t("settings.cronRemainingExecutionsInvalid"));
      }
      const timeout = Number(timeoutSeconds.trim() || DEFAULT_CRON_TIMEOUT_SECONDS);
      if (
        !Number.isSafeInteger(timeout) ||
        timeout < MIN_CRON_TIMEOUT_SECONDS ||
        timeout > MAX_CRON_TIMEOUT_SECONDS
      ) {
        throw new Error(t("settings.cronTimeoutSecondsInvalid"));
      }

      await props.onSave({
        cron: expression,
        name: name.trim() || undefined,
        description: description.trim(),
        enabled,
        remainingExecutions: remaining,
        timeoutSeconds: timeout,
      });
      requestClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("settings.cancel")}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        disabled={saving}
        onClick={requestCloseIfIdle}
      />
      <div className="settings-modal-panel relative z-10 flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
            <Clock3 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{t("scheduled.playbooksScheduleTitle")}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{props.playbook.name}</p>
          </div>
          <button
            type="button"
            onClick={requestCloseIfIdle}
            disabled={saving}
            title={t("settings.cancel")}
            aria-label={t("settings.cancel")}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="playbook-schedule-name">{t("scheduled.playbooksScheduleName")}</Label>
              <Input
                id="playbook-schedule-name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="playbook-schedule-cron">{t("scheduled.playbooksScheduleCron")}</Label>
              <Input
                id="playbook-schedule-cron"
                value={cron}
                className="font-mono"
                placeholder={t("settings.cronExpressionPlaceholder")}
                onChange={(event) => {
                  setFormError(null);
                  setValidatedCron(null);
                  setCron(event.currentTarget.value);
                }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="playbook-schedule-description">
              {t("scheduled.playbooksDescription")}
            </Label>
            <Input
              id="playbook-schedule-description"
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="playbook-schedule-remaining">
                {t("settings.cronRemainingExecutions")}
              </Label>
              <Input
                id="playbook-schedule-remaining"
                value={remainingExecutions}
                inputMode="numeric"
                placeholder={t("settings.cronRemainingExecutionsPlaceholder")}
                onChange={(event) => {
                  const value = event.currentTarget.value.trim();
                  if (value && !/^\d+$/.test(value)) return;
                  setRemainingExecutions(value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="playbook-schedule-timeout">{t("settings.cronTimeoutSeconds")}</Label>
              <Input
                id="playbook-schedule-timeout"
                value={timeoutSeconds}
                inputMode="numeric"
                onChange={(event) => {
                  const value = event.currentTarget.value.trim();
                  if (value && !/^\d+$/.test(value)) return;
                  setTimeoutSeconds(value);
                }}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/50 px-4 py-3">
            <div>
              <p className="text-sm font-medium">{t("scheduled.playbooksScheduleEnabled")}</p>
              <p className="text-xs text-muted-foreground">
                {t("scheduled.playbooksScheduleEnabledHint")}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              title={t("scheduled.playbooksScheduleEnabled")}
              onClick={() => setEnabled((value) => !value)}
              className={cn(
                "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors",
                enabled ? "bg-primary" : "bg-muted-foreground/30",
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
                  enabled ? "translate-x-5" : "translate-x-1",
                )}
              />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border/40 px-6 py-4">
          <div className="min-w-0 flex-1">
            {formError ? (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{formError}</span>
              </div>
            ) : validatedCron === cron.trim() && validatedCron ? (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                {t("scheduled.playbooksScheduleReady")}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={requestCloseIfIdle} disabled={saving}>
              {t("settings.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!cron.trim() || saving || isClosing}
              onClick={() => void handleSave()}
            >
              {t("scheduled.playbooksCreateSchedule")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
