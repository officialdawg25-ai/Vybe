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
}
export type PublicProfile = Pick<Profile, 'id' | 'username' | 'display_name' | 'avatar_path'>

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
  profiles: PublicProfile
  reactions: { count: number }[]
  comments: { count: number }[]
  mine_reaction: { user_id: string }[]
  mine_save: { user_id: string }[]
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
  status: 'active' | 'cancelled'
  organization_id?: string | null
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
