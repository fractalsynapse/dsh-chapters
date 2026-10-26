/**
 * The client entry's own contract — the row that should have existed before a swallowed newline hid a
 * declaration inside a comment (#113).
 *
 * `export const inject` is how the host loader hands this bundle its services. When it sat on the same line
 * as the `//` above it, the statement became a comment: the type-checker said nothing (the identifier was
 * simply absent, and nothing in this file referenced it), the bundle still built, and the client would have
 * booted without `remote.commands` — i.e. the bar silently never pulled. A missing declaration is not a type
 * error if no one reads the name, so the shape has to be pinned structurally.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const entry = fs.readFileSync(path.join(ROOT, 'src', 'client', 'index.ts'), 'utf8')

test('the inject list is a real statement, not a comment continuation (#113)', () => {
  const line = entry.split('\n').find((l) => l.includes('export const inject'))
  assert.ok(line !== undefined, 'the client entry must declare what it needs')
  assert.equal(line.startsWith('export const inject'), true,
    `a line that starts with // is a comment: ${line.slice(0, 90)}`)
  assert.ok(!line.includes('//'), 'and carries no comment on it that could swallow it again')
  for (const dep of ['slots', 'remote', 'remote.commands', 'sessions', 'uiWorkspace']) {
    assert.ok(line.includes(`'${dep}'`), `${dep} must stay declared — the dock pulls through remote.commands`)
  }
})

test('every module the client ships is inside the strict plane (#71)', () => {
  const strict = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.client.strict.json'), 'utf8')) as { files: string[] }
  const listed = strict.files.map((f) => path.basename(f))
  for (const f of ['index.ts', 'doors.ts', 'prompt-bar.ts', 'prompt-dock.ts']) {
    assert.ok(listed.includes(f), `${f} unlisted = unchecked = silently untyped`)
  }
})

test('no merge markers survived into the shipped source (#113)', () => {
  const files = ['src/client/index.ts', 'src/prompt.ts', 'tsconfig.client.strict.json', 'src/prompt-loop.ts', 'src/prompt-state.ts', 'src/commands.ts']
  for (const f of files) {
    const body = fs.readFileSync(path.join(ROOT, f), 'utf8')
    assert.ok(!/^<<<<<<< /m.test(body) && !/^>>>>>>> /m.test(body) && !/^=======$/m.test(body),
      `${f} still contains a conflict marker — the merge was resolved incompletely`)
  }
})
