import { describe, expect, it } from 'vitest'
import { guessTier, isHex, lighten, luminance, tierStyle, TIERS } from '../../src/lib/ticketTiers'
import { brandedQrSvg, holeSize, qrMatrix } from '../../src/lib/brandQr'

describe('ticket tiers', () => {
  it('guesses the tier from common names', () => {
    expect(guessTier('VVIP Table')).toBe('vvip'); expect(guessTier('vip lounge')).toBe('vip'); expect(guessTier('Early Bird')).toBe('early_bird')
    expect(guessTier('Student pass')).toBe('student'); expect(guessTier('Squad of 4', 'group')).toBe('group'); expect(guessTier('General')).toBe('general')
    expect(guessTier('Vipers night')).toBe('general')                                     // whole words only
  })
  it('an organiser accent replaces the tier colours and keeps the ink readable', () => {
    expect(tierStyle('vip')).toBe(TIERS.vip)
    expect(tierStyle('vip', '#ffffff').ink).toBe('#120c24'); expect(tierStyle('vip', '#111111').ink).toBe('#ffffff')
    expect(tierStyle('general', 'red')).toBe(TIERS.general)                               // invalid colours are ignored
    expect(isHex('#a1b2c3')).toBe(true); expect(isHex('#abc')).toBe(false)
    expect(lighten('#000000', 0.5)).toBe('#808080'); expect(luminance('#ffffff')).toBeCloseTo(1)
  })
})

describe('branded QR', () => {
  it('keeps the finder eyes, clears an odd centre under 10 % and stays a level-H code', () => {
    const m = qrMatrix('5FE12DA80412EE7F0C3E')
    expect(m.n).toBe(25); expect(holeSize(m.n) % 2).toBe(1); expect(holeSize(m.n) ** 2 / m.n ** 2).toBeLessThan(0.1)
    const svg = brandedQrSvg('5FE12DA80412EE7F0C3E')
    expect(svg.startsWith('<svg')).toBe(true); expect((svg.match(/fill-rule="evenodd"/g) ?? []).length).toBe(4)
    expect(brandedQrSvg('5FE12DA80412EE7F0C3E')).toBe(svg)                              // deterministic
  })
})

describe('branded QR centre', () => {
  it('carries the official V and the signed-token payload fits the same size class', async () => {
    const { brandedQrParts, V_BOX } = await import('../../src/lib/brandQr')
    const tok = 'VYBE2:0B9C8E6E-1C1E-4A0E-9D0A-3D6F5C1A2B3C:58000000:0123456789ABCDEF0123'
    const p = brandedQrParts(tok)
    expect(p.tile.size).toBeGreaterThan(3); expect(p.v.scale * V_BOX.w).toBeLessThan(p.tile.size)
    expect(qrMatrix(tok).n).toBeLessThanOrEqual(41)
  })
})
