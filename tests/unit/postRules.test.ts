import { describe, expect, it } from 'vitest'
import { meaningfulText, publishProblem } from '../../src/lib/postRules'

describe('publishing rules (mirrors public.meaningful_text)', () => {
  it('words in any script are meaningful; spaces, invisible characters, punctuation and emoji alone are not', () => {
    for (const ok of ['Hi', 'ok', '42', 'Sawubona', 'Привет', 'こんにちは', 'مرحبا', 'Hi 🔥', '¿Qué?']) expect(meaningfulText(ok)).toBe(true)
    for (const no of ['', '   ', '\n\t', '\u200b\u200b', '…!!', '🔥🔥🔥', '❤️', '🇿🇦', '\u00a0', '- - -', '\u3000', '+=~', null, undefined]) expect(meaningfulText(no)).toBe(false)
  })
  it('the publishing table', () => {
    const cases: [Parameters<typeof publishProblem>[0], boolean][] = [
      [{ text: '', media: 0 }, false], [{ text: '   ', media: 0 }, false], [{ text: 'Hi', media: 0 }, true],
      [{ text: '', media: 1 }, true], [{ text: '', media: 1, song: true }, true],
      [{ text: '', media: 0, song: true }, false], [{ text: '   ', media: 0, song: true }, false], [{ text: '🎵', media: 0, song: true }, false],
      [{ text: '', media: 0, feeling: true }, false], [{ text: '', media: 0, place: true, tags: 2 }, false], [{ text: 'At the park', media: 0, place: true }, true],
    ]
    for (const [d, ok] of cases) expect(publishProblem(d) === null).toBe(ok)
    expect(publishProblem({ text: '', media: 0, song: true })).toMatch(/song can’t be posted on its own/)
  })
})
