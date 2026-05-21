import type { Theme } from "@earendil-works/pi-coding-agent";
import { nextScope, nextWorkspaceScope, type PersistModelScope, type WorkspacePersistModelScope } from "./config.ts";
import type { ActiveState, PersistenceState } from "./engine.ts";

type ComponentLike = {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
};

type TuiLike = {
  requestRender(): void;
};

export type PersistModelCallbacks = {
  onSave(workspaceScope: WorkspacePersistModelScope, defaultScope: PersistModelScope, active: ActiveState): Promise<PersistenceState>;
  onCancel(): void;
};

export type PersistModelScreenOptions = {
  tui: TuiLike;
  theme: Theme;
  workspaceId: string;
  currentModel?: { provider: string; id: string };
  thinkingLevel: string;
  persistence: PersistenceState;
  callbacks: PersistModelCallbacks;
};

function prevScope(scope: PersistModelScope): PersistModelScope {
  switch (scope) {
    case "session":
      return "user";
    case "workspace":
      return "session";
    case "user":
      return "workspace";
  }
}

function prevWorkspaceScope(scope: WorkspacePersistModelScope): WorkspacePersistModelScope {
  switch (scope) {
    case "inherit":
      return "user";
    case "session":
      return "inherit";
    case "workspace":
      return "session";
    case "user":
      return "workspace";
  }
}

function clampLine(line: string, width: number): string {
  if (width <= 0) return "";
  return line.length <= width ? line : line.slice(0, Math.max(0, width - 1));
}

function scopeLabel(scope: WorkspacePersistModelScope): string {
  return scope === "user" ? "pi default" : scope;
}

export class PersistModelScreen implements ComponentLike {
  private readonly tui: TuiLike;
  private readonly theme: Theme;
  private readonly callbacks: PersistModelCallbacks;
  private readonly workspaceId: string;
  private readonly currentModel?: { provider: string; id: string };
  private readonly thinkingLevel: string;

  private selectedRow: 0 | 1 = 0;
  private workspaceScope: WorkspacePersistModelScope;
  private defaultScope: PersistModelScope;
  private savedWorkspaceScope: WorkspacePersistModelScope;
  private savedDefaultScope: PersistModelScope;
  private status: string | undefined;
  private error: string | undefined;
  private busy = false;

  constructor(options: PersistModelScreenOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.callbacks = options.callbacks;
    this.workspaceId = options.workspaceId;
    this.currentModel = options.currentModel;
    this.thinkingLevel = options.thinkingLevel;
    this.workspaceScope = options.persistence.workspaceScope;
    this.defaultScope = options.persistence.defaultScope;
    this.savedWorkspaceScope = this.workspaceScope;
    this.savedDefaultScope = this.defaultScope;
  }

  invalidate(): void {
    // Stateless render; nothing cached.
  }

  render(width: number): string[] {
    const w = width;
    const border = this.theme.fg("borderMuted", "─".repeat(Math.max(1, w - 2)));
    const lines: string[] = [];
    const add = (line = "") => lines.push(clampLine(line, w));
    const model = this.currentModel ? `${this.currentModel.id} [${this.currentModel.provider}]` : "(none)";
    const dirty = this.isDirty();

    add(border);
    add(this.theme.fg("accent", this.theme.bold("Persist Model")));
    add("");
    add(this.theme.fg("muted", "Workspace:"));
    add(`  ${this.workspaceId}`);
    add("");
    add(this.theme.fg("muted", "Current:"));
    add(`  ${model} · thinking ${this.thinkingLevel}`);
    add("");
    add(`${this.theme.fg("muted", "Persistence:")}${dirty ? `  ${this.theme.fg("warning", "unsaved")}` : ""}`);
    add(`  Effective: ${this.theme.fg("accent", scopeLabel(this.effectiveScope()))}`);
    add("");
    add(this.workspaceRow());
    add(this.defaultRow());
    add("");
    add(this.theme.fg("dim", "  inherit    → use User default policy"));
    add(this.theme.fg("dim", "  workspace  → store per-workspace state in ~/.pi/persist-model"));
    add(this.theme.fg("dim", "  pi default → let Pi handle ~/.pi/agent/settings.json"));
    add("");
    add(this.theme.fg("dim", "  ↑/↓ select · ←/→ change · ctrl+s save · esc close"));
    if (this.busy) add(this.theme.fg("warning", "  Saving..."));
    if (this.status) add(this.theme.fg("success", `  ${this.status}`));
    if (this.error) add(this.theme.fg("error", `  ${this.error}`));
    add(border);
    return lines;
  }

  handleInput(data: string): void {
    if (this.busy) return;

    if (data === "\x1b[A" || data === "k") {
      this.selectedRow = this.selectedRow === 0 ? 1 : 0;
      this.clearMessages();
      return;
    }
    if (data === "\x1b[B" || data === "j") {
      this.selectedRow = this.selectedRow === 0 ? 1 : 0;
      this.clearMessages();
      return;
    }
    if (data === "\x1b[D" || data === "h") {
      this.changeSelected(-1);
      return;
    }
    if (data === "\x1b[C" || data === "l") {
      this.changeSelected(1);
      return;
    }
    if (data === "\x13") {
      this.save();
      return;
    }
    if (data === "\x1b") {
      this.callbacks.onCancel();
    }
  }

  private workspaceRow(): string {
    return this.row("Workspace", this.workspaceScope, ["session", "workspace", "user", "inherit"]);
  }

  private defaultRow(): string {
    return this.row("User default", this.defaultScope, ["session", "workspace", "user"]);
  }

  private row(label: string, value: WorkspacePersistModelScope, values: WorkspacePersistModelScope[]): string {
    const selected = (label === "Workspace" && this.selectedRow === 0) || (label === "User default" && this.selectedRow === 1);
    const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
    const labelText = selected ? this.theme.fg("accent", label.padEnd(18)) : label.padEnd(18);
    const rendered = values
      .map((scope) => {
        const label = scopeLabel(scope);
        const text = scope === value ? this.theme.fg("accent", label) : this.theme.fg("dim", label);
        return scope === value ? `[ ${text} ]` : `  ${text}  `;
      })
      .join(" ");
    return `${prefix}${labelText} ${rendered}`;
  }

  private effectiveScope(): PersistModelScope {
    return this.workspaceScope === "inherit" ? this.defaultScope : this.workspaceScope;
  }

  private activeState(): ActiveState {
    return {
      provider: this.currentModel?.provider,
      model: this.currentModel?.id,
      thinkingLevel: this.thinkingLevel,
    };
  }

  private changeSelected(direction: -1 | 1): void {
    if (this.selectedRow === 0) {
      this.workspaceScope = direction > 0 ? nextWorkspaceScope(this.workspaceScope) : prevWorkspaceScope(this.workspaceScope);
    } else {
      this.defaultScope = direction > 0 ? nextScope(this.defaultScope) : prevScope(this.defaultScope);
    }
    this.clearMessages();
  }

  private save(): void {
    this.busy = true;
    this.status = undefined;
    this.error = undefined;
    this.tui.requestRender();
    void this.callbacks
      .onSave(this.workspaceScope, this.defaultScope, this.activeState())
      .then((state) => {
        this.workspaceScope = state.workspaceScope;
        this.defaultScope = state.defaultScope;
        this.savedWorkspaceScope = this.workspaceScope;
        this.savedDefaultScope = this.defaultScope;
        this.status = "Saved persistence config";
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.busy = false;
        this.tui.requestRender();
      });
  }

  private isDirty(): boolean {
    return this.workspaceScope !== this.savedWorkspaceScope || this.defaultScope !== this.savedDefaultScope;
  }

  private clearMessages(): void {
    this.status = undefined;
    this.error = undefined;
    this.tui.requestRender();
  }
}
