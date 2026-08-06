import type { Api, Model } from "@earendil-works/pi-ai";
import { type BuiltinProvider, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const OPENAI_CATALOG_PROVIDER = "openai" satisfies BuiltinProvider;
const XIAOMI_CATALOG_PROVIDER = "xiaomi" satisfies BuiltinProvider;

export function isXiaomiMimoModelId(modelId: string | undefined): boolean {
  return modelId?.trim().toLowerCase().startsWith("mimo-") ?? false;
}

function codexCatalogProvidersForModel(modelId: string): BuiltinProvider[] {
  return isXiaomiMimoModelId(modelId)
    ? [OPENAI_CATALOG_PROVIDER, XIAOMI_CATALOG_PROVIDER]
    : [OPENAI_CATALOG_PROVIDER];
}

/**
 * Resolve models exposed through a Codex/OpenAI-compatible endpoint against
 * the catalog that owns their wire protocol. A relay such as New API keeps the
 * OpenAI-shaped endpoint, but non-OpenAI model families still need their own
 * limits and compatibility metadata.
 */
export function findCodexBuiltinModel(
  modelId: string | undefined,
  api?: Api,
): Model<Api> | undefined {
  const normalizedModelId = modelId?.trim();
  if (!normalizedModelId) return undefined;

  for (const provider of codexCatalogProvidersForModel(normalizedModelId)) {
    const known = getBuiltinModels(provider).find((model) => model.id === normalizedModelId);
    if (known && (!api || known.api === api)) return known as Model<Api>;
  }
  return undefined;
}
