import type { Update } from "@tauri-apps/plugin-updater";

type TauriRuntimeWindow = Window & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

export type UpdaterUpdate = Update;

export type UpdaterClient = {
  check: () => Promise<Update | null>;
  relaunch: () => Promise<void>;
};

/** Native updater APIs only exist inside a Tauri webview. */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const runtimeWindow = window as TauriRuntimeWindow;
  return runtimeWindow.__TAURI__ !== undefined || runtimeWindow.__TAURI_INTERNALS__ !== undefined;
}

/**
 * Load native updater APIs on demand so gateway/browser builds can render the
 * About page without requiring a Tauri runtime or invoking a native command.
 */
export async function loadUpdaterClient(): Promise<UpdaterClient | null> {
  if (!isTauriRuntime()) return null;

  const [{ check }, { relaunch }] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/plugin-process"),
  ]);

  return { check, relaunch };
}

export function formatUpdaterError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Unknown updater error";
}
