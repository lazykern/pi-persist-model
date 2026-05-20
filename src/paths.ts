/**
 * Filesystem locations the extension reads and writes.
 *
 * Two kinds of file are involved:
 *  - Pi's own settings files (`settings.json`) — the extension snapshots and
 *    restores the `default*` keys in these.
 *  - The extension's own config files (`model-persistence.json`) — these hold
 *    the `mode` / `include` / ... configuration described in the README.
 *
 * All path building is pure so tests can point `home` and `cwd` at temp dirs.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Filename of Pi's settings file in both global and workspace scopes. */
export const SETTINGS_FILENAME = "settings.json";

/** Filename of the extension's own config file in both scopes. */
export const CONFIG_FILENAME = "model-persistence.json";

export type ExtensionPaths = {
  /** `~/.pi/agent` */
  globalAgentDir: string;
  /** `~/.pi/agent/settings.json` — Pi's global settings. */
  globalSettingsPath: string;
  /** `~/.pi/agent/model-persistence.json` — global extension config. */
  globalConfigPath: string;
  /** `<cwd>/.pi` */
  workspacePiDir: string;
  /** `<cwd>/.pi/settings.json` — Pi's workspace settings. */
  workspaceSettingsPath: string;
  /** `<cwd>/.pi/model-persistence.json` — workspace extension config. */
  workspaceConfigPath: string;
};

/**
 * Resolve every path the extension cares about.
 *
 * @param options.home  Home directory; defaults to `os.homedir()`.
 * @param options.cwd   Pi's working directory (`ctx.cwd`).
 */
export function resolvePaths(options: { home?: string; cwd: string }): ExtensionPaths {
  const home = options.home ?? homedir();
  const globalAgentDir = join(home, ".pi", "agent");
  const workspacePiDir = join(options.cwd, ".pi");

  return {
    globalAgentDir,
    globalSettingsPath: join(globalAgentDir, SETTINGS_FILENAME),
    globalConfigPath: join(globalAgentDir, CONFIG_FILENAME),
    workspacePiDir,
    workspaceSettingsPath: join(workspacePiDir, SETTINGS_FILENAME),
    workspaceConfigPath: join(workspacePiDir, CONFIG_FILENAME),
  };
}
