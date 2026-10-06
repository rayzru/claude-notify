import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
/** A pause, shared with the notifier and every window: { all?, editor? }, each a time or true. */
export const pausePath = (home: string) => join(claudeDir(home), 'claude-notify', 'pause.json')
/** The notifier's per-turn start times and waiting-notifier pids. */
export const stateDir = (tmp: string) => join(tmp, 'claude-notify')

export type PauseScope = 'all' | 'editor'

/** When a pause ends: a time, Infinity while paused until resumed, 0 when not paused. */
export function pausedUntil(home: string, scope: PauseScope, now = Date.now()): number {
  const until = readJson(pausePath(home))?.[scope]
  if (until === true) return Infinity
  return typeof until === 'number' && until > now ? until : 0
}

/** `until` is a time, Infinity for until resumed, or null to resume. */
export function setPause(home: string, scope: PauseScope, until: number | null): void {
  const pause = readJson(pausePath(home)) || {}
  if (until === null) delete pause[scope]
  else pause[scope] = until === Infinity ? true : until
  mkdirSync(join(claudeDir(home), 'claude-notify'), { recursive: true })
  writeFileSync(pausePath(home), JSON.stringify(pause) + '\n')
}

/** What Claude Code's hooks run: starts the notifier with the editor's own runtime. */
export const runnerPath = (home: string) => join(claudeDir(home), 'claude-notify', 'claude-notify')
/**
 * The notifying app on macOS. It is named .app only here, at a fixed path — see
 * native/macos/build.sh for why the copy inside the extension is not.
 */
export const helperPath = (home: string) => join(claudeDir(home), 'claude-notify', 'Notify for Claude Code.app')
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

const hookCommand = (home: string) => `"${runnerPath(home)}"`
/** What versions before the runner wrote; it needed a node on PATH. Replaced on sight. */
const legacyHookCommand = (home: string) => `node "${stableScriptPath(home)}"`
const isOurs = (home: string, command: unknown) => command === hookCommand(home) || command === legacyHookCommand(home)

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

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

/**
 * Writes the runner the hooks call. VS Code's own executable runs as plain Node under
 * ELECTRON_RUN_AS_NODE and is there for as long as the extension is, so hooks need no
 * Node.js; a node on PATH is only the fallback for an editor that has moved since.
 * Rewritten on every start, so it follows the editor. Returns true if it wrote.
 */
export function writeRunner(home: string, runtime: string): boolean {
  const target = runnerPath(home)
  const body = [
    '#!/bin/sh',
    '# Written by Notify for Claude Code each time it starts; Claude Code runs it on its hooks.',
    `runtime=${shellQuote(runtime)}`,
    `script=${shellQuote(stableScriptPath(home))}`,
    'if [ -x "$runtime" ]; then ELECTRON_RUN_AS_NODE=1 exec "$runtime" "$script" "$@"; fi',
    'exec node "$script" "$@"',
    '',
  ].join('\n')
  if (existsSync(target) && readFileSync(target, 'utf8') === body) return false
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
  chmodSync(target, 0o755)
  return true
}

/**
 * Copies the notifying app to its fixed place when the bundled one differs, and registers
 * it with LaunchServices, which is how macOS finds it again to deliver a click. Comparing
 * the executable is enough: its signature covers the rest of the bundle. Returns true if
 * it wrote.
 */
export function installHelper(bundled: string, home: string): boolean {
  const target = helperPath(home)
  const binary = (root: string) => join(root, 'Contents', 'MacOS', 'notify')
  if (!existsSync(binary(bundled))) return false // built without it: not on macOS
  if (existsSync(binary(target)) && readFileSync(binary(target)).equals(readFileSync(binary(bundled)))) return false
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  cpSync(bundled, target, { recursive: true })
  chmodSync(binary(target), 0o755)
  if (existsSync(LSREGISTER)) spawnSync(LSREGISTER, ['-f', target], { stdio: 'ignore' })
  return true
}

/**
 * The Claude Code plugin brings its own hooks; wiring ours too would notify twice. A plugin
 * switched off in enabledPlugins runs no hooks, so it does not count: ours are needed then.
 */
export function pluginInstalled(home: string): boolean {
  const registry = readJson(join(claudeDir(home), 'plugins', 'installed_plugins.json'))
  const plugins = registry?.plugins
  if (!plugins || typeof plugins !== 'object') return false
  const enabled = readJson(settingsPath(home))?.enabledPlugins || {}
  return Object.keys(plugins).some((k) => k.startsWith('claude-notify@') && enabled[k] !== false)
}

/** Hooks from before the runner: they work only where node is on PATH. */
export function hooksOutdated(home: string): boolean {
  const hooks = readJson(settingsPath(home))?.hooks
  const legacy = legacyHookCommand(home)
  return Boolean(hooks) && HOOK_EVENTS.some((event) =>
    (hooks[event] || []).some((entry: any) => (entry.hooks || []).some((h: any) => h.command === legacy)))
}

export function hooksWired(home: string): boolean {
  const hooks = readJson(settingsPath(home))?.hooks
  if (!hooks) return false
  const cmd = hookCommand(home)
  return HOOK_EVENTS.every((event) =>
    (hooks[event] || []).some((entry: any) => (entry.hooks || []).some((h: any) => h.command === cmd)))
}

/**
 * Adds our four hooks, replacing ones an older version wrote. Everything else in the file
 * is left exactly as it was.
 */
export function wireHooks(home: string): void {
  const path = settingsPath(home)
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '{}'
  const settings = JSON.parse(raw) // refuse to rewrite a file we cannot read
  settings.hooks ??= {}
  const cmd = hookCommand(home)
  const legacy = legacyHookCommand(home)
  for (const event of HOOK_EVENTS) {
    const entries: any[] = (settings.hooks[event] ??= [])
    for (let i = entries.length - 1; i >= 0; i--) {
      const inner = (entries[i].hooks || []).filter((h: any) => h.command !== legacy)
      if (inner.length === (entries[i].hooks || []).length) continue
      if (inner.length) entries[i] = { ...entries[i], hooks: inner }
      else entries.splice(i, 1)
    }
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
  let removed = 0
  for (const event of HOOK_EVENTS) {
    const entries: any[] | undefined = settings.hooks[event]
    if (!entries) continue
    const kept = []
    for (const entry of entries) {
      const inner = (entry.hooks || []).filter((h: any) => !isOurs(home, h.command))
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

/** Withdraws what the app delivered: a click on one would start a runner that is gone. */
function withdrawNotifications(home: string): void {
  const notify = join(helperPath(home), 'Contents', 'MacOS', 'notify')
  if (!existsSync(notify)) return
  const listed = spawnSync(notify, ['-list', 'ALL'], { encoding: 'utf8', timeout: 5000 })
  for (const row of (listed.stdout || '').split('\n').slice(1)) {
    const group = row.split('\t')[0]
    if (group) spawnSync(notify, ['-remove', group], { stdio: 'ignore', timeout: 5000 })
  }
}

/**
 * Leaves nothing behind: hooks, delivered notifications, the copied script and app, the
 * session list, link files, pause, debug log and per-turn state. The config file goes
 * too, unless the claude-notify plugin is installed — they are its settings as well.
 */
export function removeEverything(home: string, tmp = tmpdir()): number {
  const removed = unwireHooks(home)
  withdrawNotifications(home)
  if (existsSync(helperPath(home)) && existsSync(LSREGISTER)) spawnSync(LSREGISTER, ['-u', helperPath(home)], { stdio: 'ignore' })
  rmSync(join(claudeDir(home), 'claude-notify'), { recursive: true, force: true })
  rmSync(legacyLinkPath(home), { force: true })
  rmSync(stateDir(tmp), { recursive: true, force: true })
  if (!pluginInstalled(home)) rmSync(configPath(home), { force: true })
  return removed
}
