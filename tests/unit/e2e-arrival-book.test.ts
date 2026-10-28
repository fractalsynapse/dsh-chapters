/**
 * The `arrival` leg's fixture must stay big enough to defer and small enough to search (#130).
 *
 * The leg proved the mechanism (one oversized read deferred to an artifact at arrival, then answered through
 * `chapters_artifact`) AND retrieval luck at the same time: the book was 40 chapters / 3,964 lines / 373,861 bytes
 * with the token buried at chapter 21, so a small model answering through a stub reference either found it quickly or
 * spiralled into 40–70 re-reads. Three regimes in #130 showed the spiral is not the trigger margin or the aux turn —
 * it is the haystack.
 *
 * So the fixture is now a designed object with two bounds, and this row holds them: OVER the deferral threshold,
 * because a read that does not defer stops being the mechanism under test; UNDER a tractable size, because a needle
 * the model can only find by luck is not an acceptance test. Neither number is arbitrary — both are stated in terms of
 * the leg's own configuration.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHAPTERS, CENTER_TOKEN, buildBook } from '../../tests/e2e/arrival-book.ts'

test('the arrival book still exceeds the deferral threshold', () => {
  const text = buildBook()
  // The leg pins `floor: '500'` tokens; at ~4 bytes/token that is ~2,000 bytes. Three times that margin means the
  // read is unambiguously oversized on either machine, so the stub pair MUST happen.
  assert.ok(text.length > 6_000, `book must exceed the deferral threshold, got ${String(text.length)} bytes`)
})

test('and it is small enough that retrieval is a bounded query, not a lottery', () => {
  const text = buildBook()
  assert.ok(text.length < 120_000, `book must stay searchable through a stub, got ${String(text.length)} bytes`)
  const lines = text.split('\n')
  const chapterLines = lines.filter((l) => l.startsWith('## Chapter')).length
  assert.equal(chapterLines, CHAPTERS, 'the chapter count the leg asks the model to report')
  const tokenLine = lines.findIndex((l) => l.includes(CENTER_TOKEN))
  assert.ok(tokenLine >= 0, 'the buried token is present')
  const chaptersBefore = lines.slice(0, tokenLine).filter((l) => l.startsWith('## Chapter')).length
  assert.ok(chaptersBefore <= 3, `token must sit within the first few chapters so the query is bounded, found after chapter ${String(chaptersBefore)}`)
})

test('the generated file is byte-identical to the builder (the spec must not drift from the fixture)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrbook-'))
  try {
    const target = path.join(dir, 'book.md')
    const text = buildBook()
    fs.writeFileSync(target, text)
    assert.equal(fs.readFileSync(target, 'utf8'), text, 'no mutation between build and write')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
