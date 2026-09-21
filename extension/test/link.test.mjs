import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'

const SCRIPT = new URL('../../hooks/claude-notify.mjs', import.meta.url).pathname
const home = mkdtempSync(join(tmpdir(), 'cn-link-'))
mkdirSync(join(home, '.claude'))
// no notifications in this test — only the link
writeFileSync(join(home, '.claude', 'claude-notify.config.json'), JSON.stringify({ enabled: false }))

const got = []
const token = 'secret-token-for-test'
const srv = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    got.push({ path: req.url, token: req.headers['x-claude-notify-token'], body: JSON.parse(raw) })
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port
writeFileSync(join(home, '.claude', 'claude-notify-vscode.json'), JSON.stringify({ port, token, pid: process.pid }))

const run = (payload) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'ignore', 'ignore'] })
  p.on('close', resolve)
  p.stdin.end(JSON.stringify(payload))
})

await run({ hook_event_name: 'UserPromptSubmit', session_id: '11111111-2222-4333-8444-555555555555', cwd: '/x/lane-a' })
await run({ hook_event_name: 'Notification', session_id: '11111111-2222-4333-8444-555555555555', cwd: '/x/lane-a', message: 'hi' })
await run({ hook_event_name: 'Stop', session_id: '11111111-2222-4333-8444-555555555555', cwd: '/x/lane-a', agent_id: 'sub' })

assert.equal(got.length, 2, 'a subagent must not send events')
assert.deepEqual(got.map((g) => g.body.event), ['UserPromptSubmit', 'Notification'])
assert.ok(got.every((g) => g.path === '/event' && g.token === token))
assert.equal(got[0].body.lane, 'lane-a')
console.log('ok   events reach the extension with the token; subagents stay silent')
console.log('ok   disabled notifications still feed the status bar')

// a dead pid in the link file: the script must not call anywhere
got.length = 0
writeFileSync(join(home, '.claude', 'claude-notify-vscode.json'), JSON.stringify({ port, token, pid: 999999 }))
await run({ hook_event_name: 'Notification', session_id: '11111111-2222-4333-8444-555555555555', cwd: '/x/a', message: 'hi' })
assert.equal(got.length, 0)
console.log('ok   a link file left by a crashed editor is ignored')
srv.close()
