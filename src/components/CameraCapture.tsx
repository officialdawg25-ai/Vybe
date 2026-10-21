import { useEffect, useRef, useState } from 'react'
import { Camera, RefreshCw, Square, X } from 'lucide-react'
import { toast } from '../ui'

/**
 * In-app camera: take a photo or record a video without leaving VYBE. Falls back to `onUnavailable` (the device's own
 * camera picker) when the browser cannot open a camera or the member declines access.
 */
export function CameraCapture({ onCapture, onClose, onUnavailable }: { onCapture: (file: File) => void; onClose: () => void; onUnavailable: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | null>(null)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [mode, setMode] = useState<'photo' | 'video'>('photo')
  const [recording, setRecording] = useState(false)
  const [secs, setSecs] = useState(0)
  const [ready, setReady] = useState(false)

  const stopStream = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null }
  useEffect(() => {
    let live = true
    setReady(false)
    ;(async () => {
      if (!navigator.mediaDevices?.getUserMedia) { onUnavailable(); return }
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: mode === 'video' })
        if (!live) { s.getTracks().forEach(t => t.stop()); return }
        stopStream(); stream.current = s
        if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}) }
        setReady(true)
      } catch (e) {
        if (!live) return
        toast((e as DOMException)?.name === 'NotAllowedError' ? 'Camera access is blocked. Allow it in your browser settings, or use your gallery.' : 'Could not open the camera on this device.')
        onUnavailable()
      }
    })()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facing, mode])
  useEffect(() => () => { stopStream(); if (timer.current) window.clearInterval(timer.current); if (rec.current?.state === 'recording') rec.current.stop() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const snap = () => {
    const v = video.current; if (!v || !v.videoWidth) return
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight
    c.getContext('2d')!.drawImage(v, 0, 0)
    c.toBlob(b => { if (b) onCapture(new File([b], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' })) }, 'image/jpeg', 0.95)
  }
  const record = () => {
    const s = stream.current; if (!s) return
    if (recording) { rec.current?.stop(); return }
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m))
    const r = new MediaRecorder(s, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined)
    chunks.current = []
    r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
    r.onstop = () => {
      if (timer.current) window.clearInterval(timer.current); setRecording(false)
      const type = (r.mimeType || 'video/webm').split(';')[0]
      const blob = new Blob(chunks.current, { type })
      if (blob.size) onCapture(new File([blob], `video-${Date.now()}.${type === 'video/mp4' ? 'mp4' : 'webm'}`, { type }))
    }
    rec.current = r; r.start(1000); setRecording(true); setSecs(0)
    timer.current = window.setInterval(() => setSecs(x => x + 1), 1000)
  }

  return (
    <div className="cam" role="dialog" aria-modal="true" aria-label="Camera">
      <video ref={video} className="cam-view" playsInline muted autoPlay style={facing === 'user' ? { transform: 'scaleX(-1)' } : undefined} />
      <div className="cam-top">
        <button className="cam-btn" type="button" aria-label="Close camera" onClick={onClose}><X size={24} /></button>
        {recording && <span className="cam-rec"><i aria-hidden />{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>}
        <button className="cam-btn" type="button" aria-label="Switch camera" onClick={() => setFacing(f => (f === 'user' ? 'environment' : 'user'))} disabled={recording}><RefreshCw size={22} /></button>
      </div>
      <div className="cam-bottom">
        <div className="cam-modes" role="tablist" aria-label="Capture mode">
          <button role="tab" aria-selected={mode === 'photo'} className={mode === 'photo' ? 'on' : ''} onClick={() => !recording && setMode('photo')}>Photo</button>
          <button role="tab" aria-selected={mode === 'video'} className={mode === 'video' ? 'on' : ''} onClick={() => !recording && setMode('video')}>Video</button>
        </div>
        <button className={`cam-shutter${mode === 'video' ? ' video' : ''}${recording ? ' rec' : ''}`} type="button" disabled={!ready}
          aria-label={mode === 'photo' ? 'Take photo' : recording ? 'Stop recording' : 'Start recording'} onClick={mode === 'photo' ? snap : record}>
          {mode === 'photo' ? <Camera size={28} aria-hidden /> : recording ? <Square size={22} fill="currentColor" aria-hidden /> : null}
        </button>
      </div>
    </div>
  )
}
