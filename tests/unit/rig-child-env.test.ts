/**
 * The boot's child env must not inherit the developer’s live session (#56, #89 family).
 *
 * `spawn('dsh web', { env: { ...process.env, DSH_HOME: E2E_HOME } })` overrides the HOME but leaves
 * `DSH_PROFILE_DIR` — which inside a running harness session points at the DEVELOPER's live profile
 * (`/home/<user>/.dsh/profiles/web`, with every plugin that machine has mounted). So the throwaway home was
 * decorative: the boot composed the developer's plugin set, and the system header — message 0 of every
 * request, and therefore the thing every tape is keyed on — came out 7,276 characters here against 2,783 on a
 * GitHub runner that has no such variable. Four regime hypotheses (host install, copied storages, header
 * sections, the profile base) were burned before this was checked, because the mechanism that fixes the BINARY
 * (#89: "a linked dev build wearing the pin's version string") had never been applied to the PROFILE.
 *
 * A version string is not identity; neither is a directory you meant to override.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { rigChildEnv } from '../../tests/e2e/boot.ts'

const AMBIENT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/dev',
  DSH_HOME: '/home/dev/.dsh',
  DSH_PROFILE: 'web',
  DSH_PROFILE_DIR: '/home/dev/.dsh/profiles/web',
  DSH_SESSION_ID: 'session-abc',
  DSH_WEB_URL: 'http://127.0.0.1:3080',
  DSH_SHELL: '/bin/bash',
  QWEN_TOKEN_PLAN_API_KEY: 'kept-credential',
}

test('the rig child env drops the ambient session profile and identity', () => {
  const child = rigChildEnv(AMBIENT, { home: '/tmp/dsh-e2e/e2e-home-41731', port: 41731 })
  for (const key of ['DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_PROFILE']) {
    assert.equal(child[key], undefined, `${key} must not reach the boot — it re-points the rig at the developer's live profile`)
  }
  assert.equal(child.DSH_HOME, '/tmp/dsh-e2e/e2e-home-41731', 'the throwaway home IS still honored')
})

test('the child env keeps what the leg needs and never the ambient identity', () => {
  const child = rigChildEnv(AMBIENT, { home: '/tmp/h', port: 4173 })
  assert.equal(child.PATH, '/usr/bin', 'the toolchain stays reachable')
  assert.equal(child.HOME, '/home/dev', 'HOME is not the rig business')
  assert.equal(child.QWEN_TOKEN_PLAN_API_KEY, 'kept-credential', 'credentials pass through untouched (#89 rule)')
  assert.match(String(child.DSH_CHAPTERS_ENGINE_ERRORS), /e2e-engine-errors-4173\.log$/, 'diagnostics stay port-keyed')
})
