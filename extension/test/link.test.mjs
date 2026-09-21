import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const SCRIPT = new URL('../../hooks/claude-notify.mjs', import.meta.url).pathname
const home = mkdtempSync(join(tmpdir(), 'cn-link-'))
const links = join(home, '.claude', 'claude-notify', 'links')
mkdirSync(links, { recursive: true })
// no notifications in this test — only the link
writeFileSync(join(home, '.claude', 'claude-notify.config.json'), JSON.stringify({ enabled: false }))

/** A fake VS Code window: a listener plus the link file the extension would write. */
async function fakeWindow(name, folders, focusedAt, pid = process.pid) {
  const got = []
  const token = `token-${name}`
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      got.push({ path: req.url, token: req.headers['x-claude-notify-token'], body: JSON.parse(raw) })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const file = join(links, `${name}.json`)
  writeFileSync(file, JSON.stringify({ port: srv.address().port, token, pid, folders, focusedAt }))
  return { got, token, file, close: () => srv.close() }
}

const run = (payload) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'ignore', 'ignore'] })
  p.on('close', resolve)
  p.stdin.end(JSON.stringify(payload))
})
const S = '11111111-2222-4333-8444-555555555555'
let n = 0
const ok = (name) => { n++; console.log('ok  ', name) }

const a = await fakeWindow('a', ['/work/app'], 100)
const b = await fakeWindow('b', ['/work/planner'], 200)

await run({ hook_event_name: 'Notification', session_id: S, cwd: '/work/app/packages/ui', message: 'hi' })
assert.equal(a.got.length, 1); assert.equal(b.got.length, 0)
assert.equal(a.got[0].token, a.token)
ok('an event goes to the window whose folder holds the session, not the one used last')

await run({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/somewhere/else' })
assert.equal(b.got.length, 1); assert.equal(a.got.length, 1)
ok('a session outside every workspace goes to the window focused most recently')

await run({ hook_event_name: 'Stop', session_id: S, cwd: '/work/app', agent_id: 'sub' })
assert.equal(a.got.length + b.got.length, 2)
ok('subagents stay silent')

assert.deepEqual(a.got.map((g) => g.body.event), ['Notification'])
assert.equal(a.got[0].body.lane, 'ui')
ok('disabled notifications still feed the status bar')

const dead = await fakeWindow('dead', ['/work/app/packages'], 999, 999999)
await run({ hook_event_name: 'Notification', session_id: S, cwd: '/work/app/packages/ui', message: 'hi' })
assert.equal(dead.got.length, 0); assert.equal(a.got.length, 2)
assert.equal(existsSync(dead.file), false)
ok('a window that crashed is skipped and its link file cleaned up')

for (const w of [a, b, dead]) w.close()
console.log(`\n${n} passed`)
