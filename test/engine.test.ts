import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type ActiveState, PersistModelEngine } from "../src/engine.ts";
import { type JsonObject, pathExists, writeJsonAtomic } from "../src/settings-file.ts";

type Note = { message: string; level: "info" | "warning" | "error" };

type Env = {
  root: string;
  agentDir: string;
  cwd: string;
  workspaceId: string;
  globalSettings: string;
  workspaceSettings: string;
  configPath: string;
  notes: Note[];
};

const tempRoots: string[] = [];

async function createEnv(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "pm-engine-"));
  tempRoots.push(root);
  const agentDir = join(root, "home", ".pi", "agent");
  const cwd = join(root, "repo");
  const workspaceId = cwd;
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return {
    root,
    agentDir,
    cwd,
    workspaceId,
    globalSettings: join(agentDir, "settings.json"),
    workspaceSettings: join(workspaceId, ".pi", "settings.json"),
    configPath: join(root, "home", ".pi", "persist-model", "config.json"),
    notes: [],
  };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function newEngine(env: Env): PersistModelEngine {
  return new PersistModelEngine({
    agentDir: env.agentDir,
    cwd: env.cwd,
    notify: (message, level) => env.notes.push({ message, level }),
    resolveWorkspaceId: async () => env.workspaceId,
  });
}

async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

const ACTIVE: ActiveState = { provider: "openai", model: "gpt-5", thinkingLevel: "high" };

describe("init", () => {
  it("loads config from ~/.pi/persist-model/config.json", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.configPath, { defaultScope: "workspace" });
    const engine = newEngine(env);
    await engine.init();
    expect(engine.getConfig().defaultScope).toBe("workspace");
  });

  it("resolves workspace-specific scope", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.configPath, { workspaces: { [env.workspaceId]: { scope: "workspace" } } });
    const engine = newEngine(env);
    await engine.init();
    expect(engine.getPersistenceState().effectiveScope).toBe("workspace");
  });

  it("falls back to defaultScope", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.configPath, { defaultScope: "user" });
    const engine = newEngine(env);
    await engine.init();
    expect(engine.getPersistenceState().effectiveScope).toBe("user");
  });

  it("falls back to built-in session", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();
    expect(engine.getPersistenceState().effectiveScope).toBe("session");
  });
});

describe("session scope", () => {
  it("restores global provider/model after model select", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, { defaultProvider: "anthropic", defaultModel: "claude", theme: "dark" });
    const engine = newEngine(env);
    await engine.init();

    await writeJsonAtomic(env.globalSettings, { defaultProvider: "openai", defaultModel: "gpt-5", theme: "dark" });
    await engine.onModelSelect({ model: { provider: "openai", id: "gpt-5" } });

    expect(await readJson(env.globalSettings)).toEqual({ defaultProvider: "anthropic", defaultModel: "claude", theme: "dark" });
  });

  it("restores global thinking level after thinking change", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, { defaultThinkingLevel: "medium", theme: "dark" });
    const engine = newEngine(env);
    await engine.init();

    await writeJsonAtomic(env.globalSettings, { defaultThinkingLevel: "high", theme: "dark" });
    await engine.onThinkingLevelSelect({ level: "high" });

    expect(await readJson(env.globalSettings)).toEqual({ defaultThinkingLevel: "medium", theme: "dark" });
  });

  it("deletes fields missing from captured defaults", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, { theme: "dark" });
    const engine = newEngine(env);
    await engine.init();

    await writeJsonAtomic(env.globalSettings, { defaultProvider: "openai", defaultModel: "gpt-5", theme: "dark" });
    await engine.onModelSelect({ model: { provider: "openai", id: "gpt-5" } });

    expect(await readJson(env.globalSettings)).toEqual({ theme: "dark" });
  });

  it("does not create .pi directory in session scope", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, { defaultProvider: "anthropic", defaultModel: "claude" });
    const engine = newEngine(env);
    await engine.init();

    await writeJsonAtomic(env.globalSettings, { defaultProvider: "openai", defaultModel: "gpt-5" });
    await engine.onModelSelect({ model: { provider: "openai", id: "gpt-5" } });

    expect(await pathExists(join(env.cwd, ".pi"))).toBe(false);
  });

  it("back-to-back model and thinking events produce consistent final settings", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude",
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
    await Promise.all([
      engine.onModelSelect({ model: { provider: "openai", id: "gpt-5" } }),
      engine.onThinkingLevelSelect({ level: "high" }),
    ]);

    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude",
      defaultThinkingLevel: "medium",
      theme: "dark",
    });
  });
});

describe("workspace scope", () => {
  it("writes provider/model/thinking to ~/.pi/persist-model and restores global defaults", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.configPath, { workspaces: { [env.workspaceId]: { scope: "workspace" } } });
    await writeJsonAtomic(env.globalSettings, {
      defaultProvider: "anthropic",
      defaultModel: "claude",
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
    await engine.onModelSelect({ model: { provider: "openai", id: "gpt-5" } });
    await engine.onThinkingLevelSelect({ level: "high" });

    expect(await readJson(env.configPath)).toEqual({
      workspaces: {
        [env.workspaceId]: {
          scope: "workspace",
          provider: "openai",
          model: "gpt-5",
          thinkingLevel: "high",
        },
      },
    });
    expect(await pathExists(join(env.cwd, ".pi"))).toBe(false);
    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude",
      defaultThinkingLevel: "medium",
      theme: "dark",
    });
  });

  it("does not create .pi when workspace scope is applied", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, { defaultProvider: "anthropic", defaultModel: "claude" });
    const engine = newEngine(env);
    await engine.init();

    await engine.setWorkspaceScope("workspace", ACTIVE);

    expect(await pathExists(join(env.cwd, ".pi"))).toBe(false);
    expect(await readJson(env.configPath)).toEqual({
      workspaces: {
        [env.workspaceId]: { scope: "workspace", provider: "openai", model: "gpt-5", thinkingLevel: "high" },
      },
    });
  });
});

describe("user scope", () => {
  it("leaves global settings as Pi wrote them", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.configPath, { defaultScope: "user" });
    await writeJsonAtomic(env.globalSettings, { defaultProvider: "anthropic", defaultModel: "claude" });
    const engine = newEngine(env);
    await engine.init();

    await writeJsonAtomic(env.globalSettings, { defaultProvider: "openai", defaultModel: "gpt-5" });
    await engine.onModelSelect({ model: { provider: "openai", id: "gpt-5" } });

    expect(await readJson(env.globalSettings)).toEqual({ defaultProvider: "openai", defaultModel: "gpt-5" });
  });

  it("saves current model and thinking as Pi default", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.globalSettings, { defaultProvider: "anthropic", defaultModel: "claude", theme: "dark" });
    const engine = newEngine(env);
    await engine.init();

    const state = await engine.savePiDefault(ACTIVE);

    expect(state.piDefault).toEqual({ provider: "openai", model: "gpt-5", thinkingLevel: "high" });
    expect(await readJson(env.globalSettings)).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      defaultThinkingLevel: "high",
      theme: "dark",
    });
  });
});

describe("scope changes", () => {
  it("changing workspace scope updates workspaces[workspaceId].scope", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.cycleWorkspaceScope(ACTIVE);

    expect(await readJson(env.configPath)).toEqual({ workspaces: { [env.workspaceId]: { scope: "session" } } });
  });

  it("changing default scope updates defaultScope", async () => {
    const env = await createEnv();
    const engine = newEngine(env);
    await engine.init();

    await engine.cycleDefaultScope();

    expect(await readJson(env.configPath)).toEqual({ defaultScope: "workspace" });
  });

  it("preserves unrelated JSON keys", async () => {
    const env = await createEnv();
    await writeJsonAtomic(env.configPath, { custom: true });
    const engine = newEngine(env);
    await engine.init();

    await engine.cycleDefaultScope();

    expect(await readJson(env.configPath)).toEqual({ custom: true, defaultScope: "workspace" });
  });
});
