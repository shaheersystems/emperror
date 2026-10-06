import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Where project settings live, relative to the workspace root. */
export const SETTINGS_PATH = ".emperror/settings.json";

/**
 * The user's answer to an approval request: run this call only, run it and
 * stop asking for this tool in this project, or refuse it.
 */
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

/** A tool call waiting for the user's approval. */
export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** How a UI asks the user to approve a tool call. */
export type RequestApproval = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/**
 * Which tools may run without asking. Nothing is allowed by default; a tool
 * becomes allowed when the user approves it for the whole project.
 */
export interface ToolPolicy {
  isAllowed(toolName: string): boolean;
  /** Allow `toolName` from now on, persisting the rule where the policy keeps it. */
  allowForProject(toolName: string): void;
}

/**
 * `.emperror/settings.json`. Unknown keys are kept, so the file can grow other
 * settings without this module rewriting them away.
 */
const settingsSchema = z.looseObject({
  permissions: z
    .looseObject({ allow: z.array(z.string()).default([]) })
    .default({ allow: [] }),
});

type Settings = z.infer<typeof settingsSchema>;

/** A policy that remembers approvals only in memory, e.g. for tests. */
export function createMemoryPolicy(allowed: Iterable<string> = []): ToolPolicy {
  const allow = new Set(allowed);
  return {
    isAllowed: (toolName) => allow.has(toolName),
    allowForProject: (toolName) => void allow.add(toolName),
  };
}

/**
 * A policy backed by the project's `.emperror/settings.json` under `root`.
 * Reads the file once; throws a readable error if it exists but is invalid.
 */
export function createProjectPolicy(root: string): ToolPolicy {
  const file = path.join(path.resolve(root), SETTINGS_PATH);
  const memory = createMemoryPolicy(readSettings(file).permissions.allow);

  return {
    isAllowed: memory.isAllowed,
    allowForProject(toolName) {
      memory.allowForProject(toolName);
      // Re-read so edits made to the file since startup are not overwritten.
      const settings = readSettings(file);
      if (settings.permissions.allow.includes(toolName)) return;
      settings.permissions.allow.push(toolName);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
    },
  };
}

function readSettings(file: string): Settings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return settingsSchema.parse({});
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${SETTINGS_PATH}: ${(err as Error).message}`);
  }
  const parsed = settingsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid ${SETTINGS_PATH}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
