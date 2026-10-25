import { describe, expect, it } from 'vitest'
import { encodeMsg, parseMsg, tallyVotes } from '../../src/lib/streaming'

const raw = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))

describe('live data messages are parsed strictly', () => {
  it('text chat only: control characters stripped, length capped, empty refused', () => {
    expect(parseMsg(raw({ t: 'chat', m: ' hi\u0000there ' }))).toEqual({ t: 'chat', m: 'hi there' })
    expect((parseMsg(raw({ t: 'chat', m: 'x'.repeat(500) })) as { m: string }).m).toHaveLength(200)
    expect(parseMsg(raw({ t: 'chat', m: '   ' }))).toBeNull()
    expect(parseMsg(raw({ t: 'chat', m: 'hi', audio: 'blob:x' }))).toEqual({ t: 'chat', m: 'hi' })   // extra fields dropped
    expect(parseMsg(raw({ t: 'voice', m: 'x' }))).toBeNull()                                          // no voice/video notes on a live
  })
  it('reactions are one of the offered emoji (anything else becomes a heart)', () => {
    expect(parseMsg(raw({ t: 'react', e: '🔥' }))).toEqual({ t: 'react', e: '🔥' })
    expect(parseMsg(raw({ t: 'react', e: '<img src=x>' }))).toEqual({ t: 'react', e: '❤️' })
  })
  it('polls: 2–4 short options, safe ids; votes and tallies are bounded numbers', () => {
    expect(parseMsg(raw({ t: 'poll', id: 'abc123', q: 'Next song?', o: ['A', 'B', ''] }))).toEqual({ t: 'poll', id: 'abc123', q: 'Next song?', o: ['A', 'B'] })
    expect(parseMsg(raw({ t: 'poll', id: 'abc123', q: 'Q', o: ['only one'] }))).toBeNull()
    expect(parseMsg(raw({ t: 'poll', id: '../x', q: 'Q', o: ['a', 'b'] }))).toBeNull()
    expect(parseMsg(raw({ t: 'vote', id: 'abc123', i: 1 }))).toEqual({ t: 'vote', id: 'abc123', i: 1 })
    expect(parseMsg(raw({ t: 'vote', id: 'abc123', i: 9 }))).toBeNull()
    expect(parseMsg(raw({ t: 'tally', id: 'abc123', c: [3, -1] }))).toBeNull()
    expect(parseMsg(raw({ t: 'tally', id: 'abc123', c: [3, 1] }))).toEqual({ t: 'tally', id: 'abc123', c: [3, 1] })
  })
  it('pins, join requests and garbage', () => {
    expect(parseMsg(raw({ t: 'pin', m: 'Welcome!', n: 'Host' }))).toEqual({ t: 'pin', m: 'Welcome!', n: 'Host' })
    expect(parseMsg(raw({ t: 'pin', m: 'Hi', n: 'A', f: 'cccccccc-0000-4000-8000-000000000003' }))).toEqual({ t: 'pin', m: 'Hi', n: 'A', f: 'cccccccc-0000-4000-8000-000000000003' })
    expect(parseMsg(raw({ t: 'pin', m: 'Hi', n: 'A', f: '<script>' }))).toEqual({ t: 'pin', m: 'Hi', n: 'A' })
    expect(parseMsg(raw({ t: 'join' }))).toEqual({ t: 'join' })
    expect(parseMsg(new TextEncoder().encode('not json'))).toBeNull()
    expect(parseMsg(encodeMsg({ t: 'unpin' }))).toEqual({ t: 'unpin' })
  })
  it('one vote per person; changing a vote moves it', () => {
    const v = new Map([['a', 0], ['b', 1], ['c', 1]])
    expect(tallyVotes(v, 2)).toEqual([1, 2])
    v.set('a', 1)
    expect(tallyVotes(v, 2)).toEqual([0, 3])
    expect(tallyVotes(new Map([['x', 7]]), 3)).toEqual([0, 0, 0])
  })
})
