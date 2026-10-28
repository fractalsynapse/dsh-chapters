/**
 * The one user-role message of an auxiliary, out-of-band model call.
 *
 * Several features ask a model a question without entering a session: the post-relief plot elicitation in
 * `engine.ts`, the bar's suggestion generators in `index.ts`. Their payload is a single user message streamed through
 * `ctx.llm.stream(...)` — it is never admitted to a session log, so it makes no producer claim and needs no
 * `plugin:*` kind.
 *
 * That distinction is the point of this file. Session format v4 retired the catch-all `source.kind: 'plugin'`
 * (`@deepseek-ai/dsh-llm`'s `MessageSourceMap`: *"there is no shared catch-all `plugin` kind"*), and a bare `plugin`
 * is refused at row admission on 0.2.x (#43). Four aux call sites still carried the retired spelling and passed every
 * gate for two host minors, because the repo type-checked against 0.1.5-rc.2 while the rig boots 0.2.0-rc.2
 * (`tests/unit/host-dep-pinning.test.ts` now forbids that drift). One helper, one honest kind.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** @param text - the auxiliary prompt, verbatim. @returns a user-role message for a one-off `llm.stream` call. */
export function auxPromptMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
