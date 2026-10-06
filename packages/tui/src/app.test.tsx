import { expect, test } from "bun:test";
import type { AgentEvent } from "@emperror/core";
import { render } from "ink-testing-library";
import { App, type TurnRunner } from "./app.tsx";

const ENTER = "\r";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const BACKSPACE = "\x7f";
const CTRL_C = "\x03";
const CTRL_U = "\x15";
const CTRL_W = "\x17";
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

/** Let React and Ink process pending input and re-render. */
const tick = () => new Promise((r) => setTimeout(r, 30));

/** A fake agent: records inputs and replays scripted events for each turn. */
function fakeAgent(script: (input: string) => AgentEvent[] = () => []) {
  const inputs: string[] = [];
  const agent: TurnRunner = {
    async send(input, onEvent) {
      inputs.push(input);
      for (const event of script(input)) onEvent(event);
    },
  };
  return { agent, inputs };
}

async function setup(agent: TurnRunner) {
  const app = render(<App agent={agent} modelName="test-model" root="/repo" />);
  await tick();
  const type = async (...chunks: string[]) => {
    for (const chunk of chunks) {
      app.stdin.write(chunk);
      await tick();
    }
  };
  return { ...app, type };
}

test("shows the header and a placeholder prompt", async () => {
  const { lastFrame } = await setup(fakeAgent().agent);
  expect(lastFrame()).toContain("emperror");
  expect(lastFrame()).toContain("test-model");
  expect(lastFrame()).toContain("Ask for a change");
});

test("a submitted turn renders user text, tool rows and the reply", async () => {
  const { agent, inputs } = fakeAgent(() => [
    { type: "tool-call", toolCallId: "1", toolName: "read_file", input: { path: "a.ts" } },
    {
      type: "tool-result",
      toolCallId: "1",
      toolName: "read_file",
      output: { ok: true, path: "a.ts", summary: "Read a.ts" },
    },
    { type: "text", text: "It exports main." },
  ]);
  const app = await setup(agent);

  await app.type("what is in a.ts", ENTER);

  expect(inputs).toEqual(["what is in a.ts"]);
  const out = app.frames.join("\n");
  expect(out).toContain("what is in a.ts");
  expect(out).toContain("✓ Read a.ts");
  expect(out).toContain("It exports main.");
});

test("line editing: arrows, backspace, Ctrl+W, Ctrl+U", async () => {
  const { agent, inputs } = fakeAgent();
  const app = await setup(agent);

  await app.type("helo", LEFT, "l", ENTER);
  await app.type("one two", CTRL_W, "three", ENTER);
  await app.type("junk", CTRL_U, "abcx", BACKSPACE, ENTER);

  expect(inputs).toEqual(["hello", "one three", "abc"]);
});

test("pasted newlines are kept, and \\+Enter continues the line", async () => {
  const { agent, inputs } = fakeAgent();
  const app = await setup(agent);

  await app.type(paste("line1\r\nline2"), ENTER);
  await app.type("first\\", ENTER, "second", ENTER);

  expect(inputs).toEqual(["line1\nline2", "first\nsecond"]);
});

test("Up recalls the previous message", async () => {
  const { agent, inputs } = fakeAgent();
  const app = await setup(agent);

  await app.type("again", ENTER, UP, ENTER);

  expect(inputs).toEqual(["again", "again"]);
});

test("Ctrl+C clears a non-empty prompt instead of exiting", async () => {
  const { agent, inputs } = fakeAgent();
  const app = await setup(agent);

  await app.type("draft", CTRL_C, "sent", ENTER);

  expect(inputs).toEqual(["sent"]);
});

test("a thrown error is shown and the prompt accepts input again", async () => {
  let calls = 0;
  const agent: TurnRunner = {
    async send() {
      if (calls++ === 0) throw new Error("boom");
    },
  };
  const app = await setup(agent);

  await app.type("first", ENTER);
  expect(app.frames.join("\n")).toContain("✖ boom");

  await app.type("second", ENTER);
  expect(calls).toBe(2);
});

test("a tool call waits for approval, and the chosen option is returned", async () => {
  const DOWN = "\x1b[B";
  const decisions: string[] = [];
  const agent: TurnRunner = {
    async send(_input, _onEvent, requestApproval) {
      decisions.push(
        await requestApproval({
          toolCallId: "1",
          toolName: "read_file",
          input: { path: "a.ts" },
          canAllowAlways: true,
        })
      );
    },
  };
  const app = await setup(agent);

  await app.type("fix a.ts", ENTER);
  expect(app.lastFrame()).toContain("Allow this action?");
  expect(app.lastFrame()).toContain("Reading a.ts");
  expect(app.lastFrame()).toContain("don't ask again for read_file in this project");

  // Typing goes to the approval prompt, not the message box.
  await app.type("x", DOWN, ENTER);
  expect(decisions).toEqual(["allow-always"]);
  expect(app.lastFrame()).not.toContain("Allow this action?");
  expect(app.lastFrame()).not.toContain("› x");
});

test("a tool that always asks offers no project-wide option", async () => {
  const decisions: string[] = [];
  const agent: TurnRunner = {
    async send(_input, _onEvent, requestApproval) {
      decisions.push(
        await requestApproval({
          toolCallId: "1",
          toolName: "bash",
          input: { command: "bun test" },
          canAllowAlways: false,
        })
      );
    },
  };
  const app = await setup(agent);

  await app.type("run the tests", ENTER);
  expect(app.lastFrame()).toContain("Running bun test");
  expect(app.lastFrame()).not.toContain("don't ask again");

  await app.type("2");
  expect(decisions).toEqual(["deny"]);
});
