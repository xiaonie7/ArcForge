import { useCallback, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Info,
  RefreshCw,
  Sparkles,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import {
  formatUpdaterError,
  isTauriRuntime,
  loadUpdaterClient,
  type UpdaterUpdate,
} from "../../lib/updater";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; update: UpdaterUpdate; version: string; notes?: string }
  | { kind: "downloading"; progress?: number }
  | { kind: "upToDate" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

function clampProgress(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function AboutSection() {
  const { t } = useLocale();
  const [updateState, setUpdateState] = useState<UpdateState>(() =>
    isTauriRuntime() ? { kind: "idle" } : { kind: "unsupported" },
  );

  const checkForUpdates = useCallback(async () => {
    if (!isTauriRuntime()) {
      setUpdateState({ kind: "unsupported" });
      return;
    }

    setUpdateState({ kind: "checking" });
    try {
      const client = await loadUpdaterClient();
      if (!client) {
        setUpdateState({ kind: "unsupported" });
        return;
      }

      const update = await client.check();
      if (!update) {
        setUpdateState({ kind: "upToDate" });
        return;
      }

      setUpdateState({
        kind: "available",
        update,
        version: update.version,
        notes: update.body?.trim() || undefined,
      });
    } catch (error) {
      setUpdateState({ kind: "error", message: formatUpdaterError(error) });
    }
  }, []);

  const installUpdate = useCallback(async () => {
    if (updateState.kind !== "available") return;

    setUpdateState({ kind: "downloading", progress: 0 });
    try {
      const client = await loadUpdaterClient();
      if (!client) {
        setUpdateState({ kind: "unsupported" });
        return;
      }

      let downloaded = 0;
      let contentLength: number | undefined;
      await updateState.update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          const length = event.data.contentLength;
          contentLength = typeof length === "number" && length > 0 ? length : undefined;
          setUpdateState({ kind: "downloading", progress: 0 });
        } else if (event.event === "Progress") {
          const chunkLength = event.data.chunkLength;
          if (typeof chunkLength === "number" && chunkLength > 0) downloaded += chunkLength;
          setUpdateState({
            kind: "downloading",
            progress: contentLength ? clampProgress((downloaded / contentLength) * 100) : undefined,
          });
        } else if (event.event === "Finished") {
          setUpdateState({ kind: "downloading", progress: 100 });
        }
      });

      await client.relaunch();
    } catch (error) {
      setUpdateState({ kind: "error", message: formatUpdaterError(error) });
    }
  }, [updateState]);

  const updateStatus = (() => {
    switch (updateState.kind) {
      case "checking":
        return t("settings.aboutUpdateChecking");
      case "available":
        return `${t("settings.aboutUpdateAvailable")} v${updateState.version}`;
      case "downloading":
        return updateState.progress === undefined
          ? t("settings.aboutUpdateDownloading")
          : `${t("settings.aboutUpdateDownloading")} ${updateState.progress}%`;
      case "upToDate":
        return t("settings.aboutUpdateUpToDate");
      case "unsupported":
        return t("settings.aboutUpdateDesktopOnly");
      case "error":
        return updateState.message;
      default:
        return t("settings.aboutUpdateIdle");
    }
  })();

  const updateButtonLabel =
    updateState.kind === "available"
      ? t("settings.aboutUpdateInstall")
      : t("settings.aboutUpdateCheck");
  const updateButtonAction = updateState.kind === "available" ? installUpdate : checkForUpdates;
  const updateBusy = updateState.kind === "checking" || updateState.kind === "downloading";

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Info className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("settings.aboutTitle")}</h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            {t("settings.aboutDescription")}
          </p>
        </div>
      </div>

      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("settings.aboutCurrentVersion")}
            </div>
            <div className="mt-1 text-2xl font-semibold leading-none tabular-nums">
              v{__ARCFORGE_APP_VERSION__}
            </div>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/45 px-2.5 py-1 text-xs font-medium">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            {t("app.name")}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              {updateState.kind === "error" ? (
                <AlertTriangle className="h-4 w-4 text-destructive" />
              ) : updateState.kind === "upToDate" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : (
                <Download className="h-4 w-4 text-primary" />
              )}
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-semibold">{t("settings.aboutUpdateTitle")}</h4>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{updateStatus}</p>
              {updateState.kind === "available" && updateState.notes && (
                <p className="mt-2 max-w-2xl whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                  {updateState.notes}
                </p>
              )}
            </div>
          </div>

          <Button
            type="button"
            variant={updateState.kind === "available" ? "default" : "outline"}
            size="sm"
            onClick={updateButtonAction}
            disabled={updateBusy || !isTauriRuntime()}
            title={!isTauriRuntime() ? t("settings.aboutUpdateDesktopOnly") : undefined}
          >
            {updateBusy ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : updateState.kind === "available" ? (
              <Download className="h-3.5 w-3.5" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {updateButtonLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}
