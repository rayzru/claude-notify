import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import {
  hooksWired, installScript, legacyLinkPath, linkPath, linksDir, pluginInstalled, sessionsDir,
  unwireHooks, wireHooks, writeConfig,
} from './wiring'
import { ago, modelName, ownerOf, readDetails, readSessions, tokens, windowName, type Session } from './sessions'

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
const DECLINED_KEY = 'claudeNotify.hooksDeclined'
const CLAUDE_EXTENSION_OPEN = 'claude-vscode.primaryEditor.open'

let server: Server | undefined
let statusBar: vscode.StatusBarItem | undefined
let output: vscode.OutputChannel | undefined
let watcher: FSWatcher | undefined
let linkInfo: { port: number; token: string } | undefined

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
  const all = readSessions(SESSIONS)
  const waiting = all.filter((s) => s.state === 'waiting').length
  const running = all.length - waiting
  if (!all.length) {
    statusBar.hide()
    return
  }
  statusBar.text = waiting > 0
    ? `$(bell-dot) ${waiting} waiting${running ? ` · ${running} running` : ''}`
    : `$(sync~spin) ${running} running`
  statusBar.tooltip = 'Claude Code sessions in every window — click for the list'
  statusBar.show()
}

/** The window a session lives in, as the list shows it. */
function whereLabel(s: Session): string {
  const owner = ownerOf(s.cwd, linksDir(HOME))
  if (!owner) return 'no open window'
  if (owner.pid === process.pid) return 'this window'
  return `window: ${windowName(owner)}`
}

/** Every active session: who, where, in what state, how full its context is. */
async function showSessions(context: vscode.ExtensionContext): Promise<void> {
  const all = readSessions(SESSIONS)
  if (!all.length) {
    vscode.window.showInformationMessage('Claude Notify: no Claude Code sessions running or waiting.')
    return
  }
  const items = all.map((s) => {
    const d = readDetails(s.transcript)
    const facts = [
      d.model && modelName(d.model),
      d.contextTokens ? `context ${tokens(d.contextTokens)}` : '',
    ].filter(Boolean).join(' · ')
    return {
      label: `${s.state === 'waiting' ? '$(bell-dot)' : '$(sync~spin)'} ${d.title || s.project}`,
      description: `${s.state === 'waiting' ? 'waiting for you' : 'running'} ${ago(s.at)} · ${s.project} · ${whereLabel(s)}`,
      detail: s.state === 'waiting' && s.message ? `${s.message}${facts ? ` — ${facts}` : ''}` : facts,
      id: s.session,
    }
  })
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Claude Code sessions in every window — pick one to go there',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  if (!pick) return
  // The notifier routes it: raises the owning window, then asks that window to focus it.
  await runNotifier(context, ['--focus', pick.id])
  refreshStatusBar()
}

function watchSessions(): void {
  try {
    mkdirSync(SESSIONS, { recursive: true })
    let pending: NodeJS.Timeout | undefined
    watcher = watch(SESSIONS, () => {
      if (pending) clearTimeout(pending)
      pending = setTimeout(refreshStatusBar, 200)
    })
  } catch (err) {
    log(`could not watch the session list, falling back to polling: ${String(err)}`)
  }
}

/* ------------------------------------------------------------- the socket */

async function focusSession(sessionId: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(CLAUDE_EXTENSION_OPEN, sessionId)
    return true
  } catch (err) {
    // The command belongs to the official Claude Code extension. If it is missing or
    // was renamed, say so rather than failing mutely.
    log(`could not focus ${sessionId}: ${String(err)}`)
    return false
  }
}

function startServer(token: string): Promise<number> {
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
    writeFileSync(LINK_FILE, JSON.stringify({
      ...linkInfo,
      pid: process.pid,
      folders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
      workspaceFile: vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : undefined,
      appName: vscode.env.appName,
      focusedAt: vscode.window.state.focused ? Date.now() : 0,
    }, null, 2))
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
  if (pluginInstalled(HOME)) {
    log('the claude-notify Claude Code plugin is installed and brings its own hooks — leaving settings.json alone')
    if (force) vscode.window.showInformationMessage('Claude Notify: the Claude Code plugin already provides the hooks, nothing to add.')
    return
  }
  if (hooksWired(HOME)) {
    if (force) vscode.window.showInformationMessage('Claude Notify: hooks are already in place.')
    return
  }
  if (!force && context.globalState.get<boolean>(DECLINED_KEY)) return

  const add = 'Add hooks'
  const answer = await vscode.window.showInformationMessage(
    'Claude Notify needs four hooks in ~/.claude/settings.json to hear when a Claude Code session finishes or waits for you. Add them? Nothing else in the file changes.',
    add, 'Not now')
  if (answer !== add) {
    await context.globalState.update(DECLINED_KEY, true)
    log('hooks declined — run "Claude Notify: Add hooks" to add them later')
    return
  }
  try {
    wireHooks(HOME)
    await context.globalState.update(DECLINED_KEY, false)
    vscode.window.showInformationMessage('Claude Notify: hooks added. Sessions started from now on will report.')
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Notify could not update ~/.claude/settings.json: ${String(err)}`)
  }
}

function runNotifier(context: vscode.ExtensionContext, args: string[]): Promise<string> {
  const script = context.asAbsolutePath(join('dist', 'claude-notify.mjs'))
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('close', () => resolve(out))
    child.on('error', (err) => resolve(String(err)))
  })
}

/* --------------------------------------------------------------- lifecycle */

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Claude Notify')
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = 'claudeNotify.showSessions'
  context.subscriptions.push(output, statusBar)

  try {
    if (installScript(context.asAbsolutePath(join('dist', 'claude-notify.mjs')), HOME)) log('notifier script updated')
  } catch (err) {
    log(`could not install the notifier script: ${String(err)}`)
  }
  syncConfig()

  const token = randomBytes(24).toString('hex')
  try {
    const port = await startServer(token)
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
    vscode.commands.registerCommand('claudeNotify.showSessions', () => showSessions(context)),
    vscode.commands.registerCommand('claudeNotify.test', async () => {
      await runNotifier(context, ['--test'])
      vscode.window.showInformationMessage('Claude Notify: test notification sent. Click it — this session should come to the front.')
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
      vscode.window.showInformationMessage(`Claude Notify is ${next ? 'on' : 'off'}.`)
    }),
    vscode.commands.registerCommand('claudeNotify.addHooks', () => offerHooks(context, true)),
    vscode.commands.registerCommand('claudeNotify.removeHooks', () => {
      const removed = unwireHooks(HOME)
      vscode.window.showInformationMessage(removed
        ? `Claude Notify: removed ${removed} hook${removed > 1 ? 's' : ''} from ~/.claude/settings.json.`
        : 'Claude Notify: no hooks of ours to remove.')
    }),
    vscode.window.onDidChangeWindowState((state) => { if (state.focused) writeLink() }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => writeLink()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeNotify')) return
      syncConfig()
      refreshStatusBar()
    }),
  )

  void offerHooks(context)
}

export function deactivate(): void {
  server?.close()
  watcher?.close()
  // Leaving it behind would point the notifier at a port nobody is listening on.
  try { rmSync(LINK_FILE, { force: true }) } catch {}
}
