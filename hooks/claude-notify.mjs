#!/usr/bin/env node
/**
 * claude-notify — cross-platform desktop notifications for Claude Code sessions.
 *
 * Wire it as a Claude Code hook on UserPromptSubmit, Stop, StopFailure and
 * Notification. It tells you when a session has finished and when one is
 * waiting for you, and a click takes you to that session's tab in the editor.
 *
 * Zero dependencies. On macOS it drives the small notifying app the VS Code extension
 * installs, or terminal-notifier, or osascript as a last resort; a WinRT toast through
 * PowerShell on Windows; notify-send on Linux.
 *
 * Modes:
 *   (no args)       hook mode; reads the hook payload as JSON on stdin
 *   --show <json>   internal; the detached presenter process
 *   --test          send a sample notification
 *   --config        print the effective configuration and the resolved language
 *   --doctor        check the environment and report what is broken
 *   --init-config   write a config file with every key at its default
 *   --list          list delivered notifications (macOS only)
 *   --pause [minutes] [--editor]
 *                   pause notifications — all of them, or only the ones shown inside
 *                   VS Code; without minutes, until --resume
 *   --resume [--editor]
 *   --help
 *
 * click: "auto" attaches the editor deep link only when the session actually
 * runs under the editor extension; a terminal session still gets the
 * notification, just without a click target.
 */

import { spawn, spawnSync } from 'node:child_process'
import { request } from 'node:http'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const STATE_DIR = join(tmpdir(), 'claude-notify')
// Off unless asked for: `"debug": true` in the config, or CLAUDE_NOTIFY_DEBUG=1.
const DEBUG_LOG = join(homedir(), '.claude', 'claude-notify', 'debug.log')
let debugOn = process.env.CLAUDE_NOTIFY_DEBUG === '1'
function debug(line) {
  if (!debugOn) return
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true })
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [${process.pid}] ${line}\n`)
  } catch {}
}

// One file per VS Code window running the extension; empty when it is not installed.
const LINKS_DIR = join(homedir(), '.claude', 'claude-notify', 'links')
// Both kept by the VS Code extension at fixed paths, which outlive its versioned folder:
// its own notifying app, and a runner that starts this script with the editor's runtime,
// so hooks need no Node.js of their own.
const HELPER = join(homedir(), '.claude', 'claude-notify', 'Notify for Claude Code.app', 'Contents', 'MacOS', 'notify')
const RUNNER = join(homedir(), '.claude', 'claude-notify', 'claude-notify')
// One file per active session, shared by every window: who, where, in what state.
const SESSIONS_DIR = join(homedir(), '.claude', 'claude-notify', 'sessions')
// A session closed mid-turn never sends Stop; after this long without an event it is gone.
const SESSION_TTL_MS = 3 * 3600_000
// A pause, shared with every VS Code window: { all?, editor? }, each a time or true.
const PAUSE_PATH = join(homedir(), '.claude', 'claude-notify', 'pause.json')
const CONFIG_PATH = process.env.CLAUDE_NOTIFY_CONFIG || join(homedir(), '.claude', 'claude-notify.config.json')
const RESOLVED_WITHOUT_CLICK = new Set(['@TIMEOUT', '@CLOSED', ''])
const MAC_SOUNDS = { done: 'Glass', waiting: 'Ping', error: 'Basso' }
const WINDOWS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

const DEFAULTS = {
  enabled: true,
  language: 'auto',
  style: 'alert',
  events: { done: true, error: true, waitingInput: true },
  minTurnSeconds: 45,
  waitTimeoutSeconds: 0,
  groupPerSession: true,
  click: 'auto',
  sound: true,
  uriScheme: 'vscode',
  extensionId: 'Anthropic.claude-code',
  staleHours: 24,
  debug: false,
}

const STRINGS = {
  en: { title: 'Claude · {lane}', done: 'Done', doneIn: 'Done · {n} min', error: 'Stopped with an error', waiting: 'Waiting for input', open: 'Open session', dismiss: 'Dismiss', test: 'Test notification' },
  ru: { title: 'Claude · {lane}', done: 'Готово', doneIn: 'Готово · {n} мин', error: 'Остановлено с ошибкой', waiting: 'Ждёт ввода', open: 'Открыть сессию', dismiss: 'Закрыть', test: 'Тестовое уведомление' },
  de: { title: 'Claude · {lane}', done: 'Fertig', doneIn: 'Fertig · {n} Min', error: 'Mit Fehler gestoppt', waiting: 'Wartet auf Eingabe', open: 'Sitzung öffnen', dismiss: 'Schließen', test: 'Testbenachrichtigung' },
  fr: { title: 'Claude · {lane}', done: 'Terminé', doneIn: 'Terminé · {n} min', error: 'Arrêté sur une erreur', waiting: 'En attente de saisie', open: 'Ouvrir la session', dismiss: 'Fermer', test: 'Notification de test' },
  es: { title: 'Claude · {lane}', done: 'Listo', doneIn: 'Listo · {n} min', error: 'Detenido con un error', waiting: 'Esperando entrada', open: 'Abrir sesión', dismiss: 'Cerrar', test: 'Notificación de prueba' },
  'pt-br': { title: 'Claude · {lane}', done: 'Concluído', doneIn: 'Concluído · {n} min', error: 'Parado com erro', waiting: 'Aguardando entrada', open: 'Abrir sessão', dismiss: 'Fechar', test: 'Notificação de teste' },
  ja: { title: 'Claude · {lane}', done: '完了', doneIn: '完了 · {n} 分', error: 'エラーで停止しました', waiting: '入力待ちです', open: 'セッションを開く', dismiss: '閉じる', test: 'テスト通知' },
  'zh-cn': { title: 'Claude · {lane}', done: '已完成', doneIn: '已完成 · {n} 分钟', error: '出错已停止', waiting: '等待输入', open: '打开会话', dismiss: '关闭', test: '测试通知' },
}

/* ------------------------------------------------------------------ config */

/** VS Code's settings are JSON with comments and trailing commas; strips both, strings kept. */
function stripJsonc(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '"') {
      let j = i + 1
      while (j < raw.length && raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1
      out += raw.slice(i, j + 1)
      i = j
    } else if (c === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2)
      i = end < 0 ? raw.length : end + 1
    } else if (c === ',' && /^\s*[}\]]/.test(raw.slice(i + 1, i + 200))) {
      // a trailing comma: dropped
    } else out += c
  }
  return out
}

function readJsonFile(path, { stripComments = false } = {}) {
  try {
    let raw = readFileSync(path, 'utf8')
    if (stripComments) raw = stripJsonc(raw)
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * When a pause ends: a time, Infinity while paused until resumed, 0 when not paused.
 * Read on every event, so a pause set from any window applies at once. `editor` is
 * honoured by the extension, which is what shows notifications inside VS Code.
 */
function pausedUntil(scope) {
  const until = readJsonFile(PAUSE_PATH)?.[scope]
  if (until === true) return Infinity
  return typeof until === 'number' && until > Date.now() ? until : 0
}

/** `until` is a time, Infinity for until resumed, or null to resume. */
function setPause(scope, until) {
  const pause = readJsonFile(PAUSE_PATH) || {}
  if (until === null) delete pause[scope]
  else pause[scope] = until === Infinity ? true : until
  mkdirSync(dirname(PAUSE_PATH), { recursive: true })
  writeFileSync(PAUSE_PATH, JSON.stringify(pause) + '\n')
}

function describePause(scope) {
  const until = pausedUntil(scope)
  if (!until) return 'on'
  if (until === Infinity) return 'paused until resumed'
  return `paused until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function envFlag(name) {
  const v = process.env[name]
  if (v === undefined || v === '') return undefined
  return !['0', 'false', 'no', 'off'].includes(v.toLowerCase())
}

function loadConfig() {
  const file = readJsonFile(CONFIG_PATH) || {}
  const cfg = { ...DEFAULTS, ...file, events: { ...DEFAULTS.events, ...(file.events || {}) } }

  if (process.env.CLAUDE_NOTIFY_DISABLED === '1') cfg.enabled = false
  const enabled = envFlag('CLAUDE_NOTIFY_ENABLED')
  if (enabled !== undefined) cfg.enabled = enabled
  const sound = envFlag('CLAUDE_NOTIFY_SOUND')
  if (sound !== undefined) cfg.sound = sound
  if (process.env.CLAUDE_NOTIFY_LANG) cfg.language = process.env.CLAUDE_NOTIFY_LANG
  if (process.env.CLAUDE_NOTIFY_STYLE) cfg.style = process.env.CLAUDE_NOTIFY_STYLE
  if (process.env.CLAUDE_NOTIFY_CLICK) cfg.click = process.env.CLAUDE_NOTIFY_CLICK
  for (const [env, key] of [
    ['CLAUDE_NOTIFY_MIN_SECONDS', 'minTurnSeconds'],
    ['CLAUDE_NOTIFY_TIMEOUT', 'waitTimeoutSeconds'],
    ['CLAUDE_NOTIFY_STALE_HOURS', 'staleHours'],
  ]) {
    const v = Number(process.env[env])
    if (process.env[env] !== undefined && process.env[env] !== '' && Number.isFinite(v)) cfg[key] = v
  }
  return cfg
}

/* -------------------------------------------------------------- languages */

/**
 * The session runs in the Claude Code extension's own tab. Not VSCODE_PID: every process
 * started from VS Code's integrated terminal carries that, and such a session has no tab.
 */
function runsInEditor() {
  return (process.env.CLAUDE_CODE_ENTRYPOINT || '').includes('vscode')
}

/** VSCode hands its live UI language to every process it spawns. */
function vscodeEnvLocale() {
  try {
    const cfg = JSON.parse(process.env.VSCODE_NLS_CONFIG || '')
    return cfg.resolvedLanguage || cfg.userLocale || cfg.locale || null
  } catch {
    return null
  }
}

function vscodeLocale() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const candidates = {
    darwin: ['Code', 'Code - Insiders', 'Cursor'].map((d) => join(homedir(), 'Library', 'Application Support', d, 'argv.json')),
    win32: ['Code', 'Code - Insiders', 'Cursor'].map((d) => join(appData, d, 'argv.json')),
    linux: ['Code', 'Code - Insiders', 'Cursor'].map((d) => join(homedir(), '.config', d, 'argv.json')),
  }[platform()] || []
  for (const path of candidates) {
    const parsed = readJsonFile(path, { stripComments: true })
    if (parsed && parsed.locale) return parsed.locale
  }
  return null
}

function normalizeLang(raw) {
  const s = String(raw || '').toLowerCase().replace(/_/g, '-').split('.')[0]
  if (STRINGS[s]) return s
  const base = s.split('-')[0]
  return STRINGS[base] ? base : 'en'
}

function resolveLanguage(cfg) {
  if (cfg.language && cfg.language !== 'auto') return normalizeLang(cfg.language)
  return normalizeLang(vscodeEnvLocale() || vscodeLocale() || process.env.LC_ALL || process.env.LANG || 'en')
}

function t(lang, key, vars = {}) {
  const table = STRINGS[lang] || STRINGS.en
  const raw = table[key] ?? STRINGS.en[key] ?? key
  return raw.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`))
}

/* ------------------------------------------------------------------ state */

function platform() {
  return process.env.CLAUDE_NOTIFY_PLATFORM || process.platform
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'unknown'
}

const turnPath = (id) => join(STATE_DIR, `turn-${safeId(id)}`)
const pidPath = (group) => join(STATE_DIR, `pid-${safeId(group)}`)

function writeState(path, body) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, String(body))
  } catch {}
}

function removeIfMine(path, pid) {
  try {
    if (Number(readFileSync(path, 'utf8').trim()) !== Number(pid)) return
  } catch {
    return
  }
  try { unlinkSync(path) } catch {}
}

/** Kills the presenter still waiting on a notification for this group. */
function killWaiting(path) {
  let pid = null
  try { pid = Number(readFileSync(path, 'utf8').trim()) } catch {}
  if (pid && Number.isFinite(pid)) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  // A delivered notification outlives the process that owns it. Clicking such an
  // orphan makes macOS relaunch the bundle and fail: -609, or "is not open anymore".
  // Do this even when the pid is already gone — that is exactly when it orphans.
  dropNotification(basename(path).replace(/^pid-/, ''))
  try { unlinkSync(path) } catch {}
}

function sweepStale(hours) {
  if (!(hours > 0)) return
  const cutoff = Date.now() - hours * 3600_000
  let entries = []
  try { entries = readdirSync(STATE_DIR) } catch { return }
  for (const name of entries) {
    if (!name.startsWith('pid-') && !name.startsWith('turn-')) continue
    const path = join(STATE_DIR, name)
    try {
      if (statSync(path).mtimeMs > cutoff) continue
      if (name.startsWith('pid-')) killWaiting(path)
      else unlinkSync(path)
    } catch {}
  }
}

/* ------------------------------------------------------------- editor link */

/** Every VS Code window whose extension is listening, most recently focused first. */
function editorLinks() {
  let names = []
  try { names = readdirSync(LINKS_DIR) } catch { return [] }
  const links = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(LINKS_DIR, name)
    const link = readJsonFile(path)
    if (!link || !Number.isInteger(link.port) || typeof link.token !== 'string') continue
    try {
      process.kill(link.pid, 0)
    } catch (err) {
      // EPERM: alive, only not ours to signal. A dry run only looks.
      if (err.code === 'EPERM') { links.push(link); continue }
      if (process.env.CLAUDE_NOTIFY_DRYRUN !== '1') try { unlinkSync(path) } catch {} // left behind by a crashed window
      continue
    }
    links.push(link)
  }
  return links.sort((a, b) => (b.focusedAt || 0) - (a.focusedAt || 0))
}

/**
 * The window that owns a session is the one whose workspace holds the session's folder.
 * There is deliberately no fallback: a window that does not hold the session's project
 * cannot find its transcript, and asking it to open the session shows an empty Claude
 * tab. No owner means no window has it open — better to say so than to guess.
 */
function ownerLink(cwd) {
  const links = editorLinks()
  if (!links.length) return null
  const dir = String(cwd || '').replace(/[/\\]+$/, '')
  let best = null
  let bestLength = -1
  for (const link of links) {
    for (const folder of link.folders || []) {
      const root = String(folder).replace(/[/\\]+$/, '')
      if ((dir === root || dir.startsWith(root + '/')) && root.length > bestLength) {
        best = link
        bestLength = root.length
      }
    }
  }
  return best
}

/**
 * An extension cannot bring its own window to the front — VS Code has no API for it.
 * Opening the window's folder does: VS Code focuses the window that already has it.
 */
function raiseWindow(link) {
  if (platform() !== 'darwin') return
  const target = link.workspaceFile || (link.folders || [])[0]
  if (!target || !existsSync(target)) return
  spawnSync('open', ['-a', link.appName || 'Visual Studio Code', target], { stdio: 'ignore' })
}

/** Resolves true only when the extension answered and said it did the thing. */
function postToEditor(link, path, body, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    try {
      const payload = JSON.stringify(body)
      const req = request({
        host: '127.0.0.1',
        port: link.port,
        path,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-claude-notify-token': link.token,
        },
      }, (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(false)
          try { finish(JSON.parse(raw).ok === true) } catch { finish(false) }
        })
      })
      req.on('timeout', () => { req.destroy(); finish(false) })
      req.on('error', () => finish(false))
      req.end(payload)
    } catch {
      finish(false)
    }
  })
}

/**
 * Prefer the extension: it focuses the tab through the Claude Code extension's own
 * command, which VS Code does not guard. A vscode:// link is guarded — the first
 * click only raises a confirmation prompt. So the link is the fallback, not the path.
 */
async function focusOrOpen(o) {
  // With the extension running, only the owning window may take the click. The bare
  // vscode:// link is kept for when the extension is not installed at all.
  const extensionPresent = editorLinks().length > 0
  const where = o.root || o.cwd
  const link = ownerLink(where)
  if (extensionPresent && !link) {
    debug(`focus session=${o.sessionId}: no window has ${where} open`)
    return 'no-window'
  }
  if (link && UUID.test(String(o.sessionId))) {
    raiseWindow(link)
    const ok = await postToEditor(link, '/focus', { session: o.sessionId }, 1500)
    debug(`focus session=${o.sessionId} window=${link.pid} ok=${ok}`)
    if (ok) {
      markSeen(o.sessionId)
      return 'focused'
    }
  }
  if (o.uri) openUri(o.uri)
  return 'link'
}

/* ----------------------------------------------------------- notification */

/** The extension's own app when it is installed; terminal-notifier otherwise. */
function findNotifier() {
  if (existsSync(HELPER)) return HELPER
  const found = spawnSync('which', ['terminal-notifier'], { encoding: 'utf8' })
  const path = (found.stdout || '').trim()
  if (path && existsSync(path)) return path
  for (const guess of ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier']) {
    if (existsSync(guess)) return guess
  }
  return null
}

/** Drops an already delivered notification, so no orphan is left to click. */
function dropNotification(group) {
  if (platform() !== 'darwin' || !group) return
  const notifier = findNotifier()
  if (!notifier) return
  try { spawnSync(notifier, ['-remove', group], { stdio: 'ignore' }) } catch {}
}

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function windowsToastXml(o) {
  const scenario = o.style === 'alert' ? ' scenario="reminder"' : ''
  const launch = o.uri ? ` activationType="protocol" launch="${xmlEscape(o.uri)}"` : ''
  const actions = []
  if (o.uri) actions.push(`<action activationType="protocol" arguments="${xmlEscape(o.uri)}" content="${xmlEscape(o.openLabel)}"/>`)
  // scenario="reminder" only stays on screen while the toast carries an action
  if (o.style === 'alert') actions.push(`<action activationType="system" arguments="dismiss" content="${xmlEscape(o.dismissLabel)}"/>`)
  return [
    `<toast${scenario}${launch}>`,
    '<visual><binding template="ToastGeneric">',
    `<text>${xmlEscape(o.title)}</text><text>${xmlEscape(o.message)}</text>`,
    '</binding></visual>',
    actions.length ? `<actions>${actions.join('')}</actions>` : '',
    o.sound ? '' : '<audio silent="true"/>',
    '</toast>',
  ].join('')
}

/** Builds the exact command for this platform. Returns null when nothing can deliver. */
function buildPlan(o) {
  const os = platform()

  if (os === 'darwin') {
    const notifier = o.notifierPath ?? findNotifier()
    if (notifier) {
      const args = ['-title', o.title, '-message', o.message]
      if (o.subtitle) args.push('-subtitle', o.subtitle)
      if (o.sound) args.push('-sound', MAC_SOUNDS[o.soundKey] || 'default')
      if (o.group) args.push('-group', o.group)
      // The click command travels inside the notification itself, and nothing waits for
      // an answer. The earlier design kept one waiting terminal-notifier per notification;
      // macOS hands a click to any one of them — they are all the same app — and
      // terminal-notifier does not check whose notification it was, so a fresh click was
      // answered by a 26-minute-old process and took you to the wrong session. With the
      // command stored per notification there is nothing left to mix up. How long it
      // stays on screen is macOS's call: Notifications → Notify for Claude Code → Persistent.
      if (o.focusCommand) args.push('-execute', o.focusCommand)
      else if (o.uri) args.push('-open', o.uri)
      return { cmd: notifier, args, waits: false }
    }
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const sound = o.sound ? ` sound name "${MAC_SOUNDS[o.soundKey] || 'default'}"` : ''
    return {
      cmd: 'osascript',
      args: ['-e', `display notification "${esc(o.message)}" with title "${esc(o.title)}"${o.subtitle ? ` subtitle "${esc(o.subtitle)}"` : ''}${sound}`],
      waits: false,
      degraded: 'no notifying app found: no click action, banner only',
    }
  }

  if (os === 'win32') {
    const tag = safeId(o.group).slice(-16) || 'claude'
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null',
      '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$doc.LoadXml(@'\n${windowsToastXml(o)}\n'@)`,
      '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
      `$toast.Tag = '${tag}'`,
      "$toast.Group = 'claude-notify'",
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}').Show($toast)`,
    ].join('\n')
    return {
      cmd: 'powershell.exe',
      // -EncodedCommand sidesteps every quoting rule between here and PowerShell
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      waits: false,
      script,
    }
  }

  const args = ['-a', 'Claude Code', '-u', o.style === 'alert' ? 'critical' : 'normal']
  if (o.uri && o.style === 'alert') args.push('-A', `open=${o.openLabel}`)
  args.push(o.title, o.message)
  return { cmd: 'notify-send', args, waits: Boolean(o.uri && o.style === 'alert') }
}

function openUri(uri) {
  const os = platform()
  if (os === 'darwin') spawnSync('open', [uri], { stdio: 'ignore' })
  else if (os === 'win32') spawnSync('cmd', ['/c', 'start', '', uri], { stdio: 'ignore' })
  else spawnSync('xdg-open', [uri], { stdio: 'ignore' })
}

/* -------------------------------------------------------------- presenter */

/**
 * The same notification, shown again inside the window that holds the session — only
 * that one, since it is the window whose button can open the session where it already is.
 * The button goes only where a click would: a session in a plain terminal has no tab.
 */
function editorTarget(o) {
  const link = ownerLink(o.root || o.cwd)
  if (!link) return null
  return {
    link,
    body: {
      kind: o.soundKey,
      title: o.title,
      status: o.status || '',
      project: o.project || '',
      text: o.detail ?? o.message,
      // what a window running an older build of the extension shows instead
      subtitle: o.subtitle,
      message: o.message,
      session: o.uri ? o.sessionId : '',
      root: o.root || o.cwd || '',
      openLabel: o.openLabel,
    },
  }
}

function present(o) {
  if (o.debug) debugOn = true
  const plan = buildPlan(o)
  const editor = editorTarget(o)
  if (process.env.CLAUDE_NOTIFY_DRYRUN === '1') {
    console.log(JSON.stringify({ platform: platform(), ...plan, editor: editor && { window: editor.link.folders, body: editor.body } }, null, 2))
    return
  }
  if (editor) {
    postToEditor(editor.link, '/notify', editor.body, 1500)
      .then((ok) => debug(`editor notification window=${editor.link.pid} ok=${ok} group=${o.group}`))
  }
  if (!plan) return
  if (!plan.waits) {
    // Not spawnSync: while it blocks, the request to the editor times out unanswered, and
    // a toast through PowerShell, or terminal-notifier on a busy Mac, takes seconds.
    spawn(plan.cmd, plan.args, { stdio: 'ignore' })
      .on('error', (err) => debug(`notifier error: ${err && err.message}`))
    return
  }

  const path = pidPath(o.group)
  const child = spawn(plan.cmd, plan.args, { stdio: ['ignore', 'pipe', 'pipe'] })
  writeState(path, process.pid)
  debug(`presenter up group=${o.group} ppid=${process.ppid} notifier=${child.pid}`)
  process.on('exit', (code) => debug(`presenter exit code=${code} group=${o.group}`))

  let out = ''
  let err = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { err += chunk })

  let watch = null
  const stop = (reason) => {
    debug(`presenter stop: ${reason} group=${o.group}`)
    if (watch) clearInterval(watch)
    try { child.kill('SIGTERM') } catch {}
    dropNotification(o.group)
    removeIfMine(path, process.pid)
    process.exit(0)
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stop(signal))

  // A notification swiped away without an answer never reports back: terminal-notifier
  // keeps waiting for a reply that cannot come, and the process lives forever. Check
  // now and then that ours is still listed, and leave when it is not. -list does show
  // an alert that is still on screen, so this cannot cut one short.
  if (platform() === 'darwin' && plan.cmd !== 'osascript') {
    watch = setInterval(() => {
      const res = spawnSync(plan.cmd, ['-list', o.group], { encoding: 'utf8' })
      if (res.status !== 0) return // cannot tell: better to wait than to drop a live one
      const listed = (res.stdout || '').split('\n').slice(1).some((row) => row.split('\t')[0] === o.group)
      if (!listed) stop('notification gone without an answer')
    }, 30_000)
    watch.unref()
  }

  child.on('error', (err) => {
    debug(`notifier error: ${err && err.message}`)
    removeIfMine(path, process.pid)
  })
  child.on('close', (code, signal) => {
    if (watch) clearInterval(watch)
    debug(`notifier closed code=${code} signal=${signal} answer=${JSON.stringify(out.trim())} stderr=${JSON.stringify(err.trim().slice(0, 300))}`)
    removeIfMine(path, process.pid)
    // libnotify older than 0.8 has no -A: fall back to a plain notification
    if (code !== 0 && plan.args.includes('-A')) {
      const stripped = plan.args.filter((a, i) => a !== '-A' && plan.args[i - 1] !== '-A')
      spawnSync(plan.cmd, stripped, { stdio: 'ignore' })
      return
    }
    const answer = out.trim()
    if (o.uri && !RESOLVED_WITHOUT_CLICK.has(answer)) {
      // No window of its own: do nothing rather than guess. "No window" can also mean a
      // window whose extension is between restarts, and opening a folder then spawns a
      // second window of a project that is already open.
      focusOrOpen(o)
    }
  })
}

function spawnPresenter(o) {
  if (process.env.CLAUDE_NOTIFY_DRYRUN === '1') {
    console.log(JSON.stringify(o, null, 2))
    return
  }
  try {
    const child = spawn(process.execPath, [SELF, '--show', JSON.stringify(o)], {
      detached: true,
      stdio: 'ignore',
    })
    debug(`spawned presenter pid=${child.pid} group=${o.group}`)
    child.unref()
  } catch (err) {
    debug(`could not spawn presenter: ${err && err.message}`)
  }
}

/* --------------------------------------------------------- session registry */

const sessionPath = (id) => join(SESSIONS_DIR, `${safeId(id)}.json`)

/**
 * Where the session was started, which is where its tab lives. The hook reports the
 * current directory instead, and a session that has moved on to another repository
 * reports that one — a window that does not hold it would open the session empty.
 * Claude Code writes the starting directory into the transcript's first records.
 */
function readRoot(transcriptPath) {
  if (!transcriptPath) return ''
  let fd
  try {
    fd = openSync(transcriptPath, 'r')
    const buf = Buffer.alloc(64 * 1024)
    const length = readSync(fd, buf, 0, buf.length, 0)
    for (const line of buf.toString('utf8', 0, length).split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const record = JSON.parse(line)
        if (typeof record.cwd === 'string' && record.cwd) return record.cwd
      } catch {} // the last line may be cut
    }
  } catch {
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
  return ''
}

/**
 * The session's title — the one Claude Code shows in its tab — is appended to the
 * transcript on every turn, so the latest sits near the end. A name the user gave the
 * tab wins over the one Claude chose, as it does on the tab.
 */
function readTitle(transcriptPath) {
  if (!transcriptPath) return ''
  let fd
  try {
    fd = openSync(transcriptPath, 'r')
    const size = statSync(transcriptPath).size
    const length = Math.min(size, 128 * 1024)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    const titles = { aiTitle: '', customTitle: '' }
    for (const match of buf.toString('utf8').matchAll(/"(aiTitle|customTitle)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      try { titles[match[1]] = JSON.parse(`"${match[2]}"`) } catch {}
    }
    return titles.customTitle || titles.aiTitle
  } catch {
    return ''
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

/**
 * Claude Code sends Notification for three different things. Only two of them need you:
 * a permission and a question. The third, idle_prompt, is "waiting for your input" some
 * minutes after a turn ended — the same news as the Stop that already announced it, and
 * showing it replaced that notification with a vaguer one.
 */
function isIdleNotice(data) {
  if (data.notification_type) return data.notification_type === 'idle_prompt'
  return /waiting for your input/i.test(String(data.message || '')) // older Claude Code
}

/** The registry knows it once recorded; otherwise read it from the transcript. */
function sessionRoot(id, transcriptPath, fallback) {
  const entry = readJsonFile(sessionPath(id)) || {}
  return entry.root || readRoot(transcriptPath || entry.transcript) || fallback || ''
}

/**
 * Every window's status bar lists every active session, so the list lives on disk
 * rather than in one window's memory — it also survives a window reload that way.
 * Only the state goes here; title and context size are read fresh from the
 * transcript when someone looks, since they change on every turn.
 */
function recordSession(event, data) {
  const id = data.session_id
  if (!id || !UUID.test(String(id))) return
  const path = sessionPath(id)
  if (event === 'Stop' || event === 'StopFailure') {
    // Kept, not deleted: Claude Code appends a few housekeeping lines to the transcript
    // just after a turn ends, and without this mark that write would read as a new turn.
    const prev = readJsonFile(path) || {}
    const cwd = String(data.cwd || prev.cwd || '')
    const root = prev.root || readRoot(data.transcript_path) || cwd
    writeState(path, JSON.stringify({
      ...prev,
      session: id,
      state: 'done',
      message: '',
      cwd,
      root,
      project: basename(root.replace(/[/\\]+$/, '')) || root,
      transcript: String(data.transcript_path || prev.transcript || ''),
      at: Date.now(),
    }))
    return
  }
  if (event !== 'UserPromptSubmit' && event !== 'Notification') return
  if (event === 'Notification' && isIdleNotice(data)) return
  const cwd = String(data.cwd || '')
  const root = sessionRoot(id, data.transcript_path, cwd)
  // When the user last wrote to it: the session they last wrote to is the one a window's
  // Claude sidebar nearly always shows.
  const promptedAt = event === 'UserPromptSubmit' ? Date.now() : (readJsonFile(path) || {}).promptedAt
  writeState(path, JSON.stringify({
    session: id,
    ...(promptedAt ? { promptedAt } : {}),
    state: event === 'Notification' ? 'waiting' : 'running',
    message: event === 'Notification' ? String(data.message || '') : '',
    cwd,
    root,
    project: basename(root.replace(/[/\\]+$/, '')) || root,
    transcript: String(data.transcript_path || ''),
    at: Date.now(),
  }))
}

function pruneSessions() {
  let names = []
  try { names = readdirSync(SESSIONS_DIR) } catch { return }
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const name of names) {
    const path = join(SESSIONS_DIR, name)
    const entry = readJsonFile(path)
    if (!entry || !(entry.at > cutoff)) {
      try { unlinkSync(path) } catch {}
    }
  }
}

/** The user went to a waiting session: it no longer needs to call for attention. */
function markSeen(sessionId) {
  const path = sessionPath(sessionId)
  const entry = readJsonFile(path)
  if (!entry || entry.state !== 'waiting') return
  writeState(path, JSON.stringify({ ...entry, state: 'running', message: '', at: Date.now() }))
}

/** Single-quoted for /bin/sh, which is what runs an -execute command. */
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

/**
 * What a click runs. It may run long after this hook has exited — after a plugin update
 * even — so it names a node binary and a script that will still be there: the copy the
 * VS Code extension keeps at a fixed path when present, this file otherwise.
 */
function focusCommandFor(sessionId, root) {
  if (existsSync(RUNNER)) return [RUNNER, '--focus', sessionId, root || ''].map(shellQuote).join(' ')
  const stable = join(homedir(), '.claude', 'claude-notify', 'claude-notify.mjs')
  const script = existsSync(stable) ? stable : SELF
  return [process.execPath, script, '--focus', sessionId, root || ''].map(shellQuote).join(' ')
}

/**
 * The opening of the model's last written answer — enough to recognise the session
 * from the notification without switching to it. Markdown is stripped; the first
 * sentence is kept when it fits.
 */
function readLastReply(transcriptPath, limit = 140) {
  if (!transcriptPath) return ''
  let fd
  try {
    fd = openSync(transcriptPath, 'r')
    const size = statSync(transcriptPath).size
    const length = Math.min(size, 512 * 1024)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    const lines = buf.toString('utf8').split('\n')
    if (size > length) lines.shift() // starts mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"') || !lines[i].includes('"text"')) continue
      let record
      try { record = JSON.parse(lines[i]) } catch { continue }
      if (record.type !== 'assistant') continue
      const text = (record.message?.content || [])
        .filter((part) => part && part.type === 'text' && part.text)
        .map((part) => part.text).join(' ')
        // an answer that opens by naming its audience says nothing about what was done
        .replace(/^\s*Written for:[^\n]*\n+/i, '')
      const plain = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_`#>|]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (!plain) continue
      if (plain.length <= limit) return plain
      const sentence = plain.match(/^.{20,}?[.!?…](?=\s)/)
      if (sentence && sentence[0].length <= limit) return sentence[0]
      return plain.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…'
    }
  } catch {
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
  return ''
}

/* ------------------------------------------------------------- hook logic */

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {}
    const raw = readFileSync(0, 'utf8')
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `message` is the whole text of the system notification. `status` and `detail` are the
 * same news in two parts, for the window to lay out on its own: "Done · 3 min" and how
 * the answer began. Without them, the message is the detail.
 */
function compose(cfg, lang, { sessionId, lane, message, status = '', detail = message, soundKey, cwd, root, sessionTitle }) {
  const group = cfg.groupPerSession ? `claude-${safeId(sessionId)}` : `claude-${safeId(sessionId)}-${Date.now()}`
  const wantsClick = cfg.click === 'focusSession' || (cfg.click === 'auto' && runsInEditor())
  const uri = wantsClick && UUID.test(String(sessionId))
    ? `${cfg.uriScheme}://${cfg.extensionId}/open?session=${sessionId}`
    : ''
  const focusCommand = uri ? focusCommandFor(sessionId, root || cwd) : ''
  return {
    // Several sessions in one project are told apart by their titles, not the folder.
    title: (sessionTitle || t(lang, 'title', { lane })).slice(0, 120),
    subtitle: sessionTitle ? t(lang, 'title', { lane }).slice(0, 120) : '',
    message: String(message).replace(/\s+/g, ' ').slice(0, 240),
    status: String(status).slice(0, 120),
    detail: String(detail).replace(/\s+/g, ' ').slice(0, 240),
    // Only beside a session's own title: without one, the project already is the title.
    project: sessionTitle ? String(lane).slice(0, 120) : '',
    openLabel: t(lang, 'open'),
    dismissLabel: t(lang, 'dismiss'),
    soundKey,
    sound: cfg.sound,
    style: cfg.style,
    waitTimeoutSeconds: cfg.waitTimeoutSeconds,
    group,
    uri,
    focusCommand,
    sessionId,
    cwd: cwd || '',
    root: root || '',
    debug: Boolean(cfg.debug),
  }
}

function notify(cfg, payload) {
  if (cfg.groupPerSession) killWaiting(pidPath(`claude-${safeId(payload.sessionId)}`))
  sweepStale(cfg.staleHours)
  // The older notification still goes: it is out of date either way.
  if (pausedUntil('all')) {
    debug(`paused: no notification for session=${payload.sessionId}`)
    return
  }
  spawnPresenter(compose(cfg, resolveLanguage(cfg), payload))
}

async function hookMode() {
  const cfg = loadConfig()
  const data = readStdinJson()
  const event = data.hook_event_name || ''
  const sessionId = data.session_id || ''

  // The session list counts sessions whether or not notifications are on, so the
  // registry hears every main-agent event before any of the early returns below.
  if (cfg.debug) debugOn = true
  debug(`hook ${event} session=${sessionId} subagent=${Boolean(data.agent_id)} ppid=${process.ppid}`)
  if (!data.agent_id) {
    recordSession(event, data)
    pruneSessions()
  }

  if (!cfg.enabled) return

  if (event === 'UserPromptSubmit') {
    writeState(turnPath(sessionId), Date.now())
    // You are back in this session: whatever it announced before is old news, and an
    // old notification left in the stack is one a click can land on by mistake.
    killWaiting(pidPath(`claude-${safeId(sessionId)}`))
    return
  }
  if (data.agent_id) return // subagents stay silent; only the main agent reports

  const lang = resolveLanguage(cfg)
  // Named after where the session lives, not where it has wandered off to since.
  const root = sessionRoot(sessionId, data.transcript_path, data.cwd)
  const sessionTitle = readTitle(data.transcript_path)
  const lane = basename(String(root || data.cwd || process.cwd()).replace(/[/\\]+$/, '')) || 'claude'

  if (event === 'Notification') {
    if (!cfg.events.waitingInput || isIdleNotice(data)) return
    notify(cfg, { sessionId, lane, cwd: data.cwd, root, sessionTitle, message: data.message || t(lang, 'waiting'), soundKey: 'waiting' })
    return
  }

  if (event !== 'Stop' && event !== 'StopFailure') return

  let elapsed = null
  const mark = turnPath(sessionId)
  try {
    elapsed = (Date.now() - Number(readFileSync(mark, 'utf8').trim())) / 1000
    unlinkSync(mark)
  } catch {}

  if (event === 'StopFailure') {
    if (!cfg.events.error) return
    notify(cfg, { sessionId, lane, cwd: data.cwd, root, sessionTitle, message: t(lang, 'error'), status: t(lang, 'error'), detail: '', soundKey: 'error' })
    return
  }

  if (!cfg.events.done) return
  // a short turn is one you watched happen: stay quiet
  if (elapsed !== null && elapsed < cfg.minTurnSeconds) return
  const status = elapsed === null
    ? t(lang, 'done')
    : t(lang, 'doneIn', { n: Math.max(1, Math.round(elapsed / 60)) })
  const reply = readLastReply(data.transcript_path)
  const message = reply ? `${status} — ${reply}` : status
  notify(cfg, { sessionId, lane, cwd: data.cwd, root, sessionTitle, message, status, detail: reply, soundKey: 'done' })
}

/* --------------------------------------------------------------- entry */

function main() {
  const [mode, arg] = process.argv.slice(2)

  if (mode === '--show') {
    present(JSON.parse(arg))
    return
  }
  if (mode === '--help' || mode === '-h') {
    const header = readFileSync(SELF, 'utf8').split('*/')[0]
    console.log(header.replace(/^#!.*\n/, '').replace(/^\/\*\*\n?/, '').replace(/^ ?\* ?/gm, '').trimEnd())
    return
  }
  if (mode === '--config') {
    const cfg = loadConfig()
    console.log(JSON.stringify({
      configPath: CONFIG_PATH,
      configFileExists: existsSync(CONFIG_PATH),
      platform: platform(),
      language: resolveLanguage(cfg),
      vscodeEnvLocale: vscodeEnvLocale(),
      vscodeArgvLocale: vscodeLocale(),
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || null,
      runsInEditor: runsInEditor(),
      availableLanguages: Object.keys(STRINGS),
      paused: { all: describePause('all'), editor: describePause('editor') },
      config: cfg,
    }, null, 2))
    return
  }
  if (mode === '--init-config') {
    mkdirSync(join(homedir(), '.claude'), { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n')
    console.log(`wrote ${CONFIG_PATH}`)
    return
  }
  if (mode === '--list') {
    if (platform() !== 'darwin') {
      console.log('--list is macOS only; on Windows use the Action Center, on Linux your notification applet')
      return
    }
    const notifier = findNotifier()
    if (!notifier) { console.log('no notifying app installed'); return }
    const res = spawnSync(notifier, ['-list', 'ALL'], { encoding: 'utf8' })
    process.stdout.write(res.stdout || '')
    return
  }
  if (mode === '--pause' || mode === '--resume') {
    const rest = process.argv.slice(3)
    const scopes = rest.includes('--editor') ? ['editor'] : mode === '--resume' ? ['all', 'editor'] : ['all']
    const minutes = Number(rest.find((a) => /^\d+$/.test(a)))
    for (const scope of scopes) setPause(scope, mode === '--resume' ? null : minutes > 0 ? Date.now() + minutes * 60_000 : Infinity)
    console.log(`notifications: ${describePause('all')}`)
    console.log(`inside VS Code: ${describePause('editor')}`)
    return
  }
  if (mode === '--focus') {
    // The status bar list: go to a session, raising whichever window owns it.
    const cfg = loadConfig()
    if (cfg.debug) debugOn = true
    const entry = readJsonFile(sessionPath(arg)) || {}
    const cwd = process.argv[4] || entry.cwd || ''
    return focusOrOpen({
      sessionId: arg,
      cwd,
      root: entry.root || process.argv[4] || '',
      uri: UUID.test(String(arg)) ? `${cfg.uriScheme}://${cfg.extensionId}/open?session=${arg}` : '',
    }).then((outcome) => { process.stdout.write(`${outcome}\n`) })
  }
  if (mode === '--doctor') {
    doctor()
    return
  }
  if (mode === '--test') {
    const cfg = loadConfig()
    const lang = resolveLanguage(cfg)
    spawnPresenter(compose(cfg, lang, {
      sessionId: arg || 'test',
      lane: basename(process.cwd()),
      cwd: process.cwd(),
      message: t(lang, 'test'),
      soundKey: 'done',
    }))
    return
  }
  return hookMode()
}

/* ------------------------------------------------------------------ doctor */

const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification']

/**
 * macOS hides every notification while the screen is mirrored, shared or recorded, unless
 * "When mirroring or sharing the display" is on. Read through cfprefsd: the file on disk
 * lags behind the switch. null when it cannot tell.
 */
function hiddenWhileSharing() {
  if (platform() !== 'darwin') return false
  const res = spawnSync('/bin/sh', ['-c',
    'defaults export com.apple.ncprefs - | plutil -extract dnd_prefs raw -o - - | base64 -D | plutil -convert json -o - -',
  ], { encoding: 'utf8' })
  try { return JSON.parse(res.stdout).dndMirrored === true } catch { return null }
}

/** The claude-notify plugin brings its own hooks — unless it is switched off. */
function pluginActive() {
  const plugins = readJsonFile(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'))?.plugins || {}
  const enabled = readJsonFile(join(homedir(), '.claude', 'settings.json'))?.enabledPlugins || {}
  return Object.keys(plugins).some((k) => k.startsWith('claude-notify@') && enabled[k] !== false)
}

/** Hooks wired by hand in settings files — the plugin's own hooks are not listed there. */
function settingsHooks() {
  const files = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.local.json'),
    join(process.cwd(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.local.json'),
  ]
  const found = []
  for (const file of files) {
    const data = readJsonFile(file)
    if (!data || !data.hooks) continue
    for (const event of HOOK_EVENTS) {
      for (const entry of data.hooks[event] || []) {
        for (const hook of entry.hooks || []) {
          if (hook.command) found.push({ file, event, command: String(hook.command) })
        }
      }
    }
  }
  return found
}

/**
 * VS Code asks once before letting an external vscode:// link reach an extension and
 * remembers the answer. Until it is answered the click only raises the window, which
 * looks exactly like a link pointing at the wrong session.
 */
function editorTrustsLink(extensionId) {
  const db = join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb')
  if (!existsSync(db)) return null
  const res = spawnSync('sqlite3', [
    `file:${db}?mode=ro`,
    "select value from ItemTable where key='extensionUrlHandler.confirmedExtensions';",
  ], { encoding: 'utf8' })
  if (res.status !== 0) return null
  try {
    const list = JSON.parse((res.stdout || '').trim() || '[]')
    return list.some((id) => String(id).toLowerCase() === String(extensionId).toLowerCase())
  } catch {
    return null
  }
}

/** Notifications still on screen whose owning process is gone: clicking one fails. */
function orphanGroups(notifier) {
  const res = spawnSync(notifier, ['-list', 'ALL'], { encoding: 'utf8' })
  const rows = (res.stdout || '').trim().split('\n').slice(1).filter(Boolean)
  const orphans = []
  for (const row of rows) {
    const group = row.split('\t')[0]
    if (!group) continue
    let pid = null
    try { pid = Number(readFileSync(pidPath(group), 'utf8').trim()) } catch {}
    if (!pid) { orphans.push(group); continue }
    try { process.kill(pid, 0) } catch { orphans.push(group) }
  }
  return orphans
}

function doctor() {
  const cfg = loadConfig()
  const out = []
  const say = (mark, text) => out.push(`${mark}  ${text}`)
  let problems = 0
  const fail = (text) => { problems += 1; say('FAIL', text) }
  const warn = (text) => { problems += 1; say('warn', text) }
  const ok = (text) => say('ok  ', text)

  if (!cfg.enabled) fail(`disabled in ${CONFIG_PATH} — set "enabled": true, nothing will fire`)
  else ok('enabled')
  if (pausedUntil('all')) warn(`notifications are ${describePause('all')} — \`--resume\` turns them back on`)
  if (pausedUntil('editor')) say('    ', `notifications inside VS Code are ${describePause('editor')}`)

  if (platform() !== 'darwin') {
    warn(`platform ${platform()} is not covered: this plugin targets macOS with VS Code`)
  } else {
    const notifier = findNotifier()
    let allowed = false
    if (!notifier) {
      warn('no notifying app: neither Notify for Claude Code nor terminal-notifier — falling back to osascript: banner only, no click')
    } else if (notifier === HELPER) {
      const probe = spawnSync(HELPER, ['-status'], { encoding: 'utf8' })
      const status = (probe.stdout || '').trim()
      if (probe.status === 0) {
        allowed = true
        ok('Notify for Claude Code may show notifications')
        const style = ((probe.stdout || '').match(/^style: (\w+)$/m) || [])[1]
        if (style === 'banner') say('    ', 'they slide away after a few seconds — for ones that stay, set System Settings → Notifications → Notify for Claude Code → Persistent')
        if (hiddenWhileSharing()) say('    ', 'macOS hides them while the screen is shared or recorded — to see them in a call or a recording, turn on System Settings → Notifications → "When mirroring or sharing the display"')
        else if (style === 'none') warn('alerts are off for Notify for Claude Code — they only collect in Notification Centre; turn them on in System Settings → Notifications')
      } else if (status === 'notDetermined') {
        warn('Notify for Claude Code has not been allowed to notify yet — run "Notify for Claude Code: Allow notifications" in VS Code')
      } else {
        fail('macOS denies notifications to Notify for Claude Code — turn them on in System Settings → Notifications')
      }
    } else {
      const probe = spawnSync(notifier, ['-list', 'ALL'], { encoding: 'utf8' })
      if (probe.status === 3 || /not allowed/i.test(probe.stderr || '')) {
        fail('macOS denies notifications to terminal-notifier — launch its .app bundle once via `open -a` to get the prompt')
      } else {
        allowed = true
        ok(`terminal-notifier at ${notifier}`)
      }
    }
    if (allowed) {
      // Nothing waits for a click any more — the command rides in the notification — so a
      // notification without a process is normal. What does matter is a waiting process
      // left over from an older version: it takes clicks meant for other notifications.
      const waiting = spawnSync('pgrep', ['-f', 'claude-notify.mjs --show'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
      if (waiting.length) warn(`${waiting.length} waiting notifier process(es) from an older version — they can take clicks meant for other sessions; stop them with \`pkill -f 'claude-notify.mjs --show'\``)
      else ok('no leftover waiting notifiers')
    }
  }

  // The extension's runner starts hooks with the editor's own runtime. If the editor has
  // moved since, the runner falls back to a node on PATH, which may not exist.
  if (existsSync(RUNNER)) {
    const runtime = (readFileSync(RUNNER, 'utf8').match(/^runtime='(.*)'$/m) || [])[1]
    if (runtime && existsSync(runtime)) ok('hooks run with the editor\'s own runtime — no Node.js needed')
    else warn(`the runner's runtime is gone (${runtime || 'unreadable'}) — restart VS Code so the extension rewrites it`)
  }

  if (!runsInEditor()) {
    warn('not running under the VS Code extension — notifications still fire, but there is no tab to click through to')
  } else if (editorLinks().length) {
    const windows = editorLinks().length
    ok(`running under the editor (${process.env.CLAUDE_CODE_ENTRYPOINT || 'vscode'})`)
    ok(`The Notify for Claude Code extension is listening in ${windows} window${windows > 1 ? 's' : ''} — clicks go to the window that owns the session`)
  } else {
    ok(`running under the editor (${process.env.CLAUDE_CODE_ENTRYPOINT || 'vscode'})`)
    say('    ', 'The Notify for Claude Code extension is not running — clicks use vscode:// links instead')
    const trusted = editorTrustsLink(cfg.extensionId)
    if (trusted === false) warn(`VS Code has not been told to trust links to ${cfg.extensionId} — the first click shows a confirmation prompt; answer it once`)
    else if (trusted === null) say('    ', `could not read VS Code's trusted-link list (sqlite3 unavailable or no state db)`)
    else ok(`VS Code trusts links to ${cfg.extensionId}`)
  }

  // Where Claude Code opens a session decides what a click does: reveal its tab, or switch
  // the sidebar to it. Left at the default, a session kept in the sidebar gets a second
  // view in a tab instead.
  const vscodeSettings = readJsonFile(join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'), { stripComments: true }) || {}
  const location = vscodeSettings['claudeCode.preferredLocation'] || 'panel (default)'
  if (location === 'sidebar') ok('Claude opens sessions in the sidebar — a click switches it to the session')
  else say('    ', `Claude opens sessions in editor tabs (claudeCode.preferredLocation: ${location}). If you keep Claude in the sidebar, set it to "sidebar", or a click will open the session in a tab beside it`)

  // The extension wires its hooks into settings.json, and that is the one place they
  // belong. They double up only beside the plugin's own, or when wired twice.
  const manual = settingsHooks()
  const ours = manual.filter((h) => h.command.includes('claude-notify'))
  const others = manual.filter((h) => !h.command.includes('claude-notify'))
  const plugin = pluginActive()
  const twice = HOOK_EVENTS.some((event) => ours.filter((h) => h.event === event).length > 1)
  const files = [...new Set(ours.map((h) => h.file))].join(', ')
  if (ours.length && plugin) {
    fail(`claude-notify is wired in ${files} as well as by the claude-notify plugin — remove those entries or every notification fires twice`)
  } else if (twice) {
    fail(`claude-notify is wired more than once for the same event in ${files} — every notification fires twice`)
  } else ok('no duplicate wiring')
  if (others.length) {
    const label = (cmd) => {
      const script = cmd.match(/([\w.-]+\.(?:mjs|cjs|js|py|sh|ts))/)
      return script ? script[1] : cmd.trim().split(/\s+/)[0].slice(0, 30)
    }
    const where = [...new Set(others.map((h) => label(h.command)))]
    say('    ', `other tools hook the same events: ${where.join(', ')} — harmless unless they also show desktop notifications`)
  }

  console.log(out.join('\n'))
  console.log(problems === 0 ? '\nAll good.' : `\n${problems} thing(s) to look at.`)
}

// a notifier must never break the session it reports on
Promise.resolve().then(main).catch(() => {})
