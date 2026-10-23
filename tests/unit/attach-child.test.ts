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
  /**
   * The gateway surface the BROWSER reads. It lists the child by default, because the rows that
   * care about persistence are not the rows that care about visibility — and a default that made
   * "quiet success" mean "we never checked" was the bug #57 hit. Pass `undefined` to assert the
   * loud unverified path, or a failing list to assert the omission.
   */
  gateway?: unknown
  attachImpl?: (id: string) => unknown
} = {}): { ports: AttachPorts; diagnostics: string[] } => {
  const diagnostics: string[] = []
  const registry = opts.registry === undefined ? undefined : opts.registry
  const gateway = opts.gateway === undefined ? { list: async () => [{ sessionId: 'ch-1' }] } : opts.gateway
  return {
    diagnostics,
    ports: {
      workspaceRegistry: registry as never,
      sessionQuery: opts.listSessions === undefined ? undefined as never : { listSessions: opts.listSessions } as never,
      sessionController: gateway as never,
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

/**
 * #56/#57 — WHICH surface omits the child is a different fact from "it is not listed", and it
 * decides where the fix goes. `sessionQuery.listSessions()` is the host's persistence corpus;
 * `sessionController.list()` is what the gateway hands the browser, and a session missing from
 * THAT is invisible and unopenable in the UI no matter how correct the durable state is. Measured
 * on 0.2.0-rc.2: the roster note said `MISSING, 1 sessions` while the attach check said listed —
 * the two surfaces disagreed, and the old single boolean could not see that.
 */
test('listed by persistence but absent from the gateway list is named as the gateway list', async () => {
  const h = harness({
    registry: { createCanonical: async () => ({ attachSession: () => undefined }) },
    listSessions: async () => [{ header: { id: 'ch-1' } }],
  })
  const ports = { ...h.ports, sessionController: { list: async () => [{ sessionId: 'parent' }] } } as never
  const r = await attachCreatedChild(ports)
  assert.equal(r.listed, true, 'persistence really does list it — that claim stays true')
  assert.equal(r.gatewayListed, false, 'and the surface the browser reads says otherwise')
  assert.match(r.warnings.join(' '), /gateway|sessionController\.list/,
    'the warning must name the surface that dropped it, not just "not listed"')
  assert.equal(h.diagnostics.length, 1)
})

test('both surfaces agreeing is silent, and no gateway port is an unverified claim', async () => {
  const h = harness({
    registry: { createCanonical: async () => ({ attachSession: () => undefined }) },
    listSessions: async () => [{ header: { id: 'ch-1' } }],
  })
  const both = await attachCreatedChild({ ...h.ports, sessionController: { list: async () => [{ sessionId: 'ch-1' }] } } as never)
  assert.equal(both.gatewayListed, true)
  assert.deepEqual(both.warnings, [], 'a child both surfaces show is a success, and success is quiet')

  // the absent-gateway case is NO LONGER quiet — see the dedicated row below; silence about an
  // unverified surface is what let "the gateway lists it" be inferred from an unchecked check.
  const none = await attachCreatedChild({ ...h.ports, sessionController: undefined } as never)
  assert.equal(none.gatewayListed, undefined, 'absent port = UNVERIFIED, never inferred good')
  assert.equal(none.warnings.length, 1, 'and unverified is delivered, not silent')
})

test('a gateway list that throws is reported as unverified, not as absence', async () => {
  const h = harness({
    registry: { createCanonical: async () => ({ attachSession: () => undefined }) },
    listSessions: async () => [{ header: { id: 'ch-1' } }],
  })
  const r = await attachCreatedChild({ ...h.ports, sessionController: { list: async () => { throw new Error('gateway timeout') } } } as never)
  assert.equal(r.gatewayListed, undefined, 'a failed LOOKUP is not a negative result')
  assert.match(r.warnings.join(' '), /gateway timeout|could not be verified/, 'and the failure is delivered')
})

test('no sessionController to ask is said out loud — silence here reads as success', async () => {
  // The 0.2.x investigation stalled for a round because an absent verification port returned
  // `gatewayListed: undefined` with NO warning, and "no warning" was read as "the gateway lists
  // it". Unverified is a state, and this repo's rule is that a detected gap gets delivered.
  const h = harness({
    registry: { createCanonical: async () => ({ attachSession: () => undefined }) },
    listSessions: async () => [{ header: { id: 'ch-1' } }],
  })
  const r = await attachCreatedChild({ ...h.ports, sessionController: undefined } as never)
  assert.equal(r.listed, true)
  assert.equal(r.gatewayListed, undefined)
  assert.equal(r.warnings.length, 1, `expected one unverified warning, got: ${JSON.stringify(r.warnings)}`)
  assert.match(r.warnings[0]!, /gateway/i, 'and it names the surface that could not be checked')
  assert.match(r.warnings[0]!, /could not be verified|unverified/i)
})
