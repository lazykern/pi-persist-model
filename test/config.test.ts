import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  loadConfigFile,
  parseConfig,
  resolveConfig,
  updateConfigFile,
} from "../src/config.ts";
import { readJsonObject, writeJsonAtomic } from "../src/settings-file.ts";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mp-cfg-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("parseConfig", () => {
  it("keeps recognised, well-typed fields", () => {
    expect(
      parseConfig({
        mode: "session",
        include: { model: false, thinkingLevel: true },
        restoreOnModelRestore: true,
        notify: "changes",
      }),
    ).toEqual({
      mode: "session",
      include: { model: false, thinkingLevel: true },
      restoreOnModelRestore: true,
      notify: "changes",
    });
  });

  it("drops unknown or malformed fields", () => {
    expect(
      parseConfig({
        mode: "bogus",
        notify: 7,
        restoreOnModelRestore: "yes",
        include: { model: "no" },
        extra: "ignored",
      }),
    ).toEqual({});
  });

  it("returns an empty layer for non-objects", () => {
    expect(parseConfig(null)).toEqual({});
    expect(parseConfig("nope")).toEqual({});
    expect(parseConfig([1, 2])).toEqual({});
  });

  it("keeps a partially-specified include block", () => {
    expect(parseConfig({ mode: "session", include: { thinkingLevel: false } })).toEqual({
      mode: "session",
      include: { thinkingLevel: false },
    });
  });

  it("parses pins keyed by absolute working-directory path", () => {
    const raw = {
      mode: "session",
      pins: {
        "/home/user/project-a": {
          provider: "openai",
          model: "gpt-5",
          thinkingLevel: "high",
        },
        "/home/user/project-b": {
          provider: "anthropic",
          model: "claude-x",
        },
      },
    };
    expect(parseConfig(raw)).toEqual({
      mode: "session",
      pins: {
        "/home/user/project-a": {
          provider: "openai",
          model: "gpt-5",
          thinkingLevel: "high",
        },
        "/home/user/project-b": {
          provider: "anthropic",
          model: "claude-x",
        },
      },
    });
  });

  it("drops malformed pin entries", () => {
    const raw = {
      pins: {
        good: { provider: "openai", model: "gpt-5" },
        bad: { provider: 7 },
        alsoBad: "nope",
      },
    };
    expect(parseConfig(raw)).toEqual({
      pins: {
        good: { provider: "openai", model: "gpt-5" },
      },
    });
  });
});

describe("resolveConfig", () => {
  it("returns the documented defaults when nothing is supplied", () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("returns the documented defaults when an empty layer is supplied", () => {
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("overrides defaults with supplied fields", () => {
    const resolved = resolveConfig({
      mode: "global",
      notify: "off",
      include: { model: false },
    });
    expect(resolved.mode).toBe("global");
    expect(resolved.notify).toBe("off");
    expect(resolved.include.model).toBe(false);
    expect(resolved.include.thinkingLevel).toBe(true);
  });

  it("preserves unset fields from defaults", () => {
    const resolved = resolveConfig({ mode: "global" });
    expect(resolved.include).toEqual(DEFAULT_CONFIG.include);
    expect(resolved.notify).toBe(DEFAULT_CONFIG.notify);
    expect(resolved.restoreOnModelRestore).toBe(DEFAULT_CONFIG.restoreOnModelRestore);
  });

  it("merges pins from layer", () => {
    const pins = {
      "/home/proj": { provider: "x", model: "y" },
    };
    expect(resolveConfig({ pins }).pins).toEqual(pins);
  });
});

describe("loadConfigFile", () => {
  it("reports a missing file", async () => {
    const dir = await tempDir();
    const loaded = await loadConfigFile(join(dir, "config.json"));
    expect(loaded.exists).toBe(false);
    expect(loaded.config).toEqual({});
  });

  it("parses an existing file", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    await writeJsonAtomic(path, { mode: "global" });
    const loaded = await loadConfigFile(path);
    expect(loaded.exists).toBe(true);
    expect(loaded.config).toEqual({ mode: "global" });
  });

  it("surfaces an error for corrupt JSON without throwing", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{ broken", "utf8");
    const loaded = await loadConfigFile(path);
    expect(loaded.exists).toBe(true);
    expect(loaded.config).toEqual({});
    expect(loaded.error).toBeTypeOf("string");
  });
});

describe("updateConfigFile", () => {
  it("creates the file with just the patched field", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    await updateConfigFile(path, { mode: "global" });
    expect(await readJsonObject(path)).toEqual({ mode: "global" });
  });

  it("preserves unrelated keys already in the file", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    await writeJsonAtomic(path, { notify: "changes", include: { model: false } });
    await updateConfigFile(path, { mode: "global" });
    expect(await readJsonObject(path)).toEqual({
      notify: "changes",
      include: { model: false },
      mode: "global",
    });
  });

  it("writes pins", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    const pins = { "/home/proj": { provider: "x", model: "y" } };
    await updateConfigFile(path, { pins });
    expect(await readJsonObject(path)).toEqual({ pins });
  });
});
