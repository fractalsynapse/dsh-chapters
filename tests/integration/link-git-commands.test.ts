/**
 * The human entry points on the GIT plane at the COMMAND surface: modes 1-3
 * of /chapters-link (view / local-path / https[+token]) and /chapters-status
 * rendering. The TreeDX command path is covered in link-treedx.test.ts; this
 * file closes the git-side branches that the 2026-09-23 coverage audit found
 * untested (commands.ts sat at 26.6% branch coverage — the argument parsing
 * and refusal texts are exactly what an operator fat-fingers).
 *
 * Pins a real bug found while writing it: /chapters-status printed the
 * `Provider:` line TWICE (two try/catch variants of the same push had both
 * landed in the file).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHostCommands } from '../../src/commands.ts'
import { startGitHttpServer, type GitHttpServer } from './http-git-server.ts'

type CmdDef = { name: string; handler: (inv: { agent: unknown; rawInput?: string }) => Promise<{ kind: string; text?: string }> }

let root: string
let home: string
let server: GitHttpServer | null = null
const defs = new Map<string, CmdDef>()
const projects = new Map<string, Record<string, unknown>>()

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'linkgit-home-'))
  process.env.DSH_HOME = home
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkgit-ws-'))
  server = await startGitHttpServer(path.join(root, 'poolserv'))
  const table = {
    get: (k: string) => projects.get(k),
    put: async (k: string, v: Record<string, unknown>) => { projects.set(k, v) },
    entries: () => projects.entries(),
    size: projects.size,
  }
  const domain = { table: () => table, close: async () => {} }
  const ctx = { get: (n: string) => (n === 'commands' ? { register: (def: CmdDef) => { defs.set(def.name, def); return () => {} } } : undefined) }
  // stub enrichment wiring — pins the /chapters-enrich VERB SURFACE (the ladder
  // itself is enrich-wire/enrich-queue territory); commands.ts had zero coverage
  // of model-set/clear/report before this file.
  let override: string | null = null
  const enrichStub = {
    runNow: async () => ({ processed: 0, remaining: 2, draining: true, alreadyRunning: false }),
    batchCap: () => 5,
    setModelOverride: async (v: string | null) => { override = v },
    modelOverride: () => override,
    statusLine: () => 'enrichment: manual, model conversation default',
    pendingCount: async () => 3,
  }
  registerHostCommands(ctx as never, domain as never, {
    artifactStoreRoot: '.dsh-chapters',
    harnessId: 'h-cmd',
    enrich: enrichStub as never,
    rules: async (cwd: string, raw: string) => ({ kind: 'success' as const, text: `rules@${cwd}: ${raw}` }),
  })
})
after(async () => {
  await server?.stop()
  delete process.env.DSH_HOME
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

const ws = (): string => path.join(root, 'workspace')
const agent = () => ({ session: { header: { cwd: ws() } } })
const link = (): CmdDef => defs.get('chapters-link')!
const status = (): CmdDef => defs.get('chapters-status')!

test('mode 1 — an unlinked workspace reads honestly: none linked, and what still works', async () => {
  const r = await link().handler({ agent: agent(), rawInput: '' })
  assert.equal(r.kind, 'success')
  assert.match(r.text ?? '', /Upstream: none/)
  assert.match(r.text ?? '', /knowledge-local/)
})

test('mode 2 — a local-path upstream links, syncs offline, and lands a real record', async () => {
  fs.mkdirSync(ws(), { recursive: true })
  const pool = path.join(root, 'pool.git')
  const r = await link().handler({ agent: agent(), rawInput: pool })
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text ?? '', /Linked to local upstream/)
  assert.match(r.text ?? '', /Sync: /)
  const rec = [...projects.values()].find((p) => p.cwd === ws())
  assert.ok(rec !== undefined, 'record stored under the workspace cwd')
  assert.equal(rec!.remote, pool)
  assert.equal(rec!.kind ?? 'git', 'git', 'local-path is the git provider')
})

test('/chapters-status renders each fact ONCE — Provider included (dup-line pin)', async () => {
  const r = await status().handler({ agent: agent() })
  assert.equal(r.kind, 'success', r.text)
  const t = r.text ?? ''
  assert.equal((t.match(/^Provider:/gm) ?? []).length, 1, 'exactly one Provider line — the regression this file caught')
  assert.match(t, /^Provider: git · /m, 'describe() carries the transport + remote')
  assert.match(t, /Sync: /)
})

test('mode 3 — an http URL without a token links when the host is loopback', async (t) => {
  if (server === null) { t.skip('git http-backend not available'); return }
  const url = server.serveRepo('kb-cmdlink')
  const r = await link().handler({ agent: agent(), rawInput: url })
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text ?? '', /no credentials: loopback upstream/)
  const rec = [...projects.values()].find((p) => p.remote === url)
  assert.ok(rec !== undefined)
})

test('mode 3 — a non-loopback https URL WITHOUT a token refuses with the credential policy', async () => {
  const r = await link().handler({ agent: agent(), rawInput: 'https://example.invalid/kb.git' })
  assert.equal(r.kind, 'error')
  assert.match(r.text ?? '', /credential is required/i)
  assert.ok(![...projects.values()].some((p) => String(p.remote).includes('example.invalid')), 'a refused link stores no record')
})

test('a target that is neither path, http(s), nor treedx+ falls back to the usage line', async () => {
  const r = await link().handler({ agent: agent(), rawInput: 'ssh://git@example.invalid/kb.git' })
  assert.equal(r.kind, 'error')
  assert.match(r.text ?? '', /usage: \/chapters-link/i)
})

// ------------------------------------------------ /chapters-enrich verb surface

const enrich = (): CmdDef => defs.get('chapters-enrich')!

test('#565 /chapters-enrich run announces the background drain of ALL pending', async () => {
  const r = await enrich().handler({ agent: agent(), rawInput: 'run' })
  assert.equal(r.kind, 'success')
  assert.match(r.text ?? '', /draining all pending — 2 pending, batches of 5/, r.text ?? '')
})

test('#565 /chapters-enrich run <n> passes the user limit and rejects junk', async () => {
  let seen: number | undefined
  const stub = defs.get('chapters-enrich')!
  void stub
  const r = await enrich().handler({ agent: agent(), rawInput: 'run 7' })
  assert.equal(r.kind, 'success')
  assert.match(r.text ?? '', /draining up to 7 chapter\(s\)/, r.text ?? '')
  const bad = await enrich().handler({ agent: agent(), rawInput: 'run all-of-them' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text ?? '', /positive whole-number limit/, bad.text ?? '')
  void seen
})

test('/chapters-enrich model: set, view, clear — override round-trips', async () => {
  const set = await enrich().handler({ agent: agent(), rawInput: 'model testprov/testmodel' })
  assert.match(set.text ?? '', /set to testprov\/testmodel/)
  const view = await enrich().handler({ agent: agent(), rawInput: 'model' })
  assert.match(view.text ?? '', /testprov\/testmodel \(override\)/)
  const clr = await enrich().handler({ agent: agent(), rawInput: 'model clear' })
  assert.match(clr.text ?? '', /reset to the conversation default/)
  const view2 = await enrich().handler({ agent: agent(), rawInput: 'model' })
  assert.match(view2.text ?? '', /conversation default/)
})

test('/chapters-enrich report prints the status line plus pending count; junk verb yields usage', async () => {
  const r = await enrich().handler({ agent: agent(), rawInput: 'report' })
  assert.match(r.text ?? '', /enrichment: manual/)
  assert.match(r.text ?? '', /pending: 3 chapter\(s\)/)
  const u = await enrich().handler({ agent: agent(), rawInput: 'flarp' })
  assert.match(u.text ?? '', /usage: \/chapters-enrich/)
})

test('mode 1 on a LINKED workspace: provider line, branch, and pending view render', async () => {
  const r = await link().handler({ agent: agent(), rawInput: '' })
  assert.equal(r.kind, 'success')
  const t = r.text ?? ''
  assert.match(t, /Provider: git/)
  assert.match(t, /Upstream: /)
  assert.match(t, /Mirror:   \.dsh-knowledge/)
  assert.match(t, /branch main|rebuild/)
  assert.match(t, /Pending:  \d+ file\(s\)/)
})

test('/chapters-rule dispatches to the rules surface with cwd + raw args', async () => {
  const rule = defs.get('chapters-rule')
  assert.ok(rule !== undefined, 'config.rules present registers the command')
  const r = await rule.handler({ agent: agent(), rawInput: 'list --proposed' })
  assert.match(r.text ?? '', /rules@.*list --proposed/)
})

test('#50 §7.8 /chapters-status reports the identity the rules namespace derives from', async () => {
  const r = await status().handler({ agent: agent() })
  const t = r.text ?? ''
  assert.match(t, /^Identity: /m, 'the key derivation is a reported fact, not an assumption')
  // #546 semantics: a bound record but no .git here — the link IS the identity, stated calmly.
  // Silence remains forbidden; ALARM on a by-design configuration is now the forbidden branch too.
  assert.match(t, /matches the bound key|pool-keyed/, t)
  assert.doesNotMatch(t, /THIS CHECKOUT RESOLVES A DIFFERENT PROJECT KEY/,
    '#546: no-remote checkout with a valid link is not drift — the maintainer\'s pool-on-purpose setup must not read as broken')
})

test('#546 a DELIBERATELY separate pool repo reads informationally, never as a failure', async () => {
  // The maintainer's exact configuration: pool linked to its own repository, checkout's git
  // remote is the CODE repo. Both identities are named; the sentence states which one governs.
  const rec = [...projects.values()].find((p) => p.cwd === ws())
  assert.ok(rec !== undefined)
  const git = path.join(ws(), '.git')
  fs.mkdirSync(git, { recursive: true })
  fs.writeFileSync(path.join(git, 'config'), '[remote "origin"]\n\turl = https://github.com/org/saip-code.git\n')
  try {
    const t = (await status().handler({ agent: agent() })).text ?? ''
    assert.match(t, /pool-keyed/, t)
    assert.match(t, /rides this bound key|by design/i, 'the governance fact is stated, not just the difference')
    assert.doesNotMatch(t, /THIS CHECKOUT RESOLVES A DIFFERENT PROJECT KEY/, 'a separate-pool link is the documented design (§2.1) — never an alarm')
  } finally {
    fs.rmSync(git, { recursive: true, force: true })
  }
})

test('#50 §7.8 a checkout resolving a DIFFERENT key under the SAME remote is flagged, not silently private', async () => {
  // The divergence class: a bound record whose projectKey no longer matches what
  // this cwd derives (a fork listed first, a pool re-link, a path-derived
  // fallback). Silence here means a developer working all day under rules the
  // team approved elsewhere, believing they apply.
  // #546 makes the drift CLASS precise: the alarm fires when the checkout's own remote IS the
  // bound remote yet the keys disagree (stale link, canonicalization damage, fork listed first).
  // A path-derived key under a valid link is no longer in this class — see the row above.
  // (A second link test bound ANOTHER record to this same cwd; the resolver picks one, so the
  // row tampers every record for the cwd and reads the bound remote from any — the honest shape
  // of "a stored key no longer matches what the same remote derives".)
  // One deterministic record: keep the first for this cwd, stash the rest, restore all after.
  const all = [...projects.entries()]
  const forCwd = all.filter(([, p]) => p.cwd === ws())
  assert.ok(forCwd.length > 0)
  const [keepKey, keepRec] = forCwd[0]!
  const boundRemote = String(keepRec!.remote)
  const stash = new Map(all)
  projects.clear()
  for (const [k, v] of stash) if (k !== keepKey && String(v.cwd) === ws()) { /* drop siblings for determinism */ }
  else projects.set(k, v)
  const realKey = String(keepRec!.projectKey)
  keepRec!.projectKey = 'deadbeef-0000-0000-0000-000000000000'
  const git = path.join(ws(), '.git')
  fs.mkdirSync(git, { recursive: true })
  fs.writeFileSync(path.join(git, 'config'), `[remote "origin"]\n\turl = ${boundRemote}\n`)
  try {
    const t = (await status().handler({ agent: agent() })).text ?? ''
    assert.match(t, /THIS CHECKOUT RESOLVES A DIFFERENT PROJECT KEY/, t)
    assert.match(t, /will NOT appear here/, t)
  } finally {
    keepRec!.projectKey = realKey
    for (const [k, v] of stash) projects.set(k, v)
    fs.rmSync(git, { recursive: true, force: true })
  }
})
