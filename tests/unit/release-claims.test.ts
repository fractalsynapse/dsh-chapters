/**
 * #393 — the release workflow's own claims, checked against how it actually works.
 *
 * `release.yml` stated twice that the `Production` environment enforces tag protection `*.*.*`. Verified via
 * the API: it does not (only `branch_policy`; zero deployment-protection rules; no repo rulesets;
 * `/rules/tags` 404). The claim was **behaviourally** right — a non-semver tag really does not reach the
 * job — but credited to a mechanism that does not exist, which is how a future edit ends up weakening the
 * thing that actually works.
 *
 * So this file pins the real guard rather than the story about it:
 *   1. the trigger filter `tags: ['*.*.*']` exists and is the ONLY semver gate;
 *   2. the version/tag equality step still runs on tag pushes;
 *   3. the false attribution cannot come back — every mention of tag protection must be a denial;
 *   4. non-vacuity: the assertions throw if the file stops looking like the thing under test, because a
 *      comment-scanning test that matches nothing passes forever (#389/#392 lesson, learned the hard way).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const file = join(process.cwd(), '.github/workflows/release.yml')
const src = existsSync(file) ? readFileSync(file, 'utf8') : (() => { throw new Error('release.yml moved — this gate no longer verifies anything') })()

test('#393: the semver gate is the trigger filter, and it is still there', () => {
  // This is the ONLY server-side mechanism that keeps a non-semver tag from running the job. If someone
  // broadens it (e.g. tags: ['**']) believing the environment has tag protection, publish can fire on a
  // tag name that is not a version — and nothing downstream stops it.
  // Capture the literal list entry rather than pattern-matching the glob: an earlier draft tried to
  // regex the shape of '*.*.*' and matched '*.*' instead — a test asserting the wrong thing about a
  // file that was correct. The point is "is it exactly this string", so compare to the string.
  const trigger = /on:\s*\n\s*push:\s*\n\s*tags:\s*\[([^\]]*)\]/.exec(src)
  assert.ok(trigger !== null,
    'release.yml no longer pins the push trigger to a tag pattern at all — that filter IS the semver gate; '
    + 'GitHub tag protection is not configured on this repo (#393, verified via API 2026-11-15)')
  const entries = trigger![1]!.split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
  assert.deepEqual(entries, ['*.*.*'],
    `the push trigger must stay exactly ['*.*.*']; found ${JSON.stringify(entries)} — broadening it lets `
    + 'a tag that is not a version reach the publish job, since nothing server-side stops it (#393)')
})

test('#393: the version/tag equality step still runs on a tag push', () => {
  const i = src.indexOf('name: version / tag consistency')
  assert.ok(i > 0, 'the equality step was renamed or removed — the one check that catches a well-formed wrong tag')
  const after = src.slice(i, i + 400)
  assert.match(after, /if: startsWith\(github\.ref, 'refs\/tags\/'\)/,
    'still scoped to tag pushes: on a manual dispatch there is no tag, which is why #386 added confirm_version')
  assert.match(after, /GITHUB_REF_NAME/, 'and still compares the tag to the manifest version')
})

test('#393: the false attribution cannot return — every mention of tag protection must deny it', () => {
  const mentions = src.split('\n').map((l, i) => ({ n: i + 1, l })).filter((x) => /tag protection/i.test(x.l))
  assert.ok(mentions.length >= 2,
    `expected the file to discuss tag protection at least twice (it needs to say what does NOT exist); `
    + `found ${String(mentions.length)} — this row is the vacuity guard, so check the scan before cheering a pass`)
  for (const m of mentions) {
    const window = src.split('\n').slice(Math.max(0, m.n - 3), m.n + 3).join(' ')
    assert.ok(/\bNOT configured\b|\bdoes NOT enforce\b|\bnot configured\b|\bno repo ruleset\b/i.test(window),
      `line ${String(m.n)} mentions tag protection without denying it — that is the #393 defect returning: ${m.l.trim().slice(0, 90)}`)
  }
})

test('#393: the residual risk is documented where a releaser will read it', () => {
  // A malformed tag costs nothing; a WELL-FORMED WRONG tag publishes an immutable version, because the
  // equality step only sees tags that already matched *.*.*. That asymmetry is the reason the immutability
  // rule is discipline rather than protection, and the file must say so.
  assert.match(src, /well-formed wrong tag/i,
    'release.yml must state that a correctly-shaped but wrong version tag still publishes')
  assert.match(src, /immutable/i, 'and that the consequence is permanent')
})
