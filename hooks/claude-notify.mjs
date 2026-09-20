#!/usr/bin/env node
/**
 * claude-notify — cross-platform desktop notifications for Claude Code sessions.
 *
 * Wire it as a Claude Code hook on UserPromptSubmit, Stop, StopFailure and
 * Notification. It tells you when a session has finished and when one is
 * waiting for you, and a click takes you to that session's tab in the editor.
 *
 * Zero dependencies: it drives the notifier the OS already ships —
 * terminal-notifier or osascript on macOS, a WinRT toast through PowerShell on
 * Windows, notify-send on Linux.
 *
 * Modes:
 *   (no args)       hook mode; reads the hook payload as JSON on stdin
 *   --show <json>   internal; the detached presenter process
 *   --test          send a sample notification
 *   --config        print the effective configuration and the resolved language
 *   --doctor        check the environment and report what is broken
 *   --init-config   write a config file with every key at its default
 *   --list          list delivered notifications (macOS only)
 *   --help
 *
 * click: "auto" attaches the editor deep link only when the session actually
 * runs under the editor extension; a terminal session still gets the
 * notification, just without a click target.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const STATE_DIR = join(tmpdir(), 'claude-notify')
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

function readJsonFile(path, { stripComments = false } = {}) {
  try {
    let raw = readFileSync(path, 'utf8')
    if (stripComments) raw = raw.replace(/^\s*\/\/.*$/gm, '')
    return JSON.parse(raw)
  } catch {
    return null
  }
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

/** The session runs under the editor extension, not in a bare terminal. */
function runsInEditor() {
  const entry = process.env.CLAUDE_CODE_ENTRYPOINT || ''
  return entry.includes('vscode') || Boolean(process.env.VSCODE_PID)
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
    mkdirSync(STATE_DIR, { recursive: true })
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

/* ----------------------------------------------------------- notification */

function findTerminalNotifier() {
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
  const notifier = findTerminalNotifier()
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
    const notifier = o.notifierPath ?? findTerminalNotifier()
    if (notifier) {
      const args = ['-title', o.title, '-message', o.message]
      if (o.sound) args.push('-sound', MAC_SOUNDS[o.soundKey] || 'default')
      if (o.group) args.push('-group', o.group)
      if (o.uri) args.push('-open', o.uri)
      let waits = false
      if (o.style === 'alert') {
        // -action forces alert style: the notification waits instead of fading
        args.push('-action', o.openLabel)
        if (o.waitTimeoutSeconds > 0) args.push('-timeout', String(o.waitTimeoutSeconds))
        waits = true
      }
      return { cmd: notifier, args, waits }
    }
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const sound = o.sound ? ` sound name "${MAC_SOUNDS[o.soundKey] || 'default'}"` : ''
    return {
      cmd: 'osascript',
      args: ['-e', `display notification "${esc(o.message)}" with title "${esc(o.title)}"${sound}`],
      waits: false,
      degraded: 'terminal-notifier not found: no click action, banner only',
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

function present(o) {
  const plan = buildPlan(o)
  if (!plan) return
  if (process.env.CLAUDE_NOTIFY_DRYRUN === '1') {
    console.log(JSON.stringify({ platform: platform(), ...plan }, null, 2))
    return
  }
  if (!plan.waits) {
    spawnSync(plan.cmd, plan.args, { stdio: 'ignore' })
    return
  }

  const path = pidPath(o.group)
  const child = spawn(plan.cmd, plan.args, { stdio: ['ignore', 'pipe', 'ignore'] })
  writeState(path, process.pid)

  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })

  const stop = () => {
    try { child.kill('SIGTERM') } catch {}
    dropNotification(o.group)
    removeIfMine(path, process.pid)
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  child.on('error', () => removeIfMine(path, process.pid))
  child.on('close', (code) => {
    removeIfMine(path, process.pid)
    // libnotify older than 0.8 has no -A: fall back to a plain notification
    if (code !== 0 && plan.args.includes('-A')) {
      const stripped = plan.args.filter((a, i) => a !== '-A' && plan.args[i - 1] !== '-A')
      spawnSync(plan.cmd, stripped, { stdio: 'ignore' })
      return
    }
    const answer = out.trim()
    if (o.uri && !RESOLVED_WITHOUT_CLICK.has(answer)) openUri(o.uri)
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
    child.unref()
  } catch {}
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

function compose(cfg, lang, { sessionId, lane, message, soundKey }) {
  const group = cfg.groupPerSession ? `claude-${safeId(sessionId)}` : `claude-${safeId(sessionId)}-${Date.now()}`
  const wantsClick = cfg.click === 'focusSession' || (cfg.click === 'auto' && runsInEditor())
  const uri = wantsClick && UUID.test(String(sessionId))
    ? `${cfg.uriScheme}://${cfg.extensionId}/open?session=${sessionId}`
    : ''
  return {
    title: t(lang, 'title', { lane }).slice(0, 120),
    message: String(message).replace(/\s+/g, ' ').slice(0, 220),
    openLabel: t(lang, 'open'),
    dismissLabel: t(lang, 'dismiss'),
    soundKey,
    sound: cfg.sound,
    style: cfg.style,
    waitTimeoutSeconds: cfg.waitTimeoutSeconds,
    group,
    uri,
  }
}

function notify(cfg, payload) {
  if (cfg.groupPerSession) killWaiting(pidPath(`claude-${safeId(payload.sessionId)}`))
  sweepStale(cfg.staleHours)
  spawnPresenter(compose(cfg, resolveLanguage(cfg), payload))
}

function hookMode() {
  const cfg = loadConfig()
  if (!cfg.enabled) return
  const data = readStdinJson()
  const event = data.hook_event_name || ''
  const sessionId = data.session_id || ''

  if (event === 'UserPromptSubmit') {
    writeState(turnPath(sessionId), Date.now())
    return
  }
  if (data.agent_id) return // subagents stay silent; only the main agent reports

  const lang = resolveLanguage(cfg)
  const lane = basename(String(data.cwd || process.cwd()).replace(/[/\\]+$/, '')) || 'claude'

  if (event === 'Notification') {
    if (!cfg.events.waitingInput) return
    notify(cfg, { sessionId, lane, message: data.message || t(lang, 'waiting'), soundKey: 'waiting' })
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
    notify(cfg, { sessionId, lane, message: t(lang, 'error'), soundKey: 'error' })
    return
  }

  if (!cfg.events.done) return
  // a short turn is one you watched happen: stay quiet
  if (elapsed !== null && elapsed < cfg.minTurnSeconds) return
  const message = elapsed === null
    ? t(lang, 'done')
    : t(lang, 'doneIn', { n: Math.max(1, Math.round(elapsed / 60)) })
  notify(cfg, { sessionId, lane, message, soundKey: 'done' })
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
    const notifier = findTerminalNotifier()
    if (!notifier) { console.log('terminal-notifier not installed'); return }
    const res = spawnSync(notifier, ['-list', 'ALL'], { encoding: 'utf8' })
    process.stdout.write(res.stdout || '')
    return
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
      message: t(lang, 'test'),
      soundKey: 'done',
    }))
    return
  }
  hookMode()
}

/* ------------------------------------------------------------------ doctor */

const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification']

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

  if (platform() !== 'darwin') {
    warn(`platform ${platform()} is not covered: this plugin targets macOS with VS Code`)
  } else {
    const notifier = findTerminalNotifier()
    if (!notifier) {
      warn('terminal-notifier not found — falling back to osascript: banner only, no click')
    } else {
      const probe = spawnSync(notifier, ['-list', 'ALL'], { encoding: 'utf8' })
      if (probe.status === 3 || /not allowed/i.test(probe.stderr || '')) {
        fail('macOS denies notifications to terminal-notifier — launch its .app bundle once via `open -a` to get the prompt')
      } else {
        ok(`terminal-notifier at ${notifier}`)
        const orphans = orphanGroups(notifier)
        if (orphans.length) warn(`${orphans.length} notification(s) with no live owner — clicking one raises -609; clear with \`terminal-notifier -remove ALL\``)
        else ok('no orphaned notifications')
      }
    }
  }

  if (!runsInEditor()) {
    warn('not running under the VS Code extension — notifications still fire, but there is no tab to click through to')
  } else {
    ok(`running under the editor (${process.env.CLAUDE_CODE_ENTRYPOINT || 'vscode'})`)
    const trusted = editorTrustsLink(cfg.extensionId)
    if (trusted === false) warn(`VS Code has not been told to trust links to ${cfg.extensionId} — the first click shows a confirmation prompt; answer it once`)
    else if (trusted === null) say('    ', `could not read VS Code's trusted-link list (sqlite3 unavailable or no state db)`)
    else ok(`VS Code trusts links to ${cfg.extensionId}`)
  }

  const manual = settingsHooks()
  const ours = manual.filter((h) => h.command.includes('claude-notify'))
  const others = manual.filter((h) => !h.command.includes('claude-notify'))
  if (ours.length) {
    fail(`claude-notify is also wired by hand in ${[...new Set(ours.map((h) => h.file))].join(', ')} — remove those entries or every notification fires twice`)
  } else ok('no duplicate wiring in settings files')
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

try {
  main()
} catch {
  // a notifier must never break the session it reports on
}
