## What gets added

Four entries in `~/.claude/settings.json`, one for each moment Claude Code reports:

| Hook | Means |
| --- | --- |
| `UserPromptSubmit` | you sent a prompt — the turn starts |
| `Stop` | the turn finished |
| `StopFailure` | it stopped with an error |
| `Notification` | it waits for a permission or an answer |

Each runs `~/.claude/claude-notify/claude-notify`, which starts the notifier with VS Code's
own runtime — no Node.js needed.

*Notify for Claude Code: Remove hooks from Claude Code settings* takes out exactly these,
and uninstalling does it for you.

Already using the claude-notify plugin for Claude Code? Its hooks do the same, so the
extension adds none and nothing notifies twice.
