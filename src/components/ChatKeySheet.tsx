import { useState } from 'react'
import { KeyRound, Lock, ShieldCheck } from 'lucide-react'
import { Field, Sheet, errMsg } from '../ui'
import { MIN_PASSPHRASE, type ChatKeys } from '../lib/chatKeys'

/** Turn on secure chat (choose a passphrase) or unlock it on a new device (enter the passphrase). */
export function ChatKeySheet({ keys, onClose }: { keys: ChatKeys; onClose: () => void }) {
  const restoring = keys.state === 'restore'
  const [startOver, setStartOver] = useState(false)
  const mode: 'setup' | 'restore' = restoring && !startOver ? 'restore' : 'setup'
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setErr('')
    if (mode === 'setup') {
      if (pass.length < MIN_PASSPHRASE) return setErr(`Use at least ${MIN_PASSPHRASE} characters. A few random words works well.`)
      if (pass !== again) return setErr('The two passphrases do not match.')
    } else if (!pass) return setErr('Enter your chat passphrase.')
    setBusy(true)
    try { await (mode === 'setup' ? keys.setup(pass) : keys.restore(pass)); onClose() } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <Sheet title={mode === 'setup' ? (startOver ? 'Start over with new keys' : 'Turn on secure chat') : 'Unlock your secure chats'} onClose={onClose}>
      <form className="stack" style={{ gap: 12 }} onSubmit={e => { e.preventDefault(); void submit() }}>
        <p className="e2-lead"><ShieldCheck size={20} aria-hidden /> {mode === 'setup'
          ? 'Your messages, photos, videos, files and voice notes are locked on your phone before they are sent. Only you and the person you are chatting with can open them — not even VYBE.'
          : 'Enter the chat passphrase you chose. It unlocks your secure chats on this device.'}</p>
        <Field id="e2-pass" label={mode === 'setup' ? 'Choose a chat passphrase' : 'Chat passphrase'} hint={mode === 'setup' ? `At least ${MIN_PASSPHRASE} characters. It is separate from your sign-in password.` : undefined}>
          <input id="e2-pass" className="input" type="password" autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} autoFocus value={pass} onChange={e => setPass(e.target.value)} />
        </Field>
        {mode === 'setup' && <Field id="e2-again" label="Type it again"><input id="e2-again" className="input" type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} /></Field>}
        {mode === 'setup' && (
          <p className="e2-warn"><KeyRound size={18} aria-hidden /> VYBE cannot reset or recover this passphrase. If you forget it you can start over, but older secure messages will stay locked.{startOver && ' Starting over replaces your old keys.'}</p>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary grow" type="submit" disabled={busy}><Lock size={16} aria-hidden /> {busy ? 'Working…' : mode === 'setup' ? 'Turn on secure chat' : 'Unlock'}</button>
          <button className="btn ghost" type="button" onClick={onClose}>Not now</button>
        </div>
        {mode === 'restore' && <button className="linklike" type="button" onClick={() => { setStartOver(true); setPass(''); setErr('') }}>I forgot my passphrase — start over</button>}
      </form>
    </Sheet>
  )
}
