import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as s from './.build/sessions.mjs'

let n = 0
const test = (name, fn) => { fn(); n++; console.log('ok  ', name) }
const dir = () => mkdtempSync(join(tmpdir(), 'cn-sessions-'))
const put = (d, id, body) => writeFileSync(join(d, `${id}.json`), JSON.stringify({ session: id, ...body }))
const NOW = 10_000_000_000

test('waiting first (longest wait on top), then running (most recent on top)', () => {
  const d = dir()
  put(d, 'r-old', { state: 'running', at: NOW - 300_000 })
  put(d, 'w-new', { state: 'waiting', at: NOW - 60_000 })
  put(d, 'r-new', { state: 'running', at: NOW - 60_000 })
  put(d, 'w-old', { state: 'waiting', at: NOW - 900_000 })
  assert.deepEqual(s.readSessions(d, '', NOW).map((x) => x.session), ['w-old', 'w-new', 'r-new', 'r-old'])
})

test('a session silent for three hours is dropped and its file removed', () => {
  const d = dir()
  put(d, 'stale', { state: 'running', at: NOW - s.SESSION_TTL_MS - 1 })
  put(d, 'live', { state: 'running', at: NOW })
  assert.deepEqual(s.readSessions(d, '', NOW).map((x) => x.session), ['live'])
  assert.equal(existsSync(join(d, 'stale.json')), false)
})

test('unreadable files are cleaned up, a missing directory is an empty list', () => {
  const d = dir()
  writeFileSync(join(d, 'broken.json'), '{ nope')
  assert.deepEqual(s.readSessions(d, '', NOW), [])
  assert.equal(existsSync(join(d, 'broken.json')), false)
  assert.deepEqual(s.readSessions(join(d, 'absent'), '', NOW), [])
})

test('title, model and context come from the latest lines of the transcript', () => {
  const d = dir()
  const t = join(d, 't.jsonl')
  const filler = JSON.stringify({ type: 'attachment', pad: 'x'.repeat(200) })
  const lines = [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Old title' }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } } }),
    ...Array(2000).fill(filler), // pushes the old lines out of the tail
    JSON.stringify({ type: 'ai-title', aiTitle: 'Плагин VSCode сигнализирование о статусе' }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 2, cache_read_input_tokens: 392239, cache_creation_input_tokens: 4049 } } }),
  ]
  writeFileSync(t, lines.join('\n') + '\n')
  const got = s.readDetails(t)
  assert.equal(got.title, 'Плагин VSCode сигнализирование о статусе')
  assert.equal(got.model, 'claude-opus-5')
  assert.equal(got.contextTokens, 396290)
})

test('a name the user gave the tab wins over a title Claude chooses later, as on the tab', () => {
  const d = dir(); const t = join(d, 't.jsonl')
  writeFileSync(t, [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Claude\'s first idea' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Release 0.3', sessionId: 'x' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Bump the version' }),
  ].join('\n') + '\n')
  assert.equal(s.readDetails(t).title, 'Release 0.3')
})

test('a missing transcript gives empty details rather than an error', () => {
  assert.deepEqual(s.readDetails('/nope/t.jsonl'), { title: '', model: '', contextTokens: 0, cwd: '', reply: '' })
  assert.deepEqual(s.readDetails(''), { title: '', model: '', contextTokens: 0, cwd: '', reply: '' })
})

test('model names, token counts and ages read like a person wrote them', () => {
  assert.equal(s.modelName('claude-opus-5'), 'Opus 5')
  assert.equal(s.modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(s.modelName('claude-opus-5[1m]'), 'Opus 5')
  assert.equal(s.tokens(396290), '396K')
  assert.equal(s.tokens(1_250_000), '1.3M')
  assert.equal(s.ago(NOW - 30_000, NOW), 'just now')
  assert.equal(s.ago(NOW - 5 * 60_000, NOW), '5 min')
  assert.equal(s.ago(NOW - 125 * 60_000, NOW), '2 h 5 min')
})

test('the owning window is the one whose folder holds the session, deepest match wins', () => {
  const d = dir(); mkdirSync(join(d, 'links'))
  writeFileSync(join(d, 'links', '1.json'), JSON.stringify({ pid: 1, folders: ['/work'] }))
  writeFileSync(join(d, 'links', '2.json'), JSON.stringify({ pid: 2, folders: ['/work/app'] }))
  writeFileSync(join(d, 'links', '3.json'), JSON.stringify({ pid: 3, workspaceFile: '/w/team.code-workspace', folders: ['/work/planner'] }))
  assert.equal(s.ownerOf('/work/app/src', join(d, 'links')).pid, 2)
  assert.equal(s.ownerOf('/work/other', join(d, 'links')).pid, 1)
  assert.equal(s.ownerOf('/elsewhere', join(d, 'links')), null)
  assert.equal(s.windowName(s.ownerOf('/work/planner', join(d, 'links'))), 'team')
})

/* -------------------------------------------- liveness from the transcript */

const secs = (ms) => ms / 1000
const iso = (at) => new Date(at).toISOString()
function transcript(path, ageMs, cwd = '/work/app') {
  writeFileSync(path, JSON.stringify({ type: 'user', cwd, timestamp: iso(NOW - ageMs) }) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'T' }) + '\n')
  utimesSync(path, secs(NOW - ageMs), secs(NOW - ageMs))
}
/** What reopening or closing the editor does to every restored session: undated lines, a fresh file time. */
function reopened(path, ageMs = 1000) {
  appendFileSync(path, ['last-prompt', 'cost-state', 'mode'].map((type) => JSON.stringify({ type, sessionId: 'x' })).join('\n') + '\n')
  utimesSync(path, secs(NOW - ageMs), secs(NOW - ageMs))
}

test('"running" with a transcript quiet for ten minutes was interrupted, and is not shown', () => {
  const d = dir(); const t = join(d, 't.jsonl')
  transcript(t, 11 * 60_000)
  put(d, 'x', { state: 'running', at: NOW - 30 * 60_000, transcript: t })
  assert.deepEqual(s.readSessions(d, '', NOW), [])
})

test('an old prompt still counts as running while the transcript keeps being written', () => {
  const d = dir(); const t = join(d, 't.jsonl')
  transcript(t, 60_000)
  put(d, 'x', { state: 'running', at: NOW - 30 * 60_000, transcript: t })
  assert.deepEqual(s.readSessions(d, '', NOW).map((x) => x.session), ['x'])
})

test('housekeeping lines written just after a turn ends do not bring it back', () => {
  const d = dir(); const t = join(d, 't.jsonl')
  transcript(t, 50_000)
  put(d, 'x', { state: 'done', at: NOW - 60_000, transcript: t }) // written 10 s after Stop
  assert.deepEqual(s.readSessions(d, '', NOW), [])
})

test('a finished session writing again well after its turn ended is running again', () => {
  const d = dir(); const t = join(d, 't.jsonl')
  transcript(t, 20_000)
  put(d, 'x', { state: 'done', at: NOW - 10 * 60_000, transcript: t })
  const got = s.readSessions(d, '', NOW)
  assert.equal(got.length, 1); assert.equal(got[0].state, 'running')
})

test('waiting stays waiting however quiet the transcript is', () => {
  const d = dir(); const t = join(d, 't.jsonl')
  transcript(t, 60 * 60_000)
  put(d, 'x', { state: 'waiting', at: NOW - 60 * 60_000, transcript: t })
  assert.deepEqual(s.readSessions(d, '', NOW).map((x) => x.state), ['waiting'])
})

test('a session no hook has told us about is found by its transcript being written', () => {
  const d = dir(); const projects = join(d, 'projects')
  const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const B = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  mkdirSync(join(projects, '-work-app', A, 'subagents'), { recursive: true })
  transcript(join(projects, '-work-app', `${A}.jsonl`), 30_000, '/work/app/packages/ui')
  transcript(join(projects, '-work-app', `${B}.jsonl`), 5 * 60_000)
  transcript(join(projects, '-work-app', A, 'subagents', 'agent-1.jsonl'), 1000) // a subagent's own
  transcript(join(projects, '-work-app', 'not-a-session.jsonl'), 1000)
  const got = s.readSessions(join(d, 'registry'), projects, NOW)
  assert.deepEqual(got.map((x) => x.session), [A])
  assert.equal(got[0].state, 'running')
  assert.equal(got[0].cwd, '/work/app/packages/ui')
  assert.equal(got[0].project, 'ui')
})

test('a session the registry knows is not listed twice when its transcript is fresh', () => {
  const d = dir(); const projects = join(d, 'projects')
  const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  mkdirSync(join(projects, '-work-app'), { recursive: true })
  const t = join(projects, '-work-app', `${A}.jsonl`)
  transcript(t, 10_000)
  mkdirSync(join(d, 'registry'))
  put(join(d, 'registry'), A, { state: 'waiting', at: NOW - 5_000, transcript: t, message: 'permission' })
  const got = s.readSessions(join(d, 'registry'), projects, NOW)
  assert.equal(got.length, 1); assert.equal(got[0].state, 'waiting')
})

test('reopening the editor touches every restored transcript, and none of them is running', () => {
  const d = dir(); const projects = join(d, 'projects'); const registry = join(d, 'registry')
  const ids = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].map((p) => `${p}-bbbb-4ccc-8ddd-eeeeeeeeeeee`)
  mkdirSync(join(projects, '-work-app'), { recursive: true }); mkdirSync(registry)
  const [done, cut, unknown] = ids.map((id) => join(projects, '-work-app', `${id}.jsonl`))
  transcript(done, 60 * 60_000); reopened(done)
  put(registry, ids[0], { state: 'done', at: NOW - 60 * 60_000, transcript: done })
  transcript(cut, 30 * 60_000); reopened(cut) // quit mid-turn, not resumed
  put(registry, ids[1], { state: 'running', at: NOW - 30 * 60_000, transcript: cut })
  transcript(unknown, 2 * 24 * 3600_000); reopened(unknown)
  assert.deepEqual(s.readSessions(registry, projects, NOW), [])
})

test('a resumed turn after a restart is running again', () => {
  const d = dir(); const t = join(d, 't.jsonl')
  transcript(t, 30 * 60_000); reopened(t, 5000)
  appendFileSync(t, JSON.stringify({ type: 'assistant', timestamp: iso(NOW - 2000) }) + '\n')
  utimesSync(t, secs(NOW - 2000), secs(NOW - 2000))
  put(d, 'x', { state: 'running', at: NOW - 30 * 60_000, transcript: t })
  assert.deepEqual(s.readSessions(d, '', NOW).map((x) => x.session), ['x'])
  assert.equal(s.workedAt(t), NOW - 2000)
})

test('a record longer than the tail that is read is still taken as work', () => {
  const d = dir(); const t = join(d, 't.jsonl')
  transcript(t, 60 * 60_000)
  appendFileSync(t, JSON.stringify({ type: 'user', pad: 'x'.repeat(400 * 1024), timestamp: iso(NOW - 3000) }) + '\n')
  utimesSync(t, secs(NOW - 3000), secs(NOW - 3000))
  assert.equal(s.workedAt(t), NOW - 3000)
  assert.equal(s.workedAt(t, NOW - 1000), NOW - 3000) // not read: older than asked about
})

test('the starting folder comes from the head of the transcript, the current one from its tail', () => {
  const d = dir(); const projects = join(d, 'projects')
  const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  mkdirSync(join(projects, '-work-planner'), { recursive: true })
  const t = join(projects, '-work-planner', `${A}.jsonl`)
  writeFileSync(t, [
    JSON.stringify({ type: 'user', cwd: '/work/planner', timestamp: iso(NOW - 9000) }),
    JSON.stringify({ type: 'user', cwd: '/work/iss', timestamp: iso(NOW - 5000) }),
  ].join('\n') + '\n')
  utimesSync(t, secs(NOW - 5000), secs(NOW - 5000))
  assert.equal(s.readRoot(t), '/work/planner')
  const [got] = s.readSessions(join(d, 'registry'), projects, NOW)
  assert.equal(got.root, '/work/planner'); assert.equal(got.cwd, '/work/iss'); assert.equal(got.project, 'planner')
})

test('an entry written before the starting folder was recorded gets it from the transcript', () => {
  const d = dir(); const t = join(d, 't.jsonl')
  writeFileSync(t, JSON.stringify({ type: 'user', cwd: '/work/planner' }) + '\n' + JSON.stringify({ type: 'user', cwd: '/work/iss' }) + '\n')
  put(d, 'x', { state: 'waiting', at: NOW - 1000, transcript: t, cwd: '/work/iss' })
  const [got] = s.readSessions(d, '', NOW)
  assert.equal(got.root, '/work/planner'); assert.equal(got.project, 'planner')
})

/* ------------------------------------------- Claude Code's own account of its processes */

const procDir = () => { const d = dir(); mkdirSync(join(d, 'procs')); return d }
const proc = (d, pid, body) => writeFileSync(join(d, 'procs', `${pid}.json`), JSON.stringify({ pid, procStart: `start-${pid}`, ...body }))
const DEAD = 4
const runs = (pid, procStart) => pid !== DEAD && procStart === `start-${pid}`

test('Claude Code says which session each running process holds and what it is doing', () => {
  const d = procDir()
  proc(d, 1, { sessionId: 'busy', status: 'busy', cwd: '/work/app', statusUpdatedAt: NOW - 60_000 })
  proc(d, 2, { sessionId: 'asks', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: NOW - 5000 })
  proc(d, 3, { sessionId: 'idle', status: 'idle', statusUpdatedAt: NOW - 5000 })
  proc(d, DEAD, { sessionId: 'crashed', status: 'busy' }) // its process is gone
  proc(d, 5, { sessionId: 'reused', status: 'busy', procStart: 'an earlier process' }) // the pid went to another
  proc(d, 6, { sessionId: 'spare', status: 'idle', spare: true }) // started ahead of need
  proc(d, 7, { sessionId: 'old', cwd: '/work/app' }) // a version that kept no status
  writeFileSync(join(d, 'procs', '1.abcdef.key'), '{}')
  const live = s.readLive(join(d, 'procs'), runs)
  assert.deepEqual([...live.keys()].sort(), ['asks', 'busy', 'idle'])
  assert.deepEqual(live.get('busy'), { session: 'busy', status: 'busy', waitingFor: '', cwd: '/work/app', since: NOW - 60_000 })
  assert.equal(live.get('asks').waitingFor, 'input needed')
  assert.equal(s.readLive(join(d, 'absent'), runs).size, 0)
})

test('two processes on one session: the one doing something speaks for it', () => {
  const d = procDir()
  proc(d, 1, { sessionId: 'x', status: 'idle', statusUpdatedAt: NOW })
  proc(d, 2, { sessionId: 'x', status: 'busy', statusUpdatedAt: NOW - 60_000 })
  assert.equal(s.readLive(join(d, 'procs'), runs).get('x').status, 'busy')
})

test('a process is the one that wrote its file only if it started when the file says', () => {
  const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, encoding: 'utf8' }).trim()
  assert.equal(s.runningProcess(process.pid, started), true)
  assert.equal(s.runningProcess(process.pid, 'Mon Jan  1 00:00:00 2001'), false)
  assert.equal(s.runningProcess(99_999_999, started), false)
  assert.equal(s.runningProcess(0, ''), false)
})

const live = (entries) => new Map(entries.map((l) => [l.session, { waitingFor: '', cwd: '/work/app', since: NOW - 60_000, ...l }]))

test('a finished turn whose background agents still work is running, since Claude Code went busy', () => {
  const d = dir(); const t = join(d, 't.jsonl')
  transcript(t, 20 * 60_000) // the main transcript is quiet; the agents write elsewhere
  put(d, 'x', { state: 'done', at: NOW - 20 * 60_000, transcript: t })
  const [got] = s.readSessions(d, '', NOW, live([{ session: 'x', status: 'busy', since: NOW - 25 * 60_000 }]))
  assert.equal(got.state, 'running'); assert.equal(got.at, NOW - 25 * 60_000); assert.equal(got.transcript, t)
})

test('idle in Claude Code\'s word is not running, however fresh the hook or the transcript', () => {
  const d = dir(); const projects = join(d, 'projects'); const registry = join(d, 'registry')
  const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  mkdirSync(join(projects, '-work-app'), { recursive: true }); mkdirSync(registry)
  const t = join(projects, '-work-app', `${A}.jsonl`)
  transcript(t, 10_000)
  put(registry, 'x', { state: 'running', at: NOW - 10_000, transcript: t })
  assert.deepEqual(s.readSessions(registry, projects, NOW, live([{ session: 'x', status: 'idle' }, { session: A, status: 'idle' }])), [])
})

test('a permission prompt in a VS Code tab leaves the process busy; the hook\'s wait stands', () => {
  const d = dir()
  put(d, 'x', { state: 'waiting', at: NOW - 30_000, message: 'Claude needs your permission to use Bash' })
  const [got] = s.readSessions(d, '', NOW, live([{ session: 'x', status: 'busy' }]))
  assert.equal(got.state, 'waiting'); assert.equal(got.message, 'Claude needs your permission to use Bash'); assert.equal(got.at, NOW - 30_000)
})

test('busy again after the prompt means it was answered; idle, that it went away unanswered', () => {
  const d = dir()
  put(d, 'x', { state: 'waiting', at: NOW - 30_000, message: 'Claude needs your permission to use AskUserQuestion' })
  const [got] = s.readSessions(d, '', NOW, live([{ session: 'x', status: 'busy', since: NOW - 10_000 }]))
  assert.equal(got.state, 'running'); assert.equal(got.at, NOW - 10_000)
  assert.deepEqual(s.readSessions(d, '', NOW, live([{ session: 'x', status: 'idle', since: NOW - 10_000 }])), [])
})

test('a session only Claude Code knows of is listed with its transcript, found by its folder', () => {
  const d = dir(); const projects = join(d, 'projects')
  const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const B = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  mkdirSync(join(projects, '-work-planner'), { recursive: true }); mkdirSync(join(projects, '-elsewhere'))
  writeFileSync(join(projects, '-work-planner', `${A}.jsonl`), JSON.stringify({ type: 'user', cwd: '/work/planner' }) + '\n')
  writeFileSync(join(projects, '-elsewhere', `${B}.jsonl`), JSON.stringify({ type: 'user', cwd: '/work/started-here' }) + '\n')
  const got = s.readSessions(join(d, 'registry'), projects, NOW, live([
    { session: A, status: 'busy', cwd: '/work/planner' },
    { session: B, status: 'waiting', waitingFor: 'input needed', cwd: '/work/moved' },
  ]))
  assert.deepEqual(got.map((x) => [x.session, x.state, x.root, x.message]), [
    [B, 'waiting', '/work/started-here', 'input needed'],
    [A, 'running', '/work/planner', ''],
  ])
  assert.equal(got[1].transcript, join(projects, '-work-planner', `${A}.jsonl`))
})

test('the list shows how the last answer began', () => {
  const d = dir(); const t = join(d, 't.jsonl')
  writeFileSync(t, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'An older answer.' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Listener is up and **waiting** for the webhook — nothing to do until it fires.' }] } }),
  ].join('\n') + '\n')
  assert.equal(s.readDetails(t).reply, 'Listener is up and waiting for the webhook — nothing to do until it fires.')
})

test('a long answer is cut at its first sentence, or at a word with an ellipsis', () => {
  assert.equal(s.excerpt('Done with the migration. ' + 'x '.repeat(200)), 'Done with the migration.')
  const cut = s.excerpt('word '.repeat(100))
  assert.ok(cut.endsWith('…') && cut.length <= 140)
})

test('a session gone to stops waiting; one that is not waiting is left as it is', () => {
  const d = dir()
  const read = (id) => JSON.parse(readFileSync(join(d, `${id}.json`), 'utf8'))
  put(d, 'w', { state: 'waiting', message: 'Claude needs your permission to use Bash', at: 1 })
  put(d, 'r', { state: 'running', message: '', at: 1 })
  s.markSeen(d, 'w', NOW)
  s.markSeen(d, 'r', NOW)
  s.markSeen(d, 'missing', NOW)
  assert.deepEqual(read('w'), { session: 'w', state: 'running', message: '', at: NOW })
  assert.equal(read('r').at, 1)
  assert.equal(existsSync(join(d, 'missing.json')), false)
})

test('the session last written to, among those in this window; finished ones count', () => {
  const d = dir()
  put(d, 'a', { state: 'done', root: '/work/app', promptedAt: 300 })
  put(d, 'b', { state: 'running', root: '/work/app/packages/ui', promptedAt: 200 })
  put(d, 'c', { state: 'running', root: '/work/other', promptedAt: 900 })
  put(d, 'd', { state: 'running', root: '/work/app' }) // never prompted through the hook
  const here = (root) => root === '/work/app' || root.startsWith('/work/app/')
  assert.equal(s.lastPrompted(d, here), 'a')
  put(d, 'b', { state: 'running', root: '/work/app/packages/ui', promptedAt: 400 })
  assert.equal(s.lastPrompted(d, here), 'b')
  assert.equal(s.lastPrompted(d, () => false), '')
  assert.equal(s.lastPrompted(join(d, 'absent'), here), '')
})

console.log(`\n${n} passed`)
