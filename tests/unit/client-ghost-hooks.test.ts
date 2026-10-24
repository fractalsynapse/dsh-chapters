/**
 * The ghost's effects must not turn renders into host calls (#79).
 *
 * React hands a NEW `props` object on every render, so an effect that lists `[props]` re-runs on
 * every render — and for a component that subscribes to the whole input store, that is every
 * keystroke. Measured on the acceptance boots: 4 to 26 durable `chapters-prompt` command pairs per
 * session with the feature switched OFF, i.e. the transcript the chapters archive was being
 * written by a display label. These rows are cheap precisely because the failure was invisible to
 * behavior: the chip looked correct, the log filled with noise, and the OFF test still passed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const src = fs.readFileSync(path.join(ROOT, 'src', 'client', 'index.ts'), 'utf8')

const effectFor = (marker: string): string => {
  const i = src.indexOf(marker)
  assert.ok(i >= 0, `${marker} must still exist in src/client/index.ts`)
  const end = src.indexOf('}, [', i)
  assert.ok(end > i, `${marker}'s effect must be findable`)
  return src.slice(i, src.indexOf('\n', end + 1))
}

test('the model label is fetched once per mount, not once per render (#79)', () => {
  // locate the effect by the guard that makes it once-per-mount, then read its dependency array:
  // the shape that bit us was a correct-looking effect whose DEPS were `[props]`
  const i = src.indexOf('labelFetched.current = true')
  assert.ok(i >= 0, 'the label fetch must be guarded by a mount-scoped ref (see #79: [props] re-runs every render)')
  const region = src.slice(Math.max(0, i - 500), i + 500)
  const deps = /\}, \[([^\]]*)\]/.exec(region)?.[1] ?? region.slice(region.indexOf('}, ['), region.indexOf('}, [') + 30)
  assert.doesNotMatch(deps, /props/,
    `the label effect's deps must not include props (found: "${deps.trim()}") — React makes a new props object per render, so [props] is "every keystroke"`)
  assert.match(region, /fetchLabelRef/, 'the callback is read through a ref, so an unstable identity cannot defeat the guard')
  assert.doesNotMatch(src, /void props\.fetchLabel\(\)/, 'the per-render call must not come back')
})

test('the suggestion fetch keeps its per-boundary guard — it is the reason that path is bounded', () => {
  // the guard sits in the effect's body BEFORE the fetch, so look at the region around the call
  const i = src.indexOf('void props.fetchSuggestion()')
  assert.ok(i >= 0, 'the suggestion fetch must still exist')
  const region = src.slice(Math.max(0, i - 700), i + 400)
  assert.match(region, /fetchedFor\.current === boundary/,
    'the per-boundary ref guard is load-bearing; removing it turns every render into a model call')
  assert.match(region, /fetchedFor\.current = boundary/, 'and it is set before the call, not after')
})

test('an OFF boot asserts the durable command count, not only the missing chip (#79)', () => {
  // the assertion belongs on a journey that boots WITHOUT promptModel — the prompt project's own
  // spec is the ON case, and a passing ON test says nothing about polling when disabled
  const spec = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'fork-button.spec.ts'), 'utf8')
  assert.match(spec, /countGhostCommandRuns\(sessionLogTextById\(sid\)\)/,
    'the OFF boot must count the ghost commands in its own durable log')
  // one probe per mount is the honest bound (the client must ask whether the feature exists at
  // all); per-render is the bug. An unbounded expectation would pass on 4–26 commands.
  assert.match(spec, /\.toBeLessThanOrEqual\(1\)/,
    'and bound it to one capability probe per mount')
  assert.doesNotMatch(spec, /toBeLessThanOrEqual\(\s*(?:[2-9]|[1-9]\d)/,
    'no looser bound sneaks in — the measured bug was 4 to 26 commands per session')
  const helper = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'session.ts'), 'utf8')
  assert.match(helper, /export function countGhostCommandRuns/, 'the counter is shared, not re-derived per spec')
  assert.match(helper, /"command\/run"/, 'and it counts the RUN records, which are the durable evidence')
})
