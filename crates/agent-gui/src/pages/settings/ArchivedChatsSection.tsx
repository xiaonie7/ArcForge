import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Folder, Loader2, RefreshCw, Search, Trash2 } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useConfirmDialog } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { useLocale } from "../../i18n";
import {
  deleteArchivedConversations,
  getArchiveFacets,
  queryConversations,
  snapshotArchivedConversations,
  subscribeArchiveChanges,
  unarchiveConversation,
} from "../../lib/conversationArchive/api";
import {
  archiveFilterFromControls,
  archiveProjectLabel,
  freezeArchiveCandidates,
  groupArchivedConversations,
  hasArchiveFilter,
} from "../../lib/conversationArchive/model";
import type { ArchiveConversation, ArchiveFacets, ArchiveMutation, ArchivePage } from "../../lib/conversationArchive/types";
import { type WorkspaceProject, workspaceProjectPathKey } from "../../lib/settings";
import { createUuid } from "../../lib/shared/id";
import { ArchiveSelect, archiveSourceLabel } from "./archiveControls";

const PAGE_SIZE = 50;

export function ArchivedChatsSection(props: {
  onOpenConversation?: (conversationId: string) => void;
  projects?: WorkspaceProject[];
}) {
  const { t, locale } = useLocale();
  const { confirm, dialog } = useConfirmDialog();
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [source, setSource] = useState("all");
  const [project, setProject] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ArchivePage>({ items: [], totalCount: 0 });
  const [facets, setFacets] = useState<ArchiveFacets>({ sources: [], projects: [] });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const restoreRequests = useRef(new Map<string, ArchiveMutation>());
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const filter = useMemo(() => archiveFilterFromControls(searchQuery, source === "all" ? "" : source, project), [searchQuery, source, project]);
  const filtering = hasArchiveFilter(filter);
  const searching = search.trim() !== searchQuery;
  const busy = busyId !== null;
  const pageCount = Math.max(1, Math.ceil(data.totalCount / PAGE_SIZE));

  useEffect(() => {
    const timeout = setTimeout(() => { setSearchQuery(search.trim()); setPage(1); }, 250);
    return () => clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void Promise.allSettled([
      queryConversations({ ...filter, archiveState: "archived", page, pageSize: PAGE_SIZE }),
      getArchiveFacets(),
    ]).then(([pageResult, facetsResult]) => {
      if (disposed) return;
      if (pageResult.status === "fulfilled") {
        setData(pageResult.value);
        const lastPage = Math.max(1, Math.ceil(pageResult.value.totalCount / PAGE_SIZE));
        if (page > lastPage) setPage(lastPage);
      } else setError(String(pageResult.reason));
      if (facetsResult.status === "fulfilled") setFacets(facetsResult.value);
      else setError((current) => current ?? String(facetsResult.reason));
      setLoading(false);
    });
    return () => { disposed = true; };
  }, [filter, page, reload]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; refresh(); }, 500);
    };
    const unsubscribe = subscribeArchiveChanges(schedule);
    window.addEventListener("focus", schedule);
    return () => { unsubscribe(); clearTimeout(timer); window.removeEventListener("focus", schedule); };
  }, [refresh]);

  const projectNames = useMemo(() => new Map((props.projects ?? []).map((item) => [workspaceProjectPathKey(item.path), item.name])), [props.projects]);
  const projectLabel = (path: string) => projectNames.get(workspaceProjectPathKey(path)) || archiveProjectLabel(path);
  const sourceOptions = [
    { value: "all", label: t("archive.allSources") },
    ...facets.sources.map((item) => ({ value: item.id, label: archiveSourceLabel(item.id, t, item.displayName) })),
  ];
  if (!sourceOptions.some((item) => item.value === source)) sourceOptions.push({ value: source, label: archiveSourceLabel(source, t) });
  const projectOptions = [
    { value: "all", label: t("archive.allProjects") },
    { value: "unassigned", label: t("archive.unassigned") },
    ...facets.projects.filter((item) => item.path.trim()).map((item) => ({ value: `path:${item.path}`, label: `${projectLabel(item.path)} · ${item.path}` })),
  ];
  if (project.startsWith("path:") && !projectOptions.some((item) => item.value === project)) projectOptions.push({ value: project, label: projectLabel(project.slice(5)) });
  const groups = useMemo(() => groupArchivedConversations(data.items), [data.items]);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);

  const restore = async (item: ArchiveConversation) => {
    if (busy || loading) return;
    const version = item.lifecycleVersion ?? 0;
    let input = restoreRequests.current.get(item.id);
    if (!input || input.expectedLifecycleVersion !== version) {
      input = { id: item.id, expectedLifecycleVersion: version, operationId: createUuid() };
      restoreRequests.current.set(item.id, input);
    }
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      const result = await unarchiveConversation(input);
      if (result.archivedAt) throw new Error(t("archive.restoreFailed"));
      restoreRequests.current.delete(item.id);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item?: ArchiveConversation) => {
    if (busy || loading || searching) return;
    setBusyId(item?.id ?? "*");
    setError(null);
    setNotice(null);
    try {
      // Freeze every matching ID/version before asking for confirmation. Do
      // not replace this with data.items: that would delete only one page.
      const snapshot = item
        ? { candidates: [{ id: item.id, lifecycleVersion: item.lifecycleVersion ?? 0 }], totalCount: 1 }
        : await snapshotArchivedConversations(filter);
      const candidates = freezeArchiveCandidates(snapshot.candidates);
      if (candidates.length !== snapshot.totalCount) throw new Error(t("archive.invalidSnapshot"));
      if (candidates.length === 0) { refresh(); return; }
      const confirmed = await confirm({
        title: item ? t("archive.deleteTitle") : filtering ? t("archive.deleteFiltered") : t("archive.deleteAll"),
        subtitle: item?.title || undefined,
        description: t("archive.deleteConfirm").replace("{count}", String(candidates.length)),
        detail: item ? t("archive.deleteSafety") : `${t("archive.scope")}: ${[
          searchQuery ? `${t("archive.searchLabel")}: ${searchQuery}` : null,
          sourceOptions.find((option) => option.value === source)?.label,
          projectOptions.find((option) => option.value === project)?.label,
        ].filter(Boolean).join(" · ")}\n${t("archive.deleteSafety")}`,
        confirmLabel: t("archive.deletePermanently"),
        cancelLabel: t("chat.cancel"),
        tone: "destructive",
      });
      if (!confirmed) return;
      const result = await deleteArchivedConversations(candidates);
      if (result.skipped.length > 0) setNotice(t("archive.deleteSkipped").replace("{deleted}", String(result.deletedIds.length)).replace("{skipped}", String(result.skipped.length)));
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="mx-auto w-full max-w-4xl space-y-7 pb-8 pt-5 sm:pt-10" aria-busy={loading || busy}>
      {dialog}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">{t("archive.title")}</h1>
        <Button type="button" size="sm" variant="ghost" disabled={busy || loading || searching || data.totalCount === 0} onClick={() => void remove()} className="rounded-xl bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive">
          {busyId === "*" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}{filtering ? t("archive.deleteFiltered") : t("archive.deleteAll")}
        </Button>
      </div>
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_10rem_13rem]">
        <div className="relative min-w-0">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input type="search" aria-label={t("archive.searchLabel")} placeholder={t("archive.searchPlaceholder")} value={search} onChange={(event) => setSearch(event.currentTarget.value)} disabled={busy} className="h-9 rounded-xl border-border/70 pl-9 shadow-none" />
        </div>
        <ArchiveSelect label={t("archive.sourceFilter")} value={source} options={sourceOptions} disabled={busy} onChange={(value) => { setSource(value); setPage(1); }} />
        <ArchiveSelect label={t("archive.projectFilter")} value={project} options={projectOptions} disabled={busy} icon={<Folder className="h-3.5 w-3.5 shrink-0" />} onChange={(value) => { setProject(value); setPage(1); }} />
      </div>
      {error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"><span className="min-w-0 break-words">{error}</span><Button type="button" size="sm" variant="ghost" onClick={refresh} disabled={loading || busy}><RefreshCw className="h-3.5 w-3.5" />{t("archive.reload")}</Button></div> : null}
      {notice ? <p role="status" className="rounded-xl bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">{notice}</p> : null}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground" role="status">
        <span>{t("archive.total").replace("{count}", String(data.totalCount))}</span>
        {loading || searching ? <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("archive.loading")}</span> : <Button type="button" size="sm" variant="ghost" onClick={refresh} disabled={busy} title={t("archive.reload")} aria-label={t("archive.reload")} className="h-6 w-6 p-0"><RefreshCw className="h-3.5 w-3.5" /></Button>}
      </div>
      {groups.length === 0 && !loading && !error ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/70 px-6 py-16 text-center">
          <Archive className="h-7 w-7 text-muted-foreground/60" />
          <h2 className="text-sm font-medium">{filtering ? t("archive.noResults") : t("archive.empty")}</h2>
          <p className="max-w-md text-xs leading-5 text-muted-foreground">{filtering ? t("archive.noResultsHint") : t("archive.emptyHint")}</p>
        </div>
      ) : null}
      <div className="space-y-8">
        {groups.map((group) => (
          <section key={group.key || "unassigned"} className="space-y-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <h2 className="flex min-w-0 items-center gap-2 font-medium" title={group.path}><Folder className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{group.path ? projectLabel(group.path) : t("archive.unassigned")}</span></h2>
              <span className="shrink-0 text-xs text-muted-foreground">{t(pageCount > 1 ? "archive.groupPageCount" : "archive.groupCount").replace("{count}", String(group.items.length))}</span>
            </div>
            <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70">
              {group.items.map((item) => (
                <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                  <button type="button" onClick={() => props.onOpenConversation?.(item.id)} disabled={!props.onOpenConversation || busy || loading} className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default" title={t("archive.view")}>
                    <span className="block truncate text-sm font-medium">{item.title || t("chat.pendingTitle")}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{t("archive.archivedAt")}: {item.archivedAt ? dateFormatter.format(item.archivedAt) : "—"}</span><span>{archiveSourceLabel(item.originSourceId || "unknown", t, facets.sources.find((sourceItem) => sourceItem.id === item.originSourceId)?.displayName)}</span></span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                    <Button type="button" variant="ghost" size="icon" disabled={busy || loading} aria-label={t("archive.deleteTitle")} title={t("archive.deleteTitle")} onClick={() => void remove(item)} className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></Button>
                    <Button type="button" variant="secondary" size="sm" disabled={busy || loading} onClick={() => void restore(item)} className="rounded-xl text-xs">{busyId === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{t("archive.restore")}</Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {pageCount > 1 ? (
        <div className="flex items-center justify-between border-t border-border/50 pt-4 text-xs text-muted-foreground">
          <span>{t("archive.pagination").replace("{page}", String(page)).replace("{pages}", String(pageCount))}</span>
          <div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={busy || loading || page <= 1} onClick={() => setPage((value) => value - 1)}>{t("archive.previous")}</Button><Button type="button" variant="outline" size="sm" disabled={busy || loading || page >= pageCount} onClick={() => setPage((value) => value + 1)}>{t("archive.next")}</Button></div>
        </div>
      ) : null}
    </section>
  );
}
