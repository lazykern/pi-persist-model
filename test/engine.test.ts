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

type Env = {
  home: string;
  cwd: string;
  globalSettings: string;
  configPath: string;
  notes: Note[];
};

const tempRoots: string[] = [];

async function createEnv(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "mp-engine-"));
  tempRoots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(join(home, ".pi", "model-persistence"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  return {
    home,
    cwd,
    globalSettings: join(home, ".pi", "agent", "settings.json"),
    configPath: join(home, ".pi", "model-persistence", "config.json"),
    notes: [],
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
    confirm: opts.confirm,
  });
}

async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
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
    await writeJsonAtomic(env.globalSettings, { theme: "dark" });

    const engine = newEngine(env);
    await engine.init();

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

    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultThinkingLevel: "high",
      theme: "dark",
    });

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
// global mode
// ---------------------------------------------------------------------------

describe("global mode", () => {
  it("leaves settings untouched", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.configPath, { mode: "global" });
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
  });
});

// ---------------------------------------------------------------------------
// include flags
// ---------------------------------------------------------------------------

describe("include flags", () => {
  it("skips model handling when include.model is false", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.configPath, { include: { model: false } });
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
    await engine.onModelSelect(modelEvent("openai", "gpt-5"));

    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
  });

  it("skips thinking handling when include.thinkingLevel is false", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.configPath, { include: { thinkingLevel: false } });
    await writeJsonAtomic(env.globalSettings, {
      defaultThinkingLevel: "medium",
    });

    const engine = newEngine(env);
    await engine.init();

    await writeJsonAtomic(env.globalSettings, {
      defaultThinkingLevel: "high",
    });
    await engine.onThinkingLevelSelect({ level: "high" });

    expect(await readJson(env.globalSettings)).toEqual({
      defaultThinkingLevel: "high",
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

    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
    await engine.onModelSelect(modelEvent("openai", "gpt-5", "restore"));

    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
  });

  it("honours restore events when restoreOnModelRestore is true", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.configPath, { restoreOnModelRestore: true });
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

  it("save writes global defaults and updates the captured baseline", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
      theme: "dark",
    });

    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("save", active);

    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultThinkingLevel: "high",
      theme: "dark",
    });

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

  it("pin saves current model to workspace pins", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();
    expect(engine.getWorkspacePin()).toBeUndefined();

    await engine.runCommand("pin", active);

    expect(engine.getWorkspacePin()).toEqual({
      provider: "openai",
      model: "gpt-5",
      thinkingLevel: "high",
    });

    const cfg = await readJson(env.configPath);
    expect(cfg.pins).toBeDefined();
    expect((cfg.pins as JsonObject)[env.cwd]).toEqual({
      provider: "openai",
      model: "gpt-5",
      thinkingLevel: "high",
    });
  });

  it("unpin removes the workspace pin", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("pin", active);
    expect(engine.getWorkspacePin()).toBeDefined();

    await engine.runCommand("unpin", active);
    expect(engine.getWorkspacePin()).toBeUndefined();
  });

  it("unpin is a no-op when no pin exists", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("unpin", active);

    expect(env.notes.at(-1)?.message).toContain("no workspace pin");
  });

  it("mode <session|global> sets the mode", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("mode global", active);

    expect(engine.getConfig().mode).toBe("global");
    expect(await readJson(env.configPath)).toEqual({ mode: "global" });
  });

  it("status reports mode, include flags, pin, and captured defaults", async () => {
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
    expect(message).toContain("pin");
    expect(message).toContain("save");
  });
});

// ---------------------------------------------------------------------------
// save confirmation
// ---------------------------------------------------------------------------

describe("save confirmation", () => {
  it("aborts the write when confirmation is declined", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });
    const engine = newEngine(env, { confirm: async () => false });
    await engine.init();

    await engine.runCommand("save", ACTIVE);

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

    await engine.runCommand("save", ACTIVE);

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
    expect(await readJson(env.configPath)).toEqual({ notify: "changes" });
  });

  it("parses boolean include flags", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("set include.model false", ACTIVE);

    expect(engine.getConfig().include.model).toBe(false);
    expect(await readJson(env.configPath)).toEqual({ include: { model: false } });
  });

  it("rejects an invalid value without writing", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("set notify loud", ACTIVE);

    expect(env.notes.at(-1)?.level).toBe("error");
    expect(await pathExists(env.configPath)).toBe(false);
  });

  it("skips a no-op write", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.configPath, { notify: "changes" });
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("set notify changes", ACTIVE);

    expect(env.notes.at(-1)?.message).toContain("no change");
  });

  it("rejects invalid mode values", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.runCommand("set mode workspace", ACTIVE);

    expect(env.notes.at(-1)?.level).toBe("error");
    expect(env.notes.at(-1)?.message).toContain("invalid value");
  });
});

// ---------------------------------------------------------------------------
// failure state
// ---------------------------------------------------------------------------

describe("failure state", () => {
  it("records a write failure", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
    });
    const engine = newEngine(env);
    await engine.init();

    await writeFile(env.globalSettings, "{ this is not json", "utf8");
    await engine.onModelSelect(modelEvent("openai", "gpt-5"));

    expect(engine.getLastError()).toBeDefined();
  });

  it("clears failure state after later success", async () => {
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

    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
    await engine.onModelSelect(modelEvent("openai", "gpt-5"));

    expect(engine.getLastError()).toBeUndefined();
  });
});
