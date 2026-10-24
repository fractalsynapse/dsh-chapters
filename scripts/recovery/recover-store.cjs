/**
 * var/recover-store.cjs — one command to bring a clobbered registry back to the files' truth (#101).
 *
 * Sequence, and why this order:
 *   1. union the best backup's rows into the live registry (adds records, never drops the newer live ones)
 *   2. `--apply files` through the SHIPPED repair code (src/repair-run.js) so registration follows the
 *      same rules as any repair: journal, backup, twin refusal, no renumbering
 *   3. normalize: drop duplicate `(number)` records keeping the one whose sha256 matches the file's
 *      bytes, adopt the twins the runner refused under next-free numbers when the operator says so,
 *      and repair `nextChapterNumber` (a NaN counter would make every later save refuse)
 *
 * Step 3's adoption is operator authority, not a repair class: registering a file whose number is spent
 * is precisely the decision `chapters-repair` refuses to make alone (AGENTS: a chapter is never
 * renumbered in place; damage is superseded under a new number). `--adopt-twins` says make it.
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const HOME = process.env.DSH_HOME || '/home/adrian/.dsh'
const REG = path.join(HOME, 'storages', 'dsh_chapters.json')
const STORE = path.join(ROOT, '.dsh-chapters')
const ME = 'session-9a69fbbc-6389-48ad-bfd1-5ba8c0e92a83'
const adoptTwins = process.argv.includes('--adopt-twins')
const unionSrc = process.argv.find((a) => a.startsWith('--union-from='))?.slice(13)

const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
const rowsOf = () => JSON.parse(fs.readFileSync(REG, 'utf8')).tables.sessions
const write = (reg) => { const t = REG + '.tmp'; fs.writeFileSync(t, JSON.stringify(reg, null, 2) + '\n'); fs.renameSync(t, REG) }
const total = (rows) => Object.values(rows).reduce((s, r) => s + ((r.chapters || []).length), 0)

function step (name, message) { console.log(`· ${name}: ${String(message)}`) }

// 1 — union
if (unionSrc !== undefined) {
  const dir = path.join(HOME, 'storages')
  fs.copyFileSync(REG, path.join(dir, `dsh_chapters.json.pre-recover-${Date.now()}.bak`))
  const reg = JSON.parse(fs.readFileSync(REG, 'utf8'))
  const src = JSON.parse(fs.readFileSync(path.isAbsolute(unionSrc) ? unionSrc : path.join(dir, unionSrc), 'utf8'))
  const key = (c) => `${String(c.number)}#${String(c.sha256 || '')}`
  let added = 0
  for (const [id, row] of Object.entries(src.tables.sessions)) {
    let dst = reg.tables.sessions[id]
    if (dst === undefined) { reg.tables.sessions[id] = row; continue }
    const have = new Set((dst.chapters || []).map(key))
    for (const c of row.chapters || []) if (!have.has(key(c))) { (dst.chapters = dst.chapters || []).push(c); have.add(key(c)); added++ }
    dst.nextChapterNumber = Math.max(dst.nextChapterNumber || 1, row.nextChapterNumber || 1)
    for (const f of ['collections', 'finalized', 'planDocs']) {
      const a = Array.isArray(dst[f]) ? dst[f] : [], b = Array.isArray(row[f]) ? row[f] : []
      const k = (x) => JSON.stringify(x).slice(0, 200), m = new Map(a.map((x) => [k(x), x]))
      for (const x of b) if (!m.has(k(x))) m.set(k(x), x)
      if (m.size >= a.length) dst[f] = [...m.values()]
    }
  }
  write(reg)
  step('union', `${String(added)} records added, total now ${String(total(rowsOf()))}`)
}

// 2 — shipped repair registers uncited files (journals, backs up, refuses twins)
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'chapters-repair.mjs'), '--project', ROOT, '--apply', 'files', '--yes'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const applied = (/applied (\d+) move/.exec(out) ?? [, '0'])[1]
  const refused = (/refused: (\d+)/.exec(out) ?? [, '0'])[1]
  step('repair --apply files', `${applied} moves, ${refused} refused`)
} catch (e) { step('repair --apply files', 'FAILED: ' + String(e.message).split('\n')[0]) }

// 3 — normalize
const reg = JSON.parse(fs.readFileSync(REG, 'utf8'))
let dupes = 0, adopted = 0, counters = 0
for (const [id, row] of Object.entries(reg.tables.sessions)) {
  const byNum = new Map()
  for (const c of row.chapters || []) { const a = byNum.get(c.number) || []; a.push(c); byNum.set(c.number, a) }
  const keep = []
  for (const [n, list] of byNum) {
    if (list.length === 1) { keep.push(list[0]); continue }
    const good = list.map((c) => { const abs = path.resolve(ROOT, String(c.path)); let h = null; try { h = sha(abs) } catch { /* gone */ } return { c, ok: h !== null && h === c.sha256 } })
    const chosen = good.find((g) => g.ok) || good[0]
    dupes += list.length - 1
    keep.push(chosen.c)
  }
  keep.sort((a, b) => a.number - b.number)
  row.chapters = keep
  const want = (keep.length ? Math.max(...keep.map((c) => c.number)) : 0) + 1
  if (!Number.isFinite(row.nextChapterNumber) || row.nextChapterNumber < want) { row.nextChapterNumber = want; counters++ }
}
if (adoptTwins) {
  const me = reg.tables.sessions[ME]
  const dir = path.join(STORE, ME, 'chapters')
  const cited = new Set((me.chapters || []).map((c) => String(c.path).split('/').pop()))
  let n = Math.max(0, ...(me.chapters || []).map((c) => c.number))
  const shape = (me.chapters || [])[0] || {}
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md') && !x.startsWith('plan-') && !cited.has(x))) {
    const abs = path.join(dir, f), text = fs.readFileSync(abs, 'utf8')
    const fm = (k) => new RegExp('^' + k + ':\s*(.*)$', 'm').exec(text)?.[1]?.trim()
    const range = JSON.parse(fm('seqRange') || '[]')
    n += 1
    const rec = { number: n, path: path.relative(ROOT, abs), title: (fm('title') || f).replace(/^"|"$/g, ''), summary: (fm('summary') || '').replace(/^"|"$/g, ''), topics: [], startSeq: range[0] ?? 0, endSeq: range[1] ?? 0, sha256: sha(abs), status: 'active', adoptedFrom: f, repairs: 1 }
    for (const k of Object.keys(shape)) if (rec[k] === undefined) rec[k] = Array.isArray(shape[k]) ? [] : (typeof shape[k] === 'number' ? 0 : '')
    (me.chapters = me.chapters || []).push(rec); adopted++
  }
  me.chapters.sort((a, b) => a.number - b.number)
  me.nextChapterNumber = Math.max(0, ...me.chapters.map((c) => c.number)) + 1
}
write(reg)
step('normalize', `${String(dupes)} duplicate records dropped, ${String(counters)} counters repaired, twins adopted: ${String(adopted)}`)

const me = rowsOf()[ME]
const files = fs.readdirSync(path.join(STORE, ME, 'chapters')).filter((x) => x.endsWith('.md') && !x.startsWith('plan-'))
const cited = new Set(me.chapters.map((c) => String(c.path).split('/').pop()))
console.log(`MY row: ${String(me.chapters.length)} chapters, next ${String(me.nextChapterNumber)} | files ${String(files.length)}, cited ${String(files.filter((f) => cited.has(f)).length)}, uncited ${String(files.filter((f) => !cited.has(f)).length)}`)
console.log(`registry total: ${String(total(rowsOf()))} chapter records across ${String(Object.keys(rowsOf()).length)} rows`)
