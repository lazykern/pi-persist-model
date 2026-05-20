/**
 * Extension configuration: schema, defaults, parsing, and config-file IO.
 *
 * Single config file at `~/.pi/model-persistence/config.json`.
 * No layering — one file, one truth.  Pi's native `.pi/settings.json` handles
 * per-project model overrides when the user wants them.
 */

import { type JsonObject, readJsonObject, writeJsonAtomic } from "./settings-file.ts";

// ── Types ──────────────────────────────────────────────────────────────────

/** Persistence mode: `session` keeps changes in-session; `global` disables extension. */
export type PersistenceMode = "session" | "global";

/** Notification verbosity. */
export type NotifyLevel = "off" | "errors" | "changes";

/** A pinned model/thinking-level preference for one workspace. */
export type Pin = {
  provider: string;
  model: string;
  thinkingLevel?: string;
};

/** The on-disk config shape. */
export type ModelPersistenceConfig = {
  mode: PersistenceMode;
  include?: {
    model?: boolean;
    thinkingLevel?: boolean;
  };
  restoreOnModelRestore?: boolean;
  notify?: NotifyLevel;
  /** Per-workspace model pins keyed by absolute working-directory path. */
  pins?: Record<string, Pin>;
};

/** Fully-resolved config with every optional field defaulted. */
export type ResolvedConfig = {
  mode: PersistenceMode;
  include: { model: boolean; thinkingLevel: boolean };
  restoreOnModelRestore: boolean;
  notify: NotifyLevel;
  pins: Record<string, Pin>;
};

// ── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: ResolvedConfig = {
  mode: "session",
  include: { model: true, thinkingLevel: true },
  restoreOnModelRestore: false,
  notify: "errors",
  pins: {},
};

const MODES: readonly string[] = ["session", "global"];
const NOTIFY_LEVELS: readonly string[] = ["off", "errors", "changes"];

// ── Guards ─────────────────────────────────────────────────────────────────

export function isPersistenceMode(value: unknown): value is PersistenceMode {
  return typeof value === "string" && MODES.includes(value);
}

export function isNotifyLevel(value: unknown): value is NotifyLevel {
  return typeof value === "string" && NOTIFY_LEVELS.includes(value);
}

// ── Parse / Resolve ────────────────────────────────────────────────────────

/**
 * Lenient parse: recognised, well-typed fields are kept; unknowns dropped.
 * Never throws.
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
  if (
    obj.pins !== null &&
    typeof obj.pins === "object" &&
    !Array.isArray(obj.pins)
  ) {
    const rawPins = obj.pins as JsonObject;
    const pins: Record<string, Pin> = {};
    for (const [cwd, rawPin] of Object.entries(rawPins)) {
      if (
        rawPin !== null &&
        typeof rawPin === "object" &&
        !Array.isArray(rawPin) &&
        typeof (rawPin as JsonObject).provider === "string" &&
        typeof (rawPin as JsonObject).model === "string"
      ) {
        const p = rawPin as JsonObject;
        pins[cwd] = {
          provider: p.provider as string,
          model: p.model as string,
          thinkingLevel:
            typeof p.thinkingLevel === "string" ? (p.thinkingLevel as string) : undefined,
        };
      }
    }
    if (Object.keys(pins).length > 0) {
      out.pins = pins;
    }
  }

  return out;
}

/** Merge a parsed layer over defaults to produce a fully-resolved config. */
export function resolveConfig(
  layer?: Partial<ModelPersistenceConfig>,
): ResolvedConfig {
  const resolved: ResolvedConfig = {
    mode: DEFAULT_CONFIG.mode,
    include: { ...DEFAULT_CONFIG.include },
    restoreOnModelRestore: DEFAULT_CONFIG.restoreOnModelRestore,
    notify: DEFAULT_CONFIG.notify,
    pins: { ...DEFAULT_CONFIG.pins },
  };

  if (!layer) {
    return resolved;
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
  if (layer.pins) {
    resolved.pins = { ...layer.pins };
  }

  return resolved;
}

// ── IO ─────────────────────────────────────────────────────────────────────

export type LoadedConfig = {
  exists: boolean;
  config: Partial<ModelPersistenceConfig>;
  error?: string;
};

/** Read and parse the config file. Never throws. */
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
 * Apply `patch` to the config file at `path`, preserving unrelated keys.
 * Creates the file and parent directory when missing.
 */
export async function updateConfigFile(
  path: string,
  patch: Partial<ModelPersistenceConfig>,
): Promise<void> {
  let existing: JsonObject = {};
  try {
    existing = (await readJsonObject(path)) ?? {};
  } catch {
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
  if (patch.pins !== undefined) {
    next.pins = patch.pins;
  }

  await writeJsonAtomic(path, next);
}
