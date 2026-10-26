/**
 * var/adopt-twins.cjs — the operator-authority half of twin recovery (#101, #95).
 *
 * `chapters-repair` refuses to register a file whose chapter number is already spent: choosing a winner
 * is a human call (AGENTS: a chapter is never renumbered in place). This is that call, made explicit —
 * it registers the refused orphans under NEXT-FREE numbers with `adoptedFrom` naming the original file,
 * so the record is honest about its history, and never touches a byte of any chapter body.
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
/**
 * Which orphan files may be adopted into a registry row, and which must not (#113 follow-up — this tool
 * admitted the record that became `413-goal-round.md`). Pure and exported so the rules are rows, not prose.
 *
 *  - **A span that overlaps an ACTIVE record is refused.** The old version adopted one record spanning
 *    12633–15794 over 246 committed chapters, titled `<goal_round>` (the injected-title class #59 exists
 *    for) at 273K tokens where the store target is 8K. Overlap is duplicated TOC, double-counted coverage
 *    and wasted enrichment — never something an adoption pass should decide silently.
 *  - **The stored path must match the row's own dialect.** Absolute is legal — the rig pins an absolute
 *    `artifactStoreRoot` per port (#61 item 8) — but MIXED is what broke #69: a comparison through
 *    `sameStoredPath` saw two files where there was one, and the auditor reported a chapter as its own
 *    unregistered twin. The pre-fix version called `path.relative(ROOT, abs)` with the caller's cwd and
 *    stored whatever came back; when the tool ran from elsewhere, `relative()` returns the absolute path
 *    unchanged. That is how four records in one row ended up absolute while the rest were relative.
 *  - A file with no parseable `seqRange` is refused rather than guessed at.
 */
function planAdoption(row, dir, root, sessionId) {
  const { toStoredPath } = require('../../lib/archive.js')
  const adopt = []
  const refused = []
  const active = (row.chapters || []).filter((c) => c.status !== 'superseded')
  const spans = active.map((c) => ({ from: c.startSeq, to: c.endSeq, number: c.number }))
  const cited = new Set(active.map((c) => String(c.path).split('/').pop()))
  const rowAbsolute = active.filter((c) => path.isAbsolute(String(c.path))).length
  const rowDialect = active.length === 0 ? null : (rowAbsolute > active.length / 2 ? 'absolute' : 'relative')
  let n = Math.max(0, ...active.map((c) => c.number))
  const files = fs.readdirSync(dir).filter((x) => x.endsWith('.md') && !x.startsWith('plan-') && !cited.has(x))
  for (const f of files) {
    const abs = path.join(dir, f)
    const text = fs.readFileSync(abs, 'utf8')
    const fm = (k) => new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(text)?.[1]?.trim()
    const rangeRaw = fm('seqRange')
    if (rangeRaw === undefined) { refused.push(`${f}: no seqRange in frontmatter — not adopted`); continue }
    let range
    try { range = JSON.parse(rangeRaw) } catch { refused.push(`${f}: unparseable seqRange ${rangeRaw}`); continue }
    if (!Array.isArray(range) || range.length !== 2 || !Number.isInteger(range[0]) || !Number.isInteger(range[1])) {
      refused.push(`${f}: seqRange is not two integers`); continue
    }
    const [from, to] = range
    const clash = spans.filter((a) => !(a.to < from || a.from > to))
    if (clash.length > 0) {
      refused.push(`${f}: span ${String(from)}–${String(to)} overlaps ${String(clash.length)} active chapter(s) (first: ch.${String(clash[0].number)}) — adoption would duplicate them in the TOC; supersede or repair instead`)
      continue
    }
    const stored = toStoredPath(root, abs)
    const wantAbsolute = path.isAbsolute(String(stored))
    if (rowDialect !== null && (wantAbsolute ? 'absolute' : 'relative') !== rowDialect) {
      refused.push(`${f}: would store ${wantAbsolute ? 'an ABSOLUTE' : 'a RELATIVE'} path (${stored}) into a row whose dialect is '${rowDialect}' — mixed dialect is what made a chapter look like its own unregistered twin (#69); pass the ROOT the store actually uses`)
      continue
    }
    n += 1
    adopt.push({
      number: n, path: stored,
      title: (fm('title') || f).replace(/^"|"$/g, ''),
      summary: (fm('summary') || '').replace(/^"|"$/g, ''),
      startSeq: from, endSeq: to, sha256: sha(abs),
      status: 'active', adoptedFrom: f, repairs: 1,
    })
  }
  return { adopt, refused }
}

module.exports = { planAdoption }

/**
 * The CLI body only. Kept out of module scope on purpose: a previous edit put `process.exit(0)` behind an
 * `require.main` guard, which silently killed any test that imported this file — the guard belonged on the
 * work, not on the process.
 */
function main () {
  const REG = process.argv[2]
  const ROOT = process.argv[3]
  const TREE = process.argv[4]
  if (!REG || !ROOT || !TREE) {
    console.error('usage: node scripts/recovery/adopt-twins.cjs <registry.json> <project-root> <store-root>')
    process.exit(2)
  }
  const reg = JSON.parse(fs.readFileSync(REG, 'utf8'))
  let adopted = 0
  const refusedAll = []
  for (const [id, row] of Object.entries(reg.tables.sessions)) {
    const dir = path.join(TREE, id, 'chapters')
    if (!fs.existsSync(dir)) continue
    const plan = planAdoption(row, dir, ROOT, id)
    adopted += plan.adopt.length
    refusedAll.push(...plan.refused)
    if (plan.adopt.length > 0) {
      row.chapters = [...(row.chapters || []), ...plan.adopt].sort((a, b) => a.number - b.number)
      row.nextChapterNumber = Math.max(0, ...row.chapters.map((c) => c.number)) + 1
    }
  }
  for (const r of refusedAll) console.log('  refused: ' + r)
  const tmp = REG + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n')
  fs.renameSync(tmp, REG)
  console.log(`twins adopted under next-free numbers: ${adopted} | refused: ${refusedAll.length}`)
}

if (require.main === module) main()
