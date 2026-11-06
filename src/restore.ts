/**
 * #319 part 3b — the restore door's pure handler.
 *
 * The host's loader can refuse a session (#314); the host's UI then offers nothing for it.
 * This handler is the process that needs no loader: resolve the target WITHOUT guessing,
 * read its durable bytes (injected, so tests are honest about what production injects),
 * repair the archive through the SAME runRepair core, then create the continuation through
 * the SAME createChild seam every door uses. Dry-run is the default; `apply` is the only
 * word that writes; every refusal names what it refused and says NOTHING was written.
 */

export interface RestoreDeps {
  /** registry snapshot: id -> row (the handler writes nothing here; repair + create do) */
  rows(): Record<string, unknown>
  /** the target's decoded durable log, or null when there is none to restore from */
  dirFor(sessionId: string): { header: { cwd?: string } | null } | null
  /** the runRepair core, injected; returns the human summary for the pass */
  repair(sessionId: string, dryRun: boolean): Promise<string>
  /** createChild through the sanctioned seam; returns the new child's id */
  create(sessionId: string): Promise<string>
}

export async function runRestoreHandler(deps: RestoreDeps, arg: string, words: readonly string[]): Promise<string> {
  if (arg.trim() === '') return 'chapters-restore needs a session id or unique prefix: /chapters-restore <sessionId> [dry-run|apply]'
  const ids = Object.keys(deps.rows())
  const target = ids.includes(arg) ? [arg] : ids.filter((id) => id.startsWith(arg))
  if (target.length === 0) return `chapters-restore: no session matches "${arg}" in the registry (${String(ids.length)} known) — nothing read, nothing written.`
  if (target.length > 1) return `chapters-restore: ambiguous "${arg}" — ${target.slice(0, 6).join(', ')}${target.length > 6 ? ', …' : ''}; give a longer prefix. Nothing written.`
  const id = target[0]!
  if (deps.dirFor(id) === null) return `chapters-restore: ${id} has NO durable log on this machine — there is nothing to re-derive and nothing was written. (The log is the only source; a lost log is a backup question, not a repair question — site §Storage.)`
  const dryRun = !words.includes('apply')
  const summary = await deps.repair(id, dryRun)
  if (dryRun) {
    return [
      `chapters-restore ${id} — dry-run: ${summary}`,
      `pass 'apply': /chapters-restore ${id} apply — it repairs the archive (journalled), then creates a continuation citing it.`,
    ].join('\n')
  }
  const childId = await deps.create(id)
  return [
    `chapters-restore ${id} — ${summary}`,
    `new continuation created: ${childId} — open it in the sidebar; its TOC cites the restored archive.`,
    'NOTE: children are still born in the seeded shape until the #319 birth change ships, so the reload self-check may flag this child like any other at its first turn. Part 2 retires that flag; restore keeps working either way.',
  ].join('\n')
}
