// Builds src/donate.html from addresses.json, so an address is written in one place only.
import { readFileSync, writeFileSync } from 'node:fs'
const here = new URL('.', import.meta.url).pathname
const list = JSON.parse(readFileSync(`${here}addresses.json`, 'utf8'))
const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
const cards = list.map((x) => `
  <div class="card">
    <img src="../donate/qr-${x.currency.toLowerCase()}.png" width="180" height="180">
    <b>${esc(x.currency)}</b><span class="net">${esc(x.network)}</span>
    <code>${esc(x.address)}</code>
  </div>`).join('')
writeFileSync(`${here}../src/donate.html`, `<!doctype html><meta charset="utf-8">
<style>
html, body { margin: 0; background: transparent; }
body { display: flex; gap: 18px; padding: 12px; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.card { width: 262px; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 16px 12px 14px;
        background: #ffffff; border: 1px solid #e4e0d8; border-radius: 14px; color: #141413; }
.card img { image-rendering: pixelated; margin-bottom: 6px; }
b { font-size: 16px; color: #c4633f; }
.net { color: #5f5d58; font-size: 13px; }
code { margin-top: 6px; font: 11px/1.35 ui-monospace, Menlo, monospace; text-align: center; word-break: break-all; color: #141413; }
</style>${cards}
`)
console.log('wrote src/donate.html')
