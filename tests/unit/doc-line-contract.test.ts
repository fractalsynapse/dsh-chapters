/**
 * #389 — a `dsh-chapters:` line quoted in the CURRENT-STATE docs must be a line the code can emit.
 *
 * WHY THIS EXISTS. `operations/install.md` shows two boot lines and tells the reader that anything other
 * than the above is a named problem. That makes a quoted sample a contract rather than decoration, and one
 * had already drifted: the roster line gained a trailing clause the page omitted, so **a correctly
 * installed system failed the page's own check** (fixed in #388, which pinned that one line by deriving it
 * from `rosterHealthyLine()`). This file is the general check for the rest — and it is written the way it
 * is because the naive version of it lied.
 *
 * THE LIE, SO IT CANNOT BE REBUILT. The first audit script reported `UNMATCHED: 0` across the corpus, and
 * that all-clear was worthless: eleven of 45 message templates are generic wrappers
 * (`dsh-chapters: ${m}`, `dsh-chapters: ${w}`) which, converted to matchers, accept EVERY line. The tell
 * was not the count — it was that a template in `engine.ts` got credited with matching a string that lives
 * in `preset.ts`. Wrong attribution, not a suspicious number, is what exposed it.
 *
 * So the three properties below are load-bearing and each is asserted here, not assumed:
 *   1. templates are whole-line anchored — prefix matching CANNOT see truncation, the exact defect class;
 *   2. over-permissive templates are excluded, and the exclusion set is asserted NON-EMPTY and named, so
 *      adding a wrapper visibly changes this gate's breadth instead of silently widening its blind spot;
 *   3. a NEGATIVE CONTROL runs the same checker over a line no template can emit and requires it to be
 *      reported. Without this, "0 findings" is indistinguishable from "the matcher is broken".
 *
 * SCOPE: current-state pages only. `changelog.md`, `docs/project-state.md`, `docs/backlog.md` and
 * `docs/superpowers/**` quote what OLDER builds printed — that is the record, not a contract, and a gate
 * that "corrected" them would erase the evidence this release is made of. The exclusion is an explicit
 * list below rather than an omission, with this reason attached.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CWD = process.cwd()

/**
 * Current-state pages are DISCOVERED, not listed.
 *
 * The first draft here carried a hand-written list of ten paths, and its own completeness check promptly
 * failed: two of them (`getting-started.md`, `concepts/data-flow.md`) never existed — guessed from how the
 * site felt organized. A gate whose input list is a guess gets quietly shorter every time someone renames a
 * page, which is the same silent-narrowing failure as a matcher that accepts too much. Walking the tree
 * means adding a page adds it to the contract automatically, and deleting one cannot hide coverage loss.
 */
function walkDocs(dir: string, acc: string[] = []): string[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return acc }
  for (const e of names) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walkDocs(p, acc)
    else if (/\.(md|mdx)$/.test(e)) acc.push(p)
  }
  return acc
}

/** Repo-relative roots scanned for current-state pages. */
const DOC_ROOTS = ['site/src/content/docs', 'docs']

/**
 * Deliberately NOT checked: these pages quote the output of the build they were written against.
 * Editing them to match today's strings would destroy the history the release notes exist to carry — the
 * same reasoning that kept `host-compaction-seam.md`'s since-falsified claim in place next to its
 * correction. Exclusion is an explicit pattern, asserted non-empty by a row below.
 */
const HISTORICAL = /changelog|project-state|backlog|superpowers|verify\.md|frontmatter/

export function currentStateDocs(): string[] {
  const out: string[] = []
  for (const root of DOC_ROOTS) {
    for (const abs of walkDocs(join(CWD, root))) {
      const rel = abs.replace(CWD + '/', '')
      if (HISTORICAL.test(rel)) continue
      out.push(rel)
    }
  }
  return out.sort()
}

const esc = (s: string): string => s.replace(/[.*+?^()|[\]\\]/g, '\\$&')

/** Fixed (non-interpolated) characters. Below the threshold a template asserts nothing about a line. */
const fixedLen = (lit: string): number => lit.split(/\$\{[^}]*\}/).join('').replace(/\s/g, '').length
const MIN_FIXED_CHARS = 30

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { if (e !== 'node_modules') sourceFiles(p, acc) } else if (e.endsWith('.ts')) acc.push(p)
  }
  return acc
}

interface Template { lit: string; file: string; fixed: number }
function collectTemplates(): { all: Template[]; usable: Template[]; vacuous: Template[] } {
  const all: Template[] = []
  for (const f of sourceFiles(join(CWD, 'src'))) {
    const s = readFileSync(f, 'utf8')
    const rel = f.replace(CWD + '/', '')
    for (const m of s.matchAll(/`([^`\n]*dsh-chapters:[^`\n]*)`/g)) all.push({ lit: m[1]!, file: rel, fixed: fixedLen(m[1]!) })
    for (const m of s.matchAll(/['"]((?:dsh-chapters: )[^'"\n]*)['"]/g)) all.push({ lit: m[1]!, file: rel, fixed: fixedLen(m[1]!) })
  }
  const usable = all.filter((t) => t.fixed >= MIN_FIXED_CHARS)
  const vacuous = all.filter((t) => t.fixed < MIN_FIXED_CHARS)
  return { all, usable, vacuous }
}

/** Whole-line anchored: `^` … `$`, every `${…}` a wildcard. Prefix matching would hide truncation. */
function templateToRegExp(lit: string): RegExp {
  const parts = lit.split(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/)
  const body = parts.map((p) => esc(p)).join('[\\s\\S]*?')
  return new RegExp('^' + body.trimEnd() + '$')
}

/** The one checker, used for BOTH the real corpus and the negative control. */
function findUnmatched(lines: { doc: string; line: string }[], matchers: RegExp[]): string[] {
  const bad: string[] = []
  for (const { doc, line } of lines) {
    // An author-written ellipsis is a stated abbreviation, not a claim about exact bytes.
    if (line.includes('…') || line.includes('...')) continue
    if (!matchers.some((re) => re.test(line))) bad.push(`${doc}\n      ${line.slice(0, 160)}`)
  }
  return bad
}

function quotedDocLines(): { doc: string; line: string }[] {
  const rows: { doc: string; line: string }[] = []
  for (const rel of currentStateDocs()) {
    let text: string
    try { text = readFileSync(join(CWD, rel), 'utf8') } catch { continue }
    for (const raw of text.split('\n')) {
      const m = /^\s*[>`|-\s]*(dsh-chapters:[^\r\n]*)$/.exec(raw)
      if (m !== null) rows.push({ doc: rel, line: m[1]!.trimEnd() })
    }
  }
  return rows
}

const { all, usable, vacuous } = collectTemplates()
const matchers = usable.map((t) => templateToRegExp(t.lit))
const docLines = quotedDocLines()

test('#389: the template scan is real, and the vacuous set is named rather than assumed away', () => {
  assert.ok(all.length >= 40, `only ${String(all.length)} message templates found — the scanner is broken, not the docs clean`)
  assert.ok(vacuous.length > 0,
    'the over-permissive exclusion set must be NON-EMPTY: generic wrappers like `dsh-chapters: ${m}` are why '
    + 'the first version of this check reported a false all-clear. If this set is empty, someone removed a '
    + 'wrapper OR the filter broke, and either way the gate just silently widened or died.')
  assert.ok(vacuous.every((t) => t.fixed < MIN_FIXED_CHARS))
  const names = vacuous.map((t) => `${t.file}: ${t.lit.slice(0, 48)} (${String(t.fixed)} fixed)`).sort()
  // Surface the blind spot every time the suite runs. A gate's exceptions should be visible, not folklore.
  console.log(`    #389: ${String(all.length)} templates, ${String(usable.length)} matchable, `
    + `${String(vacuous.length)} EXCLUDED as over-permissive:\n      ${names.join('\n      ')}`)
})

test('#389: every dsh-chapters line quoted in current-state docs is emittable', () => {
  assert.ok(docLines.length > 0, 'the checker found no quoted lines at all — either the pages changed or the scan broke')
  const bad = findUnmatched(docLines, matchers)
  assert.deepEqual(bad, [],
    `quoted output that no template can produce (a user is told to compare against these):\n  ${bad.join('\n  ')}`)
})

test('#389: NEGATIVE CONTROL — the checker reports a line it should, so a zero is meaningful', () => {
  // Without this row, the test above cannot distinguish "the docs are correct" from "the matcher accepts
  // anything". Fabricate two driftings of the real install-page line and require BOTH to be reported.
  const real = usable.find((t) => t.lit.includes('is in the host roster'))
  assert.ok(real !== undefined, 'the roster template must still exist for this control to mean anything')
  const planted = [
    // truncation — the exact #388 defect, which a prefix matcher would wave through
    { doc: 'CONTROL', line: 'dsh-chapters: preset "chapters" is in the host roster — 30 mounted rows all active' },
    // invented tail — no template ends this way
    { doc: 'CONTROL', line: 'dsh-chapters: preset "chapters" is in the host roster — 30 rows and a fabricated clause' },
  ]
  const caught = findUnmatched(planted, matchers)
  assert.equal(caught.length, planted.length,
    `the checker must reject planted drift; it reported ${String(caught.length)} of ${String(planted.length)} — `
    + 'a gate that passes these cannot protect the docs')

  // And the control is honest in the other direction: the FULL current line must be accepted, or the
  // negative control is just a broken matcher that fails everything.
  const full = 'dsh-chapters: preset "chapters" is in the host roster — 30 mounted rows all active — '
    + 'chapter-form compaction and continuations will compose'
  assert.deepEqual(findUnmatched([{ doc: 'CONTROL', line: full }], matchers), [],
    'the genuine line must match, otherwise the control proves nothing')
})

test('#389: historical pages are excluded ON PURPOSE, and the exclusion cannot silently widen', () => {
  for (const p of ['site/src/content/docs/operations/changelog.md', 'docs/project-state.md', 'docs/backlog.md']) {
    assert.ok(HISTORICAL.test(p), `${p} must stay in the historical set — it quotes what older builds printed`)
    assert.equal(currentStateDocs().includes(p), false, `${p} must not be listed as current-state`)
  }
  // The discovered corpus must be substantial, or the scan is broken and the "all match" row is vacuous.
  const docs = currentStateDocs()
  assert.ok(docs.length >= 12, `only ${String(docs.length)} current-state pages discovered — the walk is broken`)
  assert.ok(docs.some((d) => d.includes('install.md')), 'install.md must be in the corpus; it is why this gate exists')
  // And the historical set is non-empty by construction, not by hope.
  const allPages = DOC_ROOTS.flatMap((r) => walkDocs(join(CWD, r)).map((a) => a.replace(CWD + '/', '')))
  const skipped = allPages.filter((p) => HISTORICAL.test(p))
  assert.ok(skipped.length >= 3, `expected several historical pages to exclude, found ${String(skipped.length)}`)
  console.log(`    #389 corpus: ${String(allPages.length)} pages scanned, ${String(docs.length)} current-state, `
    + `${String(skipped.length)} excluded as history (${skipped.slice(0, 5).join(', ')})`)
})
