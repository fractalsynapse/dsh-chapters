/**
 * The one formatter that turns a door's warnings into text a human reads (#61).
 *
 * The field failure was delivery, not detection: `writeArchive` produced 86 warnings across six SAIP
 * saves — naming the hollow chapter, the oversize chapters and an unarchived 0–4082 hole — and every door
 * reduced them to `(86 warning(s))`. A count is not a message. So all doors call THIS, which shows the
 * first `cap` texts and then says how many more there are, because "the withheld count is mandatory"
 * is already the rule for rules selection (record §7.4) and for search results.
 */
export function formatWarnings(warnings: readonly string[], cap: number): string {
  if (warnings.length === 0) return ''
  const shown = Math.max(1, Math.floor(cap))
  const head = warnings.slice(0, shown)
  const rest = warnings.length - head.length
  return head.join('; ') + (rest > 0 ? `; …and ${rest} more` : '')
}
