import { expect, test } from "bun:test";
import { scheduler } from "node:timers/promises";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { z } from "zod";
import {
  registerCustomApi,
  streamSimple,
  THINKING_EFFORTS,
  unregisterCustomApis,
  type FetchImpl,
  type Model,
} from "@oh-my-pi/pi-ai";
import { API_ID, BASE_URL, PROVIDER_ID, SEED_MODEL } from "./api";
import { modelDefinition } from "./catalog";
import { deepAIOAuth } from "./oauth";
import { streamDeepAI } from "./stream";

function redirectFetch(origin: string): FetchImpl {
  return (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    return fetch(new Request(`${origin}${target.pathname}${target.search}`, request));
  };
}

test.each([
  { id: "glm-5.3-flash", efforts: ["low", "high", "max"] },
  { id: "gpt-6-luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "unlisted-deepai-model", efforts: ["minimal", "low", "medium", "high"] },
])("the effort menu uses the supported model range for $id", ({ id, efforts }) => {
  const model = buildModel({
    ...modelDefinition({ ...SEED_MODEL, id }),
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
  });
  expect(getSupportedEfforts(model).map(String)).toEqual([...efforts]);
});

test("stored model rows regain missing effort choices when OAuth projects the catalog", () => {
  const cached = buildModel({
    ...modelDefinition({ ...SEED_MODEL, id: "gpt-6-luna" }),
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    thinking: {
      mode: "effort",
      efforts: THINKING_EFFORTS.filter((effort) =>
        ["minimal", "low", "medium", "high"].includes(effort),
      ),
    },
  });
  const projected = deepAIOAuth.modifyModels([cached]);
  expect(projected.map((model) => getSupportedEfforts(model).map(String))).toEqual([
    ["low", "medium", "high", "xhigh", "max"],
  ]);
});

test("desktop login rejects a foreign state before redeeming the valid callback", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body: unknown = await request.json();
      if (
        new URL(request.url).pathname !== "/deepai_code/desktop_auth/exchange/" ||
        JSON.stringify(body) !== JSON.stringify({ code: "single-use-code" })
      ) {
        return new Response(null, { status: 400 });
      }
      return Response.json({ api_key: "account-key", username: "account-user" });
    },
  });
  const callbackChecks = Promise.withResolvers<void>();
  try {
    const credentials = await deepAIOAuth.login({
      fetch: redirectFetch(server.url.origin),
      onPrompt: async () => "",
      onAuth({ url }) {
        const auth = new URL(url);
        const callback = new URL(`http://127.0.0.1:${auth.searchParams.get("port")}/auth-callback`);
        callback.searchParams.set("code", "single-use-code");
        const complete = async () => {
          expect(auth.origin + auth.pathname).toBe(`${BASE_URL}/desktop_auth/`);
          callback.searchParams.set("state", "foreign-state");
          const rejected = await fetch(callback);
          expect(rejected.ok).toBe(false);
          callback.searchParams.set("state", auth.searchParams.get("state") ?? "");
          expect((await fetch(callback)).ok).toBe(true);
        };
        void complete().then(callbackChecks.resolve, callbackChecks.reject);
      },
    });
    await callbackChecks.promise;
    expect(credentials.accountId).toBe("account-user");
    expect(deepAIOAuth.getApiKey(credentials)).toBe("account-key");
    expect(credentials.expires).toBeGreaterThan(Date.now());
  } finally {
    await server.stop(true);
  }
});

test("chat streaming preserves reasoning, tool arguments and usage through OMP dispatch", async () => {
  const chunks = [
    { delta: { reasoning_content: "Check the file." }, finish_reason: null },
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call-read",
            type: "function",
            function: { name: "read", arguments: '{"pa' },
          },
        ],
      },
      finish_reason: null,
    },
    {
      delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] },
      finish_reason: "tool_calls",
    },
  ];
  const responseModel = { ...SEED_MODEL, id: "gpt-6-astra", api: "openai-responses" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) {
        return Response.json({ models: [SEED_MODEL, responseModel] });
      }
      if (
        request.headers.get("api-key") !== "private-key" ||
        request.headers.has("authorization") ||
        request.headers.get("X-DeepAI-Code-Theos") !== "4"
      ) {
        return new Response("Bad desktop authentication", { status: 401 });
      }
      const wire = chunks
        .map((choice) =>
          JSON.stringify({
            id: "completion-one",
            object: "chat.completion.chunk",
            model: SEED_MODEL.id,
            choices: [{ index: 0, ...choice }],
          }),
        )
        .map((json) => `data: ${json}\n\n`)
        .join("");
      return new Response(
        wire +
          'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":12,"total_tokens":42}}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const model: Model = buildModel({
    ...modelDefinition(SEED_MODEL),
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
  });
  const source = "deepai-provider-test";
  registerCustomApi(API_ID, streamDeepAI, source);
  try {
    const result = await streamSimple(
      model,
      { messages: [{ role: "user", content: "Read README.md", timestamp: 1 }] },
      { apiKey: "private-key", fetch: redirectFetch(server.url.origin) },
    ).result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toMatchObject([
      { type: "thinking", thinking: "Check the file." },
      {
        type: "toolCall",
        id: "call-read",
        name: "read",
        arguments: { path: "README.md" },
      },
    ]);
    expect([result.usage.input, result.usage.output]).toEqual([30, 12]);
  } finally {
    unregisterCustomApis(source);
    await server.stop(true);
  }
});

test("a restored Responses model uses the Responses endpoint and parses its completed output", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/models")) {
        return Response.json({
          models: [SEED_MODEL, { ...SEED_MODEL, id: "gpt-6-astra", api: "openai-responses" }],
        });
      }
      if (!pathname.endsWith("/responses")) return new Response(null, { status: 404 });
      const item = {
        type: "message",
        id: "msg-one",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Ready.", annotations: [] }],
      };
      const events = [
        {
          type: "response.created",
          response: { id: "resp-one", status: "in_progress", output: [] },
        },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Ready." },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp-one",
            status: "completed",
            output: [item],
            usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
          },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const model: Model = buildModel({
    ...modelDefinition({ ...SEED_MODEL, id: "gpt-6-astra" }),
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
  });
  try {
    const result = await streamDeepAI(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      { apiKey: "private-key", fetch: redirectFetch(server.url.origin) },
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toMatchObject([{ type: "text", text: "Ready." }]);
    expect([result.usage.input, result.usage.output]).toEqual([8, 2]);
  } finally {
    await server.stop(true);
  }
});

test("thinking off reaches DeepAI as none instead of a mandatory model effort", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) {
        return Response.json({ models: [SEED_MODEL] });
      }
      const parsed = z
        .object({ reasoning_effort: z.literal("none") })
        .safeParse(await request.json());
      if (!parsed.success) return new Response("Reasoning was enabled", { status: 400 });
      return new Response(
        'data: {"choices":[{"delta":{"content":"OFF"},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const model = buildModel({
    ...modelDefinition(SEED_MODEL),
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
  });
  const source = "deepai-off-test";
  registerCustomApi(API_ID, streamDeepAI, source);
  try {
    const result = await streamSimple(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      { apiKey: "private-key", disableReasoning: true, fetch: redirectFetch(server.url.origin) },
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toMatchObject([{ type: "text", text: "OFF" }]);
  } finally {
    unregisterCustomApis(source);
    await server.stop(true);
  }
});

test("the adapter honors the host terminal-drain requirement for a capped request", async () => {
  const usageObserved = Promise.withResolvers<void>();
  const releaseTerminal = Promise.withResolvers<void>();
  const fetchImpl: FetchImpl = async (input) => {
    if (String(input instanceof Request ? input.url : input).endsWith("/models")) {
      return Response.json({ models: [SEED_MODEL] });
    }
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Drained"},"finish_reason":"stop"}]}\n\n' +
              'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
          ),
        );
      },
      async pull(controller) {
        await releaseTerminal.promise;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  };
  const provider = `deepai-drain-${crypto.randomUUID()}`;
  const model = buildModel({
    ...modelDefinition(SEED_MODEL),
    provider,
    baseUrl: BASE_URL,
  });
  let settled = false;
  const completion = streamDeepAI(
    model,
    { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
    {
      apiKey: "private-key",
      fetch: fetchImpl,
      waitForTerminalDrain: true,
      onSseEvent(event) {
        if (event.data.includes('"usage"')) usageObserved.resolve();
      },
    },
  )
    .result()
    .then((result) => {
      settled = true;
      return result;
    });
  try {
    await usageObserved.promise;
    // Flush work scheduled by the observed usage event, without a timed sleep.
    await scheduler.yield();
    expect(settled).toBe(false);
    releaseTerminal.resolve();
    const result = await completion;
    expect(result.content).toMatchObject([{ type: "text", text: "Drained" }]);
  } finally {
    releaseTerminal.resolve();
    await completion;
  }
});
