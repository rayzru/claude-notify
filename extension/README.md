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

Each one is titled with the session's name — the one Claude Code shows on its tab — with
the project underneath, and carries how the model's last answer began: *Done · 12 min — Fixed
the flaky test and pushed the branch.* Enough to know what happened without switching.

- **A short turn stays quiet.** If a turn took less than 45 seconds you were watching it
  arrive, so nothing fires. Adjustable.
- **One notification per event, and per session.** Claude Code also reports a session as
  "waiting for your input" some minutes after a turn; that is the same news as *Done*, so it
  is not shown again and does not light the status bar. A newer notification replaces the
  older one, and going back to a session clears its old one — nothing stale is left in the
  stack for a click to land on by mistake.
- **Click to switch.** The click goes straight to that session's tab.
- **Every session, from every window.** The status bar counts what is running and what is
  waiting across all your VS Code windows. Click it for the full list:

  | | |
  | --- | --- |
  | **who** | the session's title, the same one Claude Code shows |
  | **where** | the project it was started in and which window has it — plus where it is working now, if it moved on to another repository |
  | **state** | waiting for you — with what it is asking — or running, and for how long |
  | **size** | model and how much context the session is carrying |

  Pick one and its window comes to the front with that session open — in its tab if it has
  one, otherwise by switching the Claude sidebar to it when that is where you keep Claude
  (`claudeCode.preferredLocation: "sidebar"`). It never opens a second view of a session. A session that no
  window has open — started in a terminal, or in a window you closed — is listed as such,
  and picking it offers to open its folder instead of guessing a window. A notification
  for such a session does nothing on click rather than open windows you did not ask for.

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
2. **macOS asks whether `terminal-notifier` may show notifications.** Allow it, and in
   *System Settings → Notifications → terminal-notifier* set the style to **Persistent**
   (called *Alerts* on older macOS): the default makes them slide away after a few seconds. If it never asks,
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
whether it is worth a notification, and shows one through `terminal-notifier`. The command a
click should run is stored inside that notification, and nothing stays behind waiting for an
answer: macOS hands a click to any running copy of the same app, so a waiting process per
notification ends up answering clicks meant for another one. An
extension cannot show a system notification itself — VS Code has no API for it — which is
why the script does that part.

Each VS Code window's extension listens on a loopback port that only this machine can
reach, guarded by a random token, and records its port and workspace folders under
`~/.claude/claude-notify/links/`. On a click the script brings the window whose workspace
holds the session's folder to the front and asks it to focus the session; a session outside
every workspace goes to the window you used last.

The script also keeps one small file per active session under
`~/.claude/claude-notify/sessions/`, which every window reads for its status bar and list.
Whether a session is running is read from its transcript: a working session keeps writing
to it. The title and context size come from the end of that same file when you open the list,
since they change on every turn. The
extension does that through the Claude Code extension's own command, so VS Code's
confirmation prompt for external links never appears.

Nothing leaves your machine. There is no telemetry.

## Uninstalling

Uninstalling removes the hooks, the copied script and the link file. VS Code runs that
cleanup after the next restart.

## Known limits

- **Context is shown as a size, not a percentage.** The transcript rarely says how large the
  model's window is, and a guessed percentage would be worse than an honest number.
- **"Running" means the transcript is being written.** Hooks alone miss sessions that resume
  after an editor restart without a new prompt, and never hear about one killed mid-turn. A
  working session always writes its transcript, so that decides: silent for ten minutes, and
  a session that claimed to be running is taken off the list.

- **The focus command belongs to the Claude Code extension** and is not a documented API.
  If a future release renames it, clicks fall back to a `vscode://` link, which works
  after VS Code asks once.
- **Sessions in a plain terminal** have no tab to switch to. They still notify.
