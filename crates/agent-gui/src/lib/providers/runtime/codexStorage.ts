import type { ProviderId } from "../../settings";
import { isRecord } from "./common";
import type { StreamOptionsEx } from "./types";

export function attachCodexResponsesStorage(
  providerId: ProviderId,
  baseUrl: string,
  options: StreamOptionsEx,
): StreamOptionsEx {
  const previousOnPayload = options.onPayload;
  const shouldEnableStorage = isOfficialOpenAIBaseUrl(baseUrl);

  if (providerId !== "codex") {
    return options;
  }

  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;

      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (shouldEnableStorage && model.api === "openai-responses" && isRecord(nextPayload)) {
        return {
          ...nextPayload,
          store: true,
        };
      }

      return nextPayload;
    },
  };
}

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}
