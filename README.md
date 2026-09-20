# claude-notify

A Claude Code plugin that tells you when a session **finished** and when one is **waiting
for you**, so you can run several sessions at once without babysitting any of them.
Clicking the notification brings that session's tab to the front.

## Why

Claude Code does not signal a session you are not looking at. The VS Code extension puts a
badge on the session list, but only while that window is in front of you, and a session in
a terminal shows nothing at all. Run three sessions in parallel and you end up polling them
by hand.

## Scope

This targets **VS Code with the official Anthropic extension, on macOS**. That is the path
that is used daily and tested.

The code also builds commands for Windows toasts and for `notify-send` on Linux, and
`uriScheme` / `extensionId` can be pointed at a VS Code fork. Those paths are covered by
dry-run tests only — nobody has run them. Treat them as a starting point, not a promise.

## Install

```
/plugin marketplace add rayzru/claude-notify
/plugin install claude-notify@rayzru
```

The marketplace is named after its owner, so the plugin reads `claude-notify@rayzru`. If
more plugins follow, they can be listed from the same marketplace manifest.

Hooks are read when a session starts, so open a new session. Then:

```
/claude-notify:doctor
```

It checks everything below and names whatever is broken. Run it first whenever something
does not work — it is faster than guessing.

### Requirements

- Node 18 or newer.
- [`terminal-notifier`](https://github.com/julienXX/terminal-notifier)
  (`brew install terminal-notifier`). Without it notifications still appear through
  `osascript`, but they cannot be clicked.

macOS will not show notifications from `terminal-notifier` until it has been granted
permission, and it never asks when it is first run from a script. Launch its bundle once by
hand and answer the prompt:

```sh
open -a /opt/homebrew/Cellar/terminal-notifier/*/terminal-notifier.app --args -message hi
```

`/claude-notify:doctor` detects this exact state and says so.

## What you get

| Event | Notification |
| --- | --- |
| Session finished | *Done · N min* |
| Session stopped with an error | *Stopped with an error* |
| Session wants a permission or an answer | the actual request text |

Three behaviours keep it from becoming noise:

- **A short turn stays quiet.** Under `minTurnSeconds` (45 by default) nothing fires — you
  were watching that answer arrive. Set it to `0` to always notify.
- **One live notification per session.** A newer one replaces the older, so the list holds
  the current state of each session rather than a pile of history.
- **Subagents stay silent.** Only the main agent reports.

## Clicking a notification

The click opens `vscode://<extensionId>/open?session=<id>`, which reveals that session's
existing tab instead of opening a second one.

Three caveats, each of which has cost someone an afternoon:

- **VS Code asks once, before the link ever reaches the extension.** Until you answer that
  prompt, clicking only raises the VS Code window showing whatever tab was last active —
  which is indistinguishable from a link pointing at the wrong session. Answer it once and
  VS Code remembers; `doctor` reads that list and tells you where you stand.
- **That URL is read out of the extension bundle** and is not part of any documented API.
  If a future release changes it, clicks stop working; notifications keep working.
- **A session started in a plain terminal has no tab to reveal**, so `click: "auto"` leaves
  the link off. The notification still fires.

## Configuration

Settings live in `~/.claude/claude-notify.config.json`. Write a file with every key at its
default with `--init-config`.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `language` | `"auto"` | follows the editor's UI language; or pin a code |
| `style` | `"alert"` | `alert` waits for a reply; `banner` fades out on its own |
| `events` | all `true` | `done`, `error`, `waitingInput` |
| `minTurnSeconds` | `45` | below this a finished turn is not announced |
| `waitTimeoutSeconds` | `0` | how long an alert waits; `0` waits indefinitely |
| `groupPerSession` | `true` | `false` keeps every notification instead of replacing |
| `click` | `"auto"` | `auto` links to the editor only when running in one; `focusSession` always; `none` never |
| `sound` | `true` | |
| `uriScheme` | `"vscode"` | use `vscode-insiders`, `cursor`, … for a fork |
| `extensionId` | `"Anthropic.claude-code"` | the extension that handles the link |
| `staleHours` | `24` | age at which an unanswered notification is cleaned up |

Every key has an environment override, which wins over the file:
`CLAUDE_NOTIFY_DISABLED=1`, `CLAUDE_NOTIFY_LANG`, `CLAUDE_NOTIFY_STYLE`,
`CLAUDE_NOTIFY_CLICK`, `CLAUDE_NOTIFY_SOUND`, `CLAUDE_NOTIFY_MIN_SECONDS`,
`CLAUDE_NOTIFY_TIMEOUT`, `CLAUDE_NOTIFY_STALE_HOURS`, `CLAUDE_NOTIFY_CONFIG`.

Shipped languages: `en`, `ru`, `de`, `fr`, `es`, `pt-br`, `ja`, `zh-cn`. Adding one is a
single entry in the `STRINGS` table at the top of the script — eight short strings.

## Commands

| Slash command | What it does |
| --- | --- |
| `/claude-notify:doctor` | check the environment and explain whatever is broken |
| `/claude-notify:test` | send one notification and verify the click |
| `/claude-notify:config` | show the effective settings, or change one |

The script is also a plain CLI, which is what those commands call:

```sh
hooks/claude-notify.mjs --doctor        # environment check
hooks/claude-notify.mjs --test          # sample notification
hooks/claude-notify.mjs --config        # effective settings and detected language
hooks/claude-notify.mjs --init-config   # write a config file with the defaults
hooks/claude-notify.mjs --list          # delivered notifications
hooks/claude-notify.mjs --help
```

## Running alongside other tools

The plugin needs nothing but Node and, for clicks, `terminal-notifier`. It does not read or
write any other tool's state.

Several session managers hook the same four events for their own purposes, which is fine —
they do different work. It only becomes a problem when another tool also shows desktop
notifications, and then you get two for every event. `doctor` lists what else is wired to
those events so you can tell at a glance.

One conflict is worth calling out because it is easy to create by accident: if the script is
*also* wired by hand in `settings.json`, every notification fires twice. `doctor` fails
loudly on that.

## How it works

Four hooks, one script, no dependencies.

`UserPromptSubmit` writes a timestamp for the session. `Stop` and `StopFailure` read it back
to measure the turn, and stay quiet if it was short. `Notification` fires whenever Claude
wants a permission or an answer.

A notification that waits for a reply needs a process to wait in, so the hook spawns a
detached presenter and returns immediately — a hook must never hold up the session it
reports on. The presenter holds the notification, and on a click opens the session URL.

When a newer notification replaces an older one for the same session, the old presenter is
killed **and its delivered notification is removed**. Skipping that second part leaves a
notification on screen whose owner is gone, and clicking it makes macOS try to relaunch the
bundle: `-609`, or *"the application is not open anymore"*.
