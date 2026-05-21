# pi-model-persistence

A [Pi Coding Agent](https://github.com/earendil-works/pi) extension — **Model
Persistence** — that prevents model and thinking-level changes from leaking into
your *global* defaults.

- **Extension ID:** `model-persistence`
- **Display name:** Model Persistence
- **Command:** `/model-persistence`

## The problem

When you switch model with `/model` or `Ctrl+P`, or change the reasoning level,
Pi writes the new value into `~/.pi/agent/settings.json`:

- `defaultProvider`
- `defaultModel`
- `defaultThinkingLevel`

Those keys are the **global defaults for every future Pi session**. A quick,
throwaway "let me try gpt-5 for this one question" silently becomes the default
your next project starts on.

Model Persistence fixes that: changes stay session-only unless you explicitly
save them.

## How it works

By default (session mode), the extension snapshots your global defaults at
session start, then **restores them** every time Pi writes a new model or
thinking level to `~/.pi/agent/settings.json`. The active session changes
freely — global defaults are untouched.

In global mode, the extension does nothing — Pi's stock behavior is preserved.

| Mode | Active session | Global `~/.pi/agent/settings.json` |
|------|----------------|------------------------------------|
| `session` *(default)* | changes normally | **restored** to session-start snapshot |
| `global` | changes normally | left as Pi wrote it (stock behavior) |

## Configuration

Single config file: `~/.pi/model-persistence/config.json`

If the file doesn't exist, defaults apply — nothing is created automatically.

### Schema

```ts
type ModelPersistenceConfig = {
  mode: "session" | "global";
  include?: {
    model?: boolean;          // default: true
    thinkingLevel?: boolean;  // default: true
  };
  restoreOnModelRestore?: boolean;  // default: false
  notify?: "off" | "errors" | "changes";  // default: "errors"
  pins?: Record<string, {     // per-workspace model pins
    provider: string;
    model: string;
    thinkingLevel?: string;
  }>;
};
```

| Field | Meaning |
|-------|---------|
| `mode` | `session` restores globals after changes; `global` disables extension |
| `include.model` | When `false`, model/provider changes are ignored |
| `include.thinkingLevel` | When `false`, thinking-level changes are ignored |
| `restoreOnModelRestore` | When `false` (default), session restore events are ignored |
| `notify` | `off` = silent, `errors` = only failures, `changes` = announce each kept change |
| `pins` | Model preferences keyed by absolute cwd path — set via `/model-persistence pin` |

### Default config

```json
{
  "mode": "session",
  "include": {
    "model": true,
    "thinkingLevel": true
  },
  "restoreOnModelRestore": false,
  "notify": "errors"
}
```

## Commands

`/model-persistence <subcommand>`:

| Subcommand | Action |
|------------|--------|
| *(no arg)* or `status` | Show mode, include flags, captured defaults, config path, workspace pin, and last error |
| `help` | List every subcommand |
| `mode <session\|global>` | Switch persistence mode (shorthand for `set mode`) |
| `set <key> <value>` | Write one config field. Keys: `mode`, `notify`, `restoreOnModelRestore`, `include.model`, `include.thinkingLevel` |
| `save` | Write the session's current model/thinking level into `~/.pi/agent/settings.json`. Prompts for confirmation |
| `pin` | Pin the current model/thinking level to this workspace (stored in config) |
| `unpin` | Remove the workspace pin |

### `save` — make current model your new global default

`/model-persistence save` overwrites the defaults every future Pi session starts
with. It asks for confirmation first (in interactive mode), then updates the
captured baseline so future session-mode restores won't fight your deliberate
choice.

### `pin` / `unpin` — remember a workspace model

`/model-persistence pin` saves the current model to your config file under the
current workspace path. It's a reminder — Pi doesn't auto-apply it. Use
`/model-persistence` to see your pin, and switch to it manually when you want.

For automatic per-project model preferences, use Pi's native `.pi/settings.json`
— create it manually in your project root:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5"
}
```

Pi reads this on startup and applies it automatically. The extension doesn't
touch or overwrite `.pi/settings.json`.

### `set` examples

```bash
/model-persistence set notify changes
/model-persistence set include.model false
/model-persistence set restoreOnModelRestore true
```

## Installation

### From local clone

```bash
git clone https://github.com/lazykern/pi-model-persistence.git
cd pi-model-persistence
npm install

# Load into Pi
pi -e /absolute/path/to/pi-model-persistence
```

### Global installation

```bash
pi install /absolute/path/to/pi-model-persistence
# or, once published:
pi install npm:pi-model-persistence
```

Then configure — either run `touch ~/.pi/model-persistence/config.json` for
defaults, or edit the file directly.

## Local development

This package is consumed as TypeScript source (Pi loads extensions via
[jiti](https://github.com/unjs/jiti), no build step):

```bash
git clone https://github.com/lazykern/pi-model-persistence.git
cd pi-model-persistence
npm install

npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Load it into Pi without installing:

```bash
pi -e /absolute/path/to/pi-model-persistence
# or point at the entry file directly while iterating:
pi -e /absolute/path/to/pi-model-persistence/src/index.ts
```

For `/reload` support, symlink or copy the directory into
`~/.pi/agent/extensions/` or a project's `.pi/extensions/`.

## How it works

- On `session_start` the extension loads its config and **snapshots** the
  current global `default*` keys from `~/.pi/agent/settings.json`.
- On `model_select` / `thinking_level_select` it restores those snapshotted
  global keys (unless mode is `global` or the relevant `include` flag is off).
- All settings writes go through a single in-process queue, so a model change
  and the thinking-level change it triggers can never interleave their
  read/modify/write cycles.
- Global `settings.json` writes also take a cross-process advisory lock
  (`proper-lockfile`, the same mechanism Pi's own settings writer uses), so
  multiple concurrent Pi sessions coordinate.
- Writes are atomic (temp file + rename), unrelated keys are preserved, and a
  field that was originally absent is **deleted** on restore rather than
  written back as `null`.

## Limitations

- **This is a post-change repair extension, not a pre-write prevention
  mechanism.** It reacts *after* Pi has already changed a setting.
- Pi may briefly write the new global defaults to `~/.pi/agent/settings.json`
  before the extension restores them. A reader that races that window can
  observe the transient value.
- Multiple concurrent Pi sessions can still race: the cross-process lock makes
  individual writes safe, but two sessions restoring different snapshots will
  fight. Locking is used where possible; it is not a full transaction.
- The extension only manages `defaultProvider`, `defaultModel`, and
  `defaultThinkingLevel`. Other settings are never touched.

## Future: native core support

This extension exists because Pi has no first-class notion of per-session vs.
global model persistence. The clean long-term fix is a core setting, e.g.:

```ts
modelPersistence: "session" | "global"
```

Native support should:

- Cover `defaultProvider`, `defaultModel`, **and** `defaultThinkingLevel`.
- Apply the policy *before* writing settings, rather than repairing afterward —
  eliminating the transient-write window and the inter-session race entirely.

At that point this extension can be retired.

## License

MIT
