import { type JsonObject, readJsonObject, writeJsonAtomic } from "./settings-file.ts";

export type PersistModelScope = "session" | "workspace" | "user";
export type WorkspacePersistModelScope = PersistModelScope | "inherit";

export type ProjectSettingsPrior = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
};

/** Canonical user-intended defaults, stored in extension config.
 *  Read first on init so snapshot isn't poisoned by global-settings leaks. */
export type PiDefaults = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
};

export type WorkspacePersistModelConfig = {
  scope?: WorkspacePersistModelScope;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  /** Saved before the extension writes to project .pi/settings.json. */
  priorProjectSettings?: ProjectSettingsPrior;
};

export type PersistModelConfig = {
  defaultScope?: PersistModelScope;
  include?: {
    model?: boolean;
    thinkingLevel?: boolean;
  };
  workspaces?: Record<string, WorkspacePersistModelConfig>;
  piDefaults?: PiDefaults;
};

export type ResolvedPersistModelConfig = {
  defaultScope: PersistModelScope;
  include: { model: boolean; thinkingLevel: boolean };
  workspaces: Record<string, WorkspacePersistModelConfig>;
  piDefaults?: PiDefaults;
};

export const DEFAULT_CONFIG: ResolvedPersistModelConfig = {
  defaultScope: "session",
  include: { model: true, thinkingLevel: true },
  workspaces: {},
};

const SCOPES: readonly PersistModelScope[] = ["session", "workspace", "user"];
const WORKSPACE_SCOPES: readonly WorkspacePersistModelScope[] = ["inherit", ...SCOPES];

export function isPersistModelScope(value: unknown): value is PersistModelScope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

export function isWorkspacePersistModelScope(value: unknown): value is WorkspacePersistModelScope {
  return typeof value === "string" && (WORKSPACE_SCOPES as readonly string[]).includes(value);
}

export function nextScope(scope: PersistModelScope): PersistModelScope {
  const index = SCOPES.indexOf(scope);
  return SCOPES[(index + 1) % SCOPES.length] ?? "session";
}

export function nextWorkspaceScope(scope: WorkspacePersistModelScope): WorkspacePersistModelScope {
  const index = WORKSPACE_SCOPES.indexOf(scope);
  return WORKSPACE_SCOPES[(index + 1) % WORKSPACE_SCOPES.length] ?? "inherit";
}

export function parseConfig(raw: unknown): PersistModelConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const obj = raw as JsonObject;
  const out: PersistModelConfig = {};

  if (isPersistModelScope(obj.defaultScope)) {
    out.defaultScope = obj.defaultScope;
  }

  if (obj.include !== null && typeof obj.include === "object" && !Array.isArray(obj.include)) {
    const rawInclude = obj.include as JsonObject;
    const include: { model?: boolean; thinkingLevel?: boolean } = {};
    if (typeof rawInclude.model === "boolean") include.model = rawInclude.model;
    if (typeof rawInclude.thinkingLevel === "boolean") include.thinkingLevel = rawInclude.thinkingLevel;
    if (include.model !== undefined || include.thinkingLevel !== undefined) {
      out.include = include;
    }
  }

  if (obj.workspaces !== null && typeof obj.workspaces === "object" && !Array.isArray(obj.workspaces)) {
    const rawWorkspaces = obj.workspaces as JsonObject;
    const workspaces: Record<string, WorkspacePersistModelConfig> = {};
    for (const [workspaceId, rawWorkspace] of Object.entries(rawWorkspaces)) {
      if (rawWorkspace === null || typeof rawWorkspace !== "object" || Array.isArray(rawWorkspace)) {
        continue;
      }
      const raw = rawWorkspace as JsonObject;
      const workspace: WorkspacePersistModelConfig = {};
      if (isWorkspacePersistModelScope(raw.scope)) workspace.scope = raw.scope;
      if (typeof raw.provider === "string") workspace.provider = raw.provider;
      if (typeof raw.model === "string") workspace.model = raw.model;
      if (typeof raw.thinkingLevel === "string") workspace.thinkingLevel = raw.thinkingLevel;
      if (raw.priorProjectSettings !== null && typeof raw.priorProjectSettings === "object" && !Array.isArray(raw.priorProjectSettings)) {
        const pps = raw.priorProjectSettings as JsonObject;
        const prior: ProjectSettingsPrior = {};
        if (typeof pps.defaultProvider === "string") prior.defaultProvider = pps.defaultProvider;
        if (typeof pps.defaultModel === "string") prior.defaultModel = pps.defaultModel;
        if (typeof pps.defaultThinkingLevel === "string") prior.defaultThinkingLevel = pps.defaultThinkingLevel;
        workspace.priorProjectSettings = prior;
      }
      if (Object.keys(workspace).length > 0) workspaces[workspaceId] = workspace;
    }
    if (Object.keys(workspaces).length > 0) {
      out.workspaces = workspaces;
    }
  }

  if (obj.piDefaults !== null && typeof obj.piDefaults === "object" && !Array.isArray(obj.piDefaults)) {
    const raw = obj.piDefaults as JsonObject;
    const piDefaults: PiDefaults = {};
    if (typeof raw.defaultProvider === "string") piDefaults.defaultProvider = raw.defaultProvider;
    if (typeof raw.defaultModel === "string") piDefaults.defaultModel = raw.defaultModel;
    if (typeof raw.defaultThinkingLevel === "string") piDefaults.defaultThinkingLevel = raw.defaultThinkingLevel;
    if (Object.keys(piDefaults).length > 0) out.piDefaults = piDefaults;
  }

  return out;
}

export function resolveConfig(layer?: PersistModelConfig): ResolvedPersistModelConfig {
  const resolved: ResolvedPersistModelConfig = {
    defaultScope: DEFAULT_CONFIG.defaultScope,
    include: { ...DEFAULT_CONFIG.include },
    workspaces: { ...DEFAULT_CONFIG.workspaces },
  };

  if (!layer) return resolved;

  if (layer.defaultScope !== undefined) resolved.defaultScope = layer.defaultScope;
  if (layer.include) {
    if (layer.include.model !== undefined) resolved.include.model = layer.include.model;
    if (layer.include.thinkingLevel !== undefined) resolved.include.thinkingLevel = layer.include.thinkingLevel;
  }
  if (layer.workspaces) resolved.workspaces = { ...layer.workspaces };
  if (layer.piDefaults) resolved.piDefaults = { ...layer.piDefaults };

  return resolved;
}

export function resolveEffectiveScope(config: ResolvedPersistModelConfig, workspaceId: string): PersistModelScope {
  const workspaceScope = config.workspaces[workspaceId]?.scope;
  return workspaceScope && workspaceScope !== "inherit" ? workspaceScope : config.defaultScope;
}

export type LoadedConfig = {
  exists: boolean;
  config: PersistModelConfig;
  error?: string;
};

export async function loadConfigFile(path: string): Promise<LoadedConfig> {
  try {
    const raw = await readJsonObject(path);
    if (raw === null) return { exists: false, config: {} };
    return { exists: true, config: parseConfig(raw) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exists: true, config: {}, error: message };
  }
}

export async function updateConfigFile(path: string, patch: PersistModelConfig, deleteWorkspaces?: string[]): Promise<void> {
  let existing: JsonObject = {};
  try {
    existing = (await readJsonObject(path)) ?? {};
  } catch {
    existing = {};
  }

  const next: JsonObject = { ...existing };

  if (patch.defaultScope !== undefined) {
    next.defaultScope = patch.defaultScope;
  }

  if (patch.include !== undefined) {
    const prior =
      existing.include !== null && typeof existing.include === "object" && !Array.isArray(existing.include)
        ? (existing.include as JsonObject)
        : {};
    next.include = { ...prior, ...patch.include };
  }

  if (patch.piDefaults !== undefined) {
    if (Object.keys(patch.piDefaults).length === 0) {
      delete next.piDefaults;
    } else {
      const priorPi =
        next.piDefaults !== null && typeof next.piDefaults === "object" && !Array.isArray(next.piDefaults)
          ? (next.piDefaults as JsonObject)
          : {};
      next.piDefaults = { ...priorPi, ...patch.piDefaults } as JsonObject;
    }
  }

  if (patch.workspaces !== undefined || (deleteWorkspaces !== undefined && deleteWorkspaces.length > 0)) {
    const prior =
      existing.workspaces !== null && typeof existing.workspaces === "object" && !Array.isArray(existing.workspaces)
        ? (existing.workspaces as JsonObject)
        : {};
    const workspaces: JsonObject = { ...prior };

    // Delete entries explicitly (the merge below can only add/update, not remove)
    if (deleteWorkspaces) {
      for (const wsId of deleteWorkspaces) {
        delete workspaces[wsId];
      }
    }

    if (patch.workspaces) {
      for (const [workspaceId, workspacePatch] of Object.entries(patch.workspaces)) {
        const existingWorkspace =
          workspaces[workspaceId] !== null && typeof workspaces[workspaceId] === "object" && !Array.isArray(workspaces[workspaceId])
            ? (workspaces[workspaceId] as JsonObject)
            : {};
        workspaces[workspaceId] = { ...existingWorkspace, ...workspacePatch };
      }
    }

    // Remove workspaces key if empty (no entries after delete + merge)
    if (Object.keys(workspaces).length === 0) {
      delete next.workspaces;
    } else {
      next.workspaces = workspaces;
    }
  }

  await writeJsonAtomic(path, next);
}
