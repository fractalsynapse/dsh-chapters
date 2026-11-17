/**
 * #399 — the composer's host-shape gate.
 *
 * The headliner audit finding was the r28 failure class running inside the compaction composer:
 * `reconstructShadowedSeqs` read `surface.nodes` as `{seq}[]` (the host publishes a plain NUMBER array,
 * `dsh-session` lib/types/surface.d.ts:120) and captured `deriveEventMessage` into a local (the host
 * method resolves projections through `this`, lib/index.js:1576). Both errors were invisible because
 * every test stubbed the invented shape, and the silent null fell to the legacy single-chapter path —
 * so on real hosts, pressure compaction never composed topic chapters.
 *
 * Row 1 hands the function a session built by the INSTALLED kernel class — the only stub that cannot
 * lie about shape. Row 2 pins the host source text so a future rename or re-shape fails HERE, and
 * inventories the plugin's deprecated live reads (eventAt/snapshotEvents/ownEvents are all
 * `@deprecated — new calls are prohibited` at 0.2.0-rc.2; the migration is tracked, never invisible).
 * If the host packages do not resolve, the row says SKIP in its NAME — an unmeasured gate must never
 * look like a passed one (the `host-seed-contract` pattern).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { reconstructShadowedSeqs } from '../../src/engine-core.ts'

const kernel = await import('@deepseek-ai/dsh-session').catch(() => null)
const ready = kernel !== null
const guard = ready ? 'RUN' : 'SKIP'
const skipReason = ready ? false : '@deepseek-ai/dsh-session not installed (devDependency drift — bump to the live host line)'

const T = 1_794_600_000_000
const human = (seq: number, text: string): Record<string, unknown> => ({
  type: 'user/message', seq, time: T + seq, surfaceOp: 'append',
  data: { id: `hc-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

test(`${guard} — the INSTALLED kernel session: nodes are plain seqs and the composer maps against them (#399)`,
  { skip: skipReason }, () => {
    assert.ok(kernel !== null)
    const built = [
      { type: 'turn/start', seq: 0, time: T, data: { turn: 1 } },
      human(1, 'rebuild the sync loop copy-out'),
      { type: 'turn/end', seq: 2, time: T + 2, data: { turn: 1 } },
      human(3, 'document the rules tier'),
      { type: 'turn/end', seq: 4, time: T + 4, data: { turn: 1 } },
    ]
    const session = kernel.Session.create(kernel.SessionId('ch-399-shape'), built as never, undefined, 0)
    const nodes = [...session.surface.nodes]
    // The shape fact the audit found violated — stated against the real class, not a stub:
    assert.ok(nodes.length > 0, 'the kernel surfaced the human messages')
    assert.ok(nodes.every((n: unknown) => typeof n === 'number'),
      `SessionSurface.nodes must stay a plain seq array (got ${JSON.stringify(nodes)}) — if the host reshaped this, engine-core must follow HERE, not silently in production`)
    assert.equal((nodes[0] as { seq?: unknown }).seq, undefined,
      'control: .seq on a node is undefined on the REAL class — the exact access the fix retired')

    // The mapping, over the host's own derived messages (buildSummarizationInput's construction):
    const region = nodes
      .map((s: number) => session.deriveEventMessage(session.eventAt(s)!))
      .filter((m: unknown) => m !== null)
    const r = reconstructShadowedSeqs(session as never, { messages: region })
    assert.deepEqual(r, { ok: true, seqs: [...nodes] }, 'the composer maps the region back exactly on the real class')
  })

// ─────────────────────────────────────── drift guard on the installed host source text

const DSH = 'node_modules/@deepseek-ai/dsh-session'
const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

test('#399: the host source still says numbers, a bound method, and deprecated live reads', () => {
  const surface = read(`${DSH}/lib/types/surface.d.ts`)
  assert.match(surface, /readonly nodes: readonly SessionSeq\[\]/,
    'SessionSurface.nodes declaration changed shape — re-verify reconstructShadowedSeqs against it NOW')
  const types = read(`${DSH}/lib/types/types.d.ts`)
  assert.match(types, /export type SessionSeq = BrandedNumber/,
    'SessionSeq is no longer a branded number — the composer\'s node iteration must be re-derived from the host, not assumed either way')
  const index = read(`${DSH}/lib/types/index.d.ts`)
  assert.match(index, /deriveEventMessage\(event: SessionEvent\): Message \| null;/,
    'deriveEventMessage is not the class method the fix binds to — re-check the call site')
  assert.match(index, /@deprecated[\s\S]{0,420}eventAt\(/, 'eventAt lost (or gained) its deprecation — update the migration inventory')
  assert.match(index, /@deprecated[\s\S]{0,520}snapshotEvents\(/, 'snapshotEvents same')
})

test('#399: the deprecated live reads have exactly the inventoried consumers — new ones must be reviewed, not bolted on', () => {
  const EXPECTED = [
    'arrival.ts', 'auto-save.ts', 'commands.ts', 'engine-core.ts', 'engine.ts', 'index.ts',
    'prompt-runner.ts', 'reload-check.ts', 'session-rules.ts', 'tools.ts',
  ].sort()
  const hits = new Set<string>()
  for (const f of readdirSync(join(process.cwd(), 'src'))) {
    if (!f.endsWith('.ts')) continue
    if (/\.(snapshotEvents|eventAt|ownEvents)\s*(\?\.)?\(/.test(read(`src/${f}`))) hits.add(f)
  }
  assert.deepEqual([...hits].sort(), EXPECTED,
    'eventAt/snapshotEvents/ownEvents are @deprecated host reads ("new calls are prohibited"). A NEW consumer is a migration debt owed; a GONE one means retire it from the inventory here as it is migrated to deriveMessages/requestHeader/readSession.')
})
