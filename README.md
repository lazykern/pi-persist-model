# pi-model-persistence

A [Pi Coding Agent](https://github.com/earendil-works/pi) extension — **Model
Persistence** — that controls whether changing your model or reasoning level
inside a session leaks out into your *global* defaults.

- **Extension ID:** `model-persistence`
- **Display name:** Model Persistence
- **Command:** `/model-persistence`

## The problem

When you switch model with `/model` / `Ctrl+P`, or change the reasoning level,
Pi writes the new value into `~/.pi/agent/settings.json`:

- `defaultProvider`
- `defaultModel`
- `defaultThinkingLevel`

Those keys are the **global defaults for every future Pi session**. So a quick,
throwaway "let me try gpt-5 for this one question" silently becomes the default
your next project, in a different repo, starts on. There is no built-in way to
say "change the model *for this session only*".

Model Persistence fixes that. It lets the **active session change freely**
while keeping global defaults stable — unless you explicitly opt in.

## Why is it called "Model Persistence" if it also covers thinking level?

The name comes from the user-facing mental model: *"does my model choice
persist?"* Pi calls the reasoning level `thinkingLevel`, and a model change can
itself clamp or change the thinking level, so the two are inseparable in
practice. The extension therefore manages **all three** persistent keys
(`defaultProvider`, `defaultModel`, `defaultThinkingLevel`). "Model
Persistence" is the short, memorable name for the whole behavior; everywhere it
matters, thinking-level persistence is covered too (see `include.thinkingLevel`).

## Modes

The `mode` setting decides what happens after Pi persists a change:

| Mode | Active session | Global `~/.pi/agent/settings.json` | Workspace `.pi/settings.json` |
|------|----------------|------------------------------------|-------------------------------|
| `session` *(default)* | changes normally | **restored** to the session-start snapshot | untouched |
| `workspace` | changes normally | **restored** to the session-start snapshot | written with the new values |
| `global` | changes normally | left as Pi wrote it (stock behavior) | untouched |

- **`session`** — model/thinking changes affect only the running session.
  Global defaults are restored right after Pi writes them. Nothing else on disk
  changes.
- **`workspace`** — changes are persisted to the *current worktree* via
  `<cwd>/.pi/settings.json` (which Pi's project settings override read), while
  global defaults are still restored. Future sessions in the same worktree pick
  up the workspace value; other projects are unaffected.
- **`global`** — the extension does nothing; Pi's normal behavior is preserved.

The active session model and thinking level, and your session history, are
**never** modified in any mode.

## Configuration

The extension reads its own config files (separate from Pi's `settings.json`):

1. **Global:** `~/.pi/agent/model-persistence.json`
2. **Workspace:** `<cwd>/.pi/model-persistence.json`

The workspace config overrides the global config, field by field.

### Schema

```ts
type ModelPersistenceConfig = {
  mode: "session" | "workspace" | "global";
  include?: {
    model?: boolean;
    thinkingLevel?: boolean;
  };
  restoreOnModelRestore?: boolean;
  notify?: "off" | "errors" | "changes";
};
```

| Field | Meaning |
|-------|---------|
| `mode` | See [Modes](#modes). |
| `include.model` | When `false`, model/provider changes are ignored. Default `true`. |
| `include.thinkingLevel` | When `false`, thinking-level changes are ignored. Default `true`. |
| `restoreOnModelRestore` | When `false` (default), `model_select` events with `source: "restore"` (session restore) are ignored, so the extension does not fight Pi restoring a session's saved model. |
| `notify` | `off` = silent, `errors` = only failures (default), `changes` = also announce each kept/saved change. |

### Default config

If no config file exists, these defaults apply:

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

The extension **does not create** a config file unprompted. Run
`/model-persistence init` to scaffold one with the defaults above, or
`/model-persistence set ...` / `/model-persistence mode ...` to write a single
field. You can also create the file yourself.

### Example configs

Keep everything session-only (the default behavior, written explicitly):

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

Persist model choices per worktree, but never let thinking-level changes stick,
and announce everything:

```json
{
  "mode": "workspace",
  "include": { "model": true, "thinkingLevel": false },
  "notify": "changes"
}
```

## Commands

`/model-persistence <subcommand>`:

| Subcommand | Action |
|------------|--------|
| `status` | Show mode, include flags, captured defaults, settings paths, which config files exist, and the last error (if any). |
| `help` | List every subcommand. |
| `mode <session\|workspace\|global> [--global\|--workspace]` | Switch persistence mode. Shorthand for `set mode <mode>`. |
| `set <key> <value> [--global\|--workspace]` | Write one config field. Keys: `mode`, `notify`, `restoreOnModelRestore`, `include.model`, `include.thinkingLevel`. |
| `init [global\|workspace]` | Create a config file pre-filled with the documented defaults. Refuses to overwrite an existing file. |
| `capture` | Re-snapshot the current global `defaultProvider` / `defaultModel` / `defaultThinkingLevel`. Use after deliberately editing global defaults yourself. |
| `save-global` | Deliberately write the session's current provider/model/thinking level into `~/.pi/agent/settings.json`, and update the captured baseline to match. Prompts for confirmation. |
| `save-workspace` | Deliberately write the session's current provider/model/thinking level into `<cwd>/.pi/settings.json` (creating `.pi/` if needed). |

`set` / `mode` / `init` write to the **workspace** config when the worktree
already has a `.pi/` directory, otherwise to the **global** config. The
`--global` / `--workspace` flag (or the `init` argument) overrides that choice.
A `set` whose value already matches the target file is reported as a no-op and
nothing is written.

`save-global` overwrites the defaults every future Pi session starts with, so
it asks for confirmation first (in interactive mode). `save-global` /
`save-workspace` are the explicit "yes, I really mean it" escape hatches: they
are the only way model/thinking changes reach disk as a durable default while
the extension is active.

### Status footer

The extension shows `persist:<mode>` in Pi's footer. If a global-defaults
restore fails — meaning Pi's write may not have been undone — the footer
changes to `persist:<mode> ⚠` and `status` reports the error. This warning is
shown even with `notify: "off"`, since a failed restore is the one case the
extension cannot stay silent about. It clears after the next successful
restore.

## Installation

### Global installation

Install for every project:

```bash
pi install /absolute/path/to/pi-model-persistence
# or, once published:
pi install npm:pi-model-persistence
pi install git:github.com/lazykern/pi-model-persistence
```

Then run `/model-persistence init` to scaffold
`~/.pi/agent/model-persistence.json`, or drop the file in yourself.

### Workspace config usage

To make one worktree behave differently, add `<cwd>/.pi/model-persistence.json`:

```json
{ "mode": "workspace" }
```

Now model/thinking changes in that worktree are saved to its
`.pi/settings.json` and shared with future sessions there, while your global
defaults — and every other project — stay put.

### Local development

This package is consumed as TypeScript source (Pi loads extensions via
[jiti](https://github.com/unjs/jiti), no build step):

```bash
git clone https://github.com/lazykern/pi-model-persistence.git
cd pi-model-persistence
npm install

npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Load it into Pi without installing — either via the package manifest:

```bash
pi -e /absolute/path/to/pi-model-persistence
```

or point at the entry file directly while iterating:

```bash
pi -e /absolute/path/to/pi-model-persistence/src/index.ts
```

For `/reload` support, symlink or copy the directory into
`~/.pi/agent/extensions/` or a project's `.pi/extensions/`.

## How it works

- On `session_start` the extension loads its config and **snapshots** the
  current global `default*` keys.
- On `model_select` / `thinking_level_select` it restores those snapshotted
  global keys (and, in `workspace` mode, also writes the new values to
  `<cwd>/.pi/settings.json`).
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
modelPersistence: "session" | "workspace" | "global"
```

Native support should:

- Cover `defaultProvider`, `defaultModel`, **and** `defaultThinkingLevel`.
- Apply the policy *before* writing settings, rather than repairing afterward —
  eliminating the transient-write window and the inter-session race entirely.

At that point this extension can be retired. Its module boundaries
(`config` / `paths` / `settings-file` / `lock` / engine) are kept clean
deliberately, so the behavior here can inform that core PR.

## License

MIT
