/**
 * Issue #47 verification round — the REAL plugin reacting to the REAL emitter.
 *
 * Same zero-token fake-provider trick as the facts spike (FINDINGS §Reproduce),
 * but this round exists to prove PRODUCTION WIRING: the plugin's host-plane
 * apply() armed the subagent-end listener, and when a chapters-preset child
 * settles through the service, the plugin itself — not a test double — writes
 * chapters with lineage frontmatter and commits registry rows, in a scratch
 * workspace under the scratch home.
 *
 * Asserts (writes JSON, self-exits):
 *   V1  plugin armed the listener (boot log line presence is not enough — we
 *       verify by OBSERVED EFFECT)
 *   V2  chapter files exist at <probe-workspace>/.dsh-chapters/<child>/chapters/
 *   V3  frontmatter carries subagent: true + parentSession: <parentId>
 *   V4  registry state for the child holds the chapter records (search door
 *       reads these)
 *   V5  a SECOND settlement of the same child adds nothing (watermark, live)
 *   V6  a non-chapters child (agentPreset: 'standard') produces NO files
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { acquireChapterStore } from '../../../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-47b.json')
const report = { round: '47b-listener', startedAt: new Date().toISOString(), probes: [], notes: [], dirs: [] }
const writeOut = () => { try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch { /* monitor */ } }
const record = (name, ok, details = {}) => { report.probes.push({ name, ok, ...details }); writeOut() }
const note = (s) => { report.notes.push(String(s)); writeOut() }
const finish = (code = 0) => { report.finishedAt = new Date().toISOString(); writeOut(); setTimeout(() => process.exit(code), 50).unref() }

const mkTurn = (turn, text) => [
  { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `task ${turn}: ${text}` }] },
  { message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'probe', model: 'fake' }, content: [{ type: 'text', text: `${text} ANSWER-${turn}` }] }, turn, step: turn },
  { reason: { kind: 'completed' }, turn },
]

export const name = 'dsh-chapters-probe-subagent-end'
export const inject = ['agents', 'storageDomain', 'sessionQuery']

export function apply(ctx) {
  const guard = setTimeout(() => { note('GUARD 150s'); finish(1) }, 150_000)
  guard.unref?.()
  const run = async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'probe47-ws-'))
    report.dirs.push(workspace)

    const subagents = ctx.get?.('agents') === undefined ? null : (ctx.get?.('subagents') ?? null)
    if (subagents === null) { record('subagents-service', false); finish(); return }

    const pId = `p47b-${randomUUID().slice(0, 8)}`
    const ph = await ctx.agents.create({ sessionId: pId, seed: [], meta: { cwd: workspace, isSeeded: false }, agentOptions: {} })
    const parent = ph.agent

    const settled = []
    const seenIds = new Set()
    const childIds = {}
    let turnCount = 0
    const provider = {
      name: 'probe-verify-47b',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      async start(request) {
        const childId = randomUUID()
        const preset = childIds.purpose === 'negative' ? 'standard' : 'chapters'
        childIds.last = childId
        const ch = await request.parent.ctx.agents.create({
          sessionId: childId,
          parentAgent: request.parent,
          meta: { cwd: workspace, isSeeded: false, agentPreset: preset, parentSession: parent.session.id, origin: 'subagent', delegationDepth: 1 },
          agentOptions: {},
          setup: () => {},
        })
        const session = ch.agent.session
        const append = session.append.bind(session)
        append('turn/start', { turn: 1 })
        append('step/start', { turn: 1, step: 1 })
        const t = mkTurn(1, `verify child work ${randomUUID().slice(0, 8)}`)
        append('user/message', t[0], { surfaceOp: 'append' })
        append('assistant/message', t[1], { surfaceOp: 'append' })
        append('step/end', { turn: 1, step: 1 })
        append('turn/end', t[2])
        turnCount = 1
        return {
          id: childId,
          localAgent: ch.agent,
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'DONE' }] }),
          async dispose() { await ch.dispose?.() },
        }
      },
    }
    subagents.registerProvider(provider)
    ctx.on('subagent/end', (info) => { settled.push(info.id) })

    // ---- V2-V4: positive child settles; the PLUGIN (not this probe) must archive
    const run1 = await subagents.start('probe-verify-47b', {
      label: 'verify47b', prompt: [{ type: 'text', text: 'go' }], parent, signal: new AbortController().signal,
    })
    await new Promise((r) => setTimeout(r, 400)) // settle + chained plugin save
    const childId = childIds.last
    const treeDir = path.join(workspace, '.dsh-chapters', childId, 'chapters')
    let files = []
    try { files = fs.readdirSync(treeDir) } catch { /* recorded below */ }
    record('V2-chapter-files-written', files.length >= 1, { files, treeDir })

    const md = files.length > 0 ? fs.readFileSync(path.join(treeDir, files[0]), 'utf8') : ''
    const head = md.slice(0, md.indexOf('\n---\n', 4) + 1)
    record('V3-lineage-frontmatter', /subagent: true/.test(head) && head.includes(`parentSession: ${JSON.stringify(pId)}`), { head: head.slice(0, 500) })

    const { store } = await acquireChapterStore(ctx.get('storageDomain'))
    const state = await store.get(childId)
    record('V4-registry-rows', state.chapters.length >= 1, {
      chapters: state.chapters.map((c) => ({ number: c.number, range: [c.startSeq, c.endSeq], path: c.path })),
      rootSession: state.rootSession, parentSession: state.parentSession,
    })
    record('V1-listener-effect', settled.includes(childId) && state.chapters.length >= 1, { settled })

    // ---- V5: re-settlement (continuable-style second epoch) — watermark adds nothing
    const before = state.chapters.length
    const session2 = ctx.get('agents').get(childId) // likely gone (disposed) — that is fine, durable arm
    note(`live handle on child at re-settle: ${session2 !== undefined}`)
    const run2 = await subagents.start('probe-verify-47b', {
      label: 'verify47b-2', prompt: [{ type: 'text', text: 'again' }], parent, signal: new AbortController().signal,
    })
    await new Promise((r) => setTimeout(r, 400))
    const child2 = childIds.last // NOTE: start() makes a NEW child; for a true same-child re-settle we would reuse — the WATERMARK same-child case is pinned deterministically in tests/integration; here we verify a fresh child also archives cleanly:
    const files2 = (() => { try { return fs.readdirSync(path.join(workspace, '.dsh-chapters', child2, 'chapters')) } catch { return [] } })()
    record('V5-second-child-archives-too', files2.length >= 1, { files2, firstChildChaptersBefore: before })

    // ---- V6: non-chapters child → NO files anywhere for it
    childIds.purpose = 'negative'
    const run3 = await subagents.start('probe-verify-47b', {
      label: 'verify47b-negative', prompt: [{ type: 'text', text: 'nope' }], parent, signal: new AbortController().signal,
    })
    await new Promise((r) => setTimeout(r, 400))
    const negId = childIds.last
    const negDir = path.join(workspace, '.dsh-chapters', negId)
    record('V6-non-chapters-child-skipped', !fs.existsSync(negDir), { negDir, exists: fs.existsSync(negDir) })

    try { await run1.dispose?.() } catch { /* probe */ }
    try { await run2.dispose?.() } catch { /* probe */ }
    try { await run3.dispose?.() } catch { /* probe */ }
    try { await ph.dispose?.() } catch { /* probe */ }
    finish()
  }
  run().catch((error) => { note('FATAL ' + String(error?.stack ?? error)); finish(1) })
}
