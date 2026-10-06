import { CodingAgent } from "./ai/agent.ts";
import { startRepl } from "./cli/repl.ts";
import { createTools } from "./tools/index.ts";
import { createWorkspace } from "./workspace/workspace.ts";

/**
 * Composition root. Importing `./config/env.ts` (transitively, via the agent)
 * validates configuration at startup, so a misconfigured environment fails fast
 * with a clear message before the REPL starts.
 */
export async function main(): Promise<void> {
  const workspace = createWorkspace(process.cwd());
  await startRepl(new CodingAgent(createTools(workspace)));
}
