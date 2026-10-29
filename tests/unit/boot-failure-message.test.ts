/**
 * A dead boot must say what the child was doing when it died (#165).
 *
 * Measured cost of the current behaviour: ~90 minutes of elimination tonight, because the runner threw
 * `e2e boot failed within 120066ms waited (port 41732)` while the child's own log — already on disk, and proof the
 * process was alive — held the one line that separated "hung before listening" from "crashed". AGENTS' delivery rule
 * (#61): if the code already has the bytes, they reach the human. These rows pin the message, including the two ways it
 * can lie: an absent log, and a log that is empty.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootFailureMessage, TAIL_BUDGET_CHARS } from '../e2e/boot-failure.ts'

test('the message carries the port, the wait, the ceiling, the log path and the child tail', async () => {
  const msg = bootFailureMessage({
    port: 41732, waitedMs: 120066, ceilingMs: 120000,
    logPath: 'var/e2e-server-41732.log',
    tail: '[chapters-prompt] turn/end door armed\n',
  })
  assert.match(msg, /boot failed within 120066ms/, 'the measured wait stays')
  assert.match(msg, /port 41732/, 'the port stays')
  assert.match(msg, /E2E_BOOT_TIMEOUT_MS/, 'and the knob that raises it for diagnosis, named')
  assert.match(msg, /child log tail \(var\/e2e-server-41732\.log\):/, 'the log path is named, not implied')
  assert.match(msg, /turn\/end door armed/, 'and the child\'s own line is in the message')
})

test('an empty tail is stated as a fact, never as silence', () => {
  const msg = bootFailureMessage({
    port: 41737, waitedMs: 120001, ceilingMs: 120000, logPath: 'var/e2e-server-41737.log', tail: '   \n',
  })
  assert.match(msg, /tail: \(empty\)/, `"an empty log is itself evidence and must read that way, got: ${msg}"`)
})

test('a missing log file says so rather than pretending the child produced nothing', () => {
  const msg = bootFailureMessage({ port: 41739, waitedMs: 120003, ceilingMs: 120000, logPath: 'var/gone.log', tail: null })
  assert.match(msg, /unreadable or never written/, 'the two cases stay distinct')
  assert.doesNotMatch(msg, /\(empty\)/, 'absence is not emptiness')
})

test('an exhausted inotify watch budget is named as the cause, not left as a hang (#165)', () => {
  // Measured 2026-10-29: 65,387 of 65,536 watches consumed, and the host's HMR layer answered with ENOSPC. The rig's
  // dead boots printed this in the same pipe and the runner still only said `boot failed within 120000ms`, so a
  // maintainer saw a hang and reasonably suspected the plugin. Five words would have ended it.
  const msg = bootFailureMessage({
    port: 41735, waitedMs: 120066, ceilingMs: 120000, logPath: 'var/e2e-server-41735.log',
    tail: "hmr (@deepseek-ai/dsh-hmr): Error: ENOSPC: System limit for number of file watchers reached, watch '/x'\n",
  })
  assert.match(msg, /file-watcher budget exhausted/, `the cause must be named, got: ${msg}`)
  assert.match(msg, /fs\.inotify\.max_user_watches/, `and point at the knob that fixes it, got: ${msg}`)
  assert.match(msg, /not a plugin defect|environment/i, `and say whose layer it is, got: ${msg}`)
})

test('the tail is bounded and never echoes the boot URL, which carries the session token', () => {
  const secret = `http://127.0.0.1:41731/?token=${'A'.repeat(64)}`
  const long = `${'x'.repeat(TAIL_BUDGET_CHARS + 900)}\n${secret}`
  const msg = bootFailureMessage({ port: 41731, waitedMs: 120002, ceilingMs: 120000, logPath: 'var/x.log', tail: long })
  assert.ok(msg.length < TAIL_BUDGET_CHARS + 400, `message must stay bounded, got ${String(msg.length)} chars`)
  assert.doesNotMatch(msg, /token=/, 'a boot URL line must never be lifted into a failure message or a CI annotation')
  assert.match(msg, /…\[redacted\]$/, 'and the reader can see something was dropped rather than inferring it')
})
