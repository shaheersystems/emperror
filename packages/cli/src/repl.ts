import { stdout } from "node:process";
import ora, { type Ora } from "ora";
import {
  describeToolCall,
  describeToolResult,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type CodingAgent,
} from "@emperror/core";
import { askApproval } from "./approval.ts";
import { readPrompt } from "./prompt-box.ts";
import { banner, palette, whimsy } from "./theme.ts";

/**
 * What the terminal shows during a turn. Exactly one holds at a time:
 *
 * - `thinking`: the spinner shows a whimsical verb.
 * - `tool`: the spinner shows the status of the latest call still running.
 * - `text`: the spinner is stopped and assistant prose streams inline.
 * - `approving`: everything is paused while the user answers a prompt.
 * - `stopped`: the spinner is gone; the turn failed or finished.
 *
 * Every change goes through `enter`, which closes the old mode's output (e.g.
 * ends an open text block) before starting the new one's.
 */
type RenderMode = "thinking" | "tool" | "text" | "approving" | "stopped";

/**
 * Renders a single agent turn to the terminal with one spinner that steps
 * aside so streamed assistant text prints cleanly.
 */
class TurnRenderer {
  private readonly spinner: Ora;
  private mode: RenderMode = "stopped";
  /** Status lines of tool calls that haven't reported yet, in call order. */
  private readonly running = new Map<string, string>();

  constructor() {
    this.spinner = ora({ spinner: "dots", color: "magenta" });
  }

  /** Begin the turn in the "thinking" state. */
  start(): void {
    this.enter("thinking");
  }

  handle = (event: AgentEvent): void => {
    switch (event.type) {
      case "text":
        if (!event.text) break;
        this.enter("text");
        stdout.write(palette.assistant(event.text));
        break;

      case "tool-call":
        this.running.set(event.toolCallId, describeToolCall(event.toolName, event.input));
        this.enter("tool");
        break;

      case "tool-result": {
        const { ok, text } = describeToolResult(event.toolName, event.output);
        this.settleTool(event.toolCallId, ok ? "succeed" : "warn", text);
        break;
      }

      case "tool-error":
        this.settleTool(
          event.toolCallId,
          "warn",
          `${event.toolName} failed: ${errorText(event.error)}`
        );
        break;

      case "error": {
        const message = errorText(event.error);
        if (this.spinner.isSpinning) this.spinner.fail(palette.err(message));
        else {
          this.enter("stopped");
          stdout.write(palette.err(`\n✖ ${message}\n`));
        }
        this.mode = "stopped";
        break;
      }
    }
  };

  /** Pause the turn's output while the user decides on a tool call. */
  approve = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    this.enter("approving");
    const decision = await askApproval(request);
    this.resume();
    return decision;
  };

  /** Tear down the turn, clearing any lingering spinner or open text block. */
  finish(): void {
    this.enter("stopped");
  }

  /** Persist a finished call as a stable line, then show what is still going on. */
  private settleTool(toolCallId: string, kind: "succeed" | "warn", text: string): void {
    this.running.delete(toolCallId);
    if (this.mode === "text") this.enter("stopped");
    this.spinner[kind](text);
    this.mode = "stopped";
    this.resume();
  }

  /** Back to a running tool's status if any, otherwise to thinking. */
  private resume(): void {
    this.enter(this.running.size > 0 ? "tool" : "thinking");
  }

  private enter(next: RenderMode): void {
    const prev = this.mode;
    this.mode = next;
    if (prev === "text" && next !== "text") stdout.write("\n");

    switch (next) {
      case "thinking":
        if (prev !== "thinking") this.spinner.start(whimsy());
        break;
      case "tool": {
        const status = [...this.running.values()].at(-1) ?? whimsy();
        if (this.spinner.isSpinning) this.spinner.text = status;
        else this.spinner.start(status);
        break;
      }
      case "text":
        if (prev !== "text") {
          this.spinner.stop();
          stdout.write(palette.accent("\n● ") + palette.muted("assistant\n"));
        }
        break;
      case "approving":
      case "stopped":
        this.spinner.stop();
        break;
    }
  }
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Run the interactive read-eval-print loop. Each user line is handed to the
 * agent, whose streamed events are rendered to the terminal.
 */
export async function startRepl(
  agent: CodingAgent,
  modelName: string
): Promise<void> {

  stdout.write(banner(modelName));

  while (true) {
    // `null` means the user asked to quit (Ctrl+C / EOF).
    const line = await readPrompt();
    if (line === null) break;

    const userInput = line.trim();
    const command = userInput.toLowerCase();
    if (command === "exit" || command === "quit") break;
    if (!userInput) continue;

    const renderer = new TurnRenderer();
    renderer.start();
    try {
      await agent.send(userInput, renderer.handle, renderer.approve);
    } catch (err) {
      renderer.handle({ type: "error", error: err });
    } finally {
      renderer.finish();
    }
    stdout.write("\n");
  }

  stdout.write(palette.muted("\n✦ see you next time\n"));
}
