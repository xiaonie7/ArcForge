import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { subscribeConversationRuntime } from "../../pages/chat/runtime/chatPageRuntime";
import { ensureReviewThread, type ReviewThreadOptions } from "./reviewThread";

export function useReviewThread(options: ReviewThreadOptions | null) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const key = options ? JSON.stringify([options.artifact.workdir, options.artifact.path]) : "";
  const [result, setResult] = useState<{ key: string; id: string | null; error: string | null }>({
    key: "",
    id: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger
  useEffect(() => {
    const current = optionsRef.current;
    if (!current) return;
    let cancelled = false;
    setResult({ key, id: null, error: null });
    void ensureReviewThread(current).then(
      (id) => {
        if (!cancelled) setResult({ key, id, error: null });
      },
      (error) => {
        if (!cancelled)
          setResult({
            key,
            id: null,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, attempt]);
  const threadId = result.key === key ? result.id : null;
  const cache = options?.runtimeCache;
  const subscribe = useCallback(
    (listener: () => void) =>
      cache && threadId ? subscribeConversationRuntime(cache, threadId, listener) : () => {},
    [cache, threadId],
  );
  const getSnapshot = useCallback(
    () => (cache && threadId ? (cache.get(threadId) ?? null) : null),
    [cache, threadId],
  );
  const runtime = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    threadId,
    runtime,
    loading: Boolean(key && !threadId && !(result.key === key && result.error)),
    errorMessage: result.key === key ? result.error : null,
    retry,
  };
}
