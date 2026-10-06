import { createConfiguredAgent } from "@emperror/core";
import { startRepl } from "./repl.ts";

const { agent, modelName } = createConfiguredAgent();
await startRepl(agent, modelName);
