import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { BASE_URL, PROVIDER_ID, SEED_MODEL } from "./api";
import { modelDefinition } from "./catalog";
import { deepAIOAuth } from "./oauth";

test.each([
  { id: "claude-fable-5-2", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "deepai-cyber", efforts: [] },
  { id: "deepseek-v4.1-flash", efforts: ["low", "high", "max"] },
  { id: "gemini-4-argon", efforts: ["low", "medium", "high"] },
  { id: "gemini-4-carbon", efforts: ["low", "medium", "high"] },
  { id: "gemini-4-hydrogen", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "glm-5.3", efforts: ["low", "high", "max"] },
  { id: "glm-5.3-flash", efforts: ["low", "high", "max"] },
  { id: "glyph-cluster", efforts: [] },
  { id: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6.1-sol", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6.1-terra", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "kimi-k3", efforts: ["low", "high", "max"] },
  { id: "kimi-k3.1-pro", efforts: ["low", "high", "max"] },
  { id: "mimo-2.6-flash", efforts: ["low", "medium", "high"], defaultLevel: "low" },
  { id: "mimo-2.6-pro", efforts: ["low", "medium", "high"], defaultLevel: "low" },
  { id: "minimax-m3", efforts: ["high"] },
  { id: "minimax-m3.1-flash", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "muse-ember", efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  { id: "muse-spark-1.3", efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  { id: "muse-wonder", efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  { id: "qwen-3.8-flash", efforts: ["low", "medium", "xhigh"] },
  { id: "qwen-3.8-max-prime", efforts: ["low", "medium", "xhigh"] },
  { id: "solar-mini-4", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "unlisted-deepai-model", efforts: [] },
])("cached $id exposes only its documented thinking controls", (entry) => {
  const { id, efforts } = entry;
  const cached = buildModel({
    ...modelDefinition({ ...SEED_MODEL, id }),
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning: true,
    thinking: {
      mode: "effort",
      efforts: THINKING_EFFORTS,
    },
  });

  const [projected] = deepAIOAuth.modifyModels([cached]);

  expect(projected).toBeDefined();
  if (!projected) throw new Error("The cached model was removed.");
  const model = buildModel(projected);
  expect(getSupportedEfforts(model).map(String)).toEqual([...efforts]);
  expect(model.reasoning).toBe(efforts.length > 0);
  if ("defaultLevel" in entry) {
    expect(String(model.thinking?.defaultLevel)).toBe(entry.defaultLevel);
  }
});
