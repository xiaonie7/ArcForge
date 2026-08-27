import { createContext, memo, useContext, useMemo } from "react";

import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";
import type { DisplayFileItemDetails } from "../../lib/tools/builtinTypes";
import { FileText, FolderTree } from "../icons";
import { getFileTypeIcon } from "./fileTypeIcons";

export type GeneratedFilesActions = {
  onOpenFile?: (file: DisplayFileItemDetails) => void;
  onRevealInFileTree?: (file: DisplayFileItemDetails) => void;
};

const GeneratedFilesActionsContext = createContext<GeneratedFilesActions | null>(null);

export const GeneratedFilesActionsProvider = GeneratedFilesActionsContext.Provider;

export function useGeneratedFilesActions(): GeneratedFilesActions | null {
  return useContext(GeneratedFilesActionsContext);
}

function splitPath(path: string): { dir: string; base: string } {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return { dir: "", base: normalized };
  return { dir: normalized.slice(0, index + 1), base: normalized.slice(index + 1) };
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

function getFileKindLabel(t: (key: string) => string, file: DisplayFileItemDetails): string {
  switch (file.previewKind) {
    case "spreadsheet":
      return t("chat.generatedFiles.kind.spreadsheet");
    case "pdf":
      return t("chat.generatedFiles.kind.pdf");
    case "document":
      return t("chat.generatedFiles.kind.document");
    case "image":
      return t("chat.generatedFiles.kind.image");
    case "markdown":
    case "text":
      return t("chat.generatedFiles.kind.text");
    case "audio":
      return t("chat.generatedFiles.kind.audio");
    case "video":
      return t("chat.generatedFiles.kind.video");
    case "html":
      return t("chat.generatedFiles.kind.html");
    default:
      if (/\.(pptx?|pptm|odp)$/i.test(file.relativePath || file.path)) {
        return t("chat.generatedFiles.kind.presentation");
      }
      return t("chat.generatedFiles.kind.file");
  }
}

const ROW_ACTION_CLASS =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/65 opacity-0 transition-all hover:bg-foreground/[0.07] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover/generated-file:opacity-100";

const GeneratedFileRow = memo(function GeneratedFileRow({
  file,
}: {
  file: DisplayFileItemDetails;
}) {
  const { t } = useLocale();
  const actions = useGeneratedFilesActions();
  const relativePath = (file.relativePath || file.path).trim();
  const { dir, base } = splitPath(relativePath);
  const FileTypeIcon = getFileTypeIcon(relativePath, "file");
  const canOpen = Boolean(actions?.onOpenFile);
  const version = file.artifact
    ? t(
        file.artifact.artifactRole === "preview"
          ? "chat.generatedFiles.sourceVersion"
          : "chat.generatedFiles.version",
      ).replace("{version}", String(file.artifact.sourceVersion ?? file.artifact.currentVersion))
    : "";
  const validation =
    file.artifact?.latestValidationStatus === "passed"
      ? t("chat.generatedFiles.validated")
      : file.artifact?.latestValidationStatus === "failed"
        ? t("chat.generatedFiles.validationFailed")
        : "";
  const metadata = [getFileKindLabel(t, file), version, validation, formatBytes(file.sizeBytes)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="group/generated-file flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-foreground/[0.045]">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-background/70 dark:border-white/[0.07] dark:bg-white/[0.04]">
        <FileTypeIcon className="h-4 w-4" />
      </div>
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => actions?.onOpenFile?.(file)}
        className={cn(
          "flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left focus-visible:outline-none",
          canOpen ? "cursor-pointer" : "cursor-default",
        )}
        title={canOpen ? t("chat.generatedFiles.openPreview") : relativePath}
      >
        <span className="flex min-w-0 max-w-full items-baseline font-mono text-[calc(11.5px*var(--zone-font-scale,1))] leading-tight">
          {dir ? <span className="truncate text-muted-foreground/65">{dir}</span> : null}
          <span className="shrink-0 font-medium text-foreground/90">{base}</span>
        </span>
        <span className="truncate text-[calc(10.5px*var(--zone-font-scale,1))] leading-tight text-muted-foreground/75">
          {metadata}
          {!file.previewSupported ? ` · ${t("chat.generatedFiles.previewUnavailable")}` : ""}
        </span>
      </button>
      {actions?.onRevealInFileTree ? (
        <button
          type="button"
          onClick={() => actions.onRevealInFileTree?.(file)}
          title={t("chat.generatedFiles.reveal")}
          aria-label={t("chat.generatedFiles.reveal")}
          className={ROW_ACTION_CLASS}
        >
          <FolderTree className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
});

export const GeneratedFilesCard = memo(function GeneratedFilesCard({
  files,
}: {
  files: DisplayFileItemDetails[];
}) {
  const { t } = useLocale();
  const title = useMemo(
    () =>
      t(files.length === 1 ? "chat.generatedFiles.titleOne" : "chat.generatedFiles.title").replace(
        "{count}",
        String(files.length),
      ),
    [files.length, t],
  );

  return (
    <div className="generated-files-card my-1 overflow-hidden rounded-xl border border-border/45 bg-background/60 backdrop-blur-sm dark:border-white/[0.07] dark:bg-white/[0.03]">
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/45 bg-background/75 text-foreground/70 shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] dark:border-white/[0.08] dark:bg-white/[0.05] dark:shadow-[0_1px_0_rgba(255,255,255,0.05)_inset]">
          <FileText className="h-4 w-4" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[calc(12px*var(--zone-font-scale,1))] font-medium leading-tight text-foreground/85">
            {title}
          </span>
          <span className="truncate text-[calc(10.5px*var(--zone-font-scale,1))] leading-tight text-muted-foreground/70">
            {t("chat.generatedFiles.hint")}
          </span>
        </div>
      </div>
      <div className="flex max-h-[calc(210px*var(--zone-font-scale,1))] flex-col gap-0.5 overflow-y-auto overscroll-contain border-t border-border/35 px-1 py-1 dark:border-white/[0.05]">
        {files.map((file) => (
          <GeneratedFileRow key={file.fileId || file.relativePath || file.path} file={file} />
        ))}
      </div>
    </div>
  );
});
