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
import { readFileSync } from 'node:fs'
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
  // #180 — the DEFAULT gateway fixture is the MEASURED host shape, not an imagined array:
  // SessionController.list(_request, signal) resolves `SessionListValue = { items: SessionSummary[] }`
  // (docs/contract.md § The two session LIST surfaces). The old default was a bare array, which is
  // exactly the fiction that let `attach.ts` ship reading a shape the host never returns.
  const gateway = opts.gateway === undefined ? { list: async () => ({ items: [{ sessionId: 'ch-1' }] }) } : opts.gateway
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
  // #180 acceptance: the verdict itself goes to the SINK on the success path — the whole defect
  // was that the gateway check could only ever say "could not be verified". A readable
  // verification says what it verified, with the count.
  assert.equal(h.diagnostics.length, 1, `expected only the gateway verdict line, got: ${JSON.stringify(h.diagnostics)}`)
  assert.match(h.diagnostics[0]!, /^attach:gatewayList\|.*listed/)
  assert.match(h.diagnostics[0]!, /1 sessions/, 'and the verdict carries the session count')
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
  const ports = { ...h.ports, sessionController: { list: async () => ({ items: [{ sessionId: 'parent' }] }) } } as never
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
  const both = await attachCreatedChild({ ...h.ports, sessionController: { list: async () => ({ items: [{ sessionId: 'ch-1' }] }) } } as never)
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

/**
 * #180 — the browser-visibility check has been UNREADABLE on the real host since it shipped,
 * because `attach.ts` piped `sessionController.list()` into `.map` and the measured gateway
 * value is the `SessionListValue` **envelope** `{ items: SessionSummary[] }` — a truthy
 * non-array that `?? []` cannot catch. TypeError into the catch meant every verdict degraded to
 * "could not be verified". These rows pin the reader to BOTH measured surfaces (docs/contract.md
 * § The two session LIST surfaces): the result is always a verdict, never an exception.
 */
const persistenceOk = () => ({
  registry: { createCanonical: async () => ({ attachSession: () => undefined }) },
  listSessions: async () => [{ header: { id: 'ch-1' } }],
})

test('#180: the measured {items} envelope decides true and false, never throws', async () => {
  const h = harness(persistenceOk())
  const yes = await attachCreatedChild({ ...h.ports, sessionController: { list: async () => ({ items: [{ sessionId: 'parent' }, { sessionId: 'ch-1' }] }) } } as never)
  assert.equal(yes.gatewayListed, true)
  assert.deepEqual(yes.warnings, [])
  const no = await attachCreatedChild({ ...h.ports, sessionController: { list: async () => ({ items: [{ sessionId: 'parent' }] }) } } as never)
  assert.equal(no.gatewayListed, false, 'envelope minus the child is a real NEGATIVE, not an unreadable surface')
  assert.match(no.warnings.join(' '), /1 sessions/, 'and the count the browser would render is in the words')
})

test('#180: a bare array is still accepted (defensive — old fixtures, other hosts)', async () => {
  const h = harness(persistenceOk())
  const r = await attachCreatedChild({ ...h.ports, sessionController: { list: async () => [{ sessionId: 'ch-1' }] } } as never)
  assert.equal(r.gatewayListed, true)
})

test('#180: a non-callable ObservableSnapshot `list` reads through getSnapshot — the client face', async () => {
  // ISessions.list is `ObservableSnapshot<SessionListState>`: a PROPERTY, not a method.
  // If the port ever resolves that face, reading it as a callable would repeat the #180 failure
  // in the other direction; rosterIds() in doors.ts already proves the shape is readable.
  const h = harness(persistenceOk())
  const ids = await attachCreatedChild({ ...h.ports, sessionController: { list: { getSnapshot: () => ({ ids: ['parent', 'ch-1'] }) } } } as never)
  assert.equal(ids.gatewayListed, true, 'ids-list form')
  const byId = await attachCreatedChild({ ...h.ports, sessionController: { list: { getSnapshot: () => ({ byId: { parent: {}, 'ch-1': {} } }) } } } as never)
  assert.equal(byId.gatewayListed, true, 'byId-map form')
  const miss = await attachCreatedChild({ ...h.ports, sessionController: { list: { getSnapshot: () => ({ ids: ['parent'] }) } } } as never)
  assert.equal(miss.gatewayListed, false, 'and the negative still decides')
})

test('#180: list() RETURNING a snapshot object is read too (method and snapshot crossed)', async () => {
  const h = harness(persistenceOk())
  const r = await attachCreatedChild({ ...h.ports, sessionController: { list: async () => ({ getSnapshot: () => ({ ids: ['ch-1'] }) }) } } as never)
  assert.equal(r.gatewayListed, true)
})

test('#180: an unreadable result is UNVERIFIED with the received shape named — never a TypeError path', async () => {
  const h = harness(persistenceOk())
  const junk = await attachCreatedChild({ ...h.ports, sessionController: { list: async () => ({ nonsense: 1 }) } } as never)
  assert.equal(junk.gatewayListed, undefined, 'unknown shape = unknown verdict, not a false "not listed"')
  assert.match(junk.warnings.join(' '), /shape|object/, 'and the warning names what WAS received, so the next drift is diagnosable')
  const str = await attachCreatedChild({ ...h.ports, sessionController: { list: async () => 'not even an object' } } as never)
  assert.equal(str.gatewayListed, undefined)
  const noList = await attachCreatedChild({ ...h.ports, sessionController: { other: 1 } } as never)
  assert.equal(noList.gatewayListed, undefined, 'a service with no list member at all is the loud UNVERIFIED row')
  assert.match(noList.warnings.join(' '), /gateway/i)
})

test('#180 drift row: the shapes we read are pinned to the INSTALLED host types', async () => {
  // The measure-the-shape rule's own remedy (AGENTS): this row fails the day the host package
  // changes the list surface out from under attach.ts, instead of the sink silently losing the
  // verdict again for another release. Reads the SAME .d.ts files the rig compiles against.
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const svcTypes = read('../../dev/dsh-host-lock/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts')
  assert.match(svcTypes, /export interface SessionListValue\s*\{\s*readonly items: readonly SessionSummary\[\]/,
    'gateway SessionController.list resolves SessionListValue = { items: SessionSummary[] }')
  assert.match(svcTypes, /export interface SessionSummary\s*\{[^}]*readonly sessionId: SessionId/,
    'and the summary row keys the session by sessionId')
  const clientContract = read('../../dev/dsh-host-lock/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/sessions.d.ts')
  assert.match(clientContract, /readonly list: ObservableSnapshot<SessionListState>/,
    'the client face exposes list as a NON-CALLABLE ObservableSnapshot property')
  const clientSvc = read('../../dev/dsh-host-lock/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.d.ts')
  assert.match(clientSvc, /export interface SessionListState\s*\{[^}]*ids: SessionId\[\][^}]*byId: Record</,
    'and SessionListState carries ids + byId')
  const store = read('../../dev/dsh-host-lock/node_modules/@deepseek-ai/dsh-client-store/lib/types/contract.d.ts')
  assert.match(store, /getSnapshot\(\): T/, 'ObservableSnapshot is read via getSnapshot()')
})
