/**
 * #531 — retrieval observability rows: the counters module is pure and honest about scope,
 * and the wiring bumps at exactly the three doors, once each, with the status line present.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bumpRetrieval, retrievalStatsFor, formatRetrievalLine, formatRetrievalSummary } from '../../src/retrieval-stats.ts'

test('#531: bumps count per session and verb; formats say THIS PROCESS, never history', () => {
  bumpRetrieval('s-1', 'search'); bumpRetrieval('s-1', 'search'); bumpRetrieval('s-1', 'artifact'); bumpRetrieval('s-2', 'rules')
  assert.deepEqual(retrievalStatsFor('s-1'), { search: 2, artifact: 1, rules: 0 })
  assert.match(formatRetrievalLine('s-1'), /2 search · 1 artifact · 0 rules \(this process\)/)
  assert.match(formatRetrievalLine('s-9'), /no chapters_\* lookups this process/)
  assert.match(formatRetrievalSummary(), /across 2 session\(s\)/, 'summary counts sessions with activity only')
})

test('#531: the three doors bump exactly once each — counted at the door, not in the handler depths', () => {
  const tools = readFileSync(new URL('../../src/tools.ts', import.meta.url), 'utf8')
  const code = tools.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.equal(code.split("bumpRetrieval(").length - 1, 3, 'three call sites: search, artifact, rules — no fourth, no missing')
  for (const verb of ['search', 'artifact', 'rules']) {
    assert.ok(code.includes(`, '${verb}')`), `the ${verb} door bumps`)
  }
  const idx = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  assert.ok(idx.includes('lines.push(formatRetrievalSummary())'), '/chapters-status prints the summary')
})
