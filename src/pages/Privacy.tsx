import { useEffect } from 'react'
import { Lockup } from '../brand/Logo'
import { Link } from 'react-router-dom'

/** Plain-language summary of what the product does today. Not a legal document: it needs review by counsel before launch. */
export default function Privacy() {
  useEffect(() => { document.title = 'Privacy & safety · VYBE'; if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView() }, [])
  return (
    <div className="pub" style={{ maxWidth: 680, paddingBottom: 64 }}>
      <header className="pub-nav"><Link to="/" aria-label="VYBE home"><Lockup height={18} /></Link></header>
      <main>
      <h1 className="t-title" style={{ marginBottom: 8 }}>Privacy & safety</h1>
      <p className="notice" style={{ marginBottom: 24 }}>This is a plain-language summary of how VYBE works today. It is a draft and has not been reviewed as a legal policy.</p>
      <div className="stack" style={{ gap: 20 }}>
        <section><h2 className="t-section">What we store</h2><p className="t-support">Your email and password (handled by our authentication provider), the profile details you add, and what you create: posts, comments, reactions, saved items, plans and RSVPs, community membership, messages, and uploaded photos and videos.</p></section>
        <section><h2 className="t-section">Who can see it</h2><p className="t-support">Posts and plans are public, friends-only, or limited to a community or invite list, as you choose. Saved posts are private to you. Your email is never shown on your profile. Blocking someone hides you from each other and prevents messaging.</p></section>
        <section><h2 className="t-section">Messages</h2><p className="t-support">Messages are visible only to people in the conversation. They are stored on our servers and are not end-to-end encrypted. If a message is reported, a moderator can see that message.</p></section>
        <section id="ads"><h2 className="t-section">Sponsored posts and ad rules</h2><p className="t-support">Members and organisations can pay to boost a public post. Boosted posts are always labelled “Sponsored”, are reviewed by VYBE before they run, and are shown only to the audience the sponsor chose (a city and/or interests, matched with what is on a member’s profile; sponsors never see who members are). You can hide any ad, ask “Why am I seeing this?”, or report it from the ⋯ menu. Ads must be honest and lawful, must not use anyone’s content without the right to, and must not promote anything harmful. VYBE can refuse or remove a boost; a boost that is not approved is refunded in full. Payments are handled by the payment provider; VYBE never sees card or bank details.</p></section>
        <section><h2 className="t-section">Location</h2><p className="t-support">Your place is a city you pick, or one you share by tapping “Live location” in Discover. Live location uses your device’s location only when you tap it, to show what is near you. It is kept on this device, is not shown to other members, and is not saved to your profile unless you add a location there yourself. Searches that sort by distance send the place to our servers with the request, and it is not stored.</p></section>
        <section><h2 className="t-section">Moderation</h2><p className="t-support">You can report people, posts, comments, plans, communities and streams. Moderators see only the reported item, and their actions are logged.</p></section>
        <section><h2 className="t-section">Your controls</h2><p className="t-support">In Settings you can edit your profile, choose who can message you, manage notifications, unblock people, export your data, and permanently delete your account.</p></section>
        <section><h2 className="t-section">Payments</h2><p className="t-support">Tickets, VYBE Verified and sponsored boosts are paid on the checkout page of our payment providers (PayFast or Ozow); VYBE never sees or stores your card or bank details. We keep the order, the amount, its status and the receipt. A payment only counts once the provider confirms it to our servers with a signed notification that matches the amount we asked for.</p></section>
        <section><h2 className="t-section">Credits</h2><p className="t-support">Animated emoji: Noto Emoji Animation by Google, licensed under CC BY 4.0 (resized and re-encoded for VYBE).</p></section>
      </div>
      </main>
    </div>
  )
}
