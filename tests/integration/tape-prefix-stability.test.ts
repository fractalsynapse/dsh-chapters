/**
 * TAPE PREFIX-STABILITY LEDGER — the deterministic half of cache regression.
 *
 * The live-side physical property (hit rates RISE over a session) is owned by the opt-in e2e
 * probe (tests/e2e/cache-trajectory.spec.ts, `npm run test:e2e:cache` — recorded usage bytes
 * cannot measure it). What CAN be measured deterministically, from the committed model tapes,
 * is the product precondition any cache needs: **a message once sent is never mutated.** LLM
 * prefix caching is exactly "the bytes you already paid for stay valid"; a harness change that
 * rewrites an already-sent message mid-session (a re-rendered notice, a swapped-out injection,
 * a reordered block) silently poisons every downstream hit — and 2026-09-25's hosted
 * investigation proved those mutations exist as a CLASS (catalog injections are machine
 * state). This test walks every recorded session chain and fails, with the offending message
 * index, on any recorded request that continues an existing chain while NOT extending its
 * predecessor byte-for-byte.
 *
 * Chain model: group stored entries by their system-prompt signature (one group per agent
 * surface). An entry whose messages array has no shorter entry as a leading slice is a chain
 * HEAD (a fresh session's first request — legal). An entry WITH a successor but no ancestor is
 * a chain that MUTATED mid-flight — legal exactly at the two documented replacement points:
 * pressure compaction ('checkpoint condensing') and a continuation notice ('# Continuation').
 * Anywhere else, the byte-stability of sent history is invariant.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { substituteAll } from '../e2e/model-proxy.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const TAPE_DIR = path.join(ROOT, 'tests', 'fixtures', 'model-tape')

/** Normalize a stored prefix entry the way the matcher does: full substitution pipeline,
 * then drop the elements that mask to nothing (pure injections). */
function normMessages(prefix: unknown[]): string[] {
  return prefix.map((p) => substituteAll(typeof p === 'string' ? p : JSON.stringify(p) ?? '')).filter((x) => x !== '')
}

interface Entry { file: string; msgs: string[] }

function loadProject(dir: string): Entry[] {
  const out: Entry[] = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { prefix?: unknown[] }
    if (!Array.isArray(e.prefix) || e.prefix.length === 0) continue
    out.push({ file: f, msgs: normMessages(e.prefix) })
  }
  return out
}

const REPLACEMENT_MARKERS = ['checkpoint condensing', '# Continuation:']

test('tapes exist to audit (silent-empty would fake a pass)', () => {
  assert.ok(fs.existsSync(TAPE_DIR), `${TAPE_DIR} missing entirely`)
  const projects = fs.readdirSync(TAPE_DIR).filter((d) => fs.statSync(path.join(TAPE_DIR, d)).isDirectory())
  assert.ok(projects.length >= 5, `expected the six tape projects, saw: ${projects.join(',')}`)
})

/**
 * The chain walk, as a pure exported function: the project loop below is generated from the real
 * corpus, and a generated test cannot be fed a synthetic case — so a mutation row that wants to
 * prove the ledger still has teeth needs this. It is the same code, not a copy: the loop calls it.
 */
export function ledgerViolations(entries: Entry[]): string[] {
  const problems: string[] = []
  const bySystem = new Map<string, Entry[]>()
  for (const e of entries) {
    const key = `${e.msgs[0] ?? ''}\u0000${e.msgs[1] ?? ''}`
    const list = bySystem.get(key) ?? []
    list.push(e)
    bySystem.set(key, list)
  }
  for (const [sysKey, group] of bySystem) {
    const minLen = Math.min(...group.map((x) => x.msgs.length))
    for (const e of group) {
      if (e.msgs.length < 2) continue
      const ancestors = group.filter((f) => f !== e && f.msgs.length < e.msgs.length
        && e.msgs.slice(0, f.msgs.length).every((m, i) => m === f.msgs[i]))
      if (ancestors.length > 0) continue
      const hasSuccessor = group.some((f) => f !== e && f.msgs.length > e.msgs.length
        && f.msgs.slice(0, e.msgs.length).every((m, i) => m === e.msgs[i]))
      if (!hasSuccessor) continue
      const nearHead = e.msgs.length <= minLen + 1
      const replaced = e.msgs.some((m) => REPLACEMENT_MARKERS.some((k) => m.includes(k)))
      if (nearHead || replaced) continue
      problems.push(`${String(e.msgs.length)}-message entry has successors but no byte-identical predecessor `
        + `(group minimum ${String(minLen)}; system prompt ${JSON.stringify(sysKey.slice(0, 60))})`)
    }
  }
  return problems
}

for (const project of fs.readdirSync(TAPE_DIR).filter((d) => { try { return fs.statSync(path.join(TAPE_DIR, d)).isDirectory() } catch { return false } })) {
  test(`[${project}] every mid-chain request extends its predecessor byte-for-byte`, () => {
    const entries = loadProject(path.join(TAPE_DIR, project))
    const problems = ledgerViolations(entries)
    assert.deepEqual(problems, [],
      `${project}: ${problems.join('; ')} — something REWROTE an already-sent message mid-chain, `
      + 'invalidating every downstream cache line. If this is a new documented replacement point, '
      + 'add its marker above with a measured justification.')
  })
}


/**
 * The teeth, proven rather than assumed: narrowing the chain key must not turn the ledger into a
 * formality. Three synthetic entries in one chain where the MIDDLE one rewrote an already-sent
 * message have to be caught by the same walk — and the near-head case must not be.
 */
test('the ledger still catches a genuine mid-chain rewrite (mutation check)', () => {
  // Proves the walk is not a formality after the chain-key fix: a synthetic chain whose middle
  // entry rewrote an already-sent message must be reported, and an honest extension must not be.
  const SYS = { role: 'system', content: 'header bytes' }
  const H = { role: 'user', content: 'the human asked once' }
  const row = (msgs: unknown[]): Entry => ({ file: 'synthetic', msgs: msgs.map((m) => JSON.stringify(m)) })

  const honest = [
    row([SYS, H, { role: 'assistant', content: 'answer one' }]),
    row([SYS, H, { role: 'assistant', content: 'answer one' }, { role: 'user', content: 'and then' }]),
  ]
  assert.deepEqual(ledgerViolations(honest), [], 'a chain that extends byte-for-byte must pass')

  // a genuine mid-chain rewrite: a shorter chain exists (so nothing is "near head"), one entry
  // rewrote an already-sent assistant message, and a longer request continues THAT entry — which is
  // precisely the pattern the ledger exists to catch.
  const poisoned = [
    row([SYS, H, { role: 'assistant', content: 'one' }]),
    row([SYS, H, { role: 'assistant', content: 'one' }, { role: 'user', content: 'and then' }]),
    row([SYS, H, { role: 'assistant', content: 'ONE — REWRITTEN' }, { role: 'user', content: 'and then' },
      { role: 'assistant', content: 'two' }]),
    row([SYS, H, { role: 'assistant', content: 'ONE — REWRITTEN' }, { role: 'user', content: 'and then' },
      { role: 'assistant', content: 'two' }, { role: 'user', content: 'again' }]),
  ]
  const found = ledgerViolations(poisoned)
  assert.equal(found.length, 1, `a rewritten sent message must be reported, got ${String(found.length)}: ${JSON.stringify(found)}`)
  assert.match(found[0]!, /successors but no byte-identical predecessor/, 'and with a reason a reader can act on')

  // the auxiliary call that shares the header but opens differently must NOT be folded into the
  // journey chain (this is exactly what arrival/0000 and heavy/0001 looked like)
  const withAux = [
    row([SYS, { role: 'user', content: 'generate the session title from this JSON array' }]),
    row([SYS, H, { role: 'user', content: '<system-reminder> injections' }]),
    row([SYS, H, { role: 'user', content: '<system-reminder> injections' }, { role: 'assistant', content: 'ok' }]),
  ]
  assert.deepEqual(ledgerViolations(withAux), [],
    'a title call in the same header group is not this chain’s head — grouping by opening pair is what keeps that true')
})
