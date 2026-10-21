// Verifies public/_headers still matches index.html: the CSP script hash must be the inline theme snippet's hash.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8'), headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
const missing = inline.filter(h => !headers.includes(h))
if (missing.length) { console.error(`public/_headers is missing ${missing.join(', ')} for the inline script(s) in index.html`); process.exit(1) }
console.log(`✓ CSP covers ${inline.length} inline script(s)`)
