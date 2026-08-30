import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import { loadToken } from "../lib/storage";

export type TauriEvent<T> = {
  payload: T;
};

export async function listen<T>(
  event: string,
  handler: (event: TauriEvent<T>) => void,
): Promise<() => void> {
  if (event === "chat-history:changed") {
    const token = loadToken().trim();
    if (!token) return () => {};
    return getGatewayWebSocketClient(token).subscribeHistory((payload) => {
      handler({ payload: payload as T });
    });
  }
  if (event === "gateway:status") {
    const token = loadToken().trim();
    if (!token) {
      return () => {};
    }

    return getGatewayWebSocketClient(token).subscribeStatus((status, error) => {
      handler({
        payload: (status ?? {
          online: false,
          enabled: true,
          configured: true,
          gatewayUrl: window.location.origin,
          lastError: error,
        }) as T,
      });
    });
  }

  return () => {};
}
