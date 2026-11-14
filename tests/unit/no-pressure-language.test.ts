/**
 * #330 — The pressure-language gate (AGENTS § The Model Never Measures Its Context).
 *
 * The defect this row locks shut is behavioral, not compile-shaped: prose that states a
 * token/byte reading of the LIVE session teaches agents to police a gauge they cannot read,
 * and they guess — announcing an almost-full window while most of it is free. That language
 * arrived from three directions over the plugin's life (tool descriptions, the arrival stub,
 * per-bullet TOC estimates); a review rule would have caught each once. This row catches all
 * of them every run: it reads the SAME prompt-surface the tape anchor reads (`scripts/
 * prompt-anchor.mjs` — the model-facing `description`/`label` literals of src/tools.ts,
 * src/commands.ts, src/preset.ts, cordis.patch.yml) plus the runtime-composed model-visible
 * templates this repo authors, and refuses the banned shapes.
 *
 * What is NOT banned, deliberately: the plugin's own artifact measurements that survive as
 * receipts (notice-size refusal numbers, chapter ceilings, deferral floors) and the sink/
 * human-command surface (engine.ts notes, /chapters-status). The rule is about the MODEL's
 * eyes on the MODEL's window — see the AGENTS section for the exact line.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { extractTokens, PROMPT_SURFACE } from '../../scripts/prompt-anchor.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

// Banned in model-facing text: any reading, estimate, or frame of the SESSION's own
// context usage. Ordered specific→general; each phrase names the string that taught it.
const BANNED: Array<{ why: string; re: RegExp }> = [
  { why: 'names the window itself', re: /context window|the window is|your window/i },
  { why: 'the arrival-stub frame', re: /too large to sit in context|not elsewhere in this context|never enters the window/i },
  { why: 'a token/byte reading of the live session', re: /\b(est tokens|remaining tokens|tokens left|tokens remaining)\b/i },
  { why: 'budget framing on the model, not the artifact', re: /budget-checked|token ceiling|Token budget for|budget hint|budgetHint/i },
  { why: 'the fill-gauge invitation', re: /running out of context|about to (fill|exceed)|out of context|how (full|expensive)/i },
  { why: 'we\'re-expensive framing (the segment reach-for)', re: /we'?re expensive/i },
  { why: 'the spent-numbers frame (fork)', re: /numbers spent/i },
]

function surfaceText(): string[] {
  const out: string[] = []
  for (const f of PROMPT_SURFACE) {
    const abs = path.join(ROOT, f)
    if (!fs.existsSync(abs)) continue
    for (const token of extractTokens(f, fs.readFileSync(abs, 'utf8'))) out.push(`${f}: ${token}`)
  }
  return out
}

test('#330 prompt-surface descriptions carry no context-pressure vocabulary', () => {
  const offenders: string[] = []
  for (const line of surfaceText()) {
    for (const b of BANNED) if (b.re.test(line)) offenders.push(`${b.why} — ${line.slice(0, 160)}`)
  }
  assert.deepEqual(offenders, [], `agent-visible prompt bytes state or invite a reading of the model's own context:\n${offenders.join('\n')}`)
})

/** The runtime-composed model-visible templates. These strings do not ride the static
 *  anchor (prompt-anchor.mjs says so in its header), so the gate reads them from source
 *  with their delimiters — a comment can hide from a regex, a template literal cannot. */
const RUNTIME_TEMPLATES: Record<string, RegExp> = {
  'src/arrival.ts': /const stub = (`[^`]*`)/,
  'src/engine-core.ts': /summary: (`[^`]*`)/,
}

test('#330 the arrival stub and the TOC summary templates carry no session gauges', () => {
  for (const [file, grab] of Object.entries(RUNTIME_TEMPLATES)) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const m = grab.exec(src)
    assert.ok(m !== null, `${file}: the template this gate pins moved — re-point the extractor (a silent skip is how a gate dies)`)
    const text = m![1]!
    for (const b of BANNED) {
      assert.ok(!b.re.test(text), `${file}: ${b.why} — found in: ${text.slice(0, 160)}`)
    }
  }
  // Stated positively, so deletion of the gauge is a FACT and not an accident:
  const arrival = fs.readFileSync(path.join(ROOT, 'src', 'arrival.ts'), 'utf8')
  assert.match(arrival, /stored at \$\{rel\}/, 'the stub still names where the full text lives')
  assert.match(arrival, /chapters_artifact/, 'and the verb to reach for')
  const engineCore = fs.readFileSync(path.join(ROOT, 'src', 'engine-core.ts'), 'utf8')
  assert.match(engineCore, /summary: `\$\{userCount\} user \/ \$\{assistantCount\} assistant messages`/, 'TOC summaries count messages, never tokens (#330)')
})

test('#330 the segment payload exposes the deferral fact, not the size numbers', async () => {
  const built = await import('../../src/tools.ts')
  assert.ok(typeof built.registerChaptersTools === 'function' && typeof built.registerChaptersRepairRestore === 'function',
    'the split registrars are the shipped surface (realm tools vs host operator doors)')
  const render = await import('../../src/render.ts')
  // one predicate, both planes: the floor answer, not a number
  assert.equal(render.defersAtArchive(200, 200), false)
  assert.equal(render.defersAtArchive(201, 200), true)
})
