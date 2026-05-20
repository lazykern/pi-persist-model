import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyDefaults,
  pathExists,
  readJsonObject,
  restoreDefaults,
  SettingsFileError,
  snapshotDefaults,
  writeJsonAtomic,
} from "../src/settings-file.ts";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mp-sf-"));
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

describe("snapshotDefaults", () => {
  it("captures present string keys", () => {
    const snap = snapshotDefaults({
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
      defaultThinkingLevel: "high",
      theme: "dark",
    });
    expect(snap.defaultProvider).toEqual({ present: true, value: "anthropic" });
    expect(snap.defaultModel).toEqual({ present: true, value: "claude-x" });
    expect(snap.defaultThinkingLevel).toEqual({ present: true, value: "high" });
  });

  it("marks missing or non-string keys as absent", () => {
    const snap = snapshotDefaults({ defaultModel: 42, theme: "dark" });
    expect(snap.defaultProvider).toEqual({ present: false });
    expect(snap.defaultModel).toEqual({ present: false });
    expect(snap.defaultThinkingLevel).toEqual({ present: false });
  });

  it("treats a null file as all-absent", () => {
    const snap = snapshotDefaults(null);
    expect(snap.defaultProvider.present).toBe(false);
    expect(snap.defaultModel.present).toBe(false);
    expect(snap.defaultThinkingLevel.present).toBe(false);
  });
});

describe("restoreDefaults", () => {
  it("rewrites present keys and preserves unrelated keys", () => {
    const snap = snapshotDefaults({ defaultProvider: "anthropic", defaultModel: "claude-x" });
    const result = restoreDefaults(
      { defaultProvider: "openai", defaultModel: "gpt-5", theme: "dark" },
      snap,
      ["defaultProvider", "defaultModel"],
    );
    expect(result).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
      theme: "dark",
    });
  });

  it("deletes keys that were originally absent instead of writing null", () => {
    const snap = snapshotDefaults({ theme: "dark" }); // no defaults present
    const result = restoreDefaults(
      { defaultProvider: "openai", defaultModel: "gpt-5", theme: "dark" },
      snap,
      ["defaultProvider", "defaultModel"],
    );
    expect(result).toEqual({ theme: "dark" });
    expect("defaultProvider" in result).toBe(false);
    expect("defaultModel" in result).toBe(false);
  });

  it("only touches the requested keys", () => {
    const snap = snapshotDefaults(null);
    const result = restoreDefaults(
      { defaultProvider: "openai", defaultThinkingLevel: "high" },
      snap,
      ["defaultProvider"],
    );
    expect(result).toEqual({ defaultThinkingLevel: "high" });
  });
});

describe("applyDefaults", () => {
  it("overwrites managed keys and preserves the rest", () => {
    const result = applyDefaults(
      { defaultModel: "old", theme: "dark", nested: { a: 1 } },
      { defaultProvider: "openai", defaultModel: "gpt-5" },
    );
    expect(result).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      theme: "dark",
      nested: { a: 1 },
    });
  });
});

describe("readJsonObject / writeJsonAtomic", () => {
  it("returns null for a missing file", async () => {
    const dir = await tempDir();
    expect(await readJsonObject(join(dir, "missing.json"))).toBeNull();
  });

  it("round-trips an object and preserves all keys", async () => {
    const dir = await tempDir();
    const path = join(dir, "deep", "settings.json");
    await writeJsonAtomic(path, { defaultModel: "claude-x", theme: "dark", n: { a: 1 } });
    expect(await readJsonObject(path)).toEqual({
      defaultModel: "claude-x",
      theme: "dark",
      n: { a: 1 },
    });
  });

  it("throws SettingsFileError for invalid JSON", async () => {
    const dir = await tempDir();
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not json", "utf8");
    await expect(readJsonObject(path)).rejects.toBeInstanceOf(SettingsFileError);
  });

  it("throws SettingsFileError when the JSON is not an object", async () => {
    const dir = await tempDir();
    const path = join(dir, "arr.json");
    await writeFile(path, "[1, 2, 3]", "utf8");
    await expect(readJsonObject(path)).rejects.toBeInstanceOf(SettingsFileError);
  });

  it("writes atomically without leaving temp files behind", async () => {
    const dir = await tempDir();
    const path = join(dir, "settings.json");
    await writeJsonAtomic(path, { a: 1 });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries).toEqual(["settings.json"]);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });
});

describe("pathExists", () => {
  it("reports presence", async () => {
    const dir = await tempDir();
    expect(await pathExists(dir)).toBe(true);
    expect(await pathExists(join(dir, "nope"))).toBe(false);
  });
});
