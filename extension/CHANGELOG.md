# Changelog

## 0.1.0

First release.

- Notifies when a Claude Code session finishes and when one is waiting for you.
- Clicking the notification brings that session's tab to the front, without VS Code's
  prompt for external links.
- Every active session from every window in the status bar; click for the list — who,
  where, in what state, which model and how much context — and pick one to go there.
  Running is read from the session's transcript, so sessions that resumed after an editor
  restart show up and ones killed mid-turn drop off.
- Adds its hooks to `~/.claude/settings.json` only after asking, and removes them on
  uninstall.
- Works with several VS Code windows open: each session is routed to the window whose
  workspace holds it, and a click brings that window to the front.
- A session is matched to the window it was started in, even after it moves on to another
  repository.
- A notification dismissed without an answer no longer leaves a process waiting forever.
