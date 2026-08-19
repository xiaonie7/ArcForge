export class ChannelTurnTimeoutError extends Error {
  constructor(readonly maxDurationSeconds: number) {
    super(`Channel run timed out after ${maxDurationSeconds} seconds`);
    this.name = "ChannelTurnTimeoutError";
  }
}

export type ChannelTurnDeadline = {
  run<T>(operation: T | PromiseLike<T>): Promise<T>;
  clear(): void;
  isTimedOut(): boolean;
  readonly error: ChannelTurnTimeoutError;
};

export function createChannelTurnDeadline(params: {
  maxDurationSeconds: number;
  onTimeout: (error: ChannelTurnTimeoutError) => void;
}): ChannelTurnDeadline {
  const error = new ChannelTurnTimeoutError(params.maxDurationSeconds);
  const timeoutListeners = new Set<(error: ChannelTurnTimeoutError) => void>();
  let timedOut = false;
  let cleared = false;
  const timeoutId = globalThis.setTimeout(() => {
    if (cleared) return;
    timedOut = true;
    try {
      params.onTimeout(error);
    } finally {
      for (const reject of timeoutListeners) reject(error);
      timeoutListeners.clear();
    }
  }, params.maxDurationSeconds * 1_000);

  return {
    error,
    run<T>(operation: T | PromiseLike<T>) {
      if (timedOut) return Promise.reject(error);
      if (cleared) return Promise.resolve(operation);
      return new Promise<T>((resolve, reject) => {
        const rejectOnTimeout = (timeoutError: ChannelTurnTimeoutError) => {
          reject(timeoutError);
        };
        timeoutListeners.add(rejectOnTimeout);
        Promise.resolve(operation).then(
          (value) => {
            timeoutListeners.delete(rejectOnTimeout);
            resolve(value);
          },
          (operationError) => {
            timeoutListeners.delete(rejectOnTimeout);
            reject(operationError);
          },
        );
      });
    },
    clear() {
      if (cleared) return;
      cleared = true;
      globalThis.clearTimeout(timeoutId);
      timeoutListeners.clear();
    },
    isTimedOut() {
      return timedOut;
    },
  };
}
