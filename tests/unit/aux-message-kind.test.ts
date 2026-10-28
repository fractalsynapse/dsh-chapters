/**
 * Session format v4 retired the catch-all `plugin` source kind, and the retired shape must not survive in source (#128).
 *
 * `@deepseek-ai/dsh-llm`'s `MessageSourceMap` documents it directly: *"Merge-extensible sum type — each producer
 * declares its own kind in its own module; there is **no shared catch-all `plugin` kind**."* Since host 0.2.x a bare
 * `kind: 'plugin'` is refused at row admission (measured back in #43, when every continuation started refusing), and
 * our own archive screen in `src/injections.ts` keys off the producer-owned `plugin:dsh-chapters` — so the retired
 * spelling is both a runtime refusal risk and a screen the code would read wrong.
 *
 * Four sites still carried it, and they survived every gate for two minors because the repo TYPE-CHECKED against
 * 0.1.5-rc.2 while the rig BOOTS 0.2.0-rc.2 (see `host-dep-pinning.test.ts`). This row is the guard that makes that
 * silence expensive: it scans the shipped source, not the compiler's mood.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(import.meta.dirname, '..', '..', 'src')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

test('no shipped source passes the retired bare plugin source kind', () => {
  const offenders: string[] = []
  for (const file of tsFiles(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // Comment lines are excluded on purpose: prose may QUOTE the retired spelling to explain it
      // (`injections.ts` documents which producers used it), while code may not CARRY it. The guard's
      // subject is what ships in a call, not what a comment mentions.
      const code = line.trim()
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return
      if (/kind:\s*'plugin'/.test(line) && /plugin:/.test(line)) {
        offenders.push(`${path.relative(SRC, file)}:${String(i + 1)}: ${line.trim().slice(0, 80)}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `session format v4 has no catch-all 'plugin' kind; a producer declares its own\n  ${offenders.join('\n  ')}`)
})

test('an auxiliary one-off prompt is a user message, which is what it is', async () => {
  const { auxPromptMessage } = await import('../../src/aux-message.ts')
  const m = auxPromptMessage('Summarise this session in one line.') as unknown as
    { content: Array<{ text?: string }>; source?: { kind?: string } }
  assert.equal(m.content[0]?.text, 'Summarise this session in one line.', 'the prompt text survives')
  assert.equal(m.source?.kind, 'user',
    `an aux prompt is the user-role input to one llm.stream call, never a session row, so it claims no producer (got ${String(m.source?.kind)})`)
})
