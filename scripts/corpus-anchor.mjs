/**
 * Is the acceptance corpus anchored to the host we pin? One parser, two consumers (#56).
 *
 * `tests/fixtures/model-tape/CORPUS_HOST` records the host version the eight tape projects were
 * distilled against. The tape proxy matches on normalized request PREFIXES, and those prefixes
 * contain the host's system-prompt composition — so when the pinned host, the persona, or a tool
 * description moves, the corpus stops matching the rig and every replay fails for a reason that
 * belongs to an earlier change. The honest response is the one this repo already uses for a host
 * that cannot register preset rows: **refuse by name, in the run log, with a tracked issue** —
 * never a quietly green chain, and never a permanently red one that trains people to ignore it.
 *
 *   node scripts/corpus-anchor.mjs --check         # exit 0 anchored, 1 mismatch, prints the story
 *   node scripts/corpus-anchor.mjs --github-output # also writes GITHUB_OUTPUT lines for CI
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** key = value lines, '#' comments ignored. Missing file returns {} (which is NOT anchored). */
export function parseSimple(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

export function corpusAnchor(root = ROOT) {
  const file = path.join(root, 'tests', 'fixtures', 'model-tape', 'CORPUS_HOST')
  let pinned = 'unknown'
  try {
    pinned = JSON.parse(fs.readFileSync(path.join(root, 'dev', 'dsh-host-lock', 'package.json'), 'utf8'))
      .dependencies?.['@deepseek-ai/dsh'] ?? 'unknown'
  } catch { /* the lock is the other input; report its absence rather than guess */ }
  if (!fs.existsSync(file)) {
    return { anchored: false, pinned, distilled: null, tracking: null, reason: 'CORPUS_HOST is missing — provenance is unknown, so the chain cannot be claimed', file }
  }
  const rec = parseSimple(fs.readFileSync(file, 'utf8'))
  const distilled = rec.host ?? null
  const anchored = distilled !== null && distilled === pinned
  return {
    anchored, pinned, distilled,
    tracking: rec.tracking ?? null,
    reason: anchored
      ? `corpus distilled against ${distilled}`
      : rec.reason ?? `corpus distilled against ${distilled ?? '?'}, this branch pins ${pinned}`,
    file,
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const a = corpusAnchor()
  const mode = process.argv.includes('--github-output')
  if (mode) {
    const out = process.env.GITHUB_OUTPUT
    if (out) fs.appendFileSync(out, `corpus-anchored=${a.anchored ? 'true' : 'false'}\ncorpus-summary=${a.anchored ? `anchored (${a.distilled})` : `MISMATCH: distilled ${a.distilled ?? 'unknown'} vs pinned ${a.pinned}`}\n`)
  }
  if (process.argv.includes('--check') || mode) {
    console.log(a.anchored
      ? `corpus-anchor: anchored — tapes distilled against ${a.distilled}, matching the pinned host`
      : `corpus-anchor: NOT ANCHORED — ${a.reason}${a.tracking ? `\n             tracked by ${a.tracking}` : ''}`)
    process.exit(a.anchored ? 0 : 1)
  }
  console.log(JSON.stringify(a, null, 2))
}
