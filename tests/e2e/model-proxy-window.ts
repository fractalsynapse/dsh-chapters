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

/**
 * Bytes → tokens, CALIBRATED against the host's own meter rather than a guess.
 *
 * Measured on 0.2.0-rc.2 in one leg: a request of **78,140** serialized bytes was reported by
 * `tokenMeter.measure()` as 27,306 / 27,952 / 28,928 tokens — about **2.8 bytes per token**. My
 * first version used the conventional 4 and counted only message content, which under-counted a
 * real request by ~40%: `heavy` ran a 120,129-byte prompt that the host measured at 35,428 tokens
 * (over its 32,000 window) and the proxy let through as "27K", so enforcement never fired and the
 * leg looked unchanged. Two bugs in one line: the divisor, and ignoring the header (system prompt,
 * tool schemas, templates) that the host counts.
 *
 * So: whole serialized body, divided by 3. Slightly conservative on purpose — an enforcement that
 * fires a little early still exercises the pressure regime, while one that fires late exercises
 * nothing. The number lives here with its measurement, not in a config someone can drift.
 */
export const BYTES_PER_TOKEN = 3
export const BYTES_PER_TOKEN_MEASURED = 2.8

export function estimateRequestTokens(body: unknown): number {
  try {
    return Math.ceil(JSON.stringify(body ?? '').length / BYTES_PER_TOKEN)
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
