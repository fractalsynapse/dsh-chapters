/**
 * The dead-boot message — built here so its guarantees are tested without booting anything (#165).
 *
 * Two facts from 2026-10-28 shape this. First, the rig **already** appends the child's captured output to the failure
 * (`log.slice(-1500)`), which is how one line — `[chapters-prompt] turn/end door armed` — told me the child mounted and
 * then stalled before listening; that diagnostic value is kept, not added. Second, the same slice is emitted verbatim,
 * and the child prints its own boot URL carrying a session token, so a routine boot failure copies a token into a
 * Playwright error, a per-leg log, and a CI annotation. `AGENTS.md` forbids that unconditionally (never log raw tokens
 * or bearer headers), which is the actual reason this module exists.
 *
 * Three shapes the message must not blur: a tail that is **empty** (the child said nothing), a log that is **absent**
 * (nothing was written — in practice the caller passes `null`), and a tail whose only content was URL/token lines. Each
 * reads differently, because each means something different about the boot. Output is bounded, and any removal is marked
 * `…[redacted]` so a reader never mistakes suppression for silence.
 */

/** Characters of child output allowed into one message. A cap that names its own truncation, not a silent slice. */
export const TAIL_BUDGET_CHARS = 1200

const TOKEN_LINE = /(token=|url=http|listening on http)/i

/** Measured 2026-10-29 on the maintainer's box: 65,387 of 65,536 inotify watches consumed (55,201 by another
 * application), and the host's HMR layer answered with ENOSPC. The rig's dead boots carried the same words in the same
 * pipe the runner was already reading, yet the failure still said only `boot failed within 120000ms` — which is how an
 * environment limit got mistaken for a plugin defect for a day. Detect it and say it plainly, in the reader's terms:
 * whose layer it is, and the knob that clears it. */
const WATCH_LIMIT_LINE = /ENOSPC[^\n]*watchers reached|System limit for number of file watchers/i

/**
 * @param tail - the child's captured output, or `null` when the log could not be read at all.
 */
export function bootFailureMessage(input: {
  readonly port: number
  readonly waitedMs: number
  readonly ceilingMs: number
  readonly logPath: string
  readonly tail: string | null
}): string {
  const head = `e2e boot failed within ${String(input.waitedMs)}ms waited (port ${String(input.port)}) — `
    + 'the ceiling is E2E_BOOT_TIMEOUT_MS, which measures readiness to serve, not a product claim'
  if (input.tail === null) {
    return `${head}. The child log ${input.logPath} was unreadable or never written — the process produced no captured output.`
  }
  const lines = input.tail.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) {
    return `${head}. child log tail: (empty) — the log ${input.logPath} held no lines; the child never wrote one.`
  }
  const kept: string[] = []
  let dropped = false
  let budget = TAIL_BUDGET_CHARS
  for (const line of lines) {
    if (TOKEN_LINE.test(line)) { dropped = true; continue }
    if (line.length > budget) { dropped = true; break }
    kept.push(line)
    budget -= line.length
  }
  const body = kept.length > 0 ? kept.join(' | ') : '(nothing but URL/token lines)'
  const watchExhausted = WATCH_LIMIT_LINE.test(input.tail)
  const cause = watchExhausted
    ? '. CAUSE: inotify file-watcher budget exhausted — an environment limit, not a plugin defect. '
      + 'Raise it with `sudo sysctl fs.inotify.max_user_watches=524288`, or free watchers (editors/indexers hold most of them); '
      + 'the server cannot finish starting its file-watch layer until then.'
    : ''
  return `${head}. child log tail (${input.logPath}): ${body}${dropped ? '…[redacted]' : ''}${cause}`
}
