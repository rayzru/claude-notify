---
description: Send a test notification to check it appears and the click works
allowed-tools: ["Bash"]
---

Send one test notification:

```sh
node "${CLAUDE_PLUGIN_ROOT}/hooks/claude-notify.mjs" --test "$CLAUDE_SESSION_ID"
```

Then tell the user what to look for, and ask them to confirm:

1. A notification titled **Claude · <folder>** appears.
2. Clicking it brings this session's tab to the front. On the very first click VS Code may
   ask whether to trust links to the Claude Code extension — that prompt is expected, it is
   answered once and then remembered.

If nothing appears at all, run `/claude-notify:doctor` and work from its output rather than
guessing.
