/**
 * #87 — relief must not lose the question.
 *
 * Measured in the field, one `heavy` session (299 events, durable log read with `zstd -dc`): thirteen
 * compaction summaries shadowed 108 distinct seqs, including **ten of the eleven** copies of the
 * human's follow-up instruction. The surface then holds a plot, not a request, and the session simply
 * stops answering — no error, nothing in the sink. `carryOpenRequest` fixes it inside our own seam:
 * we author the summary text, so the newest human turn travels into it verbatim.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { carryOpenRequest } from '../../src/engine.ts'

const P = (text: string): { type: 'text', text: string } => ({ type: 'text', text })
const user = (text: string): unknown => ({ role: 'user', content: [{ type: 'text', text }] })

test('the newest human turn survives relief inside the summary (#87)', () => {
  const messages = [user('Read the big file.'), { role: 'assistant', content: [{ type: 'text', text: 'reading' }] }, user('Reply with exactly the single word: STILL-HERE.')]
  const out = carryOpenRequest([P('Chapters: 3')], messages, 4000)
  const text = out.map((p) => p.text).join('\n')
  assert.match(text, /OPEN REQUEST/, 'the block is named, so a reader knows why it is there')
  assert.match(text, /Reply with exactly the single word: STILL-HERE\./, 'carried VERBATIM, not paraphrased')
  assert.equal(out[0]?.text, 'Chapters: 3', 'the summary we already composed is untouched — this only appends')
  assert.equal(messages.length, 3, 'the input is never mutated (invariant 1 applies to our arguments too)')
})

test('injected scaffolding is not mistaken for a request (#87)', () => {
  const messages = [
    user('the real question: what is the cache cost?'),
    { role: 'user', content: [{ type: 'text', text: '<system-reminder> workspace instructions may be relevant' }] },
    { role: 'user', content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span' }] },
    { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 9, step 40: 2026-10-23T04:00:00-04:00' }] },
  ]
  const text = carryOpenRequest([P('summary')], messages, 4000).map((p) => p.text).join('\n')
  assert.match(text, /what is the cache cost\?/, 'the newest REAL human turn is carried')
  assert.doesNotMatch(text, /system-reminder|automatically generated checkpoint|Time sampled/,
    'machine state is never carried as if it were a request — re-injecting it would lie about who asked')
})

test('a cap is stated, never a silent cut (#87)', () => {
  const long = `Answer this: ${'x'.repeat(9000)}`
  const text = carryOpenRequest([P('summary')], [user(long)], 4000).map((p) => p.text).join('\n')
  // 9013 = 'Answer this: ' (13) + 9,000 x's, counted rather than assumed — the row that checks a
  // stated count must not itself contain a guessed one.
  assert.match(text, /\[carried in part: 9013 characters total, 4000 included/, 'the numbers are in the block')
  assert.match(text, /the whole turn stays in the durable log/, 'and the reader is told where the rest lives')
})

test('nothing is carried when there is no human turn to carry (#87)', () => {
  const out = carryOpenRequest([P('summary')], [{ role: 'assistant', content: [{ type: 'text', text: 'only机器' }] }], 4000)
  assert.equal(out.length, 1, 'no OPEN REQUEST block, no empty promise of one')
  assert.equal(carryOpenRequest([P('s')], [], 4000).length, 1, 'an empty region is not a crash')
})
