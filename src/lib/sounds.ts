/**
 * Interface sounds, synthesised with the Web Audio API (no audio files to license or download).
 * Short, soft, glass-like chimes with a touch of room reverb — inspired by the calm, minimal feel of
 * system sounds, but original. Off switch lives in Settings; nothing plays while the tab is hidden.
 */
export type SoundName = 'like' | 'unlike' | 'comment' | 'send' | 'share' | 'notify' | 'record' | 'stop' | 'success' | 'trend' | 'spotlight'

const KEY = 'vybe:sounds'
export const soundsEnabled = () => { try { return localStorage.getItem(KEY) !== '0' } catch { return true } }
export const setSoundsEnabled = (on: boolean) => { try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* storage unavailable */ } }

let ctx: AudioContext | null = null
let master: GainNode | null = null
let reverb: ConvolverNode | null = null

function engine() {
  if (ctx) return ctx.state === 'suspended' ? (void ctx.resume(), ctx) : ctx
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  ctx = new AC()
  master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination)
  // Small synthetic room: decaying noise impulse, mixed in quietly for a soft tail.
  const len = Math.floor(ctx.sampleRate * 0.7), buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3) }
  reverb = ctx.createConvolver(); reverb.buffer = buf
  const wet = ctx.createGain(); wet.gain.value = 0.22; reverb.connect(wet); wet.connect(master)
  return ctx
}

/** One bell-like note: sine fundamental + a quiet octave partial, instant-soft attack, exponential decay. */
function note(freq: number, at: number, dur: number, gain: number) {
  const c = ctx!, t = c.currentTime + at
  for (const [mult, g] of [[1, 1], [2, 0.18], [3.01, 0.05]] as const) {
    const o = c.createOscillator(), env = c.createGain()
    o.type = 'sine'; o.frequency.value = freq * mult
    env.gain.setValueAtTime(0.0001, t)
    env.gain.linearRampToValueAtTime(gain * g, t + 0.006)
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(env); env.connect(master!); env.connect(reverb!)
    o.start(t); o.stop(t + dur + 0.05)
  }
}

/** Short filtered-noise sweep for "share". */
function swoosh(at: number, dur: number, from: number, to: number, gain: number) {
  const c = ctx!, t = c.currentTime + at
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate), d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const src = c.createBufferSource(), f = c.createBiquadFilter(), env = c.createGain()
  src.buffer = buf; f.type = 'bandpass'; f.Q.value = 2.2
  f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur)
  env.gain.setValueAtTime(0.0001, t); env.gain.linearRampToValueAtTime(gain, t + dur * 0.35); env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(f); f.connect(env); env.connect(master!); env.connect(reverb!)
  src.start(t)
}

const SCORES: Record<SoundName, () => void> = {
  like: () => { note(783.99, 0, 0.32, 0.22); note(1174.66, 0.055, 0.42, 0.2) },        // G5 → D6, a soft upward "pop"
  unlike: () => note(587.33, 0, 0.22, 0.16),                                              // D5
  comment: () => { note(659.25, 0, 0.3, 0.2); note(880, 0.08, 0.3, 0.18); note(1318.5, 0.16, 0.5, 0.17) }, // E5 A5 E6
  send: () => { note(1046.5, 0, 0.26, 0.18); note(1568, 0.06, 0.4, 0.15) },               // C6 → G6
  share: () => { swoosh(0, 0.3, 500, 2600, 0.14); note(1318.5, 0.2, 0.45, 0.15) },
  notify: () => { note(1174.66, 0, 0.7, 0.2); note(1567.98, 0.16, 0.9, 0.2); note(2349.3, 0.34, 1.0, 0.1) }, // D6 G6 D7 chime
  record: () => note(880, 0, 0.18, 0.18),
  stop: () => { note(659.25, 0, 0.2, 0.16); note(493.88, 0.07, 0.3, 0.14) },
  trend: () => { swoosh(0, 0.26, 700, 3200, 0.1); note(987.77, 0.08, 0.3, 0.15); note(1318.5, 0.16, 0.3, 0.15); note(1975.5, 0.26, 0.7, 0.14) },   // rising "what's hot" sweep
  spotlight: () => { note(1046.5, 0, 0.5, 0.15); note(1318.5, 0.12, 0.5, 0.14); note(1568, 0.24, 0.8, 0.14) },                         // calm major-triad stinger for sponsored slides
  success: () => { note(783.99, 0, 0.3, 0.17); note(987.77, 0.09, 0.3, 0.17); note(1318.5, 0.18, 0.6, 0.17) },
}

export function playSound(name: SoundName) {
  if (!soundsEnabled() || typeof document === 'undefined' || document.visibilityState === 'hidden') return
  try { if (engine()) SCORES[name]() } catch { /* audio is a nicety; never break the UI */ }
}

/** Browsers only start audio after a gesture; unlock once on the first tap/key. */
export function unlockAudioOnGesture() {
  const unlock = () => { try { engine() } catch { /* ignore */ } window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
  window.addEventListener('pointerdown', unlock, { once: false }); window.addEventListener('keydown', unlock)
}
