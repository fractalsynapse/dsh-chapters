/**
 * The pinned-window refusal, in one place so the row tests the STRING THE PRODUCT SURFACE SEES
 * rather than a paraphrase of it (#78).
 *
 * The host classifies a context overflow from the provider's error wording
 * (`EXCEEDS_MODEL_CONTEXT` in `@deepseek-ai/dsh-llm/lib/types/error.js`): a subject
 * (`input|prompt|request|messages`), a verb (`exceed(s|ed)|overflow(s)?|is larger than`), and the
 * object (`(the )?(model('s)? )?context( (length|window))?`), all case-insensitive within ~40
 * chars of each other. Wording we invent but the classifier does not read would leave the rig
 * "enforcing" a window that never triggers recovery — a quieter failure than the one it fixes.
 */
export const OVERFLOW_REFUSAL = {
  message: 'This model\'s maximum context length is {window} tokens. However, your prompt resulted in {actual} tokens, which exceeds the context window.',
  type: 'invalid_request_error',
  code: 'context_length_exceeded',
} as const

/** Same estimator the rig uses elsewhere (serialized bytes / 4); deliberately crude and honest. */
export function estimateRequestTokens(body: unknown): number {
  try {
    const b = body as { messages?: unknown }
    const msgs = Array.isArray(b?.messages) ? b.messages : []
    const chars = msgs.reduce((n: number, m) => {
      const c = (m as { content?: unknown })?.content
      return n + (typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length)
    }, 0)
    return Math.ceil(chars / 4)
  } catch {
    return 0
  }
}

/** The refusal body for an over-window request, or null when the request may proceed. */
export function windowRefusal(body: unknown, windowTokens: number): { error: { message: string; type: string; code: string } } | null {
  if (!(windowTokens > 0)) return null
  const est = estimateRequestTokens(body)
  // a knife-edge margin invites a rig that refuses the request the host would have accepted;
  // the point is the pressure regime, not arithmetic coincidence
  if (est <= windowTokens) return null
  return {
    error: {
      message: OVERFLOW_REFUSAL.message.replace('{window}', String(windowTokens)).replace('{actual}', String(est)),
      type: OVERFLOW_REFUSAL.type,
      code: OVERFLOW_REFUSAL.code,
    },
  }
}
