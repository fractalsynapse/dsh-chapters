/**
 * #352 — the prompt plane must leave a DURABLE trace.
 *
 * The audit found this repo's own `diagnostics.log` holding 21,138 `realm:*` lines, 4 `rules-section`,
 * 4 `auto-save`, and **zero** prompt lines. Everything the suggested-next-step door knew — whether it
 * saw a turn boundary at all, whether the model spec reached the plane, why a round was skipped — went
 * to `console.error` and `ctx.logger` only. On the maintainer's box that is why "the bar is one turn
 * behind" (#340) and the silent mis-nesting (#341) each took a full audit to find: the evidence existed
 * for minutes in a terminal, never in a file.
 *
 * AGENTS.md: "Deliver detected failures to the user or a file." Two rows, because a structural grep on
 * its own is exactly the kind of assertion that passes while the thing is broken:
 *   1. the wiring calls the sink (structural, the `last-resort.test.ts` idiom);
 *   2. a `prompt:`-tagged note really lands in the file (behavioral — proves the sink is live for this
 *      plane's tag, not merely referenced).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureDiagnostics, configureDiagnosticsCap, diagnosticNote, diagnosticWarn } from '../../src/diag.ts'

const src = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')

test('#352: the prompt plane routes its verdicts into the diagnostics sink', () => {
  // The runner's two channels — every skip, claim, ready and failure verdict passes through them.
  assert.match(src, /log: \(m\) => \{ diagnosticNote\(ctx\.logger, 'prompt:door', m\)/,
    'the prompt runner log channel must write the file, not only stderr+logger (#340 was undiagnosable because it did not)')
  assert.match(src, /warn: \(m\) => \{ diagnosticWarn\(ctx\.logger, 'prompt:door', m\)/,
    'and the warn channel likewise')
  // The reload self-check (#319) is prompt-plane too: a doomed seed must reach a file.
  assert.match(src, /diagnosticWarn\(ctx\.logger, 'prompt:reload-check', m\)/,
    'the reload self-check warning must reach the sink')
  // A refused door registration is the loudest possible silent failure.
  assert.match(src, /diagnosticWarn\(ctx\.logger, 'prompt:door', 'turn\/end door registration REFUSED/,
    'a refused door registration must be durable, not just a boot message nobody re-reads')
  // And stderr is KEPT: the rig's throwaway home does not retain ctx.logger, which is why #61 added it.
  const kept = (src.match(/console\.error\(`\[chapters-prompt\]/g) ?? []).length
  assert.ok(kept >= 2,
    `stderr copies must survive for the rig legs (#61) — found ${String(kept)}`)
})

test('#352: a prompt-tagged note actually lands in the file, not just in a call site', () => {
  // The structural row above cannot tell a live sink from a no-op one. This one can: if the file sink
  // is not written for a `prompt:` tag, the audit's central complaint is still true no matter how the
  // wiring reads.
  const dir = mkdtempSync(join(tmpdir(), 'chapters-diag-'))
  const file = join(dir, 'diagnostics.log')
  try {
    configureDiagnostics(file)
    configureDiagnosticsCap(0)
    const loggerLines: string[] = []
    const logger = { info: (m: string) => loggerLines.push(m), warn: (m: string) => loggerLines.push(m) }

    diagnosticNote(logger, 'prompt:door', 'turn 41 already claimed for session-abc')
    diagnosticWarn(logger, 'prompt:door', 'generation failed for session-abc: no route')

    assert.ok(existsSync(file), 'the sink file was created')
    const body = readFileSync(file, 'utf8')
    assert.match(body, /prompt:door.*turn 41 already claimed/, 'the note reached the FILE')
    assert.match(body, /prompt:door.*generation failed/, 'and so did the warning')
    assert.equal(loggerLines.length, 2, 'the profile logger still receives both (no channel dropped)')
    assert.match(loggerLines[0]!, /prompt:door/, 'and the tag is on the logger line too, so one grep works either way')
  } finally {
    configureDiagnostics(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
