/** Message catalogue. Add a locale object and it is picked up by navigator.language. */
const en = {
  'brand.tagline': 'Life is better together.',
  'brand.promise': 'Discover what moves you. Find your people. Make it happen.',
  'nav.discover': 'Discover',
  'nav.friends': 'Friends',
  'nav.plans': 'Plans',
  'nav.communities': 'Communities',
  'nav.profile': 'Profile',
  'nav.messages': 'Messages',
  'nav.notifications': 'Notifications',
  'nav.search': 'Search',
  'nav.settings': 'Settings',
  'common.loading': 'Loading…',
  'common.retry': 'Try again',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.report': 'Report',
  'error.generic': 'Something went wrong. Please try again.',
  'error.config': 'VYBE is not connected to a backend yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
} as const

export type MessageKey = keyof typeof en
const catalogues: Record<string, Partial<Record<MessageKey, string>>> = { en }

export function t(key: MessageKey): string {
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'en').split('-')[0]
  return catalogues[lang]?.[key] ?? en[key]
}
