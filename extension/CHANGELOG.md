# Changelog

## 0.1.0

First release.

- Notifies when a Claude Code session finishes and when one is waiting for you.
- Clicking the notification brings that session's tab to the front, without VS Code's
  prompt for external links.
- Running and waiting sessions in the status bar; clicking it goes to the waiting one.
- Adds its hooks to `~/.claude/settings.json` only after asking, and removes them on
  uninstall.
- A notification dismissed without an answer no longer leaves a process waiting forever.
