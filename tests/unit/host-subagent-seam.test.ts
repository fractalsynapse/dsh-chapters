/**
 * Host-drift gate for the subagent lifecycle seam (issue #47).
 *
 * Door 5 leans on three published host facts. None is in our type system, so a
 * host rename would otherwise turn into silently-missing archives, not a red row:
 *
 *   F1  the emitter still publishes `subagent/start` / `subagent/end` through the
 *       service (`observeRun` / `emitLifecycle`), with `end` carrying
 *       `stopReason` (+ optional `lastAssistantMessage`) — our subscription surface.
 *   F2  `childSessionMeta` still stamps the child header with `parentSession` and
 *       `origin: "subagent"` — our gate and our lineage frontmatter.
 *   F3  the disposal ordering: the foreground path AWAITS the run result before it
 *       disposes (`settleForegroundRun`), which is why the listener's synchronous
 *       snapshot at `end` sees a live handle (measured: spikes/subagent-end).
 *
 * L4 upstream-watch style: text-pin the installed bundles; resolve from the repo,
 * walking to the global install like Node itself does (the dev box has it at
 * ~/node_modules). If NOTHING resolves, the rows are unmeasured — named SKIP,
 * never silent (the host-seed-contract precedent).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require_ = createRequire(import.meta.url)

function readInstalled(pkg: string, rel = 'lib/index.js'): { text: string } | { missing: string } {
  for (const p of [`${pkg}/${rel}`, `${pkg}`]) {
    try {
      const entry = require_.resolve(p)
      const file = p.endsWith(rel) ? entry : require_.resolve(`${pkg}/${rel}`)
      return { text: fs.readFileSync(file, 'utf8') }
    } catch { /* try the next candidate / next resolution root */ }
  }
  // Node resolution walked parents already; last try: the profile-global tree.
  try {
    const dir = process.env.HOME + '/node_modules/' + pkg + '/' + rel
    return { text: fs.readFileSync(dir, 'utf8') }
  } catch {
    return { missing: `${pkg}/${rel} not resolvable from this machine` }
  }
}

const subagent = readInstalled('@deepseek-ai/dsh-subagent')
const tool = readInstalled('@deepseek-ai/dsh-tool-subagent')
const skip = (r: { text?: string; missing?: string }): string | false => (r.text !== undefined ? false : `SKIP — ${r.missing}`)

test(`${subagent.text !== undefined ? 'RUN' : 'SKIP'} — the seam publishes subagent/start and subagent/end`, { skip: skip(subagent) }, () => {
  assert.ok(subagent.text !== undefined)
  assert.match(subagent.text, /emit\("subagent\/start"/, 'F1: the emitter stopped naming subagent/start — door 5 would never fire')
  assert.match(subagent.text, /emit\("subagent\/end"/, 'F1: same for subagent/end')
  assert.match(subagent.text, /stopReason/, 'F1: the terminal payload lost stopReason')
})

test(`${subagent.text !== undefined ? 'RUN' : 'SKIP'} — childSessionMeta still stamps parentSession + origin`, { skip: skip(subagent) }, () => {
  assert.ok(subagent.text !== undefined)
  const at = subagent.text.indexOf('function childSessionMeta')
  assert.ok(at >= 0, 'F2: childSessionMeta was renamed — find the new stamp site before trusting the gate')
  const body = subagent.text.slice(at, at + 900) // window, not brace-matching: spread-ternaries own the first }
  assert.match(body, /parentSession:\s*parentHeader\.id/, 'F2: header.parentSession is gone — lineage frontmatter would dangle')
  assert.match(body, /origin:\s*"subagent"/, 'F2: header.origin marker is gone — the gate predicate needs re-deriving')
})

test(`${tool.text !== undefined ? 'RUN' : 'SKIP'} — the foreground path settles the result BEFORE disposing`, { skip: skip(tool) }, () => {
  assert.ok(tool.text !== undefined)
  const at = tool.text.indexOf('async function settleForegroundRun')
  assert.ok(at >= 0, 'F3: settleForegroundRun renamed — re-derive the emit-vs-dispose ordering before shipping door 5 on this host')
  const body = tool.text.slice(at, at + 900)
  const execution = body.search(/await Promise\.allSettled/) // first statement: await the run's execution
  const dispose = body.search(/run\.dispose\(\)/)
  assert.ok(execution >= 0 && dispose >= 0 && execution < dispose,
    'F3: dispose now precedes awaiting the run result — subagent/end may fire after the handle is gone; the durable fallback becomes the primary arm')
})
