/**
 * #406 — model-identity proof for every rig mode that WRITES tape.
 *
 * Measured incident: this box's endpoint lists only `qwen3-4b-instruct` yet silently ANSWERS requests
 * for the pinned `qwen3.8-flash-next` (vLLM falls back to the loaded model for unknown names). A record
 * run on it produced sessions that worked, suggestions shaped as raw `think` traces, and fifteen tape
 * entries describing a model the rig does not pin — live-class evidence that was not about the pinned
 * model at all. The predicate that prevents that lives here, tested without a network: the caller in
 * tests/e2e/boot.ts fetches and feeds these functions; a non-empty verdict means REFUSE, by name.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { servedModelVerdict, stubEndpointVerdict, modelsListIds, chatServedId } from '../support/model-parity.ts'

const RIG = 'qwen3.8-flash-next'

test('#406: an endpoint that lists the pinned id AND answers as it PASSES', () => {
  const list = JSON.stringify({ data: [{ id: RIG }, { id: 'other' }] })
  const chat = JSON.stringify({ model: RIG, choices: [{ message: { content: 'pong' } }] })
  assert.equal(servedModelVerdict({ listText: list, chatText: chat, requested: RIG }), null)
})

test('#406: the measured alias — unknown name silently served by the loaded model — REFUSES and names what IS served', () => {
  const list = JSON.stringify({ data: [{ id: 'qwen3-4b-instruct', root: 'Qwen/Qwen3-4B-AWQ' }] })
  const chat = JSON.stringify({ model: 'qwen3-4b-instruct', choices: [] })
  const v = servedModelVerdict({ listText: list, chatText: chat, requested: RIG })
  assert.ok(v !== null, 'must refuse')
  assert.match(v, /qwen3-4b-instruct/, 'refusal names the served model')
  assert.match(v, /qwen3\.8-flash-next/, 'refusal names the requested model')
})

test('#406: listed correctly but answering different — still the alias class; REFUSE', () => {
  const list = JSON.stringify({ data: [{ id: RIG }] })
  const chat = JSON.stringify({ model: 'qwen3-4b-instruct', choices: [] })
  assert.ok(servedModelVerdict({ listText: list, chatText: chat, requested: RIG }) !== null)
})

test('#406: an explicitly remapped upstream (E2E_UPSTREAM_MODEL) is honored when listed AND proven', () => {
  const list = JSON.stringify({ data: [{ id: 'served-name' }] })
  const chat = JSON.stringify({ model: 'served-name', choices: [] })
  assert.equal(servedModelVerdict({ listText: list, chatText: chat, requested: 'served-name' }), null)
})

test('#406: unreadable payloads fail CLOSED with a named reason — never a silent pass', () => {
  assert.ok(servedModelVerdict({ listText: 'not json', chatText: '{}', requested: RIG }) !== null)
  assert.ok(servedModelVerdict({ listText: '{"data":[]}', chatText: '{}', requested: RIG }) !== null)
  assert.ok(servedModelVerdict({ listText: '{}', chatText: '{"model":123}', requested: RIG }) !== null)
})

test('#406: the parse helpers stay total (they run on hostile payloads)', () => {
  assert.deepEqual(modelsListIds(undefined), [])
  assert.deepEqual(modelsListIds('{"data":"nope"}'), [])
  assert.equal(chatServedId('{}'), null)
  assert.equal(chatServedId('{"model":"x"}'), 'x')
})

// ────────────────────────────── #409: the stub-class witness (the leg kinds split)

test('#409: a pure stub endpoint — everything listed is stub-prefixed — PASSES on the stub leg', () => {
  const list = JSON.stringify({ data: [{ id: 'stub-plan-carriage' }] })
  const chat = JSON.stringify({ model: 'stub-plan-carriage', choices: [] })
  assert.equal(stubEndpointVerdict({ listText: list, chatText: chat }), null)
})

test('#409: a mixed list is NOT stub-class — one real id disqualifies the whole endpoint', () => {
  const list = JSON.stringify({ data: [{ id: 'stub-plan-carriage' }, { id: 'qwen3-4b-instruct' }] })
  const chat = JSON.stringify({ model: 'stub-plan-carriage', choices: [] })
  const v = stubEndpointVerdict({ listText: list, chatText: chat })
  assert.ok(v !== null)
  assert.match(v, /qwen3-4b-instruct/, 'the refusal names the real id that broke the class')
})

test('#409: the measured alias box is refused on the STUB leg too — its only listed id is a real model', () => {
  const list = JSON.stringify({ data: [{ id: 'qwen3-4b-instruct' }] })
  const chat = JSON.stringify({ model: 'qwen3-4b-instruct', choices: [] })
  assert.ok(stubEndpointVerdict({ listText: list, chatText: chat }) !== null)
})

test('#409: an unparseable or empty stub-list fails closed like everything else here', () => {
  assert.ok(stubEndpointVerdict({ listText: 'nope', chatText: '{}' }) !== null)
  assert.ok(stubEndpointVerdict({ listText: '{"data":[]}', chatText: '{}' }) !== null)
})

test('#409: the stub witness is about the LIST — the chat arm only proves it answers as its first listed id', () => {
  // The stub's own provenance note: its `model` field ECHOES the request name and is documented
  // NOT-provenance. So the witness uses the endpoint's OWN first listed id, and requires the echo
  // to come back identical — an endpoint that lists stub ids but answers differently is broken.
  const list = JSON.stringify({ data: [{ id: 'stub-plan-carriage' }] })
  assert.ok(stubEndpointVerdict({ listText: list, chatText: JSON.stringify({ model: 'something-else' }) }) !== null)
})
