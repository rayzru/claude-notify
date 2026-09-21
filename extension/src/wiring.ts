import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Everything that touches ~/.claude lives here, with no dependency on the vscode API,
 * so the uninstall script can run it too — VS Code runs that one as plain Node.
 */

export const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification'] as const

const claudeDir = (home: string) => join(home, '.claude')
const settingsPath = (home: string) => join(claudeDir(home), 'settings.json')

/**
 * A fixed path, not the extension folder: that folder carries the version in its
 * name, so hooks pointing into it would break on every update.
 */
export const stableScriptPath = (home: string) => join(claudeDir(home), 'claude-notify', 'claude-notify.mjs')
/** Written by versions before per-window links; removed on sight. */
export const legacyLinkPath = (home: string) => join(claudeDir(home), 'claude-notify-vscode.json')
/** One file per VS Code window, so several windows do not overwrite each other. */
export const linksDir = (home: string) => join(claudeDir(home), 'claude-notify', 'links')
export const linkPath = (home: string, pid: number) => join(linksDir(home), `${pid}.json`)
/** One file per active session, written by the notifier; every window reads the same set. */
export const sessionsDir = (home: string) => join(claudeDir(home), 'claude-notify', 'sessions')
export const configPath = (home: string) => join(claudeDir(home), 'claude-notify.config.json')

const hookCommand = (home: string) => `node "${stableScriptPath(home)}"`

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** Copies the bundled notifier to the stable path when it differs. Returns true if it wrote. */
export function installScript(bundled: string, home: string): boolean {
  const target = stableScriptPath(home)
  const fresh = readFileSync(bundled, 'utf8')
  if (existsSync(target) && readFileSync(target, 'utf8') === fresh) return false
  mkdirSync(join(claudeDir(home), 'claude-notify'), { recursive: true })
  copyFileSync(bundled, target)
  return true
}

/** The Claude Code plugin brings its own hooks; wiring ours too would notify twice. */
export function pluginInstalled(home: string): boolean {
  const registry = readJson(join(claudeDir(home), 'plugins', 'installed_plugins.json'))
  const plugins = registry?.plugins
  return Boolean(plugins && typeof plugins === 'object' && Object.keys(plugins).some((k) => k.startsWith('claude-notify@')))
}

export function hooksWired(home: string): boolean {
  const hooks = readJson(settingsPath(home))?.hooks
  if (!hooks) return false
  const cmd = hookCommand(home)
  return HOOK_EVENTS.every((event) =>
    (hooks[event] || []).some((entry: any) => (entry.hooks || []).some((h: any) => h.command === cmd)))
}

/** Adds our four hooks. Everything else in the file is left exactly as it was. */
export function wireHooks(home: string): void {
  const path = settingsPath(home)
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '{}'
  const settings = JSON.parse(raw) // refuse to rewrite a file we cannot read
  settings.hooks ??= {}
  const cmd = hookCommand(home)
  for (const event of HOOK_EVENTS) {
    const entries: any[] = (settings.hooks[event] ??= [])
    const present = entries.some((entry) => (entry.hooks || []).some((h: any) => h.command === cmd))
    if (!present) entries.push({ hooks: [{ type: 'command', command: cmd, timeout: 10 }] })
  }
  mkdirSync(claudeDir(home), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
}

/** Removes only the entries we added; events left empty are dropped. */
export function unwireHooks(home: string): number {
  const path = settingsPath(home)
  const settings = readJson(path)
  if (!settings?.hooks) return 0
  const cmd = hookCommand(home)
  let removed = 0
  for (const event of HOOK_EVENTS) {
    const entries: any[] | undefined = settings.hooks[event]
    if (!entries) continue
    const kept = []
    for (const entry of entries) {
      const inner = (entry.hooks || []).filter((h: any) => h.command !== cmd)
      removed += (entry.hooks || []).length - inner.length
      if (inner.length) kept.push({ ...entry, hooks: inner })
    }
    if (kept.length) settings.hooks[event] = kept
    else delete settings.hooks[event]
  }
  if (removed) writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
  return removed
}

/** Mirrors the VS Code settings into the notifier's config file, keeping any other keys. */
export function writeConfig(home: string, values: {
  enabled: boolean; minTurnSeconds: number; events: string[]; style: string; sound: boolean
}): void {
  const path = configPath(home)
  const current = readJson(path) || {}
  const next = {
    ...current,
    enabled: values.enabled,
    minTurnSeconds: values.minTurnSeconds,
    style: values.style,
    sound: values.sound,
    events: {
      done: values.events.includes('done'),
      error: values.events.includes('error'),
      waitingInput: values.events.includes('waitingInput'),
    },
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return
  mkdirSync(claudeDir(home), { recursive: true })
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n')
}

/** Leaves nothing behind: hooks, the copied script, the link files. */
export function removeEverything(home: string): number {
  const removed = unwireHooks(home)
  rmSync(join(claudeDir(home), 'claude-notify'), { recursive: true, force: true })
  rmSync(legacyLinkPath(home), { force: true })
  return removed
}
