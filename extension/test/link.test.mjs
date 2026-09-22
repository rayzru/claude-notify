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
  const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] })
  let out = ''
  p.stdout.on('data', (c) => { out += c })
  p.on('close', () => resolve(out.trim()))
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
assert.equal(await run(['--focus', A]), 'focused')
assert.equal(a.got.length, 1); assert.equal(b.got.length, 0)
assert.equal(a.got[0].path, '/focus'); assert.equal(a.got[0].body.session, A); assert.equal(a.got[0].token, a.token)
ok('picking a session goes to the window whose folder holds it, not the one used last')

assert.equal(entry(A).state, 'running')
ok('once the user has gone to a waiting session, it stops calling for attention')

await hook({ hook_event_name: 'UserPromptSubmit', session_id: B, cwd: '/somewhere/else' })
assert.equal(await run(['--focus', B]), 'no-window')
assert.equal(a.got.length, 1); assert.equal(b.got.length, 0)
ok('a session no window holds is sent nowhere — a stranger window would show an empty tab')

const dead = await fakeWindow('dead', ['/work/app/packages'], 999, 999999)
await run(['--focus', A])
assert.equal(dead.got.length, 0); assert.equal(a.got.length, 2)
assert.equal(existsSync(dead.file), false)
ok('a window that crashed is skipped and its link file cleaned up')

await hook({ hook_event_name: 'Stop', session_id: A, cwd: '/work/app/packages/ui' })
assert.equal(entry(A).state, 'done')
assert.equal(entry(A).cwd, '/work/app/packages/ui')
ok('Stop marks where the turn ended, so housekeeping writes after it are not mistaken for work')

// The case that opened new windows: started in one repository, working in another.
const C = 'cccccccc-dddd-4eee-8fff-000000000000'
const t = join(home, 'c.jsonl')
writeFileSync(t, JSON.stringify({ type: 'user', cwd: '/work/planner' }) + '\n' + JSON.stringify({ type: 'user', cwd: '/work/iss' }) + '\n')
await hook({ hook_event_name: 'UserPromptSubmit', session_id: C, cwd: '/work/iss', transcript_path: t })
assert.equal(entry(C).root, '/work/planner')
assert.equal(entry(C).project, 'planner')
assert.equal(entry(C).cwd, '/work/iss')
ok('a session remembers where it was started, even after moving to another repository')

const before = b.got.length
assert.equal(await run(['--focus', C]), 'focused')
assert.equal(b.got.length, before + 1)
ok('so a click reaches the window it was started in, not a window for where it is now')

// Claude's own "waiting for your input", minutes after a turn: the same news as Stop.
await hook({ hook_event_name: 'Notification', session_id: C, cwd: '/work/iss', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })
assert.equal(entry(C).state, 'running')
await hook({ hook_event_name: 'Notification', session_id: C, cwd: '/work/iss', message: 'Claude is waiting for your input' })
assert.equal(entry(C).state, 'running')
ok('an idle notice does not light the bell — with or without notification_type')

await hook({ hook_event_name: 'Notification', session_id: C, cwd: '/work/iss', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
assert.equal(entry(C).state, 'waiting')
ok('a permission prompt does')

// What the notification would say, without showing one.
const home2 = mkdtempSync(join(tmpdir(), 'cn-show-'))
mkdirSync(join(home2, '.claude'))
writeFileSync(join(home2, '.claude', 'claude-notify.config.json'), JSON.stringify({ enabled: true, minTurnSeconds: 0, language: 'en' }))
const t2 = join(home2, 't.jsonl')
writeFileSync(t2, [
  JSON.stringify({ type: 'user', cwd: '/work/planner' }),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Old name' }),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Bildy "v2"' }), // quotes arrive escaped in the file
].join('\n') + '\n')
const show = (payload) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, HOME: home2, CLAUDE_NOTIFY_DRYRUN: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, stdio: ['pipe', 'pipe', 'ignore'] })
  let out = ''
  p.stdout.on('data', (c) => { out += c })
  p.on('close', () => resolve(out.trim()))
  p.stdin.end(JSON.stringify(payload))
})
const D = 'dddddddd-eeee-4fff-8000-111111111111'
const done = JSON.parse(await show({ hook_event_name: 'Stop', session_id: D, cwd: '/work/iss', transcript_path: t2 }))
assert.equal(done.title, 'Bildy "v2"')
assert.equal(done.subtitle, 'Claude · planner')
assert.match(done.message, /^Done/)
ok('the notification is titled with the session, the project goes underneath')

assert.equal(await show({ hook_event_name: 'Notification', session_id: D, cwd: '/work/iss', transcript_path: t2, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }), '')
ok('and no second one follows when Claude reports the session idle')

for (const w of [a, b, dead]) w.close()
console.log(`\n${n} passed`)
