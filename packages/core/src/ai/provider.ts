import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { Env } from "../config/env.ts";

/**
 * The production language model, resolved from configuration. `baseURL` is
 * left undefined to target the default Google Generative AI endpoint, or set
 * to point at a proxy/gateway.
 */
export function createModel(env: Env): LanguageModel {
  const provider = createGoogleGenerativeAI({
    apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
    baseURL: env.BASE_URL,
  });
  return provider(env.GOOGLE_MODEL);
}
