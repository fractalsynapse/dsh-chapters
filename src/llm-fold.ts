/**
 * #583: THE one fold for every auxiliary model call (prompt door, enrichment, conflicts probe).
 * Before this module index.ts carried three folds: the door's probed finish chunks but SLICED
 * them to 120 chars before parsing — a provider refusal whose message ran longer became
 * unparseable and vanished — while the enrichment and conflicts folds never probed at all. All
 * three collapsed "refused", "no adapter" and "answered with nothing" into 'the model returned
 * no text', so the maintainer's question — "is the model down, or is that us?" — was literally
 * unanswerable from the record. One predicate per semantic decision (#59): the host's own
 * failure words now surface as a THROW, and only a genuinely textless completion returns ''.
 */
import { BlockAssembler } from '@deepseek-ai/dsh-llm'

/** Pull the host's own failure text out of a `finish` chunk whose reason kind is `error`. */
export function hostStreamFailure(chunks: readonly string[]): string | null {
  for (const raw of chunks) {
    try {
      const j = JSON.parse(raw) as { type?: string; reason?: { kind?: string; failure?: { message?: string } } }
      if (j.type === 'finish' && j.reason?.kind === 'error') {
        const msg = j.reason.failure?.message ?? 'the host reported an error without a message'
        return `host llm.stream failed: ${msg.replace(/\s+/g, ' ').slice(0, 300)}`
      }
    } catch { /* not a JSON chunk line — not an error signal */ }
  }
  return null
}

export async function streamAuxText(
  stream: (req: Record<string, unknown>) => AsyncIterable<unknown>,
  req: Record<string, unknown>,
): Promise<string> {
  const assembler = new BlockAssembler()
  const finishes: string[] = []
  for await (const chunk of stream(req)) {
    // FULL length, never a probe slice: the refusal message is exactly what the sliced probe
    // cut off — the record the maintainer needed was the first thing thrown away.
    if ((chunk as { type?: string }).type === 'finish') {
      try { finishes.push(JSON.stringify(chunk)) } catch { /* unserializable chunk: no signal available */ }
    }
    assembler.push(chunk as never)
  }
  const failure = hostStreamFailure(finishes)
  if (failure !== null) throw new Error(failure)
  return (assembler.blocks() as { type?: string; text?: string }[])
    .filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
}
