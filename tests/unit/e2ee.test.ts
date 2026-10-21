import { describe, expect, it } from 'vitest'
import { newGroupKey, newRecoveryKey, normaliseRecoveryKey, backupWithRecoveryKey, restoreWithRecoveryKey, unwrapGroupKey, wrapGroupKey, PREFIX, backupIdentity, conversationKey, decryptBlob, decryptEnvelope, encryptBlob, encryptEnvelope, generateIdentity, isCiphertext, keyFingerprint, labelledKey, publicFromPkcs8, restoreIdentity, securityCode } from '../../src/lib/e2ee'

const CONV = '11111111-1111-4111-8111-111111111111', A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002'

async function pair() {
  const alice = await generateIdentity(), bob = await generateIdentity()
  return { alice, bob, ka: await conversationKey(alice.privateKey, bob.publicKey, CONV, A, B), kb: await conversationKey(bob.privateKey, alice.publicKey, CONV, B, A) }
}

describe('end-to-end encrypted chat', () => {
  it('both people derive the same key and read each other’s messages', async () => {
    const { ka, kb } = await pair()
    const ct = await encryptEnvelope(ka, { t: 'text', m: 'Meet at 7 🎉' }, CONV, A)
    expect(isCiphertext(ct)).toBe(true); expect(ct.startsWith(PREFIX)).toBe(true); expect(ct).not.toContain('Meet')
    expect(await decryptEnvelope(kb, ct, CONV, A)).toEqual({ t: 'text', m: 'Meet at 7 🎉' })
    expect(await decryptEnvelope(ka, ct, CONV, A)).toEqual({ t: 'text', m: 'Meet at 7 🎉' })          // the sender can re-read it too
  })
  it('every message uses a fresh IV, so equal texts give different ciphertext', async () => {
    const { ka } = await pair()
    const [x, y] = [await encryptEnvelope(ka, { t: 'text', m: 'hi' }, CONV, A), await encryptEnvelope(ka, { t: 'text', m: 'hi' }, CONV, A)]
    expect(x).not.toBe(y)
  })
  it('a stranger, a tampered message or a moved message cannot be read', async () => {
    const { ka, kb } = await pair(), eve = await generateIdentity(), mallory = await generateIdentity()
    const ct = await encryptEnvelope(ka, { t: 'text', m: 'secret' }, CONV, A)
    const keEve = await conversationKey(eve.privateKey, mallory.publicKey, CONV, 'e', 'm')
    await expect(decryptEnvelope(keEve, ct, CONV, A)).rejects.toThrow()                                         // wrong key
    const parts = ct.split('.'), flipped = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -6)}AAAAAA`
    await expect(decryptEnvelope(kb, flipped, CONV, A)).rejects.toThrow()                                        // tampered
    await expect(decryptEnvelope(kb, ct, '22222222-2222-4222-8222-222222222222', A)).rejects.toThrow()          // replayed into another conversation
    await expect(decryptEnvelope(kb, ct, CONV, B)).rejects.toThrow()                                             // attributed to someone else
    await expect(decryptEnvelope(kb, 'plain text', CONV, A)).rejects.toThrow()
  })
  it('conversation keys are separate per conversation', async () => {
    const alice = await generateIdentity(), bob = await generateIdentity()
    const k1 = await conversationKey(alice.privateKey, bob.publicKey, CONV, A, B), k2 = await conversationKey(bob.privateKey, alice.publicKey, '33333333-3333-4333-8333-333333333333', B, A)
    const ct = await encryptEnvelope(k1, { t: 'text', m: 'x' }, CONV, A)
    await expect(decryptEnvelope(k2, ct, CONV, A)).rejects.toThrow()
  })
  it('files are encrypted with their own key and come back byte for byte', async () => {
    const data = new Uint8Array(300_000); for (let i = 0; i < data.length; i += 65_536) crypto.getRandomValues(data.subarray(i, i + 65_536))
    const { cipher, key, iv } = await encryptBlob(data.buffer)
    const enc = new Uint8Array(await cipher.arrayBuffer())
    expect(enc.length).toBe(data.length + 16); expect(Buffer.from(enc.subarray(0, 64)).equals(Buffer.from(data.subarray(0, 64)))).toBe(false)
    const back = new Uint8Array(await (await decryptBlob(enc.buffer, key, iv, 'image/png')).arrayBuffer())
    expect(Buffer.from(back).equals(Buffer.from(data))).toBe(true)
    await expect(decryptBlob(enc.buffer, (await encryptBlob(data.buffer)).key, iv, 'image/png')).rejects.toThrow()
  })
  it('the passphrase backup restores the same identity and rejects a wrong passphrase', async () => {
    const id = await generateIdentity()
    const backup = await backupIdentity(id.pkcs8, 'correct horse battery', 120_000)
    expect(JSON.stringify(backup)).not.toContain(Buffer.from(id.pkcs8).toString('base64').slice(0, 20))
    await expect(restoreIdentity(backup, 'wrong passphrase!')).rejects.toThrow('not right')
    const back = await restoreIdentity(backup, 'correct horse battery')
    expect(await publicFromPkcs8(back.pkcs8)).toBe(id.publicKey)
    const bob = await generateIdentity()
    const k1 = await conversationKey(id.privateKey, bob.publicKey, CONV, A, B), k2 = await conversationKey(back.privateKey, bob.publicKey, CONV, A, B)
    expect(await decryptEnvelope(k2, await encryptEnvelope(k1, { t: 'text', m: 'after restore' }, CONV, A), CONV, A)).toEqual({ t: 'text', m: 'after restore' })
  })
  it('private keys are not extractable once locked', async () => {
    const id = await generateIdentity()
    await expect(crypto.subtle.exportKey('pkcs8', id.privateKey)).rejects.toThrow()
  })
  it('the security code is identical on both phones and changes if a key changes', async () => {
    const a = await generateIdentity(), b = await generateIdentity(), c = await generateIdentity()
    const x = await securityCode(a.publicKey, b.publicKey)
    expect(x).toBe(await securityCode(b.publicKey, a.publicKey)); expect(x).toMatch(/^(\d{5} ){11}\d{5}$/)
    expect(await securityCode(a.publicKey, c.publicKey)).not.toBe(x)
    expect(await keyFingerprint(a.publicKey)).not.toBe(await keyFingerprint(b.publicKey))
  })
  it('call keys match on both sides and differ from the message key and between calls', async () => {
    const a = await generateIdentity(), b = await generateIdentity()
    const k1 = await labelledKey(a.privateKey, b.publicKey, 'call:1'), k2 = await labelledKey(b.privateKey, a.publicKey, 'call:1')
    expect(k1).toBe(k2); expect(await labelledKey(a.privateKey, b.publicKey, 'call:2')).not.toBe(k1)
  })

  it('recovery keys: 160 bits, forgiving to type, and they restore the same identity', async () => {
    const rk = newRecoveryKey()
    expect(rk).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/); expect(newRecoveryKey()).not.toBe(rk)
    expect(normaliseRecoveryKey(rk)!.length).toBe(20)
    expect(Buffer.from(normaliseRecoveryKey(rk.toLowerCase().replace(/-/g, ' '))!).equals(Buffer.from(normaliseRecoveryKey(rk)!))).toBe(true)
    expect(normaliseRecoveryKey('too short')).toBeNull()
    const id = await generateIdentity(), backup = await backupWithRecoveryKey(id.pkcs8, rk)
    const back = await restoreWithRecoveryKey(backup, rk)
    expect(await publicFromPkcs8(back.pkcs8)).toBe(id.publicKey)
    await expect(restoreWithRecoveryKey(backup, newRecoveryKey())).rejects.toThrow('not right')
    await expect(restoreWithRecoveryKey(backup, 'nope')).rejects.toThrow('not right')
  })
  it('look-alike letters in a typed recovery key are read as the digits they resemble', () => {
    const rk = newRecoveryKey()
    const mangled = rk.replace(/0/g, 'O').replace(/1/g, 'l')
    expect(Buffer.from(normaliseRecoveryKey(mangled)!).equals(Buffer.from(normaliseRecoveryKey(rk)!))).toBe(true)
  })
  it('group keys: each member opens their own copy, outsiders cannot, and messages are bound to the epoch', async () => {
    const alice = await generateIdentity(), bob = await generateIdentity(), carol = await generateIdentity(), eve = await generateIdentity()
    const G = '44444444-4444-4444-8444-444444444444', C = 'cccccccc-0000-4000-8000-000000000003'
    const gk = newGroupKey()
    const forBob = await wrapGroupKey(alice.privateKey, bob.publicKey, gk, G, 1, B)
    const forCarol = await wrapGroupKey(alice.privateKey, carol.publicKey, gk, G, 1, C)
    const bobKey = await unwrapGroupKey(bob.privateKey, alice.publicKey, forBob, G, 1, B)
    const carolKey = await unwrapGroupKey(carol.privateKey, alice.publicKey, forCarol, G, 1, C)
    const ct = await encryptEnvelope(bobKey.key, { t: 'text', m: 'hello team' }, G, B, 1)
    expect(await decryptEnvelope(carolKey.key, ct, G, B, 1)).toEqual({ t: 'text', m: 'hello team' })
    await expect(decryptEnvelope(carolKey.key, ct, G, B, 2)).rejects.toThrow()                                    // wrong epoch
    await expect(decryptEnvelope(carolKey.key, ct, G, C, 1)).rejects.toThrow()                                    // wrong sender
    await expect(unwrapGroupKey(eve.privateKey, alice.publicKey, forBob, G, 1, B)).rejects.toThrow()             // not Bob's private key
    await expect(unwrapGroupKey(bob.privateKey, alice.publicKey, forBob, G, 1, C)).rejects.toThrow()             // delivered to a different member id
    await expect(unwrapGroupKey(bob.privateKey, eve.publicKey, forBob, G, 1, B)).rejects.toThrow()               // sealed by someone else
    await expect(unwrapGroupKey(bob.privateKey, alice.publicKey, forBob, G, 2, B)).rejects.toThrow()             // other epoch
    // a member who holds the key can hand it to a newcomer
    const dan = await generateIdentity(), D = 'dddddddd-0000-4000-8000-000000000004'
    const forDan = await wrapGroupKey(bob.privateKey, dan.publicKey, bobKey.raw, G, 1, D)
    const danKey = await unwrapGroupKey(dan.privateKey, bob.publicKey, forDan, G, 1, D)
    expect(await decryptEnvelope(danKey.key, ct, G, B, 1)).toEqual({ t: 'text', m: 'hello team' })
  })
})
