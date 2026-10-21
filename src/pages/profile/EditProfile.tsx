import { useEffect, useState } from 'react'
import { Collapse } from '../../components/Collapse'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus, Trash2, X } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { supabase } from '../../lib/supabase'
import { INTERESTS } from '../../lib/friends'
import { EMPTY_DETAILS, RELATIONSHIPS, loadMyDetails, saveMyDetails, type DetailsRow, type Section, type Vis } from '../../lib/social'
import { useAsync, useSubmit } from '../../lib/hooks'
import { nameHint, nameLockedUntil } from '../../lib/profile'
import { Field, Spinner, errMsg, toast } from '../../ui'

const VIS: { v: Vis; label: string }[] = [{ v: 'public', label: 'Public' }, { v: 'friends', label: 'Friends' }, { v: 'me', label: 'Only me' }]

function Card({ id, title, hint, vis, onVis, children }: { id: Section | 'intro'; title: string; hint?: string; vis?: Vis; onVis?: (v: Vis) => void; children: React.ReactNode }) {
  return (
    <section className="card ep-card" aria-labelledby={`ep-${id}`}>
      <div className="row between" style={{ alignItems: 'center', gap: 12 }}>
        <h2 id={`ep-${id}`} className="t-section">{title}</h2>
        {vis && onVis && <select className="select ep-vis" aria-label={`Who can see ${title}`} value={vis} onChange={e => onVis(e.target.value as Vis)}>{VIS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}</select>}
      </div>
      {hint && <p className="t-meta" style={{ margin: '2px 0 10px' }}>{hint}</p>}
      {children}
    </section>
  )
}

/** Small tag editor: type and press Enter / the plus button. */
function Tags({ label, values, onChange, max, placeholder }: { label: string; values: string[]; onChange: (v: string[]) => void; max: number; placeholder: string }) {
  const [v, setV] = useState('')
  const add = () => { const t = v.trim().slice(0, 40); if (!t) return; if (values.length >= max) return toast(`Up to ${max} entries.`); if (!values.some(x => x.toLowerCase() === t.toLowerCase())) onChange([...values, t]); setV('') }
  return (
    <div>
      <div className="chips" style={{ marginBottom: 8 }}>{values.map(x => <span key={x} className="chip on">{x}<button className="chip-x" aria-label={`Remove ${x}`} onClick={() => onChange(values.filter(y => y !== x))}><X size={14} /></button></span>)}</div>
      <div className="row"><input className="input" aria-label={label} placeholder={placeholder} maxLength={40} value={v} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
        <button className="btn icon" aria-label={`Add ${label}`} onClick={add}><Plus size={18} /></button></div>
    </div>
  )
}

export default function EditProfile() {
  const { uid, profile, refreshProfile } = useAuth()
  const nav = useNavigate()
  const [busy, submit] = useSubmit()
  const [name, setName] = useState(''), [bio, setBio] = useState(''), [interests, setInterests] = useState<string[]>([])
  const [d, setD] = useState<DetailsRow>(EMPTY_DETAILS)
  const loaded = useAsync(async () => {
    const [det, pp] = await Promise.all([loadMyDetails(uid!), supabase.from('profile_private').select('birth_date').eq('user_id', uid!).maybeSingle()])
    return { det, birth: (pp.data?.birth_date as string | null) ?? null }
  }, [uid])
  useEffect(() => { document.title = 'Edit profile · VYBE' }, [])
  useEffect(() => { if (profile) { setName(profile.display_name); setBio(profile.bio); setInterests(profile.interests) } }, [profile])
  useEffect(() => { if (loaded.data) setD(loaded.data.det) }, [loaded.data])
  const set = (patch: Partial<DetailsRow>) => setD(x => ({ ...x, ...patch }))
  const setVis = (k: Section, v: Vis) => setD(x => ({ ...x, visibility: { ...x.visibility, [k]: v } }))

  const save = () => submit(async () => {
    try {
      if (name.trim().length < 1) return toast('Add your name.')
      for (const l of d.links) if (!/^https:\/\/\S{3,}$/i.test(l.url.trim())) return toast('Links must start with https://')
      const clean: DetailsRow = { ...d, links: d.links.filter(l => l.url.trim()).map(l => ({ label: l.label.trim().slice(0, 40), url: l.url.trim() })), education: d.education.filter(e => e.school.trim()), work: d.work.filter(w => w.employer.trim()) }
      const { error } = await supabase.from('profiles').update({ ...(name.trim().slice(0, 60) !== profile?.display_name ? { display_name: name.trim().slice(0, 60) } : {}), bio: bio.trim().slice(0, 500), interests, location: clean.current_city ?? profile?.location ?? null }).eq('id', uid!)
      if (error) throw error
      await saveMyDetails(uid!, clean)
      await refreshProfile(); toast('Profile saved'); nav(profile ? `/app/u/${profile.username}` : '/app')
    } catch (e) { toast(errMsg(e)) }
  })
  if (loaded.loading || !profile) return <Spinner />
  if (loaded.error) return <p className="error" role="alert">{loaded.error}</p>

  return (
    <div className="ep">
      <header className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <Link className="icon-btn" to={`/app/u/${profile.username}`} aria-label="Back to profile"><ArrowLeft size={22} /></Link>
        <h1 className="t-title grow">Edit profile</h1>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </header>
      <p className="t-meta" style={{ marginBottom: 12 }}>Each section has its own audience. <b>Public</b> is anyone on VYBE, <b>Friends</b> only your friends, <b>Only me</b> just you. Change your photo and cover from your profile.</p>

      <Card id="intro" title="Intro">
        <Field id="ep-name" label="Name" hint={nameHint(nameLockedUntil(profile))}><input id="ep-name" className="input" value={name} maxLength={60} disabled={Boolean(nameLockedUntil(profile))} onChange={e => setName(e.target.value)} /></Field>
        <Field id="ep-user" label="Handle" hint="Your handle is permanent for now."><input id="ep-user" className="input" value={`@${profile.username}`} disabled /></Field>
        <Field id="ep-bio" label="Bio" hint={`${bio.length}/500`}><textarea id="ep-bio" className="textarea" value={bio} maxLength={500} onChange={e => setBio(e.target.value)} /></Field>
      </Card>

      <Card id="about" title="About you" vis={d.visibility.about} onVis={v => setVis('about', v)}>
        <Field id="ep-about" label="Tell people more" hint={`${d.about.length}/500`}><textarea id="ep-about" className="textarea" value={d.about} maxLength={500} onChange={e => set({ about: e.target.value })} /></Field>
      </Card>

      <Card id="personal" title="Personal details" vis={d.visibility.personal} onVis={v => setVis('personal', v)}>
        <Field id="ep-city" label="Current city or town"><input id="ep-city" className="input" value={d.current_city ?? ''} maxLength={80} onChange={e => set({ current_city: e.target.value })} /></Field>
        <Field id="ep-home" label="Hometown"><input id="ep-home" className="input" value={d.hometown ?? ''} maxLength={80} onChange={e => set({ hometown: e.target.value })} /></Field>
        <Field id="ep-rel" label="Relationship status"><select id="ep-rel" className="select" value={d.relationship ?? ''} onChange={e => set({ relationship: e.target.value || null })}><option value="">Not shown</option>{Object.entries(RELATIONSHIPS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field id="ep-gender" label="Gender" hint="Never shown to other people."><select id="ep-gender" className="select" value={d.gender ?? ''} onChange={e => set({ gender: e.target.value || null })}><option value="">Not shown</option><option value="female">Female</option><option value="male">Male</option><option value="nonbinary">Non-binary</option><option value="prefer_not">Prefer not to say</option></select></Field>
        <label className="row" style={{ minHeight: 44 }}><input type="checkbox" checked={d.birthday_visible} disabled={!loaded.data?.birth} onChange={e => set({ birthday_visible: e.target.checked })} /> <span>Show my birthday (day and month only){!loaded.data?.birth ? ' — add your birth date in onboarding first' : ''}</span></label>
        <div className="field"><span style={{ fontWeight: 600, fontSize: '.875rem' }}>Languages</span><Tags label="language" values={d.languages} onChange={languages => set({ languages })} max={8} placeholder="e.g. isiZulu" /></div>
      </Card>

      <Card id="work" title="Work" vis={d.visibility.work} onVis={v => setVis('work', v)}>
        {d.work.map((w, i) => (
          <div key={i} className="ep-pair">
            <input className="input" aria-label={`Employer ${i + 1}`} placeholder="Company or organisation" maxLength={120} value={w.employer} onChange={e => set({ work: d.work.map((x, k) => (k === i ? { ...x, employer: e.target.value } : x)) })} />
            <input className="input" aria-label={`Role ${i + 1}`} placeholder="Role (optional)" maxLength={120} value={w.role ?? ''} onChange={e => set({ work: d.work.map((x, k) => (k === i ? { ...x, role: e.target.value } : x)) })} />
            <button className="icon-btn" aria-label={`Remove work ${i + 1}`} onClick={() => set({ work: d.work.filter((_, k) => k !== i) })}><Trash2 size={18} /></button>
          </div>))}
        {d.work.length < 5 && <button className="btn sm" onClick={() => set({ work: [...d.work, { employer: '', role: '' }] })}><Plus size={16} aria-hidden /> Add work</button>}
      </Card>

      <Card id="education" title="Education" vis={d.visibility.education} onVis={v => setVis('education', v)}>
        {d.education.map((e, i) => (
          <div key={i} className="ep-pair">
            <input className="input" aria-label={`School ${i + 1}`} placeholder="School, college or university" maxLength={120} value={e.school} onChange={ev => set({ education: d.education.map((x, k) => (k === i ? { ...x, school: ev.target.value } : x)) })} />
            <input className="input" aria-label={`Field of study ${i + 1}`} placeholder="Field of study (optional)" maxLength={120} value={e.field ?? ''} onChange={ev => set({ education: d.education.map((x, k) => (k === i ? { ...x, field: ev.target.value } : x)) })} />
            <button className="icon-btn" aria-label={`Remove education ${i + 1}`} onClick={() => set({ education: d.education.filter((_, k) => k !== i) })}><Trash2 size={18} /></button>
          </div>))}
        {d.education.length < 5 && <button className="btn sm" onClick={() => set({ education: [...d.education, { school: '', field: '' }] })}><Plus size={16} aria-hidden /> Add school</button>}
      </Card>

      <Card id="hobbies" title="Hobbies" vis={d.visibility.hobbies} onVis={v => setVis('hobbies', v)}><Tags label="hobby" values={d.hobbies} onChange={hobbies => set({ hobbies })} max={12} placeholder="e.g. Surfing, Chess" /></Card>

      <section className="card ep-card" aria-labelledby="ep-int"><h2 id="ep-int" className="t-section" style={{ marginBottom: 8 }}>Interests</h2>
        <p className="t-meta" style={{ marginBottom: 8 }}>Interests help VYBE suggest plans, people and communities. They’re shown on your profile.</p>
        <Collapse title="Choose interests" summary={interests.length ? `${interests.length} selected` : 'None yet'}>
          <div className="chips" role="group" aria-labelledby="ep-int">{INTERESTS.map(i => <button key={i} className="chip" aria-pressed={interests.includes(i)} onClick={() => setInterests(c => (c.includes(i) ? c.filter(x => x !== i) : [...c, i]))}>{i}</button>)}</div>
        </Collapse>
      </section>

      <Card id="travel" title="Travel" hint="Places you’ve been or want to go." vis={d.visibility.travel} onVis={v => setVis('travel', v)}><Tags label="place" values={d.travel} onChange={travel => set({ travel })} max={20} placeholder="e.g. Zanzibar" /></Card>

      <Card id="links" title="Links" hint="Websites, blogs, portfolios. Must start with https://." vis={d.visibility.links} onVis={v => setVis('links', v)}>
        {d.links.map((l, i) => (
          <div key={i} className="ep-pair">
            <input className="input" aria-label={`Link label ${i + 1}`} placeholder="Label" maxLength={40} value={l.label} onChange={e => set({ links: d.links.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} />
            <input className="input" aria-label={`Link address ${i + 1}`} placeholder="https://…" inputMode="url" value={l.url} onChange={e => set({ links: d.links.map((x, k) => (k === i ? { ...x, url: e.target.value } : x)) })} />
            <button className="icon-btn" aria-label={`Remove link ${i + 1}`} onClick={() => set({ links: d.links.filter((_, k) => k !== i) })}><Trash2 size={18} /></button>
          </div>))}
        {d.links.length < 5 && <button className="btn sm" onClick={() => set({ links: [...d.links, { label: '', url: 'https://' }] })}><Plus size={16} aria-hidden /> Add link</button>}
      </Card>

      <Card id="contact" title="Contact info" hint="Shown only to the audience you choose. Friends by default." vis={d.visibility.contact} onVis={v => setVis('contact', v)}>
        <Field id="ep-social" label="Social media handle"><input id="ep-social" className="input" maxLength={120} value={d.contact.social ?? ''} onChange={e => set({ contact: { ...d.contact, social: e.target.value } })} placeholder="@yourhandle" /></Field>
        <Field id="ep-phone" label="Phone"><input id="ep-phone" className="input" inputMode="tel" maxLength={40} value={d.contact.phone ?? ''} onChange={e => set({ contact: { ...d.contact, phone: e.target.value } })} /></Field>
        <Field id="ep-mail" label="Public email"><input id="ep-mail" className="input" type="email" maxLength={120} value={d.contact.email ?? ''} onChange={e => set({ contact: { ...d.contact, email: e.target.value } })} /></Field>
      </Card>

      <div className="ep-save"><button className="btn primary" style={{ width: '100%' }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button></div>
    </div>
  )
}
