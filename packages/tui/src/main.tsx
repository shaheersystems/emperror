import { createConfiguredAgent, type ConfiguredAgent } from "@emperror/core";
import { render } from "ink";
import { App } from "./app.tsx";

if (!process.stdin.isTTY) {
  console.error("The TUI needs an interactive terminal. For piped input, run `bun run start:cli`.");
  process.exit(1);
}

let configured: ConfiguredAgent;
try {
  configured = createConfiguredAgent();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const app = render(
  <App agent={configured.agent} modelName={configured.modelName} root={process.cwd()} />,
  // The prompt decides what Ctrl+C means (clear the line, or exit when empty).
  { exitOnCtrlC: false }
);
await app.waitUntilExit();
