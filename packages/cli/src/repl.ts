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
 * Renders a single agent turn to the terminal. It owns one spinner that shows a
 * whimsical "working" verb between actions, swaps to a human-readable status
 * while a tool runs, and steps aside so streamed assistant text prints cleanly.
 */
class TurnRenderer {
  private readonly spinner: Ora;
  private textOpen = false;

  constructor() {
    this.spinner = ora({ text: whimsy(), spinner: "dots", color: "magenta" });
  }

  /** Begin the turn in the "thinking" state. */
  start(): void {
    this.spinner.start();
  }

  handle = (event: AgentEvent): void => {
    switch (event.type) {
      case "text": {
        if (!event.text) break;
        // Assistant prose: drop the spinner and stream the text inline.
        if (this.spinner.isSpinning) this.spinner.stop();
        if (!this.textOpen) {
          stdout.write(palette.accent("\n● ") + palette.muted("assistant\n"));
          this.textOpen = true;
        }
        stdout.write(palette.assistant(event.text));
        break;
      }

      case "tool-call": {
        this.closeText();
        const status = describeToolCall(event.toolName, event.input);
        if (!this.spinner.isSpinning) this.spinner.start();
        this.spinner.text = status;
        break;
      }

      case "tool-result": {
        const { ok, text } = describeToolResult(event.toolName, event.output);
        // Persist the finished action as a stable line, then return to thinking.
        if (ok) this.spinner.succeed(text);
        else this.spinner.warn(text);
        this.spinner.start(whimsy());
        break;
      }

      case "tool-error": {
        const message =
          event.error instanceof Error ? event.error.message : String(event.error);
        this.spinner.warn(`${event.toolName} failed: ${message}`);
        this.spinner.start(whimsy());
        break;
      }

      case "error": {
        const message =
          event.error instanceof Error ? event.error.message : String(event.error);
        this.closeText();
        if (this.spinner.isSpinning) this.spinner.fail(palette.err(message));
        else stdout.write(palette.err(`\n✖ ${message}\n`));
        break;
      }
    }
  };

  /** Pause the spinner and any open text while the user decides on a tool call. */
  approve = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    const status = this.spinner.text;
    if (this.spinner.isSpinning) this.spinner.stop();
    this.closeText();
    const decision = await askApproval(request);
    this.spinner.start(status);
    return decision;
  };

  /** Tear down the turn, clearing any lingering spinner or open text block. */
  finish(): void {
    if (this.spinner.isSpinning) this.spinner.stop();
    this.closeText();
  }

  private closeText(): void {
    if (this.textOpen) {
      stdout.write("\n");
      this.textOpen = false;
    }
  }
}

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
