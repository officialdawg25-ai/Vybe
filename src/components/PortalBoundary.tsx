import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Keeps a failure where it happened. Each portal (the app, the organisation portal, the admin portal) and each page inside
 * a portal sits in its own boundary, and each portal's code is a separate download: if the admin portal breaks or cannot
 * load, members and organisations keep using theirs, and a broken page leaves its portal's navigation working.
 * A failed code download (usually a new version was deployed while the page was open) offers a reload.
 */
interface Props { area: string; children: ReactNode; compact?: boolean }
interface State { error: Error | null }

export class PortalBoundary extends Component<Props, State> {
  state: State = { error: null }
  static getDerivedStateFromError(error: Error): State { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // Visible in the browser console for support; no personal data is attached.
    console.error(`[${this.props.area}] crashed`, error, info.componentStack)
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const stale = /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically/i.test(error.message)
    return (
      <div className={`boundary${this.props.compact ? ' compact' : ''}`} role="alert">
        <h2>{stale ? 'VYBE was updated' : `${this.props.area} hit a problem`}</h2>
        <p>{stale ? 'Reload to get the latest version.' : 'The rest of VYBE still works. Try again, or go somewhere else for now.'}</p>
        <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          {!stale && <button className="btn primary" onClick={() => this.setState({ error: null })}>Try again</button>}
          <button className={`btn${stale ? ' primary' : ''}`} onClick={() => window.location.reload()}>Reload</button>
          <a className="btn ghost" href="/app">Home</a>
        </div>
      </div>
    )
  }
}
