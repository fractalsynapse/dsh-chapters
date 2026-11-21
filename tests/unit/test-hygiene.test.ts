/**
 * #456 (lint half) / #452 — the fixed-sleep quiescence ratchet.
 *
 * A bare `await new Promise((r) => setTimeout(r, N))` waiting for background work to
 * FINISH is a wall-clock guess about a machine under load: the subagent-settlement
 * acceptance row flaked exactly that way in the #451 four-stream sweep (120 ms is not a
 * property of the waterfall, it is a property of an idle laptop). #452 replaced it with
 * artifact-observed quiescence; this ratchet keeps the pattern from spreading — and from
 * coming back. Same shape as the e2e-typecheck ratchet the repo already trusts: the count
 * per file may only SHRINK, never grow, and a new file starts at zero.
 *
 * Sanctioned forms excluded from the count:
 *   - predicate polling: the setTimeout tick sits inside a loop whose predicate is checked
 *     (same or previous line mentions `while (`/`for (`/`pred(`/`Date.now() <`), the
 *     prompt-runner.test.ts:45 idiom;
 *   - negative windows: the sleep asserts NOTHING happens and the line above says so
 *     (`// negative-window:`);
 *   - settle() loop-flushes (setImmediate, not a clock).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const BARE = /^(\s*)await new Promise\(\(r\) => setTimeout\(r, \d+\)\)\s*$/

/** count the bare fixed-sleep quiescence sites under dir (recursive, .ts only). */
export function bareSleepSites(dir: string): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p); continue }
      if (!f.name.endsWith('.ts')) continue
      const lines = fs.readFileSync(p, 'utf8').split('\n')
      let n = 0
      for (let i = 0; i < lines.length; i++) {
        if (!BARE.test(lines[i]!)) continue
        const around = `${lines[i - 1] ?? ''} ${lines[i]!}`
        if (/while \(|for \(|pred\(\)|Date\.now\(\) </.test(around)) continue // predicate loop tick
        if (/negative-window/.test(around)) continue // deliberate silence window, annotated
        n++
      }
      if (n > 0) out.set(path.relative(dir, p), n)
    }
  }
  walk(dir)
  return out
}

// Frozen 2026-11-20 (#456): these sites predate the ratchet; converting them is progress,
// keeping them from multiplying is THIS test. Shrinking a number (or deleting an entry)
// is the direction of travel; growing one, or naming a new file, fails the run.
const RATCHET: Record<string, number> = {
  'unit/prompt-runner.test.ts': 8,
  'unit/enrich-queue.test.ts': 5,
  'unit/dev-install-sdk-service.test.ts': 3,
  'unit/session-rules.test.ts': 2,
  'unit/rig-fault-miss.test.ts': 2,
  'unit/save-command.test.ts': 1,
  'unit/prompt-onready.test.ts': 1,
  'unit/engine-adapter.test.ts': 1,
  'unit/auto-save-listener.test.ts': 1,
  'integration/treedx-live.test.ts': 1,
  'e2e/boot.ts': 1,
}

test('#456 ratchet: no file exceeds its frozen bare-sleep count, and none is new', () => {
  const found = bareSleepSites(path.join(ROOT, 'tests'))
  const regressions: string[] = []
  for (const [file, n] of found) {
    const cap = RATCHET[file]
    if (cap === undefined) regressions.push(`${file}: ${String(n)} new bare-sleep site(s) — never sanctioned before the ratchet`)
    else if (n > cap) regressions.push(`${file}: ${String(n)} > frozen ${String(cap)} — the count may only shrink`)
  }
  assert.deepEqual(regressions, [], `fixed-sleep quiescence is a load-flake generator; use the until()/settle() idiom from tests/integration/subagent-auto-save.test.ts or annotate // negative-window:\n${regressions.join('\n')}`)
})

test('#452: the flaking files are FULLY converted — zero bare sleeps in subagent-auto-save', () => {
  const found = bareSleepSites(path.join(ROOT, 'tests', 'integration'))
  assert.equal(found.get('subagent-auto-save.test.ts') ?? 0, 0,
    '#452 replaced every drain with observed quiescence; a reintroduction here is the #451-load flake coming back')
})

test('#456: the ratchet scan is not vacuous — a fixture with a new site reddens it (mutation proof)', () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'hygiene-'))
  try {
    fs.writeFileSync(path.join(dir, 'evil.test.ts'), 'await new Promise((r) => setTimeout(r, 120))\n')
    const found = bareSleepSites(dir)
    assert.equal(found.get('evil.test.ts'), 1, 'the scan must count the exact defect it guards')
    fs.writeFileSync(path.join(dir, 'good.test.ts'), 'while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))\n')
    assert.equal(bareSleepSites(dir).get('good.test.ts'), undefined, 'the predicate-loop idiom is sanctioned, never flagged')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
