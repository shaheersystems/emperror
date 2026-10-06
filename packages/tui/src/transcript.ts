import { describeToolCall, describeToolResult, type AgentEvent } from "@emperror/core";

/** One row of the conversation as the TUI shows it. */
export type Entry =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "tool"; toolCallId: string; status: "running" | "ok" | "failed"; text: string }
  | { id: number; kind: "error"; text: string };

/**
 * The conversation split by mutability: `done` rows never change again (so
 * they can be printed once and scroll away), `live` rows are still streaming
 * or running and are redrawn on every update.
 */
export interface Transcript {
  done: Entry[];
  live: Entry[];
  busy: boolean;
  nextId: number;
}

export type TranscriptAction =
  | { type: "submit"; text: string }
  | { type: "agent"; event: AgentEvent }
  | { type: "turn-end" };

export const emptyTranscript: Transcript = { done: [], live: [], busy: false, nextId: 0 };

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function transcriptReducer(state: Transcript, action: TranscriptAction): Transcript {
  switch (action.type) {
    case "submit":
      return { ...push(settle(state), { kind: "user", text: action.text }, "done"), busy: true };

    case "turn-end":
      return { ...settle(state), busy: false };

    case "agent":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: Transcript, event: AgentEvent): Transcript {
  switch (event.type) {
    case "text": {
      if (!event.text) return state;
      const last = state.live.at(-1);
      if (last?.kind === "assistant") {
        const live = [...state.live.slice(0, -1), { ...last, text: last.text + event.text }];
        return { ...state, live };
      }
      return push(state, { kind: "assistant", text: event.text }, "live");
    }

    case "tool-call": {
      // Prose before a tool call is finished; the tool row follows it.
      const settled = settleAssistant(state);
      return push(
        settled,
        {
          kind: "tool",
          toolCallId: event.toolCallId,
          status: "running",
          text: describeToolCall(event.toolName, event.input),
        },
        "live"
      );
    }

    case "tool-result": {
      const { ok, text } = describeToolResult(event.toolName, event.output);
      return finishTool(state, event.toolCallId, ok ? "ok" : "failed", text);
    }

    case "tool-error":
      return finishTool(
        state,
        event.toolCallId,
        "failed",
        `${event.toolName} failed: ${errorText(event.error)}`
      );

    case "error":
      return push(settle(state), { kind: "error", text: errorText(event.error) }, "done");
  }
}

type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, "id"> : never) : never;

function push(state: Transcript, entry: NewEntry, where: "done" | "live"): Transcript {
  const row = { ...entry, id: state.nextId } as Entry;
  return {
    ...state,
    [where]: [...state[where], row],
    nextId: state.nextId + 1,
  };
}

/** Move the tool row out of `live` with its final status, keeping order. */
function finishTool(
  state: Transcript,
  toolCallId: string,
  status: "ok" | "failed",
  text: string
): Transcript {
  const row = state.live.find((e) => e.kind === "tool" && e.toolCallId === toolCallId);
  if (!row) return push(state, { kind: "tool", toolCallId, status, text }, "done");
  return {
    ...state,
    done: [...state.done, { ...row, status, text } as Entry],
    live: state.live.filter((e) => e !== row),
  };
}

/** Finish streamed assistant text so it is printed before what follows. */
function settleAssistant(state: Transcript): Transcript {
  const assistant = state.live.filter((e) => e.kind === "assistant");
  if (assistant.length === 0) return state;
  return {
    ...state,
    done: [...state.done, ...assistant],
    live: state.live.filter((e) => e.kind !== "assistant"),
  };
}

/** Finish everything still live; tools that never reported are marked failed. */
function settle(state: Transcript): Transcript {
  const finished = state.live.map((e): Entry =>
    e.kind === "tool" && e.status === "running"
      ? { ...e, status: "failed", text: `${e.text} (no result)` }
      : e
  );
  return { ...state, done: [...state.done, ...finished], live: [] };
}
