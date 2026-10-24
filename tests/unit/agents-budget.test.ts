/**
 * AGENTS.md must fit the workspace instruction budget (#71-adjacent housekeeping).
 *
 * WHY A TEST AND NOT A NOTE. The file grew to 70,401 bytes against a 65,536 budget, so the harness
 * SILENTLY truncated it on delivery: the rules near the top reached every session and the ones at the
 * bottom reached none. Nobody noticed for an entire release cycle, because a truncated instruction file
 * still looks like an instruction file. The fix is structural — history moved to `docs/project-state.md`
 * and only rules stay — and the guard is a row, because a convention that nothing checks is a
 * convention that decays at the rate of the next interesting commit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const BUDGET = 64_000
const agents = fs.readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8')

test('AGENTS.md fits the workspace instruction budget with room to grow', () => {
  const bytes = Buffer.byteLength(agents, 'utf8')
  assert.ok(bytes <= BUDGET,
    `AGENTS.md is ${bytes} bytes; the harness truncates around 65,244, and a silently-cut rule is worse `
    + 'than a short file. Move history to docs/project-state.md — do NOT cut a rule to fit.')
})

test('the sections that carry the rules are all still here', () => {
  for (const h of ['## The Four Invariants', '## Hard Rules', '## Workflow Gate (MANDATORY)',
    '## Documentation-First Development Cycle (MANDATORY)', '## Data Flow', '## Storage',
    '## Efficiency Rules', '## Rig and metering rules']) {
    assert.ok(agents.includes(h), `section gone: ${h}`)
  }
  // the seven moments are load-bearing: a door that trips no moment never enters the index
  assert.match(agents, /archive moments are exactly seven/, 'the moments list must stay counted and current')
  assert.ok(agents.includes('docs/project-state.md'), 'and the state pointer must exist so history is findable')
})

test('project state moved, it did not vanish', async () => {
  const state = await fs.promises.readFile(new URL('../../docs/project-state.md', import.meta.url), 'utf8')
  assert.ok(state.length > 20_000, `docs/project-state.md should hold the moved history, got ${state.length}`)
  assert.match(state, /Moved out of `AGENTS\.md` verbatim/, 'and say where it came from')
  for (const probe of ['Phase 0 passed', 'Cache behaviour measured', 'P3c', 'Session-plan carriage']) {
    assert.ok(state.includes(probe), `history lost: ${probe}`)
  }
})

test('a rule added here must not be a duplicate of a doc link', () => {
  // the find-fast table exists so the body stays short; a section that stops being linked is how the
  // file grows back past the budget one un-pointed paragraph at a time.
  for (const target of ['docs/contract.md', 'docs/architecture.md', 'docs/development.md', 'docs/verify.md',
    'docs/knowledge-repo.md', 'docs/provider.md', 'docs/plans-carriage.md', 'docs/backlog.md',
    'docs/host-compaction-seam.md', 'docs/project-state.md']) {
    assert.ok(agents.includes(target), `find-fast table lost its pointer to ${target}`)
  }
})
