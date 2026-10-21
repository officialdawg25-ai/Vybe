import { useEffect, useState } from 'react'
import { Check, Copy, Download, KeyRound, Lock, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Field, Sheet, Spinner, errMsg, toast } from '../ui'
import { useAuth } from '../auth/AuthProvider'
import { MIN_PASSPHRASE, cancelRecovery, escrowAvailable, requestVybeRecovery, securityInfo, type ChatKeys, type SecurityInfo } from '../lib/chatKeys'

/** Shows a recovery key once, makes the member confirm they saved it, and lets them copy or download it. */
export function RecoveryKeyScreen({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false)
  const copy = async () => { try { await navigator.clipboard.writeText(recoveryKey); toast('Recovery key copied') } catch { toast('Could not copy. Write it down instead.') } }
  const download = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([`VYBE secure chat recovery key\n\n${recoveryKey}\n\nKeep this somewhere safe and private. Anyone with it (and access to your account) can unlock your secure chats. VYBE cannot show it again.\n`], { type: 'text/plain' }))
    a.download = 'vybe-recovery-key.txt'; a.click(); URL.revokeObjectURL(a.href)
  }
  return (
    <div className="stack" style={{ gap: 12 }}>
      <p className="e2-lead"><KeyRound size={20} aria-hidden /> This is your recovery key. If you ever forget your chat passphrase, it unlocks your secure chats again.</p>
      <p className="e2-code" aria-label="Recovery key">{recoveryKey}</p>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn grow" type="button" onClick={copy}><Copy size={16} aria-hidden /> Copy</button>
        <button className="btn grow" type="button" onClick={download}><Download size={16} aria-hidden /> Save file</button>
      </div>
      <p className="e2-warn"><ShieldAlert size={18} aria-hidden /> VYBE cannot show this key again. Store it somewhere private — a password manager or a printed copy. Anyone who has it can unlock your chats.</p>
      <label className="row" style={{ gap: 10, alignItems: 'flex-start' }}><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} style={{ marginTop: 4 }} /> <span>I have saved my recovery key somewhere safe.</span></label>
      <button className="btn primary" type="button" disabled={!saved} onClick={onDone}><Check size={16} aria-hidden /> Done</button>
    </div>
  )
}

type Way = 'passphrase' | 'recovery' | 'vybe'

/** Turn on secure chat (choose a passphrase) or unlock it on a new device: with the passphrase, the recovery key, or VYBE-assisted recovery. */
export function ChatKeySheet({ keys, onClose }: { keys: ChatKeys; onClose: () => void }) {
  const { uid } = useAuth()
  const restoring = keys.state === 'restore'
  const [startOver, setStartOver] = useState(false)
  const mode: 'setup' | 'restore' = restoring && !startOver ? 'restore' : 'setup'
  const [way, setWay] = useState<Way>('passphrase')
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [rk, setRk] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<string | null>(null)     // a recovery key to show once
  const [info, setInfo] = useState<{ sec: SecurityInfo | null; vybe: boolean } | null>(null)

  useEffect(() => {
    if (mode !== 'restore' || !uid) return
    let live = true
    Promise.all([securityInfo(uid).catch(() => null), escrowAvailable()]).then(([sec, vybe]) => { if (live) setInfo({ sec, vybe }) })
    return () => { live = false }
  }, [mode, uid])
  const sec = info?.sec ?? null
  const vybeOn = Boolean(info?.vybe && sec?.escrow)
  const waiting = sec?.request?.status === 'waiting' ? sec.request : null
  const ready = Boolean(waiting && new Date(waiting.ready_at).getTime() <= Date.now())

  const run = async (f: () => Promise<void>) => { setErr(''); setBusy(true); try { await f() } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) } }
  const checkNew = () => { if (pass.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters. A few random words works well.`); if (pass !== again) throw new Error('The two passphrases do not match.') }

  const submit = () => run(async () => {
    if (mode === 'setup') { checkNew(); setShown(await keys.setup(pass)); return }
    if (way === 'passphrase') { if (!pass) throw new Error('Enter your chat passphrase.'); await keys.restore(pass); onClose(); return }
    if (way === 'recovery') { if (!rk.trim()) throw new Error('Enter your recovery key.'); checkNew(); setShown(await keys.restoreWithRecovery(rk, pass)); return }
    // VYBE-assisted
    if (!pw) throw new Error('Enter your VYBE account password.')
    if (!waiting) { await requestVybeRecovery(pw); setPw(''); setInfo({ ...info!, sec: await securityInfo(uid!) }); return }
    if (!ready) throw new Error('The waiting period is not over yet.')
    checkNew(); setShown(await keys.finishVybeRecovery(waiting.id, pw, pass))
  })

  const title = shown ? 'Save your recovery key' : mode === 'setup' ? (startOver ? 'Start over with new keys' : 'Turn on secure chat') : 'Unlock your secure chats'
  const closeSheet = () => { if (!shown) onClose() }                       // the recovery key must be acknowledged first

  return (
    <Sheet title={title} onClose={closeSheet}>
      {shown ? <RecoveryKeyScreen recoveryKey={shown} onDone={onClose} /> : (
        <form className="stack" style={{ gap: 12 }} onSubmit={e => { e.preventDefault(); void submit() }}>
          <p className="e2-lead"><ShieldCheck size={20} aria-hidden /> {mode === 'setup'
            ? 'Your messages, photos, videos, files and voice notes are locked on your phone before they are sent. Only you and the people you are chatting with can open them — not even VYBE.'
            : 'Unlock your secure chats on this device.'}</p>

          {mode === 'restore' && (
            <div className="cp-tabs e2-tabs" role="tablist" aria-label="How to unlock">
              <button type="button" role="tab" aria-selected={way === 'passphrase'} className={`cp-tab${way === 'passphrase' ? ' on' : ''}`} onClick={() => { setWay('passphrase'); setErr('') }}>Passphrase</button>
              <button type="button" role="tab" aria-selected={way === 'recovery'} className={`cp-tab${way === 'recovery' ? ' on' : ''}`} onClick={() => { setWay('recovery'); setErr('') }}>Recovery key</button>
              {vybeOn && <button type="button" role="tab" aria-selected={way === 'vybe'} className={`cp-tab${way === 'vybe' ? ' on' : ''}`} onClick={() => { setWay('vybe'); setErr('') }}>Ask VYBE</button>}
            </div>
          )}

          {mode === 'restore' && way === 'recovery' && (
            <Field id="e2-rk" label="Recovery key" hint="The 32-character key you saved when you turned on secure chat."><input id="e2-rk" className="input" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={rk} onChange={e => setRk(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" /></Field>
          )}

          {mode === 'restore' && way === 'vybe' && (
            <div className="stack" style={{ gap: 10 }}>
              {!info ? <Spinner /> : waiting ? (
                <p className="e2-warn"><ShieldAlert size={18} aria-hidden /> {ready ? 'Your waiting period is over. Enter your account password and choose a new chat passphrase to finish.' : `Recovery requested. For your safety it can be completed after ${new Date(waiting.ready_at).toLocaleString()}. We alerted your other devices; if this was not you, cancel it.`}</p>
              ) : (
                <p className="e2-warn"><ShieldAlert size={18} aria-hidden /> VYBE will release your chat key after a waiting period (usually 72 hours) and your account password. We alert all your devices and you can cancel at any time.</p>
              )}
              <Field id="e2-pw" label="Your VYBE account password"><input id="e2-pw" className="input" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
            </div>
          )}

          {(mode === 'setup' || way === 'passphrase' || way === 'recovery' || (way === 'vybe' && ready)) && (
            <>
              <Field id="e2-pass" label={mode === 'setup' || way !== 'passphrase' ? (mode === 'setup' ? 'Choose a chat passphrase' : 'Choose a new chat passphrase') : 'Chat passphrase'}
                hint={mode === 'setup' || way !== 'passphrase' ? `At least ${MIN_PASSPHRASE} characters. It is separate from your sign-in password.` : undefined}>
                <input id="e2-pass" className="input" type="password" autoComplete={mode === 'setup' || way !== 'passphrase' ? 'new-password' : 'current-password'} autoFocus={way === 'passphrase'} value={pass} onChange={e => setPass(e.target.value)} />
              </Field>
              {(mode === 'setup' || way !== 'passphrase') && <Field id="e2-again" label="Type it again"><input id="e2-again" className="input" type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} /></Field>}
            </>
          )}

          {mode === 'setup' && (
            <p className="e2-warn"><KeyRound size={18} aria-hidden /> You will get a recovery key next. {startOver ? 'Starting over replaces your old keys; older secure messages stay locked.' : 'Keep it safe — it is how you get back in if you forget this passphrase.'}</p>
          )}
          {err && <p className="error" role="alert">{err}</p>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary grow" type="submit" disabled={busy}>
              <Lock size={16} aria-hidden /> {busy ? 'Working…' : mode === 'setup' ? 'Turn on secure chat' : way === 'vybe' ? (waiting ? (ready ? 'Finish recovery' : 'Waiting…') : 'Request recovery') : 'Unlock'}
            </button>
            <button className="btn ghost" type="button" onClick={onClose}>Not now</button>
          </div>
          {mode === 'restore' && waiting && way === 'vybe' && <button className="linklike" type="button" onClick={() => run(async () => { await cancelRecovery(waiting.id); setInfo({ ...info!, sec: await securityInfo(uid!) }) })}>Cancel this recovery</button>}
          {mode === 'restore' && <button className="linklike" type="button" onClick={() => { setStartOver(true); setPass(''); setAgain(''); setErr('') }}>I can’t use any of these — start over</button>}
        </form>
      )}
    </Sheet>
  )
}
