import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  loadConfigFile,
  nextScope,
  nextWorkspaceScope,
  type PersistModelScope,
  type WorkspacePersistModelScope,
  type WorkspacePersistModelConfig,
  type ResolvedPersistModelConfig,
  type ProjectSettingsPrior,
  type PiDefaults,
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
  applyDefaults,
  readJsonObject,
  restoreDefaults,
  snapshotDefaults,
  writeJsonAtomic,
} from "./settings-file.ts";

const execFileAsync = promisify(execFile);

const MODEL_KEYS: readonly DefaultsKey[] = ["defaultProvider", "defaultModel"];
const THINKING_KEYS: readonly DefaultsKey[] = ["defaultThinkingLevel"];
const ALL_KEYS: readonly DefaultsKey[] = [...MODEL_KEYS, ...THINKING_KEYS];
const PROJECT_CONFIG_DIR = ".pi";

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

export type PiDefaultState = {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
};

export type PersistenceState = {
  workspaceId: string;
  effectiveScope: PersistModelScope;
  workspaceScope: WorkspacePersistModelScope;
  defaultScope: PersistModelScope;
  piDefault: PiDefaultState;
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
    // Snapshot from piDefaults (canonical store) to avoid poisoning from
    // global-settings leaks. On first run, capture from global settings and
    // persist as piDefaults.
    await this.captureFromPiDefaultsOrSeed();
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
      piDefault: this.getPiDefaultState(),
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
          const updates: Partial<Record<DefaultsKey, string>> = {
            defaultProvider: event.model.provider,
            defaultModel: event.model.id,
          };
          await this.capturePriorProjectSettingsIfMissing();
          await this.writeProjectDefaults(updates);
          await this.writeWorkspaceDefaults(updates);
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
          const updates: Partial<Record<DefaultsKey, string>> = {
            defaultThinkingLevel: event.level,
          };
          await this.capturePriorProjectSettingsIfMissing();
          await this.writeProjectDefaults(updates);
          await this.writeWorkspaceDefaults(updates);
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
      const newEffective = workspaceScope === "inherit" ? defaultScope : workspaceScope;
      const oldEffective = resolveEffectiveScope(this.config, this.workspaceId);
      const scopeChangedFromWorkspace = oldEffective === "workspace" && newEffective !== "workspace";

      if (workspaceScope === "inherit" || workspaceScope === defaultScope) {
        // Delete workspace entry via explicit deleteWorkspaces — the merge
        // in updateConfigFile cannot remove entries, only add/update.
        await this.updateConfig(patch, [this.workspaceId]);
      } else {
        patch.workspaces = { [this.workspaceId]: { scope: workspaceScope } };
        await this.updateConfig(patch);
      }
      await this.loadConfig();

      // If leaving workspace scope, restore prior project settings before applyScope re-snapshots
      if (scopeChangedFromWorkspace) {
        await this.restorePriorProjectSettings();
      }

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

  async savePiDefault(active: ActiveState): Promise<PersistenceState> {
    await this.queue.enqueue(async () => {
      const updates = activeToUpdates(active, { model: true, thinkingLevel: true });
      if (Object.keys(updates).length === 0) return;

      // Write to global settings AND config.piDefaults so the canonical
      // store stays in sync with the user's intended defaults.
      await withFileLock(this.paths.globalSettingsPath, async () => {
        const current = await readJsonObject(this.paths.globalSettingsPath);
        await writeJsonAtomic(this.paths.globalSettingsPath, applyDefaults(current ?? {}, updates));
      });

      // Persist to config.piDefaults (canonical store that survives leaks)
      const piDefaults: PiDefaults = {};
      if (updates.defaultProvider) piDefaults.defaultProvider = updates.defaultProvider;
      if (updates.defaultModel) piDefaults.defaultModel = updates.defaultModel;
      if (updates.defaultThinkingLevel) piDefaults.defaultThinkingLevel = updates.defaultThinkingLevel;
      await this.updateConfig({ piDefaults });
      await this.loadConfig();

      await this.recapture();
    });
    return this.getPersistenceState();
  }

  /** Restore global settings to canonical piDefaults on session end. */
  async shutdown(): Promise<void> {
    // Wait for any in-flight work to settle before restoring
    await this.queue.onIdle();
    await this.restoreGlobalDefaults(ALL_KEYS);
  }

  private getPiDefaultState(): PiDefaultState {
    return {
      provider: this.snapshot.defaultProvider.present ? this.snapshot.defaultProvider.value : undefined,
      model: this.snapshot.defaultModel.present ? this.snapshot.defaultModel.value : undefined,
      thinkingLevel: this.snapshot.defaultThinkingLevel.present ? this.snapshot.defaultThinkingLevel.value : undefined,
    };
  }

  private async loadConfig(): Promise<void> {
    const loaded = await loadConfigFile(this.paths.configPath);
    this.config = resolveConfig(loaded.config);
    if (loaded.error) {
      this.fail(`persist-model: ignoring bad config — ${loaded.error}`);
    }
  }

  private async updateConfig(patch: Parameters<typeof updateConfigFile>[1], deleteWorkspaces?: string[]): Promise<void> {
    await mkdir(dirname(this.paths.configPath), { recursive: true });
    await withFileLock(this.paths.configPath, () => updateConfigFile(this.paths.configPath, patch, deleteWorkspaces));
  }

  private projectSettingsPath(): string {
    return join(this.cwd, PROJECT_CONFIG_DIR, "settings.json");
  }

  /**
   * Snapshot from config.piDefaults (canonical store) if present.
   * On first run (no piDefaults yet), seed piDefaults from current
   * global settings so the snapshot doesn't capture prior leaks.
   */
  private async captureFromPiDefaultsOrSeed(): Promise<void> {
    try {
      if (this.config.piDefaults) {
        // Use canonical defaults as snapshot — immune to global-settings leaks
        const obj: JsonObject = {};
        const pd = this.config.piDefaults;
        if (pd.defaultProvider) obj.defaultProvider = pd.defaultProvider;
        if (pd.defaultModel) obj.defaultModel = pd.defaultModel;
        if (pd.defaultThinkingLevel) obj.defaultThinkingLevel = pd.defaultThinkingLevel;
        this.snapshot = snapshotDefaults(obj);
        this.clearFailure();
        return;
      }

      // First run: snapshot from global settings, then persist as piDefaults.
      // This seeds the canonical store with the user's current setup.
      const settings = await readJsonObject(this.paths.globalSettingsPath);
      this.snapshot = snapshotDefaults(settings);

      const piDefaults: PiDefaults = {};
      if (this.snapshot.defaultProvider.present) piDefaults.defaultProvider = this.snapshot.defaultProvider.value;
      if (this.snapshot.defaultModel.present) piDefaults.defaultModel = this.snapshot.defaultModel.value;
      if (this.snapshot.defaultThinkingLevel.present) piDefaults.defaultThinkingLevel = this.snapshot.defaultThinkingLevel.value;

      if (Object.keys(piDefaults).length > 0) {
        await this.updateConfig({ piDefaults });
        await this.loadConfig();
      }
      this.clearFailure();
    } catch (error) {
      // Fallback: snapshot from global settings without seeding piDefaults
      try {
        const settings = await readJsonObject(this.paths.globalSettingsPath);
        this.snapshot = snapshotDefaults(settings);
        this.clearFailure();
      } catch (inner) {
        this.snapshot = snapshotDefaults(null);
        this.fail(`persist-model: cannot read settings — ${describeError(inner)}`);
      }
    }
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
      await this.restorePriorProjectSettings();
      return;
    }

    if (scope === "workspace") {
      await this.capturePriorProjectSettingsIfMissing();
      await this.writeProjectDefaults(updates);
      await this.writeWorkspaceDefaults(updates);
    } else {
      await this.restorePriorProjectSettings();
    }

    await this.restoreGlobalDefaults(keys);
  }

  /**
   * If the workspace has no priorProjectSettings yet, snapshot current
   * project .pi/settings.json values so they can be restored later.
   */
  private async capturePriorProjectSettingsIfMissing(): Promise<void> {
    const ws = this.config.workspaces[this.workspaceId];
    if (ws?.priorProjectSettings !== undefined) return;

    const path = this.projectSettingsPath();
    const current = await readJsonObject(path);
    const prior: ProjectSettingsPrior = {};
    if (current) {
      if (typeof current.defaultProvider === "string") prior.defaultProvider = current.defaultProvider;
      if (typeof current.defaultModel === "string") prior.defaultModel = current.defaultModel;
      if (typeof current.defaultThinkingLevel === "string") prior.defaultThinkingLevel = current.defaultThinkingLevel;
    }
    await this.updateConfig({
      workspaces: { [this.workspaceId]: { priorProjectSettings: prior } },
    });
    await this.loadConfig();
  }

  /**
   * Restore project .pi/settings.json to the values saved in
   * priorProjectSettings, then delete priorProjectSettings from config.
   */
  private async restorePriorProjectSettings(): Promise<void> {
    const ws = this.config.workspaces[this.workspaceId];
    const prior = ws?.priorProjectSettings;
    if (!prior) return;

    const path = this.projectSettingsPath();
    const snapshot = snapshotDefaults(null);
    if (prior.defaultProvider !== undefined) snapshot.defaultProvider = { present: true, value: prior.defaultProvider };
    if (prior.defaultModel !== undefined) snapshot.defaultModel = { present: true, value: prior.defaultModel };
    if (prior.defaultThinkingLevel !== undefined) snapshot.defaultThinkingLevel = { present: true, value: prior.defaultThinkingLevel };

    await withFileLock(path, async () => {
      const current = await readJsonObject(path);
      if (current === null) return;
      const restored = restoreDefaults(current, snapshot, ALL_KEYS);
      await writeJsonAtomic(path, restored);
    });

    // Remove priorProjectSettings from config by patching with undefined
    // (JSON.stringify drops undefined keys, effectively deleting them).
    await this.updateConfig({
      workspaces: { [this.workspaceId]: { priorProjectSettings: undefined } as unknown as WorkspacePersistModelConfig },
    });
    await this.loadConfig();
  }

  /**
   * Write model/thinking keys to project .pi/settings.json so Pi picks
   * them up on next startup (project settings override global).
   */
  private async writeProjectDefaults(updates: Partial<Record<DefaultsKey, string>>): Promise<void> {
    if (Object.keys(updates).length === 0) return;
    const path = this.projectSettingsPath();
    await withFileLock(path, async () => {
      const current = await readJsonObject(path);
      await writeJsonAtomic(path, applyDefaults(current ?? {}, updates));
    });
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
