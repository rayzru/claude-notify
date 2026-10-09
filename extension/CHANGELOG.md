# Changelog

## 0.2.6

- The spinner of a running session turns about its own centre. A spinning codicon in the
  session list turned together with the space after it, off-centre and into the name.
- Every row of the session list, the controls below too, has two lines: the name beside
  its icon, and under the name, in muted text, the state first and the rest after it. What
  a waiting session asks comes right after the state, where a long line does not cut it off.

## 0.2.5

- A session whose turn has ended but whose background agents or workflow are still at work
  counts as running. Claude Code now runs subagents in the background by default, so the
  turn's end no longer means the work is done, and the status bar showed one session where
  several were busy. Running, waiting and idle now come from Claude Code's own record of its
  processes; the transcript decides only for sessions it keeps no record of.
- A question answered in a VS Code tab no longer leaves its session marked as waiting.
- A tab you renamed keeps its name in the session list and in notifications, as on the tab,
  and its notifications are still held back while that tab is in front of you.
- The session list reads in one rhythm: every icon in its own column, the name with where
  the session lives beside it, a second line that starts with the state and how long, and
  sections for sessions and for notifications.

## 0.2.4

- After VS Code restarts, the session list no longer shows every reopened session as
  running. Claude Code writes its bookkeeping (cost totals, mode, last prompt) into each
  transcript it reopens or closes, and the file's change alone was taken as work. A session
  now counts as running by the time of its last dated record: a turn in progress, or one
  resumed after the restart.

## 0.2.3

- Not connected to Claude Code yet? Every start says so, with *Connect* and a way back to
  the setup page, instead of asking once and staying quiet after a "Not now". Connecting
  starts the hooks once to check they run, and says so when the first session reports.
  Sessions already open report from their next message; the setup page no longer asks for
  a new one.
- How long a turn must last to be announced is a choice: 15, 30 or 45 seconds, 1, 1.5 or
  2 minutes, 45 seconds by default. In the settings, or *Announce turns longer than…* from
  the command palette and the bottom of the session list.
- macOS hides every notification while the screen is shared or recorded. A new, optional
  setup step explains it and opens the page with *When mirroring or sharing the display*;
  the test notification and *Check that notifications work* mention it while it is off.
- With the claude-notify plugin for Claude Code installed but switched off, the extension
  adds its own hooks. It used to count the plugin as connected, and nothing reported.
- *Check that notifications work* no longer reports the extension's own hooks as wired
  twice, and reads VS Code settings with comments and trailing commas.
- Uninstalling leaves nothing behind. Besides the hooks, script and app, it now withdraws
  the notifications still on screen and removes the session list, the debug log, the
  per-turn state in the temp folder and the config file. The config file stays while the
  claude-notify plugin for Claude Code is installed, because it holds that plugin's settings
  too.
- After an uninstall, installing again is a first start: the setup page opens again. VS Code
  had kept the extension's memory of it.

## 0.2.2

- No notification inside VS Code for the session you are looking at, in a focused window: its
  tab in front, or — with Claude in the sidebar — the session you last wrote to there. It
  covered the box you type in. The system notification still comes.

## 0.2.1

- A *Sponsor* button on the extension's page, for anyone who wants to support the project.
  The ways to donate are listed under *Support the project* in the README.

## 0.2.0

- Nothing to install besides the extension. A small app of its own shows the notifications
  — under its own name and icon, asked once whether it may — instead of `terminal-notifier`
  from Homebrew. Hooks run with VS Code's own runtime, so Node.js is not needed either;
  hooks an older version added are moved over by themselves.
- A setup page opens on the first start: connect to Claude Code, allow notifications, keep
  them on screen, try it. *Set up…* opens it again. With the claude-notify plugin for Claude
  Code installed, *Connect* is already done.
- macOS 13 or later, Apple silicon and Intel. Windows and Linux come later.
- The same notification also appears inside the VS Code window that holds the session,
  with an *Open session* button; the session's name in it is a link that does the same.
  `claudeNotify.editorNotifications` turns it off.
- Pause notifications for 15 minutes, an hour, three hours or until you resume — all of
  them, or only the ones inside VS Code. From the command palette or the bottom of the
  session list; the status bar shows it.
- Now called *Notify for Claude Code*, with the ID `rayz.claude-session-notify`: both *Claude
  Notify* and `claude-notify` are taken on the Marketplace. Settings and commands stay the same.

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
