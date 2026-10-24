/**
 * The proxy takes an ephemeral port unless someone names one (#78).
 *
 * Boots must set E2E_PROXY_PORT because the profile patch has to name the proxy URL before the
 * proxy is listening; unit tests must NOT inherit a fixed default, or two files in the same pass
 * fight over it and one of them hangs. Two behaviors, two rows — the bug was only visible as a
 * 400-second "pending promise" in a file that had nothing to do with ports.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startModelProxy } from '../../tests/e2e/model-proxy.ts'

async function proxy(dir: string) {
  return await startModelProxy({ mode: 'replay', tapeDir: dir, journalPath: path.join(dir, 'misses.log') })
}

test('two proxies with no port in the env coexist on distinct ephemeral ports', async () => {
  const prev = process.env.E2E_PROXY_PORT
  delete process.env.E2E_PROXY_PORT
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-a-'))
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-b-'))
  try {
    const pa = await proxy(a)
    const pb = await proxy(b)
    assert.notEqual(pa.url, pb.url, `both bound the same port: ${pa.url}`)
    assert.match(pa.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/, 'the URL reports the port actually bound, not one assumed')
    await pa.close(); await pb.close()
  } finally {
    if (prev !== undefined) process.env.E2E_PROXY_PORT = prev
    fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true })
  }
})

test('a named port is honored — the boot patch must reference it before listen', async () => {
  const prev = process.env.E2E_PROXY_PORT
  process.env.E2E_PROXY_PORT = '43123'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-fixed-'))
  try {
    const p = await proxy(dir)
    assert.equal(p.url, 'http://127.0.0.1:43123/v1')
    await p.close()
  } finally {
    if (prev !== undefined) process.env.E2E_PROXY_PORT = prev
    else delete process.env.E2E_PROXY_PORT
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
