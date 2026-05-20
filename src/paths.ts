/**
 * Filesystem locations for the extension.
 *
 * - Extension config: `~/.pi/model-persistence/config.json`
 * - Pi global settings: `~/.pi/agent/settings.json` (snapshotted/restored)
 *
 * No workspace `.pi/` paths — Pi's native project settings handle per-project
 * overrides; this extension only guards global defaults.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Name of the config directory inside `~/.pi`. */
const CONFIG_DIR = "model-persistence";
/** Name of the single config file. */
const CONFIG_FILENAME = "config.json";
/** Pi's settings filename. */
export const SETTINGS_FILENAME = "settings.json";

export type ExtensionPaths = {
  /** `~/.pi/model-persistence` */
  configDir: string;
  /** `~/.pi/model-persistence/config.json` */
  configPath: string;
  /** `~/.pi/agent` */
  globalAgentDir: string;
  /** `~/.pi/agent/settings.json` */
  globalSettingsPath: string;
};

/**
 * Resolve every path the extension cares about.
 *
 * @param options.home  Home directory; defaults to `os.homedir()`.
 */
export function resolvePaths(options: { home?: string }): ExtensionPaths {
  const home = options.home ?? homedir();
  const configDir = join(home, ".pi", CONFIG_DIR);
  const globalAgentDir = join(home, ".pi", "agent");

  return {
    configDir,
    configPath: join(configDir, CONFIG_FILENAME),
    globalAgentDir,
    globalSettingsPath: join(globalAgentDir, SETTINGS_FILENAME),
  };
}
