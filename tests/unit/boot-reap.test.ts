/**
 * The orphan-reaping decision, as rows — because the alternative is an agent or a shell running `pkill -f`
 * with a pattern that matches its own command line, or the live harness. Both were measured today.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ancestorChain, orphanBootPids, parsePs } from '../../tests/e2e/boot-reap.ts'

const ROOT = '/home/adrian/Projects/dsh-chapters'
const ROWS = parsePs([
  `  100  1 node ${ROOT}/dev/dsh-host-lock/node_modules/.bin/dsh web --port 41731 --no-open`,
  `  200  1 node ${ROOT}/dev/dsh-host-lock/node_modules/.bin/dsh web --port 41732 --no-open`,
  `  300  1 node /home/adrian/node_modules/.bin/dsh web --no-open`,
  `  400  50 bash -c cd ${ROOT} && pkill -f "dsh web --port 41731"`,
  `  500  1 node ${ROOT}/dev/dsh-host-lock/node_modules/.bin/dsh web --port 41731 --no-open`,
  `garbage line`,
].join('\n'))

test('ps output parses, and junk lines are skipped rather than guessed', () => {
  assert.equal(ROWS.length, 5, `the garbage row is dropped: ${JSON.stringify(ROWS.map((r) => r.pid))}`)
  assert.equal(ROWS[0]!.ppid, 1)
})

test('only this repo, this port, is a candidate', () => {
  const pids = orphanBootPids(ROWS, ROOT, 41731, 999, new Set<number>())
  assert.deepEqual(pids, [100, 500], 'the other port and the other root are never touched')
})

test('the live harness and a shell whose args merely quote the pattern are excluded', () => {
  const pids = orphanBootPids(ROWS, ROOT, 41731, 999, new Set<number>([300, 400]))
  assert.ok(!pids.includes(300), "pid 300 is the running harness — killing it ends the session")
  assert.ok(!pids.includes(400), 'pid 400 only contains the words in its command line; that is the pkill self-match')
})

test('self and every ancestor are protected, so the reaper cannot kill its own tree', () => {
  const rows = parsePs([
    '  1 0 systemd',
    '  50 1 /usr/bin/bash',
    `  60 50 node dsh web --no-open`,
    `  70 60 node ${ROOT}/dev/dsh-host-lock/node_modules/.bin/dsh web --port 41731 --no-open`,
    `  80 70 bash ${ROOT}/scripts/e2e-one.sh`,
  ].join('\n'))
  const chain = ancestorChain(rows, 80)
  assert.deepEqual([...chain].sort((a, b) => a - b), [1, 50, 60, 70, 80])
  assert.deepEqual(orphanBootPids(rows, ROOT, 41731, 80, chain), [], 'an ancestor holding the port is the run itself, not an orphan')
})

test('a process holding the port that is not dsh web is left for the operator', () => {
  const rows = parsePs(`  7 1 nginx -c ${ROOT}/x --port 41731`).concat(parsePs(`  8 1 nano ${ROOT}/notes.txt`))
  assert.deepEqual(orphanBootPids(rows, ROOT, 41731, 1, new Set<number>()), [])
})
