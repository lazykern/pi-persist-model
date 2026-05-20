/**
 * The extension's own configuration: schema, defaults, parsing, layered
 * resolution (workspace over global), and config-file IO.
 *
 * Config files are JSON and live next to Pi's settings files:
 *   - global:    `~/.pi/agent/model-persistence.json`
 *   - workspace: `<cwd>/.pi/model-persistence.json`
 */

import { type JsonObject, readJsonObject, writeJsonAtomic } from "./settings-file.ts";

/** How model/thinking-level changes are persisted. */
export type PersistenceMode = "session" | "workspace" | "global";

/** How much the extension reports through Pi's notification UI. */
export type NotifyLevel = "off" | "errors" | "changes";

/**
 * The on-disk config shape. Everything except `mode` may be omitted; missing
 * fields fall back to {@link DEFAULT_CONFIG} during resolution.
 */
export type ModelPersistenceConfig = {
  mode: PersistenceMode;
  include?: {
    model?: boolean;
    thinkingLevel?: boolean;
  };
  restoreOnModelRestore?: boolean;
  notify?: NotifyLevel;
};

/** A fully-populated config with every field resolved to a concrete value. */
export type ResolvedConfig = {
  mode: PersistenceMode;
  include: { model: boolean; thinkingLevel: boolean };
  restoreOnModelRestore: boolean;
  notify: NotifyLevel;
};

/** The defaults applied when nothing is configured. */
export const DEFAULT_CONFIG: ResolvedConfig = {
  mode: "session",
  include: { model: true, thinkingLevel: true },
  restoreOnModelRestore: false,
  notify: "errors",
};

const MODES: readonly string[] = ["session", "workspace", "global"];
const NOTIFY_LEVELS: readonly string[] = ["off", "errors", "changes"];

/** Type guard for {@link PersistenceMode}. */
export function isPersistenceMode(value: unknown): value is PersistenceMode {
  return typeof value === "string" && MODES.includes(value);
}

/** Type guard for {@link NotifyLevel}. */
export function isNotifyLevel(value: unknown): value is NotifyLevel {
  return typeof value === "string" && NOTIFY_LEVELS.includes(value);
}

/**
 * Parse a raw config object leniently: recognised, well-typed fields are kept;
 * anything unknown or malformed is dropped. Never throws.
 */
export function parseConfig(raw: unknown): Partial<ModelPersistenceConfig> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as JsonObject;
  const out: Partial<ModelPersistenceConfig> = {};

  if (isPersistenceMode(obj.mode)) {
    out.mode = obj.mode;
  }
  if (isNotifyLevel(obj.notify)) {
    out.notify = obj.notify;
  }
  if (typeof obj.restoreOnModelRestore === "boolean") {
    out.restoreOnModelRestore = obj.restoreOnModelRestore;
  }
  if (obj.include !== null && typeof obj.include === "object" && !Array.isArray(obj.include)) {
    const rawInclude = obj.include as JsonObject;
    const include: { model?: boolean; thinkingLevel?: boolean } = {};
    if (typeof rawInclude.model === "boolean") {
      include.model = rawInclude.model;
    }
    if (typeof rawInclude.thinkingLevel === "boolean") {
      include.thinkingLevel = rawInclude.thinkingLevel;
    }
    if (include.model !== undefined || include.thinkingLevel !== undefined) {
      out.include = include;
    }
  }
  return out;
}

/**
 * Merge config layers over {@link DEFAULT_CONFIG}. Later layers win, so call as
 * `resolveConfig(globalLayer, workspaceLayer)` to give the workspace priority.
 */
export function resolveConfig(
  ...layers: Array<Partial<ModelPersistenceConfig> | undefined>
): ResolvedConfig {
  const resolved: ResolvedConfig = {
    mode: DEFAULT_CONFIG.mode,
    include: { ...DEFAULT_CONFIG.include },
    restoreOnModelRestore: DEFAULT_CONFIG.restoreOnModelRestore,
    notify: DEFAULT_CONFIG.notify,
  };

  for (const layer of layers) {
    if (!layer) {
      continue;
    }
    if (layer.mode !== undefined) {
      resolved.mode = layer.mode;
    }
    if (layer.notify !== undefined) {
      resolved.notify = layer.notify;
    }
    if (layer.restoreOnModelRestore !== undefined) {
      resolved.restoreOnModelRestore = layer.restoreOnModelRestore;
    }
    if (layer.include) {
      if (layer.include.model !== undefined) {
        resolved.include.model = layer.include.model;
      }
      if (layer.include.thinkingLevel !== undefined) {
        resolved.include.thinkingLevel = layer.include.thinkingLevel;
      }
    }
  }
  return resolved;
}

/** Result of loading one config file. */
export type LoadedConfig = {
  /** Whether the file existed on disk. */
  exists: boolean;
  /** The parsed (lenient) config layer; `{}` when missing or unreadable. */
  config: Partial<ModelPersistenceConfig>;
  /** A human-readable message when the file existed but could not be used. */
  error?: string;
};

/** Read and parse a config file. Never throws — IO/parse errors surface in `error`. */
export async function loadConfigFile(path: string): Promise<LoadedConfig> {
  try {
    const raw = await readJsonObject(path);
    if (raw === null) {
      return { exists: false, config: {} };
    }
    return { exists: true, config: parseConfig(raw) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exists: true, config: {}, error: message };
  }
}

/**
 * Apply `patch` to the config file at `path`, preserving any unrelated keys
 * already present. Creates the file (and parent directory) when missing.
 */
export async function updateConfigFile(
  path: string,
  patch: Partial<ModelPersistenceConfig>,
): Promise<void> {
  let existing: JsonObject = {};
  try {
    existing = (await readJsonObject(path)) ?? {};
  } catch {
    // An unreadable existing file is replaced rather than blocking the update.
    existing = {};
  }

  const next: JsonObject = { ...existing };
  if (patch.mode !== undefined) {
    next.mode = patch.mode;
  }
  if (patch.notify !== undefined) {
    next.notify = patch.notify;
  }
  if (patch.restoreOnModelRestore !== undefined) {
    next.restoreOnModelRestore = patch.restoreOnModelRestore;
  }
  if (patch.include !== undefined) {
    const prior =
      existing.include !== null &&
      typeof existing.include === "object" &&
      !Array.isArray(existing.include)
        ? (existing.include as JsonObject)
        : {};
    next.include = { ...prior, ...patch.include };
  }

  await writeJsonAtomic(path, next);
}
