import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type ActiveState, type Confirm, ModelPersistence } from "../src/index.ts";
import { type JsonObject, pathExists, writeJsonAtomic } from "../src/settings-file.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

type Note = { message: string; level: "info" | "warning" | "error" };
type Status = { id: string; text: string };

type Env = {
  home: string;
  cwd: string;
  globalSettings: string;
  globalConfig: string;
  workspaceSettings: string;
  workspaceConfig: string;
  notes: Note[];
  statuses: Status[];
};

const tempRoots: string[] = [];

async function createEnv(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "mp-engine-"));
  tempRoots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  return {
    home,
    cwd,
    globalSettings: join(home, ".pi", "agent", "settings.json"),
    globalConfig: join(home, ".pi", "agent", "model-persistence.json"),
    workspaceSettings: join(cwd, ".pi", "settings.json"),
    workspaceConfig: join(cwd, ".pi", "model-persistence.json"),
    notes: [],
    statuses: [],
  };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function newEngine(env: Env, opts: { confirm?: Confirm } = {}): ModelPersistence {
  return new ModelPersistence({
    home: env.home,
    cwd: env.cwd,
    notify: (message, level) => env.notes.push({ message, level }),
    setStatus: (id, text) => env.statuses.push({ id, text }),
    confirm: opts.confirm,
  });
}

async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

async function writeWorkspaceConfig(env: Env, config: JsonObject): Promise<void> {
  await mkdir(join(env.cwd, ".pi"), { recursive: true });
  await writeJsonAtomic(env.workspaceConfig, config);
}

function modelEvent(provider: string, id: string, source: "set" | "cycle" | "restore" = "set") {
  return { model: { provider, id }, source } as const;
}

const ACTIVE: ActiveState = { provider: "openai", model: "gpt-5", thinkingLevel: "high" };

// ---------------------------------------------------------------------------
// session mode
// ---------------------------------------------------------------------------

describe("session mode", () => {
  it("restores the global provider/model after a model_select event", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
      theme: "dark",
    });

    const engine = newEngine(env);
    await engine.init();

    // Pi persists the new model into the global settings file.
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      theme: "dark",
    });
    await engine.onModelSelect(modelEvent("openai", "gpt-5"));

    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
      theme: "dark",
    });
  });

  it("restores the global thinking level after a thinking_level_select event", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultThinkingLevel: "medium",
      theme: "dark",
    });

    const engine = newEngine(env);
    await engine.init();

    await writeJsonAtomic(env.globalSettings, {
      defaultThinkingLevel: "high",
      theme: "dark",
    });
    await engine.onThinkingLevelSelect({ level: "high" });

    expect(await readJson(env.globalSettings)).toEqual({
      defaultThinkingLevel: "medium",
      theme: "dark",
    });
  });

  it("preserves unrelated and nested settings keys", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultModel: "claude-x",
      theme: "dark",
      compaction: { enabled: true, reserveTokens: 16384 },
    });

    const engine = newEngine(env);
    await engine.init();

    await writeJsonAtomic(env.globalSettings, {
      defaultModel: "gpt-5",
      theme: "dark",
      compaction: { enabled: true, reserveTokens: 16384 },
    });
    await engine.onModelSelect(modelEvent("openai", "gpt-5"));

    expect(await readJson(env.globalSettings)).toEqual({
      defaultModel: "claude-x",
      theme: "dark",
      compaction: { enabled: true, reserveTokens: 16384 },
    });
  });

  it("deletes fields that were absent in the captured snapshot", async () => {
    const env = await createEnv();
    // No defaults at all when the snapshot is taken.
    await writeJsonAtomic(env.globalSettings, { theme: "dark" });

    const engine = newEngine(env);
    await engine.init();

    // Pi adds brand-new default keys.
    await writeJsonAtomic(env.globalSettings, {
      theme: "dark",
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
    await engine.onModelSelect(modelEvent("openai", "gpt-5"));

    expect(await readJson(env.globalSettings)).toEqual({ theme: "dark" });
  });

  it("produces consistent settings when model and thinking events arrive back-to-back", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
      defaultThinkingLevel: "medium",
      theme: "dark",
    });

    const engine = newEngine(env);
    await engine.init();

    // Pi clamps thinking level and changes model in one /model action.
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultThinkingLevel: "high",
      theme: "dark",
    });

    // Fire both without awaiting in between.
    const thinking = engine.onThinkingLevelSelect({ level: "high" });
    const model = engine.onModelSelect(modelEvent("openai", "gpt-5"));
    await Promise.all([thinking, model]);

    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
      defaultThinkingLevel: "medium",
      theme: "dark",
    });
  });
});

// ---------------------------------------------------------------------------
// workspace mode
// ---------------------------------------------------------------------------

describe("workspace mode", () => {
  it("writes provider/model/thinking into .pi/settings.json and restores global", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalConfig, { mode: "workspace" });
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
      defaultThinkingLevel: "medium",
    });

    const engine = newEngine(env);
    await engine.init();
    expect(engine.getConfig().mode).toBe("workspace");

    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultThinkingLevel: "high",
    });
    await engine.onModelSelect(modelEvent("openai", "gpt-5"));
    await engine.onThinkingLevelSelect({ level: "high" });

    expect(await readJson(env.workspaceSettings)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultThinkingLevel: "high",
    });
    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
      defaultThinkingLevel: "medium",
    });
  });
});

// ---------------------------------------------------------------------------
// global mode
// ---------------------------------------------------------------------------

describe("global mode", () => {
  it("leaves settings untouched and never creates a workspace settings file", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalConfig, { mode: "global" });
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });

    const engine = newEngine(env);
    await engine.init();

    await engine.onModelSelect(modelEvent("openai", "gpt-5"));
    await engine.onThinkingLevelSelect({ level: "high" });

    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
    expect(await pathExists(env.workspaceSettings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// config layering & include flags
// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("lets workspace config override global extension config", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalConfig, { mode: "session" });
    await writeWorkspaceConfig(env, { mode: "workspace" });

    const engine = newEngine(env);
    await engine.init();

    expect(engine.getConfig().mode).toBe("workspace");
  });

  it("skips model handling when include.model is false", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalConfig, { include: { model: false } });
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });

    const engine = newEngine(env);
    await engine.init();

    // Pi changes the model; with include.model=false the engine ignores it.
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
    await engine.onModelSelect(modelEvent("openai", "gpt-5"));

    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
  });
});

// ---------------------------------------------------------------------------
// restoreOnModelRestore
// ---------------------------------------------------------------------------

describe("restoreOnModelRestore", () => {
  it("ignores model_select events with source 'restore' by default", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });

    const engine = newEngine(env);
    await engine.init();
    expect(engine.getConfig().restoreOnModelRestore).toBe(false);

    // A session restore re-applies the saved model.
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
    await engine.onModelSelect(modelEvent("openai", "gpt-5", "restore"));

    // Untouched: the engine did not fight the session restore.
    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
  });

  it("honours restore events when restoreOnModelRestore is true", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalConfig, { restoreOnModelRestore: true });
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });

    const engine = newEngine(env);
    await engine.init();

    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
    await engine.onModelSelect(modelEvent("openai", "gpt-5", "restore"));

    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });
  });
});

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

describe("commands", () => {
  const active: ActiveState = {
    provider: "openai",
    model: "gpt-5",
    thinkingLevel: "high",
  };

  it("save-global writes global defaults and updates the captured baseline", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
      theme: "dark",
    });

    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("save-global", active);

    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultThinkingLevel: "high",
      theme: "dark",
    });

    // Baseline now matches the deliberate save.
    const snap = engine.getSnapshot();
    expect(snap.defaultProvider).toEqual({ present: true, value: "openai" });
    expect(snap.defaultModel).toEqual({ present: true, value: "gpt-5" });

    // A later session-mode model change restores to the NEW baseline.
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "google",
      defaultModel: "gemini-9",
      defaultThinkingLevel: "high",
      theme: "dark",
    });
    await engine.onModelSelect(modelEvent("google", "gemini-9"));
    const after = await readJson(env.globalSettings);
    expect(after.defaultProvider).toBe("openai");
    expect(after.defaultModel).toBe("gpt-5");
  });

  it("save-workspace writes workspace defaults into .pi/settings.json", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("save-workspace", active);

    expect(await readJson(env.workspaceSettings)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultThinkingLevel: "high",
    });
  });

  it("capture re-snapshots the current global defaults", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });

    const engine = newEngine(env);
    await engine.init();

    // Global defaults change outside the extension's restore path.
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
    await engine.runCommand("capture", active);

    const snap = engine.getSnapshot();
    expect(snap.defaultProvider).toEqual({ present: true, value: "openai" });
    expect(snap.defaultModel).toEqual({ present: true, value: "gpt-5" });
  });

  it("mode writes the workspace config when a .pi/ directory exists", async () => {
    const env = await createEnv();
    await mkdir(join(env.cwd, ".pi"), { recursive: true });

    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("mode workspace", active);

    expect(engine.getConfig().mode).toBe("workspace");
    expect(await readJson(env.workspaceConfig)).toEqual({ mode: "workspace" });
    expect(await pathExists(env.globalConfig)).toBe(false);
  });

  it("mode writes the global config when no .pi/ directory exists", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("mode global", active);

    expect(engine.getConfig().mode).toBe("global");
    expect(await readJson(env.globalConfig)).toEqual({ mode: "global" });
    expect(await pathExists(env.workspaceConfig)).toBe(false);
  });

  it("status reports mode, include flags and captured defaults", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, { defaultModel: "claude-x" });
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("status", active);

    const last = env.notes.at(-1);
    expect(last?.level).toBe("info");
    expect(last?.message).toContain("mode:");
    expect(last?.message).toContain("captured defaultModel:         claude-x");
  });

  it("help lists the available subcommands", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("help", ACTIVE);

    const message = env.notes.at(-1)?.message ?? "";
    expect(message).toContain("commands");
    expect(message).toContain("save-global");
  });
});

// ---------------------------------------------------------------------------
// save-global confirmation
// ---------------------------------------------------------------------------

describe("save-global confirmation", () => {
  it("aborts the write when confirmation is declined", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });
    const engine = newEngine(env, { confirm: async () => false });
    await engine.init();

    await engine.runCommand("save-global", ACTIVE);

    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });
    expect(env.notes.at(-1)?.message).toContain("cancelled");
  });

  it("proceeds with the write when confirmation is granted", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });
    let asked = false;
    const engine = newEngine(env, {
      confirm: async () => {
        asked = true;
        return true;
      },
    });
    await engine.init();

    await engine.runCommand("save-global", ACTIVE);

    expect(asked).toBe(true);
    expect(await readJson(env.globalSettings)).toMatchObject({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
  });
});

// ---------------------------------------------------------------------------
// set command
// ---------------------------------------------------------------------------

describe("set command", () => {
  it("writes a config field and reloads the resolved config", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("set notify changes", ACTIVE);

    expect(engine.getConfig().notify).toBe("changes");
    expect(await readJson(env.globalConfig)).toEqual({ notify: "changes" });
  });

  it("parses boolean include flags", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("set include.model false", ACTIVE);

    expect(engine.getConfig().include.model).toBe(false);
    expect(await readJson(env.globalConfig)).toEqual({ include: { model: false } });
  });

  it("honours an explicit --global target even when a .pi/ directory exists", async () => {
    const env = await createEnv();
    await mkdir(join(env.cwd, ".pi"), { recursive: true });
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("set mode workspace --global", ACTIVE);

    expect(await readJson(env.globalConfig)).toEqual({ mode: "workspace" });
    expect(await pathExists(env.workspaceConfig)).toBe(false);
  });

  it("rejects an invalid value without writing", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("set notify loud", ACTIVE);

    expect(env.notes.at(-1)?.level).toBe("error");
    expect(await pathExists(env.globalConfig)).toBe(false);
  });

  it("skips a no-op write", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalConfig, { notify: "changes" });
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("set notify changes", ACTIVE);

    expect(env.notes.at(-1)?.message).toContain("no change");
  });
});

// ---------------------------------------------------------------------------
// init command
// ---------------------------------------------------------------------------

describe("init command", () => {
  it("creates a config file pre-filled with the documented defaults", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("init global", ACTIVE);

    expect(await readJson(env.globalConfig)).toEqual({
      mode: "session",
      notify: "errors",
      restoreOnModelRestore: false,
      include: { model: true, thinkingLevel: true },
    });
  });

  it("refuses to overwrite an existing config file", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalConfig, { mode: "global" });
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("init global", ACTIVE);

    expect(env.notes.at(-1)?.level).toBe("warning");
    expect(await readJson(env.globalConfig)).toEqual({ mode: "global" });
  });
});

// ---------------------------------------------------------------------------
// failure visibility
// ---------------------------------------------------------------------------

describe("failure visibility", () => {
  it("flags a write failure in the footer status", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });
    const engine = newEngine(env);
    await engine.init();

    // Corrupt the global settings file so the restore read fails.
    await writeFile(env.globalSettings, "{ this is not json", "utf8");
    await engine.onModelSelect(modelEvent("openai", "gpt-5"));

    expect(engine.getLastError()).toBeDefined();
    expect(env.statuses.at(-1)?.text).toContain("⚠");
  });

  it("clears the footer warning after a later success", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });
    const engine = newEngine(env);
    await engine.init();

    await writeFile(env.globalSettings, "{ broken", "utf8");
    await engine.onModelSelect(modelEvent("openai", "gpt-5"));
    expect(engine.getLastError()).toBeDefined();

    // Repair the file; the next restore succeeds and clears the flag.
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
    await engine.onModelSelect(modelEvent("openai", "gpt-5"));

    expect(engine.getLastError()).toBeUndefined();
    expect(env.statuses.at(-1)?.text).toBe("persist:session");
  });
});
