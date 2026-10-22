/**
 * Attaching a created child to the workspace, LOUDLY (#54).
 *
 * The door used to write `workspace?.attachSession?.(sessionId)` — two optional chains
 * around a step AGENTS records as load-bearing ("an unattached session was the whole
 * explanation for round 6's 'not listed'"). An optional chain through a REQUIRED step turns
 * a renamed host service into a silent no-op: on host 0.2.0-rc.2 the child is created,
 * durable, present in `session_projcache`… and absent from the sidebar after a reload, with
 * nothing anywhere saying why. The door still claimed success.
 *
 * So the step gets its own function, every failure mode gets a word in the result, and the
 * verification is the user-visible fact — is this session LISTED — not the absence of a
 * throw. Tested here rather than in a browser because every one of these branches is a
 * return value, and a browser can only show me the one that fires.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { attachCreatedChild, type AttachPorts } from '../../src/attach.ts'

const harness = (opts: {
  registry?: unknown
  listSessions?: () => Promise<Array<{ header?: { id?: string } }>>
  attachImpl?: (id: string) => unknown
} = {}): { ports: AttachPorts; diagnostics: string[] } => {
  const diagnostics: string[] = []
  const registry = opts.registry === undefined ? undefined : opts.registry
  return {
    diagnostics,
    ports: {
      workspaceRegistry: registry as never,
      sessionQuery: opts.listSessions === undefined ? undefined as never : { listSessions: opts.listSessions } as never,
      diagnostic: (where, message, error) => { diagnostics.push(`${where}|${message}|${String(error ?? '')}`) },
      childId: 'ch-1',
      cwd: '/work',
    },
  }
}

test('happy path: attached AND listed, no warning, no diagnostic', async () => {
  const attached: string[] = []
  const h = harness({
    registry: { createCanonical: async () => ({ attachSession: (id: string) => { attached.push(id) } }) },
    listSessions: async () => [{ header: { id: 'parent' } }, { header: { id: 'ch-1' } }],
  })
  const r = await attachCreatedChild(h.ports)
  assert.deepEqual(attached, ['ch-1'])
  assert.equal(r.attached, true)
  assert.equal(r.listed, true)
  assert.deepEqual(r.warnings, [], 'a success must not emit noise (the fork journey counts archive warnings)')
  assert.deepEqual(h.diagnostics, [])
})

test('a workspaceRegistry service that is ABSENT is said out loud', async () => {
  const h = harness({ registry: undefined, listSessions: async () => [{ header: { id: 'ch-1' } }] })
  const r = await attachCreatedChild(h.ports)
  assert.equal(r.attached, false)
  assert.equal(r.warnings.length, 1, 'the door result carries it, so the user sees a half-worked fork')
  assert.match(r.warnings[0]!, /workspaceRegistry/, 'and names the missing service, not a vague "attach failed"')
  assert.equal(h.diagnostics.length, 1)
  assert.match(h.diagnostics[0]!, /attach/)
})

test('a createCanonical return WITHOUT attachSession is reported, not skipped (the 0.2.x shape change)', async () => {
  // exactly the hypothesis behind tonight's orphaned children: the host renamed or moved
  // the method, the optional chain quietly did nothing, and the child never appeared.
  const h = harness({
    registry: { createCanonical: async () => ({ someOtherMethod: () => undefined }) },
    listSessions: async () => [{ header: { id: 'ch-1' } }],
  })
  const r = await attachCreatedChild(h.ports)
  assert.equal(r.attached, false)
  assert.match(r.warnings[0]!, /attachSession/, 'the missing METHOD is named')
  assert.match(r.warnings[0]!, /createCanonical|returned/, 'and says which call did not provide it')
  assert.equal(h.diagnostics.length, 1)
})

test('an attach that THROWS is recorded with its error, and the door still completes', async () => {
  const h = harness({
    registry: { createCanonical: async () => ({ attachSession: () => { throw new Error('workspace locked') } }) },
    listSessions: async () => [{ header: { id: 'ch-1' } }],
  })
  const r = await attachCreatedChild(h.ports)
  assert.equal(r.attached, false)
  assert.match(r.warnings[0]!, /workspace locked/)
  assert.match(h.diagnostics[0]!, /workspace locked/, 'the sink keeps what the composer only summarizes')
})

test('ATTACHED is not LISTED — the user-visible fact is what gets verified', async () => {
  const h = harness({
    registry: { createCanonical: async () => ({ attachSession: () => undefined }) },
    listSessions: async () => [{ header: { id: 'parent' } }],
  })
  const r = await attachCreatedChild(h.ports)
  assert.equal(r.attached, true)
  assert.equal(r.listed, false)
  assert.match(r.warnings.join(' '), /not listed|does not appear/i,
    'the child is durable and invisible — that is precisely the state a user must be told about')
  assert.equal(h.diagnostics.length, 1)
})

test('no sessionQuery means no verification, and it SAYS so instead of implying success', async () => {
  const h = harness({ registry: { createCanonical: async () => ({ attachSession: () => undefined }) } })
  const r = await attachCreatedChild(h.ports)
  assert.equal(r.attached, true)
  assert.equal(r.listed, undefined, 'undefined = UNVERIFIABLE, which is not the same as false')
  assert.match(r.warnings.join(' '), /unverified|could not verify/i)
})

test('a listing that arrives LATE is waited for, briefly — not assumed broken on the first look', async () => {
  let calls = 0
  const h = harness({
    registry: { createCanonical: async () => ({ attachSession: () => undefined }) },
    listSessions: async () => { calls += 1; return calls >= 2 ? [{ header: { id: 'ch-1' } }] : [] },
  })
  const r = await attachCreatedChild({ ...h.ports, pollIntervalMs: 1, pollBudgetMs: 200 })
  assert.equal(r.listed, true, 'a workspace that catches up within the budget is a success')
  assert.ok(calls >= 2, 'and it took more than one look')
  assert.deepEqual(r.warnings, [])
})

test('the createCanonical call itself failing is reported once, with its reason', async () => {
  const h = harness({
    registry: { createCanonical: async () => { throw new Error('no such workspace') } },
    listSessions: async () => [{ header: { id: 'ch-1' } }],
  })
  const r = await attachCreatedChild(h.ports)
  assert.equal(r.attached, false)
  assert.match(r.warnings[0]!, /no such workspace/)
  assert.equal(h.diagnostics.length, 1)
})
