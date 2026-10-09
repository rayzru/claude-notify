import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * The session list, read from the files the notifier writes. No vscode API here, so it
 * can be tested with plain Node.
 */

export type SessionState = 'running' | 'waiting'

export interface Session {
  session: string
  state: SessionState
  message: string
  /** where it is working now — it may have moved on to another repository */
  cwd: string
  /** where it was started, which is where its tab lives */
  root: string
  project: string
  transcript: string
  at: number
}

/**
 * The session the user last sent a prompt to, among those `inWindow` accepts by the folder
 * they were started in. Finished sessions count too — that is when it is asked.
 */
export function lastPrompted(dir: string, inWindow: (root: string) => boolean): string {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return '' }
  let best = ''
  let bestAt = -1
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const s = readJson(join(dir, name))
    if (!s || typeof s.promptedAt !== 'number' || !s.session) continue
    if (!inWindow(String(s.root || s.cwd || ''))) continue
    if (s.promptedAt > bestAt) {
      best = String(s.session)
      bestAt = s.promptedAt
    }
  }
  return best
}

export interface Details {
  title: string
  model: string
  contextTokens: number
  cwd: string
  /** the opening of the model's last written answer */
  reply: string
}

export const SESSION_TTL_MS = 3 * 3600_000
/** A transcript written this recently belongs to a session that is working right now. */
export const ACTIVE_MS = 2 * 60_000
/** "Running" with a transcript quiet this long was interrupted — a quit editor, a killed process. */
export const STALLED_MS = 10 * 60_000
/** Claude Code appends a few housekeeping lines right after a turn ends; they are not a new turn. */
export const AFTER_STOP_MS = 30_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Where the session was started: Claude Code writes that directory into the transcript's
 * first records. The window that owns the session is the one holding this directory, not
 * the one holding wherever the session has wandered off to since.
 */
export function readRoot(transcript: string): string {
  if (!transcript) return ''
  let fd: number | undefined
  try {
    fd = openSync(transcript, 'r')
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

const projectOf = (dir: string) => basename(dir.replace(/[/\\]+$/, '')) || dir

function mtime(path: string): number {
  try { return statSync(path).mtimeMs } catch { return 0 }
}

/**
 * When the session last did something. Every record of a turn is dated, but Claude Code
 * also appends undated bookkeeping — cost totals, the mode, the last prompt — to each
 * transcript it reopens or closes, so an editor restart touches all of them at once. The
 * file's time only says whether to look; the last dated record says when it worked.
 * A file untouched since `since` is not read: its last record can only be older still.
 */
export function workedAt(transcript: string, since = 0): number {
  const written = mtime(transcript)
  if (written < since) return written
  const tail = readTail(transcript, 256 * 1024)
  const lines = tail.text.split('\n')
  if (tail.cut) lines.shift()
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"timestamp"')) continue
    let d: any
    try { d = JSON.parse(lines[i]) } catch { continue }
    const at = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN
    if (at) return at
  }
  // a single record longer than the tail is a turn's output, not bookkeeping
  return tail.cut ? written : 0
}

/** Top-level transcripts worked in since `since`. Subagents keep theirs in subfolders, skipped. */
function recentTranscripts(projectsDir: string, since: number): Map<string, { path: string; at: number }> {
  const found = new Map<string, { path: string; at: number }>()
  let projects: string[] = []
  try { projects = readdirSync(projectsDir) } catch { return found }
  for (const project of projects) {
    let files: string[] = []
    try { files = readdirSync(join(projectsDir, project)) } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const id = file.slice(0, -'.jsonl'.length)
      if (!UUID.test(id)) continue
      const path = join(projectsDir, project, file)
      const at = workedAt(path, since)
      if (at >= since) found.set(id, { path, at })
    }
  }
  return found
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** The notifier's file name for a session. */
const safeId = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'unknown'

/** Gone to: a waiting session stops calling for attention, as after a click on its notification. */
export function markSeen(dir: string, session: string, now = Date.now()): void {
  const path = join(dir, `${safeId(session)}.json`)
  const entry = readJson(path)
  if (!entry || entry.state !== 'waiting') return
  try { writeFileSync(path, JSON.stringify({ ...entry, state: 'running', message: '', at: now })) } catch {}
}

/** What Claude Code itself says of a session one of its processes holds. */
export interface Live {
  session: string
  status: 'busy' | 'waiting' | 'idle'
  waitingFor: string
  cwd: string
  /** when the status last changed */
  since: number
}

const RANK = { idle: 0, busy: 1, waiting: 2 }
/** How long a process found to be the one that wrote its file is taken at its word. */
const VERIFIED_MS = 10 * 60_000
const verified = new Map<string, number>()

/**
 * Whether the process that wrote a file is still running. Its pid alone is not enough: a
 * file left by a crash can name a pid the system has since given to something else, so
 * the start time Claude Code wrote down must match too — read as Claude Code reads it.
 */
export function runningProcess(pid: number, procStart: string, now = Date.now()): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0) } catch (err: any) { if (err?.code !== 'EPERM') return false }
  if (!procStart || process.platform === 'win32') return true
  const key = `${pid} ${procStart}`
  if ((verified.get(key) ?? 0) > now - VERIFIED_MS) return true
  let started = ''
  try {
    started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return false
  }
  const same = started.replace(/\s+/g, ' ') === procStart.trim().replace(/\s+/g, ' ')
  if (same) verified.set(key, now)
  return same
}

/**
 * Claude Code keeps a file per running process in ~/.claude/sessions, naming the session
 * it holds and whether it is busy, waiting for the user or idle. Busy covers what no hook
 * reports: background agents and workflows still at work after the turn that started
 * them has ended. A file whose process is gone is left over from a crash and says nothing.
 */
export function readLive(dir: string, running = runningProcess): Map<string, Live> {
  const live = new Map<string, Live>()
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return live }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    const s = readJson(join(dir, name))
    // a spare is started ahead of need and holds no one's session yet
    if (!s || typeof s.sessionId !== 'string' || !s.sessionId || s.spare === true) continue
    if (s.status !== 'busy' && s.status !== 'waiting' && s.status !== 'idle') continue
    if (!running(Number(s.pid), typeof s.procStart === 'string' ? s.procStart : '')) continue
    const entry: Live = {
      session: s.sessionId,
      status: s.status,
      waitingFor: typeof s.waitingFor === 'string' ? s.waitingFor : '',
      cwd: typeof s.cwd === 'string' ? s.cwd : '',
      since: Number(s.statusUpdatedAt || s.updatedAt || s.startedAt) || 0,
    }
    // two processes on one session: the one doing something speaks for it
    const had = live.get(entry.session)
    if (!had || RANK[entry.status] > RANK[had.status] || (RANK[entry.status] === RANK[had.status] && entry.since > had.since)) {
      live.set(entry.session, entry)
    }
  }
  return live
}

/**
 * A live session as the list shows it, or null when it is idle. Claude Code's word
 * decides, with one thing only a hook knows: a permission prompt in a VS Code tab leaves
 * the process busy. So the hook's wait stands until the status changes after it — busy
 * again once answered, idle once it went away unanswered.
 */
function liveState(l: Live, s: any): { state: SessionState; message: string; at: number } | null {
  const hookWaits = s?.state === 'waiting'
  if (l.status === 'waiting') return { state: 'waiting', message: (hookWaits && s.message) || l.waitingFor, at: hookWaits ? s.at : l.since }
  if (hookWaits && s.at >= l.since) return { state: 'waiting', message: s.message || '', at: s.at }
  if (l.status === 'busy') return { state: 'running', message: '', at: l.since }
  return null
}

/** Claude Code names a project's folder after its path, every other character a dash. */
function findTranscript(projectsDir: string, id: string, cwd: string): string {
  if (!projectsDir) return ''
  const file = `${id}.jsonl`
  const guess = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), file)
  if (existsSync(guess)) return guess
  let projects: string[] = []
  try { projects = readdirSync(projectsDir) } catch { return '' }
  for (const project of projects) {
    const path = join(projectsDir, project, file)
    if (existsSync(path)) return path
  }
  return ''
}

/**
 * Active sessions. Claude Code's own account of its running processes decides first. For
 * a session it does not account for — a version before it kept one, a process already
 * gone — the hooks and the transcript decide. A prompt, a wait and a finish come from
 * hooks, but hooks alone miss too much: a session that resumes its interrupted turn after
 * an editor restart sends no prompt, and one killed mid-turn never sends a finish. What a
 * working session always does is add dated records to its transcript, so that decides
 * "running"; the hooks decide "waiting" and mark where a turn ended.
 */
export function readSessions(dir: string, projectsDir = '', now = Date.now(), live: Map<string, Live> = new Map()): Session[] {
  const registry = new Map<string, any>()
  let names: string[] = []
  try { names = readdirSync(dir) } catch {}
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    const s = readJson(path)
    if (!s || !s.session || !(s.at > now - SESSION_TTL_MS)) {
      try { unlinkSync(path) } catch {}
      continue
    }
    const root = s.root || readRoot(s.transcript) || s.cwd || ''
    registry.set(s.session, { ...s, root, project: projectOf(root) })
  }

  const out: Session[] = []
  const seen = new Set<string>()
  for (const s of registry.values()) {
    seen.add(s.session)
    const l = live.get(s.session)
    if (l) {
      const shown = liveState(l, s)
      if (shown) out.push({ ...s, ...shown })
      continue
    }
    const written = s.transcript ? workedAt(s.transcript, now - STALLED_MS) : 0
    if (s.state === 'waiting') {
      out.push(s)
    } else if (s.state === 'running') {
      // no transcript to go by: trust the hook, within the same window of time
      const lastSign = s.transcript ? Math.max(written, s.at) : s.at
      if (lastSign > now - STALLED_MS) out.push(s)
    } else if (s.state === 'done') {
      // written again well after the turn ended: working again without a prompt
      if (written > s.at + AFTER_STOP_MS && written > now - ACTIVE_MS) out.push({ ...s, state: 'running', at: written })
    }
  }

  for (const l of live.values()) {
    if (seen.has(l.session)) continue
    seen.add(l.session)
    const shown = liveState(l, null)
    if (!shown) continue
    const transcript = findTranscript(projectsDir, l.session, l.cwd)
    const root = readRoot(transcript) || l.cwd
    out.push({ session: l.session, cwd: l.cwd, root, project: projectOf(root), transcript, ...shown })
  }

  if (projectsDir) {
    for (const [id, t] of recentTranscripts(projectsDir, now - ACTIVE_MS)) {
      if (seen.has(id)) continue
      const d = readDetails(t.path)
      const cwd = d.cwd
      const root = readRoot(t.path) || cwd
      out.push({
        session: id,
        state: 'running',
        message: '',
        cwd,
        root,
        project: projectOf(root),
        transcript: t.path,
        at: t.at,
      })
    }
  }

  // Waiting first, longest-waiting on top; then running, most recent on top.
  return out.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'waiting' ? -1 : 1
    return a.state === 'waiting' ? a.at - b.at : b.at - a.at
  })
}

/** The last `bytes` of a file, and whether that cut into it — then the first line is partial. */
function readTail(path: string, bytes: number): { text: string; cut: boolean } {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(bytes, size)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    return { text: buf.toString('utf8'), cut: size > length }
  } catch {
    return { text: '', cut: false }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

/**
 * Claude Code appends the session's title and each reply's token usage to the
 * transcript, so the freshest of both sit in its last lines — reading the tail is enough,
 * even when the whole file runs to megabytes. A name the user gave the session's tab
 * wins over the one Claude chose, as it does on the tab.
 */
export function readDetails(transcript: string): Details {
  const details: Details = { title: '', model: '', contextTokens: 0, cwd: '', reply: '' }
  if (!transcript || !existsSync(transcript)) return details
  const tail = readTail(transcript, 512 * 1024)
  const lines = tail.text.split('\n')
  if (tail.cut) lines.shift() // starts mid-line; a short transcript is read whole and keeps it
  let named = ''
  for (const line of lines) {
    if (!line.includes('-title"') && !line.includes('"usage"') && !line.includes('"cwd"') && !line.includes('"text"')) continue
    let d: any
    try { d = JSON.parse(line) } catch { continue }
    if (typeof d.cwd === 'string' && d.cwd) details.cwd = d.cwd
    if (d.type === 'ai-title' && d.aiTitle) details.title = String(d.aiTitle)
    if (d.type === 'custom-title' && d.customTitle) named = String(d.customTitle)
    if (d.type === 'assistant') {
      const text = (d.message?.content || [])
        .filter((part: any) => part && part.type === 'text' && part.text)
        .map((part: any) => part.text).join(' ')
      const plain = excerpt(text)
      if (plain) details.reply = plain
    }
    const usage = d.type === 'assistant' ? d.message?.usage : undefined
    if (usage) {
      // what the model had in front of it on that turn: new input plus the cached context
      details.contextTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
      details.model = String(d.message.model || '')
    }
  }
  if (named) details.title = named
  return details
}

/** Markdown stripped, first sentence when it fits — the same rule the notifier uses. */
export function excerpt(text: string, limit = 140): string {
  const plain = text
    .replace(/^\s*Written for:[^\n]*\n+/i, '') // names its audience, says nothing about the work
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= limit) return plain
  const sentence = plain.match(/^.{20,}?[.!?…](?=\s)/)
  if (sentence && sentence[0].length <= limit) return sentence[0]
  return plain.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…'
}

/** claude-opus-5 → Opus 5, claude-haiku-4-5-20251001 → Haiku 4.5 */
export function modelName(id: string): string {
  const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '').split('-')
  if (!parts[0]) return ''
  return `${parts[0][0].toUpperCase()}${parts[0].slice(1)} ${parts.slice(1).join('.')}`.trim()
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

interface Link { pid: number; folders?: string[]; workspaceFile?: string }

/** Same rule as the notifier: the window whose workspace holds the session's folder. */
export function ownerOf(cwd: string, linksDir: string): Link | null {
  let names: string[] = []
  try { names = readdirSync(linksDir) } catch { return null }
  const dir = cwd.replace(/[/\\]+$/, '')
  let best: Link | null = null
  let bestLength = -1
  for (const name of names) {
    const link: Link | null = readJson(join(linksDir, name))
    if (!link) continue
    for (const folder of link.folders || []) {
      const root = folder.replace(/[/\\]+$/, '')
      if ((dir === root || dir.startsWith(root + '/')) && root.length > bestLength) {
        best = link
        bestLength = root.length
      }
    }
  }
  return best
}

export function windowName(link: Link): string {
  const target = link.workspaceFile || (link.folders || [])[0] || ''
  return basename(target).replace(/\.code-workspace$/, '')
}
