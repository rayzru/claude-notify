import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import {
  hooksWired, installScript, legacyLinkPath, linkPath, linksDir, pluginInstalled, unwireHooks, wireHooks, writeConfig,
} from './wiring'

/**
 * The notifier runs outside the editor — it is a hook, spawned per event, and macOS
 * notifications cannot come from an extension at all. So the two halves talk over a
 * loopback socket whose port and token are written where the hook can read them.
 *
 * Going through this socket instead of a `vscode://` link matters: VS Code guards
 * external links with a confirmation prompt, and until it is answered a click only
 * raises the window, which looks exactly like a link pointing at the wrong session.
 */
const HOME = homedir()
const LINK_FILE = linkPath(HOME, process.pid)
const SESSION_TTL_MS = 3 * 3600_000
const DECLINED_KEY = 'claudeNotify.hooksDeclined'
const CLAUDE_EXTENSION_OPEN = 'claude-vscode.primaryEditor.open'

type SessionState = 'running' | 'waiting'

const sessions = new Map<string, { state: SessionState; lane: string; at: number }>()

let server: Server | undefined
let statusBar: vscode.StatusBarItem | undefined
let output: vscode.OutputChannel | undefined

function log(line: string): void {
  output?.appendLine(`${new Date().toISOString().slice(11, 19)}  ${line}`)
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64_000) req.destroy() // a hook payload is never this big
    })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** A session closed while running or waiting never sends Stop; do not count it forever. */
function pruneSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, s] of sessions) if (s.at < cutoff) sessions.delete(id)
}

function refreshStatusBar(): void {
  if (!statusBar) return
  pruneSessions()
  if (!vscode.workspace.getConfiguration('claudeNotify').get<boolean>('statusBar', true)) {
    statusBar.hide()
    return
  }
  let running = 0
  let waiting = 0
  for (const { state } of sessions.values()) state === 'waiting' ? (waiting += 1) : (running += 1)

  if (running === 0 && waiting === 0) {
    statusBar.hide()
    return
  }
  statusBar.text = waiting > 0 ? `$(bell-dot) ${waiting} waiting` : `$(sync~spin) ${running} running`
  statusBar.tooltip = [
    running ? `${running} session${running > 1 ? 's' : ''} running` : '',
    waiting ? `${waiting} waiting for you` : '',
  ].filter(Boolean).join(' · ')
  statusBar.show()
}

/** A session the user has answered is no longer waiting, whoever told us. */
function markSession(sessionId: string, state: SessionState | 'idle', lane: string): void {
  if (!sessionId) return
  if (state === 'idle') sessions.delete(sessionId)
  else sessions.set(sessionId, { state, lane, at: Date.now() })
  refreshStatusBar()
}

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

/** The user went to it, so it no longer needs to call for attention. A running one stays counted. */
async function openSession(sessionId: string): Promise<boolean> {
  const ok = await focusSession(sessionId)
  if (ok && sessions.get(sessionId)?.state === 'waiting') markSession(sessionId, 'idle', '')
  return ok
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000)
  return minutes < 1 ? 'just now' : `${minutes} min ago`
}

/**
 * The status bar says "2 waiting"; clicking it should take you there, not open a report.
 * One waiting session: go straight to it. Several, or only running ones: pick.
 */
async function showSessions(): Promise<void> {
  const all = [...sessions.entries()]
  const waiting = all.filter(([, s]) => s.state === 'waiting')
  if (waiting.length === 1) {
    await openSession(waiting[0][0])
    return
  }
  if (!all.length) {
    vscode.window.showInformationMessage('Claude Notify: no sessions running or waiting.')
    return
  }
  const ordered = [...waiting, ...all.filter(([, s]) => s.state !== 'waiting')]
  const pick = await vscode.window.showQuickPick(ordered.map(([id, s]) => ({
    label: `${s.state === 'waiting' ? '$(bell-dot)' : '$(sync)'} ${s.lane || 'session'}`,
    description: `${s.state} · ${ago(s.at)}`,
    id,
  })), { placeHolder: 'Go to a Claude Code session' })
  if (pick) await openSession(pick.id)
}

function startServer(token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.headers['x-claude-notify-token'] !== token) {
        res.writeHead(403).end()
        return
      }
      const body = await readBody(req)
      const reply = (payload: object) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (req.url === '/focus') {
        reply({ ok: await openSession(String(body.session || '')) })
        return
      }
      if (req.url === '/event') {
        const event = String(body.event || '')
        const session = String(body.session || '')
        const lane = String(body.lane || '')
        if (event === 'UserPromptSubmit') markSession(session, 'running', lane)
        else if (event === 'Notification') markSession(session, 'waiting', lane)
        else markSession(session, 'idle', lane)
        reply({ ok: true })
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

let linkInfo: { port: number; token: string } | undefined

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
    log(`could not start the listener: ${String(err)} — notifications fall back to vscode:// links`)
  }

  context.subscriptions.push(
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
    vscode.commands.registerCommand('claudeNotify.showSessions', showSessions),
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
  // Leaving it behind would point the notifier at a port nobody is listening on.
  try { rmSync(LINK_FILE, { force: true }) } catch {}
}
