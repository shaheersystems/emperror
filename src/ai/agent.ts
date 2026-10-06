import { stepCountIs, streamText, type ModelMessage, type ToolSet } from "ai";
import { getModel } from "./provider.ts";
import { SYSTEM_PROMPT } from "./prompts.ts";

// Safety cap on tool round-trips per user turn, so a model that keeps emitting
// tool calls can never spin forever.
const MAX_STEPS = 25;

/** Semantic events emitted while the agent processes a turn. */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string; input: unknown }
  | { type: "tool-result"; toolName: string; output: unknown }
  | { type: "tool-error"; toolName: string; error: unknown }
  | { type: "error"; error: unknown };

/**
 * Stateful coding agent. Owns the conversation history and runs a single
 * multi-step turn per `send` call, streaming progress as semantic events so the
 * interface layer decides how to render them.
 */
export class CodingAgent {
  private readonly messages: ModelMessage[] = [];

  constructor(private readonly tools: ToolSet) {}

  async send(
    userInput: string,
    onEvent: (event: AgentEvent) => void
  ): Promise<void> {
    this.messages.push({ role: "user", content: userInput });

    const result = streamText({
      model: getModel(),
      system: SYSTEM_PROMPT,
      messages: this.messages,
      tools: this.tools,
      stopWhen: stepCountIs(MAX_STEPS),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          onEvent({ type: "text", text: part.text });
          break;
        case "tool-call":
          onEvent({
            type: "tool-call",
            toolName: part.toolName,
            input: part.input,
          });
          break;
        case "tool-result":
          onEvent({
            type: "tool-result",
            toolName: part.toolName,
            output: part.output,
          });
          break;
        case "tool-error":
          // Input the SDK rejected before `execute` ran (e.g. schema mismatch).
          onEvent({
            type: "tool-error",
            toolName: part.toolName,
            error: part.error,
          });
          break;
        case "error":
          onEvent({ type: "error", error: part.error });
          break;
        default:
          // Other stream parts (start/finish/step markers) need no handling.
          break;
      }
    }

    // Persist the assistant and tool messages so the next turn has full context.
    const response = await result.response;
    this.messages.push(...response.messages);
  }
}
