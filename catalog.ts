import {
  THINKING_EFFORTS,
  type Model,
  type ModelSpec,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
  hasModelScopedEffortLadder,
  resolveModelPolicy,
} from "@oh-my-pi/pi-catalog/compat/resolve";
import { API_ID, BASE_URL, PROVIDER_ID, fetchCatalog, type CatalogModel } from "./api";

function modelThinking(model: Model | ModelSpec) {
  if (!model.reasoning) return undefined;
  const { thinking: _thinking, compat: _compat, ...spec } = model;
  const native = {
    ...spec,
    api: "openai-completions" as const,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
  };
  // Do not replace DeepAI's conservative range with the catalog's generic
  // fallback. Only reviewed model-specific rules justify additional efforts.
  const thinking = hasModelScopedEffortLadder(native)
    ? resolveModelPolicy(native).thinking
    : {
        mode: "effort" as const,
        efforts: THINKING_EFFORTS.filter((effort) =>
          ["minimal", "low", "medium", "high"].includes(effort),
        ),
      };
  return thinking ? { ...thinking, requiresEffort: false, suppressWhenOff: true } : undefined;
}

export function modelDefinition(model: CatalogModel) {
  const definition = {
    id: model.id,
    name: model.name,
    api: API_ID,
    reasoning: model.reasoning,
    input: model.input,
    // DeepAI bills Theos per request, not USD per token.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
  const thinking = modelThinking({ ...definition, provider: PROVIDER_ID, baseUrl: BASE_URL });
  return { ...definition, ...(thinking ? { thinking } : {}) };
}

export function projectDeepAIModels(models: Model[]): Model[] {
  return models.map((model) => {
    const { thinking: _previous, ...rest } = model;
    const thinking = modelThinking(model);
    return { ...rest, ...(thinking ? { thinking } : {}) };
  });
}

// OMP persists discovery rows. Resolve the native API from the live catalog on
// the first turn too, so a restored Responses model never becomes a Chat model.
let catalog: CatalogModel[] | undefined;

export async function fetchDeepAIModels() {
  const models = await fetchCatalog();
  catalog = models;
  return models.map(modelDefinition);
}

export async function nativeModel(
  model: Model,
  options: Pick<SimpleStreamOptions, "signal" | "fetch">,
): Promise<Model<"openai-completions"> | Model<"openai-responses">> {
  catalog ??= await fetchCatalog(options);
  const metadata = catalog.find((entry) => entry.id === model.id);
  if (!metadata) {
    throw new UnknownDeepAIModelError(model.id);
  }
  const spec = {
    ...modelDefinition(metadata),
    provider: model.provider,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.headers ? { headers: model.headers } : {}),
  };
  return metadata.api === "openai-responses"
    ? buildModel<"openai-responses">({
        ...spec,
        api: "openai-responses",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          reasoningDisableMode: "none-effort",
        },
      })
    : buildModel<"openai-completions">({
        ...spec,
        api: "openai-completions",
        compat: {
          supportsDeveloperRole: false,
          supportsStore: false,
          supportsReasoningEffort: true,
          thinkingFormat: "openai",
          reasoningDisableMode: "none-effort",
        },
      });
}

class UnknownDeepAIModelError extends Error {
  constructor(readonly modelId: string) {
    super(`DeepAI no longer lists model ${modelId}. Refresh the model catalog.`);
    this.name = "UnknownDeepAIModelError";
  }
}
