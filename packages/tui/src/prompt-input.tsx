import { Box, Text, useInput, usePaste, type Key } from "ink";
import { useReducer } from "react";
import { colors } from "./theme.ts";

export interface PromptInputProps {
  /** Called with the entered text on Enter, unless `canSubmit` is false. */
  onSubmit(text: string): void;
  /** Ctrl+C on an empty prompt, or Ctrl+D on an empty prompt. */
  onExit(): void;
  /** Earlier submissions, oldest first, recalled with Up/Down. */
  history?: string[];
  /** While false, typing still works but Enter does nothing. */
  canSubmit?: boolean;
  placeholder?: string;
}

/**
 * Bordered prompt with readline-style editing: arrows, Home/End, Ctrl+A/E/U/K/W,
 * history on Up/Down, and pastes that keep their newlines. A trailing "\"
 * before Enter inserts a newline instead of submitting.
 */
export function PromptInput({
  onSubmit,
  onExit,
  history = [],
  canSubmit = true,
  placeholder = "Ask for a change, or a question about the code",
}: PromptInputProps) {
  const [state, dispatch] = useReducer(editorReducer, initialEditor);

  usePaste((text) => dispatch({ type: "insert", text: text.replace(/\r\n?/g, "\n") }));

  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "d")) {
      if (state.text.length === 0) onExit();
      else if (input === "c") dispatch({ type: "set", text: "" });
      return;
    }
    if (key.return) {
      if (state.text.slice(0, state.cursor).endsWith("\\")) {
        dispatch({ type: "continue-line" });
      } else if (canSubmit && state.text.trim()) {
        onSubmit(state.text);
        dispatch({ type: "set", text: "" });
      }
      return;
    }
    if (key.upArrow || key.downArrow) {
      dispatch({ type: "history", history, direction: key.upArrow ? -1 : 1 });
      return;
    }
    const edit = editForKey(input, key);
    if (edit) dispatch(edit);
  });

  return (
    <Box
      borderStyle="round"
      borderColor={canSubmit ? colors.accent : colors.border}
      paddingX={1}
    >
      <Text color={colors.accent}>› </Text>
      <Box flexGrow={1}>
        {state.text.length === 0 ? (
          <Text>
            <Text inverse>{placeholder[0] ?? " "}</Text>
            <Text dimColor>{placeholder.slice(1)}</Text>
          </Text>
        ) : (
          <Text>
            {state.text.slice(0, state.cursor)}
            <Text inverse>{cursorChar(state.text[state.cursor])}</Text>
            {state.text[state.cursor] === "\n" ? "\n" : ""}
            {state.text.slice(state.cursor + 1)}
          </Text>
        )}
      </Box>
    </Box>
  );
}

/** The character under the caret; a newline or the end shows as a space. */
const cursorChar = (ch: string | undefined) => (ch === undefined || ch === "\n" ? " " : ch);

interface EditorState {
  text: string;
  cursor: number;
  /** Index into history while browsing it, with the unsent draft kept aside. */
  browsing: { index: number; draft: string } | null;
}

type EditorAction =
  | { type: "insert"; text: string }
  | { type: "set"; text: string }
  | { type: "continue-line" }
  | { type: "backspace" | "delete" | "delete-word" | "kill-start" | "kill-end" }
  | { type: "move"; to: "left" | "right" | "start" | "end" }
  | { type: "history"; history: string[]; direction: -1 | 1 };

const initialEditor: EditorState = { text: "", cursor: 0, browsing: null };

function editForKey(input: string, key: Key): EditorAction | null {
  if (key.leftArrow) return { type: "move", to: "left" };
  if (key.rightArrow) return { type: "move", to: "right" };
  if (key.home) return { type: "move", to: "start" };
  if (key.end) return { type: "move", to: "end" };
  if (key.backspace) return { type: "backspace" };
  if (key.delete) return { type: "delete" };
  if (key.ctrl) {
    switch (input) {
      case "a": return { type: "move", to: "start" };
      case "e": return { type: "move", to: "end" };
      case "u": return { type: "kill-start" };
      case "k": return { type: "kill-end" };
      case "w": return { type: "delete-word" };
      default: return null;
    }
  }
  if (key.meta || key.escape || key.tab || !input) return null;
  return { type: "insert", text: input };
}

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const { text, cursor } = state;
  const at = (next: string, nextCursor: number): EditorState => ({
    text: next,
    cursor: nextCursor,
    browsing: null,
  });

  switch (action.type) {
    case "insert":
      return at(text.slice(0, cursor) + action.text + text.slice(cursor), cursor + action.text.length);
    case "set":
      return at(action.text, action.text.length);
    case "continue-line":
      // Replace the trailing "\" with a newline.
      return at(text.slice(0, cursor - 1) + "\n" + text.slice(cursor), cursor);
    case "backspace":
      return cursor === 0 ? state : at(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1);
    case "delete":
      return at(text.slice(0, cursor) + text.slice(cursor + 1), cursor);
    case "delete-word": {
      const start = text.slice(0, cursor).replace(/\S+\s*$|\s+$/, "").length;
      return at(text.slice(0, start) + text.slice(cursor), start);
    }
    case "kill-start":
      return at(text.slice(cursor), 0);
    case "kill-end":
      return at(text.slice(0, cursor), cursor);
    case "move": {
      const to = {
        left: Math.max(0, cursor - 1),
        right: Math.min(text.length, cursor + 1),
        start: 0,
        end: text.length,
      }[action.to];
      return { ...state, cursor: to };
    }
    case "history": {
      const { history, direction } = action;
      if (history.length === 0) return state;
      const draft = state.browsing?.draft ?? text;
      const from = state.browsing?.index ?? history.length;
      const index = Math.min(history.length, Math.max(0, from + direction));
      const next = index === history.length ? draft : history[index]!;
      return {
        text: next,
        cursor: next.length,
        browsing: index === history.length ? null : { index, draft },
      };
    }
  }
}
