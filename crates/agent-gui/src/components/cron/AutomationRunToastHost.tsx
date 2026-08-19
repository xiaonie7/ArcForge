import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import type { CronRunCompletedEvent } from "../../lib/automation";
import { CheckCircle2, Send, X, XCircle } from "../icons";

const RUN_COMPLETED_EVENT = "automation:run-completed";
const MAX_VISIBLE_NOTICES = 4;

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

export function AutomationRunToastHost() {
  const { t } = useLocale();
  const [items, setItems] = useState<CronRunCompletedEvent[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unlistenPromise = listen<CronRunCompletedEvent>(RUN_COMPLETED_EVENT, (event) => {
      if (cancelled) return;
      setItems((current) =>
        [event.payload, ...current.filter((item) => item.id !== event.payload.id)].slice(
          0,
          MAX_VISIBLE_NOTICES,
        ),
      );
    });

    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute right-3 bottom-3 z-[70] flex w-[min(24rem,calc(100%-1.5rem))] flex-col gap-2 sm:right-4 sm:bottom-4"
    >
      {items.map((item) => (
        <AutomationRunToast key={item.id} item={item} onDismiss={dismiss} t={t} />
      ))}
    </div>
  );
}

function AutomationRunToast(props: {
  item: CronRunCompletedEvent;
  onDismiss: (id: string) => void;
  t: (key: string) => string;
}) {
  const { item, onDismiss, t } = props;
  const elementRef = useRef<HTMLDivElement>(null);
  const hasError =
    !item.success || item.deliveryStatus === "failed" || item.deliveryStatus === "unknown";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const element = elementRef.current;
      if (!element) {
        onDismiss(item.id);
        return;
      }
      element.classList.add("notify-toast-exit");
      const finish = () => onDismiss(item.id);
      element.addEventListener("animationend", finish, { once: true });
      window.setTimeout(finish, 400);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [item.id, onDismiss]);

  const title = t(
    item.success ? "automation.runNoticeSuccess" : "automation.runNoticeFailure",
  ).replace("{name}", item.taskName);
  const deliveryLabel =
    item.deliveryStatus === "sent"
      ? t("automation.runNoticeDeliverySent")
      : item.deliveryStatus === "failed"
        ? t("automation.runNoticeDeliveryFailed")
        : item.deliveryStatus === "unknown"
          ? t("automation.runNoticeDeliveryUnknown")
          : item.deliveryStatus === "skipped"
            ? t("automation.runNoticeDeliverySkipped")
            : "";

  return (
    <div
      ref={elementRef}
      className={`notify-toast-enter pointer-events-auto flex items-start gap-3 rounded-lg border bg-background/95 px-3.5 py-3 shadow-xl backdrop-blur-xl ${
        hasError ? "border-red-500/30" : "border-emerald-500/30"
      }`}
    >
      {hasError ? (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
      ) : (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</p>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatDuration(item.durationMs)}
          </span>
        </div>
        {item.outputSummary ? (
          <p className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
            {item.outputSummary}
          </p>
        ) : null}
        {deliveryLabel ? (
          <div
            className={`mt-1.5 flex items-start gap-1.5 text-[11px] ${
              item.deliveryStatus === "failed"
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground"
            }`}
          >
            <Send className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 break-words">
              {deliveryLabel}
              {item.deliveryStatus === "failed" && item.deliveryError
                ? `: ${item.deliveryError}`
                : ""}
            </span>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        title={t("automation.runNoticeDismiss")}
        aria-label={t("automation.runNoticeDismiss")}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
