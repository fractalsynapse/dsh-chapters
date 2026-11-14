/**
 * acquireChapterStore: the one-domain-one-opener rule (r27b's product bug —
 * DomainFacility.open reserves the name and only close() releases it; every
 * second opener threw already-open and broke compaction).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acquireChapterStore, type DomainLike } from '../../src/store.ts'

const fakeDomain = (): DomainLike => ({
  table() {
    const m = new Map<string, any>()
    return { get: (k) => m.get(k), put: async (k, v) => { m.set(k, v) }, entries: () => m.entries(), get size() { return m.size } }
  },
  close: async () => {},
})

test('first acquirer opens and owns', async () => {
  const live = fakeDomain()
  const facility = {
    opened: false,
    async open() { if (this.opened) throw Object.assign(new Error("domain 'dsh_chapters' is already open"), { code: 'already-open' }); this.opened = true; return live },
    get: () => (facility.opened ? live : undefined),
  }
  const h = await acquireChapterStore(facility)
  assert.equal(h.owner, true)
  const second = await acquireChapterStore(facility)
  assert.equal(second.owner, false) // adopts the live handle, no close ownership
  await second.store.put('x', { parentSession: null, rootSession: 'x', nextChapterNumber: 1, chapters: [], reservations: {}, plans: {}, finalized: {}, shadowedSeqs: undefined } as never)
  const back = await h.store.get('x') // read through the OPENER's handle: proves both share one table
  assert.equal(back.rootSession, 'x')
})

test('a non-already-open failure propagates untouched', async () => {
  const facility = { async open() { throw new Error('backend gone') }, get: () => undefined }
  await assert.rejects(() => acquireChapterStore(facility as never), /backend gone/)
})

test('already-open with nothing live behind it still throws', async () => {
  const facility = { async open() { throw new Error("domain 'dsh_chapters' is already open") }, get: () => undefined }
  await assert.rejects(() => acquireChapterStore(facility as never), /already open/)
})

test('#330 an in-flight opener commits inside the retry window and is ADOPTED', async () => {
  // The race that broke the realm tools-row: the facility reserves the name before
  // awaiting the backend, so `open` already throws while `get` answers undefined for
  // a few milliseconds. Acquire must wait for the commit and adopt, owner:false.
  const domain = { table: () => ({ get: () => undefined, put: async () => {}, entries: () => [][Symbol.iterator]() }), close: async () => {} }
  let getCalls = 0
  const facility = {
    async open() { throw new Error("domain 'dsh_chapters' is already open") },
    get: () => (++getCalls >= 4 ? domain : undefined),
  }
  const h = await acquireChapterStore(facility as never)
  assert.equal(h.owner, false, 'adoption, not ownership')
  assert.ok(getCalls >= 4, `the window was retried (get calls ${getCalls})`)
  assert.ok(typeof h.store.get === 'function')
})
