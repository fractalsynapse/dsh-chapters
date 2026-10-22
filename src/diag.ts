/**
 * The one diagnostics seam for the whole plugin (#54).
 *
 * WHY THIS FILE EXISTS. `DSH_CHAPTERS_ENGINE_ERRORS` was written by two copies of the same
 * three lines — one in the realm engine, one in the subagent auto-save listener — and by
 * NEITHER of the places that actually fail a user: the host-plane doors and the shared
 * continuation core. Measured consequence on host 0.2.0-rc.2: `chapters-fork refused: child
 * creation refused: format v4 message requires a producer-owned source kind` ended the entire
 * acceptance chain, and the sink — the one artifact a human or an agent could read without a
 * browser — captured nothing at all. A diagnostic that misses the failure it exists to record
 * is worse than none, because it is trusted.
 *
 * So there is now ONE writer, called from every plane. Rules it upholds:
 *
 *  - **Never throws, never blocks.** Diagnostics must not turn a handled failure into an
 *    unhandled one, so every filesystem touch is swallowed. The real failure keeps its path.
 *  - **Never silent when opted in.** With no sink configured, `diagnostic` is a no-op by
 *    design — but `diagnosticRequested` lets a boot-time health line say "no sink is
 *    configured", so the absence is visible rather than discovered during an incident.
 *  - **Full detail on disk, short detail on screen.** The UI text is sliced to fit; the sink
 *    gets the whole message plus the stack when there is one. Refusals that get truncated to
 *    90 characters for the composer are exactly the ones worth reading in full later.
 */
import fs from 'node:fs'

/** The opt-in sink: an append-only file path, or undefined when unset/empty. */
export function diagnosticSink(): string | undefined {
  const p = process.env.DSH_CHAPTERS_ENGINE_ERRORS
  return p !== undefined && p !== '' ? p : undefined
}

/**
 * The status line: says out loud whether a failure WOULD be recorded. Discovered the hard way
 * (#54) — an unconfigured sink is invisible until the one moment you need it, which is exactly
 * when a human is asking "did the feature run, and what did the kernel say?".
 */
export function diagnosticStatusLine(): string {
  const sink = diagnosticSink()
  return sink === undefined
    ? 'Diagnostics: NO ERROR SINK — door/child failures reach only the profile logger; set DSH_CHAPTERS_ENGINE_ERRORS=/path/to/file to keep them readable outside the app'
    : `Diagnostics: sink → ${sink}`
}

/** True when SOME diagnostic was written since import — for the status line's honest "no sink" arm. */
let everWritten = false
export function diagnosticEverWritten(): boolean { return everWritten }

/** Reset for tests only; production never calls it. */
export function resetDiagnosticStateForTests(): void { everWritten = false }

/**
 * Append one diagnostic record. Returns the composed line even when the write fails, so a
 * caller can ALSO log or include it in a refusal without recomposing it.
 *
 * `where` is the seam that saw it (`'door:fork'`, `'realm:compaction'`, `'auto-save'`) — a
 * timestamp and a message without an origin is how an incident report becomes a guess.
 */
export function diagnostic(where: string, message: string, error?: unknown): string {
  const line = `[${new Date().toISOString()}] [${where}] ${message}` +
    (error === undefined ? '' : ` :: ${describe(error)}`)
  const sink = diagnosticSink()
  if (sink === undefined) return line
  try {
    // appendFileSync, not async: a refused child creation is often followed by the process
    // tearing the session down, and a pending write can be lost exactly when it matters.
    fs.appendFileSync(sink, line + '\n')
    everWritten = true
  } catch { /* diagnostics never mask the real failure */ }
  return line
}

/** The full error text a sink record needs: message, then name/code/stack — in that order. */
export function describe(error: unknown): string {
  if (error === null || error === undefined) return '(no error object)'
  if (typeof error === 'string') return error
  const e = error as { message?: string; name?: string; code?: string; stack?: string }
  const bits: string[] = []
  if (typeof e.message === 'string' && e.message !== '') bits.push(e.message)
  if (typeof e.name === 'string' && e.name !== 'Error' && !bits[0]?.startsWith(e.name)) bits.push(`name=${e.name}`)
  if (typeof e.code === 'string') bits.push(`code=${e.code}`)
  if (typeof e.stack === 'string' && e.stack !== '') bits.push(e.stack.split('\n').slice(0, 6).join(' | '))
  return bits.join(' :: ') || String(error)
}

/**
 * A logger warn PLUS the sink, for planes that have a Cordis logger. The logger alone is not
 * enough (r19: headless profiles route `ctx.logger` where nobody can see it), and the sink
 * alone loses the operator channel — so do both, in that order.
 */
export function diagnosticWarn(
  logger: { warn?(m: string): void } | undefined,
  where: string,
  message: string,
  error?: unknown,
): string {
  const line = diagnostic(where, message, error)
  try { logger?.warn?.(line) } catch { /* a hostile logger must not eat the diagnostic */ }
  return line
}
