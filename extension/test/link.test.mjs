import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'not this' },
    { type: 'text', text: '**Fixed** the flaky test in `sessions.test` and pushed the branch. Next: [review](https://x) and release.\n\n```js\ncode()\n```' },
  ] } }),
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

assert.equal(done.message, 'Done — Fixed the flaky test in sessions.test and pushed the branch. Next: review and release.')
ok('and carries how the last answer began, markdown and code stripped')

/** What the presenter would do with a notification, without doing it. */
const dryShow = (o, env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SCRIPT, '--show', JSON.stringify(o)], { env: { ...process.env, CLAUDE_NOTIFY_DRYRUN: '1', ...env }, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  p.stdout.on('data', (c) => { out += c })
  p.on('close', () => resolve(JSON.parse(out)))
})
const plan = await dryShow({ ...done, sound: true }, { HOME: home2, CLAUDE_NOTIFY_PLATFORM: 'darwin' })
if (plan.cmd.includes('terminal-notifier')) {
  assert.equal(plan.waits, false)
  assert.equal(plan.args.includes('-action'), false)
  const cmd = plan.args[plan.args.indexOf('-execute') + 1]
  assert.match(cmd, /'--focus' 'dddddddd-eeee-4fff-8000-111111111111' '\/work\/planner'$/)
  ok('the click command travels inside the notification; nothing waits for an answer')
}

assert.equal(await show({ hook_event_name: 'Notification', session_id: D, cwd: '/work/iss', transcript_path: t2, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }), '')
ok('and no second one follows when Claude reports the session idle')

// What the VS Code extension installs: its own notifying app, and a runner for the hooks.
const kept = join(home2, '.claude', 'claude-notify')
const helper = join(kept, 'Notify for Claude Code.app', 'Contents', 'MacOS', 'notify')
mkdirSync(dirname(helper), { recursive: true })
writeFileSync(helper, '')
writeFileSync(join(kept, 'claude-notify'), '')
const withHelper = await dryShow({ ...done, sound: true }, { HOME: home2, CLAUDE_NOTIFY_PLATFORM: 'darwin' })
assert.equal(withHelper.cmd, helper)
ok('the extension\'s own app shows the notification when it is installed')

const viaRunner = JSON.parse(await show({ hook_event_name: 'Stop', session_id: D, cwd: '/work/iss', transcript_path: t2 }))
assert.match(viaRunner.focusCommand, new RegExp(`^'${join(kept, 'claude-notify')}' '--focus' '${D}'`))
ok('and a click runs the runner, which needs no node on PATH')

// A pause, set from the command line the way a window sets it.
const runIn2 = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home2 }, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  p.stdout.on('data', (c) => { out += c })
  p.on('close', () => resolve(out.trim()))
})
const pauseFile = () => JSON.parse(readFileSync(join(home2, '.claude', 'claude-notify', 'pause.json'), 'utf8'))
await runIn2(['--pause'])
assert.deepEqual(pauseFile(), { all: true })
assert.equal(await show({ hook_event_name: 'Stop', session_id: D, cwd: '/work/iss', transcript_path: t2 }), '')
ok('paused, a finished session announces nothing')

await runIn2(['--pause', '30', '--editor'])
const editorUntil = pauseFile().editor
assert.ok(editorUntil > Date.now() + 29 * 60_000 && editorUntil < Date.now() + 31 * 60_000)
await runIn2(['--resume', '--editor'])
assert.deepEqual(pauseFile(), { all: true })
await runIn2(['--resume'])
assert.deepEqual(pauseFile(), {})
assert.match(await show({ hook_event_name: 'Stop', session_id: D, cwd: '/work/iss', transcript_path: t2 }), /Done/)
ok('--pause takes minutes and --editor; --resume lifts the pause again')

// The windows of the first half of this test: a holds /work/app, b holds /work/planner.
const inEditor = (await dryShow(done, { HOME: home })).editor
assert.deepEqual(inEditor.window, ['/work/planner'])
assert.deepEqual(inEditor.body, {
  kind: 'done', title: 'Bildy "v2"',
  status: 'Done', project: 'planner', text: 'Fixed the flaky test in sessions.test and pushed the branch. Next: review and release.',
  subtitle: 'Claude · planner', message: done.message,
  session: D, root: '/work/planner', openLabel: 'Open session',
})
ok('the same notification is shown in the window that holds the session, with a button to open it')

assert.equal((await dryShow({ ...done, uri: '' }, { HOME: home })).editor.body.session, '')
ok('a session with no tab to go to gets no button')

assert.equal((await dryShow({ ...done, root: '/elsewhere', cwd: '/elsewhere' }, { HOME: home })).editor, null)
ok('and a session that no window holds is shown in none')

const crashed = await fakeWindow('crashed', ['/work/planner'], 999, 999999)
await dryShow(done, { HOME: home })
assert.equal(existsSync(crashed.file), true)
ok('a dry run only looks: even a crashed window keeps its link file')

for (const w of [a, b, dead, crashed]) w.close()
console.log(`\n${n} passed`)
