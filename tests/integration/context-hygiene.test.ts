/**
 * CONTEXT-SIZE HYGIENE — the 2026-09-25 'are we hardcoding the context?' audit, pinned.
 *
 * The pressure-compaction gate reads the window LIVE from the adapter model config
 * (`ctx.llm.resolveModelInfo(provider, model).context.contextWindow`; the base throws
 * TargetPressureConfigError when it's absent — behavior pinned in
 * tests/unit/engine-lifecycle.test.ts, which also proves the gate consults that source).
 * A user reading 'compaction fired while provider usage said 29,656 of a 64,000 window'
 * reasonably suspected a hardcoded 32K. It was not one: the engine decides on the HOST
 * token-meter's estimate (provider baseline + 4-chars-per-token for content added since
 * the last request), which for that session's tool-heavy surface read ~66,700 >= 0.9 x
 * 64,000. The unit difference is documented in verify.md § CACHE.
 *
 * This test keeps the suspicion unfounded FOREVER: no context-window literal may appear
 * in the shipped surface, and no preset row may pin a window — the number must always
 * come from configuration. (Whitelisted by design: `maxBytes: 65536` is the read tool's
 * byte cap, a file-size policy, not a context claim.)
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

const CONTEXT_LITERALS = /\b(32_?000|32_?768|64_?000|128_?000|131_?072|1_?000_?000)\b/
const WINDOW_KEYS = /contextWindow|maxContextTokens|context_window/i

/**
 * The invariant this file guards is that the plugin never DEFINES or DEFAULTS a context-window
 * config key — the number belongs to the adapter (and the preset row must not pin it either).
 * Matching every MENTION was too blunt: after #78 the engine reads `info.context.contextWindow`
 * precisely in order to REPORT the number the base engine decided with, and the guard fired on a
 * read. A guard that fires on the correct code teaches people to distrust guards, so the two
 * claims are now separate: declaration-shaped text is rejected, reading the host's field is not.
 * The mutation row below pins that the narrower pattern still catches what the rule is about.
 */
const WINDOW_DECLARATION = /(?:^|[\s{,(])(?:contextWindow|maxContextTokens|context_window)\s*:|['"](?:contextWindow|maxContextTokens|context_window)['"]\s*:\s*\d|\bdefault\([^)]*\)\s*\.?(?:contextWindow|maxContextTokens)/


function walk(dir: string, out: string[]): string[] {
  // The composition moved from a shipped preset directory into `src/preset.ts`, so a
  // missing directory is not an error here — it is the shape of this repo now.
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|yml|yaml|js)$/.test(e.name)) out.push(p)
  }
  return out
}

const files = walk(path.join(ROOT, 'src'), [])

test(`no context-window literal in ${files.length} shipped files`, () => {
  const offenders: string[] = []
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.trim().startsWith('*') || line.trim().startsWith('//') || line.trim().startsWith('#')) return
      // A window-sized NUMBER is suspect only where it claims a CONTEXT budget.
      // Char/byte policies (thresholdChars, maxBytes) and per-chapter token targets
      // are archive tuning, user-overridable in the preset, not a hardcoded model
      // context — they may carry the same digits honestly.
      if (!CONTEXT_LITERALS.test(line)) return
      if (/maxBytes|thresholdChars|Chars|Bytes|chapterToken|maxTokens|Budget|budget/.test(line)) return
      offenders.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 90)}`)
    })
  }
  assert.deepEqual(offenders, [], `context-size literals must not ship — the window comes from adapter config:\n${offenders.join('\n')}`)
})

// The rows the plugin registers ARE the preset now: the composition moved from
// presets/chapters/agent.cordis.yml into src/preset.ts, and the rule travels with it.
test('preset rows never pin a window key', () => {
  for (const f of [path.join(ROOT, 'src', 'preset.ts'), ...walk(path.join(ROOT, 'presets'), [])]) {
    const body = fs.readFileSync(f, 'utf8')
    const hit = body.split('\n').find((l) => WINDOW_KEYS.test(l) && !l.trim().startsWith('#'))
    assert.equal(hit, undefined, `${path.relative(ROOT, f)} pins a context window: ${hit?.trim()}`)
  }
})

test('the engine Config declares no window field (adapter-config-only invariant)', () => {
  const body = fs.readFileSync(path.join(ROOT, 'src', 'engine.ts'), 'utf8')
  const code = body.split('\n').filter((l) => !/^\s*(\/\/|\*|#)/.test(l)).join('\n')
  assert.ok(!WINDOW_DECLARATION.test(code),
    'src/engine.ts must not define or default a context-window config key')
  // and the reading of the host's value stays explicitly allowed, or the next agent "fixes" the
  // report by deleting the number that makes it diagnosable
  assert.match(code, /context\?\.contextWindow/,
    'the engine reads the adapter-reported window in order to report a decline with its numbers (#78)')
})

test('the narrowed guard still rejects a declared or defaulted window key (mutation check)', () => {
  // Proves the previous row is not quietly vacuous: three ways to do the forbidden thing, each
  // caught, and one legitimate read, not caught.
  assert.match('  contextWindow: 32_000,', WINDOW_DECLARATION)
  assert.match('  config: { context_window: 32000 }', WINDOW_DECLARATION)
  assert.match('  maxContextTokens: 8192,', WINDOW_DECLARATION)
  assert.doesNotMatch('      const win = info?.context?.contextWindow', WINDOW_DECLARATION,
    'reading the adapter-reported value is the point of the #78 report')
})
