/**
 * #319 part 3b — the /chapters-restore command, extracted so its HUMAN-facing strings live
 * outside the prompt-anchor surface (the guard counts string literals in files that author
 * what the model sees; a HostCommand description never reaches the model — a tool description
 * does). The behavior itself is the tested runRestoreHandler; this file only wires the machine
 * seams in, and refuses targets whose durable header says they belong to another workspace.
 */
import path from 'node:path'
import { findDurableLogDir, decodeDurableLog } from './durable-log.ts'
import { runRestoreHandler } from './restore.ts'
import { continueFromRestored } from './continue-core.ts'

export interface RestoreCommandDeps {
  store: { sessions(): IterableIterator<[string, unknown]>; get(id: string): Promise<{ rootSession: string }> }
  /** opaque to this file — it is passed through to runRepair/continueFromRestored; only its existence is wired here */
  config: { artifactStoreRoot: string }
  portsFor(caller: unknown): Promise<unknown>
  runRepair(ports: unknown, opts: unknown): Promise<{ applied: unknown[]; journalId: string; findingsBefore: Array<{ remedy?: string }>; findingsAfter: unknown[] }>
  /** the caller agent type is structural: only session.header.cwd and the ports are used */
}

export function makeRestoreCommand(deps: RestoreCommandDeps): {
  name: string
  description: string
  input: { hint: string }
  handler(invocation: { agent: unknown; rawInput?: string }): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
} {
  const { store, config, portsFor, runRepair } = deps
  return {
    name: 'chapters-restore',
    description: 'Continue past a session the host cannot load: re-derive its archive from the durable log and create a continuation citing it. Dry-run by default; the word apply repairs (journalled) and creates.',
    input: { hint: '<sessionId> [dry-run|apply]' },
    async handler(invocation) {
      const cwd0 = (invocation.agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd ?? ''
      if (cwd0 === '') return { kind: 'error', text: 'chapters-restore: this session has no workspace cwd \u2014 the store cannot be located' }
      const parts = (invocation.rawInput ?? '').trim().split(/\s+/).filter((x) => x.length > 0)
      let ports: unknown = null
      try { ports = await portsFor(invocation.agent) } catch { ports = null }
      const rootsOfProject = async (): Promise<string[]> => {
        const out: string[] = []
        for (const [id] of store.sessions()) {
          const d = findDurableLogDir(id)
          const dec = d === null ? null : decodeDurableLog(d)
          if (dec?.header?.cwd !== undefined && path.resolve(String(dec.header.cwd)) === path.resolve(cwd0)) out.push((await store.get(id)).rootSession)
        }
        return out
      }
      try {
        const text = await runRestoreHandler({
          rows: () => Object.fromEntries(Array.from(store.sessions()).map(([id]) => [id, null])),
          dirFor: (id) => { const d = findDurableLogDir(id); return d === null ? null : decodeDurableLog(d) },
          repair: async (id, dryRun) => {
            const d = findDurableLogDir(id)
            const dec = d === null ? null : decodeDurableLog(d)
            if (dec === null || dec === undefined) throw new Error('no durable log inside the handler \u2014 the outer check should have refused first')
            const hcwd = dec.header?.cwd
            if (hcwd === undefined || path.resolve(String(hcwd)) !== path.resolve(cwd0)) {
              throw new Error(`the target belongs to ${String(hcwd ?? 'an unknown workspace')}, not this project (${cwd0}) \u2014 run chapters-restore from the target\u2019s own session`)
            }
            const out = await runRepair(
              { store, readLog: async () => dec.events, cwd: cwd0, config, knownRoots: await rootsOfProject(), log: () => {}, warn: () => {} },
              { sessionId: id, classes: 'all', dryRun },
            )
            if (dryRun) {
              const actionable = out.findingsBefore.filter((f) => f.remedy !== 'report-only').length
              return `${String(actionable)} actionable finding(s) would be re-derived (${String(out.findingsBefore.length)} total, report-only classes unchanged)`
            }
            return `${String(out.applied.length)} move(s) journalled ${out.journalId}; ${String(out.findingsAfter.length)} finding(s) remain`
          },
          create: async (id) => {
            if (ports === null) throw new Error('ports unavailable \u2014 this invocation has no continuation seam')
            const r = await continueFromRestored(ports as never, config as never, id)
            if (!r.ok) throw new Error(r.reason)
            return r.childId
          },
        }, parts[0] ?? '', parts.slice(1))
        return { kind: 'success', text }
      } catch (error) {
        // refusals from the injected seams (foreign-project target, budget, kernel) arrive as
        // text the operator must see, not a stack the host would only log.
        return { kind: 'error', text: `chapters-restore: ${String((error as Error)?.message ?? error)}` }
      }
    },
  }
}
