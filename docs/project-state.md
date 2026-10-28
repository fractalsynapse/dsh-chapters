# Project state — the history of what was built and measured

**Moved out of `AGENTS.md` verbatim on 2026-10-22.** `AGENTS.md` is loaded into every agent session
against a workspace instruction budget, and it had grown to 70,401 bytes — over the limit, so the file was
being silently TRUNCATED when delivered: the rules near the top survived and the ones at the bottom did not,
which is worse than a smaller honest file. This is the project's record of what happened, what was measured,
and what remains unverified. It is reference material, not a rule surface: **read it when you need the
history of a decision, not before every task.** The rules that lived inside it are in
`AGENTS.md` § Rig and metering rules, and the load-bearing spec stays in `docs/`.

---

## Start Here
## 2026-10-22/23 — the host 0.2.0-rc.2 acceptance sweep (#56)

**What actually happened, in order.** The pinned host moved to 0.2.x; the tape corpus stayed at
0.1.5-rc.1, so `CORPUS_HOST` closed the acceptance chain and no e2e claim was current (#56/#57). While
re-anchoring it, seven distinct failures turned out to be **one root cause plus six real defects**: the
preset pin had been written to a row id the host retired (`agent-presets` → `agent-preset-registry`), so
every browser boot since the move ran the STANDARD realm — no `compaction/*`, no arrival artifacting, no
`chapters_rules`. The legs were measuring an absence. Fixing the pin is what made the other six visible.

**Defects found by measurement, each with red-first rows, on `feature/56-reanchor-tape-corpus`:**
- **#77** — the continuation door called `sessions.open`, a verb that does not exist; the real seam is
  `uiWorkspace.openSession` (`docs/contract.md` § Client Sessions Service). Three evenings of "the client
  refuses to catalogue plugin-created children" were a door that never switched anything, while the tool
  reported success. The door now verifies the switch from live state and degrades to
  `switched:false, note:…` rather than claiming it.
- **The flattened 0.2.x `tool/result` shape** silently disabled arrival artifacting chain-wide (the
  probe decoded `data.message` at the top level, where 0.2.x puts `data.message.message`). Arrival
  artifacted nothing because the predicate was never true — `src/arrival.ts` now takes both dialects,
  with a row that rebuilds the assertion against the host's real event shape.
- **#79** — the composer ghost ran `command/run` on **every render** (measured 4–26 per session, into
  the transcript this plugin archives) because a `useEffect` listed `[props]` under a comment claiming
  "once per mount"; and it kept pulling suggestions from a disabled feature.
- **#78** — relief that declines while the surface is over the trigger said nothing. It now prints
  `surface=/trigger=/window=/ratio=` plus the offending node count; observed live:
  `relief declined … (surface=33442 trigger=16000 window=32000 ratio=0.5)`. The engine deliberately does
  **not** override the operator's arrival floor (AGENTS calls that switch a behavior switch, and a rig
  that reinterprets config is the same dishonesty as a pin that is collected and never applied).
- **#81/#84** — `typeComposer` decided "did my send work?" from the editor's own emptiness, which the
  host clears asynchronously: one session received the same instruction twice (seq 40 and 47). Then the
  guard, matching an 80-character prefix, **swallowed** a genuinely different second instruction. Delivery
  is now decided from the durable log, by the full instruction, after a bounded grace — and a drift row
  fails if any composer call decides from the editor again.
- **#85** — replay booted a **different realm than record** because the rig's regime lived in three
  places (distill tables, the chain script's inline env, boot defaults) and Playwright project `env`
  reaches only workers, so `globalSetup` used defaults. One table now (`tests/e2e/rig-pins.ts`), read by
  both the config and the boot.
- **#87** — the deepest one, and the last to become visible: **relief shadows the newest human
  instruction.** Measured from one session's durable log: 13 compaction summaries, 108 distinct shadowed
  seqs, `STILL-HERE` sent eleven times, **ten of them shadowed away**, final assistant text empty.
  `retainRatio` reserves a token fraction as a verbatim tail, so an oversized node in the tail consumes
  it and the question disappears with no error anywhere. The fix is inside our seam and honors
  invariant 1: `carryOpenRequest` appends the newest human turn **verbatim** into the summary we author
  (`openRequestCarryMaxChars`, default 4000; truncation is stated, never silent; injected scaffolding is
  excluded by the one canonical predicate, `isInjectedProse`).

**The instruments earned their keep, and four bugs lived in the instruments.** `pending` never
matched a JSON-escaped newline; `ids.size > 0` disabled every #77 candidate; a report helper resolved
logs against the import-time home so its own gate could never pass; an unbounded
`scrollIntoViewIfNeeded` hung a leg for 17 minutes; my own MISS dump was swallowed by its own `catch`
for a whole run; and a second injected-prose list was caught by the #59 drift row within minutes.
`docs/verify.md` now carries a release gate shaped by these failures ("an unexercised assertion is a
rumor of an assertion"), and `npm run typecheck:e2e` exposes **77 errors in a browser plane that has
never been type-checked** (#83) — after I subtracted the ones my own new code caused.

**Still open as this lands:** #86 (a session with the arrival floor off can livelock on one oversized
result — 89 requests in 20 minutes, three outcomes for the same leg minutes apart), #80 (plugin command
results are durable but render nothing operator-visible), #82 (a distill and the deterministic suite share
the corpus directory), #81 criteria 3-4, and the #78 A/B product decision, which is the maintainer's.


**Phase 0 passed.** Across nine probe boots on an isolated instance, a plugin created a session seeded with
exactly one synthetic `user/message`, and that session was **listed** by `sessionQuery.listSessions`,
**resumable** via `agents.resume({ resumeSessionId })` after disposing the create handle, **durable across a
process kill**, and its TOC text round-tripped **byte-identical**. Structurally the head is bounded: ~102
tokens of notice versus ~2,476 for the equivalent transcript. Full measurements and the seed contract:
[spikes/probe/FINDINGS.md](spikes/probe/FINDINGS.md).

**Phase 0b passed (rounds 12-17): the compaction seam is real.** A plugin-subclassed `BasicCompactionEngine`
with a deterministic `summarize()` ran both the manual (`/compact`) and automatic (`agent/pre-step`)
paths to durable commit — surface 504→206 tokens, **zero summarization tokens**, log append-only
throughout. The live engine slot is the **agent-preset realm**, not the host plane; double-provisioning
one plane fails boot loudly; and the Phase 1 mount is a shipped preset naming `dsh-chapters` +
`setup`-mounted creation (all of it measured, cited, in
[docs/host-compaction-seam.md](docs/host-compaction-seam.md) and FINDINGS).

**Phase 1 stages 0-4 landed (rounds 18-22): the whole loop works with the real parts.** Registry/store/engine/
preset-install/tools pass — a realm row names our subpath export (`dsh-chapters/engine`), the cascade
finalizes post-commit, `presets/chapters/` installs itself into `.agent-presets` at boot (profile
`!!js` has no `require`, copying was the delivery mechanism) — and since 0.1.16 that copy validates the
WHOLE shipped file set and repairs missing files additively: the guard once tested only for `preset.yml`
while `agent.cordis.yml` is the file that mounts the engine, so a partial wipe was a permanent silent
failure (never clobber a user's edits; DO restore what is absent), and r22 closed the MVP loop: parent →
`chapters_segment` → `chapters_continue` (ranges only; plugin renders) → TOC-only child with the composed
preset (15K head) → the CHILD `read` its chapter and echoed its title back. Two real bugs caught and
fixed en route: finalization must run on the rejection path too (the retry loop can commit, then throw),
and `validateRanges` refuses before any file is written.

**Host 0.1.7-alpha.1 retired the preset mechanism that paragraph describes — do not carry it forward as
current.** Nothing reads `$DSH_HOME/.agent-presets` any more; a preset is an `@deepseek-ai/dsh-agent-preset`
*declaration row*, and the chapters preset IS one now: `preset-chapters`, inserted by our own bundle patch,
with the preset definition in its `config` — so it is a visible Loader entry you can inspect, override, or
`disabled: true` from a profile patch, exactly like the host's `preset-standard`. **Its row module is ours**
(`@treeseed/dsh-chapters/preset`, `src/preset.ts`), not the host package: it mirrors the host's plugin line
for line (`inject: ['agentPresets']`, `static [EntryGroup.key] = true` so child `!!js` expressions survive
until the child activates, `[Service.init]` yielding the registry disposer so **Cordis** owns the
registration's lifetime) and adds drop-what-will-not-load. Why not name the host package: one unresolvable
row aborts the plugin tree of a host predating declaration rows, and one unresolvable *child* makes the
whole preset `broken` — measured both ways; our module resolves wherever our package runs, and pruning a
missing child keeps the preset usable instead of declaring it unusable. **The lifecycle is the trap that
took longest**: registering in `apply()` and disposing through `ctx.effect` un-registered the preset the
moment activation finished (`register()` reported success while the roster came back WITHOUT `chapters`) —
same apply-fiber trap r35 caught for the storage domain; a row's own init is the only place with the right
lifetime. **Support floor is 0.2.0** (user decision 2026-10-16): the legacy `.agent-presets` copy, the
`presets/chapters/` tree and `preset-install.test.ts` are DELETED, and a pre-0.2.0 host logs
`this host cannot register preset rows` while its tools keep working. The tape acceptance chain needs
`dev/dsh-host-lock` moved to 0.2.x plus a re-distill. **#54 did the move: the lock now
resolves 0.2.0-rc.2 — chosen by WITNESS (the host this box runs the plugin on), not by npm's
latest — the refusal has lifted itself, and `hostSupportsPresetRows()` is what lifts it (a
version test in `tests/e2e/boot.ts`, because it runs before any host exists; silently skipping
the pins would make every segment pass a run that never exercised the preset).** Three 0.2.x
drifts were found by booting rather than guessing, all rig-side (and a fourth was NOT the host:
the acceptance chain's remaining failure is a **stale tape corpus**, now gated by
`tests/fixtures/model-tape/CORPUS_HOST` — `scripts/corpus-anchor.mjs` refuses replay by name and CI
skips the acceptance job with a tracked reason, issues #56/#57; a gate that blocks `record` too
would strand itself, so record stays allowed), all the kind that yields a
WRONG conclusion rather than an error: the durable log is `session.v4.jsonl.zstd` (five hardcoded
`v3` paths made every log assertion decode nothing and report "the archive never landed" —
`sessionLogFileFor()` resolves the highest now, pinned by a row); the host opens a **Preview
Notice**, a focus trap like the 2026-09-18 `Internal Testing Notice`, and dismissal must target
`[role=dialog]`-shaped elements (matching "any div mentioning a notice" matched the app wrapper
and pressed an unrelated 'Close'); and **provider config rides `cordis.patch.yml`** — a
profile-dir `settings.yaml` is read by nothing on 0.2.x, so without an `llm-pi-ai` block the
host has no `local` provider and the browser opens on "Add an API key to get started" with the
composer never reachable. Distillation no longer needs the GPU box: `E2E_UPSTREAM[_KEY|_MODEL]`
makes the tape proxy translate on the way out while the fixture keeps its pinned model id and a
key-free profile (the tape RECORDS the profile's name — a fixture of this rig, not of the
service that distilled it). Remaining: re-distill all eight legacy projects (the ninth, `prompt`, was distilled ON 0.2.0-rc.2 in #71 and needs no re-record), then a strict replay and a
fresh `coverage:e2e` ledger — until then no browser-plane claim is verified.** Health is still the host ROSTER's answer, asked AFTER activation, plus
`compositionInventory()` rows — **file presence is not preset existence, and "declared" is not "usable"**.
A session's preset id is durable state (`agent-preset/selected`), so an unregistered id makes every session
that chose it fail to *open* (`agent-preset/not-found`) while its log sits there intact — and meanwhile the
plugin boots, registers its tools, and Settings says "enabled and running". Facts with file:line:
`docs/contract.md` § Presets are declaration rows; the gate that turns the next host rename into a red row
instead of a broken user session is `tests/unit/preset-declaration.test.ts` (15 rows, each verified to fail
on the mutation it guards: ralph re-disabled, an unknown pruner key, `toolFilter` restored, `{{cwd}}`
restored, the preset id renamed).
Rounds 23-28 then: E3 measured (per-machine — see the Cache section, never cross the numbers),
`chapters_fork` (r24), the durable title (r25), the 20-check mechanical pass (r26/26b: 18/20 proven
on-scratch, the rest human-only), the target-hardware verdict (r28: zero-token compaction confirmed at
llama.cpp counters, ~2 s steady-state turns), and a full-install product bug found-and-fixed by the
same run — one domain, one opener, `acquireChapterStore` (e0e67d0).
**MVP state: engine + tools + preset verified ON THE REAL MODEL, and the message-level fork AND
continue BUTTONS are shipped and e2e-green** (both rows come from one table + one runner in
`src/client/doors.ts` — adding a third door must extend that table, never copy the body; a test refuses a
second runner) (`conversation.chat.assistant-actions` → `remote.commands` → watermark
fork → `sessions.open` after `refresh`; `tests/{unit,integration,e2e}`, Playwright with
workspace-cached chromium — client-plane facts are now measured, never guessed).
**Long-context mechanics (architecture amendments, 2026-09-19) are BUILT**: arrival-time
artifacting — tool results ≥ `toolResultArtifactTokens` never enter the surface (stub +
content-addressed artifact, queried via `chapters_artifact` toc/search/read; measured: 373KB
book, zero blob prefills, cacheRead monotone across the stub) — and plot carriage (persona
`PLOT:` discipline carried through in-place checkpoints; bounded elicited fallback behind
`elicitedPlot`). e2e is now TWELVE specs in NINE replay projects, each with its own boot (#71 adds the prompt-ghost journey, `prompt` @ 0.99 + NO_AUX_MODEL + E2E_PROMPT=1, scripted-distilled like plans — suite = knowledge-loop +
discovery @ 0.75 of the pinned 32K/15K stress regime; heavy @ 0.5 with the arrival floor OFF —
measured: a floor below the chunk size arrival-stubs the surface and silently prevents
compaction from ever being needed; arrival @ production 0.9 + floor 500; fanout @ 0.75 — the
chains its child sessions write are the deepest on this hardware and must be distilled in
isolation, and its child prompt caps readers at SIX 300-line reads (an uncapped qwen looped
past 30 exchanges; the cap still crosses the threshold inside every child); enrich @ 0.9 with
enrichmentEnabled; rules @ 0.9; fork @ suite pins — carved out of the shared suite boot 2026-09-25
when knowledge's fork child became the SPA's restore target for later specs (the fanout lesson
generalized: one journey, one boot); explore.spec is an on-demand selector-archaeology DEV
project, never in the CI chain) against port-keyed throwaway homes `var/e2e-home-<port>` — the dev
home is SHARED with live agents and must never be the test ledger (FINDINGS 2026-09-19: run 13
asserted against an agent transcript; draft identity, YAML colon-in-plain-scalar, worker-bound
setupFiles, and same-home sibling boots all bit; identity is now verified via localStorage + the
log's own header event). ACCEPTANCE RUNS OFF THE MODEL TAPE by default:
`npm run test:e2e:replay` serves every model turn from `tests/fixtures/model-tape/<project>` (proxy
`tests/e2e/model-proxy.ts`; explore 14.7 s replayed vs 1.7 min live; recorded usage keeps the
token meter — and thus threshold behavior — bit-identical); `npm run test:e2e:record` distills
tapes from the real model (once per scenario; re-record when PRODUCT prompts change —
persona, tool descriptions, thresholds — but NOT the notice: measured 2026-10-11 that no committed tape prefix contains a seeded notice, so notice prose is currently free; that is coverage luck (no journey makes a continuation child speak), not a guarantee. Workspace docs (AGENTS.md itself,
skill catalogs) are masked out of matching by the AGENTS-BLIND rule (user decision
2026-09-20: development artifacts, every real project ships its own — doc edits are
FREE, no re-record; reaffirmed 2026-10-01 with no exceptions: the tapes stand in for
ANOTHER project, not development of this one, so no doc edit — near-threshold
compaction summaries included — ever couples a tape to this repo's docs).
`rm -rf tests/fixtures/model-tape` for a clean corpus. The normalization
pipeline is CLOSED — escape/whitespace classes, volatile rules, tool-result content and
injected instruction blocks matched out; the AGENTS-blind addition was the last change
and required one final re-record; 2026-09-23 added two DERIVED-COUNT collapses to the
same family — `(N est tokens)` in chapter index lines and the char count inside
`⟦omitted:host-injected …⟧` markers (both move with doc/render drift, both identified
already by their line — pinning them made heavy/enrich tapes brittle across builds). Replay chain verified green — ALL SEVEN segments strict 2026-09-25 and — for the first time — GREEN ON HOSTED CI (GitHub Actions, no model, no GPU): the tape is machine-neutral by contract now — injections mask to fixed tokens everywhere (skill catalogs incl. the 'catalog changed' notice), marker RUNS collapse (a dev box injects more spans than a runner), digest message-tallies collapse to <MSGCOUNT> (they count injections), the enricher's input defuses markers before its cap (hosted divergence at char 758), WS-PATH/DSH-CHECKOUT blind the system prompt's identity lines, the sessions-dir slug is COMPUTED from ROOT (a hardcoded /home/adrian one made CI poll an invisible log for 7 minutes per spec), zstd is a runner dep, the host comes from dev/dsh-host-lock's hermetic lockfile (npm global mode rewrites the plugin tree; rc-ranges float), workspaces boot PRISTINE (sessionIds cleared — restore races ended), and an unborn-mirror push is an honest no-op, not local-only (pristine-store discovery: the old knowledge assertion passed only on accumulated dev state). All 464 deterministic + 85/85/85 gate green on the hosted runner too. The `rules` browser scenario was UN-PARKED — the r39 diagnosis: the spec read zstd-compressed session directories as flat files and hardcoded a rule id; the product was always right. The enrich e2e earned its keep: it exposed two real product bugs invisible to every deterministic layer (verify.md T9/T10 — the body-hash anchor convention mismatch that silently blocked enrichment since P2, and the missing host-plane route) (r38 lesson: the DRAFT screen turns composer text into a first MESSAGE, not a command — establish a session before exercising command surfaces; and RR2=137: a chatty live loop that records mid-test can be OOM-killed — keep e2e prompts tool-free in WORDS the model obeys; and 2026-09-23: a tape records the CONTEXT it was distilled in — re-record whole projects, never one spec of a shared boot, and never run two GPU suites at once). 608 unit/integration, zero skips when the TreeDX container is up (live-gate fails loudly when configured-but-unreachable; skips only with no configuration at all), under a GATED coverage ledger: `npm run coverage:ci` (c8 --check-coverage) enforces ≥85% statements/branches/functions/lines in CI — current 97.94 / 86.47 / 93.82; `npm run coverage:e2e` remains the browser-plane ledger (eight replays since the plans journey joined, boot-level V8 profiles remapped through REAL source maps; current 79.92/64.64/76.28 — reported, not tuned; first ledger 80/62 before the audit). The 2026-09-23 coverage audit closed its own gap list the same way: providerKindFor policy rows, credential migration, the git-command surface incl. every refusal text (T13), the TreeDX client's failure vocabulary (timeout/bad_json/envelope), git-plane auth (T11), the push retry/divergence paths, scheduler pull rows, listing pagination over a paginating stub (T12), overlay-delete, rule-number walk-past by prefix (id-uniqueness), the composer busy-retry budget, and the coverage instrumentation itself; then the deterministic plane was swept to the gate — engine-lifecycle (real cordis Context + real base engine: engine.ts 40→91 stmts), the tool wrappers' full success/refusal surface, the TreeDX error taxonomy over stub faults + parser-shape drift via injected fetchImpl, the local-path git transport, host-command error arms, and the pure planners (vocabulary/enrich/indexing/search/arrival/archive) — catching one REAL bug (canonicalizeRemote carried embedded credentials into the project key: same repo with/without creds forked the pool; fixed + pinned). CI/CD shipped 2026-09-24 and went fully green 2026-09-25: .github/workflows/ci.yml (deterministic gate + seven-segment tape-replay acceptance with NO LLM/GPU/key — tape misses fail loud, hosted runs ship diff-dumps sorted by shared prefix) and release.yml (tag = package version → suite-gated npm publish --provenance; NPM_TOKEN strategy chosen, wired for the treeseed-ai org move); the pristine-runner dress rehearsal caught the scaffold-clobbering patch guard, the credential-less-provider death, and the unregistered-workspace home — plus the profile is now built with plain npm (dsh plugin add was a pnpm forwarder — nothing in this repo touches pnpm, and it is not and never will be a monorepo; the host lock is a standalone manifest). docs/development.md § Hosted CI.
Git history was rewritten 2026-09-20 (test-results/.dsh purged, .git 7M→840K) and force-pushed —
clone fresh or `git reset --hard origin/main` after pulling.
**Knowledge layer P1 (record §13) is complete and live-proven**: signatures collect at real
`turn/end`s (r35j), the fork composes topics live (r36 — same-file turns merge, topic changes
split), the index + `chapters_search` + redaction + `/chapters-link`/`/chapters-status` ride a
sync loop that degrades to local-only honestly and rebuilds the mirror on divergence, with the
two-machine exit criterion automated over a real git smart-HTTP remote (integration + the
`knowledge.spec.ts` browser journey). **P2 is BUILT (2026-09-20)**: the idle/after-push
enrichment ladder with validation-before-commit, provenance chains (`generated:` newest-first),
the body-hash guard as the only sanctioned chapter-file mutation, `/chapters-enrich
run|model|report`; shadow-by-default emergent vocabulary writing git-visible `topic-alias`
curation + derived `topics/vocabulary.json`; and index-level fragment stitching (adjacent
legacy fragments cohere into ONE search entry citing all members — nothing merged on disk). Two-machine exit criterion proven — catching r37 on the way: stageAllAndCommit compared the workdir against itself, making modifications to tracked files permanently invisible to commits (additive P1 hid it; enrichment would never have traveled). **P3 is BUILT (2026-09-20, §15 amendment: approval = per-machine curation fact, never a file rewrite)**: write-once proposed rule files, /chapters-rule add|list|approve|revoke, chapters_rule_propose tool, verbatim core block in the continuation notice (byte-identical ABSENT, golden-tested), refuse-with-numbers overflow budget, category-aware search with a per-machine core bonus, and the rules lifecycle proven transport-grade over a real pool with three machines. **P3c — two-tier rules is BUILT, both capture speeds (#50; record §7.1 + §7.3–§7.9, amendments 2026-10-20 and 2026-10-21). Two things remain unverified, for different reasons: the **browser plane** (the host pin moved to 0.2.0-rc.2 in #54 and the boot's named refusal lifted, but the corpus still has to be re-distilled on the new host before ANY browser-plane claim is real — this feature added a tool AND changed the preset persona, both prompt bytes), and **mining quality beyond n=3** — `npm run mining:probe` did run against the real session model (`qwen3.8-flash`, regional token-plan door; the GPU box was unnecessary) on three of this repo's own chapters: 9 rules, 6 stated / 3 inferred, all inferences confined to the chapter with no human text. See `docs/verify.md § Two-Tier Rules` R5 and `docs/backlog.md` 1b/1c.** The hole was concrete, not vague: `planSummarize` composes `leadSections = [planSection, plotSection]`, so a plan survives an in-place compaction and a plot survives it, and a **rule does not**. Session rules (`scope: session`, local, never staged — one filter in `planStoreToRepo`) captured by a deterministic `ADD RULE:` parse at the existing `turn/end` listener (zero model tokens, invariant 1) plus enrichment capture (`rulesEnrichment`, ON) that MINES standing orders the human never said and lets them govern on arrival — `rulesAutoActivate: true` is the default, and the earlier design that required a verbatim human quote before a mined rule could apply was REJECTED by the maintainer and removed (record Amendment 2026-10-21): demanding proof that a human already said it makes the tier redundant with the deterministic marker, and the premise of the tier is that the human may not know. Visibility replaced permission: each mined rule renders with its warrant (`stated by you, mined from ch.N` / `inferred from ch.N — nobody said it`), the agent must NAME the session rules that shaped its reply, at most 3 per chapter plus per-tier display caps, and `reviewOnly` + `approve` is the opt-in review-before-trust posture; `rulesModel` gives mining a model of its own (one extra bounded call, and its answer REPLACES the annotation pass's rules). One auxiliary completion budget, `enrichmentMaxTokens` (default 4000), is the single source for that ceiling on both planes — the route measured here does not enforce `max_tokens` and counts reasoning tokens toward completion usage, so a small number is not safety, it is truncation on a stricter provider. What did not loosen: a session rule never overrides a project rule, and never becomes one without a human. Activation itself is unchanged: **DERIVED** from the ancestor path, never a `curation.jsonl` fact — the 2026-09-20 per-machine approval boundary is NOT relaxed, it still governs the entire shared tier. Rules are carried at the two moments a head is rebuilt — the continuation notice AND the in-place compaction checkpoint (`rulesCarry` is the third lead section in `planSummarize`, and `session-rules.renderRulesBlock` is the ONE builder both paths plus `chapters_rules` call: a source-shape row fails if either door starts picking rules itself) — **never injected per request**: invariant 3, and measured llama.cpp `cacheReuse 0` on a head-position replacement means a churning ruleset is a cache-wipe machine. `chapters_continue` carries both tiers, `chapters_fork` carries project only — the SAME `intent` axis plans already use (`docs/plans-carriage.md` §§ 9–13), not a new distinction. **#52 (same round, second half): rule ancestry ALSO crosses the delegation edge** —
  `session-rules.ruleAncestorSet` walks registry `parentSession` ∪ the kernel header's
  `parentSession`, transitively, READ-ONLY, upward only (a subagent inherits its delegator's orders; a
  child's inferences never govern the parent), bounded at 64 expansions and LOUD when the cap bites;
  every door, the checkpoint and `/chapters-rule active` call that ONE walk, and an anti-drift row
  fails if a plane computes ancestry by hand again — hand-built ancestry is how delegated subagents
  ended up with zero rules. And the `chapters` preset's **persona suffix** is the per-composition
  channel that tells a session — fresh, continued, or delegated — to run `chapters_rules` before a
  task and `chapters_search` for history: that is allowed because it is preset-scoped, not a
  system-prompt contribution (invariant 3), and two couplings are pinned by behaviour: the suffix must
  stay matched by the plot template-echo guard, and it may not introduce a `{{variable}}` the host has
  not registered. Changing that suffix is a PRODUCT PROMPT change — the tape re-distill debt GROWS,
  it does not shrink. Selection is pinned → topicality → index-only, via `rules.selectRules` — the head's selector, deliberately NOT `search.rankEntries`, which ranks the corpus (one implementation of each job, and bending a rebuilt head to read index shards was rejected); per-tier count caps config-driven, and the **withheld count is mandatory** — silent selection would rebuild "lost in the noise" inside the fix for it; the token ceiling still refuses with numbers, never clips. **No global tier was built, because none was needed**: `projectKey` is UUIDv5 over the canonicalized *remote* and `harnessId` defaults to hostname, so checkouts of one repository already share one rule namespace; what that round actually owes is loudness for the four ways the identity silently diverges (record §7.8) — a `path-derived` key, a fork listed first, TreeDX keying on the pool location, and an unlinked/un-synced clone, each of which must SAY it rendered zero rules: `/chapters-status` now prints an `Identity:` line and warns when the derived key differs from the bound one (the repo's own non-git test fixture trips it, so the warning is not theoretical).
  One design lesson from that reversal, because it is the recurring mistake in this repo: a safety mechanism must block the harm, not the value. The quote gate blocked invented rules by also blocking every inferred one; the mechanisms that replaced it (a rendered warrant, the agent naming its rules, caps, one-command revoke) hold the same risk without amputating the feature. Suspicion of model authorship is a reason to make output visible and reversible, not a reason to demand human provenance.
  Two local build facts, both learned the hard way: the deterministic suites need **Node ≥ 24** (`engines`), and on this box's Node 22 every test file fails in a way that looks like your diff; and until 2026-10-21 `npm run coverage:ci` intermittently reddened `git-auth-classification`/`sync-remote` with an EPIPE blamed on their `before` hook — **diagnosed as pre-existing, which was true and not the point**: the test git server wrote request bodies into a CGI child's `stdin` with no error listener, so a child that had already exited raised an async EPIPE nobody handled. Streams are guarded now (three consecutive combined runs: 800 pass / 0 fail). Recording the sequence because the mistake is the reusable part: proving a failure predates your diff is a step, not an answer.
**Knowledge transport is now a provider seam (2026-09-21, record §15: "transport is pluggable; git is one provider" + "host-injected context is not conversation")**: `src/provider.ts`'s six verbs carry every sync path; `kind:'git'` (default, every pre-existing record — zero behavior change) or `kind:'treedx'` (`/chapters-link treedx+<url>/<repo> <token>`, `src/treedx/`: workspace-create → overlay-write → commit transport, `.treedx-state.json` mirror memory). Search/rules/index/notice layers read the materialized mirror unchanged — §3.1 survives both backends; divergence routes through rebuild-from-the-store in both; TreeDX lease contention maps to the existing rejected→pull-retry, moved head to diverged. Contract + truth table in `docs/provider.md`; TreeDX API facts (doc-reads vs live-measured, with corrections) in `spikes/treedx/FINDINGS.md`; dev loop `scripts/treedx-local.sh` + `dev/treedx.compose.yaml` (the cloned repo's own compose is platform-bound and will not boot standalone — measured). Transport-grade proof: 24 tests over an in-process stub (`treedx-{provider,sync,link}.test.ts`); the real-container exit criterion (`treedx-live.test.ts`) ran and PASSED 2026-09-21 (5/5 against a booted dev-auth service; full suite 286/286 zero skips — the live run caught three parser shapes, the born-with-`.treedxkeep` phantom-deletion trap, the lease-survives-TTL close requirement, and a swallowed auth detail, all fixed and pinned). **Re-verification 2026-09-23 caught one more, in the wild:** `paths/list` PAGINATES (limit 100, base64 offset cursor in `page.nextCursor`) — reading one page silently truncated the corpus once the shared dev repo grew past 100 paths (machine B reported 'up to date' while missing real files). `corpusPaths` now follows the cursor to the end; the paginating stub + a 150-file row pin it (T12), and the live container proves it at the real service. **The same round landed the injection screen** (`src/injections.ts`): host-injected context (instruction files, runtime snapshots, skill catalogs, our own TOC notice — event-level and `<system-reminder>` spans inside human messages) is marked-and-counted, never archived; the conversation-bytes guarantee and TOC `(N msgs)` now say what is actually true, and the knowledge corpus carries no project's instruction bytes (H1 rows in `docs/verify.md`).
**Session-plan carriage is BUILT (2026-10-09, `docs/plans-carriage.md`)**: `src/plans.ts` pairs an
`exit_plan_mode` call with the `tool/result` that carries the human verdict (approved / rejected /
dismissed / pending / superseded / failed — the fifth class is the review never opening, which is not a
verdict); chapters carry a `## Plans in this chapter` block AFTER the verbatim transcript with the plan's
outline, bounded head and content-addressed full text; `plan/mode` folds last-value-wins into `planMode:`
instead of falling into `unrenderedSeqs`; the child's notice carries the operative plan (intent-aware
since the second round — see below; a pending one is marked unapproved); plans are forced chapter boundaries in
both segmenters and title the chapter they conclude. Two truths worth keeping: the token meter is NEVER
exempted (the block is counted by `preflight`, and a plan-less path renders zero bytes — which is why all
seven tapes still replay WITHOUT re-recording, verified 2026-10-09), and a plan whose review is still open
sits in an unfinished turn above the archive ceiling, so it is carried as live and un-stored. Fixed on the
way: chapter `artifacts/…` citations pointed at paths `chapters_artifact` could not resolve at all
(`writeArchive` writes inside the session tree; the resolver only looked at the store root) — true for
every deferred blob since arrival-stubbing shipped, now pinned (verify.md P10). The browser plane is IN the chain (project `plans`, verified 2026-10-10); its tape is distilled from
the scripted upstream `tests/e2e/stub-model.ts` because this box's model server drops the stream
mid-turn — read `tests/fixtures/model-tape/plans/PROVENANCE.md` before quoting what it proves (the
carriage yes, a model's choice to plan no). **Second round, same day, four decisions landed**
(`docs/plans-carriage.md` §§ 9–13, verify.md P12–P17):
- **Intent decides what a child is told.** A CONTINUATION (`chapters_continue`) extends the same stream
  of work, so it gets `## Active plan` + `## Previous plans on this path` and, while the parent was still
  planning, a seeded `plan/mode`. A BRANCH (`chapters_fork`, the fork button) splits a new direction, so it
  gets **zero** plan bytes — its plans are history, in the cited chapters and as documents.
- **A plan is a document of a third kind**: `kind: plan`, written in `chapters/` as `plan-NNN-<slug>.md`
  with its own registry counter (`nextPlanNumber`, allocated through the registry — never a directory
  scan), so it never consumes a chapter number, is carried by the pool transport and the mirror rehydrate
  for free, and is findable with `chapters_search` **as a plan**. Superseding writes a new document; the
  old one keeps its bytes.
- **The enrichment ladder never touches a plan document.** Directives are not narrative; paraphrasing an
  order is the drift this store exists to prevent. The guard reads the file's own frontmatter.
- **The operative plan is carried into every in-place checkpoint** (the plot mechanism, but chosen
  session-wide and newest-first), bounded, with truncation announced.
- **Findability round (0.1.12, `docs/plans-carriage.md` § 14, knowledge-repo Amendment 2026-10-11): two
  doors, ONE scorer (`search.rankEntries`) — the pool mirror when pulled, the workspace store otherwise
  (and as a fallback when the pool has no match). A bare workspace used to answer `chapters_search` with
  "link a remote" while its own chapters, `kind: plan` documents and rules sat two directories away; that
  was the flaw the audit found. The answer must NAME ITS DOOR ("searched this machine's store, N docs …")
  so "this machine only" is never read as "the whole project", and "nothing matched" ≠ "nothing archived
  here" are reported apart (`documents`/`empty`). Artifacts are never indexed (they answer to
  `chapters_artifact`; a second index is forbidden). The notice gains `## Finding things` naming
  read/chapters_artifact/chapters_search (`retrievalHints`, default on) because an unmentioned tool does
  not exist to a small model. Two pinned rows asserted the old contract and failed loudly — that is why
  this is a fact rather than a guess; amended with the reason in the diff.
- **Kernel-drift gate (`tests/unit/host-seed-contract.test.ts`)**: the seeded `plan/mode` depends on the
  host knowing the type and treating it as NOT surface-eligible. Read the kernel's OWN exported predicates
  (`KNOWN_SESSION_EVENT_TYPES`, `isSurfaceEligibleType`, `isAppendSurfaceEvent`), never reimplement them —
  a kernel change that silently ungates a child must show up as a red row, not as a passing suite.
- **Two deterministic doors, one builder (`/chapters-fork`, `/chapters-continue`)** — the load-bearing
  lesson of attempt 5: **a tape cannot carry a model-authored range.** The recorded `chapters_continue`
  said `endSeq: 30`, the runner's ceiling was 29, and `validateRanges` refused it — correctly. And a small
  local model will not reliably chain `chapters_segment` → `chapters_continue` at all. So anything that must
  be accepted repeatably goes through the plugin's OWN derivation (`deriveRanges`/`composeChapters`, zero
  model involvement); the tool remains for the model's use but is never the only proof path. Both doors come
  from `deterministicCommand(door)` and a row pins that they **archive identically** (same ranges, titles,
  plan facts) — two implementations would drift. `intent` is the ONLY semantic difference: continue ⇒
  `## Active plan` (+ seeded `plan/mode` while still planning); branch ⇒ zero directive bytes.
  Also measured there: **the turn containing a plan submission does not end until the review is answered**,
  so a session whose only turn is pending has no archive ceiling and the door refuses with its first guard.
- **The one exception to the injection screen**: the harness's `plan-mode` + `form:'notice'`
  mode-flip sentence archives verbatim (named by producer AND form, so it cannot widen — v3 wrapper
  `{kind:'plugin', plugin:'plan-mode'}` and v4 `{kind:'plan-mode'}` both match, issue #43).
  `isHumanAuthored` stays strict on purpose — it drives topic signatures, and the r28 lesson was that
  injected text moves chapter boundaries.
**Outstanding: the human verification rows (live `/compact` in a real browser, readability
judgment), the seeded-gate case OBSERVED in a browser (pinned deterministically; needs a second distilled session — `docs/plans-carriage.md` § 15), per-message anchoring (the button forks at the conversation's end today; `deriveRanges`
already supports any anchor), and the default-preset shipping policy (opt-in menu vs profile
default), which is the user's call, not ours.**

The fiber-eviction trap `dsh-session-fork/src/branch.ts:10-14` warns about did **not** bite — an unattached
session was the whole explanation for round 6's "not listed", fixed by
`workspaceRegistry.createCanonical(cwd)` → `workspace.attachSession(id)`.

**Cache behaviour measured (rounds 10-11, 13, 16, real provider).** A continuation builds its own cache —
0% hit cold, 74% warm — and the parent keeps hitting across the boundary, so **G3 and G2 are green**. G1's
head is now *measured* for the composed shape: r16's `setup`-mounted child's first request was **13,315
tokens (27-tool header, this roster)** — quote the older "≈ 8K" only as a projection. Steady state it
protects: 396,800 cached + 822 uncached (**99.79%**) live session. E3 measured — and it is
per-machine (r23/r28): on the cloud provider a replacement keeps ~7.4K of prefix cached (refill
halves, 13,658 → ~7,000); on llama.cpp (the target) the slot reuses NOTHING across a head-position
replacement (cacheReuse 0) — the local win is zero-token compaction (r28: 0 prompt tokens vs ~11 min
for an LLM summary on that box) plus ~2 s steady-state turns. **Never quote one machine's cache
number for the other.**

Metric formula, since getting it wrong produces 1721% hit rates: `totalPrompt = inputTokens +
cacheReadTokens`; `hit = cacheReadTokens / totalPrompt`. Judge "cache undisturbed" by
`cacheReadTokens` not collapsing, **not** by hit percentage, which falls innocently as the prompt grows
past a cache-block boundary.

Phase 1 follow-ups CLOSED: the title call is the *service* (`sessionController.rename`, live-handle
window — r25 durable), and the preset/composition note in invariant 2 ships in every child.

Coexistence with `dsh-session-fork` is currently **untestable, not disputed**: the shipped example fails
to boot the installed host ALONE (its rc.2-era code vs rc.1's `webServer` inject requirement — verified
by pair-boot then solo-boot, r26). Name-spaces are disjoint by inspection; re-run the pair-boot on a
version-matched host before claiming either way. The dev/test loop that avoids restarting the harness
being edited from is solved — see [docs/development.md](docs/development.md).

Then [docs/contract.md](docs/contract.md) for how to declare things, and
[docs/verify.md](docs/verify.md) before claiming any step passes.

## Round: the bar renders, and the chain went green locally (2026-10-26/27, host 0.2.0-rc.2)

Measured, in the order the evidence arrived:

- **`prompt` and `prompt-off` pass in Chromium**, in record and in strict replay: the docked row mounts above
  the composer at order 30, shows `Analyzing`/the offer, expands, drafts-or-explains, and Run reaches the
  durable log as a user-role message. 10-project chain `E2E_MODEL=replay npm run test:e2e` → **EXIT=0**
  (`suite` 4 passed 39.8s, `heavy` 1.8m, `arrival`, `enrich`, `fanout`, `rules`, `fork`, `plans`, `prompt`
  4 passed, `prompt-off`). `coverage:e2e` → **EXIT=0** on the same build.
- **Four causes, all found by measurement after a wrong theory each time.** (1) The tape proxy joined
  `…/compatible-mode/v1` + `/v1/chat/completions` into `/v1/v1/…`, so nine legs had no assistant row at all.
  (2) `off` meant disabled, empty, and broken at once; `idle` split them apart. (3) A per-turn
  `Elapsed since the preceding model-visible message: …` line was unmasked, so replay diverged from record by
  one character of punctuation. (4) `prompt`'s failure was a React **#310 hook-order crash** — a hook I added
  sat below the component's early `return null` — and it *looked* credential-dependent because the credential
  changed when the row's visibility transitioned. The journal's silence (zero `MISS tape=prompt`) is what killed
  that theory in front of the evidence.
- **Rig honesty landed too:** a strict-replay `MISS` is now fatal for the leg that produced it, with a byte
  baseline so it cannot blame another leg's history; the proxy falls back to an ephemeral port rather than
  dying on an orphan; `applyRigEnv` and `rigEnv` became one derivation (mutation-proven); a missing profile
  patch throws instead of being skipped; the chain-coverage row is mutation-proven and caught
  `--project=prompt-off` substring-matching `--project=prompt`.
- **Still open, named not smoothed:** CI's acceptance job is red while the local chain is green and its
  annotation carries no verdict lines (repro running); Autorun's idle edge is **unwired** — `useSessionStatus`
  is documented in the dock's prop list but calling it failed twice, so the gate keeps `running` undefined and
  Autorun says it is unavailable, which means objective item 3's "Autorun displaces the goal" pixel is not yet
  shown and item 4 remains unit-covered only; and the `prompt` tape is 546 entries / 12 MB, needing a cap.

### 2026-10-27 — the three bullets above are now superseded, item by item

- **Autorun's idle edge is wired, and the browser says so.** The dock was being handed `useSessionStatus` — a
  `SnapshotSelectorHook`, so calling it with a session id made the host use a string as a selector and it threw
  `TypeError: l is not a function`. The signal the legs needed was on a different prop all along: `useSession`'s
  snapshot carries `running`. Wired through an identity selector folded by `deriveRunning` (unknown ≠ idle), the
  leg now asserts arm-ability and passes: `prompt` 4 passed in Chromium, model-free replay, twice (distill and
  replay). **What is still not shown is the displacement pixel** — Autorun superseding a goal's continuation — so
  objective item 3 remains partly open and item 4 is still unit-covered only.
- **CI's acceptance annotation carries its verdict now,** and the failure it names is not a tape fault:
  `MOUNT FAULT: the session registered none of the core tools every journey needs — missing: bash, read, edit,
  write (declared=44 registered=7 …)`. Root cause found by measurement, not argument: the booted profile's preset
  names 28 `@deepseek-ai/*` plugin packages, none of which is a dependency of this repository, so a development
  host resolved them out of `~/node_modules` and a CI runner resolved nothing and our preset silently pruned 21
  tool rows — 34 tools here against 7 there, and message 0 is the tape key. `linkPinnedToolPackages()` now links
  the pinned install into `node_modules/@deepseek-ai` **before** the host spawns (never replacing what the repo
  already installs), and the CI-shaped clone measured `tools=7 / chars=2880` → `tools=34 / chars=7378`. Provisioning
  bubblewrap and lifting the AppArmor userns restriction were tried first and are recorded as NOT the cause, each
  refuted by the runner's own artifact.
- **The `prompt` tape is 14 entries, not 546.** The bloat was repeated distills accumulating in a directory the
  ad-hoc loops never cleared; `distill-tapes.sh` clears per project, and the corpus is re-anchored on the capped
  build with `CORPUS_HOST` stamped (`lib=fcd1e375bab82d3d`, `distilledAt = 2026-10-27`), strict chain green twice
  locally at that point. Later the same day the pin-link change invalidated those captures and the corpus was
  restored to the stamped state rather than left mixed — recorded here because "green" has to name the build it
  belongs to.
- **New, still open, and named:** #128 (our typecheck passes against harness types a release line behind the pin —
  four sites pass `source.kind: 'plugin'`, which 0.2.0-rc.2 rejects; and `package.json` 0.2.0 vs lock 0.1.22), and
  #129 (`globalSetup` boots one server from the setup process's env while Playwright applies project env to
  workers, so a multi-project run shares a boot and a home; `scripts/chain-replay.sh` now runs one boot per
  journey, and tightening session discovery to the preferred workspace fixed `prompt`'s `identity mismatch`).

### 2026-10-28 — two product defects closed, and acceptance narrowed to one coupling

- **#131 — artifacts were unreachable.** Arrival-time deferral was applied to `chapters_artifact`'s own output, so
  asking to read a stored blob returned *another* pointer to another blob. Found in the leg's durable log (20 tool
  calls, 17 erroring/looping) after three of my own wrong diagnoses (trigger margin, aux turn, haystack size).
  Exempting artifact answers fixed two legs at once: `arrival` 8 entries and `fanout` 41 captured green, each
  replaying green alone. Filed with repro; credit matters — both looked like model flakiness for a day.
- **#113 — the Autorun button refused its own click.** The dock dispatched local state and then `refresh()` re-read
  the server and flipped the label back; `off` two lines below sent its command correctly, which is how the
  asymmetry showed. Fixed, guarded by `prompt-dock-autorun-write.test.ts` (red first; the property form survived
  my `[^}]*` mistake). **Displacement is now observed in Chromium**: with a goal armed the host offers `Pause
  goal`; clicking Autorun leaves `Autorun off` in place, the host flips to `Resume goal`, `Pause goal` disappears.
  Recorded under the real provider, replayed model-free twice at 5 passed. That closes item (3)'s last sub-claim
  and gives item (4) a browser-level half — goal-off restoring a suggestion is still unit-only and still unclaimed.
- **#129's remaining acceptance gap is one coupling, named.** `#arrive` runs only at the head of the relief entry
  points, so `auto: false` disables deferral with relief, and leaving it on makes deferral depend on when a
  threshold crosses on that machine's header bytes. Every remaining CI divergence has the same fingerprint: a
  checkpoint notice where the other machine has a plain message, or a history one message longer. `heavy` and
  `fanout` are that, not separate mysteries. The clean fix conflicts with "no second automatic engine timing of our
  own", so #132 carries four options with costs and a recommendation; the decision is the maintainer's.
- **Numbers on this branch right now:** plane 1,114/1,114 with 0 skipped; `typecheck` and `typecheck:client` 0;
  `typecheck:e2e` at its 68 baseline; full one-boot-per-journey chain green ten-for-ten twice (`AR=0`, `A2K=0`);
  fresh `coverage:e2e` 78.31% (`CVA=0`), stamped `lib=081a726aca738d02`-era corpus. CI: deterministic job green,
  acceptance red on `heavy`/`fanout` after `arrival` and `prompt` were fixed — four legs to two, both locally and on
  the runner. #127 unmerged behind that gate; `0.2.2-dev.1` unpublished.
- **Corrections I made to myself in the open** (each with its evidence in git): the `noAuxModel` "inert key" claim
  (it is a rig alias for `auto`/`elicitedPlot`, which the host does read), the fold that broke a green leg, the
  pin attribution that the pre-change logs disproved, and the `limit 5000` prompt that made a leg depend on a
  rejected call — the last one was a real bug and its fix is what took `arrival` off CI's failing list.

### 2026-10-28 — the acceptance pipeline went green, and the branch is on staging

**Run 40676609079**: deterministic ✅ · pinned-host preset-rows probe ✅ · **acceptance ✅ — ten legs `ok`, each on its own boot**: suite, heavy, arrival, enrich, fanout, rules, fork, plans, prompt, prompt-off. PR #127 squash-merged to `staging` as `45dd4ac`; #56 closes with it.

What it took, in the order the layers came apart — each fixed by measurement, never by masking:

1. **The proxy join** (`/v1/v1` → 404 → no assistant message) that had nine legs failing on provider wiring.
2. **The runner assembled 7 tools where a dev host assembled 34** — 28 preset rows naming packages that are not this
   repo's dependencies, pruned in silence. `linkPinnedToolPackages()` before spawn, plus the `MOUNT FAULT` abort that
   replaced masking. Refuted along the way, with evidence: bubblewrap provisioning, AppArmor userns, credentials,
   installed bytes, profile rows, config keys.
3. **One boot served ten projects** — `globalSetup` boots from the setup process's environment while project `env`
   reaches workers only. `npm run test:e2e:replay` is now one journey per boot, which is also how tapes are recorded.
4. **#131, the artifact cycle** — `chapters_artifact` answers were themselves arrival-stubbed, so a stored blob
   answered with a pointer to another blob and the store was unreachable at exactly the sizes it exists for. Two
   legs' week-long "flakiness" was this one defect.
5. **Turn count, not timing** — the last misses were legs whose journey length was the model's choice. Bounding them
   (`fanout`: one decisive oversized read per child; `arrival`: one read plus ≤2 artifact queries; `heavy`: three named
   600-line pages) is what made them portable, and bounding `heavy` correctly required learning that **the read tool
   caps a call at 600 lines** — measured on both machines — which is what made the old fixture's marker pigeonhole work
   and my first "three reads of 2000" bound unsatisfiable.

Five claims I published and then retracted the same day, each caught by a test or by a byte rather than by
reflection: the "nearest-prefix serving" matcher theory (`findReplay` requires equal length), the 38× title-call
signal (a cumulative journal read as one run), the duplicate `<DSH-CHECKOUT>` blind (raw dumps diffed before
normalizing), `noAuxModel` as an inert key (it is a rig alias for `auto`/`elicitedPlot`, which the host really
reads), and the folding of injected instructions out of matching (it collapses positional prefixes and mis-serves
turns — the row system refused it, and the honest fix was to stop injecting a development doc into acceptance).

**Still open, unsoftened:** #126 (a dock cannot write the composer on 0.2.0-rc.2 — click-to-draft shows a refusal and
Run submits), #128 (harness devDependencies lag the pinned runtime; 4 sites pass a retired `source.kind`), #130 (a
boot hang when plot elicitation is off while relief declines — user-reachable from config), and the goal-off
restores-a-normal-suggestion half of the interplay, which is unit-covered and **not** claimed from a browser.

### 2026-10-28 (later) — the goal-off browser leg withdrawn after four failed captures; the claim returns to unit-only

PR #136 is closed **unmerged** and the tree is byte-identical to the state CI proved green (spec back to the five
merged tests, `prompt` tape back to 24 files, stamp `lib=b67e373defcad83a`, `corpus:check` agreeing; isolated replay
`5 passed`, plane 1,115/1,115, `typecheck:e2e` 68 baseline).

Four attempts at the goal-off leg, four different failure classes — recorded because each one is a general trap:

1. `Clear goal` **button** after a turn → CI diverged at `msg32`: a `<goal_round>` where the capture had the human turn.
2. `/goal clear` immediately, no turn between → CI diverged at `msg12`: runner `Round: 3/256`, capture `Round: 4/256`.
3. Poll until a round appears, then act → still diverged. The structural reason I had missed: **a goal round is itself
   a turn, and every turn ends**, so rounds self-sustain — the resulting tape held `Round: 12/256`. Click timing
   cannot race a loop that schedules itself, and there is no rig knob (the human `/goal` takes no round argument;
   `goal-round-driver` has no config block).
4. Bound it with the product's own rule — instruct the model to call `create_goal(max_goal_rounds: 1)` and wait for
   the quiesced `Round: 1/1` → capture failed at `the host goal bar appears once a goal exists`: the model answered in
   prose instead of invoking the tool.

Attempt 4 is the one that settles it. A browser leg whose *setup* requires a small model to cooperate is encoding luck
into the tape, which is exactly what #132 and #135 keep charging this corpus to stop doing — so the leg does not ship
until its setup is deterministic without asking the model. What survives the exercise is a rig rule worth more than the
test (#135's entry in the rig list): **a tape may carry a background mechanism's output only when that mechanism has a
state it cannot leave.**

Site §28 and the interface lock are unchanged, because neither ever claimed the goal-off pixel; AGENTS.md now states
the half that is unit-covered and is not browser-claimed. `heavy`'s 600-line page fix, the prefix-symmetry fix and the
rest stay as merged — they are green on the runner.
