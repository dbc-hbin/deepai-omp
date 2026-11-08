import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import ky from "ky";
import { z } from "zod";

export const PROVIDER_ID = "deepai-code";
export const API_ID = "deepai-code";
export const BASE_URL = "https://api.deepai.org/deepai_code";
export const LANE_HEADERS = {
  "X-DeepAI-Code-Theos": "4",
  "X-DeepAI-Code-Instance": randomBytes(16).toString("hex"),
} as const;

export const http = ky.create({ retry: 0, timeout: 20_000, redirect: "error" });

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

export async function fetchCatalog(
  options: Pick<SimpleStreamOptions, "signal" | "fetch"> = {},
): Promise<CatalogModel[]> {
  const payload: unknown = await http
    .get(`${BASE_URL}/models`, {
      headers: { ...LANE_HEADERS, ...(await machineHeaders()) },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    .json();
  return catalogSchema.parse(payload).models;
}
