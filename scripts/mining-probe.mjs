#!/usr/bin/env node
/**
 * The live measurement the two-tier rules feature was missing (§7.5, Amendment
 * 2026-10-21): does a real model, mining real archived chapters, produce
 * inferences worth governing?
 *
 * It is not a fake of the ladder. The prompts are built by `buildMineInput` from
 * the shipped mining path, the answers are parsed by `parseMinedRules`, and each
 * candidate is classified by `quoteIsHuman` against the chapter's HUMAN bytes —
 * the same functions the plugin runs. Capture then runs against a scratch store so
 * the printed block is what a head would actually carry.
 *
 * Local server if it answers (the stress regime), hosted session model otherwise
 * — see scripts/llm.mjs for why the fallback is legitimate and what it is NOT
 * evidence of.
 *
 *   node scripts/mining-probe.mjs                     # three newest-ish chapters
 *   node scripts/mining-probe.mjs path/a.md path/b.md # explicit chapters
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callChat, resolve, apiKeySource } from './llm.mjs'
import { buildMineInput, parseMinedRules, ENRICH_MAX_TOKENS_DEFAULT } from '../src/enrich.ts'
import { humanBytesOf } from '../src/enrich-wire.ts'
import { parseChapterFile } from '../src/enrich-store.ts'
import { captureMinedRules, quoteIsHuman } from '../src/session-rules.ts'
import { buildRulesSection, loadRuleStatusFacts, revokedRuleIds } from '../src/rules.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'var', 'mining-live')

const chapterCandidates = (explicit) => {
  if (explicit.length > 0) return explicit.map((p) => path.resolve(ROOT, p))
  const all = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.md') || !p.includes(`${path.sep}chapters${path.sep}`)) continue
      // skip the monster chapters: the ladder caps its input anyway, and a
      // 100KB body makes the probe slow without making it more informative
      const size = fs.statSync(p).size
      if (size > 60000 || size < 3000) continue
      all.push({ p, size, mtime: fs.statSync(p).mtimeMs })
    }
  }
  if (fs.existsSync(path.join(ROOT, '.dsh-chapters'))) walk(path.join(ROOT, '.dsh-chapters'))
  // a mix: the two most recent + one older, so the answer is not one conversation's mood
  all.sort((a, b) => b.mtime - a.mtime)
  const picks = [all[0], all[1], all[Math.floor(all.length / 2)]].filter(Boolean)
  return [...new Set(picks.map((x) => x.p))]
}

const target = await resolve({ prefer: 'local' })
console.log(`model target: ${target.base}  model ${target.model}  (${target.regime})`)
console.log(`credential: ${apiKeySource()}  ${apiKeySource() === 'none' ? '— ABSENT, probe will fail' : '[value never read or printed]'}`)
if (!target.local) console.log('note: local :8080 not answering → hosted fallback. This measures inference QUALITY at the session model; it does NOT measure the 32K stress regime.')

const chapters = chapterCandidates(process.argv.slice(2))
if (chapters.length === 0) { console.error('no archived chapters found under .dsh-chapters/'); process.exit(1) }
fs.mkdirSync(OUT, { recursive: true })

// a scratch store, so capture/classification/rendering run the real code
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mining-probe-'))
const storeDir = path.join(scratch, '.dsh-chapters')
const mirror = path.join(scratch, '.dsh-knowledge')
const sessionId = `probe-${Date.now()}`
const ancestors = new Set([sessionId])

const rows = []
for (const [i, file] of chapters.entries()) {
  const doc = parseChapterFile(fs.readFileSync(file, 'utf8'))
  const human = humanBytesOf(doc.body)
  const chunks = doc.body.split(/\*\*User[^*\n]*:\*\*/g).slice(1).map((c) => c.split(/\*\*Assistant/)[0].trim())
  const prompt = buildMineInput({ requests: chunks }, doc.body.slice(0, 6000))
  fs.writeFileSync(path.join(OUT, `prompt-${i + 1}.txt`), prompt)
  fs.writeFileSync(path.join(OUT, `human-${i + 1}.txt`), human)
  process.stdout.write(`\n[${i + 1}/${chapters.length}] ${path.basename(file).slice(0, 60)} … `)
  let answer
  try {
    // the SAME ceiling the plugin sends, so the probe measures the shipped budget
    const r = await callChat(prompt, { target, maxTokens: ENRICH_MAX_TOKENS_DEFAULT })
    answer = r.text
    rows.push({ file, usage: r.usage, error: null })
  } catch (error) {
    rows.push({ file, usage: null, error: String(error.message ?? error).slice(0, 240) })
    console.log(`FAILED: ${rows.at(-1).error}`)
    continue
  }
  fs.writeFileSync(path.join(OUT, `answer-${i + 1}.json`), answer)
  const mined = parseMinedRules(answer)
  if (mined.length === 0 && /"rules"/.test(answer)) console.log('   !! advertised rules but the JSON did not parse — answer is TRUNCATED at this ceiling')
  const verdicts = mined.map((m) => ({ ...m, humanBacked: quoteIsHuman(human, m.quote) }))
  console.log(`${mined.length} rule(s); claimed-stated ${mined.filter((m) => m.basis === 'stated').length}; quote actually in human bytes ${verdicts.filter((v) => v.humanBacked).length}`)
  const cap = captureMinedRules({
    storeDir, harnessId: 'probe', sessionId, records: new Map(),
    humanText: human, rules: mined, maxPerChapter: 3, chapterNumber: i + 1, autoActivate: true,
  })
  rows.at(-1).written = cap.ids.length
  rows.at(-1).stated = cap.ids.length - cap.inferred
  rows.at(-1).inferred = cap.inferred
  for (const v of verdicts) console.log(`   · ${v.humanBacked ? 'STATED  ' : 'INFERRED'} [${v.category}] ${v.text}`)
}

// the head a session with all of this would carry
const facts = loadRuleStatusFacts(mirror, 'probe')
const rendered = buildRulesSection(mirror, {
  projectKey: 'PKPROBE', harnessId: 'probe', budgetTokens: 1200,
  storeDir, ancestorSessions: ancestors, revoked: revokedRuleIds(mirror, 'probe'),
})
console.log('\n================ what a rebuilt head would actually carry ================')
console.log(rendered.kind === 'ok' ? rendered.text : `(kind: ${rendered.kind}${rendered.kind === 'refusal' ? ` — ${rendered.reason}` : ''})`)

const total = rows.reduce((n, r) => n + (r.written ?? 0), 0)
const inferred = rows.reduce((n, r) => n + (r.inferred ?? 0), 0)
console.log('\n================ verdict ================')
for (const r of rows) console.log(` ${r.error ? 'ERR ' : 'ok  '} ${path.basename(r.file).slice(0, 52)}  ${r.written ?? 0} captured${r.usage ? `  (tok in ${r.usage.prompt_tokens ?? '?'}, out ${r.usage.completion_tokens ?? '?'})` : ''}`)
console.log(` chapters probed ${rows.length} · rules captured ${total} · of which inferred (no human sentence behind them) ${inferred}`)
console.log(` renderings: ${rendered.kind === 'ok' ? `${rendered.shown.session} session rule(s) shown, ${rendered.withheld.session} withheld, ${rendered.tokens} tokens` : rendered.kind}`)
fs.rmSync(scratch, { recursive: true, force: true })
