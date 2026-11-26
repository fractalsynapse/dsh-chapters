// #548: the diagnostics status line must describe the FRESH BOOT honestly. The sink is lazy by
// design ("first door wins", engine.ts:183 / tools.ts:147) — a process that has run no door has
// NO configured sink and that is the healthy path, not a bug. The bug claim stays for the true
// absence: nowhere to derive the default from.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnosticStatusLine, configureDiagnostics } from '../../src/diag.ts'

test('#548: fresh boot with a workspace prints the lazy-default sentence, never the bug claim', () => {
  const prev = process.env.DSH_CHAPTERS_ENGINE_ERRORS
  delete process.env.DSH_CHAPTERS_ENGINE_ERRORS
  configureDiagnostics(undefined)
  try {
    const line = diagnosticStatusLine('/home/u/proj', '.dsh-chapters')
    assert.match(line, /default sink \/home\/u\/proj\/.dsh-chapters\/diagnostics\.log — not created yet \(lazy by design/, line)
    assert.doesNotMatch(line, /NO SINK AT ALL|this is a bug/, 'the healthy fresh-boot path must not self-report damage')
  } finally {
    if (prev !== undefined) process.env.DSH_CHAPTERS_ENGINE_ERRORS = prev
    configureDiagnostics(undefined)
  }
})

test('#548: no sink AND no derivable cwd keeps the bug claim (it finally means what it says)', () => {
  const prev = process.env.DSH_CHAPTERS_ENGINE_ERRORS
  delete process.env.DSH_CHAPTERS_ENGINE_ERRORS
  configureDiagnostics(undefined)
  try {
    assert.match(diagnosticStatusLine('', '.dsh-chapters'), /NO SINK AT ALL/, 'empty cwd cannot derive a path — still a real absence')
    assert.match(diagnosticStatusLine(), /NO SINK AT ALL/, 'no-site call (roster) keeps the strict arm')
  } finally {
    if (prev !== undefined) process.env.DSH_CHAPTERS_ENGINE_ERRORS = prev
    configureDiagnostics(undefined)
  }
})

test('#548: once a door has configured the sink, the line prints the sink path (regression pin)', () => {
  const prev = process.env.DSH_CHAPTERS_ENGINE_ERRORS
  delete process.env.DSH_CHAPTERS_ENGINE_ERRORS
  try {
    configureDiagnostics('/tmp/whatever/diagnostics.log')
    assert.match(diagnosticStatusLine('/home/u/proj', '.dsh-chapters'), /^Diagnostics: sink → \/tmp\/whatever\/diagnostics\.log$/)
  } finally {
    configureDiagnostics(undefined)
    if (prev !== undefined) process.env.DSH_CHAPTERS_ENGINE_ERRORS = prev
  }
})
