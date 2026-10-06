import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
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
function transcript(path, ageMs, cwd = '/work/app') {
  writeFileSync(path, JSON.stringify({ type: 'user', cwd }) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'T' }) + '\n')
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

test('the starting folder comes from the head of the transcript, the current one from its tail', () => {
  const d = dir(); const projects = join(d, 'projects')
  const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  mkdirSync(join(projects, '-work-planner'), { recursive: true })
  const t = join(projects, '-work-planner', `${A}.jsonl`)
  writeFileSync(t, [
    JSON.stringify({ type: 'user', cwd: '/work/planner' }),
    JSON.stringify({ type: 'user', cwd: '/work/iss' }),
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

console.log(`\n${n} passed`)
