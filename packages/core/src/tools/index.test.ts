import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspace } from "../workspace/workspace.ts";
import { createTools, describeToolCall } from "./index.ts";

test("tools delegate to the workspace they are bound to", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tools-test-"));
  try {
    const tools = createTools(createWorkspace(root));
    const outcome = await tools.create_file!.execute!(
      { path: "a.txt", content: "hi" },
      { toolCallId: "1", messages: [] }
    );
    expect(outcome).toMatchObject({ ok: true, path: "a.txt", summary: "Created a.txt" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("describeToolCall uses the tool's own status line", () => {
  expect(describeToolCall("edit_file", { path: "src/a.ts", old_str: "x" })).toBe(
    "Editing src/a.ts"
  );
  expect(describeToolCall("list_files", {})).toBe("Listing .");
});

test("bash's status line shows the exact command, with hidden characters escaped", () => {
  expect(describeToolCall("bash", { command: "bun test" })).toBe("Running bun test");
  expect(
    describeToolCall("bash", { command: "rm -rf ~\r\x1b[2Kecho hi‮" })
  ).toBe("Running rm -rf ~\\u{d}\\u{1b}[2Kecho hi\\u{202e}");
});

test("search tools' status lines show the pattern and any narrowed path", () => {
  expect(describeToolCall("grep", { pattern: "load\\(" })).toBe("Searching for load\\(");
  expect(describeToolCall("grep", { pattern: "x", path: "src" })).toBe("Searching for x in src");
  expect(describeToolCall("find_files", { pattern: "*.test.ts" })).toBe("Finding *.test.ts");
});

test("describeToolCall falls back for unknown tools and malformed input", () => {
  expect(describeToolCall("mystery", {})).toBe("Running mystery");
  expect(describeToolCall("read_file", { filename: "a" })).toBe("Running read_file");
});
