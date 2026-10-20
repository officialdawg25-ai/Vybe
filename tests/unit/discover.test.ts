import { describe, expect, it } from 'vitest'
import { dateSpan, eventIcs, eventLabel } from '../../src/lib/discover'
import { formatDistance, formatDuration } from '../../src/lib/maps'
import { directionsUrl } from '../../src/lib/cities'

describe('discover helpers', () => {
  it('builds a valid calendar file with escaped text and a stable UID', () => {
    const ics = eventIcs({ id: 'e1', title: 'Jazz, Blues; & more', starts_at: '2030-05-01T18:00:00Z', ends_at: null, description: 'Line1\nLine2', venue: 'The Roof', address: '1 Long St', city: 'Cape Town' }, 'https://vybe.test')
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true); expect(ics.endsWith('END:VCALENDAR')).toBe(true)
    expect(ics).toContain('UID:e1@vybe'); expect(ics).toContain('DTSTART:20300501T180000Z'); expect(ics).toContain('DTEND:20300501T210000Z')    // default 3 h
    expect(ics).toContain('SUMMARY:Jazz\\, Blues\\; & more'); expect(ics).toContain('LOCATION:The Roof\\, 1 Long St\\, Cape Town')
    expect(ics).toContain('URL:https://vybe.test/app/plans/e1'); expect(ics).not.toMatch(/\r\n\r\n/)
  })
  it('never puts an online link into a calendar entry unless the caller passes it', () => {
    expect(eventIcs({ id: 'e2', title: 'x', starts_at: '2030-05-01T18:00:00Z', ends_at: null, online_url: null }, 'https://vybe.test')).not.toContain('https://stream')
  })
  it('summarises date ranges', () => {
    expect(dateSpan([])).toBe('')
    expect(dateSpan([{ starts_at: '2030-05-01T10:00:00Z', timezone: 'UTC' }])).toMatch(/1/)
    expect(dateSpan([{ starts_at: '2030-05-01T10:00:00Z', timezone: 'UTC' }, { starts_at: '2030-06-01T10:00:00Z', timezone: 'UTC' }])).toContain('–')
  })
  it('labels the event type from the configured category', () => {
    expect(eventLabel({ category_label: 'Comedy', starts_at: new Date(Date.now() + 864e5).toISOString() })).toBe('UPCOMING COMEDY')
    expect(eventLabel({ starts_at: new Date(Date.now() + 864e5).toISOString() })).toBe('UPCOMING EVENT')
  })
  it('formats real route numbers', () => {
    expect(formatDistance(450)).toBe('450 m'); expect(formatDistance(15400)).toBe('15 km'); expect(formatDistance(2300)).toBe('2.3 km')
    expect(formatDuration(30)).toBe('1 min'); expect(formatDuration(1260)).toBe('21 min'); expect(formatDuration(5400)).toBe('1 h 30 min')
  })
  it('directions are plain URLs (no key) and only exist when there is somewhere to go', () => {
    expect(directionsUrl({ lat: -26.2, lng: 28.04 })).toBe('https://www.google.com/maps/dir/?api=1&destination=-26.2%2C28.04&travelmode=driving')
    expect(directionsUrl({})).toBeNull()
  })
})
