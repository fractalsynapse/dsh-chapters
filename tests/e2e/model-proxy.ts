/**
 * THE MODEL TAPE — record/replay proxy for acceptance testing
 * (user directive 2026-09-19: "the local model is way too slow for regular
 * testing; distill responses that can simulate an LLM for acceptance tests").
 *
 * An OpenAI-compatible proxy between the harness and llama.cpp:
 *
 *   record  — forwards to the real model, appends each exchange (request +
 *             the RAW streamed response bytes) to the tape directory.
 *   replay  — answers ONLY from the tape: normalized-longest-prefix match of
 *             the incoming messages against recorded requests, then re-serves
 *             the recorded bytes verbatim. A miss is LOUD (503 + the miss
 *             journal) — never a silent hang.
 *
 * Prefix matching is natural here: an agent conversation is append-only, so
 * step N of a scenario is exactly step N−1's request plus new tail nodes.
 * Normalization strips run-volatile text (dates, ISO timestamps, uuid-ish
 * tokens) so a replay week later still matches. Usage fields ride along in
 * the recorded bytes — the token meter sees identical numbers, so pressure
 * thresholds fire at identical steps: acceptance tests become deterministic
 * AND seconds-fast, while the GPU model remains the distillation instrument
 * used once per scenario (and on demand).
 *
 * Test-only scaffolding, like tests/integration/http-git-server.ts: the
 * product never depends on any of this.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { estimateRequestTokens, windowRefusal } from './model-proxy-window.ts'

export interface ProxyHandle { url: string; close: () => Promise<void> }

const VOLATILE: Array<[RegExp, string]> = [
  [/\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?/g, '<DATE>'],
  // human dates measured crossing midnight: 'Sep 19' recorded, 'Sep 20' replayed
  [/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(,? \d{4})?\b/g, '<DATE>'],
  // HOSTPORT-BLIND (measured 2026-09-22, the root cause of the replay collapse):
  // the system head embeds the GUI URL `http://127.0.0.1:<port>` and the e2e
  // home path carries `var/e2e-home-<port>` — run-scheduling facts of the
  // port-keyed-home design, never product content. A run shifted off a busy
  // default port otherwise mismatched EVERY recorded entry at char ~5.9K of
  // the system message. Legacy stored prefixes re-substitute at load, so this
  // rule repairs the era's tapes without a re-record.
  [/(?:127\.0\.0\.1|localhost):\d{2,6}/g, '<HOSTPORT>'],
  [/e2e-home-\d+/g, 'e2e-home-<PORT>'],
  // est-token counts inside chapter TOC lines are DERIVED volatile numbers (they
  // move whenever a body-render detail shifts); the chapter path already
  // identifies the line, so pinning the exact count only makes tapes brittle.
  [/\(\d+ est tokens\)/g, '(<N> est tokens)'],
  // SESSIONID-BLIND (#85, measured): the compaction notice cites chapter paths under
  // `<store-root>/<rootSession>/…`, and `rootSession` is a per-boot uuid — so a replay that
  // compacted at the SAME step with the SAME bytes missed, because the path named a different
  // session. Same class as HOSTPORT-BLIND above: a run-scheduling fact of the port-keyed-home
  // design, never product content. Without it, `heavy` diverged at msg1 with commonPrefix=1 while
  // the tape held the matching entry all along (0003/0006: notice at index 1, normLen 5).
  [/\bs(?:ession|ubagent|ession-)?-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<SESSIONID>'],
  [/\bch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<SESSIONID>'],
  // WORKSPACE-BLIND (#89, measured on hosted CI 2026-10-23): the recorded prefixes carry the
  // absolute path of the machine that distilled them (`/home/adrian/Projects/dsh-chapters/…` in the
  // system header's workspace line and in every `<path>…</path>` tool result), while GitHub Actions
  // runs the same journey at `/home/runner/work/dsh-chapters/dsh-chapters`. Nothing masked it, so CI
  // could not replay ANY tape recorded on a laptop: `[suite]` hung 25 minutes on
  // `button[aria-label="Fork with chapters"]` because the first turn's request never matched an entry
  // (no answer ⇒ no assistant row ⇒ no door). Same class as HOSTPORT/SESSIONID: a scheduling fact of
  // the checkout, never product content. Applied to BOTH sides (stored prefixes re-normalize at load),
  // so a laptop replay keeps working and a runner's paths fold to the same token.
  [/(?:\/home\/runner\/work\/[\w.-]+\/[\w.-]+|\/(?:home|Users)\/[\w.-]+\/(?:Projects\/)?[\w.-]+)/g, '<WORKSPACE>'],
  // ⟦omitted:host-injected …, N chars⟧ markers embed the injected document's
  // size — which shifts with any workspace-doc edit (and real target projects
  // edit their docs constantly). The marker's presence + label are the fact;
  // the byte count is volatile.
  [/⟦omitted:host-injected [^,]+, \d+ chars/g, '⟦omitted:host-injected <label>, <N> chars'],
  // MARKER-RUN collapse (2026-09-25, hosted enrich): the enrich ladder's
  // annotation request carries the RENDERED chapter, whose injected spans
  // became N adjacent ⟦omitted⟧ markers — N depends on how many injections
  // a message happened to carry at the machine that recorded it (my box:
  // runtime snapshot + skills catalog = 2; a runner: 1). Post-canonicalization
  // the markers are byte-identical, so a run collapses to one token: the
  // FACT of injection stays; its tally is machine state.
  [/(?:⟦omitted:host-injected <label>, <N> chars(?: — [^⟧]*)?⟧[\s\n]*){2,}/g, '⟦omitted:host-injected <label>, <N> chars — project state, not conversation⟧ '],
  [/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<TIME>'],
  [/\b\d{13}\b/g, '<EPOCH>'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>'],
  [/"id"\s*:\s*"[^"]{8,}"/g, '"id":"<ID>"'],
  [/"callId"\s*:\s*"[^"]{8,}"/g, '"callId":"<CALL>"'],
  [/"toolCallId"\s*:\s*"[^"]{8,}"/g, '"toolCallId":"<CALL>"'],
  // 'seq' appears bare AND backslash-escaped (JSON-in-text title payloads);
  // one shape covers both (measured via the miss journal)
  [/"seq"\s*:\s*\d+/g, '"seq":<SEQ>'],
  // the injected skill catalog tracks the machine's plugin state and CAN
  // change between record and replay (measured mid-day); blanket it. The
  // harness CHANGED this reminder's wording once ("A skill is…" → "The
  // available skill catalog changed…"), so anchor on the STABLE structural
  // markers — a system-reminder carrying <available_skills> (or the legacy
  // opening phrase) — not on any particular sentence in the body.
  [/(?:<system-reminder>[\s\S]*?(?:<available_skills>|A skill is)[\s\S]*?<\/system-reminder>|A skill is[\s\S]*?(?:<\/system-reminder>|$))/g, '<SKILL-CATALOG>'],
  // CATALOG-CHANGE notices (2026-09-25): a mid-session swap announces itself as
  // 'The available skill catalog changed. This complete catalog replaces…' —
  // no 'A skill is' header, so the rule above never touched it and the notice
  // survived normalization as a REAL element (fork's replay request grew one
  // message past its recorded twin). Same family, same doctrine: harness
  // injection, machine- and timing-dependent, matched out entirely.
  [/(?:<system-reminder>)?\s*(?:\[System: )?The available skill catalog changed[\s\S]*?(?:<\/system-reminder>|$)/gi, '<SKILL-CATALOG>'],
  // AGENTS-BLIND (user decision 2026-09-20, reaffirmed 2026-10-01 with no
  // exceptions): workspace instruction files are DEVELOPMENT artifacts — every
  // real project ships its own; plugin behavior must not hinge on their bytes.
  // The tapes stand in for ANOTHER project, so masking the injected block
  // (header to the reminder close, or end of message) keeps doc edits FREE
  // forever: no AGENTS.md change ever requires a re-record, and a compaction
  // summary that paraphrases doc prose rides the tape as recorded model output.
  // Ordinary conversation mentions of 'AGENTS.md' are untouched: the pattern
  // demands the exact injected header. This is the LAST pipeline change: after
  // its one re-record, the corpus is stable against everything except product
  // prompts (persona, tools, notice).
  [/(?:updated |current |this is an automatically updated )?instructions from: AGENTS\.md[\s\S]*?(?=<\/system-reminder>|$)/gi, '<AGENTS-BLIND>'],
  // RUNTIME-BLIND: the harness re-injects its environment snapshot (file
  // policy, writable paths, approval policy — "Current runtime context. This
  // snapshot supersedes…") and its position/count in a conversation varies
  // with live state (measured: heavy replay missed on it). Development
  // artifact, masked like the AGENTS block; the surrounding product turns
  // still match exactly.
  [/Current runtime context\.[\s\S]*?(?=<\/system-reminder>|$)/gi, '<RUNTIME-BLIND>'],
  // WS-BLIND (measured 2026-09-24, the hosted-CI miss family): the SYSTEM
  // PROMPT itself states the machine's live paths — 'Your working directory
  // is /home/…' and 'the DSH harness implementation checkout is at
  // /usr/lib/…'. RUNTIME-BLIND cannot reach them (they are not inside the
  // injected snapshot), and every tape recorded whatever the distilling
  // machine's cwd/install prefix happened to be. A GitHub runner rewrites
  // BOTH (/home/runner/work/… and /opt/hostedtoolcache/…), so these identity
  // values blind to machine-neutral tokens; every other system-prompt byte
  // CASE-INSENSITIVE (measured same day): the sentence ships as 'The DeepSeek
  // Harness implementation checkout' (capital H) — a lowercase-only pattern
  // never fired and every tape missed on msg0.
  // (product prompts, tool descriptions) still matches exactly. Legacy
  // stored prefixes get the same substitution at load time (substituteAll),
  // so tapes recorded before this rule still match on any machine.
  [/(Your working directory is )\/[^\s"]+/gi, '$1<WS-PATH>'],
  [/(harness implementation checkout is at )\/[^\s"]+/gi, '$1<DSH-CHECKOUT>'],
  // MSGCOUNT collapse (2026-09-25, hosted heavy run): digest lines carry
  // '— N user / M assistant messages' — counts over a chapter's swallowed
  // messages INCLUDING harness injections. The skills catalog is a user
  // message on a machine that has skills (my dev box: '4 user'); a runner
  // with none computes '3 user' — one byte apart, and the STILL-HERE
  // request after two compactions missed everything. Same derived-count
  // family as (N est tokens) and the omitted-char markers: the line
  // identifies the chapter; the counts are not matching material.
  [/\d+ user \/ \d+ assistant messages?/g, '<MSGCOUNT>'],
  // CH-ORDINAL collapse (2026-09-29, hosted fanout run): a continuation TOC
  // cites `chapters/NNN-<slug>.md`; NNN is a DERIVED COUNTER — how many
  // chapters the session had written when this compaction fired. The fanout
  // child sits ON the compaction boundary (its six-read cap is tuned to
  // cross it), so a dev box that tips one more split cites `002-` where a
  // runner cites `001-`; the whole request missed its stored exchange at
  // that one byte. Same derived-count family as MSGCOUNT: the slug
  // (read-var-e2e-paperb…) identifies the chapter, the ordinal is a
  // machine-borderline count, not matching material. Match-only — the
  // served response bytes are untouched, and this rule self-repairs tapes
  // recorded before it (substituteAll runs over stored prefixes at load).
  [/chapters\/\d+-/g, 'chapters/<CH>-'],
  // and the same for the defused product token (enricher inputs): runs across
  // NEWLINES too — the dump shows spaces only because normalization ate them
  [/(?:⟦injected-context⟧[ \t\n]*){2,}/g, '⟦injected-context⟧ '],
]
/** substitution pass over ALREADY-textual content.
 *
 * FIRST STEP collapses backslash-escaped quotes at ANY nesting depth to plain
 * quotes: a title prompt carries JSON-in-text-in-JSON, so "seq":8 appears as
 * "seq":8, \"seq\":8, … depending on stringify depth. Collapsing before
 * substituting makes every depth converge to identical canonical text — on
 * both the incoming side AND legacy stored prefixes (which still hold their
 * escaped forms from the old rules). */
export function substituteAll(str: string): string {
  let t = str
  if (/^\{\s*"role"\s*:\s*"tool"/.test(t)) return '{"role":"tool"}'
  // canonical escape/whitespace equivalence class (measured S0 diff): legacy
  // stored strings round-tripped through JSON.parse carry REAL newlines/quotes,
  // incoming stringified text carries literal two-char escape sequences. Both
  // forms must collapse to identical canonical text or nothing ever matches.
  t = t.replace(/\\*"/g, '"') // escaped quotes at any depth -> plain
  t = t.replace(/\\[nrt]/g, ' ') // literal backslash-n/t/r -> space
  t = t.replace(/\s+/g, ' ') // real whitespace runs -> single space
  for (const [re, rep] of VOLATILE) t = t.replace(re, rep)
  // RE-CLOSE injection-only fragments eaten to end-of-string (measured
  // 2026-09-24, the local-green/CI-red gap): rules ending in a `$` lookahead
  // consume the JSON terminator too when the injected block runs to the
  // message end — which depends on whether the harness closed it with
  // </system-reminder> (machine/version dependent). The unterminated
  // fragment then fails the pure-noise test and survives as a phantom
  // array element. Restoring the closing quote+brace lets the existing
  // noise filter drop the message on EVERY machine; messages with genuine
  // text never match this token-only shape, so real content is untouchable.
  t = t.replace(/^(\{"role":"(?:user|system)","content":")((?:\s|<\/?system-reminder>|<(?:SKILL-CATALOG|AGENTS-BLIND|RUNTIME-BLIND)>)*<(?:SKILL-CATALOG|AGENTS-BLIND|RUNTIME-BLIND)>)$/, '$1$2"}')
  // PRESENCE-volatile injections (skill-catalog change notices, AGENTS
  // re-injects, runtime-context snapshots) may exist in one run's transcript
  // at a position and be entirely absent in another's — equalizing their
  // CONTENT is not enough, the arrays differ in length. Once masked, a
  // message consisting ONLY of such markers is dropped from matching (''),
  // and both array sides filter empties. Real conversation text can never
  // reduce to bare markers, so no genuine message is ever dropped.
  return /^\{"role":"(?:user|system)","content":"(?:\s|<\/?system-reminder>|<(?:SKILL-CATALOG|AGENTS-BLIND|RUNTIME-BLIND)>)*"\}$/.test(t) ? '' : t
}
/** canonical form of a message OBJECT: one stringify + substitutions. */
export function normalize(v: unknown): string {
  // TOOL RESULTS ARE HARNESS-GENERATED, never model output: their bytes
  // depend on the workspace state at replay time (measured: a src/ edit
  // between record and replay missed the recorded read result). They carry
  // zero signal for matching — model side, the scripted tool CALLS and
  // their args come from the tape; live tool behavior is asserted via the
  // durable plane (spec effects), not via tape equality. This rule is FINAL:
  // any further normalizer change invalidates existing tapes by definition.
  if (typeof v === 'object' && v !== null && (v as { role?: unknown }).role === 'tool') return '{"role":"tool"}'
  return substituteAll(JSON.stringify(v))
}

const messagesOf = (body: Record<string, unknown>): unknown[] => Array.isArray(body.messages) ? body.messages : []

export interface TapeEntry { key: string; prefix: unknown[]; status: number; contentType: string; bytes: string /* base64 */; model: string; recordedAt: string }

export interface ProxyOpts {
  mode: 'record' | 'replay'
  tapeDir: string
  /**
   * #78: the context window the rig ENFORCES. A hosted upstream accepts a 33K prompt happily, so
   * a context-pressure journey distilled against it never produces the `context-overflow` trigger
   * the pinned 32K regime exists to exercise — it measures a boot where nothing is wrong. The
   * local stress server refuses; this makes the refusal a property of the rig, identical on
   * rented hardware. 0/unset means no enforcement: replay and deliberately-unwindowed runs are
   * untouched.
   */
  windowTokens?: number
  /** journal override; default is next to the tapes */
  journalPath?: string
  upstream?: string // e.g. http://localhost:8080 — required in record mode
  /** #54: the credential the PROXY presents upstream, replacing whatever the
   * harness sent. The e2e profile must never hold a real key — it is a fixture —
   * and the local vLLM rig does not check one at all, so leaving this unset keeps
   * the passthrough behavior the GPU box has always had. */
  upstreamKey?: string
  /** #54: rewrite the REQUESTED model name on the way out, so the fixture can keep
   * the id its profile pins (`qwen3.8-flash-next`, the 32K stress regime) while a
   * hosted upstream is addressed by the id it actually serves. The tape stores the
   * profile's name — never the remote's — because a tape is a fixture of THIS rig,
   * not of whatever service distilled it. */
  upstreamModel?: string
  /** #54: how long the proxy waits for upstream RESPONSE HEADERS before it calls the
   * request dead. The profile pins `timeoutMs: 3600000` (an hour) on the harness side,
   * so with nothing on the proxy a stalled distill is indistinguishable from a slow one
   * — measured: a `suite` leg produced no tape entry for 20 minutes and no log line
   * anywhere could say which of the two it was. 10 minutes is generous for a real
   * prefill at the stress regime and short enough to end a run with an answer. */
  upstreamTimeoutMs?: number
  /** #54: journal path for in-flight upstream activity. Defaults next to the tapes. */
  activityLog?: string
  /** #54: how often a request that has NOT sent its first byte re-logs itself. */
  stallWarnMs?: number
  /** replay + liveFallback: a miss goes to the real model AND lands on the
   * tape (journal the gap, self-heal); strict replay keeps misses LOUD so
   * suites fail fast when a scenario legitimately changed. */
  liveFallback?: boolean
}

function loadTape(tapeDir: string): TapeEntry[] {
  const out: TapeEntry[] = []
  for (const f of fs.readdirSync(tapeDir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(tapeDir, f), 'utf8')) as TapeEntry
      // tapes recorded under older normalizer rules carry residue ('Sep 19'
      // literals); applying the SUBSTITUTION pass to stored strings keeps both
      // sides of the match on current rules without a re-record. (The earlier
      // attempt here re-RAN normalize(), which double-stringified stored
      // strings and broke every legacy match — the S0 root cause.)
      e.prefix = e.prefix.map((p) => (typeof p === 'string' ? substituteAll(p) : normalize(p))).filter((x) => x !== '')
      ;(e as Record<string, unknown>).file = f
      out.push(e)
    } catch { /* skip torn */ }
  }
  return out
}

/**
 * Recorded request must match the incoming one ENTIRELY after normalization —
 * plain prefix matching collided ACROSS scenarios (all specs share a
 * normalized system+reminder header; replayed one spec's answer into
 * another's first call, ending its turn with zero assistant messages —
 * measured). The conversation's append-only nature means the right exchange
 * is present at full length; requiring equality also on the LAST message
 * pins that. A legit re-run whose volatile content normalized identically
 * still matches.
 */
/**
 * Say WHAT DIVERGED, not only that something missed (#56).
 *
 * A bare MISS line told me `messages=5` and the last message's text — which could not answer the
 * only question that matters when replay breaks: *which recorded turn* does this continue, and at
 * which message do the bytes stop agreeing? The answer is what separates "the host asked a shorter
 * conversation because an injection went missing" from "the tape is from a different journey
 * entirely". Exported so a row can pin it, because an instrument that only runs inside a failing
 * leg is an instrument nobody trusts.
 */
export function describeMiss(tape: TapeEntry[], incoming: unknown[], label = '?'): string {
  const inc = incoming.map((x) => substituteAll(typeof x === 'string' ? x : JSON.stringify(x) ?? '')).filter((x) => x !== '')
  // `file` is filled by the tape loader; a caller without it (a test, a partially built tape)
  // still gets a usable index rather than a mysterious `?`
  let best = { entry: '?', common: -1, idx: -1 }
  const scored: Array<{ entry: string, common: number }> = []
  for (let ti = 0; ti < tape.length; ti += 1) {
    const e = tape[ti]
    const stored = (e.prefix ?? []).map((x) => substituteAll(typeof x === 'string' ? x : JSON.stringify(x) ?? '')).filter((x) => x !== '')
    let n = 0
    while (n < stored.length && n < inc.length && stored[n] === inc[n]) n += 1
    const name = e.file ?? `entry#${String(ti)}`
    scored.push({ entry: name, common: n })
    if (n > best.common) best = { entry: name, common: n, idx: ti }
  }
  // Ties were a lie: with msg0 matching every entry and msg1 matching none, the first entry won by
  // accident and reported the QUESTION-bearing entry as "closest" — pointing a reader at the wrong
  // turn. Report every entry that ties at the maximum, so "the notice matches no recorded notice"
  // is visible as such.
  const tied = scored.filter((x) => x.common === best.common).map((x) => x.entry)
  const at = best.common
  const wantIdx = at < inc.length ? String(at) : 'end'
  const got = at < inc.length ? inc[at].slice(0, 110) : ''
  const exp = (() => {
    const e = best.idx >= 0 ? tape[best.idx] : tape.find((t) => t.file === best.entry)
    if (e === undefined || at >= (e.prefix ?? []).length) return ''
    const s = (e.prefix ?? [])[at]
    return substituteAll(typeof s === 'string' ? s : JSON.stringify(s) ?? '').slice(0, 110)
  })()
  if (process.env.E2E_MISS_DUMP !== undefined && best.idx >= 0) {
    // Opt-in, and it changes nothing about matching: the 400-char previews can show THAT two long
    // notices differ without showing WHERE, and "where" is the whole diagnosis (#85). Both full
    // normalized arrays go to the file named by the env var, once per divergence.
    try {
      const bestEntry = tape[best.idx]
      const stored = (bestEntry.prefix ?? []).map((x) => substituteAll(typeof x === 'string' ? x : JSON.stringify(x) ?? '')).filter((x) => x !== '')
      fs.appendFileSync(process.env.E2E_MISS_DUMP,
        `=== MISS tape=${label} closest=${best.entry} commonPrefix=${String(best.common)}\n`
        + `--- INCOMING (${String(inc.length)}) ---\n${inc.join('\n<<<msg>>>\n')}\n`
        + `--- STORED (${String(stored.length)}) ---\n${stored.join('\n<<<msg>>>\n')}\n\n`)
    } catch (error) {
      // A diagnostic must never break a request — but swallowing the error outright is how this
      // block silently produced NO dump for a whole run while the journal kept saying MISS
      // (it referenced a variable that is not in scope here, and tsconfig.json never checks
      // tests/e2e, so nothing compile-time caught it either). Say so on stderr instead.
      console.error(`e2e: MISS dump failed (matching is unaffected): ${String(error)}`)
    }
  }
  return `closest=${best.entry}${tied.length > 1 ? ` tied=[${tied.join(',')}]` : ''} commonPrefix=${String(best.common)} divergeAt=msg${wantIdx}`
    + ` got=${JSON.stringify(got)} expected=${JSON.stringify(exp)}`
}

function findReplay(tape: TapeEntry[], incoming: unknown[]): TapeEntry | null {
  const inc = incoming.map(normalizeSingle).filter((x) => x !== '')
  let best: TapeEntry | null = null
  for (const e of tape) {
    const p = e.prefix
    if (p.length !== inc.length) continue
    let ok = true
    for (let i = 0; i < p.length; i++) if (p[i] !== inc[i]) { ok = false; break }
    // ties resolve to the NEWEST recording: re-record appends, and the
    // freshest capture of a conversation is the truthful one
    if (ok && (best === null || e.recordedAt > best.recordedAt)) best = e
  }
  if (best === null && process.env.E2E_TAPE_DIFF) {
    // instrumented: dump incoming + stored prefixes, BEST-MATCHING FIRST —
    // a flat slice(0,3) showed only unrelated scenarios that merely share a
    // normalized length, hiding the one candidate that diverged by one byte
    // (measured 2026-09-24: three CI cycles burned re-guessing at it)
    const shared = (p: unknown[]): number => {
      let n = 0
      while (n < p.length && n < inc.length && String(p[n]) === String(inc[n])) n++
      return n
    }
    const sameLen = tape
      .filter((e) => e.prefix.length === inc.length)
      .sort((a, b) => shared(b.prefix) - shared(a.prefix))
      .slice(0, 3)
    const dir = process.env.E2E_TAPE_DIFF
    fs.mkdirSync(dir, { recursive: true })
    const n = fs.readdirSync(dir).length
    fs.writeFileSync(path.join(dir, `${String(n).padStart(3, '0')}.json`), JSON.stringify({
      incoming: inc, storedCandidates: sameLen.map((e) => e.prefix),
    }, null, 1).slice(0, 4_000_000))
  }
  return best
}
export function normalizeSingle(m: unknown): string { return JSON.stringify(m) === '' ? '' : normalize(m) }

/**
 * A single upstream attempt, buffered, with bounded throttle-retry (#54).
 *
 * Why buffered rather than streamed: a 429 must be RETRYABLE, and the only safe moment to
 * decide that is before any byte reaches the client or the tape — once an SSE body has been
 * half-forwarded, retrying either duplicates output downstream or writes a throttle into the
 * corpus as if it were an answer. Record mode is a distill, not a chat: the client is the
 * harness, its own client timeout is an hour, and replay never takes this path at all (it is
 * served from the tape). So buffering costs nothing measurable and buys quota survival.
 *
 * Every watchdog is cleared on every exit path and unref'd: an armed timer is a process that
 * will not exit, which is how a green test file hung for ten minutes while its rows had
 * already finished (measured, same evening).
 */
interface PumpOpts {
  transport: typeof http | typeof https
  upstreamUrl: URL
  method: string
  headers: Record<string, unknown>
  body: Buffer
  tapeDir: string
  journal: (line: string) => void
  res: import('node:http').ServerResponse
  keyOf: () => string
  prefixOf: () => string[]
  modelOf: () => string
  timeoutMs: number
  stallMs: number
  retryMax: number
  retryMs: number
  startedAt: number
  onInflight: (delta: number) => void
  onBytes: (n: number) => void
}

interface PumpOutcome { status: number; contentType: string; chunks: Buffer[] }

const sleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() })

async function attemptOnce(o: PumpOpts, attempt: number): Promise<PumpOutcome> {
  return await new Promise<PumpOutcome>((resolve) => {
    let settled = false
    const finish = (v: PumpOutcome): void => {
      if (settled) return
      settled = true
      clearInterval(stall)
      clearTimeout(dead)
      resolve(v)
    }
    const chunks: Buffer[] = []
    let firstLogged = false
    const up = o.transport.request(o.upstreamUrl, { method: o.method, headers: { ...o.headers } }, (resUp) => {
      const status = resUp.statusCode ?? 200
      const contentType = String(resUp.headers['content-type'] ?? 'text/event-stream')
      resUp.on('data', (c) => {
        const b = c as Buffer
        chunks.push(b)
        o.onBytes(b.length)
        if (!firstLogged) {
          firstLogged = true
          clearInterval(stall)
          o.journal(`FIRSTBYTE status=${String(status)} elapsed=${String(Date.now() - o.startedAt)}ms attempt=${String(attempt)}`)
        }
      })
      resUp.on('end', () => finish({ status, contentType, chunks }))
      resUp.on('error', () => finish({ status: 0, contentType: 'text/event-stream', chunks }))
    })
    const stall = setInterval(() => {
      o.journal(`STALLED attempt=${String(attempt)} elapsed=${String(Date.now() - o.startedAt)}ms bytes=${String(chunks.length)}`)
    }, o.stallMs)
    const dead = setTimeout(() => {
      o.journal(`DEAD attempt=${String(attempt)} elapsed=${String(Date.now() - o.startedAt)}ms no-response-headers — destroying (E2E_UPSTREAM_TIMEOUT_MS=${String(o.timeoutMs)})`)
      try { up.destroy() } catch { /* already gone */ }
      finish({ status: 504, contentType: 'application/json', chunks: [Buffer.from(JSON.stringify({ error: { message: `tape proxy upstream: no response after ${String(o.timeoutMs)}ms (${o.upstreamUrl.pathname})`, type: 'upstream_timeout' } })) ] })
    }, o.timeoutMs)
    up.on('error', (e) => {
      // a transport failure is a RETRY candidate too; the old code answered 502 on the first sneeze
      o.journal(`XERROR attempt=${String(attempt)} elapsed=${String(Date.now() - o.startedAt)}ms :: ${String(e).slice(0, 160)}`)
      finish({ status: 0, contentType: 'application/json', chunks: [Buffer.from(JSON.stringify({ error: { message: `tape proxy upstream: ${String(e)}`, type: 'upstream_error' } })) ] })
    })
    stall.unref?.()
    dead.unref?.()
    up.write(o.body)
    up.end()
  })
}

async function pumpUpstream(o: PumpOpts): Promise<void> {
  let attempt = 0
  for (;;) {
    attempt += 1
    o.onInflight(1)
    const out = await attemptOnce(o, attempt)
    const throttled = out.status === 429 || out.status === 0 || out.status >= 500
    if (throttled && attempt <= o.retryMax) {
      o.journal(`RETRY attempt=${String(attempt)} status=${String(out.status)} waiting=${String(o.retryMs)}ms (E2E_UPSTREAM_RETRY_MAX=${String(o.retryMax)})`)
      o.onInflight(-1)
      await sleep(o.retryMs)
      continue
    }
    if (out.status === 429 || out.status >= 500) {
      o.journal(`LIMITED status=${String(out.status)} elapsed=${String(Date.now() - o.startedAt)}ms attempts=${String(attempt)} — distill throttled by the upstream; the answer is NOT recorded. Re-run later, or against the local stress server (:8080), which is what the pinned regime is for`)
    }
    try { o.res.writeHead(out.status, { 'content-type': out.contentType }) } catch { /* client gone */ }
    for (const b of out.chunks) { try { o.res.write(b) } catch { /* client gone mid-write */ } }
    try { o.res.end() } catch { /* client gone */ }
    o.journal(`DONE elapsed=${String(Date.now() - o.startedAt)}ms status=${String(out.status)} attempts=${String(attempt)} bytes=${String(out.chunks.reduce((n, b) => n + b.length, 0))}`)
    o.onInflight(-1)
    if (out.status >= 300) return // a failed answer is not a fixture
    const entry: TapeEntry = {
      key: o.keyOf(),
      prefix: o.prefixOf(),
      status: out.status,
      contentType: out.contentType,
      bytes: Buffer.concat(out.chunks).toString('base64'),
      model: o.modelOf(),
      recordedAt: new Date().toISOString(),
    }
    const n = fs.readdirSync(o.tapeDir).filter((f) => /^\d+\.json$/.test(f)).length
    fs.writeFileSync(path.join(o.tapeDir, `${String(n).padStart(4, '0')}.json`), JSON.stringify(entry))
    return
  }
}


export async function startModelProxy(opts: ProxyOpts): Promise<ProxyHandle> {
  // Which project's tape this is — a miss must name itself (see the journal line).
  const tapeName = path.basename(opts.tapeDir)
  fs.mkdirSync(opts.tapeDir, { recursive: true })
  const missLog = opts.journalPath ?? path.join(opts.tapeDir, '..', 'e2e-tape-misses.log')
  // #54: the DISTELLER's visibility. A tape miss is loud by design; a request that
  // simply never comes back was silent for as long as the harness's own hour timeout.
  // Every upstream attempt now logs start / stalled / first-byte / done / dead, with
  // elapsed and byte counts, so "is it progressing" is a lookup, not an inference.
  // beside the MISS journal, not inside the tape directory: tests/fixtures/model-tape
  // is the corpus, and a runtime log dropped in it is an untracked file that outlives
  // the run and gets committed by the next broad `git add`.
  const activityLog = opts.activityLog ?? process.env.E2E_UPSTREAM_LOG
    ?? path.join(path.dirname(missLog), 'e2e-upstream.log')
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? Number(process.env.E2E_UPSTREAM_TIMEOUT_MS ?? 600_000)
  const stallWarnMs = opts.stallWarnMs ?? Number(process.env.E2E_UPSTREAM_STALL_MS ?? 60_000)
  let inFlight = 0
  const journal = (line: string): void => {
    try { fs.appendFileSync(activityLog, `${new Date().toISOString()} tape=${tapeName} ${line}\n`) } catch { /* visibility never breaks the run */ }
  }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      void (async () => {
        // #54: `let`, not `const` — the upstream model rewrite below rebinds it, and a
        // TypeError thrown inside a try/catch that swallows everything is how a
        // translation silently does nothing while the client still sees a 200.
        let raw = Buffer.concat(chunks)
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(raw.toString('utf8')) as Record<string, unknown> } catch { /* non-json passthrough below */ }
        const inc = messagesOf(body)
        // #78: enforced in BOTH modes, before anything else. The regime is part of what the tape
        // records — a distill that saw a refusal and retried after relief must see the same refusal
        // on replay, or the request sequence diverges and the chain fails for a reason that looks
        // like prompt drift. Refusals are never recorded and never consume an entry.
        const win = opts.windowTokens ?? Number(process.env.E2E_WINDOW_TOKENS ?? 0)
        const refusal = windowRefusal(body, win)
        if (refusal !== null) {
          journal(`OVERFLOW refused mode=${opts.mode} est=${String(estimateRequestTokens(body))} tokens window=${String(win)} — rig-enforced (E2E_WINDOW_TOKENS); nothing recorded, no tape entry consumed`)
          try { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(refusal)) } catch { /* client gone */ }
          return
        }
        if (opts.mode === 'replay') {
          // The journal must show replay's requests too. When enforcement was hoisted above this
          // branch, `START` stayed down in the record/live path and replay went unobservable —
          // which is how a divergence hunt ended up reasoning from silence. One line per request,
          // same fields, mode named.
          journal(`REQUEST mode=replay path=${(req.url ?? '/').split('?')[0]} msgs=${String(inc.length)} reqBytes=${String(raw.length)}`)
          const tape = loadTape(opts.tapeDir)
          const hit = findReplay(tape, inc)
          if (hit !== null) {
            if (process.env.E2E_TAPE_HITS) {
              // instrumentation: normalized shape + which entry file served the request
              const norm = inc.map(normalizeSingle).filter((x) => x !== '')
              fs.appendFileSync(process.env.E2E_TAPE_HITS,
                `${new Date().toISOString()} HIT raw=${inc.length} norm=${norm.length} served=${hit.file ?? '?'} lastNorm=${String(norm[norm.length - 1] ?? '').slice(0, 110)}\n`)
            }
            res.writeHead(hit.status, { 'content-type': hit.contentType })
            res.end(Buffer.from(hit.bytes, 'base64'))
            return
          }
          // The old line said "project-tape" for every project, which made a red
          // chain undiagnosable: two boots append to one journal, so a miss from
          // `heavy` looked like the failure of whichever project died last. Name
          // the tape AND how many entries it loaded — "entries=0" is a different
          // bug (missing/untracked tape) than a prefix mismatch.
          fs.appendFileSync(missLog, `${new Date().toISOString()} MISS tape=${tapeName} entries=${String(tape.length)} messages=${String(inc.length)} ${describeMiss(tape, inc, tapeName)}\n`)
          // A miss is fatal (503) — UNLESS liveFallback is on, where it falls
          // through to the record path: the real model answers the drifted
          // request AND it lands on the tape, so the next clean replay
          // self-heals this exact prefix without a full re-record. Hits keep
          // coming from the tape; only the drifted remainder pays the GPU.
          if (opts.liveFallback !== true) {
            res.writeHead(503, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: `e2e model tape miss: no recorded exchange prefixes the ${inc.length}-message request (see ${missLog}) — re-record this scenario with E2E_MODEL=record` }, type: 'tape_miss' }))
            return
          }
        }
        // ---- record: stream through, capture bytes, append tape
        const upstreamUrl = new URL((opts.upstream ?? 'http://localhost:8080') + req.url!)
        const transport = upstreamUrl.protocol === 'https:' ? https : http
        const fwd: Record<string, unknown> = { ...req.headers, host: upstreamUrl.host }
        if (opts.upstreamKey !== undefined && opts.upstreamKey !== '') {
          // ONE credential leaves this process toward the upstream, and it is not the
          // profile's — the harness keeps talking to a keyless local fixture
          fwd.authorization = `Bearer ${opts.upstreamKey}`
        }
        if (opts.upstreamModel !== undefined && opts.upstreamModel !== '') {
          try {
            const parsed = JSON.parse(raw.toString('utf8')) as { model?: unknown }
            if (typeof parsed.model === 'string' && parsed.model !== opts.upstreamModel) {
              parsed.model = opts.upstreamModel
              raw = Buffer.from(JSON.stringify(parsed), 'utf8')
              // and say how long it is: a stale content-length makes the upstream
              // read the OLD body (measured — the rewrite silently did nothing while
              // the client still saw a 200)
              fwd['content-length'] = String(raw.length)
            }
          } catch { /* not a JSON body (models/info) — pass it through untouched */ }
        }
        const startedAt = Date.now()
        inFlight += 1
        let sawBytes = 0
        let firstByteMs = -1
        journal(`START path=${upstreamUrl.pathname} msgs=${inc.length} reqBytes=${raw.length} inflight=${inFlight} timeoutMs=${upstreamTimeoutMs}`)
        // watchdogs live in pumpUpstream now, PER ATTEMPT — arming them here too would
        // double-answer the client and keep the process alive after the run (#54).
        // Buffered pump with bounded throttle-retry (#54). The only behavioral difference
        // from the inline relay it replaces: a RECORD answer is forwarded when it completes
        // instead of chunk-by-chunk, which is what makes a 429 retryable without half-writing
        // an SSE body or recording a throttle as an answer. Replay never takes this path.
        const retryMax = opts.upstreamRetryMax ?? Number(process.env.E2E_UPSTREAM_RETRY_MAX ?? 3)
        const retryMs = opts.upstreamRetryMs ?? Number(process.env.E2E_UPSTREAM_RETRY_MS ?? 20_000)
        await pumpUpstream({
          transport, upstreamUrl, method: req.method ?? 'POST', headers: fwd, body: raw,
          tapeDir: opts.tapeDir, journal, res,
          keyOf: () => createHash('sha256').update(normalize(body)).digest('hex').slice(0, 16),
          prefixOf: () => inc.map(normalizeSingle),
          modelOf: () => String(body.model ?? ''),
          timeoutMs: upstreamTimeoutMs, stallMs: stallWarnMs,
          retryMax, retryMs, startedAt,
          onInflight: (delta) => { inFlight += delta },
          onBytes: (n) => { sawBytes += n },
        })
      })()
    })
  })
  // Port-parameterized (measured 2026-09-22): a killed run left the proxy
  // listening on the hard-coded 41799 and EVERY later boot died on EADDRINUSE.
  // Derive from the e2e boot port (E2E_PROXY_PORT, set by boot.ts from the same
  // env that keys the home) so projects and re-runs never collide.
  // #78: when nothing asks for a specific port, take an EPHEMERAL one. The fixed default
  // (41799) was already the subject of the 2026-09-22 note above, but the derivation only
  // covers boots: two unit-test files in the same `node --test` pass both defaulted to it, so
  // one bound it and the other hung on EADDRINUSE with an error that read like a leaked
  // process. `boot.ts` still sets E2E_PROXY_PORT (port+1000) because the profile patch must
  // name the proxy URL before the proxy exists — that requirement is preserved exactly.
  const wantPort = process.env.E2E_PROXY_PORT !== undefined ? Number(process.env.E2E_PROXY_PORT) : 0
  await new Promise<void>((resolve) => server.listen(wantPort, '127.0.0.1', resolve))
  const bound = server.address() as { port: number } | null
  if (bound === null) throw new Error('tape proxy: listen reported no address — the URL cannot be built')
  return {
    url: `http://127.0.0.1:${String(bound.port)}/v1`,
    close: async () => { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) },
  }
}
