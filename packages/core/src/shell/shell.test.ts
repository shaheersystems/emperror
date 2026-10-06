import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createShell, findBash, scrubEnv } from "./shell.ts";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "shell-test-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const hasBash = findBash() !== null;
const withBash = test.skipIf(!hasBash);

withBash("runs in the workspace root and returns the exit code and output", async () => {
  const shell = createShell(root);
  await Bun.write(path.join(root, "marker.txt"), "");

  expect(await shell.run("ls; echo oops >&2; exit 3")).toMatchObject({
    ok: true,
    exitCode: 3,
    summary: "Command exited with code 3",
    output: "marker.txt\noops\n",
    truncated: false,
  });
});

withBash("removes credentials from the environment", async () => {
  const shell = createShell(root, {
    env: { ...process.env, GOOGLE_GENERATIVE_AI_API_KEY: "sk-secret", VISIBLE: "yes" },
  });

  const result = await shell.run("env");

  expect(result).toMatchObject({ ok: true, exitCode: 0 });
  const output = (result as { output: string }).output;
  expect(output).not.toContain("sk-secret");
  expect(output).toContain("VISIBLE=yes");
  expect(output).toContain("GIT_TERMINAL_PROMPT=0");
});

withBash("closes stdin, so commands waiting for input don't hang", async () => {
  expect(await createShell(root).run("cat", { timeoutMs: 5_000 })).toMatchObject({
    ok: true,
    exitCode: 0,
  });
});

withBash("stops a command that runs past its timeout", async () => {
  const started = Date.now();

  const result = await createShell(root).run("sleep 30", { timeoutMs: 300 });

  expect(result).toMatchObject({ ok: false, code: "timed_out" });
  expect(Date.now() - started).toBeLessThan(5_000);
});

withBash("doesn't wait on background processes holding the output open", async () => {
  const started = Date.now();

  const result = await createShell(root).run("sleep 30 & echo started", { timeoutMs: 10_000 });

  expect(result).toMatchObject({ ok: true, exitCode: 0, output: "started\n" });
  expect(Date.now() - started).toBeLessThan(5_000);
});

withBash("keeps the head and tail of long output", async () => {
  const result = await createShell(root).run(
    "echo START; head -c 100000 /dev/zero | tr '\\0' x; echo; echo END"
  );

  expect(result).toMatchObject({ ok: true, truncated: true });
  const output = (result as { output: string }).output;
  expect(output.startsWith("START\n")).toBe(true);
  expect(output.endsWith("END\n")).toBe(true);
  expect(output).toContain("characters omitted");
  expect(output.length).toBeLessThan(31_000);
});

test("empty commands and a missing bash are failures, not exceptions", async () => {
  expect(await createShell(root).run("  ")).toMatchObject({ ok: false, code: "invalid_input" });
  expect(await createShell(root, { bashPath: null }).run("ls")).toMatchObject({
    ok: false,
    code: "shell_unavailable",
  });
});

test("scrubEnv drops credential-like names and keeps the rest", () => {
  expect(
    scrubEnv({
      PATH: "/bin",
      HOME: "/home/me",
      KEYBOARD_LAYOUT: "us",
      GITHUB_TOKEN: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      AWS_ACCESS_KEY_ID: "x",
      NPM_AUTH: "x",
      DB_PASSWORD: "x",
      DATABASE_URL: "x",
      SSH_AUTH_SOCK: "x",
    })
  ).toEqual({ PATH: "/bin", HOME: "/home/me", KEYBOARD_LAYOUT: "us" });
});
