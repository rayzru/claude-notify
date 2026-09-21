import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
  put(d, 'r-old', { state: 'running', at: NOW - 600_000 })
  put(d, 'w-new', { state: 'waiting', at: NOW - 60_000 })
  put(d, 'r-new', { state: 'running', at: NOW - 60_000 })
  put(d, 'w-old', { state: 'waiting', at: NOW - 900_000 })
  assert.deepEqual(s.readSessions(d, NOW).map((x) => x.session), ['w-old', 'w-new', 'r-new', 'r-old'])
})

test('a session silent for three hours is dropped and its file removed', () => {
  const d = dir()
  put(d, 'stale', { state: 'running', at: NOW - s.SESSION_TTL_MS - 1 })
  put(d, 'live', { state: 'running', at: NOW })
  assert.deepEqual(s.readSessions(d, NOW).map((x) => x.session), ['live'])
  assert.equal(existsSync(join(d, 'stale.json')), false)
})

test('unreadable files are cleaned up, a missing directory is an empty list', () => {
  const d = dir()
  writeFileSync(join(d, 'broken.json'), '{ nope')
  assert.deepEqual(s.readSessions(d, NOW), [])
  assert.equal(existsSync(join(d, 'broken.json')), false)
  assert.deepEqual(s.readSessions(join(d, 'absent'), NOW), [])
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
  assert.deepEqual(s.readDetails('/nope/t.jsonl'), { title: '', model: '', contextTokens: 0 })
  assert.deepEqual(s.readDetails(''), { title: '', model: '', contextTokens: 0 })
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

console.log(`\n${n} passed`)
