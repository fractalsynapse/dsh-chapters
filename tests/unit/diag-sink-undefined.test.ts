/**
 * #417 — a sink value that is really a MISSING value must resolve to NO SINK.
 *
 * Measured cost of the hole: a file literally named `undefined` appeared in the repo root holding
 * REAL diagnostics (composition-skip notes with genuine `reason=` payloads) that nobody looked at —
 * the exact "mechanism that detects and then loses the evidence" the architecture record exists to
 * end. How it forms: `process.env.X = undefined` stringifies to the nine-letter word, a host-side
 * config merge can stringify a missing value the same way, and `diagnosticSink()` believed any
 * string. A test's own restore path (`= prevSink` without the `=== undefined` arm) is what wrote it
 * in the reproduction; the guard belongs in the seam, not only in the caller.
 *
 * These rows run in a temp cwd so any stray write lands SOMEWHERE VISIBLE — the assertion is that
 * the directory stays empty, which is exactly what the acceptance names. The env value is set
 * INSIDE the isolation helper: a first draft set it before the call and the helper's own cleanup
 * wiped it, turning the refusal rows green for the wrong reason — the discipline this repo exists for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  configureDiagnostics,
  diagnostic,
  diagnosticSink,
  diagnosticStatusLine,
  resetDiagnosticStateForTests,
} from '../../src/diag.ts'

const ENV = 'DSH_CHAPTERS_ENGINE_ERRORS'

/**
 * Run fn in a fresh temp cwd with env cleared and module sink state reset, THEN let fn set whatever
 * state it wants; returns the dir listing taken BEFORE cleanup — a stray write shows up in the
 * result, which is exactly what the rows assert about.
 */
function isolated(fn: () => void): string[] {
  const prevCwd = process.cwd()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-417-'))
  const prevEnv = process.env[ENV]
  delete process.env[ENV]
  configureDiagnostics(undefined)
  resetDiagnosticStateForTests()
  process.chdir(dir)
  let listing: string[] = []
  try {
    fn()
    listing = fs.readdirSync(dir)
  } finally {
    process.chdir(prevCwd)
    if (prevEnv === undefined) delete process.env[ENV]
    else process.env[ENV] = prevEnv
    configureDiagnostics(undefined)
    resetDiagnosticStateForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return listing
}

test('#417: env literally "undefined" is refused as a path — cwd stays clean, the line still returns', () => {
  const listing = isolated(() => {
    process.env[ENV] = 'undefined'
    const line = diagnostic('door:test', 'a real diagnostic')
    assert.match(line, /a real diagnostic/, 'the composed line is still returned — callers keep their channel')
    assert.equal(diagnosticSink(), undefined, 'the sink resolves to NO SINK, not the string')
  })
  assert.deepEqual(listing, [],
    `no file may be written from a stringified missing value, got: ${JSON.stringify(listing)}`)
})

test('#417: "null" is refused the same way, and the refusal is SAID ONCE (stderr), never per-call spam', () => {
  const notes: string[] = []
  const ws = process.stderr.write.bind(process.stderr)
  const listing = isolated(() => {
    process.env[ENV] = 'null'
    process.stderr.write = ((o: typeof ws) => (c: Parameters<typeof ws>[0], ...r: Parameters<typeof ws>) => {
      notes.push(String(c)); return o(c, ...r)
    })(ws)
    try {
      diagnostic('door:test', 'one'); diagnostic('door:test', 'two'); diagnostic('door:test', 'three')
    } finally { process.stderr.write = ws }
  })
  assert.deepEqual(listing, [], 'nothing on disk')
  const refusals = notes.filter((n) => /sink refused/.test(n))
  assert.equal(refusals.length, 1, `the refusal must be said exactly once per process, got ${String(refusals.length)}`)
  assert.match(refusals[0]!, /#417/, 'and it names the record that explains it')
})

test('#417: a stringified missing reaching the CONFIGURED sink (host config merge) is refused too', () => {
  const listing = isolated(() => {
    // what an untyped config merge can hand the seam: String(undefined) as the value
    configureDiagnostics('undefined' as string)
    assert.equal(diagnosticSink(), undefined, 'the configured poison resolves to NO SINK')
    diagnostic('realm:engine', 'note')
    assert.match(diagnosticStatusLine(), /REFUSED/, 'the status line names the refusal, not just absence')
  })
  assert.deepEqual(listing, [], `no file may be written from a stringified configured value, got: ${JSON.stringify(listing)}`)
})

test('#417: with NO env and no configured sink, diagnostic() writes nothing (acceptance control row)', () => {
  const listing = isolated(() => {
    const line = diagnostic('door:test', 'hello')
    assert.match(line, /hello/, 'the line still composes for callers that log it themselves')
  })
  assert.deepEqual(listing, [])
})

test('#417 over-refusal guard: a REAL relative sink still works — only the stringified-missing words are refused', () => {
  const listing = isolated(() => {
    process.env[ENV] = 'diagnostics.log' // a legitimate relative path; resolves under the temp cwd
    diagnostic('door:test', 'kept')
    assert.deepEqual(fs.readdirSync(process.cwd()), ['diagnostics.log'], 'the legitimate sink received the line')
    assert.match(fs.readFileSync(path.join(process.cwd(), 'diagnostics.log'), 'utf8'), /kept/)
  })
  assert.deepEqual(listing, ['diagnostics.log'], 'nothing ELSE was written — the legit relative path is the only artifact')
})
