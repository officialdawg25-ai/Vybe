export interface Profile {
  id: string
  username: string
  display_name: string
  bio: string
  avatar_path: string | null
  location: string | null
  interests: string[]
  dm_policy: 'friends' | 'everyone'
  notif_prefs?: Record<string, boolean>
  onboarded_at: string | null
  display_name_changed_at?: string | null
  country?: string | null
  lat?: number | null
  lng?: number | null
  intents?: string[]
  onboarding_step?: number
  cover_path?: string | null
  verified_until?: string | null
  follow_policy?: 'everyone' | 'friends'
  show_followers?: 'public' | 'friends' | 'me'
}
export type PublicProfile = Pick<Profile, 'id' | 'username' | 'display_name' | 'avatar_path'> & { verified_until?: string | null }

export interface Post {
  id: string
  author: string
  body: string
  media_path: string | null
  media_type: 'image' | 'video' | null
  visibility: 'public' | 'friends' | 'community'
  community_id: string | null
  event_id: string | null
  created_at: string
  edited_at: string | null
  organization_id?: string | null
  org?: { id: string; name: string; slug: string } | null
  event?: { id: string; title: string; starts_at: string; timezone: string; city: string | null; venue: string | null; status: string } | null
  profiles: PublicProfile
  reactions: { count: number }[]
  comments: { count: number }[]
  mine_reaction: { user_id: string }[]
  mine_save: { user_id: string }[]
  feeling?: string | null
  place_name?: string | null
  place_lat?: number | null
  place_lng?: number | null
  music_track_id?: string | null
  music_title?: string | null
  music_artist?: string | null
  music_url?: string | null
  music_path?: string | null
  post_media?: { path: string; type: 'image' | 'video'; sort: number }[]
  tags?: { profiles: PublicProfile }[]
  track?: { preview_path: string | null; artwork_path: string | null } | null
}

export interface EventRow {
  id: string
  host: string
  title: string
  description: string
  cover_path: string | null
  starts_at: string
  ends_at: string | null
  timezone: string
  location: string | null
  visibility: 'public' | 'friends' | 'invite'
  capacity: number | null
  community_id: string | null
  price_cents: number | null
  currency: string | null
  ticket_url: string | null
  status: 'draft' | 'active' | 'cancelled' | 'completed'
  category?: string | null
  format?: 'in_person' | 'online' | 'hybrid'
  online_url?: string | null
  source?: 'vybe' | 'external'
  source_name?: string | null
  source_url?: string | null
  organization_id?: string | null
  city?: string | null
  country?: string | null
  venue?: string | null
  address?: string | null
  lat?: number | null
  lng?: number | null
  profiles: PublicProfile
}

export interface Community {
  id: string
  name: string
  description: string
  rules: string
  cover_path: string | null
  topics: string[]
  visibility: 'public' | 'private'
  created_by: string
}
