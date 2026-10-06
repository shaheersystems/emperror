import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createShell, MAX_TIMEOUT_MS, type Shell } from "../shell/shell.ts";
import type { Outcome, Workspace } from "../workspace/workspace.ts";

/** What tools act on. */
interface ToolContext {
  workspace: Workspace;
  shell: Shell;
}

/**
 * A model-facing tool over the workspace or shell: what the model sees (description,
 * input schema), what runs, and the status line shown while it runs. Results
 * are always a workspace `Outcome`, so they render without per-tool code.
 */
interface WorkspaceTool<S extends z.ZodType> {
  description: string;
  inputSchema: S;
  /** Present-tense status, e.g. "Editing src/app.ts". */
  describeCall(input: z.infer<S>): string;
  run(context: ToolContext, input: z.infer<S>): Promise<Outcome<object>>;
}

const defineTool = <S extends z.ZodType>(def: WorkspaceTool<S>) => def;

const pathArg = (what: string) =>
  z.string().describe(`${what} path, relative to the repo root.`);

/** Keys are the tool names the model sees; add a tool by adding an entry. */
const definitions = {
  read_file: defineTool({
    description: "Read the full contents of a file.",
    inputSchema: z.object({ path: pathArg("File") }),
    describeCall: ({ path }) => `Reading ${path}`,
    run: ({ workspace }, { path }) => workspace.readFile(path),
  }),

  list_files: defineTool({
    description: "List the files and directories in a directory.",
    inputSchema: z.object({
      path: pathArg("Directory").default(".").describe(
        "Directory path, relative to the repo root. Defaults to the root."
      ),
    }),
    describeCall: ({ path }) => `Listing ${path}`,
    run: ({ workspace }, { path }) => workspace.listDirectory(path),
  }),

  create_file: defineTool({
    description:
      "Create a new file with the given content, creating parent directories " +
      "as needed. Fails if the file already exists; use edit_file to change it.",
    inputSchema: z.object({
      path: pathArg("File"),
      content: z.string().default("").describe("Content of the new file."),
    }),
    describeCall: ({ path }) => `Creating ${path}`,
    run: ({ workspace }, { path, content }) => workspace.createFile(path, content),
  }),

  create_directory: defineTool({
    description:
      "Create a directory, including missing parents. Succeeds without " +
      "changes if it already exists. Use create_file to create files.",
    inputSchema: z.object({ path: pathArg("Directory") }),
    describeCall: ({ path }) => `Creating directory ${path}`,
    run: ({ workspace }, { path }) => workspace.createDirectory(path),
  }),

  edit_file: defineTool({
    description:
      "Replace old_str with new_str in an existing file. old_str must match " +
      "exactly once; the edit is refused if it matches zero or several times.",
    inputSchema: z.object({
      path: pathArg("File"),
      old_str: z
        .string()
        .min(1)
        .describe("Existing text to replace. Must match exactly and be unique."),
      new_str: z.string().default("").describe("Replacement text."),
    }),
    describeCall: ({ path }) => `Editing ${path}`,
    run: ({ workspace }, { path, old_str, new_str }) =>
      workspace.editFile(path, old_str, new_str),
  }),

  bash: defineTool({
    description:
      "Run a bash command in the repository root and return its exit code and " +
      "combined stdout/stderr. The user approves every command before it runs. " +
      "Commands are non-interactive (stdin is closed) and are stopped after " +
      "timeout_ms. Use the file tools to read, list, create, and edit files.",
    inputSchema: z.object({
      command: z.string().min(1).describe("The bash command to run."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`Timeout in milliseconds. Defaults to 120000, at most ${MAX_TIMEOUT_MS}.`),
    }),
    describeCall: ({ command }) => `Running ${showCommand(command)}`,
    run: ({ shell }, { command, timeout_ms }) => shell.run(command, { timeoutMs: timeout_ms }),
  }),
};

/**
 * A command as the user should see it before approving. Control and bidi
 * characters are escaped, so a carriage return, ANSI escape, or right-to-left
 * override can't make the command look different from what will run.
 */
export function showCommand(command: string): string {
  return command.replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g,
    (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`
  );
}

type ToolName = keyof typeof definitions;

/**
 * The AI SDK tool set exposed to the model, bound to one workspace and a shell
 * rooted at it.
 */
export function createTools(
  workspace: Workspace,
  shell: Shell = createShell(workspace.root)
): ToolSet {
  const entries = Object.entries(definitions) as [
    ToolName,
    WorkspaceTool<z.ZodType>,
  ][];
  return Object.fromEntries(
    entries.map(([name, def]) => [
      name,
      tool({
        description: def.description,
        inputSchema: def.inputSchema,
        execute: (input) => def.run({ workspace, shell }, input),
      }),
    ])
  );
}

/** Status line for a tool call, falling back to the bare name for bad input. */
export function describeToolCall(toolName: string, input: unknown): string {
  const def = definitions[toolName as ToolName] as
    | WorkspaceTool<z.ZodType>
    | undefined;
  const parsed = def?.inputSchema.safeParse(input);
  return def && parsed?.success
    ? def.describeCall(parsed.data)
    : `Running ${toolName}`;
}

/** Past-tense line for a finished tool call, e.g. "Edited src/app.ts". */
export interface ToolResultSummary {
  ok: boolean;
  text: string;
}

/**
 * Summarize a tool result. Workspace tools return an `Outcome` carrying its own
 * summary or failure message; anything else renders as a bare success.
 */
export function describeToolResult(toolName: string, output: unknown): ToolResultSummary {
  const out = (output ?? {}) as Record<string, unknown>;
  if (out.ok === true && typeof out.summary === "string") {
    return { ok: true, text: out.summary };
  }
  if (out.ok === false && typeof out.message === "string") {
    return { ok: false, text: out.message };
  }
  return { ok: true, text: `Ran ${toolName}` };
}
