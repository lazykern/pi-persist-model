import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { type ThinkingLevel, PersistModelEngine } from "./engine.ts";
import { fallbackAgentDir } from "./paths.ts";
import { PersistModelScreen } from "./tui.ts";

export { PersistModelEngine } from "./engine.ts";
export type { ActiveState, PersistenceState, ThinkingLevel } from "./engine.ts";

function agentDir(): string {
  try {
    return getAgentDir();
  } catch {
    return fallbackAgentDir();
  }
}

function asThinkingLevel(level: string): ThinkingLevel {
  if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) {
    return level as ThinkingLevel;
  }
  return "off";
}

async function openPersistModelScreen(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  engine: PersistModelEngine,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("persist-model: interactive UI unavailable", "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const close = () => done();
    return new PersistModelScreen({
      tui,
      theme,
      workspaceId: engine.getPersistenceState().workspaceId,
      currentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      thinkingLevel: asThinkingLevel(pi.getThinkingLevel()),
      persistence: engine.getPersistenceState(),
      callbacks: {
        onSave: async (workspaceScope, defaultScope, active) => engine.configureScopes(workspaceScope, defaultScope, active),
        onCancel: close,
      },
    });
  });
}

export default function persistModelExtension(pi: ExtensionAPI): void {
  let engine: PersistModelEngine | undefined;

  pi.on("session_start", async (_event, ctx) => {
    engine = new PersistModelEngine({
      agentDir: agentDir(),
      cwd: ctx.cwd,
      notify: (message, level) => ctx.ui.notify(message, level),
    });
    await engine.init();
  });

  pi.on("model_select", async (event) => {
    await engine?.onModelSelect({
      model: { provider: event.model.provider, id: event.model.id },
      source: event.source,
    });
  });

  pi.on("thinking_level_select", async (event) => {
    await engine?.onThinkingLevelSelect({ level: event.level });
  });

  pi.registerCommand("persist-model", {
    description: "Open Persist Model configuration screen",
    handler: async (_args, ctx) => {
      if (!engine) {
        engine = new PersistModelEngine({
          agentDir: agentDir(),
          cwd: ctx.cwd,
          notify: (message, level) => ctx.ui.notify(message, level),
        });
        await engine.init();
      }
      await openPersistModelScreen(pi, ctx, engine);
    },
  });
}
