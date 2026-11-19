import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, typeComposer, localModelUp, sessionLogTextById, ROOT, E2E_REGISTRY, deliveredFor } from './session.ts'

/**
 * THE COMPOSED-CHECKPOINT JOURNEY (#420 — C3's vehicle; docs/development.md "The `compose` leg").
 *
 * What is claimed, in one sentence: a real conversation that grows past the compaction trigger
 * ACROSS TURN BOUNDARIES must be relieved by a COMPOSED checkpoint — two or more chapters split at
 * the topic transitions the discussion actually made — and the split must be visible mechanically
 * in the durable bytes, not in anything the model says about it.
 *
 * Why this geometry and nothing else:
 *   - `heavy` (oversized-turn.spec) crosses pressure but is DELIBERATELY single-turn: signatures
 *     store at `turn/end`, so mid-turn relief has zero collections and the composer is structurally
 *     unreachable there (#414's measured truth — 126 legacy manifests, correctly).
 *   - `suite` is multi-turn but its live trajectory never crossed the trigger (zero compactions).
 * This journey is BOTH, and the discussion is about THIS PROJECT (maintainer's direction 2026-11-19):
 * topic turns read and summarize real documentation — architecture's storage design, development's
 * test layers — so the archive's chapters carry real knowledge and the TOC separation is verified
 * against a conversation that means something. The crossing turn applies heavy's #132 arithmetic to
 * the changelog: the host read tool caps one call at 600 lines (measured on both machines), the
 * contract names EXACTLY three page calls, the first page lands ≈9–13K tokens, and the trigger sits
 * at 0.6 of the pinned 32K window — header (~13.3K) plus the two SMALL (40-line) topic turns stays
 * under it, the first changelog page cannot.
 *
 * The oracle is the archive itself, because invariant 4 makes it honest: the MODEL proposes ranges
 * and titles; the PLUGIN renders chapter bodies VERBATIM from the durable log. A codeword that
 * exists only in turn 1's user message is either inside a chapter's bytes or it is not, and a
 * boundary at the seam between two chapters that separate the codewords is TOPIC SEPARATION read
 * off the archive — whatever any summary claims about itself.
 *
 * Replay discipline (this leg is DESIGNED for a tape, unlike heavy — NO `E2E_MODEL=replay` skip):
 *   - nothing durable reads a working-tree doc: user-message codewords, compaction events, registry
 *     chapters and rendered chapter bodies all come from the run's own bytes, so a replay of the
 *     recorded tape re-runs the same assertions forever, even after these docs grow.
 *   - the ONE place that reads the live changelog (marker substrings for the record-time compliance
 *     probe) is gated to non-replay modes: a tape-served replay holds the OLD page bytes, and the
 *     real gate there is the compaction poll below, not the substring.
 *   - if replay destabilizes, that is #141's auto-continuation branch-walk and the leg reports it by
 *     name — never healed into silence (#411's rule).
 */

const ARCH_DOC = 'docs/architecture.md'
const DEV_DOC = 'docs/development.md'
const CHANGELOG = path.join(ROOT, 'site', 'src', 'content', 'docs', 'operations', 'changelog.md')
const SUNSTONE = 'SUNSTONE-41' // exists only in topic 1's user turn
const BREADCRUST = 'BREADCRUST-77' // exists only in topic 2's user turn

function pageMarkerSubstrings(): string[] {
  // Chosen from the LIVE file at RECORD time and frozen into the tape's bytes by the run itself;
  // three pages' worth, each a distinctive slice of a prose line (heavy's marker role, real text).
  const out: string[] = []
  try {
    const lines = fs.readFileSync(CHANGELOG, 'utf8').split('\n')
    for (const idx of [299, 899, Math.max(1200, lines.length - 12)]) {
      const raw = (lines[idx] ?? '').trim()
      if (raw.length >= 40) out.push(raw.slice(0, 60))
    }
  } catch { /* the probe degrades: the compaction poll remains the real gate */ }
  return out
}

function eventTypes(log: string, type: string): Array<{ seq: number; data: Record<string, unknown> }> {
  const out: Array<{ seq: number; data: Record<string, unknown> }> = []
  for (const line of log.split('\n')) {
    try {
      const e = JSON.parse(line) as { type?: string; seq?: number; data?: Record<string, unknown> }
      if (e?.type === type) out.push({ seq: Number(e.seq ?? -1), data: e.data ?? {} })
    } catch { /* partial lines */ }
  }
  return out
}

/** seq of the user/message event whose text contains `needle` — a durable fact about the journey. */
function userSeqWith(log: string, needle: string): number {
  for (const e of eventTypes(log, 'user/message')) {
    const c = e.data.content as Array<{ text?: string }> | undefined
    if ((c ?? []).some((b) => (b?.text ?? '').includes(needle))) return e.seq
  }
  return -1
}

type RegistryChapter = { number: number; path: string; title: string; startSeq: number; endSeq: number; topics?: string[]; shadowedSeqs?: number[] }
function registryChapters(sid: string): RegistryChapter[] {
  try {
    const reg = JSON.parse(fs.readFileSync(E2E_REGISTRY, 'utf8')) as { tables: { sessions: Record<string, { chapters?: RegistryChapter[] }> } }
    return reg.tables.sessions[sid]?.chapters ?? []
  } catch { return [] }
}

/** Chapter bodies as the plugin RENDERED them — verbatim log bytes, the only oracle invariant 4 allows. */
function chapterBytes(c: RegistryChapter): string {
  const p = path.isAbsolute(c.path) ? c.path : path.join(ROOT, c.path)
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

const shadowedOf = (s: { data: Record<string, unknown> }): number[] =>
  Array.isArray(s.data.shadowedSeqs) ? (s.data.shadowedSeqs as number[]) : []

test.describe('composed checkpoints from live discussion (#420/C3)', () => {
  test('a pressure crossing that follows real turn boundaries yields a COMPOSED (>=2-chapter) checkpoint whose boundary aligns with a topic transition', async ({ page }) => {
    test.setTimeout(5_400_000) // 90 min: one forced three-page read turn spans 6–45 minutes on live (heavy's measured spread) plus two doc turns and post-relief completion
    test.skip(!(await localModelUp()), 'no reachable model for this journey') // replay serves from the tape; record/live need the route

    await openApp(page)

    // ── topic 1: THIS project's storage design. Small by contract (40 lines, one named call),
    // bounded, signature-bearing; the codeword rides the USER message so it is durable regardless
    // of what the model recites (heavy's lesson: assistant TEXT is not a compliance signal).
    const sid = await newSessionWithTurn(page,
      `Discussion about this workspace, no side tasks: read ${ARCH_DOC} with ONE read call, offset 1 limit 40. In two or three sentences, what does that opening say about the durable session log? Include the codeword ${SUNSTONE} verbatim in your reply, then stop.`,
      900_000, false)

    // #56 sequencing, load-bearing HERE specifically: turn 1 must CLOSE (durable turn/end) before
    // turn 2 is typed. The signature the composer needs IS the turn/end record — a second message
    // typed while turn 1 is open makes the very boundary this leg exists to test a race.
    await expect.poll(() => eventTypes(sessionLogTextById(sid), 'turn/end').length >= 1,
      { timeout: 900_000, intervals: [5000] }).toBe(true)

    // ── topic 2: a genuinely different subject — the development loop. Second boundary.
    await typeComposer(page,
      `New topic about this repo, same rules — no side tasks: read ${DEV_DOC} with ONE read call, offset 1 limit 40. In two or three sentences, what does it say about why the tests isolate homes and ports? Include the codeword ${BREADCRUST} verbatim, then stop.`,
      deliveredFor(sid, `New topic about this repo`))
    await expect.poll(() => eventTypes(sessionLogTextById(sid), 'turn/end').length >= 2,
      { timeout: 900_000, intervals: [5000] }).toBe(true)

    // ── the crossing turn: heavy's exact page-cap arithmetic applied to the real changelog. Three
    // named calls are forced (1236+ lines, 600-line host cap); the first landed page alone blows
    // the headroom left by the two small turns — the crossing is arithmetic, not hope.
    await typeComposer(page,
      `Bigger task on this repo: read site/src/content/docs/operations/changelog.md using the read tool in EXACTLY THREE calls, no more and no fewer: offset 1 limit 600, then offset 601 limit 600, then offset 1201 limit 600. Do NOT read any other range, do NOT read the whole file in one call, and do NOT use grep or bash. Afterwards finish with one short answer, then stop.`,
      deliveredFor(sid, 'Bigger task on this repo'))

    // compliance (RECORD/live only — see the replay-discipline header): a slice that exists only in
    // the changelog's MIDDLE pages must arrive in the durable bytes (tool results live there),
    // proving the file actually landed on the surface before we wait for relief.
    if ((process.env.E2E_MODEL ?? 'live') !== 'replay') {
      const probes = pageMarkerSubstrings()
      await expect.poll(() => {
        const raw = sessionLogTextById(sid)
        return probes.length === 0 || probes.some((m) => raw.includes(m))
      }, { timeout: 1_200_000, intervals: [10_000] }).toBe(true)
    }

    // the relief itself: with two stored signatures and a forced crossing, relief falling to legacy
    // single chapters is EXACTLY the C3 failure mode — asserted below, not assumed here.
    await expect.poll(() => eventTypes(sessionLogTextById(sid), 'compaction/summary').length >= 1,
      { timeout: 900_000, intervals: [5000] }).toBe(true)

    // the reading turn must FULLY close before archive assertions and the health probe (heavy's
    // #132 correction: mid-checkpoint the model keeps working; typing early races the journey).
    await expect.poll(() => eventTypes(sessionLogTextById(sid), 'turn/end').length >= 3,
      { timeout: 1_200_000, intervals: [5000] }).toBe(true)

    // ── THE C3 VERDICT, from durable bytes only ──────────────────────────────────────────────
    const log = sessionLogTextById(sid)
    const summaries = eventTypes(log, 'compaction/summary')
    for (const sm of summaries) {
      expect(sm.data.provider, 'every compaction/summary is chapters-engine-served').toBe('dsh-chapters')
    }

    // (1) coverage invariant first (never widened): nothing shadowed unarchived.
    let chapters = registryChapters(sid)
    await expect.poll(() => {
      chapters = registryChapters(sid)
      const shadowedAll = summaries.flatMap(shadowedOf)
      return shadowedAll.length > 0 && shadowedAll.every((seq) => chapters.some((c) => seq >= c.startSeq && seq <= c.endSeq))
    }, { timeout: 480_000, intervals: [5000] }).toBe(true)

    // (2) COMPOSED, honestly per pass (false positive retired 2026-11-19 by the first live record):
    // counting registry rows whose RANGE fell inside a pass's bounding region passed six LEGACY
    // single-chapter passes, because neighboring passes' rows overlap bounding boxes. The durable
    // truth is the SET link: a pass's chapter rows are exactly those whose own shadowedSeqs are
    // subsets of that pass's shadowed set, union-covering it. >=2 such rows = composed; 1 = legacy.
    const composedPass = summaries.some((s) => {
      const region = new Set(shadowedOf(s))
      if (region.size === 0) return false
      const rows = chapters.filter((c) => {
        const own = c.shadowedSeqs ?? []
        return own.length > 0 && own.every((q) => region.has(q))
      })
      const union = new Set(rows.flatMap((r) => r.shadowedSeqs ?? []))
      return rows.length >= 2 && [...region].every((q) => union.has(q))
    })
    expect(composedPass,
      `C3 (#420): a pressure crossing with stored signatures must COMPOSE — every pass archived its shadowed set as a SINGLE chapter row (src/compose.ts inSpan containment drops any signature clipped by an earlier pass — #421's finding, measured: six passes, six rows). passes=${String(summaries.length)}, regions=${JSON.stringify(summaries.map(shadowedOf).map((r) => r.length))}, chapters=${JSON.stringify(chapters.map((c) => [c.number, c.startSeq, c.endSeq, (c.shadowedSeqs ?? []).length]))}`).toBe(true)

    // (3) ALIGNED at a topic transition: a chapter seam lands EXACTLY after a turn/end — the durable
    // record of where one topic closed and the next opened — and the chapter that starts there
    // carries the next topic's codeword (bodies are verbatim renderings, invariant 4, so "carries"
    // is mechanical, not a claim about a title). Range-containment guesses were what the first live
    // record disproved; this rule reads the two facts the archive actually holds.
    const u2 = userSeqWith(log, BREADCRUST)
    const u3 = userSeqWith(log, 'Bigger task on this repo')
    expect(u2, 'topic 2 landed as a durable user message').toBeGreaterThan(0)
    expect(u3, 'the crossing turn landed as a durable user message').toBeGreaterThan(u2)
    const sorted = [...chapters].sort((a, b) => a.startSeq - b.startSeq)
    const turnEnds = eventTypes(log, 'turn/end').map((e) => e.seq)
    const aligned = sorted.some((c, i) => {
      const next = sorted[i + 1]
      if (next === undefined) return false
      if (next.startSeq !== c.endSeq + 1) return false
      // the seam between two adjacent chapters falls exactly where a turn closed:
      const seamIsTurnBoundary = turnEnds.includes(c.endSeq)
      const rightSignedByNextTopic = chapterBytes(next).includes(BREADCRUST) || chapterBytes(next).includes('Bigger task on this repo')
      return seamIsTurnBoundary && rightSignedByNextTopic
    })
    expect(aligned, `C3 (#420): >=2 chapters exist but NO adjacent boundary separates the topics (u2=${String(u2)}, u3=${String(u3)}): ${JSON.stringify(sorted.map((c) => ({ n: c.number, r: [c.startSeq, c.endSeq], sun: chapterBytes(c).includes(SUNSTONE), bread: chapterBytes(c).includes(BREADCRUST) })))}`).toBe(true)

    // (4) session health, one small turn later — heavy's STILL-HERE probe: this leg may not claim
    // composed checkpoints in a session the next message would crash.
    await typeComposer(page, 'Reply with exactly the single word: STILL-HERE. Do not read or run anything.',
      deliveredFor(sid, 'Reply with exactly the single word: STILL-HERE. Do not read or run anything.'))
    await expect.poll(() => eventTypes(sessionLogTextById(sid), 'turn/end').length >= 4,
      { timeout: 900_000, intervals: [5000] }).toBe(true)

    // verdict artifact — "a cumulative log grepped after the fact is not evidence" (#143): the run
    // states what the archive looks like, whichever way (2)/(3) landed, and it survives failures.
    const verdict = {
      at: new Date().toISOString(), sid, mode: process.env.E2E_MODEL ?? 'live',
      passes: summaries.length,
      chapters: sorted.map((c) => ({ number: c.number, range: [c.startSeq, c.endSeq], title: c.title.slice(0, 140), hasSunstone: chapterBytes(c).includes(SUNSTONE), hasBreadcrust: chapterBytes(c).includes(BREADCRUST) })),
      topicTurnSeqs: { u2, u3 },
      composedPass,
      aligned,
    }
    fs.writeFileSync(path.join(ROOT, 'var', 'compose-verdict.json'), JSON.stringify(verdict, null, 2) + '\n')
    // eslint-disable-next-line no-console
    console.log(`[compose] verdict: ${JSON.stringify(verdict)}`)
  })
})
