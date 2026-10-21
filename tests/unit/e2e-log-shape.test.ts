/**
 * The rig must read WHATEVER durable-log format the pinned host writes (#54).
 *
 * Two rows, both cheap and both the kind of thing that silently turns a green
 * suite into a vacuous one: a helper hardcoded to `session.v3.jsonl.zstd`, and a
 * host that moves the format again. On 0.2.x the log is `session.v4.jsonl.zstd`,
 * and every log-backed assertion had been returning '' — "the archive never
 * landed" — with no complaint anywhere.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionLogFileFor } from '../e2e/session.ts'

test("the resolver follows the host format, and takes the newest when a dir migrated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-shape-'))
  try {
    assert.equal(sessionLogFileFor(dir), null, 'no log yet is a NULL answer, never a guess')
    fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), 'old')
    assert.equal(sessionLogFileFor(dir), path.join(dir, 'session.v3.jsonl.zstd'))
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'new')
    assert.equal(sessionLogFileFor(dir), path.join(dir, 'session.v4.jsonl.zstd'),
      'a migrated session carries both; the durable one is the higher format')
    fs.writeFileSync(path.join(dir, 'session.lock'), '')
    fs.writeFileSync(path.join(dir, 'session.v2.jsonl.gz'), '')
    assert.equal(sessionLogFileFor(dir), path.join(dir, 'session.v4.jsonl.zstd'),
      'only the zstd jsonl family counts; a lock file or another codec is not a log')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('no e2e file hardcodes a log format again', () => {
  for (const f of fs.readdirSync('tests/e2e').filter((x) => /\.(ts|mjs)$/.test(x))) {
    const raw = fs.readFileSync(path.join('tests/e2e', f), 'utf8')
    // drop comment lines: documentation is ALLOWED to name the formats it explains
    const src = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    // CODE-shaped only: a quoted path fragment. Prose that NAMES the formats (the
    // comment on sessionLogFileFor explains exactly this drift) must not trip a
    // guard — a row that fails on documentation gets deleted instead of fixed.
    assert.ok(!/['"`]session\.v\d+\.jsonl\.zstd|path\.join\([^)]*session\.v\d/.test(src),
      `${f} builds a session-log path by hand — use sessionLogFileFor, or the next host rename reads as a missing archive`)
  }
})
