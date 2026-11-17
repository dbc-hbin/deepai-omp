import { THINKING_EFFORTS, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ThinkingConfig } from "@oh-my-pi/pi-catalog/types";
import { z } from "zod";
import {
  hasModelScopedEffortLadder,
  resolveModelPolicy,
} from "@oh-my-pi/pi-catalog/compat/resolve";
import {
  API_ID,
  BASE_URL,
  PROVIDER_ID,
  fetchCatalog,
  type CatalogModel,
  type DeepAIRequestOptions,
} from "./api";

const EFFORT = z.enum(THINKING_EFFORTS).enum;

function modelThinking(model: Model | ModelSpec): ThinkingConfig | undefined {
  if (!model.reasoning) return undefined;
  const { thinking: _thinking, compat: _compat, ...spec } = model;
  const native = {
    ...spec,
    api: "openai-completions" as const,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
  };
  if (model.id === "minimax-m3") {
    // OMP represents a binary thinking switch as Off / High. This model
    // receives thinking.type, never a fictitious reasoning_effort ladder.
    return { mode: "effort", efforts: [EFFORT.high], defaultLevel: EFFORT.high };
  }
  let thinking = hasModelScopedEffortLadder(native)
    ? resolveModelPolicy(native).thinking
    : undefined;
  switch (model.id) {
    // https://platform.claude.com/docs/en/build-with-claude/effort
    case "claude-fable-5-2":
    case "claude-opus-5-5":
    case "claude-sonnet-5-5":
      thinking = resolveModelPolicy({
        ...native,
        providerType: "anthropic",
        api: "anthropic-messages",
      }).thinking;
      if (thinking) {
        thinking = {
          ...thinking,
          defaultLevel: model.id === "claude-opus-5-5" ? EFFORT.medium : EFFORT.high,
        };
      }
      break;
    // Gemini 4 uses native thinking levels; Hydrogen adds xhigh.
    // https://ai.google.dev/gemini-api/docs/whats-new-gemini-4-hydrogen
    case "gemini-4-argon":
    case "gemini-4-carbon":
      thinking = {
        mode: "effort",
        efforts: [EFFORT.low, EFFORT.medium, EFFORT.high],
        defaultLevel: EFFORT.medium,
        requiresEffort: true,
      };
      break;
    case "gemini-4-hydrogen":
      thinking = {
        mode: "effort",
        efforts: [EFFORT.low, EFFORT.medium, EFFORT.high, EFFORT.xhigh],
        defaultLevel: EFFORT.high,
        requiresEffort: true,
      };
      break;
    // Xiaomi's published model catalog offers none/low/medium/high (default low).
    // https://mimo.mi.com/docs/en-US/tokenplan/integration/codex-configuration
    // The Responses schema normalizes minimal -> low and xhigh/max -> high;
    // accepted effort values do not currently imply different reasoning depth.
    case "mimo-2.6-flash":
    case "mimo-2.6-pro":
      thinking = {
        mode: "effort",
        efforts: [EFFORT.low, EFFORT.medium, EFFORT.high],
        defaultLevel: EFFORT.low,
        effortMap: {
          [EFFORT.minimal]: EFFORT.low,
          [EFFORT.xhigh]: EFFORT.high,
          [EFFORT.max]: EFFORT.high,
        },
      };
      break;
    // https://platform.minimax.io/docs/api-reference/text-chat-openai
    case "minimax-m3.1-flash":
      thinking = resolveModelPolicy({
        ...native,
        id: "MiniMax-M3.1-Flash",
        providerType: "minimax",
        api: "anthropic-messages",
      }).thinking;
      if (thinking) thinking = { ...thinking, defaultLevel: EFFORT.max };
      break;
    // https://docs.qwencloud.com/api-reference/chat/openai-chat#reasoning-effort
    case "qwen-3.8-flash":
    case "qwen-3.8-max-prime":
      thinking = {
        mode: "effort",
        efforts: [EFFORT.low, EFFORT.medium, EFFORT.xhigh],
        defaultLevel: EFFORT.xhigh,
        effortMap: {
          [EFFORT.minimal]: EFFORT.low,
          [EFFORT.high]: EFFORT.xhigh,
          [EFFORT.max]: EFFORT.xhigh,
        },
      };
      break;
    // minimal disables Solar reasoning; it is not an enabled effort.
    // https://console.upstage.ai/docs/capabilities/generate/reasoning
    case "solar-mini-4":
      thinking = {
        mode: "effort",
        efforts: [EFFORT.low, EFFORT.medium, EFFORT.high, EFFORT.xhigh, EFFORT.max],
        effortMap: { [EFFORT.minimal]: "none" },
      };
      break;
    // https://dev.meta.ai/docs/reasoning
    case "muse-ember":
    case "muse-wonder":
    case "muse-spark-1.3":
      thinking = {
        mode: "effort",
        efforts: THINKING_EFFORTS,
        defaultLevel: model.id === "muse-spark-1.3" ? EFFORT.high : EFFORT.max,
        requiresEffort: true,
      };
      break;
  }
  if (!thinking) return undefined;
  return {
    ...thinking,
    mode: "effort",
    requiresEffort:
      thinking.requiresEffort === true ||
      [
        "claude-fable-5-2",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "gpt-6-astra",
        "gpt-6.1-sol",
      ].includes(model.id),
    suppressWhenOff: false,
  };
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
  // OMP rebuilds these specs after OAuth projection and would otherwise infer
  // an unreviewed ladder. nativeModel restores the server's reasoning capability.
  return { ...definition, reasoning: thinking !== undefined, ...(thinking ? { thinking } : {}) };
}

export function projectDeepAIModels(models: Model[]): Model[] {
  return models.map((model) => {
    if (model.provider !== PROVIDER_ID) return model;
    const { thinking: _previous, ...rest } = model;
    const thinking = modelThinking(model);
    return { ...rest, reasoning: thinking !== undefined, ...(thinking ? { thinking } : {}) };
  });
}

// OMP persists discovery rows. Resolve the native API from the live catalog on
// the first turn too, so a restored Responses model never becomes a Chat model.
let catalog: { apiKey: string | undefined; models: CatalogModel[] } | undefined;

export async function fetchDeepAIModels(apiKey: string | undefined) {
  const models = await fetchCatalog({ apiKey });
  catalog = { apiKey, models };
  return models.map(modelDefinition);
}

export async function nativeModel(
  model: Model,
  options: DeepAIRequestOptions,
): Promise<Model<"openai-completions"> | Model<"openai-responses">> {
  if (!catalog || catalog.apiKey !== options.apiKey) {
    catalog = { apiKey: options.apiKey, models: await fetchCatalog(options) };
  }
  const metadata = catalog.models.find((entry) => entry.id === model.id);
  if (!metadata) {
    throw new UnknownDeepAIModelError(model.id);
  }
  const spec = {
    ...modelDefinition(metadata),
    reasoning: metadata.reasoning,
    provider: model.provider,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.headers ? { headers: model.headers } : {}),
  };
  const toggleOnly = model.id === "minimax-m3";
  return metadata.api === "openai-responses"
    ? buildModel<"openai-responses">({
        ...spec,
        api: "openai-responses",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: spec.thinking !== undefined,
          supportsReasoningParams: spec.thinking !== undefined,
          trustExplicitThinkingOnly: true,
          reasoningDisableMode: "none-effort",
        },
      })
    : buildModel<"openai-completions">({
        ...spec,
        api: "openai-completions",
        compat: {
          supportsDeveloperRole: false,
          supportsStore: false,
          supportsReasoningEffort: !toggleOnly && spec.thinking !== undefined,
          supportsReasoningParams: spec.thinking !== undefined,
          trustExplicitThinkingOnly: true,
          thinkingFormat: toggleOnly ? "zai" : "openai",
          reasoningDisableMode: toggleOnly ? "zai-thinking-disabled" : "none-effort",
        },
      });
}

class UnknownDeepAIModelError extends Error {
  constructor(readonly modelId: string) {
    super(`DeepAI no longer lists model ${modelId}. Refresh the model catalog.`);
    this.name = "UnknownDeepAIModelError";
  }
}
