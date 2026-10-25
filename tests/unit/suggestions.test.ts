import { describe, expect, it } from 'vitest'
import { reasonText } from '../../src/lib/suggestions'

describe('suggestion reasons', () => {
  it('say why in plain words, with correct plurals', () => {
    expect(reasonText({ code: 'friends_going', n: 1 })).toBe('1 friend going')
    expect(reasonText({ code: 'friends_going', n: 4 })).toBe('4 friends going')
    expect(reasonText({ code: 'mutual_friends', n: 2 })).toBe('2 mutual friends')
    expect(reasonText({ code: 'upcoming_events', n: 1 })).toBe('1 upcoming event')
    expect(reasonText({ code: 'many_followers', n: 12 })).toBe('12 followers')
    expect(reasonText({ code: 'artist_you_follow', label: 'The Night Owls' })).toBe('The Night Owls is playing')
    expect(reasonText({ code: 'plays_your_event', label: 'Rooftop Sessions' })).toBe('Playing Rooftop Sessions')
    expect(reasonText({ code: 'near_you', km: 4 })).toBe('4 km from you')
    expect(reasonText({ code: 'near_you', km: 0 })).toBe('Right near you')
    expect(reasonText({ code: 'shared_interests', label: 'Music & Art' })).toBe('Into Music & Art')
  })
  it('an unknown reason from a newer server still reads sensibly', () => {
    expect(reasonText({ code: 'something_new' })).toBe('Coming up')
  })
})
