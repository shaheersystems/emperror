import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import {
  createMemoryPolicy,
  type ApprovalRequest,
  type RequestApproval,
  type ToolPolicy,
} from "../policy/policy.ts";
import { SYSTEM_PROMPT } from "./prompts.ts";

// Safety cap on tool round-trips per user turn, so a model that keeps emitting
// tool calls can never spin forever.
const MAX_STEPS = 25;

/** Semantic events emitted while the agent processes a turn. */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { type: "tool-error"; toolCallId: string; toolName: string; error: unknown }
  | { type: "error"; error: unknown };

export interface CodingAgentOptions {
  model: LanguageModel;
  tools: ToolSet;
  /** Tools that run without asking. Defaults to none: every call needs approval. */
  policy?: ToolPolicy;
}

/** What a denied tool call returns to the model, shaped like a failed outcome. */
export interface DeniedCall {
  ok: false;
  code: "denied";
  message: string;
}

/**
 * Stateful coding agent. Owns the conversation history and runs a single
 * multi-step turn per `send` call, streaming progress as semantic events so the
 * interface layer decides how to render them.
 *
 * A failed turn is reported once, as an "error" event, and is not committed:
 * the history is left as it was before the user's message, so the next turn
 * starts clean.
 *
 * Every tool call needs the user's approval unless the policy allows its tool.
 * Without a `requestApproval` handler, calls the policy doesn't allow are denied.
 */
export class CodingAgent {
  private readonly messages: ModelMessage[] = [];
  private readonly model: LanguageModel;
  private readonly tools: ToolSet;
  private readonly policy: ToolPolicy;

  constructor({ model, tools, policy = createMemoryPolicy() }: CodingAgentOptions) {
    this.model = model;
    this.tools = tools;
    this.policy = policy;
  }

  async send(
    userInput: string,
    onEvent: (event: AgentEvent) => void,
    requestApproval?: RequestApproval
  ): Promise<void> {
    const userMessage: ModelMessage = { role: "user", content: userInput };

    const result = streamText({
      model: this.model,
      system: SYSTEM_PROMPT,
      messages: [...this.messages, userMessage],
      tools: this.gateTools(requestApproval),
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
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          break;
        case "tool-result":
          onEvent({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
          });
          break;
        case "tool-error":
          // Input the SDK rejected before `execute` ran (e.g. schema mismatch).
          onEvent({
            type: "tool-error",
            toolCallId: part.toolCallId,
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

  /**
   * Wrap each tool so it runs only once approved. Calls in one step may run in
   * parallel, so approvals are asked one at a time, and the policy is checked
   * again after waiting: an earlier "allow-always" may already cover the call.
   */
  private gateTools(requestApproval?: RequestApproval): ToolSet {
    let queue: Promise<unknown> = Promise.resolve();
    const authorize = (request: ApprovalRequest): Promise<boolean> => {
      const decided = queue.then(async () => {
        if (this.policy.isAllowed(request.toolName)) return true;
        const decision = (await requestApproval?.(request)) ?? "deny";
        if (decision === "allow-always") this.policy.allowForProject(request.toolName);
        return decision !== "deny";
      });
      queue = decided.catch(() => {});
      return decided;
    };

    return Object.fromEntries(
      Object.entries(this.tools).map(([toolName, t]) => [
        toolName,
        {
          ...t,
          execute: async (input: unknown, options: { toolCallId: string }) => {
            const approved = await authorize({
              toolCallId: options.toolCallId,
              toolName,
              input,
              canAllowAlways: this.policy.canAllowForProject(toolName),
            });
            if (!approved) {
              const denied: DeniedCall = {
                ok: false,
                code: "denied",
                message: `The user denied ${toolName}`,
              };
              return denied;
            }
            return t.execute!(input, options as Parameters<NonNullable<typeof t.execute>>[1]);
          },
        },
      ])
    );
  }
}
