/**
 * The abort must not create the next failure (#108). `watchRigFault` + `process.exit(1)` would strand the
 * booted host on the leg's port, and the following leg dies with "port already in use" — a rig fault
 * manufacturing a flake, which is the confusion this branch has been clearing all week.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installRigFaultGuard } from '../../tests/e2e/rig-fault.ts'

const FAULT = '2026-1-1 RIG-CAPABILITIES tape=suite missing=[goalTool] present=[deliverables]'
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

test('a fault stops the boot BEFORE exiting, exactly once (#108)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'))
  const journal = path.join(dir, 'misses.log')
  const order: string[] = []
  const stop = installRigFaultGuard({
    journal,
    getStopBoot: () => async () => { order.push('stop'); await sleep(40); order.push('stopped') },
    exit: (code) => { order.push(`exit:${String(code)}`) },
    log: (m) => { order.push(`log:${m.split('\n')[0]!.slice(0, 24)}`) },
    intervalMs: 60,
  })
  try {
    await sleep(200)
    assert.deepEqual(order, [], 'no journal yet means no action')
    fs.writeFileSync(journal, `2026-1-1 HIT tape=suite\n`)
    await sleep(200)
    assert.deepEqual(order, [], 'a hit is not a fault')
    fs.appendFileSync(journal, `\n${FAULT}\n`)
    const deadline = Date.now() + 4000
    while (order.length === 0 && Date.now() < deadline) await sleep(60)
    await sleep(150)
    // structure, not a truncated literal: the whole point is the ORDER, and matching on a slice of the log
    // line's text is a test that breaks when the message is reworded for a reason.
    assert.equal(order[0], 'stop', 'stopping the boot is the first thing a rig fault does')
    assert.equal(order[1], 'stopped', 'and the stop is AWAITED — a fired-and-forgotten stop leaves the server on the port')
    assert.ok(order[2]?.startsWith('log:'), `the diagnosis is printed before leaving: ${JSON.stringify(order)}`)
    assert.equal(order[3], 'exit:1', 'exit last, after the port is free')
    fs.appendFileSync(journal, `\n${FAULT}\n`)
    await sleep(250)
    assert.equal(order.filter((x) => x.startsWith('exit')).length, 1, 'and it fires once')
  } finally { stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a failed stop does not swallow the fault (#108)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard2-'))
  const journal = path.join(dir, 'misses.log')
  const seen: string[] = []
  const stop = installRigFaultGuard({
    journal,
    getStopBoot: () => async () => { throw new Error('server would not die') },
    exit: (code) => { seen.push(`exit:${String(code)}`) },
    intervalMs: 50,
  })
  try {
    fs.writeFileSync(journal, `${FAULT}\n`)
    const deadline = Date.now() + 3000
    while (seen.length === 0 && Date.now() < deadline) await sleep(50)
    assert.deepEqual(seen, ['exit:1'], 'the run still aborts — a stuck server is reported downstream, not hidden')
  } finally { stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a fault that predates the boot still reaps it (#108)', async () => {
  // The measured leak: the guard fired while `bootStop` was still null, so the child spawned after the
  // decision to leave and nobody stopped it. The guard must WAIT for the boot to exist.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard3-'))
  const journal = path.join(dir, 'misses.log')
  const order: string[] = []
  let bootStop: (() => Promise<void>) | null = null
  const stop = installRigFaultGuard({
    journal,
    getStopBoot: () => bootStop,
    exit: (code) => { order.push(`exit:${String(code)}`) },
    intervalMs: 50,
    waitMs: 3000,
  })
  try {
    fs.writeFileSync(journal, `${FAULT}\n`)
    await sleep(150)
    // the fault is already there; now the boot appears, exactly as it does in a real globalSetup
    bootStop = async () => { order.push('stop') }
    const deadline = Date.now() + 4000
    while (!order.includes('exit:1') && Date.now() < deadline) await sleep(50)
    assert.deepEqual(order, ['stop', 'exit:1'], `the boot that appeared after the fault must still be stopped: ${JSON.stringify(order)}`)
  } finally { stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a boot that never arrives does not hang the abort (#108)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard4-'))
  const journal = path.join(dir, 'misses.log')
  const seen: string[] = []
  const stop = installRigFaultGuard({ journal, getStopBoot: () => null, exit: (c) => { seen.push(`exit:${String(c)}`) }, intervalMs: 40, waitMs: 250 })
  try {
    fs.writeFileSync(journal, `${FAULT}\n`)
    const deadline = Date.now() + 3000
    while (seen.length === 0 && Date.now() < deadline) await sleep(40)
    assert.deepEqual(seen, ['exit:1'], 'gives up waiting and leaves — the fault is still reported')
  } finally { stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})
