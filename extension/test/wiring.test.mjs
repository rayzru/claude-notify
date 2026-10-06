import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as w from './.build/wiring.mjs'

const fresh = () => mkdtempSync(join(tmpdir(), 'cn-home-'))
const settings = (h) => JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))
const ours = (h) => `"${w.runnerPath(h)}"`
const legacy = (h) => `node "${w.stableScriptPath(h)}"`
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

test('hooks from before the runner are replaced, not doubled, and removal takes both kinds', () => {
  const h = fresh(); mkdirSync(join(h, '.claude'))
  const other = { type: 'command', command: 'other-tool stop' }
  const old = (cmd) => ({ hooks: [{ type: 'command', command: cmd, timeout: 10 }] })
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    Stop: [{ hooks: [other, { type: 'command', command: legacy(h) }] }],
    Notification: [old(legacy(h))],
  } }))
  assert.equal(w.hooksOutdated(h), true)
  w.wireHooks(h)
  assert.equal(w.hooksOutdated(h), false)
  assert.equal(w.hooksWired(h), true)
  const s = settings(h)
  assert.deepEqual(s.hooks.Stop[0].hooks, [other])
  assert.equal(s.hooks.Stop[1].hooks[0].command, ours(h))
  assert.equal(s.hooks.Notification.length, 1)
  // An install that was never migrated still comes out clean.
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [old(legacy(h)), old(ours(h))] } }))
  assert.equal(w.unwireHooks(h), 2)
})

test('the runner starts the notifier with the editor runtime, and falls back to node', () => {
  const h = fresh()
  const runtime = join(h, 'fake runtime')
  writeFileSync(runtime, '#!/bin/sh\necho "runtime $ELECTRON_RUN_AS_NODE $*"\n', { mode: 0o755 })
  assert.equal(w.writeRunner(h, runtime), true)
  assert.equal(w.writeRunner(h, runtime), false)
  assert.equal(statSync(w.runnerPath(h)).mode & 0o111, 0o111)
  const viaRuntime = spawnSync(w.runnerPath(h), ['--focus', 'x'], { encoding: 'utf8' })
  assert.equal(viaRuntime.stdout.trim(), `runtime 1 ${w.stableScriptPath(h)} --focus x`)
  // The editor moved: node on PATH runs the script instead.
  mkdirSync(join(h, '.claude', 'claude-notify'), { recursive: true })
  writeFileSync(w.stableScriptPath(h), 'console.log("node", process.argv.slice(2).join(" "))\n')
  w.writeRunner(h, join(h, 'gone'))
  assert.equal(spawnSync(w.runnerPath(h), ['--doctor'], { encoding: 'utf8' }).stdout.trim(), 'node --doctor')
})

test('the notifying app is copied only when it changed, and not at all where it was not built', () => {
  const h = fresh()
  const bundled = join(h, 'notify-helper')
  const binary = (root) => join(root, 'Contents', 'MacOS', 'notify')
  assert.equal(w.installHelper(bundled, h), false)
  mkdirSync(join(bundled, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(binary(bundled), 'v1')
  writeFileSync(join(bundled, 'Contents', 'Info.plist'), '<plist/>')
  assert.equal(w.installHelper(bundled, h), true)
  assert.equal(readFileSync(binary(w.helperPath(h)), 'utf8'), 'v1')
  assert.ok(w.helperPath(h).endsWith('.app'))
  assert.equal(w.installHelper(bundled, h), false)
  writeFileSync(binary(bundled), 'v2')
  assert.equal(w.installHelper(bundled, h), true)
  assert.equal(readFileSync(binary(w.helperPath(h)), 'utf8'), 'v2')
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

test('a pause holds until its time, or until resumed, for each scope on its own', () => {
  const h = fresh()
  assert.equal(w.pausedUntil(h, 'all'), 0)
  w.setPause(h, 'all', 2_000)
  w.setPause(h, 'editor', Infinity)
  assert.equal(w.pausedUntil(h, 'all', 1_000), 2_000)
  assert.equal(w.pausedUntil(h, 'all', 3_000), 0)
  assert.equal(w.pausedUntil(h, 'editor', 3_000), Infinity)
  // The notifier reads the same file: until resumed is stored as true, not as a number.
  assert.deepEqual(JSON.parse(readFileSync(w.pausePath(h), 'utf8')), { all: 2_000, editor: true })
  w.setPause(h, 'editor', null)
  assert.equal(w.pausedUntil(h, 'editor'), 0)
  assert.equal(w.pausedUntil(h, 'all', 1_000), 2_000)
})

console.log(`\n${n} passed`)
