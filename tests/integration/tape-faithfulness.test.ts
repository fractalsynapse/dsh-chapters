/**
 * Every stored tape entry must be able to produce a turn (#90).
 *
 * The motivating measurement: `a-knowledge-loop` in replay served a matching entry (zero tape misses)
 * whose stream yielded no assistant message at all, and the host ended the turn
 * `code:"TIMEOUT"` after 25 minutes. A corpus that stores a turn it cannot replay is the "green tests,
 * broken product" failure moved into the rig itself — and the chain's two existing honesty checks
 * (prefix match, durable turn/end) are both satisfiable while the entry is useless.
 *
 * This walks the committed corpus and classifies each entry's decoded SSE body. An entry is acceptable
 * when it carries text, a tool call, or reasoning (three legitimate shapes); an entry that is ONLY
 * usage/metadata, or has no choices content at all on a 200 response, is a silent time bomb and fails
 * with its path named.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const TAPE = path.join(ROOT, 'tests', 'fixtures', 'model-tape')

interface Classification { kind: 'text' | 'tool-call' | 'reasoning-only' | 'usage-only' | 'empty' | 'non-200' }

function classify(file: string): Classification {
  const e = JSON.parse(fs.readFileSync(file, 'utf8')) as { status?: number, bytes?: string }
  if (e.status !== undefined && e.status !== 200) return 'non-200'
  const raw = Buffer.from(e.bytes ?? '', 'base64').toString('utf8')
  let kind: Classification = 'empty'
  for (const line of raw.split('\n')) {
    const m = /^data:\s*(\{.*\})\s*$/.exec(line.trim())
    if (m === null) continue
    let obj: unknown
    try { obj = JSON.parse(m[1]!) } catch { continue }
    const delta = (obj as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices?.[0]?.delta
    if (delta === undefined) continue
    // `usage: null` appears on every streaming chunk of this provider's SSE, so "is the key
    // present" is not the question — the first draft of this classifier called six perfectly good
    // reasoning-only title responses `usage-only` and accused the corpus of a bug it didn't have.
    // Content also outranks reasoning: a stream that thinks and then speaks is a text turn.
    if (typeof delta.content === 'string' && delta.content !== '') kind = 'text'
    else if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) { if (kind !== 'text') kind = 'tool-call' }
    else if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') { if (kind === 'empty' || kind === 'usage-only') kind = 'reasoning-only' }
    else if (kind === 'empty' && ((obj as { usage?: unknown }).usage ?? null) !== null) kind = 'usage-only'
  }
  return kind
}

test('no committed tape entry is a stream that can only stall the turn it replays (#90)', () => {
  const projects = fs.readdirSync(TAPE).filter((d) => fs.statSync(path.join(TAPE, d)).isDirectory())
  const offenders: string[] = []
  const tally: Record<string, number> = {}
  for (const p of projects) {
    for (const f of fs.readdirSync(path.join(TAPE, p)).filter((x) => x.endsWith('.json')).sort()) {
      const k = classify(path.join(TAPE, p, f))
      tally[k] = (tally[k] ?? 0) + 1
      if (k === 'usage-only' || k === 'empty') offenders.push(`${p}/${f}`)
    }
  }
  assert.deepEqual(offenders, [],
    `these entries decode to no assistant content, so replaying them can only end in TIMEOUT (tally: ${JSON.stringify(tally)}): ${offenders.join(', ')}`)
})
