import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspace, type Workspace } from "./workspace.ts";

let root: string;
let ws: Workspace;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workspace-test-"));
  ws = createWorkspace(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const contents = (rel: string) => readFile(path.join(root, rel), "utf8");

describe("containment", () => {
  test.each(["../escape.txt", "a/../../escape.txt", path.join(tmpdir(), "abs.txt")])(
    "refuses %s",
    async (p) => {
      expect(await ws.createFile(p, "x")).toMatchObject({
        ok: false,
        code: "outside_workspace",
      });
    }
  );

  test("a sibling named '..foo' is inside the workspace", async () => {
    expect(await ws.createFile("..foo", "x")).toMatchObject({ ok: true, path: "..foo" });
  });
});

describe("readFile", () => {
  test("returns content and a workspace-relative path", async () => {
    await ws.createFile("src/a.ts", "hello");
    expect(await ws.readFile("src/a.ts")).toEqual({
      ok: true,
      path: "src/a.ts",
      summary: "Read src/a.ts",
      content: "hello",
    });
  });

  test("missing file is not_found", async () => {
    expect(await ws.readFile("nope.ts")).toMatchObject({ ok: false, code: "not_found" });
  });

  test("a directory is not_a_file", async () => {
    await ws.createDirectory("dir");
    expect(await ws.readFile("dir")).toMatchObject({ ok: false, code: "not_a_file" });
  });
});

describe("listDirectory", () => {
  test("lists sorted entries with types, defaulting to the root", async () => {
    await ws.createFile("b.txt", "");
    await ws.createDirectory("a");
    expect(await ws.listDirectory()).toMatchObject({
      ok: true,
      path: ".",
      summary: "Listed . (2 entries)",
      entries: [
        { name: "a", type: "dir" },
        { name: "b.txt", type: "file" },
      ],
    });
  });

  test("missing directory is not_found rather than a throw", async () => {
    expect(await ws.listDirectory("nope")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("createFile", () => {
  test("creates parent directories", async () => {
    expect(await ws.createFile("deep/er/x.txt", "x")).toMatchObject({ ok: true });
    expect(await contents("deep/er/x.txt")).toBe("x");
  });

  test("never overwrites an existing file", async () => {
    await ws.createFile("x.txt", "original");
    expect(await ws.createFile("x.txt", "new")).toMatchObject({
      ok: false,
      code: "already_exists",
    });
    expect(await contents("x.txt")).toBe("original");
  });
});

describe("createDirectory", () => {
  test("reports whether it created the directory", async () => {
    expect(await ws.createDirectory("d/e")).toMatchObject({ ok: true, created: true });
    expect(await ws.createDirectory("d/e")).toMatchObject({ ok: true, created: false });
  });
});

describe("editFile", () => {
  beforeEach(async () => {
    await writeFile(path.join(root, "f.ts"), "const a = 1;\nconst b = 1;\n");
  });

  test("replaces a unique match", async () => {
    expect(await ws.editFile("f.ts", "a = 1", "a = 2")).toMatchObject({ ok: true });
    expect(await contents("f.ts")).toBe("const a = 2;\nconst b = 1;\n");
  });

  test("refuses an ambiguous match and leaves the file alone", async () => {
    const outcome = await ws.editFile("f.ts", "= 1", "= 2");
    expect(outcome).toMatchObject({ ok: false, code: "ambiguous_match" });
    expect(outcome.ok === false && outcome.message).toContain("2 times");
    expect(await contents("f.ts")).toBe("const a = 1;\nconst b = 1;\n");
  });

  test("no match is no_match", async () => {
    expect(await ws.editFile("f.ts", "zzz", "y")).toMatchObject({
      ok: false,
      code: "no_match",
    });
  });

  test("inserts replacement text literally, even with $ patterns", async () => {
    await ws.editFile("f.ts", "a = 1", "a = '$&'");
    expect(await contents("f.ts")).toContain("const a = '$&';");
  });

  test("empty old text is invalid_input", async () => {
    expect(await ws.editFile("f.ts", "", "x")).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  test("missing file is not_found", async () => {
    expect(await ws.editFile("nope.ts", "a", "b")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});
