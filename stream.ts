import { setTimeout } from "node:timers/promises";
import {
  NO_AUTH_SENTINEL,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { ConfigurationError } from "@oh-my-pi/pi-ai/error";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { mapToOpenAICompletionsToolChoice } from "@oh-my-pi/pi-ai/utils/tool-choice";
import {
  clampThinkingLevelForModel,
  minimumSupportedEffort,
} from "@oh-my-pi/pi-catalog/model-thinking";
import { ensureCheckedIn, LANE_HEADERS, machineHeaders } from "./api";
import { nativeModel } from "./catalog";

export function streamDeepAI(model: Model, context: Context, options: SimpleStreamOptions = {}) {
  const output = new AssistantMessageEventStream();
  // This is the provider boundary; failures must settle both iteration and result().
  const run = async () => {
    const apiKey = options.apiKey;
    if (typeof apiKey !== "string" || !apiKey) {
      throw new ConfigurationError("Sign in to DeepAI Code with /login first.");
    }
    const upstream = await nativeModel(model, { ...options, apiKey });
    options.signal?.throwIfAborted();
    const {
      toolChoice,
      reasoning: requestedReasoning,
      forceReasoningOff: _forceReasoningOff,
      ...nativeOptions
    } = options;
    const disableReasoning =
      options.disableReasoning === true ||
      options.forceReasoningOff === true ||
      requestedReasoning === undefined ||
      upstream.thinking?.effortMap?.[requestedReasoning] === "none";
    const reasoning =
      upstream.thinking?.requiresEffort && disableReasoning
        ? minimumSupportedEffort(upstream)
        : clampThinkingLevelForModel(upstream, requestedReasoning);
    const requestOptions = {
      ...nativeOptions,
      apiKey: NO_AUTH_SENTINEL,
      ...(reasoning !== undefined ? { reasoning } : {}),
      disableReasoning: disableReasoning && !upstream.thinking?.requiresEffort,
      maxTokensExplicit: options.maxTokens !== undefined,
      headers: {
        ...model.headers,
        ...options.headers,
        ...LANE_HEADERS,
        ...(await machineHeaders()),
        ...(options.sessionId ? { "X-Session-Affinity": options.sessionId } : {}),
        "api-key": apiKey,
      },
      onPayload: async (payload: unknown, requestModel?: Model, signal?: AbortSignal) => {
        const replacement = await options.onPayload?.(
          payload,
          requestModel,
          signal ?? options.signal,
        );
        const selected = replacement === undefined ? payload : replacement;
        if (typeof selected !== "object" || selected === null || Array.isArray(selected)) {
          return selected;
        }
        const body: Record<string, unknown> = { ...selected };
        if (upstream.id === "minimax-m3" && reasoning !== undefined && !disableReasoning) {
          body["thinking"] = { type: "adaptive" };
        }
        if (upstream.api === "openai-completions" && Array.isArray(body["messages"])) {
          const messages: unknown[] = body["messages"];
          body["messages"] = messages.map((message) => {
            if (
              typeof message !== "object" ||
              message === null ||
              !("role" in message) ||
              message.role !== "user" ||
              !("content" in message) ||
              !Array.isArray(message.content) ||
              message.content.length === 0
            ) {
              return message;
            }
            const parts: unknown[] = message.content;
            if (
              !parts.every(
                (part): part is { type: "text"; text: string } =>
                  typeof part === "object" &&
                  part !== null &&
                  "type" in part &&
                  part.type === "text" &&
                  "text" in part &&
                  typeof part.text === "string" &&
                  Object.keys(part).length === 2,
              )
            ) {
              return message;
            }
            return { ...message, content: parts.map((part) => part.text).join("") };
          });
        }
        if (options.sessionId) body["prompt_cache_key"] = options.sessionId;
        return body;
      },
      fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, { ...init, redirect: "error" });
        for (;;) {
          await ensureCheckedIn({
            apiKey,
            signal: request.signal,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          });
          request.signal.throwIfAborted();
          const response = await (options.fetch ?? fetch)(request.clone());
          if (response.status !== 409) return response;
          const body: unknown = await response
            .clone()
            .json()
            .catch(() => undefined);
          if (
            typeof body !== "object" ||
            body === null ||
            !("error" in body) ||
            typeof body.error !== "object" ||
            body.error === null ||
            !("code" in body.error) ||
            body.error.code !== "session_busy"
          ) {
            return response;
          }
          await response.body?.cancel();
          const retry = Number(response.headers.get("retry-after") ?? 2);
          const delay = Number.isFinite(retry) ? Math.min(30, Math.max(1, retry)) : 2;
          await setTimeout(delay * 1000, undefined, { signal: request.signal });
        }
      },
    };
    // Call the native transports directly. OMP already owns dispatch, effort
    // selection and the concurrency lease; preserve its terminal-drain flag.
    const chatChoice = mapToOpenAICompletionsToolChoice(toolChoice);
    const inner =
      upstream.api === "openai-responses"
        ? streamOpenAIResponses(upstream, context, {
            ...requestOptions,
            ...(toolChoice ? { toolChoice } : {}),
            ...(options.hideThinkingSummary ? { reasoningSummary: null } : {}),
          })
        : streamOpenAICompletions(upstream, context, {
            ...requestOptions,
            ...(chatChoice ? { toolChoice: chatChoice } : {}),
          });
    for await (const event of inner) {
      if (
        event.type === "error" &&
        event.error.errorMessage === "Provider finish_reason: content-filter"
      ) {
        // Normalize DeepAI's spelling before the event stream classifies the failure.
        event.error.errorMessage =
          "DeepAI blocked the response (content_filter). No detailed reason was provided.";
      }
      output.push(event);
    }
    output.end(await inner.result());
  };
  void run().catch((error: unknown) => output.fail(error));
  return output;
}
