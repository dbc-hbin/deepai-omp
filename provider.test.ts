import { expect, setSystemTime, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { scheduler } from "node:timers/promises";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { z } from "zod";
import {
  registerCustomApi,
  streamSimple,
  THINKING_EFFORTS,
  type,
  unregisterCustomApis,
  type FetchImpl,
  type Model,
} from "@oh-my-pi/pi-ai";
import { API_ID, BASE_URL, PROVIDER_ID, SEED_MODEL, ensureCheckedIn } from "./api";
import { modelDefinition, nativeModel } from "./catalog";
import { deepAIOAuth } from "./oauth";
import { streamDeepAI } from "./stream";

function redirectFetch(origin: string): FetchImpl {
  return (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    return fetch(new Request(`${origin}${target.pathname}${target.search}`, request));
  };
}

test("OAuth restores DeepAI effort choices while preserving other providers", () => {
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
  const foreign = buildModel({
    ...modelDefinition({ ...SEED_MODEL, id: "combo/deepseek-4-1-flash" }),
    provider: "inferhub",
    api: "openai-completions",
    baseUrl: "https://api.inferhub.dev/v1",
    reasoning: true,
    thinking: {
      mode: "effort",
      efforts: THINKING_EFFORTS.filter((effort) => ["low", "high", "max"].includes(effort)),
    },
  });
  const projected = deepAIOAuth.modifyModels([cached, foreign]);
  expect(projected.map((model) => getSupportedEfforts(model).map(String))).toEqual([
    ["low", "medium", "high", "xhigh", "max"],
    ["low", "high", "max"],
  ]);
  expect(projected[1]).toBe(foreign);
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

test("catalog metadata is authenticated and isolated between accounts", async () => {
  const requests: string[] = [];
  const fetchImpl: FetchImpl = (input, init) => {
    const request = new Request(input, init);
    const apiKey = request.headers.get("api-key") ?? "";
    requests.push(apiKey);
    return Promise.resolve(
      Response.json({
        models: [
          {
            ...SEED_MODEL,
            ...(apiKey === "catalog-account-two" ? { api: "openai-responses" } : {}),
          },
        ],
      }),
    );
  };
  const model = buildModel({
    ...modelDefinition(SEED_MODEL),
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
  });
  await rejects(
    nativeModel(model, { apiKey: undefined, fetch: fetchImpl }),
    /Sign in to DeepAI Code/,
  );
  for (const apiKey of ["catalog-account-one", "catalog-account-one", "catalog-account-two"]) {
    const native = await nativeModel(model, { apiKey, fetch: fetchImpl });
    expect(native.api).toBe(
      apiKey === "catalog-account-two" ? "openai-responses" : "openai-completions",
    );
  }
  expect(requests).toEqual(["catalog-account-one", "catalog-account-two"]);
});

test("check-ins share renewal, isolate cancellation and renew the nonce before expiry", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const requests: Request[] = [];
  const now = Date.now();
  let unavailable = false;
  const fetchImpl: FetchImpl = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    expect(new URL(request.url).pathname).toBe("/deepai_code/theos");
    expect(request.headers.get("api-key")).toBe("check-in-account");
    expect(request.headers.get("X-DeepAI-Code-Theos")).toBe("6");
    expect(request.headers.get("X-DeepAI-Code-Beacon")).toContain("client=deepai-code-omp");
    expect(request.headers.get("X-DeepAI-Code-Beacon")).not.toMatch(/(?:^|;)(?:focus|pi)=/);
    expect(request.headers.has("authorization")).toBe(false);
    if (requests.length === 1) {
      started.resolve();
      await release.promise;
    }
    return unavailable
      ? Response.json({ error: { code: "unavailable" } }, { status: 503 })
      : Response.json({
          check_in: { nonce: (requests.length === 1 ? "a" : "b").repeat(32), seconds: 600 },
        });
  };
  setSystemTime(now);
  const first = ensureCheckedIn({
    apiKey: "check-in-account",
    fetch: fetchImpl,
    signal: controller.signal,
  });
  const second = ensureCheckedIn({ apiKey: "check-in-account", fetch: fetchImpl });
  try {
    await started.promise;
    controller.abort(new Error("Cancel only this turn"));
    await rejects(first, /Cancel only this turn/);
    release.resolve();
    await second;
    expect(requests).toHaveLength(1);
    setSystemTime(now + 301_000);
    await ensureCheckedIn({ apiKey: "check-in-account", fetch: fetchImpl });
    expect(requests[1]?.headers.get("X-DeepAI-Code-Check-In")).toBe("a".repeat(32));
    unavailable = true;
    setSystemTime(now + 602_000);
    await ensureCheckedIn({ apiKey: "check-in-account", fetch: fetchImpl });
    expect(requests[2]?.headers.get("X-DeepAI-Code-Check-In")).toBe("b".repeat(32));
    setSystemTime(now + 902_000);
    await rejects(ensureCheckedIn({ apiKey: "check-in-account", fetch: fetchImpl }));
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    setSystemTime();
  }
});

test("authenticated Chat preserves reasoning, tools and usage", async () => {
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
  const payloads: unknown[] = [];
  const sessionId = "deepai-chat-session";
  let hooks = 0;
  const responseModel = { ...SEED_MODEL, id: "gpt-6-astra", api: "openai-responses" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        request.headers.get("api-key") !== "private-key" ||
        request.headers.has("authorization") ||
        request.headers.get("X-DeepAI-Code-Theos") !== "6"
      ) {
        return new Response("Bad desktop authentication", { status: 401 });
      }
      if (new URL(request.url).pathname.endsWith("/models")) {
        return Response.json({ models: [SEED_MODEL, responseModel] });
      }
      if (new URL(request.url).pathname.endsWith("/theos")) {
        return Response.json({ check_in: { nonce: "1".repeat(32), seconds: 600 } });
      }
      expect(request.headers.get("X-Session-Affinity")).toBe(sessionId);
      expect(request.headers.has("X-DeepAI-Code-Check-In")).toBe(false);
      expect(request.headers.has("X-DeepAI-Code-Beacon")).toBe(false);
      payloads.push(await request.json());
      if (payloads.length === 2) {
        return new Response(
          'data: {"choices":[{"delta":{"content":"Read completed."},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
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
  const high = THINKING_EFFORTS.find((effort) => ["high"].includes(effort));
  const tools = [
    { name: "read", description: "Read a file.", parameters: type({ path: "string" }) },
  ];
  const user = {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "Read " },
      { type: "text" as const, text: "README.md" },
    ],
    timestamp: 1,
  };
  try {
    const result = await streamSimple(
      model,
      { systemPrompt: ["Use the provided tools."], messages: [user], tools },
      {
        apiKey: "private-key",
        fetch: redirectFetch(server.url.origin),
        sessionId,
        ...(high ? { reasoning: high } : {}),
        toolChoice: { type: "function", name: "read" },
        onPayload(payload) {
          hooks++;
          expect(typeof payload).toBe("object");
          return {
            ...(typeof payload === "object" ? payload : {}),
            prompt_cache_key: "caller-key",
          };
        },
      },
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
    expect(payloads[0]).toMatchObject({
      prompt_cache_key: sessionId,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "Use the provided tools." },
        { role: "user", content: "Read README.md" },
      ],
      tools: [{ type: "function", function: { name: "read" } }],
      tool_choice: { type: "function", function: { name: "read" } },
    });
    const replay = await streamSimple(
      model,
      {
        tools,
        messages: [
          user,
          result,
          {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: [{ type: "text", text: "File contents." }],
            isError: false,
            timestamp: 2,
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Also inspect this image." },
              { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            ],
            timestamp: 3,
          },
        ],
      },
      { apiKey: "private-key", fetch: redirectFetch(server.url.origin), sessionId },
    ).result();
    expect(replay.stopReason).toBe("stop");
    expect(hooks).toBe(1);
    expect(payloads[1]).toMatchObject({
      prompt_cache_key: sessionId,
      messages: expect.arrayContaining([
        { role: "tool", tool_call_id: "call-read", content: "File contents." },
        {
          role: "user",
          content: [
            { type: "text", text: "Also inspect this image." },
            { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
          ],
        },
      ]),
    });
  } finally {
    unregisterCustomApis(source);
    await server.stop(true);
  }
});

test("a restored Responses model uses the Responses endpoint and parses its completed output", async () => {
  const payloads: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/models")) {
        return Response.json({
          models: [SEED_MODEL, { ...SEED_MODEL, id: "gpt-6-astra", api: "openai-responses" }],
        });
      }
      if (pathname.endsWith("/theos")) {
        return Response.json({ check_in: { nonce: "2".repeat(32), seconds: 600 } });
      }
      if (!pathname.endsWith("/responses")) return new Response(null, { status: 404 });
      expect(request.headers.get("api-key")).toBe("responses-account");
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.get("X-DeepAI-Code-Theos")).toBe("6");
      expect(request.headers.get("X-Session-Affinity")).toBe("responses-session");
      payloads.push(await request.json());
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
      {
        systemPrompt: ["Use the provided tools."],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Hello" },
              { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            ],
            timestamp: 1,
          },
        ],
        tools: [
          { name: "read", description: "Read a file.", parameters: type({ path: "string" }) },
        ],
      },
      {
        apiKey: "responses-account",
        fetch: redirectFetch(server.url.origin),
        sessionId: "responses-session",
        maxTokens: 16,
        disableReasoning: true,
        toolChoice: "none",
      },
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toMatchObject([{ type: "text", text: "Ready." }]);
    expect([result.usage.input, result.usage.output]).toEqual([8, 2]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      model: "gpt-6-astra",
      instructions: "Use the provided tools.",
      prompt_cache_key: "responses-session",
      max_output_tokens: 16,
      reasoning: { effort: "low" },
      tool_choice: "none",
      tools: [{ type: "function", name: "read" }],
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Hello" },
            { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
          ],
        },
      ],
    });
  } finally {
    await server.stop(true);
  }
});

test.each(["session_busy", "other_conflict", "cancelled"])(
  "only the admission conflict %s is retried with the same body and a renewed check-in",
  async (code) => {
    const bodies: string[] = [];
    const nonces: (string | null)[] = [];
    const controller = new AbortController();
    const fetchImpl: FetchImpl = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/models")) return Response.json({ models: [SEED_MODEL] });
      if (path.endsWith("/theos")) {
        nonces.push(request.headers.get("X-DeepAI-Code-Check-In"));
        return Response.json({
          check_in: { nonce: (nonces.length === 1 ? "c" : "d").repeat(32), seconds: 1 },
        });
      }
      bodies.push(await request.text());
      if (bodies.length === 1) {
        if (code === "cancelled") controller.abort();
        return Response.json(
          {
            error: {
              code: code === "cancelled" ? "session_busy" : code,
              message: "Admission refused.",
            },
          },
          { status: 409, headers: { "Retry-After": "0" } },
        );
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"Admitted."},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    const model = buildModel({
      ...modelDefinition(SEED_MODEL),
      provider: PROVIDER_ID,
      baseUrl: BASE_URL,
    });
    const result = await streamDeepAI(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      {
        apiKey: `admission-${code}`,
        fetch: fetchImpl,
        sessionId: "admission-session",
        signal: controller.signal,
      },
    ).result();
    if (code === "session_busy") {
      expect(result.stopReason).toBe("stop");
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(nonces).toEqual([null, "c".repeat(32)]);
    } else {
      expect(result.stopReason).toBe(code === "cancelled" ? "aborted" : "error");
      expect(bodies).toHaveLength(1);
    }
  },
);

test("thinking off reaches DeepAI as none for a model with optional thinking", async () => {
  const metadata = { ...SEED_MODEL, id: "solar-mini-4" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) {
        return Response.json({ models: [metadata] });
      }
      if (new URL(request.url).pathname.endsWith("/theos")) {
        return Response.json({ check_in: { nonce: "3".repeat(32), seconds: 600 } });
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
    ...modelDefinition(metadata),
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
  });
  const source = "deepai-off-test";
  registerCustomApi(API_ID, streamDeepAI, source);
  try {
    const result = await streamSimple(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      {
        apiKey: "solar-off-account",
        disableReasoning: true,
        fetch: redirectFetch(server.url.origin),
      },
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
    if (String(input instanceof Request ? input.url : input).endsWith("/theos")) {
      return Response.json({ check_in: { nonce: "4".repeat(32), seconds: 600 } });
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
