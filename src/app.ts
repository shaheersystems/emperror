import { CodingAgent } from "./ai/agent.ts";
import { createModel } from "./ai/provider.ts";
import { startRepl } from "./cli/repl.ts";
import { loadEnv } from "./config/env.ts";
import { createTools } from "./tools/index.ts";
import { createWorkspace } from "./workspace/workspace.ts";

/**
 * Composition root: the only place that reads configuration and chooses
 * concrete adapters. Configuration is validated first, so a misconfigured
 * environment fails fast with a clear message before the REPL starts.
 */
export async function main(): Promise<void> {
  const env = loadEnv();
  const agent = new CodingAgent({
    model: createModel(env),
    tools: createTools(createWorkspace(process.cwd())),
  });
  await startRepl(agent, env.GOOGLE_MODEL);
}
