---
description: Show or change how session notifications behave
allowed-tools: ["Bash", "Read", "Edit", "Write"]
---

Show the effective settings:

```sh
node "${CLAUDE_PLUGIN_ROOT}/hooks/claude-notify.mjs" --config
```

Settings live in `~/.claude/claude-notify.config.json`; every key also has an environment
override that wins over the file. The keys worth knowing:

- `enabled` — master switch.
- `minTurnSeconds` (45) — a turn shorter than this finishes quietly, because the user was
  watching it. `0` announces every turn.
- `events` — `done`, `error`, `waitingInput`, each switchable on its own.
- `style` — `alert` stays until answered, `banner` fades out by itself.
- `click` — `auto` adds the link to the session tab only when running under the editor,
  `focusSession` always, `none` never.
- `language` — `auto` follows the editor's UI language.

If the user asks for a change, read the file first (it may not exist yet — then start from
`--init-config`), change only the keys they asked about, and keep the rest untouched.
