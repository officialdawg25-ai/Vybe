import { describe, expect, it } from 'vitest'
import { publishKeys } from '../../src/lib/chatKeys'
import type { Backup } from '../../src/lib/e2ee'

/**
 * A tiny stand-in for the two tables that enforces what the database does: chat_keys may be inserted, and updated only on
 * (public_key, updated_at); an upsert (which also SETs user_id) is refused just like Postgres' column grant refuses it.
 */
function fakeDb(opts: { raceInsert?: boolean } = {}) {
  const keys = new Map<string, string>(), backups = new Map<string, unknown>(), calls: string[] = []
  const err = (code: string, message: string) => ({ data: null, error: { code, message } })
  const from = (table: string) => ({
    upsert: async (row: Record<string, unknown>) => {
      calls.push(`${table}.upsert`)
      if (table === 'chat_keys') return err('42501', 'permission denied for table chat_keys')
      backups.set(row.user_id as string, row.backup); return { data: null, error: null }
    },
    update: (row: Record<string, unknown>) => ({
      eq: (_c: string, uid: string) => ({
        select: async () => {
          calls.push(`${table}.update`)
          if (Object.keys(row).some(k => !['public_key', 'updated_at'].includes(k))) return err('42501', 'permission denied')
          if (!keys.has(uid)) return { data: [], error: null }
          keys.set(uid, row.public_key as string); return { data: [{ user_id: uid }], error: null }
        },
      }),
    }),
    insert: async (row: Record<string, unknown>) => {
      calls.push(`${table}.insert`)
      if (opts.raceInsert) { opts.raceInsert = false; keys.set(row.user_id as string, 'other-tab'); return err('23505', 'duplicate key') }
      if (keys.has(row.user_id as string)) return err('23505', 'duplicate key')
      keys.set(row.user_id as string, row.public_key as string); return { data: null, error: null }
    },
  })
  return { db: { from } as never, keys, backups, calls }
}

const BACKUP: Backup = { v: 1, salt: 's', iv: 'i', ct: 'c', iter: 600_000 }

describe('publishing secure-chat keys', () => {
  it('first setup inserts the key (never via upsert, which the column grant refuses) and stores the backup first', async () => {
    const f = fakeDb()
    await publishKeys(f.db, 'u1', 'PUB1', BACKUP)
    expect(f.keys.get('u1')).toBe('PUB1')
    expect(f.backups.get('u1')).toEqual(BACKUP)
    expect(f.calls).toEqual(['chat_key_backups.upsert', 'chat_keys.update', 'chat_keys.insert'])
    expect(f.calls).not.toContain('chat_keys.upsert')
  })
  it('starting over replaces the existing key with an update', async () => {
    const f = fakeDb()
    await publishKeys(f.db, 'u1', 'PUB1', BACKUP)
    await publishKeys(f.db, 'u1', 'PUB2', BACKUP)
    expect(f.keys.get('u1')).toBe('PUB2')
  })
  it('when another tab inserts at the same moment, it updates instead of failing', async () => {
    const f = fakeDb({ raceInsert: true })
    await publishKeys(f.db, 'u1', 'PUB1', BACKUP)
    expect(f.keys.get('u1')).toBe('PUB1')
  })
})
