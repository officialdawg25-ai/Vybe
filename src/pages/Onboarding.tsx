import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Camera, Check, MapPin } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { INTERESTS, loadRelations } from '../lib/friends'
import { nearestCity, type City } from '../lib/cities'
import { usePlace, type Place } from '../lib/location'
import { checkAvatarFile, saveAvatar } from '../lib/avatar'
import { rankByInterest, sharedInterests } from '../lib/feeds'
import { ImageCropper } from '../components/ImageCropper'
import { LocationPicker } from '../components/LocationPicker'
import { FriendButton } from '../components/FriendButton'
import { Avatar, Field, Spinner, errMsg, toast } from '../ui'
import { savePrivate, updateProfile } from '../lib/profile'
import { playSound } from '../lib/sounds'
import type { Community, PublicProfile } from '../lib/types'

const INTENTS: [string, string, string][] = [
  ['meet_people', 'Meet new people', 'Find friends who share your interests'],
  ['find_events', 'Find things to do', 'Plans, nights out and live events near you'],
  ['host_events', 'Host events', 'Create plans and sell tickets'],
  ['grow_community', 'Build a community', 'Bring a group together'],
  ['stay_in_touch', 'Stay in touch', 'Keep up with friends and family'],
  ['promote', 'Promote a brand or venue', 'Run an organization page'],
]
const STEPS = ['Welcome', 'Your photo', 'Where you are', 'What moves you', 'Your people', 'Privacy', 'All set'] as const
const NOTIF: [string, string][] = [['friend_request', 'Friend requests'], ['comment', 'Comments on my posts'], ['reaction', 'Likes on my posts'], ['event_invite', 'Plan invitations'], ['rsvp', 'RSVPs to my plans']]

/** Age in whole years from a YYYY-MM-DD string (null when invalid). */
export function ageFrom(iso: string, now = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  let age = now.getFullYear() - y
  if (now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d)) age--
  return age >= 0 && age < 130 ? age : null
}

/** Phased onboarding. Progress is saved after every step, so people can leave and return exactly where they were. */
export default function Onboarding() {
  const { uid, profile, refreshProfile } = useAuth()
  const nav = useNavigate()
  const [step, setStep] = useState(Math.min(profile?.onboarding_step ?? 0, STEPS.length - 1))
  const [name, setName] = useState(profile?.display_name ?? '')
  const [bio, setBio] = useState(profile?.bio ?? '')
  const [birth, setBirth] = useState('')
  const [agree, setAgree] = useState(false)
  const [intents, setIntents] = useState<string[]>(profile?.intents ?? [])
  const [interests, setInterests] = useState<string[]>(profile?.interests ?? [])
  const [city, setCity] = useState<City | null>(null)
  const [picking, setPicking] = useState(false)
  const [cropping, setCropping] = useState<File | null>(null)
  const [dm, setDm] = useState<'friends' | 'everyone'>(profile?.dm_policy ?? 'friends')
  const [prefs, setPrefs] = useState<Record<string, boolean>>(profile?.notif_prefs ?? {})
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const [, setPlace] = usePlace(profile)
  useEffect(() => { document.title = 'Welcome · VYBE' }, [])
  useEffect(() => { if (profile && !name) setName(profile.display_name) }, [profile, name])

  const age = birth ? ageFrom(birth) : null
  const first = (name || profile?.username || '').split(' ')[0]
  const pct = Math.round((step / (STEPS.length - 1)) * 100)

  /** Writes this step's data, advances, and remembers where we are. */
  const next = (save: () => Promise<unknown> | void, to = step + 1) => submit(async () => {
    setErr('')
    try {
      await save()
      await updateProfile(uid!, { onboarding_step: Math.min(20, to) })
      setStep(to); window.scrollTo({ top: 0 })
    } catch (e) { setErr(errMsg(e)) }
  })

  const finish = () => submit(async () => {
    try { await updateProfile(uid!, { onboarded_at: new Date().toISOString(), onboarding_step: 6 }) } catch (e) { return setErr(errMsg(e)) }
    playSound('success'); await refreshProfile(); nav('/app', { replace: true })
  })

  const people = useAsync(async () => {
    if (step !== 4) return { people: [] as (PublicProfile & { interests: string[] })[], communities: [] as Community[], rels: new Map() }
    const rels = await loadRelations(uid!)
    let pq = supabase.from('profiles').select('id,username,display_name,avatar_path,interests').neq('id', uid!).limit(50)
    if (interests.length) pq = pq.overlaps('interests', interests)
    const [p, c] = await Promise.all([pq, supabase.from('communities').select('*').eq('visibility', 'public').limit(30)])
    const ppl = ((p.data ?? []) as (PublicProfile & { interests: string[] })[]).filter(x => !rels.has(x.id))
    const coms = ((c.data ?? []) as Community[])
    return { people: rankByInterest(ppl, interests, x => x.interests).slice(0, 6), communities: rankByInterest(coms, interests, x => x.topics).slice(0, 4), rels }
  }, [step, uid])
  const joined = useMemo(() => new Set<string>(), [])

  return (
    <div className="onb">
      <div className="onb-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}><i style={{ width: `${pct}%` }} /></div>
      <p className="t-meta" style={{ margin: '8px 0 16px' }}>Step {step + 1} of {STEPS.length} · {STEPS[step]}</p>

      {step === 0 && (
        <section aria-labelledby="o-h">
          <h1 id="o-h" className="t-display-sm">Welcome to VYBE{first ? `, ${first}` : ''}</h1>
          <p className="t-support" style={{ margin: '8px 0 20px' }}>A couple of quick questions so we can show you the right people and plans. Takes about two minutes.</p>
          <Field id="dn" label="What should we call you?"><input id="dn" className="input" value={name} maxLength={60} onChange={e => setName(e.target.value)} autoComplete="name" /></Field>
          <Field id="bd" label="Date of birth" hint="Used only to confirm you’re 13 or older. It is never shown to anyone."><input id="bd" type="date" className="input" value={birth} max={new Date().toISOString().slice(0, 10)} onChange={e => setBirth(e.target.value)} autoComplete="bday" /></Field>
          <div className="field"><span id="why" style={{ fontWeight: 600, fontSize: '.875rem' }}>What brings you to VYBE?</span>
            <div className="choices" role="group" aria-labelledby="why">{INTENTS.map(([id, label, hint]) => (
              <button key={id} type="button" className={`choice${intents.includes(id) ? ' on' : ''}`} aria-pressed={intents.includes(id)} onClick={() => setIntents(c => c.includes(id) ? c.filter(x => x !== id) : c.length < 8 ? [...c, id] : c)}>
                <span className="t-name">{label}</span><span className="t-meta">{hint}</span>{intents.includes(id) && <Check size={18} aria-hidden className="choice-check" />}</button>))}</div></div>
          <label className="row" style={{ minHeight: 44, alignItems: 'flex-start' }}><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ marginTop: 4 }} /> <span>I’m 13 or older and I’ve read the <a href="/privacy" target="_blank" rel="noopener" style={{ textDecoration: 'underline' }}>privacy &amp; safety summary</a>.</span></label>
          {err && <p className="error" role="alert">{err}</p>}
          <div className="onb-actions"><button className="btn primary" disabled={busy || name.trim().length < 1 || !agree || age == null || age < 13} onClick={() => next(async () => {
            if (age == null || age < 13) throw new Error('You must be at least 13 to use VYBE.')
            await savePrivate(uid!, { birth_date: birth, terms_accepted_at: new Date().toISOString() })
            await updateProfile(uid!, { display_name: name.trim().slice(0, 60), intents })
          })}>Continue</button></div>
          {birth && age != null && age < 13 && <p className="error" role="alert">VYBE is for people aged 13 and over.</p>}
        </section>
      )}

      {step === 1 && (
        <section aria-labelledby="o-h">
          <h1 id="o-h" className="t-display-sm">Add a profile photo</h1>
          <p className="t-support" style={{ margin: '8px 0 20px' }}>Friends find you faster with a face. You’ll be able to move and zoom it to fit the circle.</p>
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <Avatar size="lg" path={profile?.avatar_path} name={name || '?'} />
            <div style={{ marginTop: 12 }}><label className="btn"><Camera size={18} aria-hidden /> {profile?.avatar_path ? 'Change photo' : 'Choose a photo'}
              <input type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; const bad = checkAvatarFile(f); if (bad) toast(bad); else setCropping(f) }} /></label></div>
          </div>
          <Field id="bio" label="A line about you (optional)"><textarea id="bio" className="textarea" value={bio} maxLength={500} onChange={e => setBio(e.target.value)} /></Field>
          {err && <p className="error" role="alert">{err}</p>}
          <div className="onb-actions"><button className="btn ghost" onClick={() => setStep(0)}>Back</button><button className="btn primary" disabled={busy} onClick={() => next(() => updateProfile(uid!, { bio: bio.trim() }))}>{profile?.avatar_path ? 'Continue' : 'Skip for now'}</button></div>
        </section>
      )}

      {step === 2 && (
        <section aria-labelledby="o-h">
          <h1 id="o-h" className="t-display-sm">Where are you based?</h1>
          <p className="t-support" style={{ margin: '8px 0 20px' }}>We use your city to show plans near you. We only keep the city, never your exact position.</p>
          <button type="button" className="place-btn" onClick={() => setPicking(true)}><MapPin size={18} aria-hidden /><span className="grow"><span className="t-meta" style={{ display: 'block' }}>Your city</span><b>{city ? `${city.name}, ${city.country}` : 'Choose your city'}</b></span></button>
          {err && <p className="error" role="alert">{err}</p>}
          <div className="onb-actions"><button className="btn ghost" onClick={() => setStep(1)}>Back</button><button className="btn primary" disabled={busy} onClick={() => next(async () => {
            if (!city) return
            await updateProfile(uid!, { location: city.name, country: city.country, lat: city.lat, lng: city.lng })
            setPlace(city)
          })}>{city ? 'Continue' : 'Skip for now'}</button></div>
        </section>
      )}

      {step === 3 && (
        <section aria-labelledby="o-h">
          <h1 id="o-h" className="t-display-sm">What moves you?</h1>
          <p className="t-support" style={{ margin: '8px 0 20px' }}>Pick a few. We use these to suggest plans, communities and people, and you can change them any time.</p>
          <div className="chips big" role="group" aria-label="Interests">{INTERESTS.map(i => <button key={i} type="button" className="chip" aria-pressed={interests.includes(i)} onClick={() => setInterests(c => c.includes(i) ? c.filter(x => x !== i) : c.length < 20 ? [...c, i] : c)}>{i}</button>)}</div>
          {err && <p className="error" role="alert">{err}</p>}
          <div className="onb-actions"><button className="btn ghost" onClick={() => setStep(2)}>Back</button><button className="btn primary" disabled={busy} onClick={() => next(() => updateProfile(uid!, { interests }))}>{interests.length ? `Continue (${interests.length})` : 'Skip for now'}</button></div>
        </section>
      )}

      {step === 4 && (
        <section aria-labelledby="o-h">
          <h1 id="o-h" className="t-display-sm">Find your people</h1>
          <p className="t-support" style={{ margin: '8px 0 20px' }}>People and communities that match what you picked. Nothing is sent until you tap.</p>
          {people.loading ? <Spinner /> : (
            <>
              {people.data && people.data.people.length > 0 && <div className="list">{people.data.people.map(p => (
                <div key={p.id} className="item row"><Avatar path={p.avatar_path} name={p.display_name || p.username} /><div className="grow"><div className="t-name clamp-1">{p.display_name || p.username}</div><div className="t-meta clamp-1">{sharedInterests(interests, p.interests).slice(0, 3).join(' · ') || `@${p.username}`}</div></div>
                  <FriendButton other={p.id} rel={people.data?.rels.get(p.id)} onChanged={people.reload} /></div>))}</div>}
              {people.data && people.data.communities.length > 0 && <><h2 className="t-section" style={{ margin: '20px 0 4px' }}>Communities</h2><div className="list">{people.data.communities.map(c => <JoinRow key={c.id} c={c} joined={joined} />)}</div></>}
              {people.data && !people.data.people.length && !people.data.communities.length && <p className="t-support">No suggestions yet. You can find people any time from Friends and Discover.</p>}
            </>
          )}
          <div className="onb-actions"><button className="btn ghost" onClick={() => setStep(3)}>Back</button><button className="btn primary" disabled={busy} onClick={() => next(() => undefined)}>Continue</button></div>
        </section>
      )}

      {step === 5 && (
        <section aria-labelledby="o-h">
          <h1 id="o-h" className="t-display-sm">Your privacy, your call</h1>
          <p className="t-support" style={{ margin: '8px 0 20px' }}>Sensible defaults are already on. You can change any of this later in Settings.</p>
          <Field id="dm" label="Who can message you?" hint="Blocked people can never message you."><select id="dm" className="select" value={dm} onChange={e => setDm(e.target.value as 'friends' | 'everyone')}><option value="friends">Friends only (recommended)</option><option value="everyone">Anyone on VYBE</option></select></Field>
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 16px' }}>
            <legend className="t-section" style={{ margin: '8px 0' }}><Bell size={16} aria-hidden style={{ verticalAlign: '-2px' }} /> Notify me about</legend>
            {NOTIF.map(([k, label]) => <label key={k} className="row" style={{ minHeight: 44 }}><input type="checkbox" checked={prefs[k] !== false} onChange={e => setPrefs(p => ({ ...p, [k]: e.target.checked }))} /> <span>{label}</span></label>)}
          </fieldset>
          {err && <p className="error" role="alert">{err}</p>}
          <div className="onb-actions"><button className="btn ghost" onClick={() => setStep(4)}>Back</button><button className="btn primary" disabled={busy} onClick={() => next(() => updateProfile(uid!, { dm_policy: dm, notif_prefs: prefs }))}>Continue</button></div>
        </section>
      )}

      {step === 6 && (
        <section aria-labelledby="o-h" style={{ textAlign: 'center', padding: '24px 0' }}>
          <h1 id="o-h" className="t-display-sm">You’re all set{first ? `, ${first}` : ''}</h1>
          <p className="t-support" style={{ margin: '8px auto 24px', maxWidth: '34ch' }}>Your feed, plans near {city?.name ?? profile?.location ?? 'you'}, and your people are waiting.</p>
          {err && <p className="error" role="alert">{err}</p>}
          <div className="onb-actions" style={{ justifyContent: 'center' }}><button className="btn primary lg" disabled={busy} onClick={finish}>Go to VYBE</button></div>
        </section>
      )}

      {picking && <LocationPicker title="Your city" onPick={(p: Place | City) => { setCity(nearestCityFor(p)); setPicking(false) }} onClose={() => setPicking(false)} />}
      {cropping && <ImageCropper file={cropping} onCancel={() => setCropping(null)} onDone={async f => { setCropping(null); try { await saveAvatar(uid!, f, profile?.avatar_path); await refreshProfile(); toast('Photo saved') } catch (e) { toast(errMsg(e)) } }} />}
    </div>
  )
}

/** Profiles store the city centre, even when the picker returned an exact device position. */
const nearestCityFor = (p: Place | City): City => ('precise' in p && p.precise) || !('name' in p) ? nearestCity(p.lat, p.lng) : { name: p.name, country: p.country, lat: p.lat, lng: p.lng }

function JoinRow({ c, joined }: { c: Community; joined: Set<string> }) {
  const { uid } = useAuth()
  const [on, setOn] = useState(joined.has(c.id))
  const [busy, submit] = useSubmit()
  const join = () => submit(async () => {
    const { error } = await supabase.from('community_members').insert({ community_id: c.id, user_id: uid })
    if (error && error.code !== '23505') return toast(errMsg(error))
    joined.add(c.id); setOn(true)
  })
  return <div className="item row"><div className="grow"><div className="t-name clamp-1">{c.name}</div><div className="t-meta clamp-1">{c.description || c.topics.join(', ')}</div></div>{on ? <span className="t-meta">Joined</span> : <button className="btn primary sm" disabled={busy} onClick={join}>Join</button>}</div>
}
