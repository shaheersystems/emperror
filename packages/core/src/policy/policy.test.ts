import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryPolicy, createProjectPolicy, SETTINGS_PATH } from "./policy.ts";

let root: string;
let settingsFile: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "policy-test-"));
  settingsFile = path.join(root, SETTINGS_PATH);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const readSettings = async () => JSON.parse(await readFile(settingsFile, "utf8"));

test("without a settings file, nothing is allowed", () => {
  expect(createProjectPolicy(root).isAllowed("read_file")).toBe(false);
});

test("allowing a tool writes it to .emperror/settings.json", async () => {
  const policy = createProjectPolicy(root);

  policy.allowForProject("edit_file");
  policy.allowForProject("edit_file");

  expect(policy.isAllowed("edit_file")).toBe(true);
  expect(await readSettings()).toEqual({ permissions: { allow: ["edit_file"] } });
  expect(createProjectPolicy(root).isAllowed("edit_file")).toBe(true);
});

test("other settings in the file are kept", async () => {
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(
    settingsFile,
    JSON.stringify({ theme: "dark", permissions: { allow: ["read_file"], note: "x" } })
  );

  createProjectPolicy(root).allowForProject("list_files");

  expect(await readSettings()).toEqual({
    theme: "dark",
    permissions: { allow: ["read_file", "list_files"], note: "x" },
  });
});

test("bash always asks, even if the settings file allows it", async () => {
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ permissions: { allow: ["bash"] } }));
  const policy = createProjectPolicy(root);

  policy.allowForProject("bash");

  expect(policy.canAllowForProject("bash")).toBe(false);
  expect(policy.isAllowed("bash")).toBe(false);
  expect(createMemoryPolicy(["bash"]).isAllowed("bash")).toBe(false);
});

test("an invalid settings file is a readable startup error", async () => {
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ permissions: { allow: "everything" } }));

  expect(() => createProjectPolicy(root)).toThrow(/Invalid \.emperror\/settings\.json/);
});
