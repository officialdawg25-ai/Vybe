import { afterEach, describe, expect, it } from 'vitest'
import { avatarOwner, flushAvatarLookups, healAvatar, learnAvatar, resetIdentity, resolveAvatar, setAvatarFetcher } from '../../src/lib/identity'

const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002'
const p = (uid: string, n: number) => `${uid}/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000.webp`

afterEach(() => { resetIdentity(); setAvatarFetcher(null) })

describe('one profile picture everywhere', () => {
  it('finds the member a media path belongs to from its folder', () => {
    expect(avatarOwner(p(A, 1))).toBe(A)
    expect(avatarOwner('promo/x.webp')).toBeNull()
    expect(avatarOwner(null)).toBeNull()
  })
  it('after a replace, every stale copy of the old path shows the new picture', () => {
    learnAvatar(A, p(A, 2), p(A, 1))
    expect(resolveAvatar(p(A, 1))).toBe(p(A, 2))            // feed card / comment / inbox still holding the old path
    expect(resolveAvatar(p(A, 2))).toBe(p(A, 2))
  })
  it('a first upload reaches copies that had no picture, when the caller says whose avatar it is', () => {
    learnAvatar(A, p(A, 1))
    expect(resolveAvatar(null, A)).toBe(p(A, 1))
    expect(resolveAvatar(null, B)).toBeNull()                // nothing learned about B
    expect(resolveAvatar(null)).toBeNull()
  })
  it('never overrides a path that nobody replaced (it may be newer than what we learned)', () => {
    learnAvatar(A, p(A, 1))
    expect(resolveAvatar(p(A, 5))).toBe(p(A, 5))
  })
  it('other members are untouched', () => {
    learnAvatar(A, p(A, 2), p(A, 1))
    expect(resolveAvatar(p(B, 1))).toBe(p(B, 1))
  })
  it('a picture that fails heals from the database, batched into one lookup', async () => {
    const asked: string[][] = []
    setAvatarFetcher(async ids => { asked.push(ids); return ids.map(id => ({ id, avatar_path: id === A ? p(A, 9) : p(B, 9) })) })
    healAvatar(p(A, 1)); healAvatar(p(B, 1)); healAvatar(p(A, 1))
    await flushAvatarLookups()
    expect(asked).toEqual([[A, B]])
    expect(resolveAvatar(p(A, 1))).toBe(p(A, 9))
    expect(resolveAvatar(p(B, 1))).toBe(p(B, 9))
  })
  it('healing is throttled per member so a broken picture cannot hammer the database', async () => {
    let calls = 0
    setAvatarFetcher(async ids => { calls++; return ids.map(id => ({ id, avatar_path: null })) })
    healAvatar(p(A, 1)); await flushAvatarLookups()
    healAvatar(p(A, 1)); await flushAvatarLookups()
    expect(calls).toBe(1)
  })
  it('a member who removed their picture falls back to initials, not the dead file', async () => {
    setAvatarFetcher(async ids => ids.map(id => ({ id, avatar_path: null })))
    healAvatar(p(A, 1)); await flushAvatarLookups()
    expect(resolveAvatar(p(A, 1))).toBeNull()
  })
  it('a failed lookup leaves things as they were', async () => {
    setAvatarFetcher(async () => { throw new Error('offline') })
    healAvatar(p(A, 1)); await flushAvatarLookups()
    expect(resolveAvatar(p(A, 1))).toBe(p(A, 1))
  })
})
