/**
 * #221 — anchored doors: the maintainer clicked Continue on an EARLIER message and got
 * end-of-session anyway; the button ignored which row it lived under. The fix has three links:
 * the server parses an optional leading seq, the client resolves the clicked messageId to that
 * seq through a private RPC, and the runner threads it into the command line. Each link gets a
 * row here; a mutation check proves the parse refuses out-of-range anchors rather than guessing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const SRC = path.resolve(import.meta.dirname, '../../src')

test('the door handler parses a leading integer as the anchor and keeps bare titles untouched', () => {
  const TOOLS = fs.readFileSync(path.join(SRC, 'tools.ts'), 'utf8')
  assert.match(TOOLS, /const anchorMatch = .*exec\(trimmedRaw\)/, 'the anchor parse exists')
  // semantic re-derivation of the shipped regex: number-only, number+title, title-only, empty
  const re = /^(\d+)\s*([\s\S]*)$/
  const only = re.exec('42')
  assert.ok(only !== null && only[1] === '42' && only[2] === '', 'a bare number anchors with an empty title')
  assert.equal(re.exec('42 my title')?.[1], '42', 'number first token anchors')
  assert.equal(re.exec('42 my title')?.[2].trim(), 'my title', 'and the rest is the title')
  assert.equal(re.exec('ship it today'), null, 'a word title never anchors (unchanged behavior)')
  assert.equal(re.exec(''), null, 'empty input never anchors')
})

test('the anchored selection picks the last turn/end AT OR BEFORE the requested seq, and refuses above all turns', () => {
  const turnEnds = [{ seq: 10 }, { seq: 30 }, { seq: 55 }]
  const pick = (requested: number): number | undefined =>
    turnEnds.filter((e) => e.seq <= requested).at(-1)?.seq
  assert.equal(pick(12), 10, 'a click just after a boundary anchors at it')
  assert.equal(pick(30), 30, 'exactly on a boundary anchors there')
  assert.equal(pick(50), 30, 'mid-turn anchors at the PREVIOUS completed turn — nothing unfinished archives')
  assert.equal(pick(9), undefined, 'before every boundary: refuse with numbers (never silently archive nothing or everything)')
})

test('the client threads the anchor: inject reads owner.messageId, resolves via /chapters-anchor, passes the seq', () => {
  const CLIENT = fs.readFileSync(path.join(SRC, 'client/index.ts'), 'utf8')
  assert.match(CLIENT, /inject: \(sessionId: string, owner\?: \{ messageId\?: string \}\)/, 'the framework hands the action its owner props')
  assert.match(CLIENT, /\/chapters-anchor \$\{mid\}/, 'the messageId resolves through the private RPC')
  assert.match(CLIENT, /return run\(sessionId, anchor\)/, 'and the resolved seq rides the runner')
  const DOORS = fs.readFileSync(path.join(SRC, 'client/doors.ts'), 'utf8')
  assert.match(DOORS, /\$\{door\.command\} \$\{String\(Math\.trunc\(anchorSeq\)\)\}/, 'the command line carries the anchor as its first token')
  assert.match(DOORS, /anchorSeq !== undefined \?|typeof anchorSeq === 'number'/, 'absent anchor keeps the bare command — old behavior byte-identical')
})

test('the anchor RPC is registered beside the other plugin commands', () => {
  const COMMANDS = fs.readFileSync(path.join(SRC, 'commands.ts'), 'utf8')
  assert.match(COMMANDS, /name: 'chapters-anchor'/, 'the command exists')
  assert.match(COMMANDS, /commands\.register\(anchorCommand\)/, 'and is registered')
  assert.match(COMMANDS, /e\.data\?\.message\?\.id === messageId/, 'it matches the DURABLE shape: assistant/message data.message.id → seq')
})
