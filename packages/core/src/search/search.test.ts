import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSearch, MAX_FILES, MAX_MATCHES, type Search } from "./search.ts";

let root: string;
let search: Search;

/** Write files under the root, creating parent directories. */
async function files(entries: Record<string, string>) {
  for (const [rel, content] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "search-test-"));
  search = createSearch(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("grep", () => {
  test("returns matching lines with workspace-relative paths, in path order", async () => {
    await files({
      "src/b.ts": "const load = 1;\nother\n",
      "src/a.ts": "function load() {}\r\n",
      "README.md": "nothing here",
    });
    expect(await search.grep("load")).toEqual({
      ok: true,
      path: ".",
      summary: "Found 2 matches in 2 files",
      matches: [
        { path: "src/a.ts", line: 1, text: "function load() {}" },
        { path: "src/b.ts", line: 1, text: "const load = 1;" },
      ],
      truncated: false,
    });
  });

  test("narrows by path, include glob, and case", async () => {
    await files({ "src/a.ts": "Load", "src/a.js": "Load", "test/a.ts": "Load" });
    const outcome = await search.grep("load", { path: "src", include: "*.ts", ignoreCase: true });
    expect(outcome).toMatchObject({ ok: true, matches: [{ path: "src/a.ts" }] });
    expect(await search.grep("load", { path: "src" })).toMatchObject({ ok: true, matches: [] });
  });

  test("no matches is a success", async () => {
    await files({ "a.txt": "hello" });
    expect(await search.grep("absent")).toMatchObject({
      ok: true,
      summary: "No matches for absent in .",
      matches: [],
    });
  });

  test("a pattern starting with '-' is a pattern, not a flag", async () => {
    await files({ "a.txt": "x --version y" });
    expect(await search.grep("--version")).toMatchObject({ ok: true, matches: [{ line: 1 }] });
  });

  test("skips .gitignore'd and hidden files", async () => {
    await files({
      ".gitignore": "build\n",
      "build/out.js": "needle",
      ".hidden/a.txt": "needle",
      "src/a.ts": "needle",
    });
    await mkdir(path.join(root, ".git"));
    expect(await search.grep("needle")).toMatchObject({ matches: [{ path: "src/a.ts" }] });
  });

  test("never shows secret files, even when an include glob asks for them", async () => {
    await files({ ".env": "API_KEY=x", "certs/server.pem": "API_KEY=x", ".env.example": "API_KEY=" });
    expect(await search.grep("API_KEY")).toMatchObject({ ok: true, matches: [] });
    expect(await search.grep("API_KEY", { include: ".env*" })).toMatchObject({
      ok: true,
      matches: [{ path: ".env.example" }],
    });
    expect(await search.grep("API_KEY", { path: ".env" })).toMatchObject({
      ok: false,
      code: "secret_file",
    });
  });

  test("refuses a symlink path that points to a secret file", async () => {
    await files({ ".env": "API_KEY=x" });
    try {
      await symlink(path.join(root, ".env"), path.join(root, "notes.txt"));
    } catch {
      return; // Creating symlinks needs extra privileges on Windows.
    }
    expect(await search.grep("API_KEY", { path: "notes.txt" })).toMatchObject({
      ok: false,
      code: "secret_file",
    });
  });

  test("caps matches and long lines", async () => {
    await files({
      "many.txt": "hit\n".repeat(MAX_MATCHES + 5),
      "wide.txt": `hit${"x".repeat(1_000)}`,
    });
    const many = await search.grep("hit", { path: "many.txt" });
    expect(many).toMatchObject({ ok: true, truncated: true });
    if (many.ok) expect(many.matches).toHaveLength(MAX_MATCHES);

    const wide = await search.grep("hit", { path: "wide.txt" });
    if (!wide.ok) throw new Error(wide.message);
    expect(wide.matches[0]!.text.length).toBeLessThan(400);
  });

  test("an invalid regex is invalid_input", async () => {
    await files({ "a.txt": "x" });
    expect(await search.grep("a(")).toMatchObject({ ok: false, code: "invalid_input" });
  });

  test("refuses paths outside the workspace", async () => {
    expect(await search.grep("x", { path: "../" })).toMatchObject({
      ok: false,
      code: "outside_workspace",
    });
  });

  test("fails cleanly when ripgrep isn't available", async () => {
    const outcome = await createSearch(root, { rgPath: null }).grep("x");
    expect(outcome).toMatchObject({ ok: false, code: "io_error" });
  });
});

describe("findFiles", () => {
  test("lists files matching a glob, in path order", async () => {
    await files({
      "src/b.test.ts": "",
      "src/a.test.ts": "",
      "src/a.ts": "",
      "src/nested/c.test.ts": "",
    });
    expect(await search.findFiles("*.test.ts")).toEqual({
      ok: true,
      path: ".",
      summary: "Found 3 files",
      files: ["src/a.test.ts", "src/b.test.ts", "src/nested/c.test.ts"],
      truncated: false,
    });
    expect(await search.findFiles("*.ts", { path: "src/nested" })).toMatchObject({
      files: ["src/nested/c.test.ts"],
    });
  });

  test("leaves out secret files", async () => {
    await files({ ".env": "", "deploy.key": "", "keys.ts": "" });
    expect(await search.findFiles("*")).toMatchObject({ files: ["keys.ts"] });
    expect(await search.findFiles(".env")).toMatchObject({ ok: true, files: [] });
  });

  test("caps the number of files", async () => {
    await files(Object.fromEntries(Array.from({ length: MAX_FILES + 3 }, (_, i) => [`f${i}.txt`, ""])));
    const outcome = await search.findFiles("*.txt");
    expect(outcome).toMatchObject({ ok: true, truncated: true });
    if (outcome.ok) expect(outcome.files).toHaveLength(MAX_FILES);
  });
});
