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
import { LANE_HEADERS, machineHeaders } from "./api";
import { nativeModel } from "./catalog";

export function streamDeepAI(model: Model, context: Context, options: SimpleStreamOptions = {}) {
  const output = new AssistantMessageEventStream();
  // This is the provider boundary; failures must settle both iteration and result().
  const run = async () => {
    if (typeof options.apiKey !== "string" || !options.apiKey) {
      throw new ConfigurationError("Sign in to DeepAI Code with /login first.");
    }
    const upstream = await nativeModel(model, options);
    options.signal?.throwIfAborted();
    const { toolChoice, ...nativeOptions } = options;
    const requestOptions = {
      ...nativeOptions,
      apiKey: NO_AUTH_SENTINEL,
      disableReasoning: options.disableReasoning || options.forceReasoningOff || !options.reasoning,
      maxTokensExplicit: options.maxTokens !== undefined,
      headers: {
        ...model.headers,
        ...options.headers,
        ...LANE_HEADERS,
        ...(await machineHeaders()),
        ...(options.sessionId ? { "X-Session-Affinity": options.sessionId } : {}),
        "api-key": options.apiKey,
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
    for await (const event of inner) output.push(event);
    output.end(await inner.result());
  };
  void run().catch((error: unknown) => output.fail(error));
  return output;
}
