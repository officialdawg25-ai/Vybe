// Runs the real src/lib/videoCopy.ts in Chromium on a heavy video and checks the smaller copy it makes: the size it
// promised, the same duration, seekable, much smaller, with sound. Saves the copy as <MEDIA_DIR>/tall-hd-480.webm for
// scripts/media-check.mjs. Usage: MEDIA_DIR=<fixtures> CHROMIUM_PATH=... node scripts/video-copy-check.mjs
// (fixture: tall-hd.webm, 1080x1920, 8 s, ~5.5 MB, VP9 + Opus).
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const MEDIA = process.env.MEDIA_DIR
const bundle = await build({ entryPoints: [new URL('../src/lib/videoCopy.ts', import.meta.url).pathname], bundle: true, write: false, format: 'iife', globalName: 'VC', target: 'es2022' })
const js = bundle.outputFiles[0].text
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const page = await browser.newPage()
await page.route('http://copy.test/**', route => {
  const u = new URL(route.request().url())
  if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><button id=go>go</button><script>${js}</script>` })
  return route.fulfill({ contentType: u.pathname.endsWith('.mp4') ? 'video/mp4' : 'video/webm', body: readFileSync(`${MEDIA}${u.pathname}`) })
})
await page.goto('http://copy.test/')
await page.click('#go')                                         // a tap, as when the author presses Post
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`) }

for (const force of ['as recorded', 'WebM forced']) {
const t0 = Date.now()
const out = await page.evaluate(async force => {
  // second pass: pretend MP4 recording is unavailable, as in Firefox, to exercise the WebM duration fix on a real file
  if (force === 'WebM forced') { const real = MediaRecorder.isTypeSupported.bind(MediaRecorder); MediaRecorder.isTypeSupported = t => !t.startsWith('video/mp4') && real(t) }
  const file = await (await fetch('/tall-hd.webm')).blob()
  const r = await window.VC.makeSmallCopy(file)
  if (!r) return null
  const bytes = new Uint8Array(await r.blob.arrayBuffer())
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { ext: r.ext, width: r.width, height: r.height, size: r.blob.size, original: file.size, b64: btoa(bin) }
}, force)
const took = Date.now() - t0
console.log(`-- ${force}`)
check('a copy is made for a heavy 1080x1920 video', out != null, out && { ext: out.ext, width: out.width, height: out.height, tookMs: took })
if (out) {
  const path = `${MEDIA}/tall-hd-480.${out.ext}`
  writeFileSync(path, Buffer.from(out.b64, 'base64'))
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', path]).toString())
  const v = probe.streams.find(s => s.codec_type === 'video'), a = probe.streams.find(s => s.codec_type === 'audio')
  check('the copy is 480x854 (short side 480, same shape)', v?.width === 480 && v?.height === 854, { width: v?.width, height: v?.height })
  check('the copy has the original\'s duration in its header (written in for WebM)', Math.abs(Number(probe.format.duration) - 8.0) < 1, { duration: probe.format.duration })
  check('the copy keeps the sound', Boolean(a), { audio: a?.codec_name })
  check('the copy is much smaller than the original (≤ 35%)', out.size <= out.original * 0.35, { copyKB: Math.round(out.size / 1024), originalKB: Math.round(out.original / 1024), percent: Math.round(100 * out.size / out.original) })
  const seek = await page.evaluate(async name => {
    const v = document.createElement('video'); v.muted = true
    v.src = URL.createObjectURL(await (await fetch('/' + name)).blob())
    await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }))
    const d = v.duration; v.currentTime = 6
    await new Promise(r => v.addEventListener('seeked', r, { once: true }))
    return { duration: d, at: v.currentTime }
  }, `tall-hd-480.${out.ext}`)
  check('the copy plays in the browser and seeks', Number.isFinite(seek.duration) && Math.abs(seek.at - 6) < 0.6, seek)
}
}
const light = await page.evaluate(async () => window.VC.makeSmallCopy(await (await fetch('/portrait.webm')).blob()))
check('an already light video (360x640, 0.5 MB) gets no copy', light === null)
await browser.close()
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
