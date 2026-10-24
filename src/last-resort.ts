/**
 * The last-resort deferral's arithmetic (#78 option A) — kept apart from the engine so the rule that
 * decides WHEN an oversized node may override the operator's arrival floor is testable without a
 * session, a meter, or a model.
 *
 * The number is DERIVED, never invented: a node can only make relief impossible if it cannot fit
 * beside the content relief is obliged to keep. That obligation is the base engine's own verbatim
 * retain tail plus its reserved completion budget, both of which it already computes — so the
 * ceiling is `window − retainBudget − reservedCompletion`, and no new tunable appears (AGENTS: no
 * hardcoded tunables; `cordis.yml` can only change what config declares).
 */
export interface LastResortInputs {
  windowTokens: number
  retainRatio: number
  retainTokens?: number
  reservedCompletionTokens: number
}

/**
 * The token size above which an inline `tool/result` cannot coexist with the mandatory tail, or
 * `null` when nothing can be concluded. Returning `null` — rather than 0, or a guess — is the point:
 * a wrong ceiling here silently overrides an operator's configured economy knob, which is the one
 * thing this feature must never do.
 */
export function lastResortCeilingTokens(v: LastResortInputs): number | null {
  const { windowTokens, retainRatio, retainTokens, reservedCompletionTokens } = v
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  if (!finite(windowTokens) || !finite(reservedCompletionTokens)) return null
  if (windowTokens <= 0 || reservedCompletionTokens < 0) return null
  // An explicit retainTokens wins over the ratio (both are base config the host may carry either way).
  let retainBudget: number
  if (finite(retainTokens) && retainTokens > 0) {
    retainBudget = retainTokens
  } else {
    if (!finite(retainRatio) || retainRatio <= 0 || retainRatio >= 1) return null
    retainBudget = Math.floor(windowTokens * retainRatio)
  }
  const ceiling = windowTokens - retainBudget - reservedCompletionTokens
  return ceiling > 0 ? Math.floor(ceiling) : null
}
