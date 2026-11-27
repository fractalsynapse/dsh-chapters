// #583: the ONE fold for auxiliary calls. The prompt door's probe sliced finish chunks to 120
// chars before parsing, so a real provider refusal (always longer than the slice) arrived as ''
// and printed "the model returned no text" — evidence destroyed at collection. These rows are the
// direct answer to "is the model down, or is that us?": the host's words must SURVIVE to the row.
import test from 'node:test'
import assert from 'node:assert/strict'
import { streamAuxText, hostStreamFailure } from '../../src/llm-fold.ts'

const streamOf = (...chunks: unknown[]) => async function* (): AsyncGenerator<unknown> {
  for (const c of chunks) yield c
}

test('#583: a refusal LONGER than the old 120-char probe slice surfaces the host message intact', async () => {
  const longMsg = 'HTTP 429 Too Many Requests: qwen-token-plan tier rejected the completion after retry-after headers were consumed, please back off (request id 8821fa4c2e05)'
  let thrown = ''
  try {
    await streamAuxText(() => streamOf({ type: 'finish', reason: { kind: 'error', failure: { message: longMsg } } })(), {})
    assert.fail('the refusal must throw, not fold to empty')
  } catch (error) { thrown = String((error as Error).message) }
  assert.match(thrown, /host llm\.stream failed: HTTP 429 Too Many Requests/)
  assert.ok(thrown.length > 120, 'the refusal survived collection; the old probe would have cut it: ' + String(thrown.length))
})

test('#583: a genuinely textless completion returns empty string — the honest sentence, no invented error', async () => {
  const out = await streamAuxText(() => streamOf({ type: 'finish', reason: { kind: 'stop' } })(), {})
  assert.equal(out, '')
})

test('#583: text deltas still fold to the answer (the fix cannot eat successes)', async () => {
  const out = await streamAuxText(() => streamOf(
    { type: 'text-delta', index: 0, text: 'Verify ' },
    { type: 'text-delta', index: 0, text: 'the release chain.' },
    { type: 'finish', reason: { kind: 'stop' } },
  )(), {})
  assert.equal(out, 'Verify the release chain.')
})

test('#583: an error finish WITHOUT a message is still named as an error, never as emptiness', () => {
  const msg = hostStreamFailure([JSON.stringify({ type: 'finish', reason: { kind: 'error' } })])
  assert.match(msg ?? '', /host llm\.stream failed: the host reported an error without a message/)
})
