/**
 * pi-model-persistence — keeps model/thinking-level changes session-only.
 *
 * Pi writes `defaultProvider` / `defaultModel` / `defaultThinkingLevel` into
 * `~/.pi/agent/settings.json` on every model/thinking change.  That silently
 * overwrites the *global* defaults for every future session.
 *
 * This extension restores the original global values after Pi writes them,
 * so a throwaway "let me try gpt-5 for this one question" stays session-only.
 *
 * Config lives at `~/.pi/model-persistence/config.json`.  No `.pi/` folder
 * is ever created in the workspace — Pi's native `.pi/settings.json` handles
 * per-project overrides when the user wants them.
 *
 * ## Commands
 *
 *   /model-persistence               show status (default subcommand)
 *   /model-persistence help          command reference
 *   /model-persistence save          write current model to global defaults
 *   /model-persistence pin           pin current model to this workspace
 *   /model-persistence unpin         remove workspace pin
 *   /model-persistence set <k> <v>   edit a config field
 *   /model-persistence mode <m>      shorthand: set mode <m>
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isNotifyLevel,
  isPersistenceMode,
  loadConfigFile,
  type ModelPersistenceConfig,
  type Pin,
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
  readJsonObject,
  restoreDefaults,
  snapshotDefaults,
  writeJsonAtomic,
} from "./settings-file.ts";
import { SerialQueue, withFileLock } from "./lock.ts";

// ── Public types ───────────────────────────────────────────────────────────

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelSelectInput = {
  model: { provider: string; id: string };
  source: "set" | "cycle" | "restore";
};

export type ThinkingSelectInput = {
  level: string;
};

export type ActiveState = {
  provider: string | undefined;
  model: string | undefined;
  thinkingLevel: string | undefined;
};

export type Notifier = (message: string, level: "info" | "warning" | "error") => void;
export type Confirm = (title: string, message: string) => Promise<boolean>;

export type EngineDeps = {
  home: string;
  cwd: string;
  notify: Notifier;
  setStatus?: (id: string, text: string) => void;
  confirm?: Confirm;
};

// ── Constants ──────────────────────────────────────────────────────────────

const STATUS_ID = "model-persistence";
const LOG_PREFIX = "model-persistence:";

const MODEL_KEYS: readonly DefaultsKey[] = ["defaultProvider", "defaultModel"];
const THINKING_KEYS: readonly DefaultsKey[] = ["defaultThinkingLevel"];

type SettableKey = "mode" | "notify" | "restoreOnModelRestore" | "include.model" | "include.thinkingLevel";
const SETTABLE_KEYS: Record<string, SettableKey> = {
  mode: "mode",
  notify: "notify",
  restoreonmodelrestore: "restoreOnModelRestore",
  "include.model": "include.model",
  "include.thinkinglevel": "include.thinkingLevel",
};

// ── Helpers ────────────────────────────────────────────────────────────────

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeToUpdates(active: ActiveState): Partial<Record<DefaultsKey, string>> {
  const updates: Partial<Record<DefaultsKey, string>> = {};
  if (active.provider) updates.defaultProvider = active.provider;
  if (active.model) updates.defaultModel = active.model;
  if (active.thinkingLevel) updates.defaultThinkingLevel = active.thinkingLevel;
  return updates;
}

function describeUpdates(updates: Partial<Record<DefaultsKey, string>>): string {
  const parts: string[] = [];
  if (updates.defaultProvider || updates.defaultModel) {
    parts.push(`model ${updates.defaultProvider ?? "?"}/${updates.defaultModel ?? "?"}`);
  }
  if (updates.defaultThinkingLevel) {
    parts.push(`thinking ${updates.defaultThinkingLevel}`);
  }
  return parts.length > 0 ? parts.join(", ") : "(nothing)";
}

function parseBool(raw: string): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

function parseSetPatch(
  key: SettableKey,
  raw: string,
): Partial<ModelPersistenceConfig> | string {
  switch (key) {
    case "mode":
      return isPersistenceMode(raw)
        ? { mode: raw }
        : `invalid value "${raw}" for mode — use session or global`;
    case "notify":
      return isNotifyLevel(raw)
        ? { notify: raw }
        : `invalid value "${raw}" for notify — use off, errors, or changes`;
    case "restoreOnModelRestore": {
      const v = parseBool(raw);
      return v === undefined
        ? `invalid value "${raw}" for restoreOnModelRestore — use true or false`
        : { restoreOnModelRestore: v };
    }
    case "include.model": {
      const v = parseBool(raw);
      return v === undefined
        ? `invalid value "${raw}" for include.model — use true or false`
        : { include: { model: v } };
    }
    case "include.thinkingLevel": {
      const v = parseBool(raw);
      return v === undefined
        ? `invalid value "${raw}" for include.thinkingLevel — use true or false`
        : { include: { thinkingLevel: v } };
    }
  }
}

function patchAlreadyApplied(
  existing: Partial<ModelPersistenceConfig>,
  patch: Partial<ModelPersistenceConfig>,
): boolean {
  if (patch.mode !== undefined && existing.mode !== patch.mode) return false;
  if (patch.notify !== undefined && existing.notify !== patch.notify) return false;
  if (
    patch.restoreOnModelRestore !== undefined &&
    existing.restoreOnModelRestore !== patch.restoreOnModelRestore
  )
    return false;
  if (patch.include) {
    if (patch.include.model !== undefined && existing.include?.model !== patch.include.model)
      return false;
    if (
      patch.include.thinkingLevel !== undefined &&
      existing.include?.thinkingLevel !== patch.include.thinkingLevel
    )
      return false;
  }
  return true;
}

// ── Engine ─────────────────────────────────────────────────────────────────

export class ModelPersistence {
  private readonly paths: ExtensionPaths;
  private readonly cwd: string;
  private readonly notify: Notifier;
  private readonly setStatus: ((id: string, text: string) => void) | undefined;
  private readonly confirm: Confirm | undefined;
  private readonly queue = new SerialQueue();

  private config: ResolvedConfig = resolveConfig();
  private snapshot: DefaultsSnapshot = snapshotDefaults(null);
  private configExists = false;
  private lastError: string | undefined;
  /** Pin for this cwd (from config.pins), if any. */
  private workspacePin: Pin | undefined;

  constructor(deps: EngineDeps) {
    this.paths = resolvePaths({ home: deps.home });
    this.cwd = deps.cwd;
    this.notify = deps.notify;
    this.setStatus = deps.setStatus;
    this.confirm = deps.confirm;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.loadConfig();
    await this.recapture();
    this.updateStatus();
  }

  private async loadConfig(): Promise<void> {
    const loaded = await loadConfigFile(this.paths.configPath);
    this.configExists = loaded.exists;
    this.config = resolveConfig(loaded.config);

    if (loaded.error) {
      this.reportError(`${LOG_PREFIX} ignoring bad config — ${loaded.error}`);
    }

    // Resolve workspace pin
    this.workspacePin = this.config.pins[this.cwd];
  }

  // ── Event handlers ─────────────────────────────────────────────────────

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
        await this.restoreGlobalDefaults(MODEL_KEYS);
        this.reportChange(
          `${LOG_PREFIX} model ${provider}/${model} kept session-only; global default kept`,
        );
        this.clearFailure();
      } catch (error) {
        this.fail(`${LOG_PREFIX} failed to keep global model default — ${describeError(error)}`);
      }
    });
  }

  onThinkingLevelSelect(event: ThinkingSelectInput): Promise<void> {
    if (this.config.mode === "global" || !this.config.include.thinkingLevel) {
      return Promise.resolve();
    }

    const level = event.level;

    return this.queue.enqueue(async () => {
      try {
        await this.restoreGlobalDefaults(THINKING_KEYS);
        this.reportChange(
          `${LOG_PREFIX} thinking level ${level} kept session-only; global default kept`,
        );
        this.clearFailure();
      } catch (error) {
        this.fail(
          `${LOG_PREFIX} failed to keep global thinking default — ${describeError(error)}`,
        );
      }
    });
  }

  // ── Commands ───────────────────────────────────────────────────────────

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
        await this.commandSet(["mode", ...tokens.slice(1)]);
        return;
      case "set":
        await this.commandSet(tokens.slice(1));
        return;
      case "save":
        await this.commandSave(active);
        return;
      case "pin":
        await this.commandPin(active);
        return;
      case "unpin":
        await this.commandUnpin();
        return;
      default:
        this.notify(
          `${LOG_PREFIX} unknown subcommand "${sub}". ${this.helpText()}`,
          "error",
        );
    }
  }

  statusText(): string {
    const field = (key: DefaultsKey): string => {
      const snap = this.snapshot[key];
      return snap.present ? snap.value : "(absent)";
    };
    const pin = this.workspacePin;
    const pinLine = pin
      ? `  workspace pin:                  ${pin.provider}/${pin.model}` +
        (pin.thinkingLevel ? ` (thinking ${pin.thinkingLevel})` : "")
      : "  workspace pin:                  (none)";
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
      `  config path:                   ${this.paths.configPath}`,
      `  config present:                ${this.configExists}`,
      pinLine,
      `  last error:                    ${this.lastError ?? "(none)"}`,
    ].join("\n");
  }

  helpText(): string {
    return [
      "Model Persistence — commands",
      "  status                                       show current state (default)",
      "  help                                         show this help",
      "  mode <session|global>                        shorthand: set mode",
      "  set <key> <value>                            edit a config field",
      "       keys: mode, notify, restoreOnModelRestore, include.model, include.thinkingLevel",
      "  save                                         write current model to global defaults",
      "  pin                                          pin current model to this workspace",
      "  unpin                                        remove workspace pin",
    ].join("\n");
  }

  // Public queries for tests
  getConfig(): ResolvedConfig {
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
  getWorkspacePin(): Pin | undefined {
    return this.workspacePin;
  }
  settled(): Promise<void> {
    return this.queue.onIdle();
  }

  // ── Command implementations ────────────────────────────────────────────

  private async commandSet(tokens: string[]): Promise<void> {
    const rawKey = tokens[0];
    const rawValue = tokens[1];
    if (!rawKey) {
      this.notify(
        `${LOG_PREFIX} usage: set <key> <value> — ` +
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

    const path = this.paths.configPath;
    const existing = await loadConfigFile(path);
    if (existing.exists && patchAlreadyApplied(existing.config, patch)) {
      this.notify(`${LOG_PREFIX} ${key} already "${rawValue}" — no change`, "info");
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

  /** Write current model/thinking to global defaults (confirmed). */
  private async commandSave(active: ActiveState): Promise<void> {
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
        this.notify(`${LOG_PREFIX} save cancelled`, "info");
        return;
      }
    }
    await this.queue.enqueue(async () => {
      await withFileLock(this.paths.globalSettingsPath, async () => {
        const current = (await readJsonObject(this.paths.globalSettingsPath)) ?? {};
        const next = applyDefaults(current, updates);
        await writeJsonAtomic(this.paths.globalSettingsPath, next);
        this.snapshot = snapshotDefaults(next);
      });
    });
    this.updateStatus();
    this.notify(`${LOG_PREFIX} saved global defaults — ${describeUpdates(updates)}`, "info");
  }

  /** Pin current model/thinking to this workspace. */
  private async commandPin(active: ActiveState): Promise<void> {
    if (!active.provider || !active.model) {
      this.notify(`${LOG_PREFIX} no active model to pin`, "warning");
      return;
    }
    const pin: Pin = {
      provider: active.provider,
      model: active.model,
      thinkingLevel: active.thinkingLevel,
    };

    const path = this.paths.configPath;
    await this.queue.enqueue(async () => {
      // Re-read config to merge pin without losing concurrent changes
      const loaded = await loadConfigFile(path);
      const existing = resolveConfig(loaded.config);
      const pins = { ...existing.pins, [this.cwd]: pin };
      await mkdir(dirname(path), { recursive: true });
      await withFileLock(path, () => updateConfigFile(path, { pins }));
    });
    await this.loadConfig();
    this.updateStatus();
    this.notify(
      `${LOG_PREFIX} pinned ${pin.provider}/${pin.model} to this workspace ` +
        `(saved in ${path})`,
      "info",
    );
  }

  /** Remove the workspace pin for this cwd. */
  private async commandUnpin(): Promise<void> {
    if (!this.workspacePin) {
      this.notify(`${LOG_PREFIX} no workspace pin to remove`, "info");
      return;
    }
    const path = this.paths.configPath;
    await this.queue.enqueue(async () => {
      const loaded = await loadConfigFile(path);
      const existing = resolveConfig(loaded.config);
      const pins = { ...existing.pins };
      delete pins[this.cwd];
      await mkdir(dirname(path), { recursive: true });
      await withFileLock(path, () => updateConfigFile(path, { pins }));
    });
    await this.loadConfig();
    this.updateStatus();
    this.notify(`${LOG_PREFIX} removed workspace pin`, "info");
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async recapture(): Promise<void> {
    try {
      const settings = await readJsonObject(this.paths.globalSettingsPath);
      this.snapshot = snapshotDefaults(settings);
      this.clearFailure();
    } catch (error) {
      this.snapshot = snapshotDefaults(null);
      this.fail(`${LOG_PREFIX} cannot read global settings — ${describeError(error)}`);
    }
  }

  private async restoreGlobalDefaults(keys: readonly DefaultsKey[]): Promise<void> {
    await withFileLock(this.paths.globalSettingsPath, async () => {
      const current = await readJsonObject(this.paths.globalSettingsPath);
      const restored = restoreDefaults(current ?? {}, this.snapshot, keys);
      if (current === null && Object.keys(restored).length === 0) {
        return;
      }
      await writeJsonAtomic(this.paths.globalSettingsPath, restored);
    });
  }

  private updateStatus(): void {
    const base = `persist:${this.config.mode}`;
    this.setStatus?.(STATUS_ID, this.lastError ? `${base} ⚠` : base);
  }

  private reportError(message: string): void {
    if (this.config.notify !== "off") {
      this.notify(message, "error");
    }
  }

  private fail(message: string): void {
    this.lastError = message;
    this.reportError(message);
    this.updateStatus();
  }

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

// ── Completions ────────────────────────────────────────────────────────────

function completeArguments(
  prefix: string,
): Array<{ value: string; label: string }> | null {
  const tokens = prefix.trimStart().split(/\s+/);
  const subcommands = ["status", "help", "mode", "set", "save", "pin", "unpin"];

  const complete = (
    names: readonly string[],
    token: string,
    valuePrefix = "",
  ): Array<{ value: string; label: string }> | null => {
    const matches = names.filter((n) => n.startsWith(token));
    return matches.length > 0
      ? matches.map((n) => ({ value: `${valuePrefix}${n}`, label: n }))
      : null;
  };

  if (tokens.length <= 1) {
    return complete(subcommands, tokens[0] ?? "");
  }

  const sub = tokens[0];
  if (sub === "mode" && tokens.length === 2) {
    return complete(["session", "global"], tokens[1] ?? "", "mode ");
  }
  if (sub === "set" && tokens.length === 2) {
    const keys = [
      "mode",
      "notify",
      "restoreOnModelRestore",
      "include.model",
      "include.thinkingLevel",
    ];
    return complete(keys, tokens[1] ?? "", "set ");
  }
  if (sub === "set" && tokens.length === 3) {
    const valuesByKey: Record<string, readonly string[]> = {
      mode: ["session", "global"],
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

// ── Extension factory ──────────────────────────────────────────────────────

export default function modelPersistenceExtension(pi: ExtensionAPI): void {
  let engine: ModelPersistence | undefined;

  pi.on("session_start", async (_event, ctx) => {
    engine = new ModelPersistence({
      home: homedir(),
      cwd: ctx.cwd,
      notify: (message, level) => ctx.ui.notify(message, level),
      setStatus: (id, text) => ctx.ui.setStatus(id, text),
      confirm: ctx.hasUI
        ? (title, message) => ctx.ui.confirm(title, message)
        : undefined,
    });
    await engine.init();

    // If there's a workspace pin, gently remind the user
    if (engine.getWorkspacePin()) {
      const pin = engine.getWorkspacePin()!;
      ctx.ui.notify(
        `${LOG_PREFIX} workspace pin: ${pin.provider}/${pin.model}` +
          (pin.thinkingLevel ? ` (thinking ${pin.thinkingLevel})` : "") +
          " — switch to it manually or run /model-persistence unpin to remove",
        "info",
      );
    }
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
    description:
      "Control whether model / thinking-level changes leak to global defaults",
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
