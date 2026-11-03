/**
 * The `chapters` agent preset row — our implementation of the host's own
 * `@deepseek-ai/dsh-agent-preset` declaration row, mounted from the bundle patch
 * (`cordis.patch.yml`, row id `preset-chapters`), so the preset is a visible Loader entry
 * exactly like `preset-standard` / `preset-ptc` rather than something a plugin does aside.
 *
 * WHY OUR ROW AND NOT THE HOST PACKAGE DIRECTLY
 * --------------------------------------------
 * A preset can be unusable in two ways and both are total: one unresolvable child row makes
 * the WHOLE preset `broken` (`mountPreset` throws on any failed row → `record.broken` →
 * `retain()` refuses with `agent-preset/invalid`), which is the same user-visible failure as
 * a missing preset — every chapters session stops composing while its durable log sits there
 * intact. Measured on the stable release with a composition copy-anchored to the alpha:
 * `@deepseek-ai/dsh-tool-schedule` is not published at 0.2.0-rc.2 at all, and the boot said
 * `preset "chapters" is DECLARED BUT BROKEN — tool-schedule … never started`.
 *
 * So this row does what the host's does, plus drop-what-will-not-load. It also refuses to
 * brick a host predating the mechanism: a `@deepseek-ai/dsh-agent-preset` row is
 * unresolvable before 0.1.7-alpha.1, and ONE unresolvable row aborts a legacy plugin tree
 * (`plugin tree failed to load: … Cannot find package`), while a row naming our own package
 * resolves wherever our package runs. The support floor is 0.2.0, so that is now
 * belt-and-braces rather than the reason — and it is why the row plugin is ours.
 *
 * WHAT IS COPIED FROM THE HOST'S PLUGIN, LINE FOR LINE
 * ---------------------------------------------------
 *  - `static inject = ['agentPresets']` — the registry's shape, never a version test.
 *  - `static [EntryGroup.key] = true` — "preserve child expressions until their own plugins
 *    activate". Without it the Loader interpolates `!!js` against the HOST context, and
 *    `disabled: !!js process.platform === 'win32'` stops belonging to the child row that
 *    owns it.
 *  - `[Service.init]` `yield`s the registry's disposer, so Cordis owns the registration's
 *    lifetime. That also disposes of the trap the first draft fell into: calling
 *    `ctx.effect(disposer)` from `apply()` fires when the apply FIBER finishes, which
 *    un-registered the preset the instant it had been registered (measured on 0.2.0-rc.2:
 *    `register()` reported success while the roster came back without `chapters`).
 *
 * @module dsh-chapters/src/preset
 */
import { Service } from '@deepseek-ai/cordis'
import { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'

/** One mounted plugin row of a preset composition (the Loader's own shape). A group row
 *  carries its children in `config`; an ordinary row carries a config map. */
export interface PresetRow {
  id: string
  name: string
  config?: Record<string, unknown> | PresetRow[]
  disabled?: boolean
  group?: boolean
  isolate?: Record<string, boolean>
}

/** The preset definition, in the shape `AgentPresetRegistry.register()` accepts — the host
 *  plugin's own Config: id, name?, description?, order, plugins. */
export interface PresetDefinition {
  id: string
  name?: string
  description?: string
  order?: number
  plugins: PresetRow[]
}

/** The preset identity. `config.id` is DURABLE STATE: every continuation child's log
 *  records it as `agent-preset/selected`, so renaming it orphans those sessions. */
export const CHAPTERS_PRESET_ID = 'chapters'

/** Whether a row's module must be probed at all. `cordis:` rows are pseudo-modules the
 *  Loader always provides; our own package is by definition present — its realm row is the
 *  whole point of the preset, and pruning it would quietly delete the feature. */
function needsProbe(row: PresetRow): boolean {
  return !row.name.startsWith('cordis:') && !row.name.startsWith('@fractalsynapse/dsh-chapters')
}

/**
 * Drop rows whose module cannot be imported, keeping the group structure intact.
 *
 * The probe is asked with the row's FULL specifier, so a package that still exists but no
 * longer exports the subpath a row names (`…/tools`, `…/list-agents`) is caught too — those
 * renames are what eat presets between host versions.
 *
 * @param rows the composition, groups included.
 * @param resolvable asked with each row's module specifier. MUST NOT throw.
 * @returns the composition to register, and every drop NAMED — a silent drop is how a
 *          preset loses a tool nobody notices.
 */
export function pruneUnresolvableRows(
  rows: PresetRow[],
  resolvable: (specifier: string) => boolean,
): { kept: PresetRow[]; dropped: string[] } {
  const dropped: string[] = []
  const keep = (row: PresetRow): boolean => {
    if (!needsProbe(row)) return true
    if (resolvable(row.name)) return true
    dropped.push(`${row.id} (${row.name})`)
    return false
  }
  const visit = (list: PresetRow[]): PresetRow[] => list.flatMap((row): PresetRow[] => {
    if (row.group !== true || !Array.isArray(row.config)) return keep(row) ? [row] : []
    const children = (row.config as PresetRow[]).filter(keep)
    if (children.length === 0) {
      dropped.push(`${row.id} (group emptied)`)
      return []
    }
    return [{ ...row, config: children }]
  })
  return { kept: visit(rows), dropped }
}

/** What registering a preset can end up as. Every arm has its own log line and its own
 *  remedy, because the silent case is the one that cost a human hours. */
export type RegisterOutcome =
  | { state: 'registered' }
  | { state: 'pruned'; dropped: string[] }
  | { state: 'already-declared' }
  | { state: 'unsupported' }
  | { state: 'failed'; reason: string }

/** The narrow surface of `ctx.get('agentPresets')` this row uses. */
export interface PresetRegistryLike {
  register?: (definition: PresetDefinition) => Promise<() => Promise<void>>
  list?: () => Promise<unknown>
  /** `compositionInventory()` in `@deepseek-ai/dsh-agent-preset-registry`: every declared
   *  preset with its mounted rows and their Loader states. */
  compositionInventory?: () => Promise<unknown>
}

/**
 * Register a declared preset, dropping rows this host cannot import.
 *
 * Split out of the plugin class so every arm is unit-testable without a host: the caller
 * hands in the registry surface and a resolver.
 *
 * @returns the outcome AND the disposer the registry hands back — the caller must keep it
 *          alive for the row's lifetime, which is what yielding it from `[Service.init]`
 *          does; nothing else has the right lifetime (see the module header).
 */
export async function registerPrunedPreset(
  presets: PresetRegistryLike | undefined,
  definition: PresetDefinition,
  resolvable: (specifier: string) => boolean,
): Promise<{ outcome: RegisterOutcome; disposer?: () => Promise<void> }> {
  if (typeof presets?.register !== 'function') return { outcome: { state: 'unsupported' } }
  const { kept, dropped } = pruneUnresolvableRows(definition.plugins, resolvable)
  const pruned = { ...definition, plugins: kept }
  let disposer: () => Promise<void>
  try {
    disposer = await presets.register(pruned)
  } catch (error) {
    const reason = String((error as Error)?.message ?? error)
    // A duplicate is not our failure: someone declared `chapters` themselves — a profile
    // patch override is a legitimate choice. Their row wins; ours must not throw, because a
    // row that fails to activate takes the preset with it, and the roster line with it.
    if (/duplicate agent preset/i.test(reason)) return { outcome: { state: 'already-declared' } }
    return { outcome: { state: 'failed', reason } }
  }
  return {
    outcome: dropped.length > 0 ? { state: 'pruned', dropped } : { state: 'registered' },
    disposer,
  }
}

/** One mounted row of a live preset composition, as the host's inventory reports it.
 *  `fiberState` is the Loader's state for that row; an enabled row that is not `active`
 *  cannot serve a session, and the roster's `broken` flag reports that only for the whole
 *  mount — which is why the witness asks for the rows as well. */
export interface InventoryRow {
  entryId?: string
  moduleName?: string
  enabled?: boolean
  fiberState?: string
}

/** One preset's entry in a `compositionInventory()` response. */
export interface InventoryEntry {
  id?: string
  broken?: string
  rows?: InventoryRow[]
}

/** Find one preset in an inventory response, tolerating a missing or odd shape. */
export function inventoryEntry(raw: unknown, presetId: string): InventoryEntry | undefined {
  return Array.isArray(raw) ? (raw as InventoryEntry[]).find((entry) => entry?.id === presetId) : undefined
}

/** Enabled rows of one preset that are not active. A row `pending` a host service can still
 *  activate later, so this is reported apart from `broken` and never as a refusal. */
export function unusableRows(entry: InventoryEntry | undefined): string[] {
  if (!Array.isArray(entry?.rows)) return []
  return (entry.rows as InventoryRow[])
    .filter((row) => row.enabled !== false && typeof row.fiberState === 'string' && row.fiberState !== 'active')
    .map((row) => `${row.entryId ?? '?'} (${row.moduleName ?? '?'}) ${row.fiberState}`)
}

/**
 * Whether a module specifier can be imported from THIS package's resolution family.
 *
 * Two limits are the host's, not ours to paper over: a RELATIVE specifier resolves without
 * touching the filesystem (so a file-URL row would always be reported resolvable — the
 * composition uses package specifiers only, and the drift test pins that), and a name that
 * resolves is not yet a name that ACTIVATES, which is what the roster line reports as
 * `DECLARED BUT BROKEN`. Never throws: an unresolvable specifier is the answer.
 */
export function resolvableFromThisPackage(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) return true
  try {
    import.meta.resolve(specifier)
    return true
  } catch {
    return false
  }
}

/** The narrow slice of the Cordis context this row needs. */
interface RowCtx {
  agentPresets: PresetRegistryLike
  logger?: { info?: (m: string) => void; warn?: (m: string) => void }
}

/**
 * The declaration row. `config` IS the preset definition, exactly as the host's
 * `AgentPreset` plugin consumes it, so a profile patch can override `preset-chapters`
 * wholesale or `disabled: true` it — the two things a runtime registration done in
 * `apply()` cannot offer, and the reason this is a row.
 */
export default class ChaptersPresetRow {
  static inject = ['agentPresets'] as const

  /** Preserve child `!!js` expressions until their own plugins activate. */
  static [EntryGroup.key] = true

  static Config = z.object({
    id: z.string().required(),
    name: z.string(),
    description: z.string(),
    order: z.number(),
    plugins: z.array(z.any()).required(),
  })

  ctx: RowCtx
  config: PresetDefinition

  constructor(ctx: RowCtx, config: PresetDefinition) {
    this.ctx = ctx
    this.config = config
  }

  /** Registers, then yields the disposer so Cordis owns the registration's lifetime — the
   *  host's own row plugin does exactly this (`yield await this.ctx.agentPresets.register(…)`). */
  async *[Service.init](): AsyncGenerator<() => Promise<void>, void> {
    const { outcome, disposer } = await registerPrunedPreset(this.ctx.agentPresets, this.config, resolvableFromThisPackage)
    const log = (message: string, warn: boolean): void => {
      // `ctx.logger` alone is invisible to a headless `dsh web` (r19), so the loud arms go
      // to stderr as well — a health line nobody reads is how the silent case survived.
      if (warn) {
        this.ctx.logger?.warn?.(message)
        console.error(message)
      } else this.ctx.logger?.info?.(message)
    }
    if (outcome.state === 'unsupported') {
      // Pre-0.1.7 hosts have no register(). They are below the support floor, but saying so
      // beats aborting their plugin tree over a row they cannot read.
      log(`dsh-chapters: this host cannot register preset declaration rows (before 0.2.0) — the "${CHAPTERS_PRESET_ID}" preset cannot exist here; the chapters tools still work`, true)
      return
    }
    if (outcome.state === 'already-declared') {
      log(`dsh-chapters: preset "${this.config.id}" is also declared by another row — that one is kept, this bundle's copy stands down`, false)
      return
    }
    if (outcome.state === 'failed') {
      log(`dsh-chapters: UNHEALTHY — registering the "${this.config.id}" preset was refused: ${outcome.reason} — every session choosing it will fail to compose`, true)
      return
    }
    if (outcome.state === 'pruned') {
      log(`dsh-chapters: preset "${this.config.id}" registered — dropped ${outcome.dropped.length} row(s) this host cannot import: ${outcome.dropped.join(', ')} (one unresolvable row would make the whole preset broken, so they are gone rather than mounted)`, false)
    } else {
      log(`dsh-chapters: preset "${this.config.id}" registered as a declaration row`, false)
    }
    if (disposer !== undefined) yield disposer
  }
}
