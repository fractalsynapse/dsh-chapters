/**
 * #406 — the model-identity predicate for the rig's tape-writing modes.
 *
 * Pure and total: every function takes possibly-hostile strings and returns a verdict, never throws,
 * never reaches the network. `tests/e2e/boot.ts` owns the fetches; this file owns the decision, so it
 * can be tested against measured payloads — including the exact one that motivated the issue: an
 * endpoint that lists only `qwen3-4b-instruct` but SILENTLY ANSWERS chat requests named
 * `qwen3.8-flash-next` (vLLM serves the loaded model for unknown names), so the RESPONSE's `model`
 * field is the witness and a `/v1/models` list alone is not enough.
 *
 * A `null` verdict means PROVEN; a string is the refusal, worded to be pasted into a boot failure.
 */

export const modelsListIds = (text: string | undefined): string[] => {
  try {
    const j = JSON.parse(text ?? '') as { data?: unknown }
    const arr = Array.isArray(j.data) ? j.data : []
    return arr.map((d) => (d as { id?: unknown })?.id).filter((x): x is string => typeof x === 'string')
  } catch { return [] }
}

export const chatServedId = (text: string | undefined): string | null => {
  try {
    const j = JSON.parse(text ?? '') as { model?: unknown }
    return typeof j.model === 'string' && j.model !== '' ? j.model : null
  } catch { return null }
}

/**
 * Prove the endpoint really serves `requested` — deliberately remapped through E2E_UPSTREAM_MODEL or
 * not, the rule is the same: the name must be LISTED and the chat response must ANSWER AS IT.
 * The alias class fails HERE: an unknown request name is silently served by another loaded model,
 * and that served model is named in the refusal.
 */
export function servedModelVerdict(input: { listText: string, chatText: string, requested: string }): string | null {
  const ids = modelsListIds(input.listText)
  if (ids.length === 0) {
    return `the upstream's /v1/models carried no parsable model list — identity of the pinned rig model `
      + `(${input.requested}) cannot be proven, and nothing was recorded`
  }
  const served = chatServedId(input.chatText)
  if (!ids.includes(input.requested)) {
    return `the upstream does not list ${input.requested}; it lists [${ids.join(', ')}] — `
      + `this endpoint cannot write tapes for the pinned rig model (start the server the rig pins, or `
      + `set E2E_UPSTREAM_MODEL to a listed id — it is itself proven before it is honored)`
  }
  if (served === null) {
    return `the chat probe to ${input.requested} carried no parsable model field — refusing to record `
      + `against an unprovable endpoint`
  }
  if (served !== input.requested) {
    return `SILENT ALIAS: a chat request named ${input.requested} was ANSWERED as ${served} — `
      + `this endpoint serves the loaded model under any name (measured 2026-11-17: qwen3.8-flash-next → `
      + `qwen3-4b-instruct with raw think traces as content). Recorded tapes would describe the wrong `
      + `model; refusing before boot`
  }
  return null
}

/**
 * #409 — the STUB-class witness, for the legs whose documented upstream IS the scripted stub
 * (tests/e2e/stub-model.ts; #56 policy). An endpoint is stub-class iff its model list is non-empty
 * and EVERY id carries the `stub-` prefix — one real id disqualifies the whole endpoint, which is
 * what keeps the measured alias box refused here too. The chat arm is honest about what it can
 * prove: the stub echoes the REQUEST name and its own provenance file says that field is
 * NOT-provenance, so the witness requests the endpoint's OWN first listed id and requires the echo
 * back unchanged — presence and self-consistency, nothing more. Leg-kind itself is carried by the
 * marker E2E_STUB_LEG that distill-tapes.sh sets beside the stub it pins; boot enforces both
 * directions (marker without stub-class → refuse, stub-class on a live leg → refuse via the
 * live-path witness, which fails because the stub list has no pinned id).
 */
export function stubEndpointVerdict(input: { listText: string, chatText: string }): string | null {
  const ids = modelsListIds(input.listText)
  if (ids.length === 0) {
    return `the upstream's /v1/models carried no parsable model list — a STUB-leg record requires `
      + 'the scripted stub (all ids `stub-`-prefixed); nothing was recorded'
  }
  const real = ids.filter((id) => !id.startsWith('stub-'))
  if (real.length > 0) {
    return `a STUB-leg record was pointed at a NON-stub endpoint — its list carries real model ids `
      + `[${real.join(', ')}] alongside anything else; the scripted stub lists only \`stub-\` names. Refusing before boot`
  }
  const served = chatServedId(input.chatText)
  if (served === null || served !== ids[0]) {
    return `the stub-class endpoint did not answer as its own first listed id `
      + `(asked ${ids[0] ?? '?'}, answered ${served ?? 'unparsable'}) — refusing before boot`
  }
  return null
}
