import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { createTools } from "../tools/index.ts";
import { createWorkspace } from "../workspace/workspace.ts";
import { CodingAgent, type AgentEvent } from "./agent.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agent-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function respond(
  parts: LanguageModelV3StreamPart[],
  unified: LanguageModelV3FinishReason["unified"]
): LanguageModelV3StreamResult {
  return {
    stream: simulateReadableStream<LanguageModelV3StreamPart>({
      chunks: [
        { type: "stream-start", warnings: [] },
        ...parts,
        {
          type: "finish",
          finishReason: { unified, raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    }),
  };
}

const say = (text: string) =>
  respond(
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
    ],
    "stop"
  );

const call = (toolName: string, input: object) =>
  respond(
    [{ type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) }],
    "tool-calls"
  );

/** A model that answers each successive call with the next scripted result. */
function scripted(...results: LanguageModelV3StreamResult[]) {
  let i = 0;
  return new MockLanguageModelV3({ doStream: async () => results[i++]! });
}

/** Send one message, collecting the events the agent emits. */
async function turn(agent: CodingAgent, input: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await agent.send(input, (e) => events.push(e));
  return events;
}

/** The user/assistant/tool messages (system prompt excluded) of the nth model call. */
const conversation = (model: MockLanguageModelV3, n: number) =>
  model.doStreamCalls[n]!.prompt.filter((m) => m.role !== "system");

function agentWith(model: MockLanguageModelV3) {
  return new CodingAgent({ model, tools: createTools(createWorkspace(root)) });
}

test("streams text and carries the exchange into the next turn", async () => {
  const model = scripted(say("hi there"), say("again"));
  const agent = agentWith(model);

  expect(await turn(agent, "hello")).toEqual([{ type: "text", text: "hi there" }]);
  await turn(agent, "and now?");

  expect(conversation(model, 1).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
});

test("runs tool calls against the workspace and continues the turn", async () => {
  const model = scripted(call("create_file", { path: "a.txt", content: "made" }), say("done"));

  const events = await turn(agentWith(model), "make a file");

  expect(events.map((e) => e.type)).toEqual(["tool-call", "tool-result", "text"]);
  expect(events[1]).toMatchObject({
    type: "tool-result",
    toolName: "create_file",
    output: { ok: true, path: "a.txt" },
  });
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("made");
});

test("a failed turn leaves the history untouched", async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      if (calls++ === 0) throw new Error("network down");
      return say("recovered");
    },
  });
  const agent = agentWith(model);

  const failed = await turn(agent, "first");
  expect(failed).toEqual([{ type: "error", error: new Error("network down") }]);

  await turn(agent, "second");
  const history = conversation(model, 1);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "second" }] });
});
