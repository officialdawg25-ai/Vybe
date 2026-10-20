import { Briefcase, Cake, Globe2, GraduationCap, Heart, Home, Languages, Link2, MapPin, Phone, Plane, Sparkles, AtSign } from 'lucide-react'
import { RELATIONSHIPS, type ViewDetails } from '../lib/social'

const Row = ({ icon: Icon, children }: { icon: typeof Home; children: React.ReactNode }) => <li className="pd-row"><Icon size={20} aria-hidden /><span>{children}</span></li>

/** The dedicated "Details" section of a profile. Only sections the viewer is allowed to see arrive from the server, so this just renders what it is given. */
export function DetailsCard({ d, interests, empty }: { d: ViewDetails | null; interests: string[]; empty?: string }) {
  const p = d?.personal
  const personal = p && [p.current_city && ['city', <>Lives in <b>{p.current_city}</b></>, MapPin], p.hometown && ['home', <>From <b>{p.hometown}</b></>, Home], p.birthday && ['bday', <>Born <b>{p.birthday}</b></>, Cake],
    p.relationship && ['rel', <b>{RELATIONSHIPS[p.relationship] ?? p.relationship}</b>, Heart], p.languages?.length ? ['lang', <>Speaks <b>{p.languages.join(', ')}</b></>, Languages] : null].filter(Boolean) as [string, React.ReactNode, typeof Home][]
  const c = d?.contact
  const contact = c && [c.social && ['social', <>{c.social}</>, AtSign], c.phone && ['phone', <>{c.phone}</>, Phone], c.email && ['email', <>{c.email}</>, AtSign]].filter(Boolean) as [string, React.ReactNode, typeof Home][]
  const any = Boolean(d?.about || personal?.length || d?.work?.length || d?.education?.length || d?.hobbies?.length || d?.travel?.length || d?.links?.length || contact?.length)
  return (
    <>
      <section className="card pd" aria-labelledby="pd-h">
        <h2 id="pd-h" className="t-section">Details</h2>
        {d?.about && <p className="pd-about">{d.about}</p>}
        {personal && personal.length > 0 && <ul className="pd-list" aria-label="Personal details">{personal.map(([k, node, Ico]) => <Row key={k} icon={Ico}>{node}</Row>)}</ul>}
        {d?.work && d.work.length > 0 && <ul className="pd-list" aria-label="Work">{d.work.map((w, i) => <Row key={i} icon={Briefcase}>{w.role ? <>{w.role} at <b>{w.employer}</b></> : <>Works at <b>{w.employer}</b></>}</Row>)}</ul>}
        {d?.education && d.education.length > 0 && <ul className="pd-list" aria-label="Education">{d.education.map((e, i) => <Row key={i} icon={GraduationCap}>Studied {e.field ? <>{e.field} at </> : 'at '}<b>{e.school}</b></Row>)}</ul>}
        {d?.travel && d.travel.length > 0 && <ul className="pd-list" aria-label="Travel"><Row icon={Plane}>Has been to <b>{d.travel.join(', ')}</b></Row></ul>}
        {d?.links && d.links.length > 0 && <ul className="pd-list" aria-label="Links">{d.links.map((l, i) => <Row key={i} icon={Link2}><a href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc">{l.label || l.url.replace(/^https:\/\//, '')}</a></Row>)}</ul>}
        {contact && contact.length > 0 && <ul className="pd-list" aria-label="Contact info">{contact.map(([k, node, Ico]) => <Row key={k} icon={Ico}>{node}</Row>)}</ul>}
        {!any && <p className="t-support">{empty ?? 'Nothing to show yet.'}</p>}
      </section>
      {d?.hobbies && d.hobbies.length > 0 && (
        <section className="card" aria-labelledby="pd-hob"><h2 id="pd-hob" className="t-section" style={{ marginBottom: 8 }}><Sparkles size={16} aria-hidden style={{ verticalAlign: '-2px' }} /> Hobbies</h2><div className="chips">{d.hobbies.map(h => <span key={h} className="chip static">{h}</span>)}</div></section>
      )}
      {interests.length > 0 && (
        <section className="card" aria-labelledby="pd-int"><h2 id="pd-int" className="t-section" style={{ marginBottom: 8 }}><Globe2 size={16} aria-hidden style={{ verticalAlign: '-2px' }} /> Interests</h2><div className="chips">{interests.map(i => <span key={i} className="chip on" style={{ cursor: 'default' }}>{i}</span>)}</div></section>
      )}
    </>
  )
}
