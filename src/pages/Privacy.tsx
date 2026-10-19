import { useEffect } from 'react'
import { Wordmark } from '../brand/Logo'
import { Link } from 'react-router-dom'

/** Plain-language summary of what the product does today. Not a legal document: it needs review by counsel before launch. */
export default function Privacy() {
  useEffect(() => { document.title = 'Privacy & safety · VYBE' }, [])
  return (
    <div className="pub" style={{ maxWidth: 680, paddingBottom: 64 }}>
      <header className="pub-nav"><Link to="/" aria-label="VYBE home"><Wordmark height={22} /></Link></header>
      <main>
      <h1 className="t-title" style={{ marginBottom: 8 }}>Privacy & safety</h1>
      <p className="notice" style={{ marginBottom: 24 }}>This is a plain-language summary of how VYBE works today. It is a draft and has not been reviewed as a legal policy.</p>
      <div className="stack" style={{ gap: 20 }}>
        <section><h2 className="t-section">What we store</h2><p className="t-support">Your email and password (handled by our authentication provider), the profile details you add, and what you create: posts, comments, reactions, saved items, plans and RSVPs, community membership, messages, and uploaded photos and videos.</p></section>
        <section><h2 className="t-section">Who can see it</h2><p className="t-support">Posts and plans are public, friends-only, or limited to a community or invite list, as you choose. Saved posts are private to you. Your email is never shown on your profile. Blocking someone hides you from each other and prevents messaging.</p></section>
        <section><h2 className="t-section">Messages</h2><p className="t-support">Messages are visible only to people in the conversation. They are stored on our servers and are not end-to-end encrypted. If a message is reported, a moderator can see that message.</p></section>
        <section><h2 className="t-section">Location</h2><p className="t-support">Location is an optional free-text city or area you type yourself. VYBE does not ask for precise device location or your address book.</p></section>
        <section><h2 className="t-section">Moderation</h2><p className="t-support">You can report people, posts, comments, plans, communities and streams. Moderators see only the reported item, and their actions are logged.</p></section>
        <section><h2 className="t-section">Your controls</h2><p className="t-support">In Settings you can edit your profile, choose who can message you, manage notifications, unblock people, export your data, and permanently delete your account.</p></section>
        <section><h2 className="t-section">Payments</h2><p className="t-support">VYBE does not process payments. Ticket links open external providers.</p></section>
      </div>
      </main>
    </div>
  )
}
