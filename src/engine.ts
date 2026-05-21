import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import {
  loadConfigFile,
  nextScope,
  nextWorkspaceScope,
  type PersistModelScope,
  type WorkspacePersistModelScope,
  type ResolvedPersistModelConfig,
  resolveConfig,
  resolveEffectiveScope,
  updateConfigFile,
} from "./config.ts";
import { SerialQueue, withFileLock } from "./lock.ts";
import { type ExtensionPaths, resolvePaths } from "./paths.ts";
import {
  type DefaultsKey,
  type DefaultsSnapshot,
  type JsonObject,
  readJsonObject,
  restoreDefaults,
  snapshotDefaults,
  writeJsonAtomic,
} from "./settings-file.ts";

const execFileAsync = promisify(execFile);

const MODEL_KEYS: readonly DefaultsKey[] = ["defaultProvider", "defaultModel"];
const THINKING_KEYS: readonly DefaultsKey[] = ["defaultThinkingLevel"];

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ActiveState = {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
};

export type ModelSelectInput = {
  model: { provider: string; id: string };
  source?: "set" | "cycle" | "restore";
};

export type ThinkingSelectInput = {
  level: string;
};

export type Notifier = (message: string, level: "info" | "warning" | "error") => void;

export type EngineDeps = {
  agentDir?: string;
  home?: string;
  cwd: string;
  notify: Notifier;
  resolveWorkspaceId?: (cwd: string) => Promise<string>;
};

export type PersistenceState = {
  workspaceId: string;
  effectiveScope: PersistModelScope;
  workspaceScope: WorkspacePersistModelScope;
  defaultScope: PersistModelScope;
  include: { model: boolean; thinkingLevel: boolean };
  configPath: string;
  globalSettingsPath: string;
  lastError?: string;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeToUpdates(
  active: ActiveState,
  include: { model: boolean; thinkingLevel: boolean },
): Partial<Record<DefaultsKey, string>> {
  const updates: Partial<Record<DefaultsKey, string>> = {};
  if (include.model) {
    if (active.provider) updates.defaultProvider = active.provider;
    if (active.model) updates.defaultModel = active.model;
  }
  if (include.thinkingLevel && active.thinkingLevel) {
    updates.defaultThinkingLevel = active.thinkingLevel;
  }
  return updates;
}

export async function resolveWorkspaceIdFromGit(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    const root = stdout.trim();
    return root || cwd;
  } catch {
    return cwd;
  }
}

export class PersistModelEngine {
  private readonly paths: ExtensionPaths;
  private readonly cwd: string;
  private readonly notify: Notifier;
  private readonly resolveWorkspaceIdFn: (cwd: string) => Promise<string>;
  private readonly queue = new SerialQueue();

  private config: ResolvedPersistModelConfig = resolveConfig();
  private snapshot: DefaultsSnapshot = snapshotDefaults(null);
  private workspaceId: string;
  private lastError: string | undefined;

  constructor(deps: EngineDeps) {
    this.paths = resolvePaths({ agentDir: deps.agentDir, home: deps.home });
    this.cwd = deps.cwd;
    this.workspaceId = deps.cwd;
    this.notify = deps.notify;
    this.resolveWorkspaceIdFn = deps.resolveWorkspaceId ?? resolveWorkspaceIdFromGit;
  }

  async init(): Promise<void> {
    this.workspaceId = await this.resolveWorkspaceIdFn(this.cwd);
    await this.loadConfig();
    await this.recapture();
  }

  getPaths(): ExtensionPaths {
    return this.paths;
  }

  getConfig(): ResolvedPersistModelConfig {
    return resolveConfig(this.config);
  }

  getSnapshot(): DefaultsSnapshot {
    const obj: JsonObject = {};
    for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const) {
      const field = this.snapshot[key];
      if (field.present) obj[key] = field.value;
    }
    return snapshotDefaults(obj);
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  getPersistenceState(): PersistenceState {
    const workspaceScope = this.config.workspaces[this.workspaceId]?.scope ?? "inherit";
    return {
      workspaceId: this.workspaceId,
      effectiveScope: resolveEffectiveScope(this.config, this.workspaceId),
      workspaceScope,
      defaultScope: this.config.defaultScope,
      include: { ...this.config.include },
      configPath: this.paths.configPath,
      globalSettingsPath: this.paths.globalSettingsPath,
      lastError: this.lastError,
    };
  }

  settled(): Promise<void> {
    return this.queue.onIdle();
  }

  async onModelSelect(event: ModelSelectInput): Promise<void> {
    if (!this.config.include.model) return;
    const scope = resolveEffectiveScope(this.config, this.workspaceId);
    if (scope === "user") return;

    await this.queue.enqueue(async () => {
      try {
        if (scope === "workspace") {
          await this.writeWorkspaceDefaults({
            defaultProvider: event.model.provider,
            defaultModel: event.model.id,
          });
        }
        await this.restoreGlobalDefaults(MODEL_KEYS);
        this.clearFailure();
      } catch (error) {
        this.fail(`persist-model: failed to repair model defaults — ${describeError(error)}`);
      }
    });
  }

  async onThinkingLevelSelect(event: ThinkingSelectInput): Promise<void> {
    if (!this.config.include.thinkingLevel) return;
    const scope = resolveEffectiveScope(this.config, this.workspaceId);
    if (scope === "user") return;

    await this.queue.enqueue(async () => {
      try {
        if (scope === "workspace") {
          await this.writeWorkspaceDefaults({ defaultThinkingLevel: event.level });
        }
        await this.restoreGlobalDefaults(THINKING_KEYS);
        this.clearFailure();
      } catch (error) {
        this.fail(`persist-model: failed to repair thinking defaults — ${describeError(error)}`);
      }
    });
  }

  async cycleWorkspaceScope(active: ActiveState): Promise<PersistenceState> {
    const current = this.config.workspaces[this.workspaceId]?.scope ?? "inherit";
    const scope = nextWorkspaceScope(current);
    await this.setWorkspaceScope(scope, active);
    return this.getPersistenceState();
  }

  async cycleDefaultScope(): Promise<PersistenceState> {
    const scope = nextScope(this.config.defaultScope);
    await this.setDefaultScope(scope);
    return this.getPersistenceState();
  }

  async setWorkspaceScope(scope: WorkspacePersistModelScope, active: ActiveState): Promise<void> {
    await this.queue.enqueue(async () => {
      await this.updateConfig({ workspaces: { [this.workspaceId]: { scope } } });
      await this.loadConfig();
      await this.applyScope(resolveEffectiveScope(this.config, this.workspaceId), active);
    });
  }

  async setDefaultScope(scope: PersistModelScope): Promise<void> {
    await this.queue.enqueue(async () => {
      await this.updateConfig({ defaultScope: scope });
      await this.loadConfig();
    });
  }

  async configureScopes(
    workspaceScope: WorkspacePersistModelScope,
    defaultScope: PersistModelScope,
    active: ActiveState,
  ): Promise<PersistenceState> {
    await this.queue.enqueue(async () => {
      const patch: Parameters<typeof updateConfigFile>[1] = { defaultScope };
      if (workspaceScope === "inherit" || workspaceScope === defaultScope) {
        const existing = await readJsonObject(this.paths.configPath);
        if (existing !== null && typeof existing.workspaces === "object" && !Array.isArray(existing.workspaces)) {
          const workspaces = { ...existing.workspaces } as JsonObject;
          delete workspaces[this.workspaceId];
          patch.workspaces = workspaces;
        }
      } else {
        patch.workspaces = { [this.workspaceId]: { scope: workspaceScope } };
      }
      await this.updateConfig(patch);
      await this.loadConfig();
      await this.applyScope(resolveEffectiveScope(this.config, this.workspaceId), active);
    });
    return this.getPersistenceState();
  }

  async applyCurrent(active: ActiveState): Promise<void> {
    const scope = resolveEffectiveScope(this.config, this.workspaceId);
    await this.queue.enqueue(async () => {
      await this.applyScope(scope, active);
    });
  }

  async applyModelSelection(model: { provider: string; id: string }): Promise<void> {
    await this.onModelSelect({ model });
  }

  async applyThinkingSelection(level: string): Promise<void> {
    await this.onThinkingLevelSelect({ level });
  }

  private async loadConfig(): Promise<void> {
    const loaded = await loadConfigFile(this.paths.configPath);
    this.config = resolveConfig(loaded.config);
    if (loaded.error) {
      this.fail(`persist-model: ignoring bad config — ${loaded.error}`);
    }
  }

  private async updateConfig(patch: Parameters<typeof updateConfigFile>[1]): Promise<void> {
    await mkdir(dirname(this.paths.configPath), { recursive: true });
    await withFileLock(this.paths.configPath, () => updateConfigFile(this.paths.configPath, patch));
  }

  private async recapture(): Promise<void> {
    try {
      const settings = await readJsonObject(this.paths.globalSettingsPath);
      this.snapshot = snapshotDefaults(settings);
      this.clearFailure();
    } catch (error) {
      this.snapshot = snapshotDefaults(null);
      this.fail(`persist-model: cannot read global settings — ${describeError(error)}`);
    }
  }

  private async applyScope(scope: PersistModelScope, active: ActiveState): Promise<void> {
    const updates = activeToUpdates(active, this.config.include);
    const keys = Object.keys(updates) as DefaultsKey[];

    if (scope === "user") {
      return;
    }

    if (scope === "workspace") {
      await this.writeWorkspaceDefaults(updates);
    }

    await this.restoreGlobalDefaults(keys);
  }


  private async writeWorkspaceDefaults(updates: Partial<Record<DefaultsKey, string>>): Promise<void> {
    if (Object.keys(updates).length === 0) return;
    const workspacePatch = Object.fromEntries(
      Object.entries({
        provider: updates.defaultProvider,
        model: updates.defaultModel,
        thinkingLevel: updates.defaultThinkingLevel,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    await this.updateConfig({ workspaces: { [this.workspaceId]: workspacePatch } });
    await this.loadConfig();
  }

  private async restoreGlobalDefaults(keys: readonly DefaultsKey[]): Promise<void> {
    if (keys.length === 0) return;
    await withFileLock(this.paths.globalSettingsPath, async () => {
      const current = await readJsonObject(this.paths.globalSettingsPath);
      const restored = restoreDefaults(current ?? {}, this.snapshot, keys);
      if (current === null && Object.keys(restored).length === 0) return;
      await writeJsonAtomic(this.paths.globalSettingsPath, restored);
    });
  }

  private fail(message: string): void {
    this.lastError = message;
    this.notify(message, "error");
  }

  private clearFailure(): void {
    this.lastError = undefined;
  }
}
