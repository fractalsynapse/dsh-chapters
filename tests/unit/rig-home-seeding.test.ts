/**
 * The rig boot's home seeding is a tested surface, not commented behavior (#89 LAYER FOUR, #56).
 *
 * Two claims the branch has now paid for three times: (1) nothing from the untracked developer home may decide
 * what a boot composes — which plugins mount decides which instruction paragraphs the host writes into message 0,
 * and message 0 is the tape key (measured: 2,783 chars on a runner against 7,276 here); and (2) a checkout that
 * has never run the dev profile must still boot, because a test bed that only works where it was first built
 * proves nothing about anywhere else.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shouldCopyIntoRigHome, seedRigHomeFromUntrackedDevCopy } from '../../tests/e2e/boot.ts'

test('the untracked dev home cannot smuggle a profile into a rig boot', () => {
  assert.equal(shouldCopyIntoRigHome('settings.yaml'), false, 'the tracked seed owns settings')
  assert.equal(shouldCopyIntoRigHome(path.join('profiles', 'web', 'cordis.patch.yml')), false, 'and the profile patch')
  assert.equal(shouldCopyIntoRigHome('profiles'), false, 'the whole profiles tree — 18 MB of another run’s plugins')
  assert.equal(shouldCopyIntoRigHome(path.join('profiles', 'web', 'node_modules', 'x')), false, 'including its node_modules')
  assert.equal(shouldCopyIntoRigHome(path.join('sessions', 'session-abc')), false, 'never the developer’s transcripts')
  assert.equal(shouldCopyIntoRigHome('e2e.env'), true, 'scratch config that carries no plugin authority')
})

test('a checkout without the untracked dev home still seeds a complete boot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-home-'))
  try {
    const devCopy = path.join(root, '.dshdev-local')
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const absent = seedRigHomeFromUntrackedDevCopy(root, home)
    assert.equal(absent.copied, false, 'an absent dev home is normal, not fatal')
    assert.match(absent.reason, /tracked seeds are authoritative/, 'and it says which authority applies')

    fs.mkdirSync(path.join(devCopy, 'profiles', 'web'), { recursive: true })
    fs.writeFileSync(path.join(devCopy, 'settings.yaml'), 'evil: true\n')
    fs.writeFileSync(path.join(devCopy, 'e2e.env'), 'E2E_X=1\n')
    fs.writeFileSync(path.join(devCopy, 'profiles', 'web', 'cordis.patch.yml'), 'plugins: [mine]\n')
    const present = seedRigHomeFromUntrackedDevCopy(root, home)
    assert.equal(present.copied, true, 'a fresh clone with the dev home still takes it (filtered)')
    assert.equal(fs.existsSync(path.join(home, 'settings.yaml')), false, 'settings.yaml did not cross')
    assert.equal(fs.existsSync(path.join(home, 'profiles')), false, 'no profile tree crossed')
    assert.equal(fs.readFileSync(path.join(home, 'e2e.env'), 'utf8'), 'E2E_X=1\n', 'the allowed file did')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
