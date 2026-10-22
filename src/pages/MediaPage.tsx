import { useEffect } from 'react'
import { MediaLibrary } from '../components/MediaLibrary'

/** /app/media: the member's own photos and videos (private to them). */
export default function MediaPage() {
  useEffect(() => { document.title = 'Media library · VYBE' }, [])
  return (
    <>
      <h1 className="t-display-sm" style={{ marginBottom: 8 }}>Media library</h1>
      <MediaLibrary />
    </>
  )
}
