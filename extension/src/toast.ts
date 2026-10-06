/**
 * A notification from the notifier, as it is shown inside a window. No vscode API here,
 * so it can be tested with plain Node.
 */

export interface Toast {
  severity: 'error' | 'warning' | 'info'
  title: string
  text: string
  /** the button that opens the session; empty when there is no session to open */
  button: string
  session: string
  root: string
}

/**
 * VS Code turns `[label](command:…)` in a notification into a link that runs the command.
 * The title and the message come from the transcript — a title Claude chose, how its last
 * answer began — so they must not be able to make one. Without a `[` there is no link.
 */
const inert = (value: unknown) => String(value ?? '').replace(/[[\]]/g, '')

/** encodeURIComponent leaves parentheses alone, and a `)` ends the link. */
const linkArgs = (args: unknown[]) =>
  encodeURIComponent(JSON.stringify(args)).replace(/\(/g, '%28').replace(/\)/g, '%29')

/**
 * One line, because VS Code makes it one: it turns line breaks into spaces and has no way
 * to style a part of the text. So the order does the work — the session's name, in link
 * colour, reads as the heading; then what happened and where; then what it said.
 *
 *   Fix the build: Done · 3 min · app — Fixed the flaky test and pushed the branch.
 *
 * VS Code has no click on the toast itself, so the session's name is a link to
 * `openCommand` as well.
 */
export function toastFor(body: any, openCommand: string): Toast {
  const title = inert(body?.title) || 'Claude'
  const session = String(body?.session || '')
  const root = String(body?.root || '')
  const name = session ? `[${title}](command:${openCommand}?${linkArgs([session, root])})` : title
  const meta = [inert(body?.status), inert(body?.project)].filter(Boolean).join(' · ')
  // A notifier from before `text` sends the whole of it as `message`.
  const said = inert(body?.text ?? body?.message)
  return {
    severity: body?.kind === 'error' ? 'error' : body?.kind === 'waiting' ? 'warning' : 'info',
    title,
    text: `${name}: ${[meta, said].filter(Boolean).join(' — ')}`,
    button: session ? String(body?.openLabel || 'Open session') : '',
    session,
    root,
  }
}

/**
 * Whether a tab's label names this session. Claude Code labels a session's tab with its title,
 * cut to 24 characters and an ellipsis when it is longer than 25. A mark it may put before the
 * title — or that the title itself starts with — is not compared.
 */
export function tabShowsTitle(label: string, title: string): boolean {
  const bare = (value: string) => String(value || '').trim().replace(/^[^\p{L}\p{N}]+(?=[\p{L}\p{N}])/u, '')
  const name = bare(title)
  const shown = bare(label)
  if (!name || !shown) return false
  if (!shown.endsWith('…')) return shown === name
  const start = shown.slice(0, -1).trimEnd()
  return start.length > 0 && name.startsWith(start)
}
