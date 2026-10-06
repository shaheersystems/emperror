import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const EnvSchema = z.object({
  GOOGLE_GENERATIVE_AI_API_KEY: z
    .string()
    .min(1, "GOOGLE_GENERATIVE_AI_API_KEY is required"),
  GOOGLE_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  // Optional override for the API endpoint (e.g. a proxy or gateway).
  BASE_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Load variables from a local .env file (a no-op for variables already in
 * process.env) and validate them, throwing a readable error listing every
 * problem. Called once, by the composition root.
 */
export function loadEnv(): Env {
  loadDotenv();
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
