/**
 * A busy tape-proxy port must degrade, not abort (#108 class).
 *
 * `E2E_PROXY_PORT` is derived as `boot port + 1000` so parallel legs never collide, but that derivation only
 * covers CONCURRENT boots — it cannot see a proxy orphaned by a killed run. Measured twice on 2026-10-26: a
 * leg killed mid-boot left its proxy on 42733, and every later `heavy` boot died with `listen EADDRINUSE`,
 * which reads like a leaked process and costs a full run to diagnose. Tape matching is HOSTPORT-BLIND and the
 * profile is patched with the proxy's ACTUAL bound URL, so nothing requires a predictable port; refusing to
 * start does.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startModelProxy } from '../../tests/e2e/model-proxy.ts'

test('a second proxy on a busy derived port still binds, on another port', async () => {
  const saved = process.env.E2E_PROXY_PORT
  const taken = await startModelProxy({ mode: 'replay', tapeDir: '/tmp/dsh-proxy-test-tape', journalPath: '/tmp/dsh-proxy-test-journal.log', upstream: 'http://127.0.0.1:1' })
  try {
    const busy = new URL(taken.url).port
    process.env.E2E_PROXY_PORT = busy
    const second = await startModelProxy({ mode: 'replay', tapeDir: '/tmp/dsh-proxy-test-tape', journalPath: '/tmp/dsh-proxy-test-journal.log', upstream: 'http://127.0.0.1:1' })
    try {
      assert.notEqual(new URL(second.url).port, busy, 'it must have landed elsewhere rather than colliding')
      assert.ok(new URL(second.url).port !== '', 'and it must have a port at all')
    } finally { await second.close() }
  } finally {
    if (saved === undefined) delete process.env.E2E_PROXY_PORT
    else process.env.E2E_PROXY_PORT = saved
    await taken.close()
  }
})
