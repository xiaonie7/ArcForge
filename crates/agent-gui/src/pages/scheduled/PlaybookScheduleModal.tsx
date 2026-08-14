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
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const { isClosing, modalState, requestClose: requestMotionClose } = useModalMotion(props.onClose);

  function requestModalClose() {
    if (savingRef.current) return;
    requestMotionClose();
  }

  async function handleSave() {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      setIsSaving(true);
      setFormError(null);
      const expression = cron.trim();
      if (!expression) throw new Error(t("scheduled.playbooksScheduleCronRequired"));
      await validateCronExpression(expression);

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
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
    >
      <button
        type="button"
        aria-label={t("settings.cancel")}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        disabled={isSaving}
        onClick={requestModalClose}
      />
      <div className="settings-modal-panel relative z-10 flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
        <div className="settings-modal-header flex items-center gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
            <Clock3 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{t("scheduled.playbooksScheduleTitle")}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{props.playbook.name}</p>
          </div>
          <button
            type="button"
            disabled={isSaving}
            onClick={requestModalClose}
            title={t("settings.cancel")}
            aria-label={t("settings.cancel")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="settings-modal-body flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("scheduled.playbooksScheduleName")}
              </Label>
              <Input value={name} onChange={(event) => setName(event.currentTarget.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("scheduled.playbooksScheduleCron")}
              </Label>
              <Input
                value={cron}
                className="font-mono"
                placeholder={t("settings.cronExpressionPlaceholder")}
                onChange={(event) => {
                  setFormError(null);
                  setCron(event.currentTarget.value);
                }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              {t("scheduled.playbooksDescription")}
            </Label>
            <Input
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("settings.cronRemainingExecutions")}
              </Label>
              <Input
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
              <Label className="text-xs font-medium text-muted-foreground">
                {t("settings.cronTimeoutSeconds")}
              </Label>
              <Input
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
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border/50 px-4 py-3">
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

        <div className="settings-modal-footer flex items-center justify-between gap-4 border-t border-border/40 px-6 py-4">
          <div className="min-w-0 flex-1">
            {formError ? (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{formError}</span>
              </div>
            ) : cron.trim() ? (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                {t("scheduled.playbooksScheduleReady")}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={isSaving} onClick={requestModalClose}>
              {t("settings.cancel")}
            </Button>
            <Button
              disabled={!cron.trim() || isSaving || isClosing}
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
