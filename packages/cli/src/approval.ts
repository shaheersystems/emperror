import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  describeToolCall,
  type ApprovalDecision,
  type ApprovalRequest,
} from "@emperror/core";
import { palette } from "./theme.ts";

/**
 * Ask on the terminal whether a tool call may run. Anything but a recognized
 * answer, including EOF, denies it.
 */
export async function askApproval(
  { toolName, input, canAllowAlways }: ApprovalRequest,
  streams: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {}
): Promise<ApprovalDecision> {
  const options: { decision: ApprovalDecision; key: string; label: string }[] = [
    { decision: "allow-once", key: "y", label: "Yes" },
    ...(canAllowAlways
      ? [
          {
            decision: "allow-always" as const,
            key: "a",
            label: `Yes, and don't ask again for ${toolName} in this project`,
          },
        ]
      : []),
    { decision: "deny", key: "n", label: "No" },
  ];
  const answers = new Map<string, ApprovalDecision>(
    options.flatMap((o, i) => [
      [String(i + 1), o.decision],
      [o.key, o.decision],
    ])
  );

  const out = streams.output ?? stdout;
  out.write(
    `\n${palette.warn.bold("Allow this action?")} ${describeToolCall(toolName, input)} ` +
      palette.muted(`(${toolName})`) +
      options.map((o, i) => `\n  ${palette.accent(String(i + 1))} ${o.label}`).join("") +
      "\n"
  );

  const rl = createInterface({ input: streams.input ?? stdin, output: out });
  try {
    const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
    const answer = await Promise.race([rl.question(palette.accent("› ")), closed]);
    return answers.get(answer?.trim().toLowerCase() ?? "") ?? "deny";
  } catch {
    return "deny";
  } finally {
    rl.close();
  }
}
