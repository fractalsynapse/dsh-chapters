/**
 * #304 — the boot reclaim, as the boot actually runs it: the store-level loop over every session
 * (headless-boot drills proved flaky against the host's domain lifecycle; this tests the exact
 * code path `apply()` executes, with the real makeDomainStore over a fake domain).
 *
 * The claim semantics being verified: `analyzing` is the ONLY state that moves, it moves to the
 * runner's resting vocabulary (which the state verb renders as idle, not off-to-a-client), and a
 * row with nothing to reclaim is returned SAME-OBJECT so the boot writes nothing it didn't need.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDomainStore } from '../../src/store.ts'
import { reconcilePromptRow } from '../../src/prompt-runner.ts'

function fakeDomain(initial: Record<string, unknown>) {
  const rows = structuredClone(initial)
  return {
    table() {
      return {
        get: (k: string) => (rows[k] === undefined ? undefined : structuredClone(rows[k])),
        put: async (k: string, v: unknown) => { rows[k] = structuredClone(v) },
        delete: async (k: string) => { delete rows[k] },
        entries: () => Object.entries(structuredClone(rows)) as IterableIterator<[string, unknown]>,
      }
    },
    dump: () => rows,
  }
}

test('#304: the boot loop releases a planted zombie claim and leaves everything else byte-identical', async () => {
  const zombie = { rev: 3, chapters: [], promptSuggestion: { status: 'analyzing', text: '', turnSeq: 9999, error: '', at: '2026-11-04T21:00:00Z', intent: 'worker-step', goalRevision: null } }
  const standing = { rev: 1, chapters: [], promptSuggestion: { status: 'ready', text: 'keep it', turnSeq: 7, error: '', at: 'x', intent: 'worker-step', goalRevision: null } }
  const failed = { rev: 2, chapters: [], promptSuggestion: { status: 'failed', text: '', turnSeq: 8, error: 'boom', at: 'y', intent: 'worker-step', goalRevision: null } }
  const store = makeDomainStore(fakeDomain({ 'zombie': zombie, 'standing': standing, 'failed': failed }) as never)
  for (const [id, row] of store.sessions()) {
    if (row.promptSuggestion?.status === 'analyzing') {
      await store.mutate(id, ((r: never) => reconcilePromptRow(r)) as never)
    }
  }
  const out = store.sessions()
  const byId = new Map([...out].map(([k, v]) => [k, v]))
  const z = byId.get('zombie')?.promptSuggestion
  assert.equal(z?.status, 'off', 'zombie released to resting')
  assert.equal(z?.turnSeq, null, 'the claim identity is gone — no idempotence trap for the next boundary')
  assert.deepEqual(byId.get('standing')?.promptSuggestion, standing.promptSuggestion, 'ready untouched')
  assert.deepEqual(byId.get('failed')?.promptSuggestion, failed.promptSuggestion, 'failed untouched')
})
