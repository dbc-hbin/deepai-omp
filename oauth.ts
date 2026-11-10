import { randomBytes } from "node:crypto";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/oauth/callback-server";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { z } from "zod";
import { BASE_URL, http } from "./api";
import { projectDeepAIModels } from "./catalog";

const exchangeSchema = z.object({
  api_key: z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/),
  username: z.string().optional(),
});

class DeepAILogin extends OAuthCallbackFlow {
  constructor(callbacks: OAuthLoginCallbacks) {
    super(callbacks, {
      preferredPort: 0,
      callbackHostname: "127.0.0.1",
      callbackPath: "/auth-callback",
    });
  }

  override generateState(): string {
    return randomBytes(32).toString("hex");
  }

  override async generateAuthUrl(state: string, redirectUri: string) {
    const url = new URL(`${BASE_URL}/desktop_auth/`);
    url.searchParams.set("state", state);
    url.searchParams.set("port", new URL(redirectUri).port);
    return { url: url.href, instructions: "Sign in to DeepAI Code in your browser." };
  }

  override async exchangeToken(code: string): Promise<OAuthCredentials> {
    const payload: unknown = await http
      .post(`${BASE_URL}/desktop_auth/exchange/`, {
        json: { code },
        ...(this.ctrl.fetch ? { fetch: this.ctrl.fetch } : {}),
        ...(this.ctrl.signal ? { signal: this.ctrl.signal } : {}),
      })
      .json();
    this.ctrl.signal?.throwIfAborted();
    const result = exchangeSchema.parse(payload);
    return {
      access: result.api_key,
      refresh: result.api_key,
      // The desktop exchange returns a persistent key, without a refresh token
      // or expiry. A revoked key requires another interactive sign-in.
      expires: Number.MAX_SAFE_INTEGER,
      ...(result.username ? { accountId: result.username } : {}),
    };
  }
}

export const deepAIOAuth = {
  name: "DeepAI Code",
  login: (callbacks: OAuthLoginCallbacks) => new DeepAILogin(callbacks).login(),
  getApiKey: (credentials: OAuthCredentials) => credentials.access,
  // Reproject cached rows too; their previously fixed effort lists can otherwise
  // hide new choices until OMP's discovery cache expires.
  modifyModels: projectDeepAIModels,
};
