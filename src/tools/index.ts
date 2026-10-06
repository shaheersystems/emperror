import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Outcome, Workspace } from "../workspace/workspace.ts";

/**
 * A model-facing tool over the workspace: what the model sees (description,
 * input schema), what runs, and the status line shown while it runs. Results
 * are always a workspace `Outcome`, so they render without per-tool code.
 */
interface WorkspaceTool<S extends z.ZodType> {
  description: string;
  inputSchema: S;
  /** Present-tense status, e.g. "Editing src/app.ts". */
  describeCall(input: z.infer<S>): string;
  run(workspace: Workspace, input: z.infer<S>): Promise<Outcome<object>>;
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
    run: (ws, { path }) => ws.readFile(path),
  }),

  list_files: defineTool({
    description: "List the files and directories in a directory.",
    inputSchema: z.object({
      path: pathArg("Directory").default(".").describe(
        "Directory path, relative to the repo root. Defaults to the root."
      ),
    }),
    describeCall: ({ path }) => `Listing ${path}`,
    run: (ws, { path }) => ws.listDirectory(path),
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
    run: (ws, { path, content }) => ws.createFile(path, content),
  }),

  create_directory: defineTool({
    description:
      "Create a directory, including missing parents. Succeeds without " +
      "changes if it already exists. Use create_file to create files.",
    inputSchema: z.object({ path: pathArg("Directory") }),
    describeCall: ({ path }) => `Creating directory ${path}`,
    run: (ws, { path }) => ws.createDirectory(path),
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
    run: (ws, { path, old_str, new_str }) => ws.editFile(path, old_str, new_str),
  }),
};

type ToolName = keyof typeof definitions;

/** The AI SDK tool set exposed to the model, bound to one workspace. */
export function createTools(workspace: Workspace): ToolSet {
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
        execute: (input) => def.run(workspace, input),
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
