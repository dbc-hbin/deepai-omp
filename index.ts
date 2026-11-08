import { API_ID, BASE_URL, PROVIDER_ID, SEED_MODEL } from "./api";
import { fetchDeepAIModels, modelDefinition } from "./catalog";
import { deepAIOAuth } from "./oauth";
import { streamDeepAI } from "./stream";

// Structural host contract keeps the extension independent of the CLI package.
interface ExtensionAPI {
  setLabel(label: string): void;
  registerProvider(
    id: string,
    config: {
      baseUrl: string;
      api: string;
      authHeader: boolean;
      oauth: typeof deepAIOAuth;
      models: ReturnType<typeof modelDefinition>[];
      fetchDynamicModels: typeof fetchDeepAIModels;
      streamSimple: typeof streamDeepAI;
    },
  ): void;
}

export default function deepAICodeExtension(pi: ExtensionAPI): void {
  pi.setLabel("DeepAI Code");
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: BASE_URL,
    api: API_ID,
    authHeader: false,
    oauth: deepAIOAuth,
    models: [modelDefinition(SEED_MODEL)],
    fetchDynamicModels: fetchDeepAIModels,
    streamSimple: streamDeepAI,
  });
}
