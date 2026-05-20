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
        mode: "workspace",
        include: { model: false, thinkingLevel: true },
        restoreOnModelRestore: true,
        notify: "changes",
      }),
    ).toEqual({
      mode: "workspace",
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
});

describe("resolveConfig", () => {
  it("returns the documented defaults when nothing is supplied", () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("layers later sources over earlier ones", () => {
    const resolved = resolveConfig({ mode: "session", notify: "off" }, { mode: "global" });
    expect(resolved.mode).toBe("global");
    expect(resolved.notify).toBe("off");
  });

  it("deep-merges the include block across layers", () => {
    const resolved = resolveConfig(
      { include: { model: false } },
      { include: { thinkingLevel: false } },
    );
    expect(resolved.include).toEqual({ model: false, thinkingLevel: false });
  });

  it("lets a workspace layer override a global layer (workspace wins)", () => {
    const global = parseConfig({ mode: "session" });
    const workspace = parseConfig({ mode: "workspace" });
    expect(resolveConfig(global, workspace).mode).toBe("workspace");
  });
});

describe("loadConfigFile", () => {
  it("reports a missing file", async () => {
    const dir = await tempDir();
    const loaded = await loadConfigFile(join(dir, "model-persistence.json"));
    expect(loaded.exists).toBe(false);
    expect(loaded.config).toEqual({});
  });

  it("parses an existing file", async () => {
    const dir = await tempDir();
    const path = join(dir, "model-persistence.json");
    await writeJsonAtomic(path, { mode: "workspace" });
    const loaded = await loadConfigFile(path);
    expect(loaded.exists).toBe(true);
    expect(loaded.config).toEqual({ mode: "workspace" });
  });

  it("surfaces an error for corrupt JSON without throwing", async () => {
    const dir = await tempDir();
    const path = join(dir, "model-persistence.json");
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
    const path = join(dir, "model-persistence.json");
    await updateConfigFile(path, { mode: "workspace" });
    expect(await readJsonObject(path)).toEqual({ mode: "workspace" });
  });

  it("preserves unrelated keys already in the file", async () => {
    const dir = await tempDir();
    const path = join(dir, "model-persistence.json");
    await writeJsonAtomic(path, { notify: "changes", include: { model: false } });
    await updateConfigFile(path, { mode: "global" });
    expect(await readJsonObject(path)).toEqual({
      notify: "changes",
      include: { model: false },
      mode: "global",
    });
  });
});
