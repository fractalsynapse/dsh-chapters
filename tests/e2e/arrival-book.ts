/**
 * The `arrival` leg's fixture book — a designed object with two bounds (#130).
 *
 * It has to be BIG enough that the single read is unambiguously oversized, so arrival defers it to an artifact and
 * the leg actually exercises the mechanism; and SMALL enough that answering through the stub reference is a bounded
 * query rather than a lottery. The old book (40 chapters, 3,964 lines, 373,861 bytes, token buried at chapter 21)
 * was the second one wrong: three regimes in #130 showed the model either found it fast or spiralled into 40–70
 * re-reads, and the variable was luck, not the trigger margin or the aux turn.
 *
 * Guarded by `tests/unit/e2e-arrival-book.test.ts`, which holds both bounds and the token's position.
 */
export const CHAPTERS = 8
export const LINES_PER_CHAPTER = 48
export const FINGERPRINT = 'BLOB-FINGERPRINT-9182736450-qzxv'
export const CENTER_TOKEN = 'EMBED-CENTER-4417'
/** Where the buried token lives — early enough that one `search` finds it. */
export const TOKEN_CHAPTER = 2

export function buildBook(): string {
  const lines: string[] = ['# The Big Reference Book', '', `Structure probe target: ${String(CHAPTERS)} chapters.`]
  for (let c = 1; c <= CHAPTERS; c++) {
    lines.push('', `## Chapter ${c} of ${String(CHAPTERS)}`, `Chapter ${c} discusses windowing, filing, and retrieval.`)
    for (let l = 0; l < LINES_PER_CHAPTER; l++) {
      lines.push(`line ${c}-${l}: reference material regarding context economics and archival discipline number ${String(c * 100 + l)}.`)
    }
    if (c === TOKEN_CHAPTER) {
      lines.push(`${FINGERPRINT} ${'filler-'.repeat(200)}`)
      lines.push(`buried here: ${CENTER_TOKEN}`)
    }
  }
  return lines.join('\n')
}
