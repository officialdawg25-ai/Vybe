/**
 * What a post needs before it can be published (the database enforces the same rule: migration 34). A post needs
 * meaningful text or a photo/video. A song, feeling, place or tagged friends make a post richer but never qualify on
 * their own. "Meaningful" text is whatever is left after removing spaces, invisible characters, punctuation, symbols and
 * emoji, mirroring public.meaningful_text.
 */
const NOISE = /[\s\p{P}\u00a0\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202f\u205f-\u206f\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0\u20e3\u2190-\u21ff\u2300-\u23ff\u2460-\u24ff\u25a0-\u27bf\u2900-\u297f\u2b00-\u2bff\u{1F000}-\u{1FAFF}\u{E0000}-\u{E007F}]/gu
/** ASCII symbols that Postgres' [:punct:] removes but \p{P} does not (+, <, =, >, |, ~, ^, `, $). */
const ASCII_SYMBOLS = /[$+<=>^`|~]/g

export const meaningfulText = (s: string | null | undefined) => (s ?? '').replace(NOISE, '').replace(ASCII_SYMBOLS, '').length > 0

export interface Draft { text: string; media: number; song?: boolean; feeling?: boolean; place?: boolean; tags?: number }

/** Why this draft cannot be published yet, or null when it can. */
export function publishProblem(d: Draft): string | null {
  if (d.media > 0 || meaningfulText(d.text)) return null
  if (d.song) return 'A song can’t be posted on its own. Add a photo, a video or a few words.'
  if (d.text.trim()) return 'Add a few words (emoji and punctuation alone don’t count), or a photo or video.'
  if (d.feeling || d.place || d.tags) return 'Add a photo, a video or a few words to post this.'
  return 'Write something, or add a photo or video.'
}
