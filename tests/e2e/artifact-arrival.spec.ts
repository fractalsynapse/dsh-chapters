import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, localModelUp, sessionLogTextById, E2E_HOME, ROOT } from './session.ts'

/**
 * ARRIVAL-TIME ARTIFACTING, end to end (architecture.md amendment, G1+G2).
 * Boot pins toolResultArtifactTokens=500 and the production threshold 0.9:
 * a single huge read must be stubbed at the tail node BEFORE the next request
 * composes — so compaction is never even needed to keep the turn alive.
 * Proofs, in the session's own durable log:
 *   - the arrival pair (compaction/prune 'by:dsh-chapters-arrival' + stubbed
 *     tool/result) exists;
 *   - the blob's fingerprint NEVER appears in any request/* event (the blob
 *     was prefilled zero times — the cache-safety claim at the transcript
 *     level; llama.cpp counters land in the sidecar);
 *   - the model WORKS the artifact via chapters_artifact (toc + search) and
 *     returns facts that only exist inside the blob.
 */
import { buildBook, CHAPTERS } from './arrival-book.ts'

const BOOK = path.join(ROOT, 'var', 'e2e-book.md')
const FINGERPRINT = 'BLOB-FINGERPRINT-9182736450-qzxv'
const CENTER_TOKEN = 'EMBED-CENTER-4417'

function parseRows(text: string): { seq: number; type: string; raw: string }[] {
  const out: { seq: number; type: string; raw: string }[] = []
  for (const line of text.split('\n')) {
    try { const e = JSON.parse(line); if (typeof e?.seq === 'number') out.push({ seq: e.seq, type: String(e.type ?? ''), raw: line }) } catch { /* partial */ }
  }
  return out
}

test('one oversized read is artifacted at arrival, never prefilled, and answered through chapters_artifact', async ({ page }) => {
  test.setTimeout(3_600_000) // 60 min ceiling (measured variance: 5–15 artifact calls depending on model curiosity)
  test.skip(!(await localModelUp()), 'Local model server not running')
  fs.writeFileSync(BOOK, buildBook())
  const bookBytes = fs.statSync(BOOK).size
  // Both bounds are the leg's own contract (#130): the read must exceed the deferral threshold or the stub pair
  // never happens, and the artifact must stay queryable or the leg is measuring retrieval luck. The old fixture was
  // 373,861 bytes with the token at chapter 21 — comfortably over the first bound and hopeless on the second.
  expect(bookBytes, 'book must exceed the arrival deferral threshold').toBeGreaterThan(6_000)
  expect(bookBytes, 'book must stay small enough that the artifact query is bounded').toBeLessThan(120_000)

  await openApp(page)
  const sid = await newSessionWithTurn(page,
    'var/e2e-book.md is a large reference document. Step 1: fetch it ONCE with the read tool at offset 1, limit 2000 — which is the maximum range this host accepts, so the call SUCCEEDS and its whole body arrives at once (one call; whatever comes back is handled by the system). '
    + 'Step 2: answer with AT MOST TWO chapters_artifact calls and nothing else — first action toc for the chapter count, then action search with query "buried here" for the token. No further tool calls of any kind, and do not read the file again. '
    + 'Final answer: one short line "<count> chapters; <token>".',
    2_400_000, false) // #132: bounded to one oversized read + at most two artifact queries — the ceiling is slack for the model, not room to wander

  const rows = parseRows(sessionLogTextById(sid))

  // --- the arrival pair landed
  const prunes = rows.filter((r) => r.type === 'compaction/prune' && r.raw.includes('dsh-chapters-arrival'))
  expect(prunes.length, 'at least one arrival stub pair (one oversized read)').toBeGreaterThanOrEqual(1)
  expect(rows.some((r) => r.type === 'tool/result' && r.raw.includes('[dsh:artifact')), 'stubbed tool/result present').toBe(true)
  // checkpoint count goes to the sidecar, not the gate: arrival's claim is
  // the blob never enters context — whether a deep explorer also crosses the
  // production threshold is model curiosity, and compaction handling THAT
  // is a success story too (oversized-turn.spec owns it).
  const checkpoints = rows.filter((r) => r.type === 'user/message' && r.raw.includes('auto-generated checkpoint')).length

  // --- the fingerprint blob never entered a model request
  const requestBlob = rows.filter((r) => r.type.startsWith('request/')).map((r) => r.raw).join('\n')
  const hasRequests = rows.some((r) => r.type.startsWith('request/'))
  if (hasRequests) expect(requestBlob, 'blob fingerprint leaked into a request — arrival stubbing failed').not.toContain(FINGERPRINT)

  // --- the model worked the artifact and surfaced facts that only exist inside it
  const finalText = rows.filter((r) => r.type === 'assistant/message').map((r) => r.raw).join('\n')
  expect(finalText, 'model never found the buried token via the artifact tool').toContain(CENTER_TOKEN)
  expect(finalText, `the model must report ${String(CHAPTERS)} chapters`).toContain(String(CHAPTERS))
  const artifactCalls = rows.filter((r) => r.type === 'tool/call' && r.raw.includes('chapters_artifact'))
  expect(artifactCalls.length, 'chapters_artifact used to query, not re-read').toBeGreaterThanOrEqual(1)

  // --- sidecar: usage/cache observations after the stub (never a gate)
  const usages = rows.filter((r) => r.type === 'assistant/usage' || r.raw.includes('cacheReadTokens'))
  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-arrival-notes.json'), JSON.stringify({
    at: new Date().toISOString(), bookBytes, prunes: prunes.length, artifactCalls: artifactCalls.length,
    checkpoints, usageCarryingEvents: usages.length, home: E2E_HOME,
  }, null, 1))
})
