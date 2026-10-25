/**
 * The rig must mount the plugin as a COPY, not a link (#108).
 *
 * Measured: `file:/home/adrian/Projects/dsh-chapters` installs as a SYMLINK, so the mounted plugin's realpath
 * is the repo; its peer deps install into the repo's node_modules, and every further require walks up from the
 * repo into `~/node_modules` (289 packages on this box, nothing on a runner). That is why the same pinned host
 * composed 7,276 header chars here and 2,783 there — and why a corpus recorded on a laptop cannot replay on CI.
 * A packed tarball is extracted INTO the profile, so resolution terminates at the profile on every machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'bootstrap-dev-profile.sh'), 'utf8')

test('the dev profile packs the plugin instead of linking a directory (#108)', () => {
  assert.match(script, /npm pack[\s\S]{0,200}--pack-destination/, 'the profile install must use a packed tarball')
  assert.doesNotMatch(script, /dependencies\["@treeseed\/dsh-chapters"\]\s*=\s*"file:"\s*\+\s*root/,
    'a `file:<directory>` dependency is a symlink and leaks the developer tree into the rig')
  assert.match(script, /dependencies\["@treeseed\/dsh-chapters"\]\s*=\s*"file:"\s*\+\s*tarball\b/,
    'the mount must name the packed tarball variable, not a directory path (a directory is what npm links)')
  assert.match(script, /TARBALL="\$\(cd "\$ROOT" && npm pack --pack-destination/,
    'the tarball must be packed into the profile directory the install runs in')
})
