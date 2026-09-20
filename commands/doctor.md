---
description: Check that session notifications actually work, and report what is broken
allowed-tools: ["Bash"]
---

Run the built-in check and report the result to the user in their own language:

```sh
node "${CLAUDE_PLUGIN_ROOT}/hooks/claude-notify.mjs" --doctor
```

Explain every line that is not `ok`, in plain words, and say what to do about it:

- **disabled in …config.json** — nothing will ever fire. Offer to set `"enabled": true`.
- **macOS denies notifications to terminal-notifier** — macOS never showed the permission
  prompt because the tool was first run from a non-interactive shell. Offer to run
  `open -a` on the bundle once, which triggers the prompt.
- **terminal-notifier not found** — notifications still work through `osascript`, but they
  cannot be clicked. Offer `brew install terminal-notifier`.
- **VS Code has not been told to trust links** — the first click will show a VS Code
  confirmation prompt instead of switching sessions. Nothing to fix in advance: tell the
  user to answer that prompt once, and it is remembered.
- **notification(s) with no live owner** — leftovers whose process is gone; clicking one
  raises a macOS error dialog. Offer to clear them with `terminal-notifier -remove ALL`.
- **wired by hand in settings.json** — the plugin already provides these hooks, so every
  notification fires twice. Offer to remove those entries from the settings file.

Do not change anything without asking first.
