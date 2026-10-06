import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Outcome } from "../workspace/workspace.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

/** Output beyond this keeps its head and tail; the middle is dropped. */
const MAX_OUTPUT_CHARS = 30_000;

/**
 * How long to wait for output after bash exits. A background process can hold
 * the pipes open forever; past this, the call returns without waiting for it.
 */
const EXIT_GRACE_MS = 500;

/** How long to wait for a timed-out command to die after it is killed. */
const KILL_GRACE_MS = 2_000;

/**
 * Environment variables that look like credentials. They are removed before a
 * command runs so the model can't read them back (e.g. with `env`), including
 * the API key that `.env` loads into this process.
 */
const SECRET_NAME =
  /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|COOKIE|SESSION|PRIVATE|DSN|DATABASE_URL|CONNECTION_STRING)(_|$)/i;

/** Make commands fail fast instead of waiting on a prompt or a pager. */
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  PAGER: "cat",
  GIT_PAGER: "cat",
  NO_COLOR: "1",
  TERM: "dumb",
};

export interface CommandResult {
  exitCode: number;
  /** stdout and stderr interleaved in arrival order. */
  output: string;
  /** Whether the middle of a long output was dropped. */
  truncated: boolean;
}

/** Runs commands with bash in the workspace root. */
export interface Shell {
  run(command: string, options?: { timeoutMs?: number }): Promise<Outcome<CommandResult>>;
}

export interface ShellOptions {
  /** bash to run; `null` means none is available. Defaults to `findBash()`. */
  bashPath?: string | null;
  /** Environment to start from before secrets are removed. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * A shell rooted at `root`. Commands run non-interactively (stdin closed),
 * without credential-like environment variables, under a timeout that kills
 * the whole process tree. Like the other tools it never throws.
 *
 * This is not a sandbox: a command can `cd` anywhere and do anything the user
 * can. The safeguard is that every command is shown to the user for approval.
 */
export function createShell(root: string, options: ShellOptions = {}): Shell {
  const cwd = path.resolve(root);
  const bash = options.bashPath === undefined ? findBash() : options.bashPath;
  const env = { ...scrubEnv(options.env ?? process.env), ...NON_INTERACTIVE_ENV };

  const fail = (code: "invalid_input" | "shell_unavailable" | "timed_out" | "io_error", message: string) =>
    ({ ok: false, path: ".", code, message }) as const;

  return {
    async run(command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      if (!bash) return fail("shell_unavailable", "bash was not found on this machine");
      if (command.trim() === "") return fail("invalid_input", "Command must not be empty");
      const limit = Math.min(Math.max(1, timeoutMs), MAX_TIMEOUT_MS);

      return new Promise((resolve) => {
        const output = createOutputBuffer(MAX_OUTPUT_CHARS);
        let timedOut = false;
        let settled = false;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;

        const child = spawn(bash, ["-c", command], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process group on POSIX, so the whole tree can be killed.
          detached: process.platform !== "win32",
          windowsHide: true,
        });

        const finish = (result: Outcome<CommandResult>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(graceTimer);
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve(result);
        };

        // On timeout, wait (briefly) for the tree to die so nothing is left
        // running in the workspace when the call returns.
        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
          graceTimer = setTimeout(done, KILL_GRACE_MS);
        }, limit);

        for (const stream of [child.stdout, child.stderr]) {
          stream?.setEncoding("utf8");
          stream?.on("data", (chunk: string) => output.push(chunk));
        }

        child.on("error", (err) => finish(fail("io_error", err.message)));

        let exitCode = 0;
        const done = () => {
          if (timedOut) {
            finish(
              fail("timed_out", `Command timed out after ${formatSeconds(limit)} and was stopped`)
            );
            return;
          }
          const truncated = output.truncated();
          finish({
            ok: true,
            path: ".",
            summary:
              `Command exited with code ${exitCode}` + (truncated ? " (output truncated)" : ""),
            exitCode,
            output: output.text(),
            truncated,
          });
        };

        child.on("exit", (code, signal) => {
          exitCode = code ?? (signal ? 128 : 1);
          // Don't leave background jobs running after the call returns. Only on
          // POSIX: the process group outlives bash, but on Windows its pid may
          // already belong to an unrelated process.
          if (process.platform !== "win32") killTree(child);
          clearTimeout(graceTimer);
          graceTimer = setTimeout(done, EXIT_GRACE_MS);
        });
        child.on("close", done);
      });
    },
  };
}

/**
 * Locate bash. On Windows this is Git Bash; `C:\Windows\System32\bash.exe`
 * is skipped because it runs commands inside WSL, not on this filesystem.
 */
export function findBash(): string | null {
  if (process.platform !== "win32") return Bun.which("bash");

  const candidates: string[] = [];
  const git = Bun.which("git");
  if (git) candidates.push(path.join(path.dirname(path.dirname(git)), "bin", "bash.exe"));
  candidates.push(
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
  );
  const onPath = Bun.which("bash");
  if (onPath && !/\\(system32|windowsapps)\\/i.test(onPath)) candidates.push(onPath);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** `env` without variables whose names look like credentials. */
export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !SECRET_NAME.test(entry[0])
    )
  );
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

/** Keeps the first and last `limit / 2` characters of everything pushed. */
function createOutputBuffer(limit: number) {
  const half = Math.floor(limit / 2);
  let head = "";
  let tail = "";
  let dropped = 0;
  return {
    push(chunk: string) {
      if (head.length < half) {
        const take = chunk.slice(0, half - head.length);
        head += take;
        chunk = chunk.slice(take.length);
      }
      if (chunk === "") return;
      tail += chunk;
      if (tail.length > half) {
        dropped += tail.length - half;
        tail = tail.slice(-half);
      }
    },
    truncated: () => dropped > 0,
    text: () =>
      dropped > 0 ? `${head}\n… ${dropped} characters omitted …\n${tail}` : head + tail,
  };
}

const formatSeconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
