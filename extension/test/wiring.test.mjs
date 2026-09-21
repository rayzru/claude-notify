import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as w from './.build/wiring.mjs'

const fresh = () => mkdtempSync(join(tmpdir(), 'cn-home-'))
const settings = (h) => JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))
const ours = (h) => `node "${w.stableScriptPath(h)}"`
let n = 0
const test = (name, fn) => { fn(); n++; console.log('ok  ', name) }

test('empty home: adds the four hooks', () => {
  const h = fresh()
  assert.equal(w.hooksWired(h), false)
  w.wireHooks(h)
  assert.equal(w.hooksWired(h), true)
  for (const e of w.HOOK_EVENTS) assert.equal(settings(h).hooks[e].length, 1)
})

test('leaves other hooks and keys alone; running twice adds nothing', () => {
  const h = fresh(); mkdirSync(join(h, '.claude'))
  const other = { hooks: [{ type: 'command', command: 'other-tool stop' }] }
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ theme: 'light', hooks: { Stop: [other] } }))
  w.wireHooks(h); w.wireHooks(h)
  const s = settings(h)
  assert.equal(s.theme, 'light')
  assert.equal(s.hooks.Stop.length, 2)
  assert.deepEqual(s.hooks.Stop[0], other)
  assert.equal(s.hooks.Notification.length, 1)
})

test('removal takes only ours and drops events left empty', () => {
  const h = fresh(); mkdirSync(join(h, '.claude'))
  const other = { hooks: [{ type: 'command', command: 'other-tool stop' }] }
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [other] } }))
  w.wireHooks(h)
  assert.equal(w.unwireHooks(h), 4)
  const s = settings(h)
  assert.deepEqual(s.hooks.Stop, [other])
  assert.equal('Notification' in s.hooks, false)
  assert.equal(w.unwireHooks(h), 0)
})

test('refuses to rewrite an unreadable settings.json', () => {
  const h = fresh(); mkdirSync(join(h, '.claude'))
  writeFileSync(join(h, '.claude', 'settings.json'), '{ not json')
  assert.throws(() => w.wireHooks(h))
  assert.equal(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'), '{ not json')
})

test('detects the Claude Code plugin', () => {
  const h = fresh()
  assert.equal(w.pluginInstalled(h), false)
  mkdirSync(join(h, '.claude', 'plugins'), { recursive: true })
  writeFileSync(join(h, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'claude-notify@rayzru': [{}] } }))
  assert.equal(w.pluginInstalled(h), true)
})

test('copies the script only when it changed', () => {
  const h = fresh(); const src = join(h, 'bundled.mjs'); writeFileSync(src, '// v1')
  assert.equal(w.installScript(src, h), true)
  assert.equal(w.installScript(src, h), false)
  writeFileSync(src, '// v2')
  assert.equal(w.installScript(src, h), true)
  assert.equal(readFileSync(w.stableScriptPath(h), 'utf8'), '// v2')
})

test('config: writes our keys, keeps the rest', () => {
  const h = fresh(); mkdirSync(join(h, '.claude'))
  writeFileSync(w.configPath(h), JSON.stringify({ language: 'ru', enabled: false }))
  w.writeConfig(h, { enabled: true, minTurnSeconds: 30, events: ['done'], style: 'banner', sound: false })
  const c = JSON.parse(readFileSync(w.configPath(h), 'utf8'))
  assert.equal(c.language, 'ru'); assert.equal(c.enabled, true); assert.equal(c.minTurnSeconds, 30)
  assert.deepEqual(c.events, { done: true, error: false, waitingInput: false })
})

test('full removal leaves nothing behind', () => {
  const h = fresh(); const src = join(h, 'b.mjs'); writeFileSync(src, '//')
  w.installScript(src, h); w.wireHooks(h)
  writeFileSync(w.legacyLinkPath(h), '{}')
  mkdirSync(w.linksDir(h), { recursive: true }); writeFileSync(w.linkPath(h, 123), '{}')
  assert.equal(w.removeEverything(h), 4)
  assert.equal(existsSync(w.stableScriptPath(h)), false)
  assert.equal(existsSync(w.legacyLinkPath(h)), false)
  assert.equal(existsSync(w.linkPath(h, 123)), false)
  assert.equal(w.hooksWired(h), false)
})

console.log(`\n${n} passed`)
