// Proves the branded ticket QR (src/lib/brandQr.ts) still decodes: each code is rendered as the app renders it, drawn
// into a canvas in Chromium at several sizes (and with blur, like a phone camera), and read back with jsQR — the same
// decoder the VYBE door scanner uses. Run: node --experimental-strip-types scripts/qr-check.mts
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { brandedQrSvg, qrMatrix, holeSize } from '../src/lib/brandQr.ts'

const require = createRequire(import.meta.url)
const jsqrSrc = readFileSync(require.resolve('jsqr/dist/jsQR.js'), 'utf8')
const codes = Array.from({ length: 60 }, () => randomBytes(10).toString('hex').toUpperCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.*)$/, (_m, a, b, c, d, e) => 'VYBE2:' + a.toLowerCase() + '-' + b.toLowerCase() + '-' + c.toLowerCase() + '-' + d.toLowerCase() + '-' + e.toLowerCase() + '00:58000000:' + randomBytes(10).toString('hex')).toUpperCase())
const sample = qrMatrix(codes[0])
console.log(`QR version ${sample.version}, ${sample.n}×${sample.n} modules, clear centre ${holeSize(sample.n)}×${holeSize(sample.n)} (${(100 * holeSize(sample.n) ** 2 / sample.n ** 2).toFixed(1)} % of modules)`)
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const page = await browser.newPage()
await page.setContent('<html><body></body></html>')
await page.addScriptTag({ content: jsqrSrc })
const cases = [{ px: 320, blur: 0 }, { px: 160, blur: 0 }, { px: 110, blur: 0 }, { px: 240, blur: 1.6 }, { px: 330, blur: 2.4 }, { px: 200, blur: 0, dark: true }]
let fails = 0
for (const c of cases) {
  let ok = 0
  for (const code of codes) {
    const svg = brandedQrSvg(code)
    const got = await page.evaluate(async ({ svg, px, blur, dark }) => {
      const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode()
      const pad = 24, cv = document.createElement('canvas'); cv.width = cv.height = px + pad * 2
      const g = cv.getContext('2d')!; g.fillStyle = dark ? '#0e0b22' : '#ffffff'; g.fillRect(0, 0, cv.width, cv.height)
      if (blur) g.filter = `blur(${blur}px)`
      g.drawImage(img, pad, pad, px, px)
      const d = g.getImageData(0, 0, cv.width, cv.height)
      return (window as any).jsQR(d.data, d.width, d.height)?.data ?? null
    }, { svg, ...c })
    if (got === code) ok++
  }
  const pass = ok === codes.length
  if (!pass) fails++
  console.log(`${pass ? '✓' : '✗'} ${c.px}px${c.blur ? `, blur ${c.blur}px` : ''}${c.dark ? ', on a dark page' : ''}: ${ok}/${codes.length} decoded`)
}
await browser.close()
console.log(fails ? `\n${fails} case(s) failed` : '\nAll QR checks passed')
process.exit(fails ? 1 : 0)
