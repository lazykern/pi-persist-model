# Persist Model

Persist Model is a Pi extension for controlling how model and reasoning-level settings are applied.

Use it to keep changes temporary for the current session, save them for a specific workspace, or apply them globally.

```
pi install npm:pi-persist-model
/persist-model   ← opens TUI
```

No project `.pi/` folders. All state in `~/.pi/persist-model/config.json`.

## Scopes

| Scope | Effect |
|---|---|
| `session` | Changes last only this session |
| `workspace` | Saved per project under `~/.pi/persist-model` |
| `pi default` | Let Pi handle it normally |
| `inherit` | Workspace follows User default |

## TUI

| Key | Action |
|---|---|
| `↑/↓` | Select scope row |
| `←/→` | Change scope value |
| `ctrl+s` | Save & apply |
| `esc` | Close |

## License

MIT
