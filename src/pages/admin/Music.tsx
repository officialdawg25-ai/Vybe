import { useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { putObject } from '../../lib/media'
import { useAsync } from '../../lib/hooks'
import { brandUrl } from '../../lib/social'
import { ErrorState, Field, Spinner, errMsg } from '../../ui'

interface Track { id: string; title: string; artist: string; artwork_path: string | null; preview_path: string | null; external_url: string | null; genre: string | null; active: boolean }
const IMG: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const AUD: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' }

/** Admin → Music: the VYBE song library. Only add music you have the rights to share: previews are public files. */
export default function AdminMusic() {
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('music_tracks').select('id,title,artist,artwork_path,preview_path,external_url,genre,active').order('created_at', { ascending: false }).limit(200)
    if (error) throw error
    return (data ?? []) as Track[]
  }, [])
  const [f, setF] = useState({ title: '', artist: '', url: '', genre: '', length: '' })
  const [art, setArt] = useState<File | null>(null), [aud, setAud] = useState<File | null>(null)
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const artIn = useRef<HTMLInputElement>(null), audIn = useRef<HTMLInputElement>(null)

  const up = async (file: File | null, map: Record<string, string>, max: number) => {
    if (!file) return null
    const ext = map[file.type]
    if (!ext) throw new Error(`Unsupported file type: ${file.type || 'unknown'}.`)
    if (file.size > max) throw new Error(`${file.name} is larger than ${max / 1024 / 1024} MB.`)
    const path = `music/${crypto.randomUUID()}.${ext}`
    try { await putObject('brand', path, file, file.type) } catch (e) { throw new Error(`Upload failed: ${(e as Error).message}`) }
    return path
  }
  const add = async () => {
    if (busy) return
    setBusy(true); setMsg(null)
    const made: string[] = []
    try {
      if (!f.title.trim() || !f.artist.trim()) throw new Error('Add the song title and the artist.')
      if (f.url.trim() && !/^https:\/\/\S+$/i.test(f.url.trim())) throw new Error('The link must start with https://')
      const artwork = await up(art, IMG, 5 * 1024 * 1024); if (artwork) made.push(artwork)
      const preview = await up(aud, AUD, 8 * 1024 * 1024); if (preview) made.push(preview)
      const m = f.length.trim().match(/^(\d{1,2}):([0-5]\d)$/)
      if (f.length.trim() && !m) throw new Error('Write the length as minutes:seconds, for example 3:18.')
      const row: Record<string, unknown> = { title: f.title.trim(), artist: f.artist.trim(), artwork_path: artwork, preview_path: preview, external_url: f.url.trim() || null, genre: f.genre.trim() || null }
      let { error } = await supabase.from('music_tracks').insert(m ? { ...row, duration_ms: (Number(m[1]) * 60 + Number(m[2])) * 1000 } : row)
      if (error && m && /duration_ms/.test(error.message)) ({ error } = await supabase.from('music_tracks').insert(row))   // server before migration 26
      if (error) throw error
      setF({ title: '', artist: '', url: '', genre: '', length: '' }); setArt(null); setAud(null); if (artIn.current) artIn.current.value = ''; if (audIn.current) audIn.current.value = ''
      setMsg({ kind: 'ok', text: 'Song added.' }); list.reload()
    } catch (e) { if (made.length) await supabase.storage.from('brand').remove(made); setMsg({ kind: 'err', text: errMsg(e) }) } finally { setBusy(false) }
  }
  const toggle = async (t: Track) => { const { error } = await supabase.from('music_tracks').update({ active: !t.active }).eq('id', t.id); if (error) return setMsg({ kind: 'err', text: errMsg(error) }); list.reload() }
  const del = async (t: Track) => {
    if (!confirm(`Delete “${t.title}”? Posts that used it keep the song name.`)) return
    const { error } = await supabase.from('music_tracks').delete().eq('id', t.id)
    if (error) return setMsg({ kind: 'err', text: errMsg(error) })
    const files = [t.artwork_path, t.preview_path].filter((x): x is string => Boolean(x)); if (files.length) await supabase.storage.from('brand').remove(files)
    list.reload()
  }
  return (
    <div className="stack">
      <div className="notice"><b>Music library.</b> Members pick songs from here when they post, and artists suggested on Home come from here. Upload only audio, artwork and links you’re entitled to share; previews are public files. Keep previews short (30 seconds is typical).</div>
      <section className="card">
        <h2 className="t-section">Add a song</h2>
        <Field id="mu-title" label="Title"><input id="mu-title" className="input" maxLength={120} value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></Field>
        <Field id="mu-artist" label="Artist"><input id="mu-artist" className="input" maxLength={120} value={f.artist} onChange={e => setF({ ...f, artist: e.target.value })} /></Field>
        <Field id="mu-genre" label="Genre (optional)"><input id="mu-genre" className="input" maxLength={40} value={f.genre} onChange={e => setF({ ...f, genre: e.target.value })} /></Field>
        <Field id="mu-len" label="Song length (optional)" hint="minutes:seconds, e.g. 3:18 — shown in the library"><input id="mu-len" className="input" inputMode="numeric" placeholder="3:18" value={f.length} onChange={e => setF({ ...f, length: e.target.value })} /></Field>
        <Field id="mu-url" label="Link to listen (optional)" hint="https:// only"><input id="mu-url" className="input" inputMode="url" value={f.url} onChange={e => setF({ ...f, url: e.target.value })} /></Field>
        <Field id="mu-art" label="Artwork (JPG, PNG or WebP, up to 5 MB)"><input id="mu-art" ref={artIn} className="input" type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setArt(e.target.files?.[0] ?? null)} /></Field>
        <Field id="mu-aud" label="Preview audio (MP3, M4A or OGG, up to 8 MB)"><input id="mu-aud" ref={audIn} className="input" type="file" accept="audio/mpeg,audio/mp4,audio/ogg" onChange={e => setAud(e.target.files?.[0] ?? null)} /></Field>
        <button className="btn primary" disabled={busy} onClick={add}>{busy ? 'Uploading…' : 'Add song'}</button>
        {msg && <p className={msg.kind === 'err' ? 'error' : 't-meta'} role={msg.kind === 'err' ? 'alert' : 'status'} style={{ marginTop: 8 }}>{msg.text}</p>}
      </section>
      <section className="card"><h2 className="t-section" style={{ marginBottom: 8 }}>Library ({list.data?.length ?? 0})</h2>
        {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? <p className="t-support">No songs yet.</p> : (
          <ul className="arc">{list.data.map(t => (
            <li key={t.id} className="arc-row"><span className="track-art" style={{ width: 48, height: 48, ...(t.artwork_path ? { backgroundImage: `url(${brandUrl(t.artwork_path)})` } : {}) }} aria-hidden />
              <span className="grow" style={{ minWidth: 0 }}><span className="t-name clamp-1" style={{ display: 'block' }}>{t.title}</span><span className="t-meta clamp-1" style={{ display: 'block' }}>{t.artist}{t.genre ? ` · ${t.genre}` : ''} · {t.preview_path ? 'preview' : 'no preview'} · {t.active ? 'visible' : 'hidden'}</span></span>
              <button className="btn sm" onClick={() => toggle(t)}>{t.active ? 'Hide' : 'Show'}</button><button className="btn sm danger" onClick={() => del(t)}>Delete</button></li>))}</ul>)}
      </section>
    </div>
  )
}
