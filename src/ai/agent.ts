import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
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

export interface CodingAgentOptions {
  model: LanguageModel;
  tools: ToolSet;
}

/**
 * Stateful coding agent. Owns the conversation history and runs a single
 * multi-step turn per `send` call, streaming progress as semantic events so the
 * interface layer decides how to render them.
 *
 * A failed turn is reported once, as an "error" event, and is not committed:
 * the history is left as it was before the user's message, so the next turn
 * starts clean.
 */
export class CodingAgent {
  private readonly messages: ModelMessage[] = [];
  private readonly model: LanguageModel;
  private readonly tools: ToolSet;

  constructor({ model, tools }: CodingAgentOptions) {
    this.model = model;
    this.tools = tools;
  }

  async send(
    userInput: string,
    onEvent: (event: AgentEvent) => void
  ): Promise<void> {
    const userMessage: ModelMessage = { role: "user", content: userInput };

    const result = streamText({
      model: this.model,
      system: SYSTEM_PROMPT,
      messages: [...this.messages, userMessage],
      tools: this.tools,
      stopWhen: stepCountIs(MAX_STEPS),
      // Errors reach the caller as "error" events; skip the SDK's console log.
      onError: () => {},
    });

    let failed = false;
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
          failed = true;
          onEvent({ type: "error", error: part.error });
          break;
        default:
          // Other stream parts (start/finish/step markers) need no handling.
          break;
      }
    }

    // Already reported; awaiting the response would only reject with a generic
    // "no output" error on top of it.
    if (failed) return;

    const response = await result.response;
    this.messages.push(userMessage, ...response.messages);
  }
}
