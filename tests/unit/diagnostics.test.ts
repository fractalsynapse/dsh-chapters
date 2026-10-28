/**
 * The diagnostics seam is the most load-bearing part of the system (#54), so it is tested as
 * such: the sink is written from the shared core, not only from the engine; the record carries
 * the whole error, not the composer-sized slice; and no module gets to keep its own copy.
 *
 * The bug this pins is real and recent. On host 0.2.0-rc.2, `chapters-fork` answered
 * `child creation refused: format v4 message requires a producer-owned source kind` and the
 * DSH_CHAPTERS_ENGINE_ERRORS file stayed EMPTY — two copies of the writer existed (realm
 * engine, auto-save) and neither was on the path a user's door takes. Diagnosing it took two
 * browser probes. That is the failure mode: not a missing message, a missing RECORD of one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diagnostic, diagnosticSink, describe as describeError, diagnosticWarn, diagnosticStatusLine } from '../../src/diag.ts'
import { runContinue } from '../../src/continue-core.ts'
import { freshSession } from '../../src/registry.ts'

const withSink = async (fn: (file: string) => Promise<void> | void): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-sink-'))
  const file = path.join(dir, 'errors.log')
  process.env.DSH_CHAPTERS_ENGINE_ERRORS = file
  try { await fn(file) } finally { delete process.env.DSH_CHAPTERS_ENGINE_ERRORS; fs.rmSync(dir, { recursive: true, force: true }) }
}

test('a diagnostic lands in the sink with its origin, and the sink is opt-in', async () => {
  assert.equal(diagnosticSink(), undefined, 'unset means no sink, and no throw')
  await withSink(async (file) => {
    const line = diagnostic('door:fork', 'child creation refused for ch-x')
    assert.match(line, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[door:fork\] child creation refused for ch-x$/)
    assert.equal(fs.readFileSync(file, 'utf8'), line + '\n', 'the composed line is what was written')
    assert.equal(diagnosticSink(), file)
  })
})

test('the record carries the WHOLE error — message, code, and a stack excerpt', async () => {
  await withSink(async (file) => {
    const err = Object.assign(new Error('format v4 message requires a producer-owned source kind'), { code: 'E_ADMISSION' })
    diagnostic('door:fork', 'child creation refused', err)
    const written = fs.readFileSync(file, 'utf8')
    assert.match(written, /format v4 message requires a producer-owned source kind/)
    assert.match(written, /code=E_ADMISSION/)
    assert.match(written, /:: .*Error/, 'a stack excerpt belongs in the file, not the composer')
    assert.ok(describeError(err).includes('E_ADMISSION'))
    assert.equal(describeError(undefined), '(no error object)')
    assert.equal(describeError('plain'), 'plain')
  })
})

test('diagnostics never mask the failure they record', async () => {
  // an unwritable sink is a bad day, not a crash: the real error still has to reach the user
  const saved = process.env.DSH_CHAPTERS_ENGINE_ERRORS
  process.env.DSH_CHAPTERS_ENGINE_ERRORS = '/proc/definitely-not-writable/diag.log'
  try {
    assert.doesNotThrow(() => diagnostic('realm:engine', 'kept working anyway'))
  } finally {
    if (saved === undefined) delete process.env.DSH_CHAPTERS_ENGINE_ERRORS
    else process.env.DSH_CHAPTERS_ENGINE_ERRORS = saved
  }
})

test('diagnosticWarn writes the sink AND warns — one is not enough (r19)', async () => {
  const seen: string[] = []
  await withSink(async (file) => {
    diagnosticWarn({ warn: (m: string) => { seen.push(m) } }, 'auto-save', 'child unreadable at settlement')
    assert.equal(seen.length, 1, 'the operator channel still sees it')
    assert.match(fs.readFileSync(file, 'utf8'), /\[auto-save\] child unreadable at settlement/)
    // a hostile logger must not eat the record
    assert.doesNotThrow(() => diagnosticWarn({ warn: () => { throw new Error('logger exploded') } }, 'x', 'still recorded'))
  })
})

test('THE ACTUAL BUG: a door whose child creation is refused reaches the sink from the CORE', async () => {
  // Nothing here boots a browser or a host: the ports are the same shape the host plane
  // injects, so if this fails, a real `chapters-fork` refusal is invisible again.
  const kernelMessage = 'format v4 message requires a producer-owned source kind'
  await withSink(async (file) => {
    const files = new Map<string, string>()
    let ids = 0
    const ports = {
      readCallerEvents: async () => Array.from({ length: 7 }, (_, seq) => ({
        seq, type: seq % 2 === 0 ? 'user/message' : 'assistant/message',
        data: { content: [{ type: 'text', text: `turn ${String(seq)}` }] },
      })).concat([{ seq: 6, type: 'turn/end', data: {} } as never]),
      // ^ the ceiling is a turn/end boundary; without one the door refuses BEFORE it ever
      // reaches createChild, and the row would be asserting the wrong guard.
      // the REAL state shape, from the registry's own constructor — hand-rolling a fake here
      // once meant the row failed inside reserve() on a field nobody told it about.
      getState: async () => freshSession('A'),
      putState: async () => { },
      // #101: the allocator now reserves through mutate, so a stub that DROPS the mutation would hand back
      // no numbers and the door would fail before createChild — the row would then be asserting a different
      // guard than it claims. Apply fn the way the store does (this file's getState/putState stay no-ops by
      // design: the point is the sink record, not the registry).
      mutateState: async (_id: string, fn: (s: never) => never) => { fn(freshSession('A') as never) },
      fs: () => ({
        async write(p: string, c: string) { files.set(p, c) },
        async read(p: string) { return files.get(p) },
        async exists(p: string) { return files.has(p) },
      }),
      budgetProbe: async () => ({ windowTokens: 131072, headerBoundTokens: 13000 }),
      newId: () => `id-${String(++ids)}`,
      now: () => 1700000000000,
      createChild: async () => { throw new Error(kernelMessage) },
      diagnostic: (where: string, message: string, error?: unknown) => { diagnostic(where, message, error) },
    }
    let refusal: unknown = null
    try {
      await runContinue(ports as never, {
      callerSessionId: 'A', callerPreset: 'chapters', title: 'Widget work',
      handoffNote: 'Mid-refactor.', intent: 'branch', toolResultOverrides: [],
      chapters: [{ title: 'Setup', summary: 'scaffold', startSeq: 0, endSeq: 4 },
        { title: 'Model changes', summary: 'edits', startSeq: 5, endSeq: 6 }],
    } as never, {
        chapterTokenTarget: 8000, toolResultDeferFloorTokens: 1000, continuationBudgetRatio: 0.3,
      } as never)
    } catch (error) { refusal = error }
    // the door surfaces a refusal (thrown here, a value at the tool boundary) — the point of
    // the row is that the SAME event also leaves a record, so assert on both surfaces
    assert.match(JSON.stringify((refusal as { result?: { reason?: string } }).result?.reason ?? String(refusal)),
      /child creation refused/, 'the door still refuses, exactly as before')
    const written = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    assert.match(written, /child creation refused for ch-/, 'the core reported WHICH child it could not create')
    assert.match(written, new RegExp(kernelMessage), 'and the kernel\'s own words survived to the file')
    assert.match(written, /\[door:branch\]|\[door:continue\]/, 'the origin is in the record')
  })
})

test('the status line names the blindness, so an unconfigured sink is visible BEFORE the incident', () => {
  const saved = process.env.DSH_CHAPTERS_ENGINE_ERRORS
  delete process.env.DSH_CHAPTERS_ENGINE_ERRORS
  // AMENDED #61: this row asserted 'NO ERROR SINK' for the unset case, because blindness was the
  // designed default. #61 inverted the default — the first door that touches a project resolves
  // <store-root>/diagnostics.log — so the unset-and-unresolved state is now an ANOMALY (no store root
  // at all), and the line says so. The env override is also named, because an operator who set both a
  // profile path and the env deserves to know which one is live.
  try { assert.match(diagnosticStatusLine(), /NO SINK AT ALL/) } finally {
    if (saved !== undefined) process.env.DSH_CHAPTERS_ENGINE_ERRORS = saved
  }
  process.env.DSH_CHAPTERS_ENGINE_ERRORS = '/tmp/x.log'
  try { assert.match(diagnosticStatusLine(), /^Diagnostics: sink → \/tmp\/x\.log \(env override\)$/) }
  finally { if (saved === undefined) delete process.env.DSH_CHAPTERS_ENGINE_ERRORS; else process.env.DSH_CHAPTERS_ENGINE_ERRORS = saved }
})

test('exactly one module reads the sink env — copies are how planes go blind', () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(ts)$/.test(e.name) || p.includes('/diag.ts')) continue
      // CODE-shaped: a read of the env var. Prose naming it (the comment in engine.ts
      // explains the r19 reason the sink exists) must not trip a guard — a row that fails
      // on documentation gets deleted instead of fixed.
      const src = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      if (/process\.env\.DSH_CHAPTERS_ENGINE_ERRORS|env\s*\.\s*DSH_CHAPTERS_ENGINE_ERRORS/.test(src)) offenders.push(p)
    }
  }
  walk('src')
  assert.deepEqual(offenders, [],
    `these modules touch the sink directly instead of calling src/diag.ts: ${offenders.join(', ')}`)
})
