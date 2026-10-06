/**
 * Public interface of the coding agent core. User interfaces import only from
 * here; nothing in core knows how events are rendered.
 */
import { CodingAgent } from "./ai/agent.ts";
import { createModel } from "./ai/provider.ts";
import { loadEnv } from "./config/env.ts";
import { createTools } from "./tools/index.ts";
import { createWorkspace } from "./workspace/workspace.ts";

export { CodingAgent, type AgentEvent, type CodingAgentOptions } from "./ai/agent.ts";
export {
  describeToolCall,
  describeToolResult,
  type ToolResultSummary,
} from "./tools/index.ts";
export type { Outcome, FailureCode } from "./workspace/workspace.ts";

export interface ConfiguredAgent {
  agent: CodingAgent;
  /** The configured model id, for display. */
  modelName: string;
}

/**
 * Build an agent from the environment, working in `root` (default: the
 * current directory). Validates configuration first and throws a readable
 * error listing every problem, so a UI can fail fast before it starts.
 */
export function createConfiguredAgent({
  root = process.cwd(),
}: { root?: string } = {}): ConfiguredAgent {
  const env = loadEnv();
  const agent = new CodingAgent({
    model: createModel(env),
    tools: createTools(createWorkspace(root)),
  });
  return { agent, modelName: env.GOOGLE_MODEL };
}
