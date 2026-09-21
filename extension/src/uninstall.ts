import { homedir } from 'node:os'
import { removeEverything } from './wiring'

// VS Code runs this with plain Node once the extension is fully uninstalled, after the
// editor restarts. Hooks left pointing at a deleted script would fail on every event.
try {
  removeEverything(homedir())
} catch {
  // nothing useful to report to: there is no UI at this point
}
