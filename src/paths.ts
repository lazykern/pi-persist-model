import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const EXTENSION_ID = "persist-model";
export const SETTINGS_FILENAME = "settings.json";

export type ExtensionPaths = {
  agentDir: string;
  configDir: string;
  configPath: string;
  globalSettingsPath: string;
};

export function fallbackAgentDir(home = homedir()): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir === "~") return home;
    if (envDir.startsWith("~/")) return join(home, envDir.slice(2));
    return envDir;
  }
  return join(home, ".pi", "agent");
}

function inferPiDir(agentDir: string, home = homedir()): string {
  const parent = dirname(agentDir);
  return agentDir === join(parent, "agent") && parent.endsWith(".pi") ? parent : join(home, ".pi");
}

export function resolvePaths(options: { agentDir?: string; home?: string } = {}): ExtensionPaths {
  const home = options.home ?? homedir();
  const agentDir = options.agentDir ?? fallbackAgentDir(home);
  const configDir = join(inferPiDir(agentDir, home), EXTENSION_ID);

  return {
    agentDir,
    configDir,
    configPath: join(configDir, "config.json"),
    globalSettingsPath: join(agentDir, SETTINGS_FILENAME),
  };
}

