# Claude Notify

Run several Claude Code sessions at once without watching any of them. Claude Notify
tells you when a session **finished** and when one is **waiting for you** — a permission,
a question — and a click on the notification brings that session's tab to the front.

## Why

Claude Code does not signal a session you are not looking at. The Claude Code extension
puts a badge on its session list, but only while that window is in front of you. With
three sessions running, you end up checking each one by hand.

## What you get

| When | Notification |
| --- | --- |
| A session finished | *Done · N min* |
| A session stopped with an error | *Stopped with an error* |
| A session wants a permission or an answer | the actual request text |

- **A short turn stays quiet.** If a turn took less than 45 seconds you were watching it
  arrive, so nothing fires. Adjustable.
- **One notification per session.** A newer one replaces the older, so what is on screen
  is the current state of each session, not a pile of history.
- **Click to switch.** The click goes straight to that session's tab.
- **Every session, from every window.** The status bar counts what is running and what is
  waiting across all your VS Code windows. Click it for the full list:

  | | |
  | --- | --- |
  | **who** | the session's title, the same one Claude Code shows |
  | **where** | its project, and whether it is in this window or which other one |
  | **state** | waiting for you — with what it is asking — or running, and for how long |
  | **size** | model and how much context the session is carrying |

  Pick one and its window comes to the front with that session open.

## Requirements

- **macOS.** That is the only platform this is built and tested for.
- The official **Claude Code** extension for VS Code.
- **Node.js 18+** on your `PATH` — Claude Code runs the hook with it.
- [`terminal-notifier`](https://github.com/julienXX/terminal-notifier):
  `brew install terminal-notifier`. Without it notifications still appear, but cannot be
  clicked.

## First run

Two one-time prompts, both expected:

1. **Claude Notify asks to add four hooks** to `~/.claude/settings.json`. That file
   belongs to Claude Code, and hooks are the only way it tells anyone about a session, so
   the extension asks rather than editing it quietly. Nothing else in the file changes.
   Sessions started after that will report.
2. **macOS asks whether `terminal-notifier` may show notifications.** If it never asks,
   macOS skipped the prompt because the tool was first run from a script — run
   *Claude Notify: Check that notifications work* and it will say what to do.

## Commands

| Command | What it does |
| --- | --- |
| Claude Notify: Go to a session | the list of every active session — the same as clicking the status bar |
| Claude Notify: Send a test notification | one notification, to check it appears and the click works |
| Claude Notify: Check that notifications work | checks everything below and names what is broken |
| Claude Notify: Turn notifications on or off | master switch |
| Claude Notify: Add hooks to Claude Code settings | if you said "Not now" at first |
| Claude Notify: Remove hooks from Claude Code settings | takes out only what it added |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `claudeNotify.enabled` | `true` | master switch |
| `claudeNotify.minTurnSeconds` | `45` | shorter turns finish quietly; `0` announces every turn |
| `claudeNotify.events` | all | `done`, `error`, `waitingInput` |
| `claudeNotify.style` | `alert` | `alert` stays until answered, `banner` fades out |
| `claudeNotify.sound` | `true` | |
| `claudeNotify.statusBar` | `true` | running and waiting sessions in the status bar |

## How it works

Claude Code runs a small script on four events. The script times the turn, decides
whether it is worth a notification, and shows one through `terminal-notifier`. An
extension cannot show a system notification itself — VS Code has no API for it — which is
why the script does that part.

Each VS Code window's extension listens on a loopback port that only this machine can
reach, guarded by a random token, and records its port and workspace folders under
`~/.claude/claude-notify/links/`. On a click the script brings the window whose workspace
holds the session's folder to the front and asks it to focus the session; a session outside
every workspace goes to the window you used last.

The script also keeps one small file per active session under
`~/.claude/claude-notify/sessions/`, which every window reads for its status bar and list.
The title and context size are read fresh from the end of the session's transcript when you
open the list, rather than stored, since they change on every turn. The
extension does that through the Claude Code extension's own command, so VS Code's
confirmation prompt for external links never appears.

Nothing leaves your machine. There is no telemetry.

## Uninstalling

Uninstalling removes the hooks, the copied script and the link file. VS Code runs that
cleanup after the next restart.

## Known limits

- **Context is shown as a size, not a percentage.** The transcript rarely says how large the
  model's window is, and a guessed percentage would be worse than an honest number.
- **"Running" is as of the last event.** Claude Code reports a prompt, a wait and a finish,
  but not the moment you answer a permission — so after you go to a waiting session it shows
  as running until the turn ends.

- **The focus command belongs to the Claude Code extension** and is not a documented API.
  If a future release renames it, clicks fall back to a `vscode://` link, which works
  after VS Code asks once.
- **Sessions in a plain terminal** have no tab to switch to. They still notify.
