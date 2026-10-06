import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdirSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import {
  helperPath, hooksOutdated, hooksWired, installHelper, installScript, legacyLinkPath, linkPath,
  linksDir, pausedUntil, pausePath, pluginInstalled, sessionsDir, setPause, unwireHooks, wireHooks,
  writeConfig, writeRunner, type PauseScope,
} from './wiring'
import { ago, lastPrompted, markSeen, modelName, ownerOf, readDetails, readSessions, tokens, windowName, type Session } from './sessions'
import { tabShowsTitle, toastFor } from './toast'

/**
 * The notifier runs outside the editor — it is a hook, spawned per event, and macOS
 * notifications cannot come from an extension at all. So the halves meet on disk and
 * over a loopback socket:
 *
 * - the notifier keeps one file per active session in ~/.claude/claude-notify/sessions,
 *   which every window reads for its status bar;
 * - each window writes a link file with its port, token and folders, so a click can be
 *   routed to the window that owns the session.
 *
 * Going through the socket instead of a `vscode://` link matters: VS Code guards external
 * links with a confirmation prompt, and until it is answered a click only raises the
 * window, which looks exactly like a link pointing at the wrong session.
 */
const HOME = homedir()
const LINK_FILE = linkPath(HOME, process.pid)
const SESSIONS = sessionsDir(HOME)
// Claude Code's own transcripts: a working session keeps writing to its file.
const PROJECTS = join(HOME, '.claude', 'projects')
const DECLINED_KEY = 'claudeNotify.hooksDeclined'
const SETUP_SHOWN_KEY = 'claudeNotify.setupShown'
const HELPER_ID = 'ru.rayz.notify-for-claude-code'
/**
 * The Claude Code extension's own "open this session" — the one that decides where. With
 * `programmatic: 'honor-preferred-location'` it reveals the session's tab if it has one,
 * otherwise switches the sidebar to it when Claude lives in the sidebar
 * (claudeCode.preferredLocation = sidebar), and only then opens a tab. Without that flag it
 * would quietly reset the user's preference to tabs.
 *
 * primaryEditor.open — what vscode:// links use — always goes to an editor tab. For a
 * session shown in the sidebar that means a second view of it, and a second view is not a
 * safe one: a prompt typed there has been seen to go nowhere.
 */
const CLAUDE_OPEN_SESSION = 'claude-vscode.editor.open'
const CLAUDE_OPEN_IN_EDITOR = 'claude-vscode.primaryEditor.open'

let server: Server | undefined
let statusBar: vscode.StatusBarItem | undefined
let output: vscode.OutputChannel | undefined
let watcher: FSWatcher | undefined
let pauseWatcher: FSWatcher | undefined
let linkInfo: { port: number; token: string } | undefined
/** `<publisher>.<name>#setup`, from the running extension rather than written out. */
let setupWalkthrough = ''

function log(line: string): void {
  output?.appendLine(`${new Date().toISOString().slice(11, 19)}  ${line}`)
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64_000) req.destroy() // a request from the notifier is never this big
    })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/* ------------------------------------------------------------- status bar */

function refreshStatusBar(): void {
  if (!statusBar) return
  if (!vscode.workspace.getConfiguration('claudeNotify').get<boolean>('statusBar', true)) {
    statusBar.hide()
    return
  }
  const all = readSessions(SESSIONS, PROJECTS)
  const waiting = all.filter((s) => s.state === 'waiting').length
  const running = all.length - waiting
  const paused = pauseNote()
  // A pause stays in sight even with no session running: it is easy to forget.
  if (!all.length && !paused) {
    statusBar.hide()
    return
  }
  const counts = [waiting && `${waiting} waiting`, running && `${running} running`].filter(Boolean).join(' · ')
  const icon = paused ? '$(bell-slash)' : waiting ? '$(bell-dot)' : '$(sync~spin)'
  // ✻ is Claude Code's own mark in the status bar: it says whose sessions these are.
  statusBar.text = `✻ ${icon} ${counts || 'paused'}`
  statusBar.tooltip = [paused, 'Claude Code sessions in every window — click for the list'].filter(Boolean).join('\n')
  // A session waiting for you is the one moment this should catch the eye.
  statusBar.backgroundColor = waiting && !paused ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
  statusBar.show()
}

/* ------------------------------------------------------------------ pause */

/** "until 15:30", or "until you resume". */
function untilLabel(until: number): string {
  if (until === Infinity) return 'until you resume'
  return `until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** What is paused, in words; empty when nothing is. */
function pauseNote(): string {
  const all = pausedUntil(HOME, 'all')
  if (all) return `Notifications paused ${untilLabel(all)}`
  const editor = pausedUntil(HOME, 'editor')
  if (editor) return `Notifications inside VS Code paused ${untilLabel(editor)}`
  return ''
}

/**
 * The pause lives in a file the notifier reads on every event, so it holds for every
 * window and for sessions in a terminal too. Sessions keep being counted meanwhile.
 */
async function pauseNotifications(): Promise<void> {
  const scope = await vscode.window.showQuickPick<vscode.QuickPickItem & { scope: PauseScope }>([
    { label: '$(bell-slash) All notifications', description: 'the system ones and the ones inside VS Code', scope: 'all' },
    { label: '$(window) Only the ones inside VS Code', description: 'system notifications keep coming', scope: 'editor' },
  ], { placeHolder: 'Pause which notifications?' })
  if (!scope) return
  const span = await vscode.window.showQuickPick<vscode.QuickPickItem & { minutes: number }>([
    { label: '15 minutes', minutes: 15 },
    { label: '1 hour', minutes: 60 },
    { label: '3 hours', minutes: 180 },
    { label: 'Until I resume', minutes: Infinity },
  ], { placeHolder: 'For how long?' })
  if (!span) return
  try {
    setPause(HOME, scope.scope, span.minutes === Infinity ? Infinity : Date.now() + span.minutes * 60_000)
  } catch (err) {
    vscode.window.showErrorMessage(`Notify for Claude Code could not pause: ${String(err)}`)
    return
  }
  refreshStatusBar()
  vscode.window.setStatusBarMessage(`$(bell-slash) ${pauseNote()}`, 5000)
}

function resumeNotifications(): void {
  const was = pauseNote()
  try {
    setPause(HOME, 'all', null)
    setPause(HOME, 'editor', null)
  } catch (err) {
    vscode.window.showErrorMessage(`Notify for Claude Code could not resume: ${String(err)}`)
    return
  }
  refreshStatusBar()
  vscode.window.setStatusBarMessage(was ? '$(bell) Notifications resumed' : '$(bell) Notifications were not paused', 5000)
}

/** "work-planner · now in ISS": started in one repository, working in another. */
function movedTo(s: Session): string {
  if (!s.cwd || !s.root || s.cwd === s.root || s.cwd.startsWith(s.root + '/')) return ''
  return ` · now in ${basename(s.cwd)}`
}

/** The window a session lives in, as the list shows it. */
function whereLabel(s: Session): string {
  const owner = ownerOf(s.root || s.cwd, linksDir(HOME))
  if (!owner) return 'no open window'
  if (owner.pid === process.pid) return 'this window'
  return `window: ${windowName(owner)}`
}

/**
 * Go to a session wherever it lives. In this window that is a call away. Another window is
 * reached through the notifier, as a click on a system notification is: it raises that
 * window first. Either way the session stops calling for attention.
 */
async function goToSession(context: vscode.ExtensionContext, session: string, root: string, title = ''): Promise<void> {
  const owner = ownerOf(root, linksDir(HOME))
  let outcome = owner ? '' : 'no-window'
  if (owner?.pid === process.pid && await focusSession(session)) markSeen(SESSIONS, session)
  // Another window, or the Claude Code extension's command failed here: the notifier then
  // falls back to a vscode:// link.
  else if (owner) outcome = (await runNotifier(context, ['--focus', session, root])).trim()
  refreshStatusBar()
  if (outcome !== 'no-window') return
  // Sending it to a window that does not hold its project shows an empty Claude tab.
  const openFolder = 'Open its folder in a new window'
  const answer = await vscode.window.showInformationMessage(
    `"${title || basename(root) || 'This session'}" is not open in any VS Code window.`, ...(root ? [openFolder] : []))
  if (answer === openFolder) {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: true })
  }
}

type SessionPick = vscode.QuickPickItem & { id: string; root: string; title: string }
type ControlPick = vscode.QuickPickItem & { action?: 'pause' | 'resume' | 'setup' }

/** Every active session: who, where, in what state, how full its context is. */
async function showSessions(context: vscode.ExtensionContext): Promise<void> {
  const all = readSessions(SESSIONS, PROJECTS)
  const sessions: SessionPick[] = all.map((s) => {
    const d = readDetails(s.transcript)
    const facts = [
      d.model && modelName(d.model),
      d.contextTokens ? `context ${tokens(d.contextTokens)}` : '',
    ].filter(Boolean).join(' · ')
    return {
      label: `${s.state === 'waiting' ? '$(bell-dot)' : '$(sync~spin)'} ${d.title || s.project}`,
      description: `${s.state === 'waiting' ? 'waiting for you' : 'running'} ${ago(s.at)} · ${s.project}${movedTo(s)} · ${whereLabel(s)}`,
      // What it is asking, or else how its last answer began — enough to recognise it.
      detail: [s.state === 'waiting' && s.message ? s.message : d.reply, facts].filter(Boolean).join(' — '),
      id: s.session,
      root: s.root || s.cwd,
      title: d.title || s.project,
    }
  })
  // Last, not first: the first item is what Enter picks.
  const paused = pauseNote()
  const control: ControlPick = paused
    ? { label: '$(bell) Resume notifications', description: paused, action: 'resume' }
    : { label: '$(bell-slash) Pause notifications…', action: 'pause' }
  const setup: ControlPick = { label: '$(gear) Set up…', description: 'connect, allow notifications, try it', action: 'setup' }
  const items: (SessionPick | ControlPick)[] = sessions.length
    ? [...sessions, { label: '', kind: vscode.QuickPickItemKind.Separator }, control, setup]
    : [control, setup]
  const pick = await vscode.window.showQuickPick(items, {
    // The same mark as in the status bar, so the list is recognisably the one it opens.
    title: '✻ Claude Code sessions',
    placeHolder: sessions.length
      ? 'Every window — pick one to go there'
      : 'No sessions running or waiting',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  if (!pick) return
  if (!('id' in pick)) {
    if (pick.action === 'pause') await pauseNotifications()
    else if (pick.action === 'resume') resumeNotifications()
    else if (pick.action === 'setup') await openSetup()
    return
  }
  await goToSession(context, pick.id, pick.root, pick.title)
}

function watchSessions(): void {
  let pending: NodeJS.Timeout | undefined
  const soon = () => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(refreshStatusBar, 200)
  }
  try {
    mkdirSync(SESSIONS, { recursive: true })
    watcher = watch(SESSIONS, soon)
    // A pause set in another window or from the command line.
    pauseWatcher = watch(dirname(pausePath(HOME)), (_event, file) => { if (file === 'pause.json') soon() })
  } catch (err) {
    log(`could not watch the session list, falling back to polling: ${String(err)}`)
  }
}

/* ------------------------------------------------------------- the socket */

async function focusSession(sessionId: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(CLAUDE_OPEN_SESSION, sessionId, undefined, undefined, undefined, undefined,
      { programmatic: 'honor-preferred-location' })
    return true
  } catch (err) {
    log(`${CLAUDE_OPEN_SESSION} failed for ${sessionId}: ${String(err)} — trying ${CLAUDE_OPEN_IN_EDITOR}`)
  }
  try {
    // An older Claude Code without the location-aware command.
    await vscode.commands.executeCommand(CLAUDE_OPEN_IN_EDITOR, sessionId)
    return true
  } catch (err) {
    // Both belong to the official Claude Code extension. If they are missing or were
    // renamed, say so rather than failing mutely.
    log(`could not focus ${sessionId}: ${String(err)}`)
    return false
  }
}

function editorNotificationsOn(): boolean {
  return vscode.workspace.getConfiguration('claudeNotify').get<boolean>('editorNotifications', true)
    && !pausedUntil(HOME, 'all') && !pausedUntil(HOME, 'editor')
}

/**
 * The user is already looking at the session, so a toast would only cover the box they type
 * in. The window must have focus. Then either its active tab is the session's own Claude Code
 * tab, recognised by its label; or Claude lives in the sidebar and this is the session the user
 * last wrote to in this window. The sidebar shows one session and no API says which, but it is
 * nearly always that one.
 */
function sessionInFront(session: string, title: string): boolean {
  if (!vscode.window.state.focused) return false
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab
  const input = tab?.input
  if (input instanceof vscode.TabInputWebview && input.viewType.endsWith('claudeVSCodePanel')) {
    return tabShowsTitle(tab!.label, title)
  }
  if (!session || vscode.workspace.getConfiguration('claudeCode').get<string>('preferredLocation') !== 'sidebar') return false
  return lastPrompted(SESSIONS, (root) => ownerOf(root, linksDir(HOME))?.pid === process.pid) === session
}

/**
 * The system notification, repeated in this window. Its button and the session's name in
 * it go where a click on the system one goes.
 */
function notifyHere(context: vscode.ExtensionContext, body: any): boolean {
  if (!editorNotificationsOn()) return false
  if (sessionInFront(String(body?.session || ''), String(body?.title || ''))) {
    log(`not shown here: "${String(body?.title)}" is the tab in front`)
    return false
  }
  const toast = toastFor(body, 'claudeNotify.openSession')
  const show = toast.severity === 'error' ? vscode.window.showErrorMessage
    : toast.severity === 'warning' ? vscode.window.showWarningMessage
    : vscode.window.showInformationMessage
  // Resolves only when the toast is answered or dismissed, so it is not awaited here.
  void show(toast.text, ...(toast.button ? [toast.button] : [])).then(async (answer) => {
    if (answer && answer === toast.button) await goToSession(context, toast.session, toast.root, toast.title)
  })
  return true
}

function startServer(context: vscode.ExtensionContext, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.headers['x-claude-notify-token'] !== token) {
        res.writeHead(403).end()
        return
      }
      const body = await readBody(req)
      if (req.url === '/focus') {
        const ok = await focusSession(String(body.session || ''))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok }))
        return
      }
      if (req.url === '/notify') {
        const ok = notifyHere(context, body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok }))
        return
      }
      res.writeHead(404).end()
    })
    srv.on('error', reject)
    // Loopback only: nothing outside this machine has any business here.
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address && typeof address === 'object') {
        server = srv
        resolve(address.port)
      } else reject(new Error('no port'))
    })
  })
}

/**
 * The notifier picks the window whose workspace holds a session's folder, and raises it
 * by opening that folder — so it needs to know this window's folders and app name.
 */
function writeLink(): void {
  if (!linkInfo) return
  try {
    mkdirSync(linksDir(HOME), { recursive: true })
    // The token in it lets whoever reads it put text in this window's notifications.
    writeFileSync(LINK_FILE, JSON.stringify({
      ...linkInfo,
      pid: process.pid,
      folders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
      workspaceFile: vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : undefined,
      appName: vscode.env.appName,
      focusedAt: vscode.window.state.focused ? Date.now() : 0,
    }, null, 2), { mode: 0o600 })
    chmodSync(LINK_FILE, 0o600) // mode only applies to a new file
  } catch (err) {
    log(`could not write the link file: ${String(err)}`)
  }
}

/* ------------------------------------------------------- settings & hooks */

function syncConfig(): void {
  const cfg = vscode.workspace.getConfiguration('claudeNotify')
  try {
    writeConfig(HOME, {
      enabled: cfg.get<boolean>('enabled', true),
      minTurnSeconds: cfg.get<number>('minTurnSeconds', 45),
      events: cfg.get<string[]>('events', ['done', 'error', 'waitingInput']),
      style: cfg.get<string>('style', 'alert'),
      sound: cfg.get<boolean>('sound', true),
    })
  } catch (err) {
    log(`could not write the notifier config: ${String(err)}`)
  }
}

/**
 * Claude Code only tells anyone about a session through hooks in its settings file,
 * so without them this extension hears nothing. That file is the user's, though:
 * ask once, and remember a "not now" instead of asking on every start.
 */
async function offerHooks(context: vscode.ExtensionContext, force = false): Promise<void> {
  // Already connected is a finished step, not a refusal: tick it on the setup page and say so.
  if (pluginInstalled(HOME)) {
    log('the claude-notify Claude Code plugin is installed and brings its own hooks — leaving settings.json alone')
    await refreshSetup()
    if (force) vscode.window.showInformationMessage('Notify for Claude Code: already connected — the claude-notify plugin for Claude Code reports every session. Nothing to change.')
    return
  }
  if (hooksWired(HOME)) {
    await refreshSetup()
    if (force) vscode.window.showInformationMessage('Notify for Claude Code: already connected — the hooks are in place.')
    return
  }
  if (force) {
    // Asked for by name — from the command palette or the setup page — so no second question.
    try {
      wireHooks(HOME)
      await context.globalState.update(DECLINED_KEY, false)
      vscode.window.showInformationMessage('Notify for Claude Code: connected. Claude sessions started from now on will report.')
    } catch (err) {
      vscode.window.showErrorMessage(`Notify for Claude Code could not update ~/.claude/settings.json: ${String(err)}`)
    }
    await refreshSetup()
    return
  }
  if (context.globalState.get<boolean>(DECLINED_KEY)) return

  const add = 'Add hooks'
  const answer = await vscode.window.showInformationMessage(
    'Notify for Claude Code needs four hooks in ~/.claude/settings.json to hear when a Claude Code session finishes or waits for you. Add them? Nothing else in the file changes.',
    add, 'Not now')
  if (answer !== add) {
    await context.globalState.update(DECLINED_KEY, true)
    log('hooks declined — run "Notify for Claude Code: Add hooks" to add them later')
    return
  }
  try {
    wireHooks(HOME)
    await context.globalState.update(DECLINED_KEY, false)
    vscode.window.showInformationMessage('Notify for Claude Code: hooks added. Sessions started from now on will report.')
  } catch (err) {
    vscode.window.showErrorMessage(`Notify for Claude Code could not update ~/.claude/settings.json: ${String(err)}`)
  }
  await refreshSetup()
}

/* ------------------------------------------------------------------ setup */

const helperBinary = () => join(helperPath(HOME), 'Contents', 'MacOS', 'notify')

/** Runs the notifying app; resolves with its exit code and what it printed. */
function runHelper(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    if (!existsSync(helperBinary())) return resolve({ code: null, out: 'not installed' })
    const child = spawn(helperBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('close', (code) => resolve({ code, out: out.trim() }))
    child.on('error', (err) => resolve({ code: null, out: String(err) }))
  })
}

/**
 * What the setup page ticks off by itself: connected to Claude Code, allowed to notify,
 * and notifications that stay on screen.
 */
async function refreshSetup(): Promise<void> {
  const connected = pluginInstalled(HOME) || hooksWired(HOME)
  const status = process.platform === 'darwin' ? await runHelper(['-status']) : { code: 0, out: '' }
  await vscode.commands.executeCommand('setContext', 'claudeNotify.connected', connected)
  await vscode.commands.executeCommand('setContext', 'claudeNotify.allowed', status.code === 0)
  await vscode.commands.executeCommand('setContext', 'claudeNotify.persistent', /^style: alert$/m.test(status.out))
}

function openSetup(): Thenable<unknown> {
  return vscode.commands.executeCommand('workbench.action.openWalkthrough', setupWalkthrough, false)
}

/** The same question a first notification would ask, asked while the user is looking. */
async function allowNotifications(): Promise<void> {
  const { code, out } = await runHelper(['-authorize'])
  await refreshSetup()
  if (code === 0) {
    vscode.window.setStatusBarMessage('$(check) Notify for Claude Code may show notifications', 5000)
    return
  }
  if (out === 'not installed') {
    vscode.window.showErrorMessage('Notify for Claude Code: its notifying app is missing — reinstall the extension.')
    return
  }
  // Once declined, macOS does not ask again; only System Settings can turn it on.
  const open = 'Open notification settings'
  const answer = await vscode.window.showWarningMessage(
    'macOS has notifications turned off for Notify for Claude Code. Turn them on in System Settings → Notifications.', open)
  if (answer === open) openNotificationSettings()
}

/** Straight to our app's page; a macOS that ignores the id opens the list. */
function openNotificationSettings(): void {
  spawn('open', [`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${HELPER_ID}`], { stdio: 'ignore' })
    .on('error', (err) => log(`could not open System Settings: ${String(err)}`))
}

/** The setup page once, on the first start; after that, only the reminder about hooks. */
async function firstRun(context: vscode.ExtensionContext): Promise<void> {
  await refreshSetup()
  if (!context.globalState.get<boolean>(SETUP_SHOWN_KEY)) {
    await context.globalState.update(SETUP_SHOWN_KEY, true)
    await openSetup()
    return
  }
  await offerHooks(context)
}

function runNotifier(context: vscode.ExtensionContext, args: string[], cwd?: string): Promise<string> {
  const script = context.asAbsolutePath(join('dist', 'claude-notify.mjs'))
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('close', () => resolve(out))
    child.on('error', (err) => resolve(String(err)))
  })
}

/* --------------------------------------------------------------- lifecycle */

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  setupWalkthrough = `${context.extension.id}#setup`
  output = vscode.window.createOutputChannel('Notify for Claude Code')
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = 'claudeNotify.showSessions'
  statusBar.name = 'Claude Code sessions'
  context.subscriptions.push(output, statusBar)

  try {
    if (installScript(context.asAbsolutePath(join('dist', 'claude-notify.mjs')), HOME)) log('notifier script updated')
    if (writeRunner(HOME, process.execPath)) log('hook runner updated')
    if (process.platform === 'darwin' && installHelper(context.asAbsolutePath(join('dist', 'notify-helper')), HOME)) {
      log('notifying app installed')
    }
    // Hooks an older version wrote need a node on PATH; the runner does not.
    if (!pluginInstalled(HOME) && hooksOutdated(HOME)) {
      wireHooks(HOME)
      log('hooks moved to the runner')
    }
  } catch (err) {
    log(`could not install the notifier: ${String(err)}`)
  }
  syncConfig()

  const token = randomBytes(24).toString('hex')
  try {
    const port = await startServer(context, token)
    linkInfo = { port, token }
    writeLink()
    try { rmSync(legacyLinkPath(HOME), { force: true }) } catch {}
    log(`listening on 127.0.0.1:${port}`)
  } catch (err) {
    log(`could not start the listener: ${String(err)} — clicks fall back to vscode:// links`)
  }

  watchSessions()
  refreshStatusBar()
  // fs.watch can miss events, and stale sessions only expire with time: refresh anyway.
  const tick = setInterval(refreshStatusBar, 30_000)

  context.subscriptions.push(
    { dispose: () => clearInterval(tick) },
    { dispose: () => watcher?.close() },
    { dispose: () => pauseWatcher?.close() },
    vscode.commands.registerCommand('claudeNotify.showSessions', () => showSessions(context)),
    vscode.commands.registerCommand('claudeNotify.pause', pauseNotifications),
    vscode.commands.registerCommand('claudeNotify.resume', resumeNotifications),
    vscode.commands.registerCommand('claudeNotify.openSession', (session: string, root: string) =>
      goToSession(context, String(session || ''), String(root || ''))),
    vscode.commands.registerCommand('claudeNotify.test', async () => {
      // Run from this window's folder, so the notification is routed back to this window.
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri
      const cwd = folder?.scheme === 'file' && existsSync(folder.fsPath) ? folder.fsPath : undefined
      const here = Boolean(cwd && linkInfo) && editorNotificationsOn()
      await runNotifier(context, ['--test'], cwd)
      vscode.window.showInformationMessage(`Notify for Claude Code: test notification sent — it should appear among the system notifications${here ? ' and in this window' : ''}.`)
    }),
    vscode.commands.registerCommand('claudeNotify.doctor', async () => {
      const report = await runNotifier(context, ['--doctor'])
      output?.clear()
      output?.appendLine(report.trimEnd())
      output?.show(true)
    }),
    vscode.commands.registerCommand('claudeNotify.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('claudeNotify')
      const next = !cfg.get<boolean>('enabled', true)
      await cfg.update('enabled', next, vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage(`Notify for Claude Code is ${next ? 'on' : 'off'}.`)
    }),
    vscode.commands.registerCommand('claudeNotify.addHooks', () => offerHooks(context, true)),
    vscode.commands.registerCommand('claudeNotify.setup', openSetup),
    vscode.commands.registerCommand('claudeNotify.allowNotifications', allowNotifications),
    vscode.commands.registerCommand('claudeNotify.openNotificationSettings', openNotificationSettings),
    vscode.commands.registerCommand('claudeNotify.removeHooks', () => {
      const removed = unwireHooks(HOME)
      void refreshSetup()
      vscode.window.showInformationMessage(removed
        ? `Notify for Claude Code: removed ${removed} hook${removed > 1 ? 's' : ''} from ~/.claude/settings.json.`
        : 'Notify for Claude Code: no hooks of ours to remove.')
    }),
    // Back from System Settings, perhaps with notifications turned on: tick the setup page.
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return
      writeLink()
      void refreshSetup()
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => writeLink()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeNotify')) return
      syncConfig()
      refreshStatusBar()
    }),
  )

  void firstRun(context)
}

export function deactivate(): void {
  server?.close()
  watcher?.close()
  pauseWatcher?.close()
  // Leaving it behind would point the notifier at a port nobody is listening on.
  try { rmSync(LINK_FILE, { force: true }) } catch {}
}
