/**
 * The rig's preset pin (#56/#77) — per-boot config that reaches the REALM, not just the host.
 *
 * Two failures this exists to kill, both measured on host 0.2.0-rc.2:
 *
 * 1. `Pins.thresholdRatio`, `Pins.toolResultArtifactTokens`, `Pins.enrichment` and
 *    `Pins.noAuxModel` were collected by `globalSetup` and consumed by NOTHING — `bootE2eServer`
 *    applied only `storeRoot` + `promptModel`. So every leg ran on realm defaults while its log
 *    line and the script header claimed a threshold of 0.5, an arrival floor of 1,000,000 and
 *    "no aux model". A pin that cannot be observed is a pin that did not happen (the repo's own
 *    commit 8f5624b said so, and then the pins went inert anyway).
 * 2. Those keys live on the preset's `chapters-engine` row, which is declared in the SHIPPED
 *    bundle patch (`cordis.patch.yml`, `- insert: - id: preset-chapters`). Patch layers merge by
 *    ROW ID, so the only honest way to pin a realm value from a profile is to re-declare that row
 *    with the shipped tree carried along — a partial row would replace `config` and delete the
 *    preset's plugins. So this function extracts the shipped `preset-chapters` row, re-indents it
 *    to profile level, and rewrites the engine row's config in place.
 *
 * Dedup is line-scanned (same discipline as `applyRigPluginPatch`): reruns must REPLACE, never
 * stack, because two rows for one id leave "which wins" to the host's merge order.
 */
import type { Pins } from './boot.ts'

/** The engine row's config keys the rig is allowed to pin — read from `src/engine.ts`'s schema. */
export interface RealmPin {
  thresholdRatio?: string
  toolResultArtifactTokens?: string
  enrichmentEnabled?: boolean
  noAuxModel?: boolean
  artifactStoreRoot?: string
  /** #85: per-boot pool-mirror root, so a notice's CORE RULES block cannot come from the
   *  developer's repo. Without it, `heavy`'s recorded notice carried `[dev2/001] …` and the
   *  replayed notice carried none — same build, same pins, different repo state. */
  knowledgeMirrorDir?: string
}

const PRESET_ROW = '- id: preset-chapters'

/**
 * Extract the shipped `preset-chapters` row from the bundle patch text and apply realm pins.
 * Returns the profile-level YAML for that row. Throws loudly if the row is missing — a silently
 * absent preset row is how every leg ran `standard` without anyone noticing for two days.
 */
export function renderPinnedPreset(shipped: string, pins: RealmPin): string {
  const lines = shipped.split('\n')
  const start = lines.findIndex((l) => l.trim() === PRESET_ROW && l.startsWith('    '))
  if (start < 0) throw new Error(`cordis.patch.yml: no "${PRESET_ROW}" row found — the preset is no longer shipped as a declaration row, and the rig pin must be re-expressed`)
  // the row ends at the next line indented <= the row's own indent that starts a sibling
  const rowIndent = lines[start]!.indexOf('-')
  let end = start + 1
  while (end < lines.length) {
    const l = lines[end]!
    if (l.trim() === '') { end += 1; continue }
    const ind = l.search(/\S/)
    if (ind <= rowIndent && /^\s*-\s/.test(l)) break
    if (ind <= rowIndent && /^\s*[A-Za-z_]/.test(l)) break
    end += 1
  }
  const block = lines.slice(start, end).map((l) => (l.startsWith(' '.repeat(4)) ? l.slice(4) : l))
  const out: string[] = []
  for (const raw of block) {
    let l = raw
    // the engine row carries the realm's compaction/arrival/enrichment config: everything the
    // rig's pins are about. Insert pins right after its `thresholdRatio:` line.
    if (/^\s+- id: chapters-engine\s*$/.test(l)) { out.push(l); continue }
    if (/^\s+thresholdRatio: [\d.]+\s*$/.test(l) && /^ {14,}/.test(l)) {
      const ind = /^ +/.exec(l)![0]
      const ratio = pins.thresholdRatio ?? l.split(':')[1]!.trim()
      l = `${ind}thresholdRatio: ${ratio}`
      out.push(l)
      const extras: string[] = []
      if (pins.artifactStoreRoot !== undefined) extras.push(`${ind}artifactStoreRoot: '${pins.artifactStoreRoot}'`)
      if (pins.knowledgeMirrorDir !== undefined) extras.push(`${ind}knowledgeMirrorDir: '${pins.knowledgeMirrorDir}'`)
      if (pins.toolResultArtifactTokens !== undefined) extras.push(`${ind}toolResultArtifactTokens: ${pins.toolResultArtifactTokens}`)
      if (pins.enrichmentEnabled !== undefined) extras.push(`${ind}enrichmentEnabled: ${String(pins.enrichmentEnabled)}`)
      // #77's predecessor lesson: the aux pin was expressed against keys that no longer exist.
      // `auto: false` + `elicitedPlot: false` ARE realm keys today (src/engine.ts:229,264), so a
      // no-aux boot is genuinely no-aux, and the tape's request sequence is the whole story.
      if (pins.noAuxModel === true) { extras.push(`${ind}auto: false`); extras.push(`${ind}elicitedPlot: false`) }
      // #130: the narrower lever, kept separate because the BOTH-off form hangs the boot at low ratios while the
      // plot-only form is the cell the acceptance fix actually needs (relief live, aux turn gone).
      else if (pins.noElicitedPlot === true) { extras.push(`${ind}elicitedPlot: false`) }
      out.push(...extras)
      continue
    }
    out.push(l)
  }
  return out.join('\n')
}

/**
 * Apply the realm pins to a profile patch text: drop any previously written `preset-chapters`
 * row (rerun-safe), append the pinned copy of the shipped one.
 */
export function applyRigPresetPin(existing: string, shipped: string, pins: RealmPin): string {
  const kept: string[] = []
  let skipping = false
  for (const line of existing.split('\n')) {
    if (/^- id: preset-chapters/.test(line)) { skipping = true; continue }
    if (skipping && !/^\s/.test(line) && line !== '') skipping = false
    if (!skipping) kept.push(line)
  }
  return `${renderPinnedPreset(shipped, pins)}\n${kept.join('\n')}`
}

/**
 * Guarantee the preset-registry pin in a boot's own profile patch, from the repo's dev profile.
 *
 * Why per boot rather than by fixing the source home once: `.dshdev-local/profiles/web/cordis.patch.yml`
 * is written by `scripts/bootstrap-dev-profile.sh` (line 68) — last run Oct 16 — so EVERY edit to
 * `dev/profile-cordis.patch.yml` is invisible to every leg until someone reruns a bootstrap script
 * nobody remembers. That is the same trap as the copied plugin tree (#54: measurements of a build
 * that was not the one under test), and it is why the corrected row id appeared to do nothing.
 *
 * Two actions, both idempotent:
 *  1. DELETE the retired `- id: agent-presets` row. On 0.2.x it matches no mounted row (the
 *     registry mounts as `agent-preset-registry`; `agent-presets` survives only as a client UI
 *     section id), and patch layers merge by id — so the row is inert while LOOKING like a pin.
 *  2. INSERT the dev profile's registry row if the boot home lacks one.
 */
export function ensurePresetRegistryPin(existing: string, devProfile: string): string {
  const kept: string[] = []
  let skipping = false
  for (const line of existing.split('\n')) {
    if (/^- id: agent-presets\s*$/.test(line)) { skipping = true; continue }
    if (skipping && !/^\s/.test(line) && line !== '') skipping = false
    if (!skipping) kept.push(line)
  }
  const body = kept.join('\n')
  if (/^- id: agent-preset-registry\s*$/m.test(body)) return body
  const lines = devProfile.split('\n')
  const start = lines.findIndex((l) => /^- id: agent-preset-registry\s*$/.test(l))
  if (start < 0) {
    throw new Error('dev/profile-cordis.patch.yml carries no `agent-preset-registry` row — the rig cannot guarantee the preset pin, and every boot would silently run the standard realm (issues #56/#77)')
  }
  let end = start + 1
  while (end < lines.length && (lines[end]!.startsWith(' ') || lines[end]!.trim() === '')) end += 1
  return `${lines.slice(start, end).join('\n').replace(/\s+$/, '')}\n${body.replace(/^\n+/, '')}`
}

/** Which realm pins do the rig's collected `Pins` map to? One place, so a field cannot go inert. */
export function realmPinsOf(pins: Pins, storeRoot: string, mirrorRoot?: string): RealmPin {
  return {
    thresholdRatio: pins.thresholdRatio,
    artifactStoreRoot: storeRoot,
    ...(mirrorRoot !== undefined ? { knowledgeMirrorDir: mirrorRoot } : {}),
    ...(pins.toolResultArtifactTokens !== undefined ? { toolResultArtifactTokens: pins.toolResultArtifactTokens } : {}),
    ...(pins.enrichment !== undefined ? { enrichmentEnabled: pins.enrichment } : {}),
    ...(pins.noAuxModel === true ? { noAuxModel: true } : {}),
  }
}
