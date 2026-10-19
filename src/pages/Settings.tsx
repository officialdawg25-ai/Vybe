import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { INTERESTS } from '../lib/friends'
import { uploadMedia, validateMedia } from '../lib/media'
import { Avatar, Field, Spinner, errMsg, toast } from '../ui'
import type { PublicProfile } from '../lib/types'

export default function Settings() {
  const { uid, profile, refreshProfile, session } = useAuth()
  const nav = useNavigate()
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  const [location, setLocation] = useState('')
  const [interests, setInterests] = useState<string[]>([])
  const [dm, setDm] = useState<'friends' | 'everyone'>('friends')
  const [busy, submit] = useSubmit()
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => {
    document.title = 'Settings · VYBE'
    if (profile) { setName(profile.display_name); setBio(profile.bio); setLocation(profile.location ?? ''); setInterests(profile.interests); setDm(profile.dm_policy) }
  }, [profile])

  const blocked = useAsync(async () => {
    const { data: b, error } = await supabase.from('blocks').select('blocked')
    if (error) throw error
    const ids = (b ?? []).map(x => x.blocked)
    if (!ids.length) return [] as PublicProfile[]
    // profiles RLS hides blocked accounts in both directions, so fall back to a placeholder row to keep unblock possible.
    const { data } = await supabase.from('profiles').select('id,username,display_name,avatar_path').in('id', ids)
    const found = (data ?? []) as PublicProfile[]
    return ids.map(id => found.find(f => f.id === id) ?? ({ id, username: 'unavailable', display_name: 'Blocked account', avatar_path: null } as PublicProfile))
  }, [])

  const save = () => submit(async () => {
    const { error } = await supabase.from('profiles').update({ display_name: name.trim().slice(0, 60), bio: bio.trim(), location: location.trim() || null, interests, dm_policy: dm }).eq('id', uid!)
    if (error) return toast(errMsg(error))
    await refreshProfile(); toast('Saved')
  })
  const avatar = (f?: File) => submit(async () => {
    if (!f) return
    const c = validateMedia(f)
    if (!c.ok || c.type !== 'image') return toast('Choose a JPG, PNG, WebP or GIF image under 10 MB.')
    try {
      const up = await uploadMedia(uid!, f)
      const { error } = await supabase.from('profiles').update({ avatar_path: up.path }).eq('id', uid!)
      if (error) throw error
      if (profile?.avatar_path) await supabase.storage.from('media').remove([profile.avatar_path])
      await refreshProfile(); toast('Photo updated')
    } catch (e) { toast(errMsg(e)) }
  })
  const unblock = async (id: string) => { const { error } = await supabase.from('blocks').delete().eq('blocker', uid!).eq('blocked', id); if (error) toast(errMsg(error)); else blocked.reload() }
  const signOut = async () => { await supabase.auth.signOut(); nav('/', { replace: true }) }
  const exportData = () => submit(async () => {
    const [p, posts, saves, ev] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', uid!).single(),
      supabase.from('posts').select('*').eq('author', uid!),
      supabase.from('saves').select('*'),
      supabase.from('events').select('*').eq('host', uid!),
    ])
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), email: session?.user.email, profile: p.data, posts: posts.data, saves: saves.data, plans_hosted: ev.data }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'vybe-export.json'; a.click(); URL.revokeObjectURL(a.href)
  })
  const del = async () => {
    if (prompt('This permanently deletes your account and content. Type DELETE to confirm.') !== 'DELETE') return
    const { error } = await supabase.rpc('delete_my_account')
    if (error) return toast(errMsg(error))
    await supabase.auth.signOut(); nav('/', { replace: true })
  }

  if (!profile) return <Spinner />
  return (
    <div className="stack" style={{ gap: 32 }}>
      <h1 className="t-title">Settings</h1>
      <section aria-labelledby="s-profile">
        <h2 id="s-profile" className="t-section" style={{ marginBottom: 12 }}>Profile</h2>
        <div className="row" style={{ marginBottom: 16 }}>
          <Avatar size="lg" path={profile.avatar_path} name={profile.display_name || profile.username} />
          <input ref={file} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif" onChange={e => avatar(e.target.files?.[0])} />
          <button className="btn sm" onClick={() => file.current?.click()}>Change photo</button>
        </div>
        <Field id="st-dn" label="Display name"><input id="st-dn" className="input" value={name} maxLength={60} onChange={e => setName(e.target.value)} /></Field>
        <Field id="st-user" label="Username" hint="Usernames are permanent for now."><input id="st-user" className="input" value={`@${profile.username}`} disabled /></Field>
        <Field id="st-bio" label="Bio"><textarea id="st-bio" className="textarea" value={bio} maxLength={500} onChange={e => setBio(e.target.value)} /></Field>
        <Field id="st-loc" label="City or area"><input id="st-loc" className="input" value={location} maxLength={120} onChange={e => setLocation(e.target.value)} /></Field>
        <div className="field"><span id="st-int" style={{ fontWeight: 600, fontSize: '.875rem' }}>Interests</span>
          <div className="chips" role="group" aria-labelledby="st-int">{INTERESTS.map(i => <button key={i} className="chip" aria-pressed={interests.includes(i)} onClick={() => setInterests(c => c.includes(i) ? c.filter(x => x !== i) : c.length < 20 ? [...c, i] : c)}>{i}</button>)}</div></div>
        <h2 className="t-section" style={{ margin: '24px 0 12px' }}>Privacy</h2>
        <Field id="st-dm" label="Who can message you" hint="Blocked people can never message you, whatever this is set to.">
          <select id="st-dm" className="select" value={dm} onChange={e => setDm(e.target.value as 'friends' | 'everyone')}><option value="friends">Friends only</option><option value="everyone">Anyone on VYBE</option></select>
        </Field>
        <button className="btn primary" disabled={busy} onClick={save}>Save changes</button>
      </section>
      <section aria-labelledby="s-blocked">
        <h2 id="s-blocked" className="t-section">Blocked accounts</h2>
        {blocked.loading ? <Spinner /> : !blocked.data?.length ? <p className="t-support" style={{ marginTop: 8 }}>You haven't blocked anyone.</p> : (
          <div className="list">{blocked.data.map(b => <div key={b.id} className="item row"><Avatar path={b.avatar_path} name={b.display_name} /><span className="grow">{b.display_name}</span><button className="btn sm" onClick={() => unblock(b.id)}>Unblock</button></div>)}</div>
        )}
      </section>
      <section aria-labelledby="s-account">
        <h2 id="s-account" className="t-section" style={{ marginBottom: 8 }}>Account</h2>
        <p className="t-support" style={{ marginBottom: 12 }}>Signed in as {session?.user.email}</p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn" onClick={signOut}>Sign out</button>
          <button className="btn" onClick={exportData} disabled={busy}>Export my data</button>
          <button className="btn danger" onClick={del}>Delete account</button>
        </div>
      </section>
    </div>
  )
}
