// Verifies the entrance animation in a real browser: scrubs every running animation to fixed times and
// screenshots each stage, then lets it play in real time to confirm it ends and hands over to the page.
//   npx vite preview --outDir dist-mock --port 4174 &  node scripts/splash-check.mjs [outDir]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const OUT = process.argv[2] ?? 'splash-frames'
mkdirSync(OUT, { recursive: true })
const STAGES = [
  ['0-blank', 100], ['1-V-redraw-start', 500], ['2-V-redraw-done', 1000], ['3-V-moving-left', 1450], ['4-YBE-enter-and-redraw', 1900],
  ['5-wordmark-complete', 2500], ['6-light-pulse', 3100], ['7-fading-into-app', 3550],
]
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const ctx = await browser.newContext({ viewport: { width: 1000, height: 600 } })
const page = await ctx.newPage()
const problems = []
page.on('pageerror', e => problems.push(e.message))
await page.goto(BASE + '/')
await page.waitForSelector('[data-testid=splash]')
for (const [name, ms] of STAGES) {
  await page.evaluate(t => document.getAnimations().forEach(a => { a.pause(); a.currentTime = t }), ms)
  await page.waitForTimeout(60)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  const st = await page.evaluate(() => {
    const q = s => document.querySelector(s)
    const x = el => (el ? Math.round(el.getBoundingClientRect().x) : null)
    return { vx: x(q('.sp-v .sp-path')), yx: x(q('.sp-ybe .sp-path')), glow: getComputedStyle(q('.sp-glow')).opacity }
  })
  console.log(name.padEnd(26), `t=${ms}ms`, JSON.stringify(st))
}
await ctx.close()

// Real-time run: the overlay must disappear on its own, and the page underneath must be usable.
const ctx2 = await browser.newContext({ viewport: { width: 1000, height: 600 } })
const p2 = await ctx2.newPage()
const t0 = Date.now()
await p2.goto(BASE + '/')
await p2.waitForSelector('[data-testid=splash]')
await p2.waitForSelector('[data-testid=splash]', { state: 'detached', timeout: 8000 })
const took = Date.now() - t0
console.log(`real-time: splash gone after ${took} ms; landing heading visible: ${await p2.locator('h1').isVisible()}`)
await p2.screenshot({ path: `${OUT}/8-landing-after-splash.png` })
// Second visit in the same session: no replay.
await p2.goto(BASE + '/signin'); await p2.goto(BASE + '/')
console.log('same session replay:', await p2.locator('[data-testid=splash]').count() === 0 ? 'none (correct)' : 'REPLAYED')
await ctx2.close()

// Reduced motion: static wordmark, then handed over.
const ctx3 = await browser.newContext({ viewport: { width: 1000, height: 600 }, reducedMotion: 'reduce' })
const p3 = await ctx3.newPage()
await p3.goto(BASE + '/'); await p3.waitForSelector('[data-testid=splash]'); await p3.waitForTimeout(200)
await p3.screenshot({ path: `${OUT}/9-reduced-motion.png` })
await p3.waitForSelector('[data-testid=splash]', { state: 'detached', timeout: 5000 })
console.log('reduced-motion: static wordmark shown, then handed over')
// Deep links are never delayed.
const ctx4 = await browser.newContext({ viewport: { width: 1000, height: 600 } })
const p4 = await ctx4.newPage(); await p4.goto(BASE + '/signin')
console.log('deep link /signin splash count:', await p4.locator('[data-testid=splash]').count())
await browser.close()
if (problems.length) { console.log('page errors:', problems); process.exit(1) }
