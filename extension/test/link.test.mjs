import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const SCRIPT = new URL('../../hooks/claude-notify.mjs', import.meta.url).pathname
const home = mkdtempSync(join(tmpdir(), 'cn-link-'))
const base = join(home, '.claude', 'claude-notify')
const links = join(base, 'links')
const sessions = join(base, 'sessions')
mkdirSync(links, { recursive: true })
// no notifications in this test — only the registry and the routing
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

const run = (args, payload) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'ignore', 'ignore'] })
  p.on('close', resolve)
  p.stdin.end(payload ? JSON.stringify(payload) : '')
})
const hook = (payload) => run([], payload)
const entry = (id) => existsSync(join(sessions, `${id}.json`)) ? JSON.parse(readFileSync(join(sessions, `${id}.json`), 'utf8')) : null

const A = '11111111-2222-4333-8444-555555555555'
const B = '66666666-7777-4888-8999-000000000000'
let n = 0
const ok = (name) => { n++; console.log('ok  ', name) }

await hook({ hook_event_name: 'UserPromptSubmit', session_id: A, cwd: '/work/app/packages/ui', transcript_path: '/t/a.jsonl' })
assert.equal(entry(A).state, 'running')
assert.equal(entry(A).project, 'ui')
assert.equal(entry(A).transcript, '/t/a.jsonl')
ok('a prompt puts the session on the list as running, with its folder and transcript')

await hook({ hook_event_name: 'Notification', session_id: A, cwd: '/work/app/packages/ui', message: 'Claude needs your permission to use Bash' })
assert.equal(entry(A).state, 'waiting')
assert.equal(entry(A).message, 'Claude needs your permission to use Bash')
ok('a notification marks it waiting, with what it is waiting for')

await hook({ hook_event_name: 'Notification', session_id: B, cwd: '/work/planner', message: 'x', agent_id: 'sub' })
assert.equal(entry(B), null)
ok('subagents stay off the list')

const a = await fakeWindow('a', ['/work/app'], 100)
const b = await fakeWindow('b', ['/work/planner'], 200)
await run(['--focus', A])
assert.equal(a.got.length, 1); assert.equal(b.got.length, 0)
assert.equal(a.got[0].path, '/focus'); assert.equal(a.got[0].body.session, A); assert.equal(a.got[0].token, a.token)
ok('picking a session goes to the window whose folder holds it, not the one used last')

assert.equal(entry(A).state, 'running')
ok('once the user has gone to a waiting session, it stops calling for attention')

await hook({ hook_event_name: 'UserPromptSubmit', session_id: B, cwd: '/somewhere/else' })
await run(['--focus', B])
assert.equal(b.got.length, 1)
ok('a session outside every workspace goes to the window focused most recently')

const dead = await fakeWindow('dead', ['/work/app/packages'], 999, 999999)
await run(['--focus', A])
assert.equal(dead.got.length, 0); assert.equal(a.got.length, 2)
assert.equal(existsSync(dead.file), false)
ok('a window that crashed is skipped and its link file cleaned up')

await hook({ hook_event_name: 'Stop', session_id: A, cwd: '/work/app/packages/ui' })
assert.equal(entry(A), null)
ok('Stop takes the session off the list')

for (const w of [a, b, dead]) w.close()
console.log(`\n${n} passed`)
