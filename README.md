# Persist Model

- Package: `pi-persist-model`
- Extension ID: `persist-model`
- Command: `/persist-model`
- Display name: Persist Model

Persist Model adds a `/persist-model` configuration screen to Pi.

It controls what happens after model and thinking-level changes: `session`, `workspace`, or `pi default`.

- `session` — temporary changes for the current session only
- `workspace` — per-workspace state stored under `~/.pi/persist-model`
- `pi default` — do nothing; let Pi use its normal `~/.pi/agent/settings.json` behavior
- `inherit` — workspace row only; follow the User default policy

All Persist Model extension config/state is stored in:

```text
~/.pi/persist-model/config.json
```

Persist Model does **not** create project-level folders or files. It does not create `<workspace>/.pi/`.

## Command

```text
/persist-model
```

No subcommands. The command always opens the interactive TUI.

## Scopes

| Scope | Meaning |
| --- | --- |
| `session` | Changes affect only the current session. Future sessions keep previous defaults. |
| `workspace` | Changes are stored per workspace under `~/.pi/persist-model`, keyed by workspace path. |
| `user` / `pi default` | Persist Model does nothing; Pi keeps its normal user-level behavior. |
| `inherit` | Workspace-only value; use the User default policy. |

## Configuration

```ts
type PersistModelScope = "session" | "workspace" | "user";
type WorkspacePersistModelScope = PersistModelScope | "inherit";

type PersistModelConfig = {
  defaultScope?: PersistModelScope;
  include?: {
    model?: boolean;
    thinkingLevel?: boolean;
  };
  workspaces?: Record<
    string,
    {
      scope?: WorkspacePersistModelScope;
      provider?: string;
      model?: string;
      thinkingLevel?: string;
    }
  >;
};
```

Default config:

```json
{
  "defaultScope": "session",
  "include": {
    "model": true,
    "thinkingLevel": true
  },
  "workspaces": {}
}
```

Workspace overrides are keyed by stable absolute workspace path. Git worktrees naturally get separate paths.

```json
{
  "defaultScope": "session",
  "include": {
    "model": true,
    "thinkingLevel": true
  },
  "workspaces": {
    "/Users/me/work/project-a": {
      "scope": "workspace",
      "provider": "openai",
      "model": "gpt-5",
      "thinkingLevel": "high"
    },
    "/Users/me/work/project-b": {
      "scope": "user"
    }
  }
}
```

## TUI keys

| Key | Action |
| --- | --- |
| `↑/↓` | Select Workspace scope or User default scope. |
| `←/→` | Change selected scope value. |
| `ctrl+s` | Save both scope settings and apply current model/thinking level to effective scope. |
| `esc` | Close TUI. |

TUI configures only persistence policy for this project/worktree. Model and thinking-level selection still use Pi’s native controls. No footer/status widget is added.

## Storage

Persist Model writes only extension-owned state:

- Extension config/state: `~/.pi/persist-model/config.json`
- Pi user settings: `~/.pi/agent/settings.json` is only restored for `session`/`workspace`, or left alone for `pi default`
- Project/workspace files: never created by Persist Model

Unrelated JSON keys are preserved. Writes are atomic and file-locked where possible.

## Development

```bash
npm install
npm run typecheck
npm test
```

Load locally:

```bash
pi -e /absolute/path/to/pi-persist-model
```

## License

MIT
