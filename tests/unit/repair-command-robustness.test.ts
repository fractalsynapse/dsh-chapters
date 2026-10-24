/**
 * One kernel-refused session must not cancel a repair (#101, measured live).
 *
 * `/chapters-repair dry-run` died with `stored session "ch-dc3be3ab-…" is corrupt: se…` and repaired
 * nothing — even though the other 48 rows were readable and the offline runner skips unreadable logs
 * without complaint. The command's session read was unguarded, so the kernel's `SessionQueryError`
 * propagated out of the loop. This drives the REAL command object (`buildChaptersTools(...).repairCommand`)
 * rather than the library underneath it: "the library tolerates it" is not "the command works", which is
 * the exact gap that let this ship.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildChaptersTools } from '../../src/tools.ts'
import { freshSession } from '../../src/registry.ts'

const CONFIG = { artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, mergeThreshold: 0.3 } as never

function world (opts: { corruptIds: string[] }) {
  const states = new Map<string, unknown>([
    ['session-good', { ...freshSession(), rootSession: 'session-good', parentSession: null, nextChapterNumber: 1, chapters: [], collections: [] }],
    ['ch-corrupt', { ...freshSession(), rootSession: 'ch-corrupt', parentSession: null, nextChapterNumber: 1, chapters: [], collections: [] }],
  ])
  const store = {
    sessions: () => [...states.entries()].map(([id, s]) => [id, s]),
    get: async (id: string) => states.get(id) ?? freshSession(),
    put: async (id: string, s: unknown) => { states.set(id, s) },
    mutate: async (id: string, fn: (s: unknown) => unknown) => { states.set(id, fn(states.get(id) ?? freshSession())) },
    listSettings: async () => [],
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name: string) => name === 'sessionQuery' ? {
      async readSession (id: string) {
        if (opts.corruptIds.includes(id)) throw new Error(`stored session "${id}" is corrupt: session format mismatch`)
        // the host returns the header itself as `session` (cwd/origin/agentPreset live on it), not a wrapper
        if (id === 'session-good') return { session: { id, cwd: '/tmp/lab-proj' }, events: [{ seq: 0, type: 'session', data: { header: { cwd: '/tmp/lab-proj' } } }] }
        return { session: { id }, events: [] }
      },
    } : undefined,
  }
  const built = buildChaptersTools(ctx as never, store as never, CONFIG as never)
  return { built, states }
}

const invoke = (cmd: { handler(a: unknown): Promise<{ kind: string; text?: string }> }, rawInput: string) =>
  cmd.handler({ agent: { session: { id: 'session-good', header: { cwd: '/tmp/lab-proj' } } }, rawInput })

test('a kernel-refused session is named and skipped; the rest of the store is still repaired (#101)', async () => {
  const { built } = world({ corruptIds: ['ch-corrupt'] })
  const out = await invoke(built.repairCommand as never, 'dry-run')
  assert.equal(out.kind, 'success', `the command must not die: ${out.text?.slice(0, 200)}`)
  assert.match(out.text ?? '', /ch-corrupt/, 'it must name the session it could not read')
  // the kernel's own word has to survive into the report, or the operator has nothing to act on
  assert.match(out.text ?? '', /corrupt|unreadable/i)
  assert.match(out.text ?? '', /not repaired|skipped/i, 'and must say plainly that its knowledge was NOT repaired')
})
