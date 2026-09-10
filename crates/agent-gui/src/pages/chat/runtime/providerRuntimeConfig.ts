import {
  type AppSettings,
  type ChatRuntimeControls,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  normalizeChatRuntimeControlsForProvider,
  type SelectedModel,
} from "../../../lib/settings";
import type { EffectiveChatModelSelection } from "./modelSelection";

export function resolveMemorySummaryModelSelection(
  settings: AppSettings,
): EffectiveChatModelSelection | null {
  const summaryModel = settings.memory.summaryModel;
  if (!summaryModel) {
    return null;
  }

  const provider = settings.customProviders.find(
    (item) => item.id === summaryModel.customProviderId,
  );
  if (!provider || !provider.activeModels.includes(summaryModel.model)) {
    return null;
  }

  return {
    selectedModel: summaryModel,
    provider,
    providerId: provider.type,
    model: summaryModel.model,
  };
}

export function resolveConversationTitleModelSelection(
  settings: AppSettings,
  fallback: EffectiveChatModelSelection,
): EffectiveChatModelSelection {
  const titleModel = settings.customSettings.conversationTitleModel;
  if (!titleModel) {
    return fallback;
  }

  const provider = settings.customProviders.find((item) => item.id === titleModel.customProviderId);
  if (!provider || !provider.activeModels.includes(titleModel.model)) {
    return fallback;
  }

  return {
    selectedModel: titleModel,
    provider,
    providerId: provider.type,
    model: titleModel.model,
  };
}

/**
 * The model that answers VisualReview calls. `configured` when the custom-settings slot
 * names an enabled model, otherwise the current chat model (`current`).
 */
export function resolveVisualReviewModelSelection(
  settings: AppSettings,
  fallback: EffectiveChatModelSelection,
): EffectiveChatModelSelection & { source: "configured" | "current" } {
  const reviewModel = settings.customSettings.visualReviewModel;
  if (!reviewModel) {
    return { ...fallback, source: "current" };
  }

  const provider = settings.customProviders.find(
    (item) => item.id === reviewModel.customProviderId,
  );
  if (!provider || !provider.activeModels.includes(reviewModel.model)) {
    return { ...fallback, source: "current" };
  }

  return {
    selectedModel: reviewModel,
    provider,
    providerId: provider.type,
    model: reviewModel.model,
    source: "configured",
  };
}

export function buildProviderRuntimeConfig(
  provider: AppSettings["customProviders"][number],
  model: string,
  controlsInput?: ChatRuntimeControls,
) {
  const modelConfig = findProviderModelConfig(provider, model);
  const reasoningParams = {
    providerId: provider.type,
    requestFormat: provider.requestFormat,
    modelId: model,
    baseUrl: provider.baseUrl,
    modelConfig,
  };
  const controls = normalizeChatRuntimeControlsForProvider(controlsInput, reasoningParams);
  const reasoningSupported = getChatRuntimeReasoningLevelsForProvider(reasoningParams).length > 0;
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    customHeaders: provider.customHeaders,
    requestFormat: provider.requestFormat,
    reasoning: reasoningSupported
      ? controls.thinkingEnabled
        ? controls.reasoning
        : "off"
      : undefined,
    promptCachingEnabled: provider.promptCachingEnabled,
    promptCacheRetention: provider.promptCacheRetention,
    nativeWebSearchEnabled: controls.nativeWebSearchEnabled,
    useSystemProxy: provider.useSystemProxy,
    modelConfig,
  };
}

export function selectedModelsMatch(
  left: SelectedModel | undefined,
  right: SelectedModel | undefined,
) {
  return (
    Boolean(left) &&
    Boolean(right) &&
    left?.customProviderId === right?.customProviderId &&
    left?.model === right?.model
  );
}
