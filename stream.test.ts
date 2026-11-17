import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { Flag, is } from "@oh-my-pi/pi-ai/error";
import { THINKING_EFFORTS, type AssistantMessage, type FetchImpl } from "@oh-my-pi/pi-ai";
import { z } from "zod";
import { BASE_URL, PROVIDER_ID, SEED_MODEL } from "./api";
import { modelDefinition } from "./catalog";
import { streamDeepAI } from "./stream";

const EFFORT = z.enum(THINKING_EFFORTS).enum;

test.each([
  { finishReason: "content_filter", blocked: true },
  { finishReason: "content-filter", blocked: true },
  { finishReason: "network_error", blocked: false },
])(
  "classifies DeepAI $finishReason without losing partial output",
  async ({ finishReason, blocked }) => {
    let completions = 0;
    const fetchImpl: FetchImpl = (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path.endsWith("/models")) return Promise.resolve(Response.json({ models: [SEED_MODEL] }));
      if (path.endsWith("/theos")) {
        return Promise.resolve(
          Response.json({ check_in: { nonce: "1".repeat(32), seconds: 600 } }),
        );
      }
      completions++;
      const choices = [
        { delta: { reasoning_content: "Inspect disk usage." }, finish_reason: null },
        { delta: {}, finish_reason: finishReason },
      ];
      const wire = choices
        .map((choice) => `data: ${JSON.stringify({ choices: [{ index: 0, ...choice }] })}\n\n`)
        .join("");
      return Promise.resolve(
        new Response(`${wire}data: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    };
    const model = buildModel({
      ...modelDefinition(SEED_MODEL),
      provider: PROVIDER_ID,
      baseUrl: BASE_URL,
    });
    const stream = streamDeepAI(
      model,
      { messages: [{ role: "user", content: "Inspect disk usage.", timestamp: 1 }] },
      { apiKey: `filter-test-${finishReason}`, fetch: fetchImpl, maxHttpAttempts: 1 },
    );
    let terminal: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === "error") terminal = event.error;
    }
    const result = await stream.result();
    expect(terminal).toBe(result);
    expect(result.stopReason).toBe("error");
    expect(is(result.errorId, Flag.ContentBlocked)).toBe(blocked);
    expect(result.content).toMatchObject([{ type: "thinking", thinking: "Inspect disk usage." }]);
    expect(completions).toBe(1);
  },
);

type ThinkingWireCase = {
  readonly id: string;
  readonly effort?: Effort;
  readonly wireEffort?: string;
  readonly thinkingType?: string;
  readonly responses?: boolean;
  readonly forceOff?: boolean;
};

const thinkingWireCases: readonly ThinkingWireCase[] = [
  { id: "claude-opus-5-5", effort: EFFORT.xhigh, wireEffort: "xhigh" },
  { id: "claude-fable-5-2", wireEffort: "low" },
  { id: "claude-sonnet-5-5", forceOff: true, wireEffort: "low" },
  { id: "gemini-4-argon", wireEffort: "low" },
  { id: "gemini-4-carbon", effort: EFFORT.medium, wireEffort: "medium" },
  { id: "gemini-4-hydrogen", effort: EFFORT.xhigh, wireEffort: "xhigh" },
  { id: "glm-5.3-flash", wireEffort: "low" },
  { id: "deepseek-v4.1-flash", effort: EFFORT.max, wireEffort: "max" },
  { id: "kimi-k3", wireEffort: "low" },
  { id: "kimi-k3.1-pro", effort: EFFORT.max, wireEffort: "max" },
  { id: "gpt-6-astra", wireEffort: "low" },
  { id: "gpt-6-luna", effort: EFFORT.max, wireEffort: "max" },
  { id: "gpt-6.1-sol", forceOff: true, wireEffort: "low", responses: true },
  { id: "gpt-6.1-terra", wireEffort: "none", responses: true },
  { id: "muse-ember", effort: EFFORT.xhigh, wireEffort: "xhigh" },
  { id: "muse-ember", effort: EFFORT.max, wireEffort: "max" },
  { id: "muse-ember", wireEffort: "minimal" },
  { id: "muse-wonder", effort: EFFORT.max, wireEffort: "max", responses: true },
  { id: "muse-wonder", wireEffort: "minimal" },
  { id: "muse-spark-1.3", wireEffort: "minimal" },
  { id: "minimax-m3.1-flash", effort: EFFORT.max, wireEffort: "max" },
  { id: "minimax-m3.1-flash", wireEffort: "low" },
  { id: "qwen-3.8-flash", effort: EFFORT.high, wireEffort: "xhigh" },
  { id: "qwen-3.8-max-prime", effort: EFFORT.max, wireEffort: "xhigh" },
  { id: "solar-mini-4", effort: EFFORT.minimal, wireEffort: "none" },
  { id: "solar-mini-4", effort: EFFORT.max, wireEffort: "max" },
  { id: "mimo-2.6-flash", effort: EFFORT.low, wireEffort: "low" },
  { id: "mimo-2.6-flash", effort: EFFORT.medium, wireEffort: "medium" },
  { id: "mimo-2.6-flash", effort: EFFORT.high, wireEffort: "high" },
  { id: "mimo-2.6-flash", wireEffort: "none" },
  { id: "mimo-2.6-flash", effort: EFFORT.minimal, wireEffort: "low" },
  { id: "mimo-2.6-flash", effort: EFFORT.xhigh, wireEffort: "high" },
  { id: "mimo-2.6-flash", effort: EFFORT.medium, wireEffort: "medium", responses: true },
  { id: "mimo-2.6-flash", effort: EFFORT.high, wireEffort: "high", responses: true },
  { id: "mimo-2.6-flash", wireEffort: "none", responses: true },
  { id: "mimo-2.6-pro", effort: EFFORT.low, wireEffort: "low" },
  { id: "mimo-2.6-pro", effort: EFFORT.medium, wireEffort: "medium" },
  { id: "mimo-2.6-pro", effort: EFFORT.high, wireEffort: "high" },
  { id: "mimo-2.6-pro", effort: EFFORT.high, forceOff: true, wireEffort: "none" },
  { id: "mimo-2.6-pro", effort: EFFORT.max, wireEffort: "high" },
  { id: "mimo-2.6-pro", effort: EFFORT.low, wireEffort: "low", responses: true },
  { id: "mimo-2.6-pro", effort: EFFORT.medium, wireEffort: "medium", responses: true },
  { id: "mimo-2.6-pro", effort: EFFORT.high, wireEffort: "high", responses: true },
  { id: "mimo-2.6-pro", wireEffort: "none", responses: true },
  { id: "minimax-m3", effort: EFFORT.high, thinkingType: "adaptive" },
  { id: "minimax-m3", thinkingType: "disabled" },
  { id: "deepai-cyber", effort: EFFORT.max },
  { id: "glyph-cluster", effort: EFFORT.high },
  { id: "unlisted-deepai-model", responses: true },
];

test.each(thinkingWireCases)(
  "$id encodes $effort with only its supported reasoning fields",
  async ({ id, effort, wireEffort, thinkingType, responses, forceOff }) => {
    const metadata = {
      ...SEED_MODEL,
      id,
      ...(responses ? { api: "openai-responses" as const } : {}),
    };
    const payloads: unknown[] = [];
    const fetchImpl: FetchImpl = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/models")) return Response.json({ models: [metadata] });
      if (path.endsWith("/theos")) {
        return Response.json({ check_in: { nonce: "e".repeat(32), seconds: 600 } });
      }
      payloads.push(await request.json());
      const item = {
        id: "message",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Ready.", annotations: [] }],
      };
      const wire = responses
        ? [
            { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
            {
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              delta: "Ready.",
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: "response",
                status: "completed",
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("")
        : 'data: {"choices":[{"delta":{"reasoning_content":"Reasoning."},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"Ready."},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n";
      return new Response(wire, { headers: { "Content-Type": "text/event-stream" } });
    };
    const model = buildModel({
      ...modelDefinition(metadata),
      provider: PROVIDER_ID,
      baseUrl: BASE_URL,
    });

    const result = await streamDeepAI(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      {
        apiKey: `thinking-${id}-${effort}-${responses}-${forceOff}`,
        fetch: fetchImpl,
        ...(effort !== undefined ? { reasoning: effort } : {}),
        ...(forceOff ? { forceReasoningOff: true } : {}),
      },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toMatchObject(
      responses
        ? [{ type: "text", text: "Ready." }]
        : [
            { type: "thinking", thinking: "Reasoning." },
            { type: "text", text: "Ready." },
          ],
    );
    const reasoningFields = z.object({
      reasoning_effort: z.string().optional(),
      reasoning: z.object({ effort: z.string().optional() }).optional(),
      thinking: z.object({ type: z.string() }).optional(),
    });
    expect(payloads.map((payload) => reasoningFields.parse(payload))).toEqual([
      {
        ...(wireEffort !== undefined
          ? responses
            ? { reasoning: { effort: wireEffort } }
            : { reasoning_effort: wireEffort }
          : {}),
        ...(thinkingType ? { thinking: { type: thinkingType } } : {}),
      },
    ]);
  },
);
