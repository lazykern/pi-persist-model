import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  loadConfigFile,
  parseConfig,
  resolveConfig,
  resolveEffectiveScope,
  updateConfigFile,
} from "../src/config.ts";
import { readJsonObject, writeJsonAtomic } from "../src/settings-file.ts";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pm-cfg-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("parseConfig", () => {
  it("keeps recognised, well-typed fields", () => {
    expect(
      parseConfig({
        defaultScope: "workspace",
        include: { model: false, thinkingLevel: true },
        workspaces: {
          "/repo": { scope: "user" },
        },
      }),
    ).toEqual({
      defaultScope: "workspace",
      include: { model: false, thinkingLevel: true },
      workspaces: {
        "/repo": { scope: "user" },
      },
    });
  });

  it("drops unknown or malformed fields", () => {
    expect(
      parseConfig({
        defaultScope: "bogus",
        include: { model: "no" },
        workspaces: { "/repo": { scope: "nope" }, bad: null },
        extra: "ignored",
      }),
    ).toEqual({});
  });

  it("returns empty config for non-objects", () => {
    expect(parseConfig(null)).toEqual({});
    expect(parseConfig("nope")).toEqual({});
    expect(parseConfig([1, 2])).toEqual({});
  });
});

describe("resolveConfig", () => {
  it("returns documented defaults", () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("merges include and workspaces", () => {
    const resolved = resolveConfig({
      include: { thinkingLevel: false },
      workspaces: { "/repo": { scope: "workspace" } },
    });
    expect(resolved.include).toEqual({ model: true, thinkingLevel: false });
    expect(resolved.workspaces["/repo"]).toEqual({ scope: "workspace" });
  });
});

describe("resolveEffectiveScope", () => {
  it("resolves workspace-specific scope", () => {
    const cfg = resolveConfig({ defaultScope: "session", workspaces: { "/repo": { scope: "workspace" } } });
    expect(resolveEffectiveScope(cfg, "/repo")).toBe("workspace");
  });

  it("falls back to defaultScope", () => {
    const cfg = resolveConfig({ defaultScope: "user" });
    expect(resolveEffectiveScope(cfg, "/repo")).toBe("user");
  });

  it("falls back to built-in session", () => {
    const cfg = resolveConfig({});
    expect(resolveEffectiveScope(cfg, "/repo")).toBe("session");
  });
});

describe("loadConfigFile", () => {
  it("loads config from config.json", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    await writeJsonAtomic(path, { defaultScope: "workspace" });
    const loaded = await loadConfigFile(path);
    expect(loaded.exists).toBe(true);
    expect(loaded.config).toEqual({ defaultScope: "workspace" });
  });

  it("reports missing file", async () => {
    const dir = await tempDir();
    const loaded = await loadConfigFile(join(dir, "missing.json"));
    expect(loaded.exists).toBe(false);
    expect(loaded.config).toEqual({});
  });
});

describe("updateConfigFile", () => {
  it("changes workspace scope", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    await updateConfigFile(path, { workspaces: { "/repo": { scope: "workspace" } } });
    expect(await readJsonObject(path)).toEqual({ workspaces: { "/repo": { scope: "workspace" } } });
  });

  it("changes default scope", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    await updateConfigFile(path, { defaultScope: "user" });
    expect(await readJsonObject(path)).toEqual({ defaultScope: "user" });
  });

  it("preserves unrelated JSON keys", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    await writeJsonAtomic(path, { unrelated: 1, include: { model: false } });
    await updateConfigFile(path, { defaultScope: "workspace", include: { thinkingLevel: false } });
    expect(await readJsonObject(path)).toEqual({
      unrelated: 1,
      include: { model: false, thinkingLevel: false },
      defaultScope: "workspace",
    });
  });
});
