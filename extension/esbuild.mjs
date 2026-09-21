import { build, context } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'

const watch = process.argv.includes('--watch')
const options = {
  entryPoints: ['src/extension.ts', 'src/uninstall.ts'],
  bundle: true,
  outdir: 'dist',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: watch,
  minify: !watch,
}

// One copy of the notifier, shared with the Claude Code plugin next door.
mkdirSync('dist', { recursive: true })
copyFileSync('../hooks/claude-notify.mjs', 'dist/claude-notify.mjs')

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('watching')
} else {
  await build(options)
  console.log('built dist/')
}
