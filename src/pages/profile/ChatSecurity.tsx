import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, KeyRound, Lock, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { useAsync } from '../../lib/hooks'
import { MIN_PASSPHRASE, cancelRecovery, changePassphrase, disableEscrow, enableEscrow, escrowAvailable, newRecoveryKeyFor, refreshChatKeys, securityInfo, useChatKeys } from '../../lib/chatKeys'
import { ChatKeySheet, RecoveryKeyScreen } from '../../components/ChatKeySheet'
import { Empty, ErrorState, Field, Sheet, Spinner, errMsg, toast } from '../../ui'
import { timeAgo } from '../../lib/format'

const EVENT_TEXT: Record<string, string> = {
  create: 'Secure chat was turned on', rotate: 'Your chat keys were replaced (start over)', recovery_key: 'A new recovery key was issued', passphrase: 'Your chat passphrase was changed',
  escrow_on: 'VYBE-assisted recovery was turned on', escrow_off: 'VYBE-assisted recovery was turned off', recovery_requested: 'A recovery was requested',
  recovery_cancelled: 'A recovery was cancelled', recovery_completed: 'A recovery was completed', recovery_failed: 'A wrong password was entered during recovery',
}

type Dialog = null | 'recovery' | 'passphrase' | 'escrow-on' | 'reset'

/** Chat security: recovery key, passphrase, opt-in VYBE-assisted recovery, and the account's security activity. */
export default function ChatSecurity() {
  const { uid } = useAuth()
  const keys = useChatKeys()
  const [dlg, setDlg] = useState<Dialog>(null)
  const [shown, setShown] = useState<string | null>(null)
  useEffect(() => { document.title = 'Chat security · VYBE' }, [])
  const info = useAsync(() => (uid ? securityInfo(uid) : Promise.resolve(null)), [uid, keys.state, keys.version])
  const vybe = useAsync(() => escrowAvailable(), [])
  const waiting = info.data?.request?.status === 'waiting' ? info.data.request : null
  const reload = () => { info.reload(); refreshChatKeys() }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row" style={{ gap: 8 }}><Link className="icon-btn" to="/app/settings" aria-label="Back to settings"><ArrowLeft size={22} /></Link><h1 className="t-display-sm">Chat security</h1></div>

      {waiting && (
        <div className="notice err" role="alert">
          <b><ShieldAlert size={16} aria-hidden /> A recovery of your chat key was requested.</b>
          <p style={{ margin: '6px 0' }}>It can be completed after {new Date(waiting.ready_at).toLocaleString()}. If this was not you, cancel it now and change your account password.</p>
          <button className="btn danger" onClick={async () => { try { await cancelRecovery(waiting.id); toast('Recovery cancelled'); reload() } catch (e) { toast(errMsg(e)) } }}>This wasn’t me — cancel</button>
        </div>
      )}

      <section className="card" aria-labelledby="cs-status">
        <h2 id="cs-status" className="t-section"><ShieldCheck size={18} aria-hidden /> Secure chat</h2>
        {keys.state === 'loading' ? <Spinner /> : keys.state === 'unsupported' ? (
          <p className="t-support">Secure chat is not available in this browser or on this server yet.</p>
        ) : keys.state === 'ready' ? (
          <p className="t-support">On. Your one-to-one and group chats are end-to-end encrypted on this device. VYBE cannot read them.</p>
        ) : (
          <><p className="t-support">{keys.state === 'restore' ? 'Secure chat is set up on your account but locked on this device.' : 'Secure chat is not turned on yet.'}</p><button className="btn primary" onClick={() => setDlg('reset')}><Lock size={16} aria-hidden /> {keys.state === 'restore' ? 'Unlock' : 'Turn on'}</button></>
        )}
      </section>

      {keys.state === 'ready' && (
        <>
          <section className="card" aria-labelledby="cs-rec">
            <h2 id="cs-rec" className="t-section"><KeyRound size={18} aria-hidden /> Recovery key &amp; passphrase</h2>
            <p className="t-support" style={{ margin: '6px 0 12px' }}>{info.data?.hasRecoveryKey ? 'You have a recovery key on file.' : 'No recovery key yet.'} Either one unlocks your chats on a new device. VYBE can never show them to you again.</p>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button className="btn" onClick={() => setDlg('recovery')}>Get a new recovery key</button>
              <button className="btn" onClick={() => setDlg('passphrase')}>Change passphrase</button>
            </div>
          </section>

          <section className="card" aria-labelledby="cs-vybe">
            <h2 id="cs-vybe" className="t-section"><ShieldAlert size={18} aria-hidden /> VYBE-assisted recovery</h2>
            {vybe.loading ? <Spinner /> : !vybe.data ? <p className="t-support" style={{ marginTop: 6 }}>Not available on this server.</p> : (
              <>
                <p className="t-support" style={{ margin: '6px 0 12px' }}>
                  {info.data?.escrow
                    ? 'On. If you lose your passphrase and recovery key, VYBE can release your chat key after a waiting period (72 hours by default) and your account password. We alert all your devices and you can cancel any time.'
                    : 'Off. Chats stay strictly end-to-end encrypted: nobody, including VYBE, can recover your key.'}
                </p>
                <p className="e2-warn" style={{ marginBottom: 12 }}><ShieldAlert size={18} aria-hidden /> Turning this on gives VYBE’s systems a sealed copy of your chat key. Anyone who broke into both our database and our server secrets could open it, so your chats would no longer be end-to-end encrypted in the strictest sense. Leave it off if you prefer maximum privacy.</p>
                {info.data?.escrow
                  ? <button className="btn" onClick={async () => { if (!confirm('Turn off VYBE-assisted recovery? The stored copy is deleted.')) return; try { await disableEscrow(); toast('VYBE-assisted recovery is off'); reload() } catch (e) { toast(errMsg(e)) } }}>Turn off</button>
                  : <button className="btn" onClick={() => setDlg('escrow-on')}>Turn on…</button>}
              </>
            )}
          </section>
        </>
      )}

      <section aria-labelledby="cs-act">
        <h2 id="cs-act" className="t-section" style={{ marginBottom: 8 }}>Security activity</h2>
        {info.loading ? <Spinner /> : info.error ? <ErrorState message={info.error} onRetry={info.reload} /> : !info.data?.events.length ? <Empty title="Nothing yet">Changes to your chat keys and recovery settings appear here.</Empty> : (
          <ul className="list" style={{ listStyle: 'none', padding: 0 }}>{info.data.events.map(e => (
            <li key={e.id} className="item row"><span className="grow"><span className="t-name" style={{ display: 'block' }}>{EVENT_TEXT[e.action] ?? e.action}</span><span className="t-meta">{timeAgo(e.created_at)} · {new Date(e.created_at).toLocaleString()}</span></span></li>
          ))}</ul>
        )}
        <p className="t-meta" style={{ marginTop: 8 }}>Don’t recognise something? Change your account password, cancel any recovery above, and use “start over” below.</p>
      </section>

      {keys.state !== 'loading' && keys.state !== 'unsupported' && (
        <section aria-labelledby="cs-reset">
          <h2 id="cs-reset" className="t-section" style={{ marginBottom: 8 }}>Start over</h2>
          <p className="t-support" style={{ marginBottom: 8 }}>Creates new keys and a new passphrase. Your older secure messages stay locked and your contacts will see a security-code change.</p>
          <button className="btn danger" onClick={() => setDlg('reset')}>Start over with new keys</button>
        </section>
      )}

      {dlg === 'reset' && <ChatKeySheet keys={{ ...keys, state: keys.state === 'ready' ? 'setup' : keys.state }} onClose={() => { setDlg(null); reload() }} />}
      {(dlg === 'recovery' || dlg === 'passphrase' || dlg === 'escrow-on') && uid && <PassphraseDialog kind={dlg} uid={uid} onClose={() => { setDlg(null); reload() }} onShow={setShown} />}
      {shown && <Sheet title="Save your recovery key" onClose={() => {}}><RecoveryKeyScreen recoveryKey={shown} onDone={() => { setShown(null); reload() }} /></Sheet>}
    </div>
  )
}

function PassphraseDialog({ kind, uid, onClose, onShow }: { kind: 'recovery' | 'passphrase' | 'escrow-on'; uid: string; onClose: () => void; onShow: (k: string) => void }) {
  const [pass, setPass] = useState(''), [next, setNext] = useState(''), [again, setAgain] = useState(''), [ok, setOk] = useState(false)
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  const title = kind === 'recovery' ? 'Get a new recovery key' : kind === 'passphrase' ? 'Change your passphrase' : 'Turn on VYBE-assisted recovery'
  const submit = async () => {
    setErr(''); setBusy(true)
    try {
      if (kind === 'passphrase') { if (next.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters.`); if (next !== again) throw new Error('The two passphrases do not match.') }
      if (kind === 'escrow-on' && !ok) throw new Error('Tick the box to confirm you understand.')
      if (kind === 'recovery') onShow(await newRecoveryKeyFor(uid, pass))
      else if (kind === 'passphrase') onShow(await changePassphrase(uid, pass, next))
      else { await enableEscrow(uid, pass); toast('VYBE-assisted recovery is on') }
      onClose()
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <Sheet title={title} onClose={onClose}>
      <form className="stack" style={{ gap: 12 }} onSubmit={e => { e.preventDefault(); void submit() }}>
        <p className="t-support">Confirm with your current chat passphrase.{kind === 'passphrase' && ' You will also get a new recovery key; the old one stops working.'}{kind === 'recovery' && ' The old recovery key stops working.'}</p>
        <Field id="cs-pass" label="Current chat passphrase"><input id="cs-pass" className="input" type="password" autoComplete="current-password" autoFocus value={pass} onChange={e => setPass(e.target.value)} /></Field>
        {kind === 'passphrase' && <>
          <Field id="cs-new" label="New passphrase" hint={`At least ${MIN_PASSPHRASE} characters.`}><input id="cs-new" className="input" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></Field>
          <Field id="cs-again" label="Type it again"><input id="cs-again" className="input" type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} /></Field>
        </>}
        {kind === 'escrow-on' && <label className="row" style={{ gap: 10, alignItems: 'flex-start' }}><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} style={{ marginTop: 4 }} /> <span>I understand VYBE will hold a sealed copy of my chat key and that this is not strict end-to-end encryption.</span></label>}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row" style={{ gap: 8 }}><button className="btn primary grow" type="submit" disabled={busy || !pass}>{busy ? 'Working…' : 'Continue'}</button><button className="btn ghost" type="button" onClick={onClose}>Cancel</button></div>
      </form>
    </Sheet>
  )
}
