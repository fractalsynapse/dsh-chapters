/**
 * Arrival-time artifacting against a session shim that EMULATES the kernel's
 * surfaceOp replace (real sessions apply it; the r28 lesson demands the fake
 * mirror the real shape or the test proves nothing).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyArrivalStubs, ARRIVAL_MARKER } from '../../src/arrival.ts'
import { artifactPath, sha256 } from '../../src/render.ts'

interface Ev { type: string; data: any }
function fakeSession(events: Map<number, Ev>) {
  const appended: { type: string; data: any; opts?: any }[] = []
  return {
    session: {
      get surface() { return { nodes: [...events.keys()] } },
      eventAt: (seq: number) => events.get(seq),
      append(type: string, data: any, opts?: any) {
        appended.push({ type, data, opts })
        const op = opts?.surfaceOp
        if (op?.op === 'replace' && op.startSeq === op.endSeq) {
          events.set(op.startSeq, { type, data }) // kernel semantics: node content swapped in place
        }
        return { seq: 9000 + appended.length }
      },
    },
    appended,
  }
}

const est = (m: unknown): number => Math.ceil(JSON.stringify(m).length / 4)

test('over-floor tool/result lands as artifact + stub pair; below-floor untouched; second pass no-ops', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'))
  const big = 'research document '.repeat(4000) // ~28K chars => ~7K tok by est; floor 3000
  const small = 'ok'
  const events = new Map<number, Ev>([
    [1, { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'go' }] } } }],
    [2, { type: 'tool/result', data: { message: { source: { callId: 'c2' }, role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c2', isError: false, content: [{ type: 'text', text: big }] }] } } }],
    [3, { type: 'tool/result', data: { message: { source: { callId: 'c3' }, role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c3', isError: false, content: [{ type: 'text', text: small }] }] } } }],
  ])
  const { session, appended } = fakeSession(events)
  const r = await applyArrivalStubs(session, { cwd, storeRoot: '.dsh-chapters', floorTokens: 3000, estimate: est })
  assert.deepEqual(r, { stubbed: 1 })
  const rel = artifactPath(sha256(big))
  assert.equal(fs.readFileSync(path.join(cwd, '.dsh-chapters', rel), 'utf8'), big, 'artifact carries exact bytes')
  assert.equal(appended.length, 2, 'prune + replacement pair')
  assert.equal(appended[0]!.type, 'compaction/prune')
  assert.deepEqual(appended[0]!.data.shadowedSeqs, [2])
  assert.deepEqual(appended[1]!.opts.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 })
  assert.deepEqual(appended[1]!.opts.sourceEventSeqs, [2])
  const stub = String(((events.get(2) as Ev).data.message.content[0] as any).content[0].text)
  assert.ok(stub.includes(ARRIVAL_MARKER) && stub.includes(rel) && stub.includes('chapters_artifact'), stub.slice(0, 160))
  assert.equal(((events.get(3) as Ev).data.message.content[0] as any).content[0].text, 'ok', 'small node untouched')
  const r2 = await applyArrivalStubs(session, { cwd, storeRoot: '.dsh-chapters', floorTokens: 3000, estimate: est })
  assert.equal(r2.stubbed, 0, 'idempotent: the stub is small and marker-carrying')
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('non-text blocks survive the stub', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'))
  const big = 'x'.repeat(30_000)
  const events = new Map<number, Ev>([
    [1, { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x', content: [{ type: 'text', text: big }] }, { type: 'image', bytes: '…' }] } } }],
  ])
  const { session } = fakeSession(events)
  await applyArrivalStubs(session, { cwd, storeRoot: '.dsh-chapters', floorTokens: 3000, estimate: est })
  const content = (events.get(1) as Ev).data.message.content as any[]
  assert.equal(content.length, 2, 'image + stubbed wrapper')
  assert.equal(content[0]!.type, 'image', 'non-tool-result blocks preserved')
  assert.equal(content[1]!.type, 'tool-result', 'wrapper survives with nested stub')
  assert.ok(String(content[1]!.content[0].text).includes('[dsh:artifact'))
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('disk failure degrades to inline (loud detail), never throws', async () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-')), 'blocker')
  fs.writeFileSync(blocker, 'not a directory')
  const events = new Map<number, Ev>([
    [1, { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'z', content: [{ type: 'text', text: 'y'.repeat(30_000) }] }] } } }],
  ])
  const { session, appended } = fakeSession(events)
  const r = await applyArrivalStubs(session, { cwd: blocker, storeRoot: 'nope', floorTokens: 3000, estimate: est })
  assert.equal(r.stubbed, 0)
  assert.match(String(r.detail), /artifact write failed/)
  assert.equal(appended.length, 0, 'nothing half-committed')
  assert.equal(((events.get(1) as Ev).data.message.content[0] as any).content[0].text.length, 30_000, 'blob stays inline')
})

/**
 * #78 — the shape the pinned host actually writes.
 *
 * The nested wrapper this file was built around is the 0.1.x shape, and its comment says the flat
 * one "hid a whole run" — the drift has since gone the OTHER way. Measured 2026-10-22 in the
 * arrival leg's own durable log (host 0.2.0-rc.2): seq 51, 54,763 bytes, `message.content` =
 * `[{ type: 'text', text: … }]`, block keys `type,text`, and `message` keys
 * `role,source,toolCallId,content,isError,id`. A filter that keeps only `type === 'tool-result'`
 * therefore found NO carriers in any result and stubbed nothing — silently, with `detail` unset —
 * which is why every leg could report "no arrival pair" while the engine entry line proved the
 * hook was running. Both shapes are first-class now; neither is inferred.
 */
test('the 0.2.x flattened tool/result is stubbed too (measured shape, not a guess)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-v4-'))
  const big = 'host 0.2.x flattened content '.repeat(3000) // ~84K chars ⇒ ~21K tok by est; floor 3000
  const events = new Map<number, Ev>([
    [1, { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'read it all' }] } } }],
    [2, {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool', source: { kind: 'tool', callId: 'c2' }, toolCallId: 'c2', isError: false, id: 'm2',
          content: [{ type: 'text', text: big }],
        },
      },
    }],
  ])
  const { session, appended } = fakeSession(events)
  const r = await applyArrivalStubs(session, { cwd, storeRoot: '.dsh-chapters', floorTokens: 3000, estimate: est })
  assert.equal(r.stubbed, 1, `a flattened text block is exactly what the host writes now: ${JSON.stringify(r)}`)
  assert.equal(r.detail, undefined, 'and nothing went wrong on the way')
  const rel = artifactPath(sha256(big))
  assert.equal(fs.readFileSync(path.join(cwd, '.dsh-chapters', rel), 'utf8'), big, 'exact bytes to the artifact')
  assert.deepEqual(appended.map((a: any) => a.type), ['compaction/prune', 'tool/result'], 'same pair as the nested shape')
  const after = (events.get(2) as Ev).data.message.content as any[]
  assert.equal(after[0]!.type, 'text', 'the block keeps its OWN type — a v4 reader must still parse it')
  assert.ok(String(after[0]!.text).includes(ARRIVAL_MARKER) && String(after[0]!.text).includes(rel),
    `stub marker and citation must be in place: ${String(after[0]!.text).slice(0, 140)}`)
  const again = await applyArrivalStubs(session, { cwd, storeRoot: '.dsh-chapters', floorTokens: 3000, estimate: est })
  assert.equal(again.stubbed, 0, 'idempotent across shapes as well')
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('a result with no text carrier at all is left alone, quietly and correctly', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-none-'))
  const events = new Map<number, Ev>([
    [2, { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'image', source: { url: 'x' } }] } } }],
  ])
  const { session, appended } = fakeSession(events)
  const r = await applyArrivalStubs(session, { cwd, storeRoot: '.dsh-chapters', floorTokens: 1, estimate: est })
  assert.equal(r.stubbed, 0)
  assert.equal(appended.length, 0, 'no carriers means no prune and no replacement, not a stub of nothing')
  fs.rmSync(cwd, { recursive: true, force: true })
})

/**
 * A `chapters_artifact` result is the ANSWER to a query, not a tool result to economize (#131).
 *
 * Measured in the `arrival` leg's own durable log: reading a stored blob returned ANOTHER arrival stub pointing at
 * another artifact — `-> [dsh:artifact 4b85a272127c] 5.5 KB ≈ 1423 tok stored at artifacts/4b/…txt — query it with
 * chapters_artifact` — so the store became unreachable at exactly the sizes it exists for, and the model called the
 * tool 20 times before the leg gave up. Whether the cycle started depended on how large a range the model happened
 * to ask for, which is why this leg looked like a flake for a day.
 */
test('an artifact answer is never stubbed, while an ordinary oversized read still is', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-exempt-'))
  try {
    const big = 'retrieved chapter body '.repeat(3000) // well over the 300-tok floor below
    const events = new Map<number, Ev>([
      [1, { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'query the store' }] } } }],
      [2, { type: 'tool/call', data: { callId: 'c-read', name: 'read', arguments: '{"file_path":"big.md"}' } }],
      [3, { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c-read' }, role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c-read', isError: false, content: [{ type: 'text', text: big }] }] } } }],
      [4, { type: 'tool/call', data: { callId: 'c-art', name: 'chapters_artifact', arguments: '{"action":"read","path":"artifacts/ab/abcd.txt"}' } }],
      [5, { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c-art' }, role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c-art', isError: false, content: [{ type: 'text', text: big }] }] } } }],
    ])
    const { session } = fakeSession(events)
    const r = await applyArrivalStubs(session, { cwd, storeRoot: '.dsh-chapters', floorTokens: 300, estimate: est })
    assert.equal(r.stubbed, 1, `only the ordinary read may be deferred: got ${String(r.stubbed)}`)
    const readText = String(((events.get(3) as Ev).data.message.content[0] as any).content[0].text)
    const artText = String(((events.get(5) as Ev).data.message.content[0] as any).content[0].text)
    assert.ok(readText.includes(ARRIVAL_MARKER), 'the oversized read is stubbed as designed (the exemption is not a widening)')
    assert.equal(artText, big, 'the artifact answer arrives verbatim — a stub here is a cycle, not economy')
    assert.ok(!artText.includes(ARRIVAL_MARKER), 'and specifically never a pointer to another artifact')
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})
