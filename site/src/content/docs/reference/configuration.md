---
title: "17. Configuration"
description: Every knob, which plane it lives on, and the one rule that ties them together.
lastUpdated: true
---

No hardcoded tunables anywhere the harness can configure them. The table below is the complete host-plane list (the `config` schema in `src/index.ts`); the comment header of the shipped `cordis.patch.yml` (inside `node_modules/@treeseed/dsh-chapters/`) mirrors the schema and is the in-repo reference, but this page is kept current with the code.

**Two planes.** `config` (below) is the *host plane* — your profile's plugin entry. The compaction *engine* lives on the *realm plane*: the `chapters` agent-preset row (the `preset-chapters` declaration row at the foot of the bundle's `cordis.patch.yml`, mounted by `src/preset.ts`), which owns `thresholdRatio`, `retainRatio/retainTokens`, `maxTokens`, `compactionRetries/maxOverflowRetries`, `summarizationProvider/summarizationModel` (legacy override), `enrichmentTrigger` (`afterPush|idle|both|manual`), `elicitedPlot`, and `toolResultArtifactTokens`. Shared names behave per plane — design record §12.

The `#50` rule keys below are declared on the **host plane** only; the three the compaction checkpoint
also needs (`projectRulesDisplayCap`, `sessionRulesDisplayCap`, `rulesRelevance`) are *mirrored* into
the engine's `chaptersConfig` the way `elicitedPlot` and `enrichmentEnabled` already are — one
declaration read by both planes, so a head rebuilt by either path selects the same rules.

| Key | Default | Meaning |
|---|---|---|
| `harnessId` | hostname | this machine's identity: commit author, curation partition, rule authorship |
| `knowledgeRemote` | `''` | pre-bind an upstream (else `/chapters-link`) |
| `knowledgeProvider` | `auto` | transport policy: `auto` dispatches on the remote scheme (`treedx+` → TreeDX, else git); an explicit `git`/`treedx` must match the scheme or the link refuses |
| `projectKeyOverride` | `''` | wins over the remote-derived project key |
| `syncDebounceMs` | 30000 | coalesce window for post-archive pushes |
| `treedxFetchTimeoutMs` / `treedxWorkspaceTtlSeconds` / `treedxLeaseRetries` / `treedxLeaseRetryDelayMs` | 15000 / 900 / 3 / 1000 | TreeDX transport tunables (fetch timeout, workspace TTL, lease retry count and delay) |
| `enrichmentEnabled` | true | **false makes the whole P2 ladder a pure no-op** — corpus stays fully working |
| `enrichmentModel` | `''` (conversation route) | the annotator override |
| `enrichmentMaxTokens` | 4000 | one auxiliary completion budget (annotation, mined rules, the conflicts report). It has to cover **reasoning** tokens, not just the visible answer — measured mining usage ran 1.1K–3.2K per chapter. The route used here ignores `max_tokens`, so this is headroom for providers that don't rather than a live limit |
| `enrichmentIdleMs` / `enrichmentBatchCap` | 60000 / 5 | idle trigger; chapters per drain |
| `vocabApply` | false | shadow (default) vs git-visible topic curation |
| `vocabCoMin` / `vocabOverlapMin` | 3 / 0.5 | trust thresholds for emergent vocabulary |
| `coreRulesBudgetTokens` | 1200 | the CORE RULES block in notices — **refuses with numbers, never clips** |
| `rulesCoreBonus` | 0.15 | per-machine rank bonus for core-approved rules |
| `sessionRulesEnabled` | true | deterministic `ADD RULE:` capture into the local session tier — zero model tokens, never staged to the pool |
| `rulesMinedPerChapter` | 3 | cap on mined rules per chapter; the cap counts rules **written**, so a duplicate cannot consume a chapter's budget, and 3 is the ceiling on what any one archived chapter can teach the session |
| `rulesMarkerPrefix` | `ADD RULE:` | the capture marker; matched at line start in **human-authored** messages only, so prose that merely mentions it is not a rule |
| `rulesEnrichment` | true | model-derived capture: the enrichment pass mines standing orders from each archived chapter, idle-batched, never per-turn |
| `rulesAutoActivate` | true | whether a mined rule governs on arrival. It does by default — inferring what nobody said is the tier's purpose ([#50, Amendment 2026-10-21](https://github.com/treeseed-ai/dsh-chapters/blob/main/docs/knowledge-repo.md)). Off ⇒ mined rules are written `reviewOnly` and stay inert until you `approve` |
| `rulesModel` | `''` | `'provider/model'` for a **dedicated mining model**: one extra bounded call per chapter, and its answer replaces (never supplements) the annotation pass's rules. `''` ⇒ mine inside the enrichment call, at no extra cost. Runtime: `/chapters-rule model p/m` |
| `projectRulesDisplayCap` / `sessionRulesDisplayCap` | 12 / 12 | per-tier count caps on rules rendered into a rebuilt head — anything dropped is **announced by count**, never silently clipped |
| `rulesRelevance` | true | topic-overlap selection on (`search.rankEntries`, the same scorer as `chapters_search`); off ⇒ deterministic category→id order |
| `promptModel` | `''` | the model that **defines** the next work ([§28](/concepts/prompt-recommendations/)). Empty ⇒ the feature does not exist — zero calls, zero surface. Setting it (here, or at runtime with `/chapters-prompt model p/m`) **is** the enable: one knob, no second boolean to drift |
| `promptContextChars` | derived | budget for the suggestion input; **model-derived by default** — `contextWindow × promptContextRatio` at 4 chars/token when the prompt model is set via `/chapters-prompt model`, this key is the fallback when no window resolves, and the command stores an explicit pair beside the model when given numbers (#188) |
| `promptContextRatio` | 0.5 | share of the model's context window the derived budget takes — one rule, budgets 30× apart between a 32K and a 1M model |
| `promptMaxChars` | 4096 | cap on the recommendation (raised from 240 by #188 — a cap that cannot carry a paragraph cannot carry an instruction; settable beside the model). An over-cap answer is retried **once** with the cap restated, then refused — never truncated |
| — | — | all three model keys take a `provider/model` route — `/chapters-models` lists the exact identifiers this host accepts, their context windows, and each key's current value (#173) |
| — | — | `/chapters-rule conflicts` has **no key of its own**: it runs one bounded stream call on the conversation route the session already has, **report-only**, never edits a rule. No route ⇒ the verb refuses honestly |
| `continuationBudgetRatio` | 0.25 | TOC + note share of the window *remaining after the header* |
| `chapterTokenTarget` / `chapterLimit` | 8000 / 8000 | soft per-chapter size / hard split |
| `mergeThreshold` | 0.3 | turn→chapter topic-merge τ (archive-time only) |
| `subagentAutoSave` | true | archive a subagent's completed turns into searchable chapters when its run settles (every settlement of a continuable child; the watermark makes repeats save only what is new). Save-only — creates no session, compacts nothing; enrichment is queued, never run per child. `false` unregisters the behavior entirely |
| `planInlineChars` | 900 | verbatim plan characters printed in a chapter's Plans block — the plan's **full** text is always an artifact, so this is display economy, never a data decision (`0` = pointer only) |
| `plansInNotice` | true | carry the plan block into a child's notice; renders **zero bytes** when the path holds no plan, so tape neutrality is the default |
| `planSeedMode` | true | seed `plan/mode {active:true}` into a **continuation** child when the archived span was still in plan mode, so the gate survives the boundary (measured: kernel accepts the two-event seed, the host's own projection folds it). Never for a branch, never after an approval — approving a plan exits plan mode |
| `plansInCheckpoint` | true | carry the operative plan into every in-place compaction checkpoint, the way the plot is carried — because shadowing can hide the chapter that holds it |
| `planCheckpointChars` | 1600 | how much plan text a checkpoint carries; the archive keeps all of it, and a truncated carry says so in the text |
| `retrievalHints` | true | put `## Loudness (issue #61)

| key | default | what it changes |
|---|---|---|
| `diagnosticsLog` | unset → `<store-root>/diagnostics.log` | where refusals, deferred finalizations and door failures are appended. `DSH_CHAPTERS_ENGINE_ERRORS` overrides it; the literal `off` disables file logging (the profile logger still gets them). Before this, an unset variable meant **no trace on disk** — and three real compaction failures left none. |
| `warningsDisplayCap` | 6 | how many warning TEXTS a door prints before switching to `…and M more`. Counts alone hid 86 warnings across six saves, including the one that named a hollow chapter. |
| `segmentCandidateCapTokens` | 4000 | the ceiling on the oversized-result candidate list `chapters_segment` returns. Ranked by size, and the response always names what was withheld. |

## Finding things` in the child's notice — the three lookup verbs (`read`, `chapters_artifact`, `chapters_search`). Off ⇒ the notice is byte-identical to the pre-hint shape |
| `callArgArtifactTokens` | 0 (off) | above this, a tool-call *argument* is artifact-backed and the inline text is a bounded head. Off by default on purpose: switching it on changes chapter bytes wherever a `write` carried a whole file, which means your model tapes need re-recording |
| `toolResultDeferFloorTokens` | 200 | archive-time inline/defer floor (realm `toolResultArtifactTokens` is the *arrival* floor — keep it **above** your chunk size: below it, stubs hide compaction and thresholds silently stop firing — measured) |
| `artifactStoreRoot` | `.dsh-chapters` | workspace store (must be `read`-reachable) |
| `noticeIndexCap` | 6 | how many chapter lines the continuation notice lists; `0` lists every one. Past the cap the notice says so and points at `chapters_search` — nothing is dropped silently. The point is SIZE stability: an uncapped list grows ~120 chars per chapter, so the surface crosses the compaction trigger at a different turn on each run, which makes a boundary-sitting journey impossible to capture as a replayable tape (#56) |
| `installChaptersPreset` | true | **inert since 0.1.18** — the preset is the `preset-chapters` row in the bundle patch; `disabled: true` on that row is the switch. Still accepted so an older profile patch parses |
| `compactionThresholdRatio` | 0.9 | **inert since 0.1.18** — it is `thresholdRatio` on the preset's `chapters-engine` row now (see [§17](/reference/configuration/) notes on the realm plane) |
| `fallbackPreset` | `chapters` | mounted for children when the caller's preset can't be resolved |
| `searchDefaultMaxTokens` | 400 | `chapters_search` result-packing budget |

Read the row values, change what you own, restart to reload. Next: [18. The continuation notice, annotated](/reference/notice/).
