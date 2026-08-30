import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Archive, Loader2, RefreshCw } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useLocale } from "../../i18n";
import { getArchiveFacets, getAutoArchivePolicy, saveAutoArchivePolicy } from "../../lib/conversationArchive/api";
import { archiveProjectLabel, MAX_ARCHIVE_IDLE_MINUTES, validateAutoArchivePolicy } from "../../lib/conversationArchive/model";
import type { ArchiveFacets, AutoArchivePolicy } from "../../lib/conversationArchive/types";
import { type WorkspaceProject, workspaceProjectPathKey } from "../../lib/settings";
import { ArchiveSelect, archiveSourceLabel } from "./archiveControls";
import { AgentActivationSwitch } from "./shared";

export function AutoArchiveSection({ projects = [] }: { projects?: WorkspaceProject[] }) {
  const { t } = useLocale();
  const fieldId = useId();
  const [policy, setPolicy] = useState<AutoArchivePolicy | null>(null);
  const [savedPolicy, setSavedPolicy] = useState<AutoArchivePolicy | null>(null);
  const [facets, setFacets] = useState<ArchiveFacets>({ sources: [], projects: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void Promise.allSettled([getAutoArchivePolicy(), getArchiveFacets("all")]).then(([policyResult, facetsResult]) => {
      if (disposed) return;
      if (policyResult.status === "fulfilled") {
        setPolicy(policyResult.value);
        setSavedPolicy(policyResult.value);
      } else {
        setError(String(policyResult.reason));
      }
      if (facetsResult.status === "fulfilled") setFacets(facetsResult.value);
      else setError((current) => current ?? String(facetsResult.reason));
      setLoading(false);
    });
    return () => { disposed = true; };
  }, [reload]);

  const dirty = policy !== null && JSON.stringify(policy) !== JSON.stringify(savedPolicy);
  const validationError = policy ? validateAutoArchivePolicy(policy) : null;
  const patch = useCallback((value: Partial<AutoArchivePolicy>) => {
    setSaved(false);
    setPolicy((current) => current ? { ...current, ...value } : current);
  }, []);
  const sources = useMemo(() => {
    const result = new Map(facets.sources.map((source) => [source.id, source]));
    for (const id of policy?.sourceIds ?? []) {
      if (!result.has(id)) result.set(id, { id, count: 0 });
    }
    return [...result.values()];
  }, [facets.sources, policy?.sourceIds]);
  const projectOptions = useMemo(() => {
    const result = new Map<string, { path: string; label: string }>();
    for (const project of projects) {
      if (project.path.trim()) result.set(workspaceProjectPathKey(project.path), { path: project.path, label: project.name || archiveProjectLabel(project.path) });
    }
    for (const path of [...facets.projects.map((project) => project.path), ...(policy?.projectPaths ?? [])]) {
      if (path.trim() && !result.has(workspaceProjectPathKey(path))) result.set(workspaceProjectPathKey(path), { path, label: archiveProjectLabel(path) });
    }
    return [...result.values()];
  }, [facets.projects, policy?.projectPaths, projects]);

  const save = async () => {
    if (!policy || saving || validationError) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await saveAutoArchivePolicy({ ...policy, timeZone: policy.timeZone.trim() });
      setPolicy(next);
      setSavedPolicy(next);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 rounded-2xl border border-border/60 bg-card p-4" aria-busy={loading || saving}>
      <div className="flex items-center justify-between gap-4">
        <h3 className="flex items-center gap-2 text-sm font-medium"><Archive className="h-4 w-4 text-muted-foreground" />{t("archive.policy.title")}</h3>
        <AgentActivationSwitch checked={policy?.enabled === true} title={t("archive.policy.enabled")} disabled={!policy || loading || saving} onToggle={() => patch({ enabled: !policy?.enabled })} />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t("archive.policy.description")}</p>
      {error ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
          <span className="min-w-0 break-words">{error}</span>
          <Button type="button" size="sm" variant="ghost" disabled={loading || saving} onClick={() => { setSaved(false); setReload((value) => value + 1); }}><RefreshCw className="h-3.5 w-3.5" />{t("archive.reload")}</Button>
        </div>
      ) : null}
      {loading ? <div role="status" className="flex items-center gap-2 py-3 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("archive.loading")}</div> : null}
      {policy && !loading ? (
        <fieldset disabled={saving} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor={`${fieldId}-mode`} className="text-xs font-medium">{t("archive.policy.mode")}</label>
              <ArchiveSelect id={`${fieldId}-mode`} label={t("archive.policy.mode")} value={policy.mode} options={[{ value: "idle", label: t("archive.policy.idle") }, { value: "daily", label: t("archive.policy.daily") }]} onChange={(mode) => patch({ mode: mode as AutoArchivePolicy["mode"] })} disabled={saving} />
            </div>
            {policy.mode === "idle" ? (
              <div className="space-y-1.5">
                <label htmlFor={`${fieldId}-idle`} className="text-xs font-medium">{t("archive.policy.idleMinutes")}</label>
                <Input id={`${fieldId}-idle`} type="number" min={1} max={MAX_ARCHIVE_IDLE_MINUTES} step={1} value={policy.idleMinutes || ""} onChange={(event) => patch({ idleMinutes: Number(event.currentTarget.value) })} className="h-9 rounded-xl" />
              </div>
            ) : (
              <div className="space-y-1.5">
                <label htmlFor={`${fieldId}-time`} className="text-xs font-medium">{t("archive.policy.dailyTime")}</label>
                <Input id={`${fieldId}-time`} type="time" value={policy.dailyTime} onChange={(event) => patch({ dailyTime: event.currentTarget.value })} className="h-9 rounded-xl" />
              </div>
            )}
            <div className="space-y-1.5">
              <label htmlFor={`${fieldId}-timezone`} className="text-xs font-medium">{t("archive.policy.timeZone")}</label>
              <Input id={`${fieldId}-timezone`} value={policy.timeZone} placeholder="Europe/London" onChange={(event) => patch({ timeZone: event.currentTarget.value })} className="h-9 rounded-xl" />
            </div>
            {policy.mode === "daily" ? (
              <div className="space-y-1.5">
                <label htmlFor={`${fieldId}-minimum`} className="text-xs font-medium">{t("archive.policy.minimumIdle")}</label>
                <Input id={`${fieldId}-minimum`} type="number" min={1} max={MAX_ARCHIVE_IDLE_MINUTES} step={1} value={policy.minimumIdleMinutes || ""} onChange={(event) => patch({ minimumIdleMinutes: Number(event.currentTarget.value) })} className="h-9 rounded-xl" />
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor={`${fieldId}-sources`} className="text-xs font-medium">{t("archive.policy.sources")}</label>
              <ArchiveSelect id={`${fieldId}-sources`} label={t("archive.policy.sources")} value={policy.sourceMode} disabled={saving} options={[{ value: "all", label: t("archive.allSources") }, { value: "selected", label: t("archive.policy.selectedSources") }]} onChange={(sourceMode) => patch({ sourceMode: sourceMode as AutoArchivePolicy["sourceMode"] })} />
              {policy.sourceMode === "all" ? <p className="text-xs leading-5 text-muted-foreground">{t("archive.policy.futureSources")}</p> : (
                <div className="max-h-44 space-y-2 overflow-auto rounded-xl border border-border/60 p-3">
                  {sources.length === 0 ? <p className="text-xs text-muted-foreground">{t("archive.policy.noSources")}</p> : sources.map((source) => (
                    <label key={source.id} className="flex items-center gap-2 text-xs">
                      <input type="checkbox" className="accent-primary" checked={policy.sourceIds.includes(source.id)} onChange={(event) => patch({ sourceIds: event.currentTarget.checked ? [...policy.sourceIds, source.id] : policy.sourceIds.filter((id) => id !== source.id) })} />
                      <span className="truncate">{archiveSourceLabel(source.id, t, source.displayName)}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <label htmlFor={`${fieldId}-projects`} className="text-xs font-medium">{t("archive.policy.projects")}</label>
              <ArchiveSelect id={`${fieldId}-projects`} label={t("archive.policy.projects")} value={policy.projectMode} disabled={saving} options={[{ value: "all", label: t("archive.allProjects") }, { value: "unassigned", label: t("archive.unassigned") }, { value: "selected", label: t("archive.policy.selectedProjects") }]} onChange={(projectMode) => patch({ projectMode: projectMode as AutoArchivePolicy["projectMode"] })} />
              {policy.projectMode === "selected" ? (
                <div className="max-h-44 space-y-2 overflow-auto rounded-xl border border-border/60 p-3">
                  {projectOptions.length === 0 ? <p className="text-xs text-muted-foreground">{t("archive.policy.noProjects")}</p> : projectOptions.map((project) => {
                    const selected = policy.projectPaths.some((path) => workspaceProjectPathKey(path) === workspaceProjectPathKey(project.path));
                    return <label key={project.path} title={project.path} className="flex items-start gap-2 text-xs">
                      <input type="checkbox" className="mt-0.5 accent-primary" checked={selected} onChange={(event) => patch({ projectPaths: event.currentTarget.checked ? [...policy.projectPaths, project.path] : policy.projectPaths.filter((path) => workspaceProjectPathKey(path) !== workspaceProjectPathKey(project.path)) })} />
                      <span className="min-w-0"><span className="block truncate">{project.label}</span><span className="block truncate text-[11px] text-muted-foreground">{project.path}</span></span>
                    </label>;
                  })}
                </div>
              ) : null}
            </div>
          </div>
          <p className="rounded-xl bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">{t("archive.policy.protection")}</p>
          <p className="text-xs leading-5 text-muted-foreground">{t("archive.policy.availability")}</p>
          {validationError ? <p role="alert" className="text-xs text-destructive">{t(validationError)}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-3">
            <p role="status" className="text-xs text-muted-foreground">{saving ? t("archive.policy.saving") : dirty ? t("archive.policy.unsaved") : saved ? t("archive.policy.saved") : t("archive.policy.saveHint")}</p>
            <Button type="button" size="sm" disabled={!dirty || saving || Boolean(validationError)} onClick={() => void save()}>{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{t("archive.policy.save")}</Button>
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}
