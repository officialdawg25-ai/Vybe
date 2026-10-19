import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { PostCard } from '../components/PostCard'
import { Avatar, Empty, ErrorState, Spinner, Tabs } from '../ui'
import { formatEventTime } from '../lib/format'
import type { Community, EventRow, Post, PublicProfile } from '../lib/types'

type Tab = 'people' | 'posts' | 'plans' | 'communities'
const RECENT = 'vybe.recent-searches'
const recent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT) ?? '[]') } catch { return [] } }
const remember = (q: string) => { try { localStorage.setItem(RECENT, JSON.stringify([q, ...recent().filter(x => x !== q)].slice(0, 6))) } catch { /* storage unavailable */ } }
/** Strip characters that carry meaning in PostgREST filter syntax or LIKE patterns. */
export const clean = (q: string) => q.replace(/[,()%*_\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

export default function Search() {
  const { uid } = useAuth()
  const [params, setParams] = useSearchParams()
  const q = clean(params.get('q') ?? '')
  const [tab, setTab] = useState<Tab>('people')
  const [input, setInput] = useState(q)
  useEffect(() => { document.title = 'Search · VYBE' }, [])
  useEffect(() => setInput(q), [q])

  const res = useAsync(async () => {
    if (q.length < 2) return null
    // All queries run under RLS: private posts, invite-only plans and blocked users never appear.
    if (tab === 'people') {
      const { data, error } = await supabase.from('profiles').select('id,username,display_name,avatar_path,bio').or(`username.ilike.${q}%,display_name.ilike.%${q}%`).limit(25)
      if (error) throw error; return data as (PublicProfile & { bio: string })[]
    }
    if (tab === 'posts') {
      const { data, error } = await supabase.from('posts').select('*, profiles:author(id,username,display_name,avatar_path), reactions(count), comments(count), mine_reaction:reactions(user_id), mine_save:saves(user_id)').ilike('body', `%${q}%`).eq('mine_reaction.user_id', uid!).order('created_at', { ascending: false }).limit(20)
      if (error) throw error; return data as unknown as Post[]
    }
    if (tab === 'plans') {
      const { data, error } = await supabase.from('events').select('*, profiles:host(id,username,display_name,avatar_path)').eq('status', 'active').or(`title.ilike.%${q}%,location.ilike.%${q}%`).order('starts_at').limit(25)
      if (error) throw error; return data as unknown as EventRow[]
    }
    const { data, error } = await supabase.from('communities').select('*').or(`name.ilike.%${q}%,description.ilike.%${q}%`).limit(25)
    if (error) throw error; return data as Community[]
  }, [q, tab])

  const submit = (e: FormEvent) => { e.preventDefault(); const c = clean(input); if (c.length >= 2) { remember(c); setParams({ q: c }, { replace: true }) } }

  const rows = res.data as any[] | null
  return (
    <>
      <h1 className="sr-only">Search</h1>
      <form role="search" onSubmit={submit} className="row" style={{ marginBottom: 12 }}>
        <input className="input" type="search" aria-label="Search VYBE" placeholder="Search people, posts, plans, communities" value={input} onChange={e => setInput(e.target.value)} autoFocus />
        <button className="btn primary">Search</button>
      </form>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'people', label: 'People' }, { id: 'posts', label: 'Posts' }, { id: 'plans', label: 'Plans' }, { id: 'communities', label: 'Communities' }]} />
      {q.length < 2 ? (
        <div>
          <p className="t-meta">{recent().length ? 'Recent searches' : 'Type at least 2 characters to search.'}</p>
          <div className="chips" style={{ marginTop: 8 }}>{recent().map(r => <button key={r} className="chip" onClick={() => setParams({ q: r })}>{r}</button>)}</div>
        </div>
      ) : res.loading ? <Spinner /> : res.error ? <ErrorState message={res.error} onRetry={res.reload} /> : !rows?.length ? (
        <Empty title={`No ${tab} found for “${q}”`}>Check the spelling or try a broader term.</Empty>
      ) : tab === 'people' ? (
        <div className="list">{rows.map((p: PublicProfile & { bio: string }) => (
          <Link key={p.id} to={`/app/u/${p.username}`} className="item row link"><Avatar path={p.avatar_path} name={p.display_name || p.username} />
            <div className="grow"><div className="t-name clamp-1">{p.display_name || p.username}</div><div className="t-meta clamp-1">@{p.username}</div></div></Link>))}</div>
      ) : tab === 'posts' ? (
        <div>{rows.map((p: Post) => <PostCard key={p.id} post={p} onChange={n => res.setData(cur => (cur as Post[]).map(x => (x.id === n.id ? n : x)) as never)} onDeleted={id => res.setData(cur => (cur as Post[]).filter(x => x.id !== id) as never)} />)}</div>
      ) : tab === 'plans' ? (
        <div className="list">{rows.map((e: EventRow) => (
          <Link key={e.id} to={`/app/plans/${e.id}`} className="item link" style={{ display: 'block' }}><div className="t-name">{e.title}</div><div className="t-meta">{formatEventTime(e.starts_at, e.timezone)}{e.location ? ` · ${e.location}` : ''}</div></Link>))}</div>
      ) : (
        <div className="list">{rows.map((c: Community) => (
          <Link key={c.id} to={`/app/communities/${c.id}`} className="item link" style={{ display: 'block' }}><div className="t-name">{c.name} {c.visibility === 'private' && <span className="t-meta">· Private</span>}</div><div className="t-meta clamp-1">{c.description}</div></Link>))}</div>
      )}
    </>
  )
}
