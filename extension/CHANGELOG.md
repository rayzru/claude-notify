# Changelog

## 0.2.0

- Nothing to install besides the extension. A small app of its own shows the notifications
  — under its own name and icon, asked once whether it may — instead of `terminal-notifier`
  from Homebrew. Hooks run with VS Code's own runtime, so Node.js is not needed either;
  hooks an older version added are moved over by themselves.
- A setup page opens on the first start: connect to Claude Code, allow notifications, choose
  where Claude lives, try it. *Set up…* opens it again.
- macOS 13 or later, Apple silicon and Intel. Windows and Linux come later.
- The same notification also appears inside the VS Code window that holds the session,
  with an *Open session* button; the session's name in it is a link that does the same.
  `claudeNotify.editorNotifications` turns it off.
- Pause notifications for 15 minutes, an hour, three hours or until you resume — all of
  them, or only the ones inside VS Code. From the command palette or the bottom of the
  session list; the status bar shows it.
- Now called *Notify for Claude Code*: the name *Claude Notify* is taken on the Marketplace.
  Settings, commands and the extension ID stay the same.

## 0.1.0

First release.

- Notifies when a Claude Code session finishes and when one is waiting for you — one
  notification per event, titled with the session's name and carrying how the last
  answer began.
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
- A click switches to the session where it already is — its tab, or the Claude sidebar —
  instead of opening a second view of it in a new tab.
- A click always opens the session of the notification you clicked: the command rides inside
  the notification instead of in a waiting process, which macOS could hand another click.
