import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/** Why a workspace operation did not apply. Stable, so the model can branch on it. */
export type FailureCode =
  | "outside_workspace"
  | "secret_file"
  | "not_found"
  | "already_exists"
  | "not_a_file"
  | "not_a_directory"
  | "no_match"
  | "ambiguous_match"
  | "invalid_input"
  | "io_error"
  | "timed_out"
  | "shell_unavailable";

/**
 * Result of every workspace operation. Operations never throw: a failure is a
 * value the model can read and recover from. `path` is workspace-relative with
 * forward slashes; `summary`/`message` are human-readable one-liners.
 */
export type Outcome<T = {}> =
  | ({ ok: true; path: string; summary: string } & T)
  | { ok: false; path: string; code: FailureCode; message: string };

/**
 * File names that usually hold credentials: env files (but not their
 * committed templates), private keys and certificates, and auth configs.
 */
const SECRET_FILE =
  /^(\.env(\.(?!(example|sample|template|dist)$).+)?|.+\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.pgpass|\.npmrc|\.git-credentials)$/i;

/** Whether `filePath`'s name marks it as likely holding secrets. */
export function isSecretFile(filePath: string): boolean {
  return SECRET_FILE.test(path.basename(filePath));
}

/**
 * Whether the file at absolute path `abs` holds secrets, judged by its own
 * name and, so a symlink can't disguise one, by the name of the file it
 * points to.
 */
export async function isSecretPath(abs: string): Promise<boolean> {
  if (isSecretFile(abs)) return true;
  const target = await realpath(abs).catch(() => abs);
  return isSecretFile(target);
}

/**
 * Resolve a caller-supplied path against `root` (absolute), or `null` if it
 * escapes. `rel === ".."` or a leading "../" segment means the path left the
 * root; a sibling such as "..foo" must not be misread as an escape.
 */
export function resolveWithin(root: string, userPath: string): string | null {
  const abs = path.resolve(root, userPath);
  const rel = path.relative(root, abs);
  const outside = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return outside ? null : abs;
}

export interface DirectoryEntry {
  name: string;
  type: "file" | "dir";
}

/** The repository the agent works in. Every path is confined to `root`. */
export interface Workspace {
  readonly root: string;
  readFile(filePath: string): Promise<Outcome<{ content: string }>>;
  listDirectory(dirPath?: string): Promise<Outcome<{ entries: DirectoryEntry[] }>>;
  /** Creates parent directories as needed; never overwrites an existing file. */
  createFile(filePath: string, content: string): Promise<Outcome>;
  /** Creates parents as needed; an existing directory is a success, not a failure. */
  createDirectory(dirPath: string): Promise<Outcome<{ created: boolean }>>;
  /** Replaces `oldText` with `newText`; `oldText` must occur exactly once. */
  editFile(filePath: string, oldText: string, newText: string): Promise<Outcome>;
}

export function createWorkspace(root: string): Workspace {
  const absRoot = path.resolve(root);

  /** Workspace-relative, forward-slash form of an absolute path, for display. */
  const display = (abs: string) =>
    path.relative(absRoot, abs).split(path.sep).join("/") || ".";

  const resolve = (userPath: string) => resolveWithin(absRoot, userPath);

  function fail(shown: string, code: FailureCode, message: string): Outcome<never> {
    return { ok: false, path: shown, code, message };
  }

  /**
   * A failure if the file at `abs` holds secrets. Its contents would
   * otherwise reach the model without the user seeing them.
   */
  async function refuseSecret(abs: string, shown: string): Promise<Outcome<never> | null> {
    if (!(await isSecretPath(abs))) return null;
    return fail(shown, "secret_file", `${shown} may contain secrets and can't be read or edited`);
  }

  /** Map a filesystem error to a failure outcome. */
  function fromError(shown: string, err: unknown): Outcome<never> {
    switch ((err as NodeJS.ErrnoException).code) {
      case "ENOENT":
        return fail(shown, "not_found", `Couldn't find ${shown}`);
      case "EEXIST":
        return fail(shown, "already_exists", `${shown} already exists`);
      case "EISDIR":
        return fail(shown, "not_a_file", `${shown} is a directory`);
      case "ENOTDIR":
        return fail(shown, "not_a_directory", `${shown} is not a directory`);
      default:
        return fail(shown, "io_error", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Run `op` on the resolved path, turning containment violations and
   * filesystem errors into failure outcomes so no operation ever throws.
   */
  async function within<T>(
    userPath: string,
    op: (abs: string, shown: string) => Promise<Outcome<T>>
  ): Promise<Outcome<T>> {
    const abs = resolve(userPath);
    if (abs === null) {
      return fail(userPath, "outside_workspace", `${userPath} is outside the workspace`);
    }
    const shown = display(abs);
    try {
      return await op(abs, shown);
    } catch (err) {
      return fromError(shown, err);
    }
  }

  return {
    root: absRoot,

    readFile: (filePath) =>
      within(filePath, async (abs, shown) => {
        const secret = await refuseSecret(abs, shown);
        if (secret) return secret;
        const content = await readFile(abs, "utf8");
        return { ok: true, path: shown, summary: `Read ${shown}`, content };
      }),

    listDirectory: (dirPath = ".") =>
      within(dirPath, async (abs, shown) => {
        const entries = (await readdir(abs, { withFileTypes: true }))
          .map((ent): DirectoryEntry => ({
            name: ent.name,
            type: ent.isDirectory() ? "dir" : "file",
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          ok: true,
          path: shown,
          summary: `Listed ${shown} (${entries.length} entries)`,
          entries,
        };
      }),

    createFile: (filePath, content) =>
      within(filePath, async (abs, shown) => {
        await mkdir(path.dirname(abs), { recursive: true });
        // `wx` fails with EEXIST if the path exists, so we never clobber a file.
        await writeFile(abs, content, { encoding: "utf8", flag: "wx" });
        return { ok: true, path: shown, summary: `Created ${shown}` };
      }),

    createDirectory: (dirPath) =>
      within(dirPath, async (abs, shown) => {
        // `recursive: true` returns undefined when the directory already exists.
        const created = (await mkdir(abs, { recursive: true })) !== undefined;
        return {
          ok: true,
          path: shown,
          summary: created ? `Created directory ${shown}` : `${shown} already exists`,
          created,
        };
      }),

    editFile: (filePath, oldText, newText) =>
      within(filePath, async (abs, shown) => {
        if (oldText.length === 0) {
          return fail(shown, "invalid_input", "Text to replace must not be empty");
        }
        // Refused too: whether an edit matches would reveal the file's contents.
        const secret = await refuseSecret(abs, shown);
        if (secret) return secret;
        const original = await readFile(abs, "utf8");
        const matches = original.split(oldText).length - 1;
        if (matches === 0) {
          return fail(shown, "no_match", `No matching text to edit in ${shown}`);
        }
        if (matches > 1) {
          return fail(
            shown,
            "ambiguous_match",
            `Text to replace matches ${matches} times in ${shown}; include more surrounding context`
          );
        }
        await writeFile(abs, original.replace(oldText, () => newText), "utf8");
        return { ok: true, path: shown, summary: `Edited ${shown}` };
      }),
  };
}
