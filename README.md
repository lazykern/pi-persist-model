# Persist Model

Persist Model is a Pi extension for controlling how model and reasoning-level settings are applied.

Use it to keep changes temporary for the current session, save them for a specific workspace, or apply them globally.

![Persist Model TUI](https://raw.githubusercontent.com/lazykern/pi-persist-model/main/screenshot.png)

```
pi install npm:pi-persist-model
/persist-model   ← opens TUI
```

## The problem

Pi stores model and reasoning defaults in `~/.pi/agent/settings.json`. Every time you switch model or reasoning level, Pi writes those changes to the **global** config — so a quick "let me try GPT-5 for this one question" silently becomes the default for every future session and every project.

Persist Model intercepts those changes and keeps them scoped to your chosen policy: session-only, per-workspace, or global.

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
