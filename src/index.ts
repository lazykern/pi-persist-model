/**
 * pi-model-persistence — "Model Persistence" extension for the Pi Coding Agent.
 *
 * Pi writes `defaultProvider` / `defaultModel` / `defaultThinkingLevel` into
 * `~/.pi/agent/settings.json` whenever you change the model or thinking level.
 * That silently rewrites the *global* defaults used by every future session.
 *
 * This extension lets the active session change freely while keeping global
 * defaults stable — unless you explicitly opt in. See README.md for details.
 *
 * `index.ts` holds the orchestration: the {@link ModelPersistence} engine (the
 * testable event/command logic) plus the default Pi extension factory that
 * wires the engine to real Pi events. The pure/IO building blocks live in
 * `config.ts`, `paths.ts`, `settings-file.ts`, and `lock.ts`.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_CONFIG,
  isNotifyLevel,
  isPersistenceMode,
  loadConfigFile,
  type ModelPersistenceConfig,
  type ResolvedConfig,
  resolveConfig,
  updateConfigFile,
} from "./config.ts";
import { type ExtensionPaths, resolvePaths } from "./paths.ts";
import {
  applyDefaults,
  type DefaultsKey,
  type DefaultsSnapshot,
  type JsonObject,
  pathExists,
  readJsonObject,
  restoreDefaults,
  snapshotDefaults,
  writeJsonAtomic,
} from "./settings-file.ts";
import { SerialQueue, withFileLock } from "./lock.ts";

/** Pi's reasoning-effort levels. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** The subset of Pi's `model_select` event the engine needs. */
export type ModelSelectInput = {
  model: { provider: string; id: string };
  source: "set" | "cycle" | "restore";
};

/** The subset of Pi's `thinking_level_select` event the engine needs. */
export type ThinkingSelectInput = {
  level: string;
};

/** The session's live provider/model/thinking level, used by the save commands. */
export type ActiveState = {
  provider: string | undefined;
  model: string | undefined;
  thinkingLevel: string | undefined;
};

/** Notification sink — `ctx.ui.notify` in production, a spy in tests. */
export type Notifier = (message: string, level: "info" | "warning" | "error") => void;

/** Confirmation prompt — `ctx.ui.confirm` in production. Absent in print/RPC mode. */
export type Confirm = (title: string, message: string) => Promise<boolean>;

/** Everything the engine needs from its host. */
export type EngineDeps = {
  /** Home directory used to locate `~/.pi/agent`. */
  home: string;
  /** Pi's working directory (`ctx.cwd`). */
  cwd: string;
  /** Notification sink. */
  notify: Notifier;
  /** Optional footer status sink (`ctx.ui.setStatus`). */
  setStatus?: (id: string, text: string) => void;
  /** Optional confirmation prompt. When absent, irreversible commands proceed unprompted. */
  confirm?: Confirm;
};

const STATUS_ID = "model-persistence";
const LOG_PREFIX = "model-persistence:";

const MODEL_KEYS: readonly DefaultsKey[] = ["defaultProvider", "defaultModel"];
const THINKING_KEYS: readonly DefaultsKey[] = ["defaultThinkingLevel"];

/** Canonical config keys settable via `/model-persistence set`, by lowercased alias. */
type SettableKey = "mode" | "notify" | "restoreOnModelRestore" | "include.model" | "include.thinkingLevel";
const SETTABLE_KEYS: Record<string, SettableKey> = {
  mode: "mode",
  notify: "notify",
  restoreonmodelrestore: "restoreOnModelRestore",
  "include.model": "include.model",
  "include.thinkinglevel": "include.thinkingLevel",
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeToUpdates(active: ActiveState): Partial<Record<DefaultsKey, string>> {
  const updates: Partial<Record<DefaultsKey, string>> = {};
  if (active.provider) {
    updates.defaultProvider = active.provider;
  }
  if (active.model) {
    updates.defaultModel = active.model;
  }
  if (active.thinkingLevel) {
    updates.defaultThinkingLevel = active.thinkingLevel;
  }
  return updates;
}

function describeUpdates(updates: Partial<Record<DefaultsKey, string>>): string {
  const parts: string[] = [];
  if (updates.defaultProvider !== undefined || updates.defaultModel !== undefined) {
    parts.push(`model ${updates.defaultProvider ?? "?"}/${updates.defaultModel ?? "?"}`);
  }
  if (updates.defaultThinkingLevel !== undefined) {
    parts.push(`thinking ${updates.defaultThinkingLevel}`);
  }
  return parts.length > 0 ? parts.join(", ") : "(nothing)";
}

/** Parse a strict boolean token. Returns `undefined` for anything else. */
function parseBool(raw: string): boolean | undefined {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return undefined;
}

/**
 * Build a config patch for one `set` key/value pair. Returns a string when the
 * value is invalid (the string is the human-readable reason).
 */
function parseSetPatch(key: SettableKey, raw: string): Partial<ModelPersistenceConfig> | string {
  switch (key) {
    case "mode":
      return isPersistenceMode(raw)
        ? { mode: raw }
        : `invalid value "${raw}" for mode — use session, workspace, or global`;
    case "notify":
      return isNotifyLevel(raw)
        ? { notify: raw }
        : `invalid value "${raw}" for notify — use off, errors, or changes`;
    case "restoreOnModelRestore": {
      const value = parseBool(raw);
      return value === undefined
        ? `invalid value "${raw}" for restoreOnModelRestore — use true or false`
        : { restoreOnModelRestore: value };
    }
    case "include.model": {
      const value = parseBool(raw);
      return value === undefined
        ? `invalid value "${raw}" for include.model — use true or false`
        : { include: { model: value } };
    }
    case "include.thinkingLevel": {
      const value = parseBool(raw);
      return value === undefined
        ? `invalid value "${raw}" for include.thinkingLevel — use true or false`
        : { include: { thinkingLevel: value } };
    }
  }
}

/** True when `existing` already holds every field that `patch` would write. */
function patchAlreadyApplied(
  existing: Partial<ModelPersistenceConfig>,
  patch: Partial<ModelPersistenceConfig>,
): boolean {
  if (patch.mode !== undefined && existing.mode !== patch.mode) {
    return false;
  }
  if (patch.notify !== undefined && existing.notify !== patch.notify) {
    return false;
  }
  if (
    patch.restoreOnModelRestore !== undefined &&
    existing.restoreOnModelRestore !== patch.restoreOnModelRestore
  ) {
    return false;
  }
  if (patch.include) {
    if (patch.include.model !== undefined && existing.include?.model !== patch.include.model) {
      return false;
    }
    if (
      patch.include.thinkingLevel !== undefined &&
      existing.include?.thinkingLevel !== patch.include.thinkingLevel
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The event/command engine. Pure of any direct Pi dependency so it can be
 * driven by tests with a mocked context and temp-directory paths.
 */
export class ModelPersistence {
  private readonly paths: ExtensionPaths;
  private readonly notify: Notifier;
  private readonly setStatus: ((id: string, text: string) => void) | undefined;
  private readonly confirm: Confirm | undefined;
  private readonly queue = new SerialQueue();

  private config: ResolvedConfig = resolveConfig();
  private snapshot: DefaultsSnapshot = snapshotDefaults(null);
  private workspaceConfigExists = false;
  private globalConfigExists = false;
  /** Message of the last failed settings operation; `undefined` when healthy. */
  private lastError: string | undefined = undefined;

  constructor(deps: EngineDeps) {
    this.paths = resolvePaths({ home: deps.home, cwd: deps.cwd });
    this.notify = deps.notify;
    this.setStatus = deps.setStatus;
    this.confirm = deps.confirm;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Load configuration and snapshot Pi's current global defaults. Call once
   * per `session_start`.
   */
  async init(): Promise<void> {
    await this.loadConfig();
    await this.recapture();
    this.updateStatus();
  }

  /** Load (or reload) both config layers and resolve them. */
  private async loadConfig(): Promise<void> {
    const [globalCfg, workspaceCfg] = await Promise.all([
      loadConfigFile(this.paths.globalConfigPath),
      loadConfigFile(this.paths.workspaceConfigPath),
    ]);
    this.globalConfigExists = globalCfg.exists;
    this.workspaceConfigExists = workspaceCfg.exists;
    this.config = resolveConfig(globalCfg.config, workspaceCfg.config);

    for (const error of [globalCfg.error, workspaceCfg.error]) {
      if (error) {
        // A bad config file is reported but does not flag the footer: the
        // extension falls back to defaults, nothing on disk is at risk.
        this.reportError(`${LOG_PREFIX} ignoring bad config — ${error}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  /** Handle a Pi `model_select` event. */
  onModelSelect(event: ModelSelectInput): Promise<void> {
    if (event.source === "restore" && !this.config.restoreOnModelRestore) {
      return Promise.resolve();
    }
    if (this.config.mode === "global" || !this.config.include.model) {
      return Promise.resolve();
    }

    const provider = event.model.provider;
    const model = event.model.id;

    return this.queue.enqueue(async () => {
      try {
        if (this.config.mode === "workspace") {
          await this.writeWorkspaceDefaults({
            defaultProvider: provider,
            defaultModel: model,
          });
          this.reportChange(
            `${LOG_PREFIX} saved model ${provider}/${model} to workspace; global default kept`,
          );
        } else {
          this.reportChange(
            `${LOG_PREFIX} model ${provider}/${model} kept session-only; global default kept`,
          );
        }
        await this.restoreGlobalDefaults(MODEL_KEYS);
        this.clearFailure();
      } catch (error) {
        this.fail(`${LOG_PREFIX} failed to keep global model default — ${describeError(error)}`);
      }
    });
  }

  /** Handle a Pi `thinking_level_select` event. */
  onThinkingLevelSelect(event: ThinkingSelectInput): Promise<void> {
    if (this.config.mode === "global" || !this.config.include.thinkingLevel) {
      return Promise.resolve();
    }

    const level = event.level;

    return this.queue.enqueue(async () => {
      try {
        if (this.config.mode === "workspace") {
          await this.writeWorkspaceDefaults({ defaultThinkingLevel: level });
          this.reportChange(
            `${LOG_PREFIX} saved thinking level ${level} to workspace; global default kept`,
          );
        } else {
          this.reportChange(
            `${LOG_PREFIX} thinking level ${level} kept session-only; global default kept`,
          );
        }
        await this.restoreGlobalDefaults(THINKING_KEYS);
        this.clearFailure();
      } catch (error) {
        this.fail(
          `${LOG_PREFIX} failed to keep global thinking default — ${describeError(error)}`,
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Dispatch a `/model-persistence` subcommand. */
  async runCommand(args: string, active: ActiveState): Promise<void> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const sub = (tokens[0] ?? "status").toLowerCase();

    switch (sub) {
      case "status":
        this.notify(this.statusText(), "info");
        return;
      case "help":
        this.notify(this.helpText(), "info");
        return;
      case "mode":
        // `mode <m>` is shorthand for `set mode <m>`.
        await this.commandSet(["mode", ...tokens.slice(1)]);
        return;
      case "set":
        await this.commandSet(tokens.slice(1));
        return;
      case "init":
        await this.commandInit(tokens[1]);
        return;
      case "capture":
        await this.commandCapture();
        return;
      case "save-global":
        await this.commandSaveGlobal(active);
        return;
      case "save-workspace":
        await this.commandSaveWorkspace(active);
        return;
      default:
        this.notify(
          `${LOG_PREFIX} unknown subcommand "${sub}". ${this.helpText()}`,
          "error",
        );
    }
  }

  /** Render the human-readable status block. */
  statusText(): string {
    const field = (key: DefaultsKey): string => {
      const snap = this.snapshot[key];
      return snap.present ? snap.value : "(absent)";
    };
    return [
      "Model Persistence — status",
      `  mode:                          ${this.config.mode}`,
      `  include.model:                 ${this.config.include.model}`,
      `  include.thinkingLevel:         ${this.config.include.thinkingLevel}`,
      `  restoreOnModelRestore:         ${this.config.restoreOnModelRestore}`,
      `  notify:                        ${this.config.notify}`,
      `  captured defaultProvider:      ${field("defaultProvider")}`,
      `  captured defaultModel:         ${field("defaultModel")}`,
      `  captured defaultThinkingLevel: ${field("defaultThinkingLevel")}`,
      `  global settings path:          ${this.paths.globalSettingsPath}`,
      `  workspace settings path:       ${this.paths.workspaceSettingsPath}`,
      `  global config present:         ${this.globalConfigExists}`,
      `  workspace config present:      ${this.workspaceConfigExists}`,
      `  last error:                    ${this.lastError ?? "(none)"}`,
    ].join("\n");
  }

  /** Render the command reference. */
  helpText(): string {
    return [
      "Model Persistence — commands",
      "  status                                       show current state",
      "  help                                         show this help",
      "  mode <session|workspace|global> [--global|--workspace]",
      "  set <key> <value> [--global|--workspace]",
      "       keys: mode, notify, restoreOnModelRestore, include.model, include.thinkingLevel",
      "  init [global|workspace]                      create a config file with defaults",
      "  capture                                      re-snapshot global defaults",
      "  save-global                                  write the session model to global defaults",
      "  save-workspace                               write the session model to the workspace",
    ].join("\n");
  }

  /** Read-only copy of the resolved config (for tests / status). */
  getConfig(): ResolvedConfig {
    return resolveConfig(this.config);
  }

  /** Read-only copy of the captured defaults snapshot (for tests). */
  getSnapshot(): DefaultsSnapshot {
    return snapshotDefaults(this.snapshotAsObject());
  }

  /** Message of the last failed settings operation, or `undefined` when healthy. */
  getLastError(): string | undefined {
    return this.lastError;
  }

  /** Resolves once all queued settings writes have settled. */
  settled(): Promise<void> {
    return this.queue.onIdle();
  }

  /**
   * Apply a `set` (or `mode`) command. `tokens` is the argument list after the
   * subcommand: `<key> <value>` plus an optional `--global` / `--workspace`
   * target flag.
   */
  private async commandSet(tokens: string[]): Promise<void> {
    let target: "global" | "workspace" | undefined;
    const rest: string[] = [];
    for (const token of tokens) {
      if (token === "--global") {
        target = "global";
      } else if (token === "--workspace") {
        target = "workspace";
      } else {
        rest.push(token);
      }
    }

    const rawKey = rest[0];
    const rawValue = rest[1];
    if (!rawKey) {
      this.notify(
        `${LOG_PREFIX} usage: set <key> <value> [--global|--workspace] — ` +
          "keys: mode, notify, restoreOnModelRestore, include.model, include.thinkingLevel",
        "error",
      );
      return;
    }
    const key = SETTABLE_KEYS[rawKey.toLowerCase()];
    if (!key) {
      this.notify(
        `${LOG_PREFIX} unknown key "${rawKey}" — ` +
          "keys: mode, notify, restoreOnModelRestore, include.model, include.thinkingLevel",
        "error",
      );
      return;
    }
    if (rawValue === undefined) {
      this.notify(`${LOG_PREFIX} missing value for "${key}"`, "error");
      return;
    }

    const patch = parseSetPatch(key, rawValue);
    if (typeof patch === "string") {
      this.notify(`${LOG_PREFIX} ${patch}`, "error");
      return;
    }

    const path = await this.resolveConfigTarget(target);

    const existing = await loadConfigFile(path);
    if (existing.exists && patchAlreadyApplied(existing.config, patch)) {
      this.notify(`${LOG_PREFIX} ${key} already "${rawValue}" in ${path} — no change`, "info");
      return;
    }

    await this.queue.enqueue(async () => {
      await mkdir(dirname(path), { recursive: true });
      await withFileLock(path, () => updateConfigFile(path, patch));
    });
    await this.loadConfig();
    this.updateStatus();
    this.notify(`${LOG_PREFIX} ${key} set to "${rawValue}" (${path})`, "info");
  }

  /** Create a config file pre-filled with the documented defaults. */
  private async commandInit(rawTarget: string | undefined): Promise<void> {
    let target: "global" | "workspace";
    if (rawTarget === "global" || rawTarget === "workspace") {
      target = rawTarget;
    } else if (rawTarget === undefined) {
      target = (await pathExists(this.paths.workspacePiDir)) ? "workspace" : "global";
    } else {
      this.notify(
        `${LOG_PREFIX} invalid init target "${rawTarget}" — use global or workspace`,
        "error",
      );
      return;
    }

    const path =
      target === "global" ? this.paths.globalConfigPath : this.paths.workspaceConfigPath;
    if (await pathExists(path)) {
      this.notify(
        `${LOG_PREFIX} config already exists at ${path} — edit it or use /model-persistence set`,
        "warning",
      );
      return;
    }

    await this.queue.enqueue(async () => {
      await mkdir(dirname(path), { recursive: true });
      await withFileLock(path, () =>
        updateConfigFile(path, {
          mode: DEFAULT_CONFIG.mode,
          notify: DEFAULT_CONFIG.notify,
          restoreOnModelRestore: DEFAULT_CONFIG.restoreOnModelRestore,
          include: { ...DEFAULT_CONFIG.include },
        }),
      );
    });
    await this.loadConfig();
    this.updateStatus();
    this.notify(`${LOG_PREFIX} created ${path}\n${this.statusText()}`, "info");
  }

  private async commandCapture(): Promise<void> {
    await this.queue.enqueue(() => this.recapture());
    this.updateStatus();
    this.notify(`${LOG_PREFIX} re-captured global defaults\n${this.statusText()}`, "info");
  }

  private async commandSaveGlobal(active: ActiveState): Promise<void> {
    const updates = activeToUpdates(active);
    if (Object.keys(updates).length === 0) {
      this.notify(`${LOG_PREFIX} no active model/thinking level to save`, "warning");
      return;
    }
    if (this.confirm) {
      const ok = await this.confirm(
        "Overwrite global model defaults?",
        `This writes ${describeUpdates(updates)} into ${this.paths.globalSettingsPath} — ` +
          "the defaults every future Pi session starts with.",
      );
      if (!ok) {
        this.notify(`${LOG_PREFIX} save-global cancelled`, "info");
        return;
      }
    }
    await this.queue.enqueue(async () => {
      await withFileLock(this.paths.globalSettingsPath, async () => {
        const current = (await readJsonObject(this.paths.globalSettingsPath)) ?? {};
        const next = applyDefaults(current, updates);
        await writeJsonAtomic(this.paths.globalSettingsPath, next);
        // The baseline now matches what we deliberately wrote.
        this.snapshot = snapshotDefaults(next);
      });
    });
    this.updateStatus();
    this.notify(`${LOG_PREFIX} saved global defaults — ${describeUpdates(updates)}`, "info");
  }

  private async commandSaveWorkspace(active: ActiveState): Promise<void> {
    const updates = activeToUpdates(active);
    if (Object.keys(updates).length === 0) {
      this.notify(`${LOG_PREFIX} no active model/thinking level to save`, "warning");
      return;
    }
    await this.queue.enqueue(() => this.writeWorkspaceDefaults(updates));
    this.notify(
      `${LOG_PREFIX} saved workspace defaults — ${describeUpdates(updates)} ` +
        `(${this.paths.workspaceSettingsPath})`,
      "info",
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Choose which config file a `set` writes to. An explicit `--global` /
   * `--workspace` flag wins; otherwise the workspace config is used when this
   * worktree already has a `.pi/` directory, else the global config.
   */
  private async resolveConfigTarget(
    explicit: "global" | "workspace" | undefined,
  ): Promise<string> {
    if (explicit === "global") {
      return this.paths.globalConfigPath;
    }
    if (explicit === "workspace") {
      return this.paths.workspaceConfigPath;
    }
    const useWorkspace = await pathExists(this.paths.workspacePiDir);
    return useWorkspace ? this.paths.workspaceConfigPath : this.paths.globalConfigPath;
  }

  /** Re-snapshot Pi's global defaults from `~/.pi/agent/settings.json`. */
  private async recapture(): Promise<void> {
    try {
      const settings = await readJsonObject(this.paths.globalSettingsPath);
      this.snapshot = snapshotDefaults(settings);
      this.clearFailure();
    } catch (error) {
      // A corrupt global settings file cannot be snapshotted; the write paths
      // also re-read it and abort, so nothing is overwritten.
      this.snapshot = snapshotDefaults(null);
      this.fail(`${LOG_PREFIX} cannot read global settings — ${describeError(error)}`);
    }
  }

  /** Reset the given keys in the global settings file back to the snapshot. */
  private async restoreGlobalDefaults(keys: readonly DefaultsKey[]): Promise<void> {
    await withFileLock(this.paths.globalSettingsPath, async () => {
      const current = await readJsonObject(this.paths.globalSettingsPath);
      const restored = restoreDefaults(current ?? {}, this.snapshot, keys);
      if (current === null && Object.keys(restored).length === 0) {
        // Nothing was persisted and nothing needs restoring: do not create an
        // empty settings file.
        return;
      }
      await writeJsonAtomic(this.paths.globalSettingsPath, restored);
    });
  }

  /** Write the given managed keys into `<cwd>/.pi/settings.json`. */
  private async writeWorkspaceDefaults(
    updates: Partial<Record<DefaultsKey, string>>,
  ): Promise<void> {
    await mkdir(this.paths.workspacePiDir, { recursive: true });
    await withFileLock(this.paths.workspaceSettingsPath, async () => {
      const current = (await readJsonObject(this.paths.workspaceSettingsPath)) ?? {};
      const next = applyDefaults(current, updates);
      await writeJsonAtomic(this.paths.workspaceSettingsPath, next);
    });
  }

  private snapshotAsObject(): JsonObject {
    const obj: JsonObject = {};
    for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const) {
      const field = this.snapshot[key];
      if (field.present) {
        obj[key] = field.value;
      }
    }
    return obj;
  }

  private updateStatus(): void {
    const base = `persist:${this.config.mode}`;
    this.setStatus?.(STATUS_ID, this.lastError ? `${base} ⚠` : base);
  }

  /** Notify an error, gated by the configured `notify` level. */
  private reportError(message: string): void {
    if (this.config.notify !== "off") {
      this.notify(message, "error");
    }
  }

  /**
   * Record a failed settings operation: report it, remember it, and flag the
   * footer. Used for failures that may have left Pi's write in place.
   */
  private fail(message: string): void {
    this.lastError = message;
    this.reportError(message);
    this.updateStatus();
  }

  /** Clear a previously recorded failure after a successful operation. */
  private clearFailure(): void {
    if (this.lastError !== undefined) {
      this.lastError = undefined;
      this.updateStatus();
    }
  }

  private reportChange(message: string): void {
    if (this.config.notify === "changes") {
      this.notify(message, "info");
    }
  }
}

/** Subcommand / argument completions for `/model-persistence`. */
function completeArguments(prefix: string): Array<{ value: string; label: string }> | null {
  const tokens = prefix.trimStart().split(/\s+/);
  const subcommands = [
    "status",
    "help",
    "mode",
    "set",
    "init",
    "capture",
    "save-global",
    "save-workspace",
  ];

  const complete = (
    names: readonly string[],
    token: string,
    valuePrefix = "",
  ): Array<{ value: string; label: string }> | null => {
    const matches = names.filter((name) => name.startsWith(token));
    return matches.length > 0
      ? matches.map((name) => ({ value: `${valuePrefix}${name}`, label: name }))
      : null;
  };

  if (tokens.length <= 1) {
    return complete(subcommands, tokens[0] ?? "");
  }

  const sub = tokens[0];
  if (sub === "mode" && tokens.length === 2) {
    return complete(["session", "workspace", "global"], tokens[1] ?? "", "mode ");
  }
  if (sub === "init" && tokens.length === 2) {
    return complete(["global", "workspace"], tokens[1] ?? "", "init ");
  }
  if (sub === "set" && tokens.length === 2) {
    const keys = ["mode", "notify", "restoreOnModelRestore", "include.model", "include.thinkingLevel"];
    return complete(keys, tokens[1] ?? "", "set ");
  }
  if (sub === "set" && tokens.length === 3) {
    const valuesByKey: Record<string, readonly string[]> = {
      mode: ["session", "workspace", "global"],
      notify: ["off", "errors", "changes"],
      restoreonmodelrestore: ["true", "false"],
      "include.model": ["true", "false"],
      "include.thinkinglevel": ["true", "false"],
    };
    const values = valuesByKey[(tokens[1] ?? "").toLowerCase()];
    return values ? complete(values, tokens[2] ?? "", `set ${tokens[1]} `) : null;
  }
  return null;
}

/**
 * Default Pi extension factory.
 *
 * A fresh {@link ModelPersistence} engine is built on every `session_start`
 * (covering `/new`, `/resume`, `/fork`, and `/reload`) so configuration and
 * the defaults snapshot always reflect the current session.
 */
export default function modelPersistenceExtension(pi: ExtensionAPI): void {
  let engine: ModelPersistence | undefined;

  pi.on("session_start", async (_event, ctx) => {
    engine = new ModelPersistence({
      home: homedir(),
      cwd: ctx.cwd,
      notify: (message, level) => ctx.ui.notify(message, level),
      setStatus: (id, text) => ctx.ui.setStatus(id, text),
      confirm: ctx.hasUI ? (title, message) => ctx.ui.confirm(title, message) : undefined,
    });
    await engine.init();
  });

  pi.on("model_select", async (event) => {
    await engine?.onModelSelect({
      model: { provider: event.model.provider, id: event.model.id },
      source: event.source,
    });
  });

  pi.on("thinking_level_select", async (event) => {
    await engine?.onThinkingLevelSelect({ level: event.level });
  });

  pi.registerCommand("model-persistence", {
    description: "Control whether model / thinking-level changes persist (session/workspace/global)",
    getArgumentCompletions: (prefix) => completeArguments(prefix),
    handler: async (args, ctx) => {
      if (!engine) {
        ctx.ui.notify(`${LOG_PREFIX} not initialised yet`, "warning");
        return;
      }
      const active: ActiveState = {
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        thinkingLevel: pi.getThinkingLevel(),
      };
      await engine.runCommand(args, active);
    },
  });
}
