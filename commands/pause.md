---
description: Pause session notifications for a while, or turn them back on
argument-hint: "[minutes] [editor] | resume"
allowed-tools: ["Bash"]
---

The user asked: `$ARGUMENTS`

Turn that into one call:

- nothing, or a number of minutes — pause every notification, for that long or until resumed:
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/claude-notify.mjs" --pause [minutes]`
- mentions the editor, VS Code or "inside" — pause only the notifications shown inside VS Code,
  system ones keep coming: add `--editor`
- "resume", "on", "back", "unpause" — `--resume` (with `--editor` to lift only that one)

Run it and report the two lines it prints. A pause holds across every window and every
session, and sessions keep being counted in the status bar meanwhile.
