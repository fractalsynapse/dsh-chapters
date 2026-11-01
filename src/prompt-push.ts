/**
 * The push transport (#194): the bar's state as a durable plugin record + a projection fold.
 *
 * Probe-verified on host 0.2.1-rc.5 (spikes/push-probe/FINDINGS.md — four real boots):
 *  - `appendPluginRecord` commits `ignorable: true` records; unknown `plugin:` types are skipped by
 *    readers and rendered by nothing, so the steady state writes ZERO history nodes.
 *  - The function MUST come from the host's own module instance: the plugin's own copy at the
 *    IDENTICAL version throws `Receiver must be an instance of class Session` against a host
 *    session, and a bare import from a `link:` install resolves by realpath into the source tree
 *    (on a dev machine: a different host checkout than the running server). Hence the host-anchored
 *    createRequire recipe below, one try behind try/catch, failure = pull fallback for the process.
 *  - The projection is registered ONLY when the writer resolved — registration is the feature
 *    signal the client reads through the standard `useProjection` seat (undefined ⇒ pull schedule).
 */
import { createRequire } from 'node:module'
import { z } from 'zod'

/** The record grammar: lowercase segments, each starting with a letter or digit (host grammar). */
export const PROMPT_RECORD_TYPE = 'plugin:dsh-chapters/prompt'

/** Projection key — shared with the client through ONE module (src/prompt-keys.ts), never retyped. */
export { PROMPT_PROJECTION_KEY } from './prompt-keys.ts'
import { PROMPT_PROJECTION_KEY } from './prompt-keys.ts'

/** The bar's durable facts, versioned. `v` rides along so a future shape never folds into a lie. */
export interface PromptPushPayload {
  v: 1
  status: 'off' | 'analyzing' | 'ready' | 'failed'
  text: string
  turnSeq: number | null
  error: string
  intent: 'worker-step' | 'goal-edit'
  goalRevision: number | null
  autorun: 'armed' | 'disarmed'
  at: string
}

export function promptRecordPayload(facts: Omit<PromptPushPayload, 'v'>): PromptPushPayload {
  return { v: 1, ...facts }
}

/** Projection fold: ours last-wins (each record carries the WHOLE state), anything else is not ours. */
export function foldPromptRecord(state: PromptPushPayload | null, event: { type?: unknown; data?: unknown } | null | undefined): PromptPushPayload | null {
  if (event === null || event === undefined) return state
  if (event.type !== PROMPT_RECORD_TYPE) return state
  const d = event.data as Partial<PromptPushPayload> | undefined
  if (d === undefined || d === null || d.v !== 1 || typeof d.status !== 'string') return state
  return d as PromptPushPayload
}

/**
 * The projection definition, duck-typed schemas included (the probe measured that the host's
 * register accepts `{parse}` shapes; zod is not required and would be a second schema system here).
 * Kept a value builder so the wiring can register it only when the writer resolved.
 */
const promptPayloadSchema = z.object({
  v: z.literal(1),
  status: z.enum(['off', 'analyzing', 'ready', 'failed']),
  text: z.string(),
  turnSeq: z.number().nullable(),
  error: z.string(),
  intent: z.enum(['worker-step', 'goal-edit']),
  goalRevision: z.number().nullable(),
  autorun: z.enum(['armed', 'disarmed']),
  at: z.string(),
})

/**
 * #218: REAL zod schemas, like the goal projection — the duck-typed `{parse}` shapes passed the
 * server-side fold (the probe measured `stateOf` working) but the CLIENT delivery validates
 * through `wire.viewSchema`, and an object that is not a real schema can fail that validation
 * silently — killing the one hop this transport exists to provide. Same shape as the goal
 * definition: stateSchema, init, apply, wire, stateVersion.
 */
export function promptProjectionDefinition(): unknown {
  return {
    key: PROMPT_PROJECTION_KEY,
    stateSchema: promptPayloadSchema.nullable(),
    init: (): PromptPushPayload | null => null,
    apply: (state: PromptPushPayload | null, event: unknown) => foldPromptRecord(state, event as { type?: unknown; data?: unknown }),
    wire: { viewSchema: promptPayloadSchema.nullable(), view: (s: PromptPushPayload | null) => s },
    stateVersion: 2,
  }
}

export interface PushWriter {
  append(session: unknown, payload: PromptPushPayload): boolean
}

/**
 * Resolve the host's own `appendPluginRecord`, or nothing. The anchor is the host binary
 * (`process.argv[1]`), NOT this module's resolution scope — the probe measured every alternative
 * failing (own copy: foreign class; bare import: realpath into the source tree). Injectable seams
 * for tests; a production call passes nothing and reads the process.
 */
export async function resolvePushWriter(seams?: {
  anchor?: string
  requireFn?: (anchor: string) => { resolve(spec: string): string }
  importFn?: (resolved: string) => Promise<Record<string, unknown>>
  log?: (message: string) => void
}): Promise<PushWriter | null> {
  const anchor = seams?.anchor ?? process.argv[1] ?? process.execPath
  try {
    const req = seams?.requireFn ?? ((a: string) => createRequire(a) as unknown as { resolve(spec: string): string })
    const resolved = req(anchor).resolve('@deepseek-ai/dsh-session')
    const mod = await (seams?.importFn ?? ((r: string) => import(r) as Promise<Record<string, unknown>>))(resolved)
    const fn = mod.appendPluginRecord ?? (mod.default as Record<string, unknown> | undefined)?.appendPluginRecord
    if (typeof fn !== 'function') {
      seams?.log?.(`prompt push: host module resolved but appendPluginRecord is absent (${resolved}) — pull transport stands`)
      return null
    }
    const append = fn as (session: unknown, type: string, data: unknown) => number
    return {
      append(session, payload) {
        try {
          append(session, PROMPT_RECORD_TYPE, payload)
          return true
        } catch (error) {
          // A failed append is a degraded push, never a crashed bar: the row write already happened,
          // the client's staleness-confirm pull covers the gap, and the reason is logged (#61).
          seams?.log?.(`prompt push: append failed (${String((error as Error)?.message ?? error).slice(0, 140)}) — the pull schedule covers this session`)
          return false
        }
      },
    }
  } catch (error) {
    seams?.log?.(`prompt push: unavailable on this host (${String((error as Error)?.message ?? error).slice(0, 140)}) — pull transport stands`)
    return null
  }
}
