# Releasing

This repository ships two things with versions of their own: the VS Code extension
*Notify for Claude Code* (`extension/`) and the Claude Code plugin `claude-notify`
(`.claude-plugin/`, `hooks/`, `commands/`). They share the notifier script in `hooks/`.

## The VS Code extension

1. Raise `version` in `extension/package.json` and add a `## <version>` section at the top of
   `extension/CHANGELOG.md` — the release notes are taken from it.
2. Merge to `main`, then tag and push:

   ```sh
   git tag ext-v0.3.0
   git push origin ext-v0.3.0
   ```

3. The *Release* workflow builds on macOS, because the notifying app is compiled with Swift.
   It makes two packages, `darwin-arm64` and `darwin-x64`, both carrying the same universal
   app, creates the GitHub release with both attached, and publishes them to Open VSX.
4. **VS Code Marketplace, by hand:** download both `.vsix` files from the release, then on
   [the publisher page](https://marketplace.visualstudio.com/manage/publishers/rayzru) open
   the extension's **⋯** menu → **Update** and upload them. Microsoft's global access tokens
   stop working on 1 December 2026, which is why this step is not automated.

Before tagging, `cd extension && npm test && npm run package` builds and checks the same
package locally.

## The Claude Code plugin

Raise `version` in `.claude-plugin/plugin.json` and merge to `main`. Users pick it up with

```sh
claude plugin marketplace update rayzru
claude plugin update claude-notify@rayzru
```

## One-time setup

- **VS Code Marketplace:** publisher `rayzru`, created at
  [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) with the
  Microsoft account it belongs to. The first version is uploaded there as a new extension.
- **Open VSX:** an Eclipse account with the GitHub user `rayzru`, the Publisher Agreement
  signed on [open-vsx.org](https://open-vsx.org), and the namespace `rayzru`, created and
  first published with an access token:

  ```sh
  export OVSX_PAT=…   # Settings → Access Tokens on open-vsx.org
  npx ovsx create-namespace rayzru
  npx ovsx publish --packagePath claude-notify-<version>-darwin-*.vsix
  ```

  Then, on open-vsx.org under *Settings → Trusted Publishers*, trust GitHub Actions for
  `rayzru/claude-notify`, workflow `release.yml`, and set the repository variable
  `OPEN_VSX_TRUSTED` to `true` (`gh variable set OPEN_VSX_TRUSTED --body true`). From then on
  the workflow publishes without a stored token, and the access token can be deleted.
