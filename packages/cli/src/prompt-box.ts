import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { palette } from "./theme.ts";

export interface PromptOptions {
  placeholder?: string;
  /** Defaults to the process's stdin. Raw-mode editing needs a TTY. */
  input?: NodeJS.ReadStream;
  /** Defaults to the process's stdout. `columns` sets the box width. */
  output?: NodeJS.WriteStream;
}

/**
 * A bordered, single-line input field in the style of modern AI coding CLIs
 * (Claude Code, Gemini CLI). It renders a rounded box whose right edge stays
 * aligned while you type, supports basic line editing, and horizontally scrolls
 * for input longer than the box. Pasted text keeps its newlines (shown as ⏎)
 * instead of submitting early.
 *
 * Returns the entered text, or `null` when the user asks to quit (Ctrl+C, or
 * Ctrl+D / EOF on an empty line).
 */
export async function readPrompt({
  placeholder = "Type a message…",
  input = stdin,
  output = stdout,
}: PromptOptions = {}): Promise<string | null> {
  // Without a TTY (piped input, tests) we can't do raw-mode editing, so fall
  // back to a plain readline prompt that still works end-to-end.
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return readPromptFallback(input, output);
  }
  return new Promise<string | null>((resolve) => {
    new BoxEditor(input, output, placeholder, resolve).run();
  });
}

const ESC = "\x1b[";
const up = (n: number) => `${ESC}${n}A`;
const down = (n: number) => `${ESC}${n}B`;
const toCol = (n: number) => `${ESC}${n}G`; // 1-based column
const BRACKETED_PASTE_ON = `${ESC}?2004h`;
const BRACKETED_PASTE_OFF = `${ESC}?2004l`;
const PASTE_END = `${ESC}201~`;

type Key =
  | { kind: "text"; text: string }
  | { kind: "enter" | "backspace" | "delete" | "left" | "right" | "home" | "end" }
  | { kind: "interrupt" | "eof" };

/**
 * Turns raw terminal input into keys. Escape sequences and paste markers can
 * be split across `data` chunks, so an incomplete tail is held until the next
 * chunk completes it.
 */
class KeyDecoder {
  private pending = "";
  private pasting = false;

  decode(chunk: string): Key[] {
    const s = this.pending + chunk;
    this.pending = "";
    const keys: Key[] = [];
    let i = 0;

    while (i < s.length) {
      if (this.pasting) {
        const end = s.indexOf(PASTE_END, i);
        if (end === -1) {
          // Hold back a partial end marker; everything before it is pasted text.
          const hold = partialSuffixLength(s, PASTE_END);
          pushText(keys, normalizePaste(s.slice(i, s.length - hold)));
          this.pending = s.slice(s.length - hold);
          break;
        }
        pushText(keys, normalizePaste(s.slice(i, end)));
        this.pasting = false;
        i = end + PASTE_END.length;
        continue;
      }

      const ch = s[i]!;
      if (ch === "\x1b") {
        const seq = parseEscape(s, i);
        if (seq === null) {
          this.pending = s.slice(i); // incomplete; wait for the rest
          break;
        }
        if (seq.key === "paste-start") this.pasting = true;
        else if (seq.key) keys.push({ kind: seq.key });
        i += seq.length;
        continue;
      }

      if (ch === "\x03") keys.push({ kind: "interrupt" });
      else if (ch === "\x04") keys.push({ kind: "eof" });
      else if (ch === "\r" || ch === "\n") {
        keys.push({ kind: "enter" });
        if (ch === "\r" && s[i + 1] === "\n") i++;
      } else if (ch === "\x7f" || ch === "\b") keys.push({ kind: "backspace" });
      else if (ch >= " ") pushText(keys, ch);
      // Other control characters are ignored.
      i++;
    }
    return keys;
  }
}

type EscapeKey = "left" | "right" | "home" | "end" | "delete" | "paste-start";

/**
 * Parse the escape sequence starting at `s[i]`. Returns `null` when the input
 * ends mid-sequence, and `key: undefined` for sequences we deliberately ignore
 * (they are still consumed whole, so none of their bytes leak into the text).
 */
function parseEscape(
  s: string,
  i: number
): { length: number; key?: EscapeKey } | null {
  const intro = s[i + 1];
  if (intro === undefined) return null;

  if (intro === "[") {
    // CSI: parameter/intermediate bytes, then one final byte in @–~.
    let j = i + 2;
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x3f) j++;
    if (j >= s.length) return null;
    const params = s.slice(i + 2, j);
    const length = j - i + 1;
    switch (s[j]) {
      case "D": return { length, key: "left" };
      case "C": return { length, key: "right" };
      case "H": return { length, key: "home" };
      case "F": return { length, key: "end" };
      case "~":
        if (params === "3") return { length, key: "delete" };
        if (params === "1" || params === "7") return { length, key: "home" };
        if (params === "4" || params === "8") return { length, key: "end" };
        if (params === "200") return { length, key: "paste-start" };
        return { length };
      default:
        return { length };
    }
  }

  if (intro === "O") {
    // SS3: application-mode cursor keys, e.g. "\x1bOH" for Home.
    const final = s[i + 2];
    if (final === undefined) return null;
    const key = ({ D: "left", C: "right", H: "home", F: "end" } as const)[
      final as "D" | "C" | "H" | "F"
    ];
    return { length: 3, key };
  }

  // A lone Escape (or Alt+key): drop the Escape itself.
  return { length: 1 };
}

function pushText(keys: Key[], text: string): void {
  if (!text) return;
  const last = keys[keys.length - 1];
  if (last?.kind === "text") last.text += text;
  else keys.push({ kind: "text", text });
}

/** Pasted line endings become "\n"; other control characters are dropped. */
function normalizePaste(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Length of the longest suffix of `s` that is a proper prefix of `marker`. */
function partialSuffixLength(s: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, s.length); n > 0; n--) {
    if (marker.startsWith(s.slice(-n))) return n;
  }
  return 0;
}

/** One display column per character, so cursor math stays index-based. */
const displayChar = (ch: string) => (ch === "\n" ? "⏎" : ch === "\t" ? " " : ch);

class BoxEditor {
  private readonly decoder = new KeyDecoder();
  private text = "";
  private cursor = 0; // caret index within `text`
  private scroll = 0; // first visible column of the body
  private rendered = false;

  constructor(
    private readonly input: NodeJS.ReadStream,
    private readonly output: NodeJS.WriteStream,
    private readonly placeholder: string,
    private readonly done: (value: string | null) => void
  ) {}

  run(): void {
    this.output.write("\n" + BRACKETED_PASTE_ON);
    this.input.setRawMode(true);
    this.input.resume();
    this.input.setEncoding("utf8");
    this.input.on("data", this.onData);
    this.render();
  }

  private finish(value: string | null): void {
    this.input.off("data", this.onData);
    this.input.setRawMode(false);
    this.input.pause();
    // Step below the box so the next output starts on a fresh line.
    this.output.write(`${BRACKETED_PASTE_OFF}\r${down(1)}\n`);
    this.done(value);
  }

  private onData = (chunk: string): void => {
    let dirty = false;
    for (const key of this.decoder.decode(chunk)) {
      switch (key.kind) {
        case "interrupt":
          return this.finish(null);
        case "enter":
          return this.finish(this.text);
        case "eof":
          // Quit only on an empty line, mirroring shell behaviour.
          if (this.text.length === 0) return this.finish(null);
          continue;
        case "text":
          this.text =
            this.text.slice(0, this.cursor) + key.text + this.text.slice(this.cursor);
          this.cursor += key.text.length;
          break;
        case "backspace":
          if (this.cursor === 0) continue;
          this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
          this.cursor--;
          break;
        case "delete":
          this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
          break;
        case "left":
          this.cursor = Math.max(0, this.cursor - 1);
          break;
        case "right":
          this.cursor = Math.min(this.text.length, this.cursor + 1);
          break;
        case "home":
          this.cursor = 0;
          break;
        case "end":
          this.cursor = this.text.length;
          break;
      }
      dirty = true;
    }
    if (dirty) this.render();
  };

  /** Visible width of the box: the full terminal width, minus a trailing
   * column so the right border never wraps. */
  private boxWidth(): number {
    return Math.max(24, (this.output.columns ?? 80) - 1);
  }

  private render(): void {
    const W = this.boxWidth();
    const inner = W - 4; // body width between "│ " and " │"
    const marker = "› ";
    const empty = this.text.length === 0;
    const shown = Array.from(this.text, displayChar).join("");
    const body = empty ? marker + this.placeholder : marker + shown;
    const caretInBody = marker.length + this.cursor;

    // Keep the caret inside the visible window, scrolling horizontally if needed.
    if (caretInBody < this.scroll) this.scroll = caretInBody;
    else if (caretInBody > this.scroll + inner - 1) this.scroll = caretInBody - inner + 1;
    if (empty) this.scroll = 0;

    const window = body.slice(this.scroll, this.scroll + inner).padEnd(inner, " ");
    const caretCol = 2 + (caretInBody - this.scroll); // 0-based terminal column

    // Colorize: accent marker when it sits at the window start, dim placeholder.
    let painted: string;
    if (empty) {
      painted = palette.accent(window.slice(0, marker.length)) +
        palette.muted(window.slice(marker.length));
    } else if (this.scroll === 0) {
      painted = palette.accent(window.slice(0, marker.length)) +
        palette.assistant(window.slice(marker.length));
    } else {
      painted = palette.assistant(window);
    }

    const bar = palette.border("│");
    const content = `${bar} ${painted} ${bar}`;

    if (!this.rendered) {
      const dash = "─".repeat(W - 2);
      const top = palette.border(`╭${dash}╮`);
      const bottom = palette.border(`╰${dash}╯`);
      this.output.write(`${top}\n${content}\n${bottom}${up(1)}${toCol(caretCol + 1)}`);
      this.rendered = true;
    } else {
      this.output.write(`\r${content}${toCol(caretCol + 1)}`);
    }
  }
}

/** Minimal non-TTY prompt used when raw-mode editing isn't available. */
async function readPromptFallback(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream
): Promise<string | null> {
  const rl = createInterface({ input, output });
  try {
    // A closed input (EOF) never answers the question, so race it.
    const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
    return await Promise.race([rl.question(palette.accent("\n› ")), closed]);
  } catch {
    return null; // EOF
  } finally {
    rl.close();
  }
}
