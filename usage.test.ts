import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { UsageCredential, UsageProvider } from "@oh-my-pi/pi-ai";
import { ensureCheckedIn } from "./api";
import deepAICodeExtension from "./index";

type Host = Parameters<typeof deepAICodeExtension>[0];
type ProviderConfig = Parameters<Host["registerProvider"]>[1];

async function fetchUsage(response: {
  readonly body: unknown;
  readonly status?: number;
  readonly credentialType?: UsageCredential["type"];
  readonly signedIn?: boolean;
  readonly signal?: AbortSignal;
}) {
  const apiKey = `theos-${randomUUID()}`;
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname);
      if (
        request.method !== "GET" ||
        request.headers.get("api-key") !== apiKey ||
        request.headers.get("X-DeepAI-Code-Theos") !== "6" ||
        !request.headers.get("X-DeepAI-Code-Beacon")?.includes("client=deepai-code-omp")
      ) {
        return Response.json({ error: { code: "auth_required" } }, { status: 401 });
      }
      return Response.json(response.body, { status: response.status ?? 200 });
    },
  });
  const providers = new Map<string, ProviderConfig>();
  deepAICodeExtension({
    setLabel() {},
    registerProvider(id, config) {
      providers.set(id, config);
    },
  });
  try {
    const usage: UsageProvider | undefined = providers.get("deepai-code")?.usage;
    if (!usage) throw new Error("DeepAI did not register a native usage provider.");
    const report = await usage.fetchUsage(
      {
        provider: "deepai-code",
        credential: {
          type: response.credentialType ?? "oauth",
          accountId: "theos-account",
          ...(response.signedIn !== false ? { apiKey, accessToken: apiKey } : {}),
        },
        ...(response.signal ? { signal: response.signal } : {}),
      },
      {
        fetch(input, init) {
          const request = new Request(input, init);
          const url = new URL(request.url);
          return fetch(new Request(`${server.url.origin}${url.pathname}${url.search}`, request));
        },
      },
    );
    return { apiKey, paths, report };
  } finally {
    await server.stop(true);
  }
}

test.each(["oauth", "api_key"] as const)(
  "native /usage reports authenticated Theo balances for %s credentials",
  async (credentialType) => {
    const result = await fetchUsage({
      credentialType,
      body: {
        enabled: true,
        balance: "25.12500",
        granted: "100",
        refresh_at: "2026-11-18T00:00:00Z",
        check_in: { nonce: "c".repeat(32), seconds: 600 },
      },
    });

    expect(result.paths).toEqual(["/deepai_code/theos"]);
    expect(result.report?.limits).toEqual([
      {
        id: "deepai-code:theos",
        label: "Theos",
        scope: { provider: "deepai-code", tier: "Premier", accountId: "theos-account" },
        amount: { unit: "credits", remaining: 25.125 },
        window: {
          id: "refresh",
          label: "Theo refresh",
          resetsAt: Date.UTC(2026, 10, 18),
          resetLabel: "refreshes",
        },
        notes: ["Balance: 25.12500 Theos", "Granted: 100 Theos"],
      },
    ]);
    await ensureCheckedIn({
      apiKey: result.apiKey,
      fetch: () => Promise.reject(new Error("The usage response should already check in.")),
    });
  },
);

test.each([
  { balance: "0", enabled: true, remaining: 0, note: "Balance: 0 Theos" },
  { balance: null, enabled: true, note: "Balance: unavailable" },
  { balance: "25", enabled: false, note: "Balance: unavailable" },
  { enabled: true, note: "Balance: unavailable" },
])("native /usage distinguishes zero from unavailable allowance %j", async (allowance) => {
  const result = await fetchUsage({ body: allowance });

  expect(result.report?.limits[0]?.amount).toEqual({
    unit: "credits",
    ...("remaining" in allowance ? { remaining: allowance.remaining } : {}),
  });
  expect(result.report?.limits[0]?.notes).toEqual([allowance.note]);
});

test("native /usage does not request a balance without credentials", async () => {
  const result = await fetchUsage({ signedIn: false, body: {} });

  expect(result.paths).toEqual([]);
  expect(result.report).toBeNull();
});

test.each([401, 403, 426, 503])(
  "native /usage reports HTTP %s as unavailable while retaining the check-in",
  async (status) => {
    const result = await fetchUsage({
      status,
      body: {
        error: { code: "metering_refused" },
        check_in: { nonce: "d".repeat(32), seconds: 600 },
      },
    });

    expect(result.report?.limits).toEqual([]);
    expect(result.report?.notes).toEqual([
      `Theo balance unavailable (HTTP ${status}). Model access is independent.`,
    ]);
    await ensureCheckedIn({
      apiKey: result.apiKey,
      fetch: () => Promise.reject(new Error("A refused balance can still check in.")),
    });
  },
);

test.each([
  { balance: "not-a-number" },
  { balance: 0 },
  { balance: "10", refresh_at: "not-a-date" },
  { balance: "9".repeat(400) },
])("native /usage rejects malformed allowance %j without inventing a balance", async (body) => {
  const result = await fetchUsage({ body });

  expect(result.report?.limits).toEqual([]);
  expect(result.report?.notes).toEqual([
    "Theo balance unavailable: DeepAI returned an invalid response.",
  ]);
});

test("native /usage propagates cancellation rather than caching an unavailable report", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Usage cancelled"));

  await rejects(
    fetchUsage({ signal: controller.signal, body: { balance: "10" } }),
    /Usage cancelled/,
  );
});
