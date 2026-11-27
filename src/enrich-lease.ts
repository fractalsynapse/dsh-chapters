/**
 * #578: THE DRAIN LEASE, one predicate for every pump that touches the shared per-home registry.
 * Extracted from #571's queue-internal lease so the enrichment drain and the human-only rules
 * reprocess cannot each invent their own idea of "someone else is pumping this" — two pumps, one
 * lock, one stale-lease takeover rule. The holder writes {plane, at, token} under one settings
 * key; fresh means under TTL; a stale lease is taken over LOUDLY (the caller logs it) because a
 * lease that permanently starves every pump is worse than the race it prevents.
 */
export const LEASE_KEY = 'enrichment.drainLease'
export const LEASE_TTL_MS = 20 * 60_000

export interface LeaseApi {
  claim(): boolean
  release(): void
  heldByOther(): string | undefined
  read(): { plane?: string; at?: number; token?: string } | undefined
  label: string
}

export function createDrainLease(
  spine: { get(key: string): string | undefined; put(key: string, value: string | undefined): void },
  label: string,
): LeaseApi {
  const token = Math.random().toString(36).slice(2)
  const read = (): { plane?: string; at?: number; token?: string } | undefined => {
    try {
      const raw = spine.get(LEASE_KEY)
      if (raw === undefined || raw === '') return undefined
      return JSON.parse(raw) as { plane?: string; at?: number; token?: string }
    } catch { return undefined }
  }
  const fresh = (l: { at?: number } | undefined): boolean => l !== undefined && typeof l.at === 'number' && Date.now() - l.at < LEASE_TTL_MS
  return {
    label,
    read,
    heldByOther: () => {
      const cur = read()
      return fresh(cur) && cur?.token !== token ? (typeof cur?.plane === 'string' ? cur.plane : 'another pump') : undefined
    },
    claim: () => {
      const cur = read()
      if (fresh(cur) && cur?.token !== token) return false
      spine.put(LEASE_KEY, JSON.stringify({ plane: label, at: Date.now(), token }))
      return true
    },
    release: () => {
      const cur = read()
      if (cur?.token === token) spine.put(LEASE_KEY, undefined)
    },
  }
}

/** One route decision for every mining caller (#578): spec → {provider, model} or undefined for
 *  "rides the annotation route". ladder and reprocess share it so the printed mining route and
 *  the route actually used cannot drift apart. */
export function mineRouteOf(spec: string, fallback: { provider: string; model: string } | null):
  { provider: string; model: string } | undefined {
  const s = spec.trim()
  if (s === '' || s === 'conversation') return undefined
  const sep = s.indexOf('/')
  if (sep > 0) return { provider: s.slice(0, sep), model: s.slice(sep + 1) }
  return fallback !== null && fallback !== undefined
    ? { provider: fallback.provider, model: s }
    : undefined
}
