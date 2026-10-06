import chalk from "chalk";

/**
 * Presentation layer for the CLI: colors, the whimsical "working" verbs, and
 * rendering of tool results as human-readable status lines.
 * Keeping it here means the REPL stays focused on control flow.
 */

/** Brand palette, centralized so the look can be retuned in one place. */
export const palette = {
  brand: chalk.hex("#c084fc"), // soft violet
  accent: chalk.hex("#22d3ee"), // cyan
  user: chalk.hex("#34d399"), // green
  assistant: chalk.white,
  border: chalk.hex("#6b7280"), // subtle gray box edges
  muted: chalk.dim,
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
};

/**
 * Cute, whimsical present-participles shown while the agent is thinking. One is
 * picked at random each time the agent returns to "working", e.g. "Ziggagging…".
 */
const WHIMSICAL_VERBS = [
  "Ziggagging",
  "Noodling",
  "Bamboozling",
  "Conjuring",
  "Percolating",
  "Wobbling",
  "Marinating",
  "Frolicking",
  "Tinkering",
  "Galumphing",
  "Befuddling",
  "Kerfuffling",
  "Doodling",
  "Discombobulating",
  "Snazzifying",
  "Wrangling",
  "Flummoxing",
  "Razzmatazzing",
  "Bedazzling",
  "Hornswoggling",
  "Skedaddling",
  "Canoodling",
  "Mulling",
  "Yak-shaving",
  "Jitterbugging",
  "Flibbertigibbeting",
  "Whirring",
  "Scheming",
  "Pondering",
  "Brewing",
];

/** A random whimsical status line such as "Bamboozling…". */
export function whimsy(): string {
  const verb = WHIMSICAL_VERBS[Math.floor(Math.random() * WHIMSICAL_VERBS.length)];
  return `${palette.brand(verb)}${palette.muted("…")}`;
}

/** Outcome of a finished tool call, ready to render with a check or warning. */
export interface ToolOutcome {
  ok: boolean;
  text: string;
}

/**
 * Past-tense summary of a completed tool call. Workspace tools return an
 * `Outcome` carrying its own summary or failure message (see src/workspace);
 * anything else renders as a bare success.
 */
export function describeToolResult(toolName: string, output: unknown): ToolOutcome {
  const out = (output ?? {}) as Record<string, unknown>;
  if (out.ok === true && typeof out.summary === "string") {
    return { ok: true, text: out.summary };
  }
  if (out.ok === false && typeof out.message === "string") {
    return { ok: false, text: out.message };
  }
  return { ok: true, text: `Ran ${chalk.bold(toolName)}` };
}

/** The startup banner. */
export function banner(model: string): string {
  const title = palette.brand.bold("✦ coding agent");
  const sub = palette.muted(`model ${model} · type `) + palette.accent("exit") +
    palette.muted(" or ") + palette.accent("quit") + palette.muted(" to leave");
  return `\n${title}\n${sub}\n`;
}
