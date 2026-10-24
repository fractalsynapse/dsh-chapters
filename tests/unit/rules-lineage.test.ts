/**
 * Rule ancestry over DELEGATION lineage (#52, user decision 2026-10-21).
 *
 * Session rules activated by ancestry reached a continuation but not a subagent,
 * because our registry is the sole authority on continuation lineage and ignores
 * the kernel header's `parentSession` — so a delegated child was an unrelated root
 * and inherited nothing. These rows pin the fix: the rule tier joins BOTH edges
 * (registry ancestry and header parentSession), transitively, read-only, bounded,
 * cycle-safe, and LOUD when it gives up.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ruleAncestorSet, RULE_LINEAGE_MAX_EXPANSIONS } from '../../src/session-rules.ts'

/** registry ancestors per session id, and header parents per session id */
const world = (links: Record<string, string[]>, parents: Record<string, string | undefined>) => ({
  registryAncestors: async (id: string) => links[id] ?? [],
  parentOf: async (id: string) => parents[id] ?? null,
})

test('a delegated child inherits the delegating parent through the header alone', async () => {
  // exactly the subagent case: our registry has NO link for the child
  const r = await ruleAncestorSet({ seeds: ['sub-1'], ...world({}, { 'sub-1': 'parent-1' }) })
  assert.ok(r.ancestors.has('sub-1'), 'the session itself is always in its ancestry')
  assert.ok(r.ancestors.has('parent-1'), 'the header parent joins the set')
  assert.equal(r.truncated, false)
})

test('the join is transitive across mixed edges: parent-of-parent and continuation links', async () => {
  // sub-2 delegated from sub-1, which is a continuation child of root-A
  const links = { 'sub-1': ['root-A'], 'cont-1': ['root-A'] }
  const parents = { 'sub-2': 'sub-1' }
  const r = await ruleAncestorSet({ seeds: ['sub-2'], ...world(links, parents) })
  assert.deepEqual([...r.ancestors].sort(), ['root-A', 'sub-1', 'sub-2'],
    'header edge → registry edge of the parent must also be walked')
})

test('direction stays one-way: a parent never inherits its child’s tree', async () => {
  const r = await ruleAncestorSet({ seeds: ['parent-1'], ...world({}, { 'sub-1': 'parent-1' }) })
  assert.deepEqual([...r.ancestors], ['parent-1'], 'walking goes UP only')
})

test('a header cycle terminates instead of hanging', async () => {
  const r = await ruleAncestorSet({ seeds: ['a'], ...world({ b: ['a'] }, { a: 'b', b: 'a' }) })
  assert.ok(r.ancestors.has('a') && r.ancestors.has('b'))
  assert.equal(r.truncated, false, 'a closed walk is complete, not truncated')
})

test('deep delegation is bounded, and says so', async () => {
  const parents: Record<string, string> = {}
  for (let i = 0; i < RULE_LINEAGE_MAX_EXPANSIONS + 40; i++) parents[`s${i}`] = `s${i + 1}`
  const r = await ruleAncestorSet({ seeds: ['s0'], ...world({}, parents) })
  assert.equal(r.truncated, true, 'giving up quietly is the failure mode this repo rejects')
  assert.ok(r.ancestors.size <= RULE_LINEAGE_MAX_EXPANSIONS + 1, 'the cap is a real cap')
})

test('an unknown session (no header yet) yields just itself, never a guess', async () => {
  const r = await ruleAncestorSet({ seeds: ['ghost'], ...world({}, {}) })
  assert.deepEqual([...r.ancestors], ['ghost'])
  assert.equal(r.truncated, false)
})

test('a throwing header reader is treated as no parent, not as a crash', async () => {
  const r = await ruleAncestorSet({
    seeds: ['sub-9'],
    registryAncestors: async () => [],
    parentOf: async () => { throw new Error('session not open') },
  })
  assert.deepEqual([...r.ancestors], ['sub-9'], 'a rule walk must never break a turn')
})

test('EVERY door that resolves rule ancestry uses the ONE walk (anti-drift)', () => {
  // three planes read ancestry; a second implementation is how the subagent gap
  // happened in the first place, so no call site may compute it itself
  const sites = ['src/index.ts', 'src/engine.ts', 'src/tools.ts']
  for (const f of sites) {
    const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8')
    if (!src.includes('ancestorSessionIds')) continue // this plane reads no ancestry at all
    assert.match(src, /ruleAncestorSet/,
      `${f} walks ancestry by hand instead of through ruleAncestorSet — the two tiers would drift`)
  }
})
