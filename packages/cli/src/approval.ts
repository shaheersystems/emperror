import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  describeToolCall,
  type ApprovalDecision,
  type ApprovalRequest,
} from "@emperror/core";
import { palette } from "./theme.ts";

const ANSWERS: Record<string, ApprovalDecision> = {
  "1": "allow-once",
  y: "allow-once",
  "2": "allow-always",
  a: "allow-always",
  "3": "deny",
  n: "deny",
};

/**
 * Ask on the terminal whether a tool call may run. Anything but a recognized
 * answer, including EOF, denies it.
 */
export async function askApproval(
  { toolName, input }: ApprovalRequest,
  streams: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {}
): Promise<ApprovalDecision> {
  const out = streams.output ?? stdout;
  out.write(
    `\n${palette.warn.bold("Allow this action?")} ${describeToolCall(toolName, input)} ` +
      palette.muted(`(${toolName})`) +
      `\n  ${palette.accent("1")} Yes` +
      `\n  ${palette.accent("2")} Yes, and don't ask again for ${toolName} in this project` +
      `\n  ${palette.accent("3")} No\n`
  );

  const rl = createInterface({ input: streams.input ?? stdin, output: out });
  try {
    const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
    const answer = await Promise.race([rl.question(palette.accent("› ")), closed]);
    return ANSWERS[answer?.trim().toLowerCase() ?? ""] ?? "deny";
  } catch {
    return "deny";
  } finally {
    rl.close();
  }
}
