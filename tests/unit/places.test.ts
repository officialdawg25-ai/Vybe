import { describe, expect, it } from 'vitest'
import { CITIES, directionsUrl, distanceKm, nearestCity, searchCities } from '../../src/lib/cities'
import { rangeBounds } from '../../src/pages/Discover'
import { saleState, money } from '../../src/lib/tickets'
import { ageFrom } from '../../src/pages/Onboarding'
import { pickRecorderType, MAX_VOICE_BYTES } from '../../src/components/VoiceNote'

describe('cities and distance', () => {
  it('searches by name or country, accent-insensitively, best prefix first', () => {
    expect(searchCities('johan')[0].name).toBe('Johannesburg')
    expect(searchCities('sao paulo')[0].name).toBe('São Paulo')
    expect(searchCities('south africa', 40).length).toBeGreaterThan(15)
    expect(searchCities('zzzz')).toEqual([])
  })
  it('computes great-circle distance (Johannesburg ↔ Cape Town ≈ 1,260 km)', () => {
    const jhb = CITIES.find(c => c.name === 'Johannesburg')!, cpt = CITIES.find(c => c.name === 'Cape Town')!
    expect(distanceKm(jhb, cpt)).toBeGreaterThan(1230); expect(distanceKm(jhb, cpt)).toBeLessThan(1290)
    expect(distanceKm(jhb, jhb)).toBeCloseTo(0, 5)
  })
  it('snaps a position to the nearest listed city', () => { expect(nearestCity(-26.1, 28.1).name).toBe('Sandton'); expect(nearestCity(-33.9, 18.5).name).toBe('Cape Town') })
  it('builds directions links from coordinates, falling back to the address', () => {
    expect(directionsUrl({ lat: -26.2, lng: 28.04 })).toContain('destination=-26.2%2C28.04')
    expect(directionsUrl({ lat: null, lng: null, venue: 'The Roof', city: 'Durban' }, 'apple')).toBe('https://maps.apple.com/?daddr=The%20Roof%2C%20Durban&dirflg=d')
    expect(directionsUrl({})).toBeNull()
  })
})

describe('discover date ranges', () => {
  it('today ends at the next local midnight', () => {
    const now = new Date(2026, 9, 21, 15, 0)             // Wed 21 Oct 2026, 15:00 local
    const { from, to } = rangeBounds('today', now)
    expect(new Date(from).getTime()).toBe(now.getTime()); expect(new Date(to!).getHours()).toBe(0); expect(new Date(to!).getDate()).toBe(22)
  })
  it('weekend = Saturday 00:00 to Monday 00:00; on Sunday it is already running', () => {
    const wed = rangeBounds('weekend', new Date(2026, 9, 21, 9, 0))
    expect(new Date(wed.from).getDay()).toBe(6); expect(new Date(wed.to!).getDay()).toBe(1)
    const sun = new Date(2026, 9, 25, 11, 0)
    expect(new Date(rangeBounds('weekend', sun).from).getTime()).toBe(sun.getTime())
  })
  it('any time has no upper bound', () => expect(rangeBounds('any').to).toBeNull())
})

describe('ticket sale windows and money', () => {
  const t = (o = {}) => ({ status: 'active' as const, sales_start: null, sales_end: null, ...o })
  it('classifies sale state', () => {
    const now = Date.parse('2026-10-21T12:00:00Z')
    expect(saleState(t(), now)).toBe('on_sale'); expect(saleState(t({ status: 'paused' }), now)).toBe('paused')
    expect(saleState(t({ sales_start: '2026-10-22T00:00:00Z' }), now)).toBe('soon'); expect(saleState(t({ sales_end: '2026-10-20T00:00:00Z' }), now)).toBe('closed')
  })
  it('formats rand', () => expect(money(16050)).toMatch(/160[.,]50/))
})

describe('onboarding age', () => {
  const now = new Date(2026, 9, 21)
  it('counts whole years and respects birthdays', () => {
    expect(ageFrom('2013-10-21', now)).toBe(13); expect(ageFrom('2013-10-22', now)).toBe(12); expect(ageFrom('1999-05-05', now)).toBe(27)
    expect(ageFrom('', now)).toBeNull(); expect(ageFrom('2099-01-01', now)).toBeNull(); expect(ageFrom('not-a-date', now)).toBeNull()
  })
})

describe('voice notes', () => {
  it('has no time limit, only a file-size guard just under the storage upload limit', () => { expect(MAX_VOICE_BYTES).toBeGreaterThan(40 * 1024 * 1024); expect(MAX_VOICE_BYTES).toBeLessThan(50 * 1024 * 1024) })
  it('reports no recorder when MediaRecorder is unavailable (node)', () => expect(pickRecorderType()).toBeNull())
})

describe('QR decoding (works without BarcodeDetector)', () => {
  it('decodes a ticket QR rendered at phone-camera scale', async () => {
    const { default: QRCode } = await import('qrcode')
    const { decodeQrFromRgba } = await import('../../src/lib/qr')
    const code = 'ABCDEFGHIJKLMNOPQRST'
    const qr = QRCode.create(code, { errorCorrectionLevel: 'M' })
    const n = qr.modules.size, scale = 6, quiet = 4, size = (n + quiet * 2) * scale
    const px = new Uint8ClampedArray(size * size * 4).fill(255)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(y, x)) {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4; px[i] = px[i + 1] = px[i + 2] = 0 }
    }
    expect(await decodeQrFromRgba(px, size, size)).toBe(code)
    expect(await decodeQrFromRgba(new Uint8ClampedArray(size * size * 4).fill(255), size, size)).toBeNull()
  })
})
