import type { UsageProvider } from "@oh-my-pi/pi-ai";
import { HTTPError } from "ky";
import { z } from "zod";
import { fetchTheos, PROVIDER_ID } from "./api";

export const deepAIUsageProvider: UsageProvider = {
  id: PROVIDER_ID,
  // The metering endpoint can refuse a key that still works for models.
  validatesCredentials: false,
  supports: (params) => params.provider === PROVIDER_ID,
  async fetchUsage(params, ctx) {
    if (params.provider !== PROVIDER_ID) return null;
    const apiKey = {
      api_key: params.credential.apiKey,
      oauth: params.credential.accessToken,
    }[params.credential.type];
    if (!apiKey) return null;
    try {
      const allowance = await fetchTheos({
        apiKey,
        fetch: ctx.fetch,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const remaining =
        allowance.enabled !== false && allowance.balance != null
          ? z.number().parse(Number(allowance.balance))
          : undefined;
      return {
        provider: params.provider,
        fetchedAt: Date.now(),
        notes: ["Theos apply to Premier models; free model access is independent."],
        limits: [
          {
            id: `${PROVIDER_ID}:theos`,
            label: "Theos",
            scope: {
              provider: params.provider,
              tier: "Premier",
              ...(params.credential.accountId ? { accountId: params.credential.accountId } : {}),
            },
            amount: {
              unit: "credits",
              ...(remaining !== undefined ? { remaining } : {}),
            },
            ...(allowance.refresh_at
              ? {
                  window: {
                    id: "refresh",
                    label: "Theo refresh",
                    resetsAt: Date.parse(allowance.refresh_at),
                    resetLabel: "refreshes",
                  },
                }
              : {}),
            notes: [
              remaining !== undefined
                ? `Balance: ${allowance.balance} Theos`
                : "Balance: unavailable",
              ...(allowance.granted != null ? [`Granted: ${allowance.granted} Theos`] : []),
            ],
          },
        ],
      };
    } catch (error) {
      params.signal?.throwIfAborted();
      if (!(error instanceof Error)) throw error;
      return {
        provider: params.provider,
        fetchedAt: Date.now(),
        limits: [],
        notes: [
          error instanceof HTTPError
            ? `Theo balance unavailable (HTTP ${error.response.status}). Model access is independent.`
            : error instanceof z.ZodError
              ? "Theo balance unavailable: DeepAI returned an invalid response."
              : "Theo balance unavailable: check your connection and refresh /usage.",
        ],
      };
    }
  },
};
