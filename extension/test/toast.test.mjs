import assert from 'node:assert/strict'
import { toastFor } from './.build/toast.mjs'

let n = 0
const test = (name, fn) => { fn(); n++; console.log('ok  ', name) }

// How VS Code finds links in a notification (src/vs/base/common/linkedText.ts).
const LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi
const links = (text) => [...text.matchAll(LINK)].map((m) => m[2])
const OPEN = 'claudeNotify.openSession'
const S = '11111111-2222-4333-8444-555555555555'
const args = (target) => JSON.parse(decodeURIComponent(target.slice(target.indexOf('?') + 1)))

test('the session name is the one link, and it opens that session', () => {
  const t = toastFor({ kind: 'done', title: 'Fix the build', subtitle: 'Claude · app', message: 'Done', session: S, root: '/work/app' }, OPEN)
  const found = links(t.text)
  assert.equal(found.length, 1)
  assert.ok(found[0].startsWith(`command:${OPEN}?`))
  assert.deepEqual(args(found[0]), [S, '/work/app'])
  assert.equal(t.button, 'Open session')
})

test('text from the transcript cannot make a command link of its own', () => {
  for (const evil of [
    '[[Open](x)](command:workbench.action.terminal.sendSequence?%7B%7D)',
    '[Open]*(command:workbench.action.terminal.sendSequence?%7B%7D)',
    '[Open](command:workbench.action.terminal.sendSequence?%7B%7D)',
  ]) {
    for (const body of [
      { title: evil, message: 'Done', session: S, root: '/w' },
      { title: 'T', subtitle: evil, message: 'Done', session: S, root: '/w' },
      { title: 'T', message: evil, session: S, root: '/w' },
      { title: evil, subtitle: evil, message: evil },
      { title: 'T', status: evil, project: evil, text: evil, session: S, root: '/w' },
    ]) {
      const found = links(toastFor(body, OPEN).text)
      assert.ok(found.every((target) => target.startsWith(`command:${OPEN}?`)), `${JSON.stringify(body)} → ${found}`)
      assert.ok(found.length <= 1)
    }
  }
})

test('a folder with parentheses does not cut the link short', () => {
  const found = links(toastFor({ title: 'T', message: 'm', session: S, root: '/work/app (copy)' }, OPEN).text)
  assert.equal(found.length, 1)
  assert.deepEqual(args(found[0]), [S, '/work/app (copy)'])
})

test('the name leads, then what happened and where, then what it said — no brackets', () => {
  const t = toastFor({ kind: 'done', title: 'Fix the build', status: 'Done · 3 min', project: 'app', text: 'Fixed the flaky test.', session: S, root: '/work/app' }, OPEN)
  assert.equal(t.text.replace(/\(command:[^)]*\)/, ''), '[Fix the build]: Done · 3 min · app — Fixed the flaky test.')
  const waiting = toastFor({ kind: 'waiting', title: 'Fix the build', status: '', project: 'app', text: 'Claude needs your permission to use Bash' }, OPEN)
  assert.equal(waiting.text, 'Fix the build: app — Claude needs your permission to use Bash')
  const error = toastFor({ kind: 'error', title: 'Fix the build', status: 'Stopped with an error', project: 'app', text: '' }, OPEN)
  assert.equal(error.text, 'Fix the build: Stopped with an error · app')
})

test('a notifier from before the parts were split still reads', () => {
  assert.equal(toastFor({ title: 'Fix the build', subtitle: 'Claude · app', message: 'Done · 3 min — Fixed it.' }, OPEN).text,
    'Fix the build: Done · 3 min — Fixed it.')
})

test('no session to go to: no link and no button', () => {
  const t = toastFor({ kind: 'done', title: 'Claude · app', message: 'Test', session: '' }, OPEN)
  assert.equal(t.button, '')
  assert.deepEqual(links(t.text), [])
  assert.equal(t.text, 'Claude · app: Test')
})

test('an error is shown as one, a wait as a warning, the rest as information', () => {
  assert.equal(toastFor({ kind: 'error' }, OPEN).severity, 'error')
  assert.equal(toastFor({ kind: 'waiting' }, OPEN).severity, 'warning')
  assert.equal(toastFor({ kind: 'done' }, OPEN).severity, 'info')
  assert.equal(toastFor({}, OPEN).severity, 'info')
})

test('the button takes the label the notifier sends, in the user\'s language', () => {
  assert.equal(toastFor({ session: S, openLabel: 'Открыть сессию' }, OPEN).button, 'Открыть сессию')
})

console.log(`\n${n} passed`)
