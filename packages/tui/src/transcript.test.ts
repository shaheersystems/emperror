import { expect, test } from "bun:test";
import type { AgentEvent } from "@emperror/core";
import { emptyTranscript, transcriptReducer, type Transcript } from "./transcript.ts";

const agent = (event: AgentEvent) => ({ type: "agent" as const, event });

function run(...actions: Parameters<typeof transcriptReducer>[1][]): Transcript {
  return actions.reduce(transcriptReducer, emptyTranscript);
}

const view = (entries: Transcript["done"]) =>
  entries.map((e) => (e.kind === "tool" ? `${e.kind}:${e.status}:${e.text}` : `${e.kind}:${e.text}`));

test("streamed text accumulates in one live assistant row", () => {
  const t = run(
    { type: "submit", text: "hi" },
    agent({ type: "text", text: "Hel" }),
    agent({ type: "text", text: "lo" })
  );
  expect(t.busy).toBe(true);
  expect(view(t.done)).toEqual(["user:hi"]);
  expect(view(t.live)).toEqual(["assistant:Hello"]);
});

test("a tool call settles prior text, then its result finishes the row", () => {
  const t = run(
    { type: "submit", text: "edit it" },
    agent({ type: "text", text: "Looking." }),
    agent({ type: "tool-call", toolCallId: "1", toolName: "read_file", input: { path: "a.ts" } })
  );
  expect(view(t.done)).toEqual(["user:edit it", "assistant:Looking."]);
  expect(view(t.live)).toEqual(["tool:running:Reading a.ts"]);

  const after = transcriptReducer(
    t,
    agent({
      type: "tool-result",
      toolCallId: "1",
      toolName: "read_file",
      output: { ok: true, path: "a.ts", summary: "Read a.ts" },
    })
  );
  expect(view(after.done).at(-1)).toBe("tool:ok:Read a.ts");
  expect(after.live).toEqual([]);
});

test("parallel tool calls finish against the matching row", () => {
  const t = run(
    { type: "submit", text: "go" },
    agent({ type: "tool-call", toolCallId: "a", toolName: "read_file", input: { path: "a" } }),
    agent({ type: "tool-call", toolCallId: "b", toolName: "read_file", input: { path: "b" } }),
    agent({
      type: "tool-result",
      toolCallId: "b",
      toolName: "read_file",
      output: { ok: false, path: "b", code: "not_found", message: "Couldn't find b" },
    })
  );
  expect(view(t.done).at(-1)).toBe("tool:failed:Couldn't find b");
  expect(view(t.live)).toEqual(["tool:running:Reading a"]);
});

test("turn end settles live rows and marks unfinished tools failed", () => {
  const t = run(
    { type: "submit", text: "go" },
    agent({ type: "tool-call", toolCallId: "a", toolName: "list_files", input: {} }),
    { type: "turn-end" }
  );
  expect(t.busy).toBe(false);
  expect(t.live).toEqual([]);
  expect(view(t.done).at(-1)).toBe("tool:failed:Listing . (no result)");
});

test("errors land after whatever was live", () => {
  const t = run(
    { type: "submit", text: "go" },
    agent({ type: "text", text: "partial" }),
    agent({ type: "error", error: new Error("quota exceeded") })
  );
  expect(view(t.done)).toEqual(["user:go", "assistant:partial", "error:quota exceeded"]);
});

test("row ids stay unique", () => {
  const t = run(
    { type: "submit", text: "a" },
    agent({ type: "text", text: "b" }),
    { type: "turn-end" },
    { type: "submit", text: "c" }
  );
  const ids = t.done.map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
});
