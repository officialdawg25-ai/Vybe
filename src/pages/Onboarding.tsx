import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useSubmit } from '../lib/hooks'
import { INTERESTS } from '../lib/friends'
import { Field, errMsg } from '../ui'

export default function Onboarding() {
  const { uid, profile, refreshProfile } = useAuth()
  const nav = useNavigate()
  const [name, setName] = useState(profile?.display_name ?? '')
  const [bio, setBio] = useState('')
  const [interests, setInterests] = useState<string[]>([])
  const [location, setLocation] = useState('')
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  useEffect(() => { document.title = 'Welcome · VYBE'; if (profile?.display_name) setName(n => n || profile.display_name) }, [profile])

  const finish = (skip: boolean) => submit(async () => {
    const patch = skip ? { onboarded_at: new Date().toISOString() }
      : { display_name: name.trim().slice(0, 60), bio: bio.trim(), interests, location: location.trim() || null, onboarded_at: new Date().toISOString() }
    const { error } = await supabase.from('profiles').update(patch).eq('id', uid!)
    if (error) return setErr(errMsg(error))
    await refreshProfile()
    nav('/app/friends', { replace: true })
  })

  return (
    <div style={{ maxWidth: 480 }}>
      <h1 className="t-title">Welcome to VYBE{profile ? `, @${profile.username}` : ''}</h1>
      <p className="t-support" style={{ margin: '8px 0 24px' }}>Tell us a little so we can suggest people and plans. Everything here is optional and can be changed later.</p>
      <Field id="dn" label="Display name"><input id="dn" className="input" value={name} onChange={e => setName(e.target.value)} maxLength={60} /></Field>
      <Field id="bio" label="Bio"><textarea id="bio" className="textarea" value={bio} onChange={e => setBio(e.target.value)} maxLength={500} /></Field>
      <Field id="loc" label="City or area" hint="Shown on your profile. We never ask for precise location."><input id="loc" className="input" value={location} onChange={e => setLocation(e.target.value)} maxLength={120} /></Field>
      <div className="field"><span id="int" style={{ fontWeight: 600, fontSize: '.875rem' }}>What moves you?</span>
        <div className="chips" role="group" aria-labelledby="int">
          {INTERESTS.map(i => <button key={i} type="button" className="chip" aria-pressed={interests.includes(i)} onClick={() => setInterests(c => c.includes(i) ? c.filter(x => x !== i) : c.length < 20 ? [...c, i] : c)}>{i}</button>)}
        </div>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={busy} onClick={() => finish(false)}>Continue</button>
        <button className="btn ghost" disabled={busy} onClick={() => finish(true)}>Skip for now</button>
      </div>
    </div>
  )
}
