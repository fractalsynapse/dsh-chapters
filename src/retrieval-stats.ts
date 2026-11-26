/**
 * #531 — retrieval observability: is the archive actually being consulted?
 *
 * The SAIP audit measured the failure this counts: 501 bash calls, ZERO chapters_search in a
 * session with a growing knowledge pool — and answering "did it search?" required durable-log
 * archaeology. Per-process counters (like the prompt-plane's boundary sightings, #225): a
 * restart resets them, the status line SAYS so, and absence of a number is never a number.
 * Pure by doctrine: the tools bump, the status formats, nothing here decides anything.
 */
export type RetrievalVerb = 'search' | 'artifact' | 'rules'

const counters = new Map<string, Record<RetrievalVerb, number>>()

export function bumpRetrieval(sessionId: string, verb: RetrievalVerb): void {
  const cur = counters.get(sessionId) ?? { search: 0, artifact: 0, rules: 0 }
  cur[verb] += 1
  counters.set(sessionId, cur)
}

export function retrievalStatsFor(sessionId: string): Record<RetrievalVerb, number> | undefined {
  return counters.get(sessionId)
}

/** Plane-level summary for /chapters-status (the status block is per-plane; per-session detail
 *  lives in the durable log by design). One line, honest scope in the wording. */
export function formatRetrievalSummary(): string {
  let search = 0; let artifact = 0; let rules = 0; let sessions = 0
  for (const c of counters.values()) { search += c.search; artifact += c.artifact; rules += c.rules; if (c.search + c.artifact + c.rules > 0) sessions += 1 }
  return `  retrieval (this process): ${String(search)} search · ${String(artifact)} artifact · ${String(rules)} rules across ${String(sessions)} session(s) — the pool is consulted only if this grows`
}

/** One status line, per session — the maintainer's question ("is it searching?") answerable
 *  without touching a log. Counts are this process; the wording says it, never implies more. */
export function formatRetrievalLine(sessionId: string): string {
  const c = counters.get(sessionId)
  return c === undefined
    ? '  retrieval: no chapters_* lookups this process for this session (searches land in the durable log regardless — this is a live count, not history)'
    : `  retrieval: ${String(c.search)} search · ${String(c.artifact)} artifact · ${String(c.rules)} rules (this process)`
}
