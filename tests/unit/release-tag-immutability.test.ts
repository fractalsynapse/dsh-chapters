/**
 * A pushed tag is immutable (maintainer rule, 2026-10-24).
 *
 * The `release-workflow` skill used to instruct the opposite — "If a tag was pushed incorrectly, delete
 * it … before creating the correct one" — and I followed it literally: the first `0.2.0` tag hit a failing
 * publish gate, so I deleted the tag and re-cut `0.2.0` on a different commit. Nothing was half-published
 * (the gate stopped it), but a version number that meant two different commits on two machines is exactly
 * the identity ambiguity this project refuses everywhere else — a chapter's identity is `(number, sha256)`,
 * never the number alone. A release number is a chapter number's bigger sibling.
 *
 * The rule now: a bad release gets a NEW version. Deleting a tag is legitimate only while it is still
 * local — never pushed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const skill = fs.readFileSync(path.join(ROOT, '.dsh', 'skills', 'release-workflow', 'SKILL.md'), 'utf8')

test('the release skill forbids deleting a pushed tag and requires a new version', () => {
  assert.match(skill, /tag[s]? .* never delete|do not delete a pushed tag/i,
    'the skill must state the prohibition, because an agent follows the file, not the memory')
  assert.match(skill, /new version|next patch/i, 'and name the remedy: a new release number')
  assert.doesNotMatch(skill, /git push origin :refs\/tags/, 'the delete-a-pushed-tag command must not survive in the skill')
})
