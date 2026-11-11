import {
  describeToolCall,
  describeToolResult,
  type AgentEvent,
  type ApprovalRequest,
} from "@emperror/core";

/** One row of the conversation as the TUI shows it. */
export type Entry =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "tool"; toolCallId: string; status: "running" | "ok" | "failed"; text: string }
  | { id: number; kind: "error"; text: string };

/**
 * Where the TUI is in a turn. Exactly one holds at a time:
 *
 *   idle ──submit──▶ working ──approval-requested──▶ awaiting-approval
 *    ▲                 │  ▲                              │
 *    └────turn-end─────┘  └──────approval-decided────────┘
 *
 * `turn-end` also returns to idle from awaiting-approval (the turn failed
 * while asking). Actions that don't fit the current phase are ignored.
 */
export type TurnPhase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "awaiting-approval"; request: ApprovalRequest };

/**
 * The conversation split by mutability: `done` rows never change again (so
 * they can be printed once and scroll away), `live` rows are still streaming
 * or running and are redrawn on every update.
 */
export interface Transcript {
  done: Entry[];
  live: Entry[];
  phase: TurnPhase;
  nextId: number;
}

export type TranscriptAction =
  | { type: "submit"; text: string }
  | { type: "agent"; event: AgentEvent }
  | { type: "approval-requested"; request: ApprovalRequest }
  | { type: "approval-decided" }
  | { type: "turn-end" };

const IDLE: TurnPhase = { kind: "idle" };
const WORKING: TurnPhase = { kind: "working" };

export const emptyTranscript: Transcript = { done: [], live: [], phase: IDLE, nextId: 0 };

/** Whether a turn is running, i.e. a new message can't be sent yet. */
export const isBusy = (t: Transcript) => t.phase.kind !== "idle";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function transcriptReducer(state: Transcript, action: TranscriptAction): Transcript {
  switch (action.type) {
    case "submit":
      if (state.phase.kind !== "idle") return state;
      return { ...push(settle(state), { kind: "user", text: action.text }, "done"), phase: WORKING };

    case "approval-requested":
      if (state.phase.kind !== "working") return state;
      return { ...state, phase: { kind: "awaiting-approval", request: action.request } };

    case "approval-decided":
      if (state.phase.kind !== "awaiting-approval") return state;
      return { ...state, phase: WORKING };

    case "turn-end":
      return { ...settle(state), phase: IDLE };

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
