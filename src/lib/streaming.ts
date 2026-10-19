/**
 * Streaming sits behind this interface so the social graph, plans and UI never depend on one vendor.
 * Going live and joining a stream require a server that holds provider credentials and mints
 * short-lived access tokens after checking visibility; that server is NOT part of this repository yet,
 * so `configured` is false unless both values below are provided at build time.
 */
export interface StreamProvider {
  readonly name: string
  readonly configured: boolean
}

const url = import.meta.env.VITE_LIVEKIT_URL as string | undefined
const tokenEndpoint = import.meta.env.VITE_STREAM_TOKEN_ENDPOINT as string | undefined

export const streamProvider: StreamProvider = { name: 'livekit', configured: Boolean(url && tokenEndpoint) }
