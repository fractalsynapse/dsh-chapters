/**
 * var/adopt-twins.cjs — the operator-authority half of twin recovery (#101, #95).
 *
 * `chapters-repair` refuses to register a file whose chapter number is already spent: choosing a winner
 * is a human call (AGENTS: a chapter is never renumbered in place). This is that call, made explicit —
 * it registers the refused orphans under NEXT-FREE numbers with `adoptedFrom` naming the original file,
 * so the record is honest about its history, and never touches a byte of any chapter body.
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const REG = process.argv[2], ROOT = process.argv[3], TREE = process.argv[4]
const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
const reg = JSON.parse(fs.readFileSync(REG, 'utf8'))
let adopted = 0
for (const [id, row] of Object.entries(reg.tables.sessions)) {
  const dir = path.join(TREE, id, 'chapters')
  if (!fs.existsSync(dir)) continue
  const cited = new Set((row.chapters || []).map((c) => String(c.path).split('/').pop()))
  const shape = (row.chapters || [])[0] || {}
  let n = Math.max(0, ...(row.chapters || []).map((c) => c.number))
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md') && !x.startsWith('plan-') && !cited.has(x))) {
    const abs = path.join(dir, f), text = fs.readFileSync(abs, 'utf8')
    const fm = (k) => new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(text)?.[1]?.trim()
    const range = JSON.parse(fm('seqRange') || '[]')
    n += 1
    const rec = { number: n, path: path.relative(ROOT, abs), title: (fm('title') || f).replace(/^"|"$/g, ''),
      summary: (fm('summary') || '').replace(/^"|"$/g, ''), startSeq: range[0] ?? 0, endSeq: range[1] ?? 0,
      sha256: sha(abs), status: 'active', adoptedFrom: f, repairs: 1 }
    for (const k of Object.keys(shape)) if (rec[k] === undefined) rec[k] = Array.isArray(shape[k]) ? [] : (typeof shape[k] === 'number' ? 0 : '')
    ;(row.chapters = row.chapters || []).push(rec); adopted++
  }
  row.chapters.sort((a, b) => a.number - b.number)
  row.nextChapterNumber = Math.max(0, ...row.chapters.map((c) => c.number)) + 1
}
const tmp = REG + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n'); fs.renameSync(tmp, REG)
console.log('twins adopted under next-free numbers:', adopted)
