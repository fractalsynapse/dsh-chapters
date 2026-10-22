#!/usr/bin/env node
/**
 * `chapters-repair` — the offline repair runner (#60).
 *
 * WHY A SEPARATE RUNNER: a repair is most needed when the plugin cannot act — a store whose registry row
 * and files disagree, a session that finished days ago, a machine where the host is not running. This
 * script reads exactly what the host reads and writes exactly what the host writes:
 *   registry:  $DSH_HOME/storages/dsh_chapters.json            (domain rows, whole-value writes)
 *   durable log: $DSH_HOME/sessions/<cwd-slug>/<uuid>/session.v4.jsonl.zstd
 * and it decodes the log with node's own zstd, so the archive can be re-derived with NO host, NO model
 * and NO network. Registry session ids are `session-<uuid>`; the directory is the bare `<uuid>` — the
 * workspace each session belongs to comes from the log's OWN header event, never guessed from a name.
 *
 * It reuses the shipped code, not a copy of it: `lib/repair-run.js` is what `/chapters-repair` runs in
 * the host, so an offline repair and an in-host repair cannot drift. Run `npm run build` first.
 *
 * SAFETY. Dry-run is the DEFAULT. `--apply` requires `--yes`, backs the registry file up beside itself,
 * and writes it atomically (tmp + rename) after all mutations are computed. Every file move is
 * a COPY into `.repair-quarantine/` and every run gets a journal under `<tree>/repairs/`, so
 * `restoreRepair()` can walk it backwards. Nothing is ever deleted.
 *
 *   node scripts/chapters-repair.mjs --project /home/adrian/Projects/saip
 *   node scripts/chapters-repair.mjs --project <cwd> --apply hollow,gaps --yes
 *   node scripts/chapters-repair.mjs --list
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const LIB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib')
if (!fs.existsSync(path.join(LIB, 'repair-run.js'))) {
  console.error(`no build found at ${path.relative(process.cwd(), LIB) || LIB} — run \`npm run build\` first.`)
  process.exit(2)
}
const { runRepair, restoreRepair } = await import(path.join(LIB, 'repair-run.js'))
const { freshSession } = await import(path.join(LIB, 'registry.js'))

// ──────────────────────────────────────────────────────────── args
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const HOME = opt('home', process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
const REGISTRY = opt('registry', path.join(HOME, 'storages', 'dsh_chapters.json'))
const PROJECT = opt('project', undefined)
const SESSION = opt('session', undefined)
const APPLY = opt('apply', undefined)          // 'all' or a comma list
const DRY = flag('dry-run') || APPLY === undefined
const YES = flag('yes')
const LIST = flag('list')

const CLASS_ALIASES = {
  hollow: 'hollow-payload', gaps: 'never-archived-span', citations: 'dead-citation',
  bookkeeping: ['ghost-plan-manifest', 'unreleased-reservation', 'countervalue-drift'],
  all: 'all',
}
const classes = () => {
  if (APPLY === 'all' || flag('all')) return 'all'
  return String(APPLY ?? '').split(',').flatMap((c) => CLASS_ALIASES[c.trim()] ?? c.trim()).filter(Boolean)
}

// ──────────────────────────────────────────────────────────── durable logs
/** The kernel's own naming: a workspace slug dir, one session uuid per child, one zstd log per session. */
function findLogDir(sessionId) {
  // MEASURED on this machine: session dirs keep the `session-` prefix (`…/session-2edf9694-…`), while
  // some dirs are the bare uuid. Trying both costs nothing; guessing one silently loses sessions.
  const names = [sessionId, sessionId.replace(/^session-/, '')]
  const base = path.join(HOME, 'sessions')
  if (!fs.existsSync(base)) return null
  for (const slug of fs.readdirSync(base)) {
    for (const n of names) {
      const dir = path.join(base, slug, n)
      if (fs.existsSync(dir)) return dir
    }
  }
  return null
}
const LOG_NAME = /^session\.v(\d+)\.jsonl\.zstd$/
function decodeLog(dir) {
  const versions = fs.readdirSync(dir).map((f) => LOG_NAME.exec(f)).filter(Boolean)
  if (versions.length === 0) return null
  versions.sort((a, b) => Number(b[1]) - Number(a[1])) // highest format wins (the same rule the e2e rig uses)
  const file = path.join(dir, `session.v${versions[0][1]}.jsonl.zstd`)
  // The kernel appends one ZSTD FRAME PER FLUSH, not one frame per file: `session-2edf9694` holds
  // 3,915 frames in 3.4 MB. Node's zstdDecompressSync decodes the FIRST frame only — which is the
  // header line — so a naive decode yields a 1-event log and every finding below it would be a false
  // "nothing to repair". Split on the magic and decode them all.
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = buf.indexOf(magic); i >= 0; i = buf.indexOf(magic, i + 4)) starts.push(i)
  if (starts.length === 0) return { error: `${file} holds no zstd frame` }
  let text = ''
  for (let k = 0; k < starts.length; k++) {
    const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    try { text += zlib.zstdDecompressSync(slice).toString('utf8') } catch (error) {
      return { error: `frame ${k}/${starts.length} of ${file} failed to decode: ${String(error.message).slice(0, 60)}` }
    }
  }
  const events = []
  let header = {}
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let e
    try { e = JSON.parse(line) } catch { continue /* a torn final line is not a reason to lose 6,000 */ }
    if (e === null || typeof e !== 'object') continue
    // The FIRST line is the session HEADER record: type 'session', no seq, and its fields (cwd,
    // parentSession, origin, agentPreset) sit at the TOP LEVEL, not under `data` (measured 2026-10-22).
    if (e.type === 'session' && typeof e.seq !== 'number') { header = e; continue }
    if (typeof e.seq === 'number' && typeof e.type === 'string') events.push({ ...e, data: e.data ?? {} })
  }
  return { events, header, file }
}

// ──────────────────────────────────────────────────────────── registry port
/**
 * A RegistryStore over the JSON file. Writes are serialized per session through the SAME `mutate`
 * discipline the plugin uses (#59); the file itself is written atomically at the end of the run.
 */
const tablesOf = (reg) => reg.tables ?? reg

function makeRegistry(reg) {
  const tables = reg.tables ?? reg
  const gates = new Map()
  const section = (id, fn) => {
    const prev = gates.get(id) ?? Promise.resolve()
    const job = prev.then(fn, fn)
    gates.set(id, job.then(() => undefined, () => undefined))
    return job
  }
  const read = (id) => (tables.sessions[id] !== undefined ? structuredClone(tables.sessions[id]) : freshSession(id))
  return {
    async get(id) { return read(id) },
    async put(id, state) { return section(id, async () => { tables.sessions[id] = state; return state }) },
    async mutate(id, fn) {
      return section(id, async () => {
        const before = read(id)
        const next = { ...fn(before), rev: (before.rev ?? 0) + 1 }
        tables.sessions[id] = next
        return next
      })
    },
    sessions: () => Object.entries(tables.sessions),
  }
}

// ──────────────────────────────────────────────────────────── main
if (!fs.existsSync(REGISTRY)) {
  console.error(`no registry at ${REGISTRY} — pass --registry or --home`)
  process.exit(2)
}
const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
const store = makeRegistry(reg)
const all = [...store.sessions()].map(([id]) => id)

if (LIST) {
  console.log(`${all.length} session rows in ${REGISTRY}`)
  for (const id of all) {
    const dir = findLogDir(id)
    const st = await store.get(id)
    const hollow = st.chapters.filter((c) => (c.messages ?? 0) === 0 && c.endSeq >= c.startSeq).length
    console.log(`  ${id.slice(0, 18)}…  chapters=${st.chapters.length} hollow=${hollow} log=${dir !== null ? 'yes' : 'MISSING'}`)
  }
  process.exit(0)
}

const targets = all.filter((id) => {
  if (SESSION !== undefined) return id === SESSION || id === `session-${SESSION}`
  if (PROJECT === undefined) return false
  const dir = findLogDir(id)
  if (dir === null) return false
  const decoded = decodeLog(dir)
  const cwd = decoded?.header !== undefined ? decoded.header.cwd : undefined
  return cwd === PROJECT || (cwd !== undefined && path.resolve(cwd) === path.resolve(PROJECT))
})
if (targets.length === 0) {
  console.error(PROJECT !== undefined
    ? `no session rows with a durable log for ${PROJECT} under ${HOME} — try --list`
    : 'pass --project <cwd>, --session <id> or --list')
  process.exit(2)
}

const CONFIG = {
  artifactStoreRoot: opt('store', '.dsh-chapters'),
  chapterTokenTarget: Number(opt('target', 8000)),
  chapterOversizeFactor: Number(opt('oversize-factor', 2)),
  toolResultDeferFloorTokens: Number(opt('defer-floor', 200)),
  mergeThreshold: Number(opt('merge-threshold', 0.3)),
  chapterLimit: Number(opt('chapter-limit', 8000)),
}

console.log(`dsh chapters repair — registry ${REGISTRY}`)
console.log(`  home ${HOME}`)
console.log(`  ${targets.length} session(s)${PROJECT !== undefined ? ` under ${PROJECT}` : ''} · ${DRY ? 'DRY RUN (nothing is written)' : `APPLY (${APPLY})`}`)

let totals = { findings: 0, applied: 0, refused: 0, blind: 0 }
const histogram = {}
const perSession = []
for (const id of targets) {
  const dir = findLogDir(id)
  if (dir === null) {
    console.log(`  ${id}: NO DURABLE LOG — its knowledge cannot be re-derived (unrecoverable)`)
    perSession.push({ sessionId: id, noLog: true })
    continue
  }
  const decoded = decodeLog(dir)
  if (decoded.error !== undefined) { console.log(`  ${id}: ${decoded.error}`); continue }
  const cwd = decoded.header.cwd
  if (typeof cwd !== 'string' || cwd === '') { console.log(`  ${id}: header carries no cwd — nowhere to write`); continue }
  const out = await runRepair({
    store,
    readLog: async () => decoded.events,
    cwd,
    config: CONFIG,
    knownRoots: all.map((sid) => (tablesOf(reg).sessions[sid]?.rootSession) ?? sid),
    log: (m) => console.log(`    + ${m}`),
    warn: (m) => console.log(`    ! ${m}`),
  }, { sessionId: id, classes: DRY ? 'all' : classes(), dryRun: DRY })
  totals.findings += out.findingsBefore.length
  totals.applied += out.applied.length
  totals.refused += out.refused.length
  totals.blind += out.blindSpots.length
  perSession.push({ sessionId: id, cwd, ...out })
  const byClass = (list) => list.reduce((m, f) => ({ ...m, [f.class]: (m[f.class] ?? 0) + 1 }), {})
  // ACCUMULATE, not assign: Object.assign overwrote each class with the last session's count and
  // reported "1 hollow chapter" for a project the audit measured at 12.
  for (const [k, n] of Object.entries(byClass(out.findingsBefore))) histogram[k] = (histogram[k] ?? 0) + n
  console.log(`  ${id}: ${out.findingsBefore.length} finding(s) ${JSON.stringify(byClass(out.findingsBefore))}`)
  if (out.blindSpots.length > 0) console.log(`    blind to: ${out.blindSpots.join(', ')}`)
  // Refusals are AGGREGATED by class: a hollow chapter with 102 empty refs printed 102 identical lines
  // on the first real run, which buries the four findings that actually matter. An operator tool earns
  // its output by counting, not by dumping.
  const grouped = new Map()
  for (const r of out.refused) {
    const key = r.split(':')[0] ?? r
    const prev = grouped.get(key)
    if (prev === undefined) grouped.set(key, { first: r, n: 1 })
    else grouped.set(key, { first: prev.first, n: prev.n + 1 })
  }
  for (const { first, n } of grouped.values()) console.log(`    refused: ${first}${n > 1 ? `  (+${n - 1} more of this class)` : ''}`)
  if (!DRY) console.log(`    → ${out.applied.length} move(s) journalled as ${out.journalId}; ${out.findingsAfter.length} finding(s) remain`)
}

console.log(`\nfindings by class: ${JSON.stringify(histogram)}`)
if (DRY) {
  console.log(`dry run: ${totals.findings} finding(s) across ${targets.length} session(s). Nothing written.`)
  console.log('apply with:  node scripts/chapters-repair.mjs --project <cwd> --apply all --yes')
  process.exit(0)
}
if (!YES) {
  console.error('\n--apply needs --yes: this writes into the live registry file and the store tree.')
  process.exit(2)
}

// write the registry back: backup, then atomic replace
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.copyFileSync(REGISTRY, `${REGISTRY}.pre-repair-${stamp}.bak`)
const tmp = `${REGISTRY}.tmp-${stamp}`
fs.writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`)
fs.renameSync(tmp, REGISTRY)
console.log(`\napplied ${totals.applied} move(s); registry backed up to ${path.basename(`${REGISTRY}.pre-repair-${stamp}.bak`)} and rewritten atomically.`)
console.log(`journals: <store>/<root>/repairs/*.json — undo a run with  node scripts/chapters-repair.mjs --restore <journal-id> --session <id> --yes`)
if (totals.blind > 0) console.log(`note: ${totals.blind} blind spot(s) — this runner CAN list directories, so that count should be 0 here.`)
fs.writeFileSync(path.join(path.dirname(REGISTRY), `chapters-repair-report-${stamp}.json`), `${JSON.stringify({ stamp, totals, perSession: perSession.map((p) => ({ sessionId: p.sessionId, cwd: p.cwd, findingsBefore: p.findingsBefore, findingsAfter: p.findingsAfter, applied: p.applied, refused: p.refused, blindSpots: p.blindSpots, journalId: p.journalId })) }, null, 2)}\n`)
process.exit(0)
