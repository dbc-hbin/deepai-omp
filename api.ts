import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { ConfigurationError } from "@oh-my-pi/pi-ai/error";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import ky, { HTTPError } from "ky";
import { z } from "zod";
import packageInfo from "./package.json";

export const PROVIDER_ID = "deepai-code";
export const API_ID = "deepai-code";
export const BASE_URL = "https://api.deepai.org/deepai_code";
export const LANE_HEADERS = {
  "X-DeepAI-Code-Theos": "6",
  "X-DeepAI-Code-Instance": randomBytes(16).toString("hex"),
} as const;

export const http = ky.create({ retry: 0, timeout: 20_000, redirect: "error" });
export type DeepAIRequestOptions = Pick<SimpleStreamOptions, "signal" | "fetch"> & {
  apiKey: string | undefined;
};

const modelSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  name: z.string().min(1),
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])).refine((input) => input.includes("text")),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  api: z.literal("openai-responses").optional(),
  premier: z.boolean().optional(),
  theosPerRequest: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .optional(),
});

export const catalogSchema = z.object({ models: z.array(modelSchema).min(1) });
export type CatalogModel = z.infer<typeof modelSchema>;

// This is the desktop app's bundled model, used before OMP's model discovery.
export const SEED_MODEL: CatalogModel = {
  id: "glm-5.3-flash",
  name: "GLM 5.3 Flash",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  premier: false,
  theosPerRequest: "0",
};

const exec = promisify(execFile);
let machine: Promise<Record<string, string>> | undefined;

async function detectMachine(): Promise<Record<string, string>> {
  // Use the desktop client's real hardware identity; never mint another machine.
  if (process.platform !== "darwin") return {};
  const { stdout } = await exec("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  const raw = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1];
  return raw
    ? { "X-DeepAI-Code-Machine": createHash("sha256").update(raw.toLowerCase()).digest("hex") }
    : {};
}

export function machineHeaders(): Promise<Record<string, string>> {
  machine ??= detectMachine();
  return machine;
}

const checkInSchema = z.object({
  check_in: z.object({
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    seconds: z.number().positive(),
  }),
});
interface CheckInState {
  mark?: { nonce: string; renewAt: number; expiresAt: number };
  pending?: Promise<void>;
}
const checkIns = new Map<string, CheckInState>();

export async function ensureCheckedIn(options: DeepAIRequestOptions): Promise<void> {
  options.signal?.throwIfAborted();
  const apiKey = options.apiKey;
  if (!apiKey) throw new ConfigurationError("Sign in to DeepAI Code with /login first.");
  const state: CheckInState = checkIns.get(apiKey) ?? {};
  checkIns.set(apiKey, state);
  if (state.mark && Date.now() < state.mark.renewAt) return;
  if (!state.pending) {
    const noteCheckIn = (payload: unknown) => {
      const parsed = checkInSchema.safeParse(payload);
      if (!parsed.success) return false;
      const { nonce, seconds } = parsed.data.check_in;
      const now = Date.now();
      state.mark = { nonce, renewAt: now + (seconds * 1000) / 2, expiresAt: now + seconds * 1000 };
      return true;
    };
    // The renewal belongs to the account, not to whichever concurrent turn
    // started it. Each waiter can cancel without aborting the shared request.
    state.pending = (async () => {
      try {
        const payload: unknown = await http
          .get(`${BASE_URL}/theos`, {
            headers: {
              ...LANE_HEADERS,
              ...(await machineHeaders()),
              "api-key": apiKey,
              "X-DeepAI-Code-Beacon": `v=${packageInfo.version};up=${Math.floor(process.uptime())};client=${packageInfo.name}`,
              ...(state.mark ? { "X-DeepAI-Code-Check-In": state.mark.nonce } : {}),
            },
            ...(options.fetch ? { fetch: options.fetch } : {}),
          })
          .json();
        if (!noteCheckIn(payload)) throw new Error("DeepAI did not return a valid check-in.");
      } catch (error) {
        const refreshed =
          error instanceof HTTPError &&
          noteCheckIn(
            await error.response
              .clone()
              .json()
              .catch(() => undefined),
          );
        if (
          state.mark &&
          Date.now() < state.mark.expiresAt &&
          (refreshed || !(error instanceof HTTPError) || error.response.status >= 500)
        ) {
          if (!refreshed) state.mark.renewAt = Math.min(state.mark.expiresAt, Date.now() + 5000);
          return;
        }
        throw error;
      } finally {
        delete state.pending;
      }
    })();
  }
  await raceWithSignal(state.pending, options.signal);
}

export async function fetchCatalog(options: DeepAIRequestOptions): Promise<CatalogModel[]> {
  if (!options.apiKey) {
    throw new ConfigurationError("Sign in to DeepAI Code with /login first.");
  }
  const payload: unknown = await http
    .get(`${BASE_URL}/models`, {
      headers: { ...LANE_HEADERS, ...(await machineHeaders()), "api-key": options.apiKey },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    .json();
  return catalogSchema.parse(payload).models;
}
