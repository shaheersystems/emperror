import { spawn } from "node:child_process";
import path from "node:path";
import {
  isSecretPath,
  resolveWithin,
  type FailureCode,
  type Outcome,
} from "../workspace/workspace.ts";

/** Most matches `grep` returns; past this it reports `truncated`. */
export const MAX_MATCHES = 100;
/** Most paths `findFiles` returns; past this it reports `truncated`. */
export const MAX_FILES = 200;
/** Longer matched lines are cut, so a minified file can't flood the result. */
const MAX_LINE_CHARS = 300;
const TIMEOUT_MS = 30_000;

export interface Match {
  /** Workspace-relative, forward slashes. */
  path: string;
  /** 1-based. */
  line: number;
  text: string;
}

export interface GrepOptions {
  /** Directory or file to search, relative to the root. Defaults to the root. */
  path?: string;
  /** Glob limiting which files are searched, e.g. `*.ts` or `src/**\/*.tsx`. */
  include?: string;
  ignoreCase?: boolean;
}

/**
 * Searches the workspace with ripgrep. Like the workspace, it never throws and
 * never leaves the root. Files ignored by `.gitignore`, hidden files, and
 * binary files are skipped, and files that may hold secrets are never shown.
 */
export interface Search {
  /** Lines matching the regular expression `pattern`, in path order. */
  grep(
    pattern: string,
    options?: GrepOptions
  ): Promise<Outcome<{ matches: Match[]; truncated: boolean }>>;
  /** Paths of files matching the glob `pattern`, in path order. */
  findFiles(
    pattern: string,
    options?: { path?: string }
  ): Promise<Outcome<{ files: string[]; truncated: boolean }>>;
}

export interface SearchOptions {
  /** ripgrep to run; `null` means none is available. Defaults to `@vscode/ripgrep`'s. */
  rgPath?: string | null;
}

export function createSearch(root: string, options: SearchOptions = {}): Search {
  const absRoot = path.resolve(root);
  const rg: Promise<string | null> =
    options.rgPath !== undefined
      ? Promise.resolve(options.rgPath)
      : // Throws on import when no binary was installed for this platform.
        import("@vscode/ripgrep").then((m) => m.rgPath, () => null);

  const fail = (shown: string, code: FailureCode, message: string) =>
    ({ ok: false, path: shown, code, message }) as const;

  /** Workspace-relative, forward-slash form of a path ripgrep printed. */
  const display = (rgOutput: string) =>
    path.relative(absRoot, path.resolve(absRoot, rgOutput)).split(path.sep).join("/") || ".";

  /** Arguments that confine a search to `userPath`, or a failure. */
  async function scope(userPath: string) {
    const abs = resolveWithin(absRoot, userPath);
    if (abs === null) {
      return fail(userPath, "outside_workspace", `${userPath} is outside the workspace`);
    }
    const shown = display(abs);
    // ripgrep follows a path it is given, even a symlink to a secret file.
    if (await isSecretPath(abs)) {
      return fail(shown, "secret_file", `${shown} may contain secrets and can't be searched`);
    }
    return { shown, target: path.relative(absRoot, abs) || "." };
  }

  /**
   * Keep only paths that don't hold secrets. An include glob such as `.env`
   * overrides ripgrep's ignore rules, so this is the only check that counts.
   */
  async function withoutSecrets<T extends { path: string }>(items: T[]): Promise<T[]> {
    const secret = new Map<string, Promise<boolean>>();
    const checks = items.map((item) => {
      if (!secret.has(item.path)) {
        secret.set(item.path, isSecretPath(path.join(absRoot, item.path)));
      }
      return secret.get(item.path)!;
    });
    const flags = await Promise.all(checks);
    return items.filter((_, i) => !flags[i]);
  }

  return {
    async grep(pattern, { path: userPath = ".", include, ignoreCase = false } = {}) {
      if (pattern === "") return fail(".", "invalid_input", "Pattern must not be empty");
      const where = await scope(userPath);
      if ("ok" in where) return where;

      const args = ["--json", ...(ignoreCase ? ["--ignore-case"] : [])];
      if (include) args.push("--glob", include);
      // `--regexp` keeps a pattern starting with "-" from being read as a flag.
      args.push("--regexp", pattern, "--", where.target);

      const matches: Match[] = [];
      const result = await runRg(await rg, absRoot, args, (line) => {
        const event = parseJson(line);
        if (event?.type !== "match") return true;
        const file = event.data?.path?.text;
        const text = event.data?.lines?.text;
        // Non-UTF-8 paths and lines arrive base64-encoded as `bytes`; skip them.
        if (typeof file !== "string" || typeof text !== "string") return true;
        matches.push({
          path: display(file),
          line: event.data.line_number,
          text: clip(text.replace(/\r?\n$/, "")),
        });
        // Read one past the limit so we know whether there were more.
        return matches.length <= MAX_MATCHES;
      });
      if (!result.ok) return failFromRg(result, where.shown);

      const visible = await withoutSecrets(matches);
      const truncated = matches.length > MAX_MATCHES;
      const shown = visible.slice(0, MAX_MATCHES);
      const files = new Set(shown.map((m) => m.path)).size;
      return {
        ok: true,
        path: where.shown,
        summary:
          shown.length === 0
            ? `No matches for ${pattern} in ${where.shown}`
            : `Found ${plural(shown.length, "match", "matches")} in ${plural(files, "file", "files")}` +
              (truncated ? " (more not shown)" : ""),
        matches: shown,
        truncated,
      };
    },

    async findFiles(pattern, { path: userPath = "." } = {}) {
      if (pattern === "") return fail(".", "invalid_input", "Pattern must not be empty");
      const where = await scope(userPath);
      if ("ok" in where) return where;

      const found: { path: string }[] = [];
      const result = await runRg(
        await rg,
        absRoot,
        ["--files", "--glob", pattern, "--", where.target],
        (line) => {
          if (line !== "") found.push({ path: display(line) });
          return found.length <= MAX_FILES;
        }
      );
      if (!result.ok) return failFromRg(result, where.shown);

      const visible = await withoutSecrets(found);
      const truncated = found.length > MAX_FILES;
      const files = visible.slice(0, MAX_FILES).map((f) => f.path);
      return {
        ok: true,
        path: where.shown,
        summary:
          files.length === 0
            ? `No files match ${pattern} in ${where.shown}`
            : `Found ${plural(files.length, "file", "files")}` + (truncated ? " (more not shown)" : ""),
        files,
        truncated,
      };
    },
  };

  function failFromRg(result: RgFailure, shown: string) {
    return fail(shown, result.code, result.message);
  }
}

type RgFailure = { ok: false; code: FailureCode; message: string };

/**
 * Run ripgrep in `cwd`, feeding each stdout line to `onLine` until it returns
 * false, at which point ripgrep is stopped. Exit code 1 (nothing found) is a
 * success; an error with no output, or a timeout, is a failure.
 */
function runRg(
  rgPath: string | null,
  cwd: string,
  args: string[],
  onLine: (line: string) => boolean
): Promise<{ ok: true } | RgFailure> {
  if (!rgPath) {
    return Promise.resolve({
      ok: false,
      code: "io_error",
      message: "ripgrep isn't installed for this platform",
    });
  }
  // `--no-config` ignores RIPGREP_CONFIG_PATH; `--sort path` makes results
  // stable at the cost of searching on one thread.
  const fullArgs = ["--no-config", "--sort", "path", "--no-messages", ...args];

  return new Promise((resolve) => {
    const child = spawn(rgPath, fullArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stopped = false;
    let timedOut = false;
    let produced = false;
    let pending = "";
    let stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);

    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        produced = true;
        if (!onLine(line.replace(/\r$/, ""))) return stop();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 2_000) stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: "io_error", message: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stopped && pending !== "") {
        produced = true;
        onLine(pending.replace(/\r$/, ""));
      }
      if (timedOut) {
        resolve({ ok: false, code: "timed_out", message: `Search timed out after ${TIMEOUT_MS / 1000}s` });
      } else if (stopped || code === 0 || code === 1 || (code === 2 && produced)) {
        // Code 2 with output means some files couldn't be read; the rest stand.
        resolve({ ok: true });
      } else {
        const message = stderr.trim().replace(/^rg: /, "") || `ripgrep exited with code ${code}`;
        // A bad regex or glob is the caller's to fix, not an I/O problem.
        const badInput = /regex parse error|glob|unclosed|invalid/i.test(message);
        resolve({ ok: false, code: badInput ? "invalid_input" : "io_error", message });
      }
    });
  });
}

function parseJson(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const clip = (text: string) =>
  text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
