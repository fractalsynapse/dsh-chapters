/**
 * Every realm key the rig writes into the profile must be READ by the plugin (#129, found 2026-10-27).
 *
 * `realmPinsOf()` writes `noAuxModel: true`, and `boot.ts` says it "disables automatic compaction AND plot
 * elicitation, so the request sequence the tape carries is the whole story". It does nothing of the kind:
 * `noAuxModel` appears nowhere in `src/` — only in rig pins and rig tests. A determinism switch that no code
 * consumes is worse than no switch, because the comment and the passing pin test both assert the boot is
 * insulated from mid-journey compaction, and it is not. That is exactly how "the same corpus misses a different
 * set of legs on each machine" survived three investigations.
 *
 * So the guard is mechanical, not editorial: for each key the rig can write, the plugin source must reference it.
 * When a key's consumer is removed in a refactor, this fails here rather than silently changing what acceptance
 * measures.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(import.meta.dirname, '..', '..', 'src')
const REALM_KEYS = ['thresholdRatio', 'artifactStoreRoot', 'knowledgeMirrorDir', 'toolResultArtifactTokens', 'enrichmentEnabled', 'noAuxModel']

const sourceText = (): string =>
  fs.readdirSync(SRC).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n')

test('the rig writes no realm key that the plugin does not read', () => {
  const text = sourceText()
  const unread = REALM_KEYS.filter((k) => !new RegExp(`\\b${k}\\b`).test(text))
  assert.deepEqual(unread, [],
    `these keys are configured by the rig and read by nobody — either implement the gate or delete the claim: ${unread.join(', ')}`)
})
