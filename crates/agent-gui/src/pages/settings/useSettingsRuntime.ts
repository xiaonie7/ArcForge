import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { AppSettings } from "../../lib/settings";
import { type McpStatus, summarizeMcpStatus } from "./overviewModel";
import type { SettingsRuntimeSources } from "./types";

export function useSettingsRuntime(settings: AppSettings, sources?: SettingsRuntimeSources | null) {
  const [activity, setActivity] = useState({ running: false, toolsRunning: false });
  const [mcp, setMcp] = useState({ connected: 0, loading: true, unavailable: false, error: false });
  const [databaseCount, setDatabaseCount] = useState<number | null>(null);
  // Include configuration changes in the key so replaced endpoints cannot retain a stale status.
  const serversKey = JSON.stringify(settings.mcp.servers.filter((server) => server.enabled));

  useEffect(() => {
    if (!sources) {
      setActivity({ running: false, toolsRunning: false });
      return;
    }
    let transcriptUnsubscribers: Array<() => void> = [];
    const readActivity = () => {
      const ids = sources.sidebar.getSnapshot().runningConversationIds;
      const toolsRunning = [...ids].some((id) =>
        sources
          .transcript(id)
          .getSnapshot()
          .liveRounds.some((round) => round.runningToolCallIds.length > 0),
      );
      const running = ids.size > 0;
      setActivity((prev) =>
        prev.running === running && prev.toolsRunning === toolsRunning
          ? prev
          : { running, toolsRunning },
      );
    };
    const subscribeTranscripts = () => {
      for (const unsubscribe of transcriptUnsubscribers) unsubscribe();
      transcriptUnsubscribers = [...sources.sidebar.getSnapshot().runningConversationIds].map(
        (id) => sources.transcript(id).subscribe(readActivity),
      );
      readActivity();
    };
    subscribeTranscripts();
    const unsubscribe = sources.sidebar.subscribe(subscribeTranscripts);
    return () => {
      unsubscribe();
      for (const dispose of transcriptUnsubscribers) dispose();
    };
  }, [sources]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const servers = JSON.parse(serversKey) as AppSettings["mcp"]["servers"];
    if (!servers.length) {
      setMcp({ connected: 0, loading: false, unavailable: false, error: false });
      return;
    }
    if (!isTauri()) {
      setMcp({ connected: 0, loading: false, unavailable: true, error: false });
      return;
    }
    setMcp({ connected: 0, loading: true, unavailable: false, error: false });
    const refresh = async () => {
      if (cancelled) return;
      if (document.hidden) {
        timer = setTimeout(refresh, 10000);
        return;
      }
      // Status reads never start servers or run connection tests.
      const results = await Promise.allSettled(
        servers.map((server) => invoke<McpStatus>("mcp_runtime_status", { server_id: server.id })),
      );
      if (cancelled) return;
      setMcp({ ...summarizeMcpStatus(results), loading: false });
      timer = setTimeout(refresh, 10000);
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [serversKey]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void invoke<unknown[]>("database_profiles_list")
      .then((profiles) => {
        if (!cancelled) setDatabaseCount(profiles.length);
      })
      .catch(() => {
        if (!cancelled) setDatabaseCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { ...activity, mcp, databaseCount };
}
