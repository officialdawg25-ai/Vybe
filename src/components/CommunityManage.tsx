import { useRef, useState } from 'react'
import { Camera, Globe2, Lock, ShieldCheck, Users } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useSubmit } from '../lib/hooks'
import { INTERESTS } from '../lib/friends'
import { saveCommunityImage } from '../lib/communityMedia'
import { isMissingSchema } from '../lib/tickets'
import { ImageCropper } from './ImageCropper'
import { Field, Sheet, errMsg, toast } from '../ui'
import type { Community } from '../lib/types'

/**
 * The page's controls for its owner and admins (row security decides who can really change anything): name and about, rules,
 * topics, who can join, who can post, and the cover and picture.
 */
export function CommunityManage({ c, uid, onClose, onSaved }: { c: Community; uid: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(c.name)
  const [description, setDescription] = useState(c.description ?? '')
  const [rules, setRules] = useState(c.rules ?? '')
  const [topics, setTopics] = useState<string[]>(c.topics ?? [])
  const [visibility, setVisibility] = useState(c.visibility)
  const [postPolicy, setPostPolicy] = useState<'members' | 'admins'>(c.post_policy ?? 'members')
  const [crop, setCrop] = useState<{ file: File; kind: 'cover' | 'avatar' } | null>(null)
  const [busy, submit] = useSubmit()
  const [err, setErr] = useState('')
  const coverIn = useRef<HTMLInputElement>(null), picIn = useRef<HTMLInputElement>(null)

  const save = () => submit(async () => {
    setErr('')
    if (name.trim().length < 2) return setErr('Give your community a name.')
    const base = { name: name.trim(), description: description.trim(), rules: rules.trim(), topics, visibility }
    let { error } = await supabase.from('communities').update({ ...base, post_policy: postPolicy }).eq('id', c.id)
    if (error && isMissingSchema(error)) {
      if (postPolicy !== (c.post_policy ?? 'members')) return setErr('Choosing who can post needs the latest VYBE update on the server.')
      ;({ error } = await supabase.from('communities').update(base).eq('id', c.id))
    }
    if (error) return setErr(errMsg(error))
    toast('Community updated'); onSaved(); onClose()
  })
  const pick = (kind: 'cover' | 'avatar', f?: File) => { if (f) { if (!/^image\/(jpeg|png|webp)$/.test(f.type)) toast('Choose a JPG, PNG or WebP image.'); else setCrop({ file: f, kind }) } }
  const done = async (f: File) => {
    const kind = crop!.kind; setCrop(null)
    try { await saveCommunityImage(c.id, uid, f, kind, kind === 'cover' ? c.cover_path : c.avatar_path); toast(kind === 'cover' ? 'Cover updated' : 'Picture updated'); onSaved() } catch (e) { toast(errMsg(e)) }
  }
  return (
    <>
      <Sheet title="Manage community" onClose={onClose}>
        <div className="stack" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => coverIn.current?.click()}><Camera size={16} aria-hidden /> Change cover</button>
            <button className="btn" onClick={() => picIn.current?.click()}><Camera size={16} aria-hidden /> Change picture</button>
          </div>
          <Field id="cm-name" label="Name"><input id="cm-name" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></Field>
          <Field id="cm-desc" label="About"><textarea id="cm-desc" className="textarea" rows={4} value={description} maxLength={1000} onChange={e => setDescription(e.target.value)} /></Field>
          <Field id="cm-rules" label="Community rules"><textarea id="cm-rules" className="textarea" rows={4} value={rules} maxLength={2000} onChange={e => setRules(e.target.value)} /></Field>
          <fieldset className="cm-opts"><legend className="t-name">Who can join</legend>
            <button type="button" className={`cp-opt${visibility === 'public' ? ' on' : ''}`} aria-pressed={visibility === 'public'} onClick={() => setVisibility('public')}><Globe2 size={20} aria-hidden /><span className="grow"><b>Public</b><span className="t-meta" style={{ display: 'block' }}>Anyone can join and see posts and plans</span></span></button>
            <button type="button" className={`cp-opt${visibility === 'private' ? ' on' : ''}`} aria-pressed={visibility === 'private'} onClick={() => setVisibility('private')}><Lock size={20} aria-hidden /><span className="grow"><b>Private</b><span className="t-meta" style={{ display: 'block' }}>People ask to join; you approve them</span></span></button>
          </fieldset>
          <fieldset className="cm-opts"><legend className="t-name">Who can post</legend>
            <button type="button" className={`cp-opt${postPolicy === 'members' ? ' on' : ''}`} aria-pressed={postPolicy === 'members'} onClick={() => setPostPolicy('members')}><Users size={20} aria-hidden /><span className="grow"><b>All members</b><span className="t-meta" style={{ display: 'block' }}>Anyone who has joined</span></span></button>
            <button type="button" className={`cp-opt${postPolicy === 'admins' ? ' on' : ''}`} aria-pressed={postPolicy === 'admins'} onClick={() => setPostPolicy('admins')}><ShieldCheck size={20} aria-hidden /><span className="grow"><b>Admins and moderators only</b><span className="t-meta" style={{ display: 'block' }}>Everyone can still read and comment</span></span></button>
          </fieldset>
          <div><div className="t-name" style={{ marginBottom: 6 }}>Topics</div>
            <div className="chips" role="group" aria-label="Topics">{INTERESTS.map(i => <button key={i} type="button" className="chip" aria-pressed={topics.includes(i)} onClick={() => setTopics(t => t.includes(i) ? t.filter(x => x !== i) : t.length < 10 ? [...t, i] : t)}>{i}</button>)}</div>
          </div>
          {err && <p className="cp-problem" role="alert">{err}</p>}
          <div className="row" style={{ gap: 8 }}><button className="btn primary grow" disabled={busy} onClick={save}>Save changes</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
        </div>
        <input ref={coverIn} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={e => { pick('cover', e.target.files?.[0]); e.target.value = '' }} />
        <input ref={picIn} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={e => { pick('avatar', e.target.files?.[0]); e.target.value = '' }} />
      </Sheet>
      {crop && <ImageCropper file={crop.file} shape={crop.kind} onCancel={() => setCrop(null)} onDone={done} />}
    </>
  )
}
