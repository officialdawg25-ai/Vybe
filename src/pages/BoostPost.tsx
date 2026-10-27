import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Megaphone, ShieldCheck } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { supabase } from '../lib/supabase'
import { callFunction } from '../lib/functions'
import { fetchPosts } from '../lib/posts'
import { CITIES } from '../lib/cities'
import { INTERESTS } from '../lib/friends'
import { GOALS, SPONSORED_LABEL, isSecureLink, loadPackages, type AdInfo, type BoostPackage, type Goal } from '../lib/sponsor'
import { money, newIdempotencyKey, submitCheckout, type Checkout, type Provider } from '../lib/tickets'
import { useAsync } from '../lib/hooks'
import { PostCard } from '../components/PostCard'
import { Empty, ErrorState, Field, Spinner, errMsg } from '../ui'

/**
 * Boost a post: choose what you want people to do, who should see it and for how long, preview it exactly as members will see it
 * (with its "Sponsored" label), then pay. Nothing runs until the payment provider confirms and VYBE has reviewed it; the
 * price comes from the server, not from this page.
 */
export default function BoostPost() {
  const { postId } = useParams()
  const { uid, profile } = useAuth()
  const nav = useNavigate()
  const post = useAsync(async () => (await fetchPosts({ uid: uid!, ids: [postId!] }))[0] ?? null, [postId, uid])
  const pkgs = useAsync(loadPackages, [])
  const [goal, setGoal] = useState<Goal>('engage')
  const [label, setLabel] = useState(''), [url, setUrl] = useState('')
  const [audience, setAudience] = useState<'all' | 'city'>('all')
  const [city, setCity] = useState(''), [interests, setInterests] = useState<string[]>([])
  const [pkg, setPkg] = useState(''), [provider, setProvider] = useState<Provider>('payfast')
  const [agree, setAgree] = useState(false), [busy, setBusy] = useState(false), [err, setErr] = useState('')
  const [key, setKey] = useState(newIdempotencyKey)
  useEffect(() => { document.title = 'Boost post · VYBE' }, [])
  useEffect(() => { const c = profile?.location?.split(',')[0]?.trim(); if (c && !city) setCity(c) }, [profile?.location]) // eslint-disable-line react-hooks/exhaustive-deps
  const chosen: BoostPackage | undefined = pkgs.data?.find(p => p.id === pkg) ?? pkgs.data?.[1] ?? pkgs.data?.[0]
  const preview = useRef<HTMLDivElement>(null)
  useEffect(() => { preview.current?.setAttribute('inert', '') })        // the preview is for looking at, not for tapping

  if (post.loading) return <Spinner />
  if (post.error) return <ErrorState message={post.error} onRetry={post.reload} />
  const p = post.data
  if (!p || p.author !== uid && !p.organization_id) return <Empty title="Post not found">You can only boost your own posts.</Empty>
  const eligible = p.visibility === 'public' && !p.community_id
  const needsPlan = goal === 'plan' && !p.event_id
  const linkOk = goal !== 'link' || isSecureLink(url)
  const ready = eligible && Boolean(chosen) && linkOk && !needsPlan && agree && (audience === 'all' || city.trim().length >= 2)
  const ad: AdInfo = { id: 'preview', post_id: p.id, goal, cta_label: label.trim() || null, cta_url: goal === 'link' ? url.trim() : null, sponsor: p.author }

  const pay = async () => {
    if (!chosen || busy || !ready) return
    setBusy(true); setErr('')
    try {
      const { data, error } = await supabase.rpc('create_sponsor_order', {
        p_post: p.id, p_package: chosen.id, p_goal: goal, p_cta_label: label.trim() || null, p_cta_url: goal === 'link' ? url.trim() : null,
        p_city: audience === 'city' ? city.trim() : null, p_interests: interests, p_provider: provider, p_idem: key,
      })
      if (error) throw error
      const o = data as { id: string; status: string }
      if (o.status !== 'pending') { setKey(newIdempotencyKey()); throw new Error(`That order is already ${o.status}. Try again.`) }
      submitCheckout(await callFunction<Checkout>('pay-start', { order_id: o.id }))
    } catch (e) { setErr(errMsg(e)); setKey(newIdempotencyKey()); setBusy(false) }
  }

  return (
    <>
      <header className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <button className="icon-btn" aria-label="Back" onClick={() => nav(-1)}><ArrowLeft size={22} /></button>
        <h1 className="t-title">Boost post</h1>
      </header>
      {!eligible && <p className="notice err" role="alert">Only public posts can be boosted. Change who can see this post first, then come back.</p>}

      <section aria-labelledby="bp-prev" className="bp-sec">
        <h2 id="bp-prev" className="t-section">Preview</h2>
        <p className="t-meta">This is how members will see it. The “{SPONSORED_LABEL}” label is added by VYBE and can’t be removed.</p>
        <div className="bp-preview" ref={preview}><PostCard post={p} ad={ad} onChange={() => {}} onDeleted={() => {}} /></div>
      </section>

      <section aria-labelledby="bp-goal" className="bp-sec">
        <h2 id="bp-goal" className="t-section">What do you want people to do?</h2>
        <div className="stack" style={{ gap: 8 }} role="radiogroup" aria-labelledby="bp-goal">
          {GOALS.map(g => (
            <label key={g.id} className={`cp-opt${goal === g.id ? ' on' : ''}`}>
              <input type="radio" name="goal" checked={goal === g.id} onChange={() => setGoal(g.id)} style={{ accentColor: 'var(--brand)', width: 20, height: 20 }} />
              <span className="grow"><b>{g.title}</b><span className="t-meta" style={{ display: 'block' }}>{g.hint}</span></span>
            </label>))}
        </div>
        {goal === 'link' && (
          <div style={{ marginTop: 12 }}>
            <Field id="bp-url" label="Website link" hint="Must start with https://. Members leave VYBE when they tap it."><input id="bp-url" className="input" inputMode="url" autoCapitalize="none" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://" aria-invalid={url !== '' && !linkOk} /></Field>
            <Field id="bp-label" label="Button text" hint="Up to 24 characters. Leave empty for “Learn more”."><input id="bp-label" className="input" maxLength={24} value={label} onChange={e => setLabel(e.target.value)} /></Field>
          </div>)}
        {needsPlan && <p className="notice" role="status" style={{ marginTop: 12 }}>This post doesn’t have a plan attached. Choose another goal, or share a plan in a new post.</p>}
      </section>

      <section aria-labelledby="bp-aud" className="bp-sec">
        <h2 id="bp-aud" className="t-section">Who should see it?</h2>
        <div className="chips" role="group" aria-label="Audience">
          <button className="chip" aria-pressed={audience === 'all'} onClick={() => setAudience('all')}>Everyone on VYBE</button>
          <button className="chip" aria-pressed={audience === 'city'} onClick={() => setAudience('city')}>People in a city</button>
        </div>
        {audience === 'city' && (
          <div style={{ marginTop: 12 }}>
            <Field id="bp-city" label="City" hint="Matched with the city on members’ profiles."><input id="bp-city" className="input" list="bp-cities" value={city} onChange={e => setCity(e.target.value)} /></Field>
            <datalist id="bp-cities">{CITIES.map(c => <option key={c.name} value={c.name} />)}</datalist>
          </div>)}
        <div className="field" style={{ marginTop: 12 }}><span id="bp-int" style={{ fontWeight: 600, fontSize: '.875rem' }}>Interests (optional)</span>
          <div className="chips" role="group" aria-labelledby="bp-int">{INTERESTS.map(i => <button key={i} className="chip" aria-pressed={interests.includes(i)} onClick={() => setInterests(c => c.includes(i) ? c.filter(x => x !== i) : c.length < 10 ? [...c, i] : c)}>{i}</button>)}</div>
          <span className="hint">Only people who list at least one of these see it. You never see who they are.</span></div>
      </section>

      <section aria-labelledby="bp-len" className="bp-sec">
        <h2 id="bp-len" className="t-section">How long should it run?</h2>
        {pkgs.loading ? <Spinner /> : pkgs.error ? <ErrorState message={pkgs.error} onRetry={pkgs.reload} /> : !pkgs.data?.length ? <p className="t-support">Boosting isn’t available right now.</p> : (
          <div className="stack" style={{ gap: 8 }} role="radiogroup" aria-labelledby="bp-len">
            {pkgs.data.map(k => (
              <label key={k.id} className={`cp-opt${chosen?.id === k.id ? ' on' : ''}`}>
                <input type="radio" name="pkg" checked={chosen?.id === k.id} onChange={() => setPkg(k.id)} style={{ accentColor: 'var(--brand)', width: 20, height: 20 }} />
                <span className="grow"><b>{k.days} days</b><span className="t-meta" style={{ display: 'block' }}>{money(Math.round(k.price_cents / k.days))} a day</span></span><b>{money(k.price_cents)}</b>
              </label>))}
          </div>)}
      </section>

      <section aria-labelledby="bp-pay" className="bp-sec">
        <h2 id="bp-pay" className="t-section">Payment</h2>
        <div className="chips" role="group" aria-label="Payment method">{(['payfast', 'ozow'] as Provider[]).map(m => <button key={m} className="chip" aria-pressed={provider === m} onClick={() => setProvider(m)}>{m === 'payfast' ? 'PayFast (card, instant EFT)' : 'Ozow (instant EFT)'}</button>)}</div>
        <ul className="vf-list" style={{ marginTop: 12 }}>
          <li>You pay <b>once</b>{chosen ? <> — <b>{money(chosen.price_cents)}</b> for {chosen.days} days</> : ''}. It never renews by itself.</li>
          <li>VYBE <b>reviews</b> every boost before it runs, usually within a business day. If it isn’t approved, you’re refunded in full.</li>
          <li>It runs for the days you chose once approved. You can pause it (paused time is given back) or stop it any time; days already delivered aren’t refunded.</li>
          <li>You’ll see real insights: people reached, views and taps. Boosting shows your post to more people; it doesn’t guarantee a number of results.</li>
        </ul>
        <label className="row" style={{ alignItems: 'flex-start', gap: 10, margin: '12px 0' }}>
          <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ accentColor: 'var(--brand)', width: 20, height: 20, marginTop: 2 }} />
          <span>I confirm this post follows the <Link to="/privacy#ads" style={{ textDecoration: 'underline' }}>VYBE ad rules <ExternalLink size={12} aria-hidden /></Link>: it’s honest, I have the right to use everything in it, and it doesn’t promote anything illegal or harmful.</span>
        </label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary" style={{ width: '100%' }} disabled={busy || !ready} onClick={pay}><Megaphone size={18} aria-hidden /> {busy ? 'Opening payment…' : `Pay ${chosen ? money(chosen.price_cents) : ''}`}</button>
        <p className="t-meta" style={{ marginTop: 8 }}><ShieldCheck size={13} aria-hidden style={{ verticalAlign: '-2px' }} /> You’ll pay on the provider’s page. Your card or bank details never touch VYBE.</p>
      </section>
    </>
  )
}
