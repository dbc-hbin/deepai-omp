import { THINKING_EFFORTS, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { API_ID, fetchCatalog, type CatalogModel } from "./api";

export function modelDefinition(model: CatalogModel) {
  return {
    id: model.id,
    name: model.name,
    api: API_ID,
    reasoning: model.reasoning,
    ...(model.reasoning
      ? {
          thinking: {
            mode: "effort",
            requiresEffort: false,
            suppressWhenOff: true,
            efforts: THINKING_EFFORTS.filter((effort) =>
              ["minimal", "low", "medium", "high"].includes(effort),
            ),
          } as const,
        }
      : {}),
    input: model.input,
    // DeepAI bills Theos per request, not USD per token.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
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
