/**
 * The model-driven activities, verified LIVE (#175): enrichment writes a real annotation, mining
 * writes a real rule with an honest warrant, `view` reads it back in full, and `/chapters-models`
 * feeds an identifier a setter accepts.
 *
 * WHY THIS LEG IS NOT TAPE-BACKED. The nine model-free legs replay CANNED completions: they prove
 * the plumbing (the annotation prompt is asked in the right shape, the frontmatter writer runs, the
 * bar renders), and the 2026-10-30 re-record left real completions in the corpus as artifacts —
 * `enrich/0002.json` decodes to an annotation JSON with `topics` and a `rules` array. But no spec
 * ever ASSERTED the mining half: `"rules": []` is a legitimate annotation answer, and nothing in
 * the recorded journeys forced a mineable standing order to exist. The maintainer's release gate
 * for this chain is that all three activities work when turned on with a model — that claim needs
 * a real completion, so this leg runs against the real provider under a wall-clock bound, in the
 * `prompt-goal-live` pattern, and `scripts/chain-replay.sh` deliberately does not list the project:
 * the model-free acceptance job does NOT cover these claims, a live run does, stated not hidden.
 *
 * WHAT EACH ASSERTION OBSERVES (durable artifacts, never vibes):
 *  - enrichment: the chapter file's `generated:` frontmatter with the verbatim body preserved —
 *    the same artifact the tape-backed leg asserts, here written by a real completion;
 *  - mining: the session-rule FILE itself (`scope: session`, `derivedFrom: model`, and a `basis`
 *    that is `stated` or `inferred` — decided by §7.5's verbatim-quote gate, `quoteIsHuman`, which
 *    unit rows pin; this leg proves the warrant survives the whole journey to disk);
 *  - the reading surface: `/chapters-rule view <id>` puts the rule's full body and, for an
 *    inferred warrant, the "the model wrote this; you never said it" caveat into the durable log
 *    (#80: command results do NOT render on the 0.2.x conversation surface — the durable record is
 *    the observation, and it is what this leg reads);
 *  - discovery → setter: an identifier PRINTED by `/chapters-models` is passed to
 *    `/chapters-enrich model` and echoed back as the stored override (#173's live criterion).
 *
 * Evidence copies land in `var/model-activities-evidence/` before the throwaway home is cleaned,
 * so the issue can cite artifacts instead of adjectives.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  openApp, newSessionWithTurn, typeComposer, deliveredFor, forkDoor,
  E2E_STORE_ROOT, E2E_SESS_DIR, ROOT, decodeSessionLogAt,
} from './session.ts'

test.describe.configure({ timeout: 1_200_000 })

// Same guard shape as prompt-goal-live, and the same discipline: this spec refuses to run against
// a tape rather than silently proving nothing. (`=== 'replay'` — the inverted form once shipped and
// ran a live spec only against tapes; #141's correction.)
test.skip(process.env.E2E_MODEL === 'replay',
  'model-activities-live needs the live provider (E2E_MODEL!=replay): its claims are about REAL model '
  + 'completions driving enrichment, mining, and setter round-trips — a tape replays canned ones, '
  + 'which is what the nine model-free legs already prove.')

const STANDING_ORDER = 'Always run the deterministic test suite before opening a pull request.'

function chapterFile(sid: string): string {
  const dir = path.join(E2E_STORE_ROOT, sid, 'chapters')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : []
  return files.length > 0 ? path.join(dir, files[0]!) : ''
}

/** Every rule file the model mined on this boot, whatever harness dir it landed under. */
function minedRuleFiles(): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.md')) continue
      try { if (/derivedFrom: model/.test(fs.readFileSync(p, 'utf8'))) out.push(p) } catch { /* mid-write */ }
    }
  }
  walk(path.join(E2E_STORE_ROOT, 'rules'))
  return out
}

/** Every durable session log this boot has written, decoded and concatenated. */
function allLogs(): string {
  let text = ''
  try {
    for (const name of fs.readdirSync(E2E_SESS_DIR)) text += decodeSessionLogAt(path.join(E2E_SESS_DIR, name)) + '\n'
  } catch { /* no session dir yet */ }
  return text
}

/** The rule's body as `view` must render it: the file's post-frontmatter bytes, first line. */
function ruleBodyOf(fileText: string): string {
  const i = fileText.indexOf('\n---\n')
  return (i >= 0 ? fileText.slice(i + 5) : fileText).trim()
}

/** How a multi-line command result looks inside a JSON-encoded log line: `\n` as two chars. */
function escaped(needle: string): string {
  return JSON.stringify(needle).slice(1, -1)
}

/**
 * One provider/model id from the /chapters-models output, in either of the two shapes it renders:
 * a catalog model line (`\n  provider/model — Name`) or the current-settings footer
 * (`enrichment.model  provider/model (from …)`). The footer is the fallback that keeps this
 * extraction honest when a provider advertises an empty catalog — the conversation route the
 * journey just rode is itself a printed, setter-acceptable identifier.
 */
function modelIdFrom(logText: string): string | null {
  const line = /\\n {2}([\w.-]+)\/([\w.-]+) — /.exec(logText)
  if (line !== null) return `${line[1]!}/${line[2]!}`
  const footer = /enrichment\.model\s+([\w.-]+)\/([\w.-]+)\s/.exec(logText)
  if (footer !== null) return `${footer[1]!}/${footer[2]!}`
  return null
}

test('enrichment enriches, mining mines with a warrant, view reads it whole, and /chapters-models feeds a setter', async ({ page }) => {
  test.setTimeout(1_200_000)
  await openApp(page)
  // The rules surface needs a linked pool (`view` refuses without one) — same throwaway-pool
  // pattern as rules.spec.ts.
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-activities-pool-'))
  const sid = await newSessionWithTurn(page,
    `Remember this standing order for the whole project: ${STANDING_ORDER} Now answer: what does the read tool do? One sentence, no tools.`)
  await typeComposer(page, `/chapters-link ${path.join(pool, 'pool.git')} `, deliveredFor(sid, '/chapters-link '))

  // --- 1. enrichment, live: a real completion writes the annotation frontmatter ---------------
  await forkDoor(page).click()
  await expect.poll(async () => chapterFile(sid), { timeout: 360_000, intervals: [2000] }).not.toBe('')
  const before = fs.readFileSync(chapterFile(sid), 'utf8')
  const bodyBefore = before.slice(before.indexOf('\n---\n') + 5)
  await typeComposer(page, '/chapters-enrich run ', deliveredFor(sid, '/chapters-enrich run '))
  await expect.poll(() => {
    const f = chapterFile(sid)
    const t = f === '' ? '' : fs.readFileSync(f, 'utf8')
    return t.includes('generated:') ? 'yes' : ''
  }, { timeout: 420_000, intervals: [3000] }).toBe('yes')
  const after = fs.readFileSync(chapterFile(sid), 'utf8')
  expect(after.slice(after.indexOf('\n---\n') + 5),
    'the verbatim body survives the sanctioned write — live or taped, this is the enrichment contract').toBe(bodyBefore)

  // --- 2. mining, live: the same drain carried the annotation call mining rides ---------------
  await expect.poll(() => minedRuleFiles().length, {
    timeout: 240_000, intervals: [3000],
    message: `no mined rule landed. chapter frontmatter was: ${after.slice(0, 500)}`,
  }).toBeGreaterThan(0)
  const ruleFile = minedRuleFiles()[0]!
  const ruleText = fs.readFileSync(ruleFile, 'utf8')
  expect(ruleText, 'a mined rule is session-tier — it never reaches the pool unapproved').toMatch(/scope: session/)
  const basis = /basis: (stated|inferred)/.exec(ruleText)
  expect(basis, `the warrant must be present and one of the two honest values, got: ${ruleText.slice(0, 300)}`).not.toBeNull()

  // --- 3. the reading surface: view renders the FULL body and the warrant (#174, live) --------
  const harnessDir = path.basename(path.dirname(ruleFile))
  const num = /^(\d{3})-/.exec(path.basename(ruleFile))?.[1] ?? '001'
  const ruleId = `${harnessDir}/${num}`
  const body = ruleBodyOf(ruleText)
  await typeComposer(page, `/chapters-rule view ${ruleId} `, deliveredFor(sid, '/chapters-rule view '))
  await expect.poll(() => allLogs().includes(escaped(body.slice(0, 40))), {
    timeout: 90_000, intervals: [2000],
    message: `view's output never reached the durable log; rule body was: ${body.slice(0, 80)}`,
  }).toBe(true)
  if (basis![1] === 'inferred') {
    expect(allLogs(),
      'an inferred warrant renders with its caveat — a model-written rule never masquerades as your words').toContain('the model wrote this')
  }

  // --- 4. discovery → setter: a printed identifier is an accepted identifier (#173) -----------
  await typeComposer(page, '/chapters-models ', deliveredFor(sid, '/chapters-models '))
  await expect.poll(() => modelIdFrom(allLogs()) !== null, {
    timeout: 90_000, intervals: [2000],
    message: 'the models command never printed a provider/model identifier into the durable log',
  }).toBe(true)
  const id = modelIdFrom(allLogs())!
  await typeComposer(page, `/chapters-enrich model ${id} `, deliveredFor(sid, '/chapters-enrich model '))
  await expect.poll(() => allLogs().includes(escaped(`enrichment model: ${id}`)), {
    timeout: 90_000, intervals: [2000],
    message: `the setter never echoed the identifier ${id} back as the stored override`,
  }).toBe(true)

  // --- evidence outlives the throwaway home ---------------------------------------------------
  const ev = path.join(ROOT, 'var', 'model-activities-evidence')
  fs.mkdirSync(ev, { recursive: true })
  fs.writeFileSync(path.join(ev, 'mined-rule.md'), ruleText)
  fs.writeFileSync(path.join(ev, 'chapter-frontmatter.txt'), after.slice(0, after.indexOf('\n---\n') + 5))
  fs.writeFileSync(path.join(ev, 'summary.json'), JSON.stringify({
    at: new Date().toISOString(), ruleId, basis: basis![1],
    standingOrderInJourney: STANDING_ORDER,
    modelIdRoundTripped: id,
  }, null, 2) + '\n')
})
