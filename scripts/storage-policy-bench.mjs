// Lab benchmark (PGlite, not production): the cost of the `media` read policy that Supabase Storage evaluates for every
// file it signs. Seeds USERS/POSTS rows (posts with a photo, a gallery row, a comment each, 20% with a voice note), then
// times one feed page's check (10 post photos + 10 author pictures, none owned by the viewer) as a signed-in viewer.
// UPTO=<migration file prefix> stops before that migration (e.g. UPTO=20261107 for the state before migration 25).
// Usage: POSTS=40000 node scripts/storage-policy-bench.mjs
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'

const repo = new URL('../supabase/migrations/', import.meta.url).pathname
// The same auth/storage stand-ins as the database tests, plus Storage's own (bucket_id, name) index.
const STUBS = readFileSync(new URL('../tests/db/rls.test.ts', import.meta.url), 'utf8').match(/const STUBS = `([\s\S]*?)`/)[1] + '\ncreate unique index on storage.objects (bucket_id, name);\n'
const db = new PGlite()
await db.exec(STUBS)
for (const f of readdirSync(repo).filter(f => f.endsWith('.sql')).sort()) {
  if (process.env.UPTO && f > process.env.UPTO) break
  await db.exec(readFileSync(repo + f, 'utf8'))
}

const N_USERS = Number(process.env.USERS ?? 2000), N_POSTS = Number(process.env.POSTS ?? 40000)
const t0 = Date.now()
await db.exec(`set session_replication_role = replica;`)
await db.exec(`insert into auth.users (id, email) select gen_random_uuid(), 'u'||g||'@e.com' from generate_series(1, ${N_USERS}) g;`)
await db.exec(`insert into public.profiles (id, username, display_name, avatar_path) select id, 'user'||row_number() over (), 'U', id||'/'||gen_random_uuid()||'.webp' from auth.users;`)
await db.exec(`
  insert into public.posts (id, author, body, media_path, media_type, visibility, created_at)
  select gen_random_uuid(), (select id from auth.users offset (g % ${N_USERS}) limit 1), 'p', null, null, 'public', now() - (g || ' minutes')::interval
  from generate_series(1, ${N_POSTS}) g;`)
await db.exec(`update public.posts set media_path = author||'/'||gen_random_uuid()||'.jpg', media_type = 'image';`)
await db.exec(`insert into public.post_media (post_id, sort, path, type) select id, 0, media_path, 'image' from public.posts;`)
await db.exec(`insert into public.comments (id, post_id, author, body, audio_path, audio_ms) select gen_random_uuid(), id, author, 'c', a, case when a is not null then 3000 end from (select id, author, case when random() < 0.2 then author||'/'||gen_random_uuid()||'.webm' end a from public.posts) s;`)
await db.exec(`insert into storage.objects (bucket_id, name) select 'media', media_path from public.posts union all select 'media', avatar_path from public.profiles;`)
await db.exec(`set session_replication_role = origin; analyze;`)
console.log(`seeded ${N_USERS} users, ${N_POSTS} posts in ${Date.now() - t0} ms`)

const viewer = (await db.query(`select id from auth.users limit 1`)).rows[0].id
const posts = (await db.query(`select media_path, author from public.posts where author <> $1 order by created_at desc limit 10`, [viewer])).rows
const avatars = (await db.query(`select avatar_path from public.profiles where id = any($1)`, [posts.map(r => r.author)])).rows.map(r => r.avatar_path)
const page = [...posts.map(r => r.media_path), ...avatars, ...(await db.query(`select avatar_path from public.profiles where id <> $1 limit ${20 - posts.length - avatars.length}`, [viewer])).rows.map(r => r.avatar_path)]
const q = `select name from storage.objects where bucket_id = 'media' and name = any($1)`
const run = async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${viewer}', false);`)
  try { const t = performance.now(); const r = await db.query(q, [page]); return { ms: performance.now() - t, n: r.rows.length } }
  finally { await db.exec('reset role') }
}
await run()
const times = []
for (let i = 0; i < 7; i++) times.push((await run()).ms)
times.sort((a, b) => a - b)
const { n } = await run()
console.log(`visible ${n}/${page.length}; signing check for a feed page (10 post images + 10 avatars): median ${times[3].toFixed(1)} ms (min ${times[0].toFixed(1)}, max ${times[6].toFixed(1)})`)
if (process.env.PLAN) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${viewer}', false);`)
  const plan = (await db.query(`explain (analyze, costs off, timing off, summary off) ${q.replace('$1', `array['${page.at(-1)}']`)}`)).rows.map(r => r['QUERY PLAN'])
  await db.exec('reset role')
  console.log(plan.filter(l => /Scan|SubPlan/.test(l)).join('\n'))
}
