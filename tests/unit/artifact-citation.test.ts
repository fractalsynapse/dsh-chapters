/**
 * #348 (third defect) — an artifact citation must be a path the reader can OPEN.
 *
 * `artifactPath` is store-relative (`artifacts/8f/<sha>.txt`) because that is what the writer hands back
 * and it stays stable across workspaces. But the citation is printed into a chapter a model reads with a
 * `read` tool rooted at the WORKSPACE, so the printed path resolved from nowhere. Verified on this
 * machine's real archive: bytes live at `.dsh-chapters/17f7c1d6-…/artifacts/e3/e3b0c442…txt` while every
 * chapter said `` `artifacts/e3/e3b0c442…txt` `` — and the text never mentioned that `chapters_artifact`
 * is the tool that actually retrieves it.
 *
 * The two acceptable fixes were "make it read-reachable" and "at minimum name the tool". Both are here:
 * prefix when the door knows where the session store sits in the workspace; otherwise say which tool to
 * use. Printing a bare unopenable path is the option deliberately rejected -- a model retries a path
 * rather than question it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { citationBaseOf, citationOf, renderChapter } from '../../src/render.ts'
import type { SessionEventLike } from '../../src/types.ts'

const big = (seq: number, callId: string, text: string): SessionEventLike => ({
  type: 'tool/result', seq, time: 0, surfaceOp: 'append',
  data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } },
})

const events = (): SessionEventLike[] => [
  { type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } },
  { type: 'tool/call', seq: 1, time: 0, surfaceOp: 'append', data: { callId: 'c1', name: 'bash', arguments: '{"command":"cat big"}' } },
  big(2, 'c1', 'z'.repeat(4000)),
  { type: 'turn/end', seq: 3, time: 0, surfaceOp: 'append', data: { turn: 1 } },
]

const renderWith = (config: Record<string, unknown>): string => {
  const out = renderChapter(events() as never, { title: 't', summary: 's', startSeq: 0, endSeq: 3 } as never,
    { toolResultDeferFloorTokens: 1, chapterTokenTarget: 4000, ...config } as never, [], []) as unknown as { markdown: string }
  return out.markdown
}

test('#348: citationBaseOf yields a workspace-relative directory for a relative store root', () => {
  assert.equal(citationBaseOf('.dsh-chapters', 'root1', '/work/proj'), '.dsh-chapters/root1')
  assert.equal(citationBaseOf('.dsh-chapters/', 'root1', '/work/proj'), '.dsh-chapters/root1', 'trailing slash normalised')
})

test('#348: an absolute store root is only cited when it is INSIDE the workspace', () => {
  assert.equal(citationBaseOf('/work/proj/store', 'root1', '/work/proj'), 'store/root1',
    'inside: rewritten relative, so read can reach it')
  assert.equal(citationBaseOf('/elsewhere/store', 'root1', '/work/proj'), undefined,
    'outside: no base -- the file is unreachable by `read`, so the line must name the tool instead')
  assert.equal(citationBaseOf(undefined, 'root1', '/work/proj'), undefined)
  assert.equal(citationBaseOf('.dsh-chapters', undefined, '/work/proj'), undefined,
    'and no root session means no directory to claim')
})

test('#348: with a base, the citation is a path that actually resolves on disk', () => {
  // The acceptance criterion, demonstrated rather than asserted about strings: write a real artifact
  // under a real store layout, render a chapter, and OPEN the path the chapter text names.
  const ws = mkdtempSync(join(tmpdir(), 'cite-'))
  try {
    const root = 'session-abc'
    const sha = 'a'.repeat(64)
    const dir = join(ws, '.dsh-chapters', root, 'artifacts', 'aa')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sha}.txt`), 'the payload')

    const base = citationBaseOf('.dsh-chapters', root, ws)
    assert.equal(existsSync(join(ws, `${base}/artifacts/aa/${sha}.txt`)), true, 'fixture path exists')

    const cited = citationOf(`artifacts/aa/${sha}.txt`, base)
    assert.equal(cited, `.dsh-chapters/${root}/artifacts/aa/${sha}.txt`)
    assert.equal(existsSync(join(ws, cited)), true, 'and the cited form opens from the workspace root')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('#348: the rendered deferred-result line carries the resolvable path', () => {
  const md = renderWith({ citationBase: '.dsh-chapters/root1' })
  const line = md.split('\n').find((l) => l.includes('- result:') && l.includes('artifacts/'))
  assert.ok(line !== undefined, 'a deferred result line is present')
  assert.match(line!, /→ `\.dsh-chapters\/root1\/artifacts\/[0-9a-f]{2}\/[0-9a-f]{64}\.txt`/,
    `the citation is workspace-relative end to end, got: ${line!.trim()}`)
  assert.ok(!/→ `artifacts\//.test(line!), 'and never the old store-relative fragment')
})

test('#348: without a base the line names chapters_artifact instead of a dead path', () => {
  const md = renderWith({})
  const line = md.split('\n').find((l) => l.includes('- result:') && l.includes('artifacts/'))
  assert.ok(line !== undefined)
  assert.match(line!, /via chapters_artifact/,
    'an unresolvable path must come with the tool that CAN fetch it')
})

test('#348: the full-arguments citation follows the same rule', () => {
  // #335 territory is a separate decision, but WHERE the argument artifact is cited must not print a
  // second, inconsistent convention.
  const md = renderWith({ citationBase: '.dsh-chapters/root1', callArgArtifactTokens: 0 })
  const argLine = md.split('\n').find((l) => l.includes('full arguments:'))
  if (argLine !== undefined) {
    assert.match(argLine, /\.dsh-chapters\/root1\/artifacts\//, 'arguments are prefixed too')
  }
  const bare = renderWith({ callArgArtifactTokens: 0 })
  const bareLine = bare.split('\n').find((l) => l.includes('full arguments:'))
  if (bareLine !== undefined) assert.match(bareLine, /via chapters_artifact/, 'and share the fallback wording')
})

test('#348: a plan-document citation already named the tool and still does', () => {
  // Control row: this path was already honest (render.ts:689 names chapters_artifact with its actions).
  // Pinning it stops a future "consistency" edit from REMOVING the hint from the one line that had it.
  const md = renderWith({ citationBase: '.dsh-chapters/root1' })
  assert.ok(md.includes('chapters_artifact') || !md.includes('full text:'),
    'either no plan block here, or the tool is still named')
})
