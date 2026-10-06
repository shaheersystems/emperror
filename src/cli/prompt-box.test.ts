import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { readPrompt } from "./prompt-box.ts";

/** A stand-in terminal: a raw-mode-capable input and a capturing output. */
function fakeTerminal({ tty = true, columns = 40 } = {}) {
  const input = Object.assign(new PassThrough(), {
    isTTY: tty,
    rawMode: false,
    setRawMode(mode: boolean) {
      input.rawMode = mode;
      return input;
    },
  });
  let written = "";
  const output = Object.assign(new PassThrough(), {
    columns,
    write(chunk: string) {
      written += chunk;
      return true;
    },
  });
  return {
    input,
    /** Everything written so far, with ANSI escape sequences stripped. */
    screen: () => written.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""),
    raw: () => written,
    prompt: (placeholder?: string) =>
      readPrompt({
        placeholder,
        input: input as unknown as NodeJS.ReadStream,
        output: output as unknown as NodeJS.WriteStream,
      }),
  };
}

/** Type each chunk as a separate `data` event and resolve the prompt. */
async function typeChunks(...chunks: string[]): Promise<string | null> {
  const term = fakeTerminal();
  const result = term.prompt();
  for (const chunk of chunks) term.input.write(chunk);
  return result;
}

const LEFT = "\x1b[D";
const HOME = "\x1b[H";
const END = "\x1b[F";
const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;

describe("submitting and quitting", () => {
  test("Enter submits the typed text", async () => {
    expect(await typeChunks("hello", "\r")).toBe("hello");
  });

  test("Ctrl+C quits", async () => {
    expect(await typeChunks("half", "\x03")).toBeNull();
  });

  test("Ctrl+D quits only on an empty line", async () => {
    expect(await typeChunks("\x04")).toBeNull();
    expect(await typeChunks("keep", "\x04", "\r")).toBe("keep");
  });
});

describe("editing", () => {
  test("backspace and left-arrow insertion", async () => {
    expect(await typeChunks("ac", LEFT, "b", "\r")).toBe("abc");
    expect(await typeChunks("abx", "\x7f", "c\r")).toBe("abc");
  });

  test("Home, End and Delete", async () => {
    expect(await typeChunks("bc", HOME, "a", END, "d\r")).toBe("abcd");
    expect(await typeChunks("abxc", LEFT, LEFT, "\x1b[3~", "\r")).toBe("abc");
  });

  test("alternate Home/End encodings", async () => {
    expect(await typeChunks("b", "\x1bOH", "a", "\x1b[4~", "c\r")).toBe("abc");
  });
});

describe("escape sequences", () => {
  test("a sequence split across chunks is still decoded", async () => {
    expect(await typeChunks("ab", "\x1b", "[D", "X\r")).toBe("aXb");
    expect(await typeChunks("ab", "\x1b[", "D", "X\r")).toBe("aXb");
  });

  test("modified keys don't leak bytes into the text", async () => {
    // Ctrl+Left: moves left like a plain arrow.
    expect(await typeChunks("ab", "\x1b[1;5D", "X\r")).toBe("aXb");
    // Unknown sequences (here F5) are ignored whole.
    expect(await typeChunks("a", "\x1b[15~", "b\r")).toBe("ab");
  });
});

describe("pasting", () => {
  test("pasted newlines are kept instead of submitting", async () => {
    expect(await typeChunks(PASTE("line1\r\nline2\rline3"), "\r")).toBe(
      "line1\nline2\nline3"
    );
  });

  test("a paste split across chunks, including its end marker", async () => {
    expect(await typeChunks("\x1b[200~one\n", "two\x1b[2", "01~", "!\r")).toBe(
      "one\ntwo!"
    );
  });

  test("pasted newlines render as ⏎ on one line", async () => {
    const term = fakeTerminal();
    const result = term.prompt();
    term.input.write(PASTE("a\nb"));
    term.input.write("\r");
    await result;
    expect(term.screen()).toContain("› a⏎b");
  });
});

describe("rendering and terminal state", () => {
  test("the box fits the terminal width and shows the placeholder", async () => {
    const term = fakeTerminal({ columns: 40 });
    const result = term.prompt("Ask away");
    term.input.write("\x03");
    await result;

    const [top] = term.screen().split("\n").filter((l) => l.includes("╭"));
    expect(top).toBe(`╭${"─".repeat(37)}╮`);
    expect(term.screen()).toContain("› Ask away");
  });

  test("long input scrolls instead of overflowing the box", async () => {
    const term = fakeTerminal({ columns: 30 });
    const result = term.prompt();
    term.input.write("x".repeat(100));
    term.input.write("\r");
    expect(await result).toBe("x".repeat(100));
    for (const line of term.screen().split(/[\r\n]/)) {
      expect(line.length).toBeLessThanOrEqual(29);
    }
  });

  test("raw mode and bracketed paste are turned off afterwards", async () => {
    const term = fakeTerminal();
    const result = term.prompt();
    expect(term.input.rawMode).toBe(true);
    term.input.write("\r");
    await result;
    expect(term.input.rawMode).toBe(false);
    expect(term.raw()).toContain("\x1b[?2004h");
    expect(term.raw().lastIndexOf("\x1b[?2004l")).toBeGreaterThan(
      term.raw().lastIndexOf("\x1b[?2004h")
    );
  });
});

describe("without a TTY", () => {
  test("reads a plain line", async () => {
    const term = fakeTerminal({ tty: false });
    const result = term.prompt();
    term.input.write("hello\n");
    expect(await result).toBe("hello");
  });

  test("closed input means quit", async () => {
    const term = fakeTerminal({ tty: false });
    const result = term.prompt();
    term.input.end();
    expect(await result).toBeNull();
  });
});
