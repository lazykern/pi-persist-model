/**
 * Reading and writing Pi `settings.json` files.
 *
 * The extension only ever touches three keys — `defaultProvider`,
 * `defaultModel`, `defaultThinkingLevel` — but every operation goes through a
 * full read / transform / atomic-write cycle so unrelated keys and the JSON
 * object structure are preserved.
 *
 * The pure helpers (`snapshotDefaults`, `restoreDefaults`, `applyDefaults`) are
 * separated from the IO functions so they can be unit-tested without a disk.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** A parsed JSON object. */
export type JsonObject = Record<string, unknown>;

/** The Pi settings keys this extension manages. */
export const DEFAULTS_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;
export type DefaultsKey = (typeof DEFAULTS_KEYS)[number];

/**
 * One captured field. `present` distinguishes "the key was absent" from "the
 * key held a value" — restoring an originally-absent field deletes the key
 * rather than writing `null`.
 */
export type SnapshotField = { present: true; value: string } | { present: false };

/** A snapshot of the three managed keys at a point in time. */
export type DefaultsSnapshot = Record<DefaultsKey, SnapshotField>;

/** Raised when a settings file exists but is not a readable JSON object. */
export class SettingsFileError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "SettingsFileError";
    this.path = path;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Capture the three managed keys from a settings object (or `null` file). */
export function snapshotDefaults(settings: JsonObject | null): DefaultsSnapshot {
  const read = (key: DefaultsKey): SnapshotField => {
    const value = settings?.[key];
    return typeof value === "string" ? { present: true, value } : { present: false };
  };
  return {
    defaultProvider: read("defaultProvider"),
    defaultModel: read("defaultModel"),
    defaultThinkingLevel: read("defaultThinkingLevel"),
  };
}

/**
 * Return a copy of `settings` with the given keys reset to `snapshot`.
 * Keys captured as present are written back; keys captured as absent are
 * deleted. Unrelated keys are left untouched.
 */
export function restoreDefaults(
  settings: JsonObject,
  snapshot: DefaultsSnapshot,
  keys: readonly DefaultsKey[],
): JsonObject {
  const next: JsonObject = { ...settings };
  for (const key of keys) {
    const field = snapshot[key];
    if (field.present) {
      next[key] = field.value;
    } else {
      delete next[key];
    }
  }
  return next;
}

/** Return a copy of `settings` with the provided managed keys overwritten. */
export function applyDefaults(
  settings: JsonObject,
  updates: Partial<Record<DefaultsKey, string>>,
): JsonObject {
  const next: JsonObject = { ...settings };
  for (const key of DEFAULTS_KEYS) {
    const value = updates[key];
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/** True if the path exists (file or directory). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a JSON object from disk.
 *
 * @returns `null` when the file is missing, an object otherwise.
 * @throws  {@link SettingsFileError} when the file exists but is not a JSON object.
 */
export async function readJsonObject(path: string): Promise<JsonObject | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") {
      return null;
    }
    throw new SettingsFileError(path, `cannot read ${path}: ${describe(error)}`);
  }

  if (text.trim() === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SettingsFileError(path, `invalid JSON in ${path}: ${describe(error)}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsFileError(path, `expected a JSON object in ${path}`);
  }
  return parsed as JsonObject;
}

/**
 * Write a JSON object atomically: serialize to a sibling temp file, then
 * `rename()` over the target. Creates the parent directory if needed.
 */
export async function writeJsonAtomic(path: string, value: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw new SettingsFileError(path, `cannot write ${path}: ${describe(error)}`);
  }
}
