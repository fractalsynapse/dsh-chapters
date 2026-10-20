# Knowledge Repository Design Record

The governing design for the **git-based shared knowledge pool**: multiple DSH harness instances,
on multiple machines, feeding and searching one private per-project repository of past
conversations — chapters, artifacts, a topic index, and rules — while keeping every individual
session's context small. Written to *govern*: implementation plans derive from this file, and
amendments are human decisions recorded in git history (see **Amendments** below).

Status: **agreed 2026-09-17, pre-implementation.** Phased build in §13.

## 0. What this is, and what it is not

**What it is:** the plugin's existing artifacts (chapters, deferred tool results, the TOC
continuation mechanic) become the contents of a private repository per project, synced across
every harness the user connects to it — over **pluggable transport**: a git repo (§3, the
default) or a TreeDX service (`treedx+…`, Amendment 2026-09-21, transport). Compaction and forking remain the
*knowledge generators*; the repo is the *transport and the shared corpus*. Agents gain one
new capability: search and load of past work across their own and other machines' sessions,
plus a bounded set of
human-approved rules to live by.

**What it is not:**

- Not a general vector store or embedding search. Scoring is deterministic and inspectable (§8).
- Not a system-prompt injection channel. Rules enter context only through the continuation
  notice (§7) — per-continuation, budgeted, append-only — never as a contributed header section
  (invariant 3, `AGENTS.md`).
- Not a rewrite of what shipped. The MVP loop (engine, registry, TOC continuation, fork button)
  is the foundation this record extends; §1 lists the invariants that must survive the extension.
- Not real-time collaboration. Sync points are deliberate (§5); the repo is a pool, not a shared
  live document.

## 1. Invariants the extension must not erode

Carried from `AGENTS.md` and this project's measured history, restated because the knowledge
layer tempts each one:

1. **The compaction/fork critical path stays zero-model-token.** Model enrichment is strictly
   post-archive, async, optional (§6). A fork must remain instant even when the model is down,
   busy, or slow — the deterministic path is the product; enrichment is garnish.
2. **Refuse with numbers, never truncate.** Applies to the rules core set rendered into the
   notice (§7) and to search output packing (§8): over budget → refuse/explain with the
   measured numbers, or the user curates; silent clipping is banned.
3. **The local store is append-only.** Chapters are never renumbered, rewritten, or
   re-chaptered after archive. Composition must be right at archive time (§4); enrichment can
   relabel, never re-chapter.
4. **Model proposes, plugin commits — extended.** The model proposes topics, summaries, and
   rule text. The plugin owns the canonical vocabulary, the index, and rule status (§6, §7).
   The model never writes to the repo directly; the plugin is the only writer.
5. **Per-machine write namespaces.** Two machines never write the same file. Zero merge
   conflicts by construction, not by hope (§3.3).
6. **Budget the added context, never the corpus.** Continuation notices stay O(1) in corpus
   size (§7.3). The corpus grows without bound; the head it pays does not.
7. **Verbatim stays verbatim** except the redaction carve-out (§9) — and the carve-out is
   credentials-only, marked, and deterministic.

## 2. The knowledge repository

### 2.1 One private repo per project, user-created

The user creates a private repository per project and registers it with
`/chapters-link` (four modes, live): **no args** shows the upstream + mirror state,
**a local path** binds a directory upstream, **a URL + token** binds a network git
upstream, **`treedx+<url>/<repo>` + token** binds a TreeDX service (managed repository
resolved-or-created by the link itself — the explicit human act; §15.1).
Profile config (`knowledgeRemote`) supplies the same URL as a lazy default; it never
creates anything by itself. A personal cross-project repo is the *user's* choice of an
additional project entry, not a built-in mode.

Per-harness credentials are **scoped, revocable tokens limited to that repository** —
deliberately better than SSH deploy keys: revocable, per-repo, no shell access.
**Credentials are mandatory for network upstreams** (loopback exempt, so local test
forges work) and **never needed for local-path upstreams**. Storage is under the DSH
home — `<DSH_HOME>/dsh-chapters/credentials/<projectKey>`, 0600 — never the project
tree: the workspace is the agent's reading room and only the plugin touches the token
(a same-uid hygiene boundary, not a cryptographic one; the hard guarantee is that no
code path ever echoes it into a context).

Why per-project: natural secret boundary (§9), natural permission boundary, and the
`projectKey` (§2.3) is what keeps a small model's session from wading into a foreign corpus by
accident.

### 2.2 Repository layout

```
<knowledge-repo>/
  project.yml                  # projectKey, slug, created-by, created-at  (plugin-maintained)
  chapters/
    <projectKey>/
      <sessionId>/
        <chapter-file>.md      # frontmatter + verbatim body (today's format, §2.4)
  artifacts/
    <projectKey>/
      <sha256-prefix>/<sha256> # deferred tool results, content-addressed (today's format)
  collections/
    <projectKey>/
      <sessionId>.jsonl        # per-turn signatures, one line per completed turn (§4.1)
  index/                       # LAYER 2 — derived, plugin-built, do not hand-edit (§10.2)
    <topic-shard>.md           # one shard per canonical topic, alphabetical
    manifest.json              # build manifest: file hash → last processed state (§10.2)
  edits/
    <harness-id>/
      curation.jsonl           # LAYER 1 — per-machine editable index facts (§10.1)
  rules/
    <projectKey>/
      <rule-file>.md           # rules-as-chapters: kind: rule (§7)
  topics/
    vocabulary.json            # plugin-owned canonical vocabulary + aliases (§6.3)
```

Machine-specific and derived state lives in machine-namespaced or manifest-tracked files (§10);
human-meaningful content (chapters, rules, vocabulary) is globally readable and git-diffable so
the user can see what any harness decided and revert it.

### 2.3 `projectKey`: UUIDv5 over the normalized remote

The key must be **identical on every machine** for the same project — that is the whole point,
since local paths differ (`/Users/adrian/repo` vs `/home/adrian/Projects/repo`).

Canonicalization, exact:

1. Take the project's git remote URL (`origin`, first if several).
2. Lowercase.
3. Normalize form: strip `https://` and `ssh://` schemes; convert `git@host:org/repo` →
   `host/org/repo`; strip trailing `/` and `.git`.
4. **Keep the host.** Two hosts, same path = different projects.
5. `projectKey = UUIDv5(NAMESPACE_OID, canonical-string)` — standards-based, deterministic,
   name-derived; the same canonical string always yields the same key, anywhere.

Fallbacks, all recorded in `project.yml` and the notice so they are visible:

- **Non-git workspace:** UUIDv5 over the absolute path, flagged `path-derived` (unstable across
  machines — the notice says so).
- **User override:** a `projectKey:` line in config wins, for monorepo subdirectories and
  multi-remote situations.

### 2.4 Chapter frontmatter (extended)

Today's frontmatter (title, summary, ranges, sha, …) gains:

```yaml
projectKey: 1c3f…          # §2.3 — every chapter carries its project
kind: chapter              # chapter | rule (§7)
harnessId: adrian-mbp      # writing machine, human-readable
topics: [auth, middleware] # deterministic signature topics at archive time (§4);
                           # model-enrichment may later add semantic topics
generated:                 # provenance per field class (user-confirmed, §6)
  title:   {by: deterministic}
  summary: {by: model, model: qwen3.8-flash-next, at: 2026-09-17T…}   # or {by: deterministic}
  topics:  {by: deterministic}
```

Provenance is load-bearing: it is what makes the emergent vocabulary auditable and enrichment
re-runnable (§6).

## 3. Storage vs transport

### 3.1 The store stays in the workspace; the clone is a mirror

Chapters must remain reachable by the existing `read` tool — a property proven load-bearing in
the r22 read-back test, and one the agent sandbox may gate for outside-workspace paths.
Therefore:

- **Storage** stays exactly where it is: `.dsh-chapters/<rootSessionId>/…` in the workspace.
- **Transport** is a git clone in the same workspace: `.dsh-knowledge/` (hidden; the plugin
  writes/updates a gitignore hint in the project on first sync so the project's own repo
  ignores it).
- Sync = copy-out (store → clone, commit, push) and copy-in (clone → store, new files only).
  The clone is *transport*, never the read path's source of truth for the live session.

Failure domains stay separate: a broken remote never breaks compaction/fork (sync is
best-effort, §5.3), and a broken clone never corrupts the store.

### 3.2 Git client: pure-JS SDK, not the executable

**Decision (user-directed):** no dependency on a `git` binary. A pure-JS client
(isomorphic-git-class) over **HTTPS** — which is what makes the scoped-token credential model
of §2.1 possible. Logged risks: pure-JS fetch/push is slower than native git (mitigation: the
knowledge repo is small relative to source repos; lazy-clone on first use); the repo grows a
dependency to own. Fallback, config-gated and documented: the CLI, for hosts where the SDK
chokes. SSH-only remotes are a known gap in this decision (HTTPS tokens are the supported path).

**Local-path upstreams bypass HTTP entirely** (`/chapters-link <path>`, added with the
P1 close-out): the pool is a directory (bare repo created on first sync if absent) and
transfer is isomorphic-git's own pack layer — `packObjects` fed an **explicitly computed
reachability closure** (commits → trees → blobs; packObjects packs exactly what it is
given, measured) written straight into the target's `objects/pack/` and `indexPack`ed,
then refs moved under the same ff-only rule. Zero network, zero credentials, still zero
git-binary. Two machines converging through one shared path — including a real fork
resolved by mirror rebuild — is covered by `tests/integration/sync-local-upstream.test.ts`.

**§3.1/§3.2 are the git provider's rules.** Since the 2026-09-21 transport amendment the transport behind them
is one implementation of a six-verb seam (`src/provider.ts`); the TreeDX service provider
keeps §3.1's store/mirror split verbatim (the mirror is provider-materialized content, not a
clone) and §5.2's rebuild-on-divergence verbatim. The per-verb mapping, failure classes, and
mirror state file are specified in [docs/provider.md](provider.md); API facts and the
[LIVE-GATED] list live in [spikes/treedx/FINDINGS.md](../spikes/treedx/FINDINGS.md).

### 3.3 The no-conflict rule

Two machines never write the same file:

- `chapters/`, `artifacts/`, `collections/` are partitioned by **sessionId** (UUID — collision-free)
  under the project key; a session belongs to exactly one machine.
- `edits/<harness-id>/` is partitioned by **harness id** — one writer per file, ever.
- `index/`, `topics/vocabulary.json`, `project.yml` are **plugin-derived, single-consumer
  writes**: built by the syncing machine from append-only inputs. If a pull ever finds a
  divergent derived file, the plugin **rebuilds it locally and commits the rebuild** — never
  merge-resolves it (§10.2). Merge conflicts are structurally impossible for content and
  structurally repaired for derived state.

## 4. Chapter composition: topic-sequential, deterministic

The user requirement: **consecutive message collections that reference the same task merge into
one chapter; a chapter splits only when the task changes or the chapter outgrows a configured
limit.** This replaces size-only splitting as the primary axis and is the load-bearing new
algorithm of the whole record.

### 4.1 Collection and signature

- **Collection = one completed turn**: the user message(s) of the turn, its assistant
  messages, and its `turn/end`. (The "user + first + last assistant" slice is the *enrichment
  input*, §6.1; composition works on the whole collection.)
- **At `turn/end`, synchronously** (millisecond-scale, no queue), the plugin extracts the
  collection's **deterministic signature** and appends one line to
  `collections/<projectKey>/<sessionId>.jsonl`:

```json
{"seqs":[41,42,43,44,45],"paths":["src/auth/middleware.ts","src/auth/token.ts"],
 "commands":["npm test","git diff"],"terms":["auth","refresh","jwt","middleware"],
 "size":1830,"by":"deterministic","at":"2026-09-17T…"}
```

  - `paths`: file paths mentioned in tool calls/results (highest-signal source in coding
    sessions).
  - `commands`: command/argv tokens, normalized.
  - `terms`: stopword-filtered keyword frequency, top-N.
  - `size`: estimated tokens (cross-machine heuristic — fine for composition, not for
    display; the TOC shows message counts, not tokens, §7.3, because tokenization is not
    comparable across models).

  Because the signature is computed *when the turn completes*, **no compaction or fork ever
  needs unprocessed material**: every completed collection is already signed, and an
  unfinished collection (the in-flight turn) is never in scope — the host compacts at
  `agent/pre-step` only, never mid-step (measured r13/r17), and its retained tail always
  contains the current turn. This is the answer to "compaction can happen at any step."

### 4.2 Composition (at archive time)

When a compaction or fork archives a span of completed collections, chapters are composed by a
**greedy sequential merge**, deterministic and O(collections in span):

1. Open chapter 1 at collection 1; accumulate its running signature (union, with
   per-collection weighting).
2. For each next collection: **merge** if
   `overlap(collection, running) ≥ τ` **or** `primaryMatch(collection, running)` — **and**
   `chapterSize < chapterLimit` — otherwise **close the chapter and open a new one**
   at this collection.
3. `overlap` is a normalized term overlap: shared paths (heavy weight — same file is
   near-probably same task), shared command families, shared terms, over the union.
   `τ` (merge threshold) and `chapterLimit` are config (§12), both in the same
   "no hardcoded tunables" register as `chapterTokenTarget`.
4. `primaryMatch`: the first path of either running member (`paths[0]` — the file a
   turn is *about*, by causal order of touch) names the same file as the incoming
   collection's primary, with a spelling tolerance (`src/render` = `src/render.ts`).
   **Amendment r28 (2026-09-18, measured live):** the first real topic test — five
   research turns on this repo — showed overlap ALONE never reaches τ for legitimate
   same-topic pairs: real turns touch 5–6 files, one shared path dilutes in a union
   of ~10 (measured 0.077 vs τ 0.3), while cross-topic pairs score 0.0–0.02. The
   intent of rule 3's "same file is near-probably same task" is thus carried
   explicitly: a shared primary is a first-class merge signal, not a diluted weight.
   τ and the size cap are unchanged; every decision still logs the rule that fired.

Boundary, measured live (r29/r36): the host's pressure selection ends at
tool-pair balance points, blind to turn boundaries — shallow repairs slice
collections, and the completeness guard then correctly falls back to legacy
single-chapter fragments. Topic-sequential composition therefore governs the
turn-aligned archive moments (fork/continue, where the span is anchored at a
`turn/end`); the engine wiring (r29) is the opportunistic upgrade for deep
selections (first breach of a heavily-over window), never a fragment
regression. If engine-path merges ever need to be reliable under steady
pressure, the fix is cross-chapter collection stitching in the index (P2),
not selection tuning.

Honest quality bar: strong for coding sessions (files and commands leave loud signatures),
degrading to time/size splitting for pure-prose conversations — never worse than today's
behavior, never blocking.

### 4.3 The completeness guard

Chapters include **only collections with a `turn/end`** inside the span. If a compaction
boundary ever lands mid-collection (the manual-`/compact` edge case — the automatic path
cannot produce one, §4.1), the composition clamps to the last completed collection and the
TOC notes the clamp. The unfinished collection stays in the live context, per the user
requirement, and composes at the next archive.

### 4.4 Consequence: composition is archive-time-only

Because chapters are append-only (invariant 3), the merge threshold must be right *when the
archive happens*. The per-collection signature is stored with provenance (§4.1) precisely so
any merge or split is **inspectable after the fact** — and so `τ` can be tuned for future
archives without pretending to rewrite old ones. Enrichment (§6) may later *relabel* a
chapter's topics but may never re-chapter it.

## 5. The sync loop

### 5.1 Points

| Event | Action |
|---|---|
| New chapters-preset session created | **pull** (fresh corpus before the first turn; §5.2 ordering) |
| Fork (button or command) | **pull → compose/archive → push** |
| Compaction finalization | **push** (debounced — see 5.2) |
| Idle (debounce expired after the last archive) | **push** |
| Pull failure / push failure | log, surface via `/chapters-status`, **never fail the archive** |
| `/chapters-link <path>` | binds a directory upstream (bare repo materialized on first sync); no credentials |

Compaction and fork are simultaneously push points *and* the right refresh points — the loop
is pull → archive new span → push, so a fork point always sees a current index.

### 5.2 Ordering and serialization

- A **per-repo writer lock** serializes (a) store transactions (reserve → write → commit) and
  (b) clone operations. A pull never lands mid-archive-write and a push never ships a
  half-committed store.
- Push = `copy-out → commit → fetch → if diverged: rebase-apply (append-only ⇒ fast-forward
  safe) → push`, with bounded retry. All git calls run with no TTY prompt (
  `GIT_TERMINAL_PROMPT=0` equivalent in the SDK), hard timeouts, and network treated as
  best-effort.
  **Implementation note (r35, via §15):** divergence is resolved by REBUILDING the mirror,
  not rebasing it — `remove → fresh clone → re-publish from the store → push`. Same
  semantics (the local backlog reaches the remote without force; append-only content merges
  trivially), fewer moving parts, and no rebase primitive needed (isomorphic-git 1.42 has
  none). The rebuild is safe only because the mirror is transport (§3.1) — the workspace
  store is the truth it re-publishes from. Diverged-vs-network is a machine-readable
  failure CODE, not prose matching: a network error's message once contained the word
  "diverge" and falsely triggered this path (caught by the real-HTTP test).
- Debounce: consecutive archive events within the configured window coalesce into one push.
  The triggers live in both planes: the host plugin pulls before, and schedules after,
  fork/continue archives; the realm engine schedules after compaction finalization and
  pulls at each session's first `turn/start` (the "new session" refresh point, read
  process-scoped). The file lock is what makes the two schedulers safe side by side.

### 5.3 Failure semantics

Remote down, token revoked, clone corrupted — each degrades to *local-only mode*: the store
keeps working, pending sync accumulates, `/chapters-status` says so with numbers. Nothing in
the conversation path waits on the network.

## 6. Model enrichment: async, provenance-tagged, re-runnable

### 6.1 The pass

For each archived chapter, one structured call whose input is the cheap slice the user
specified — **the user request(s) plus first and last assistant message**, each capped, plus
the first ~200 tokens of the chapter body for grounding — and whose output is validated JSON:

```json
{"title": "…one sentence…", "summary": "…short…", "topics": ["…up to 10…"]}
```

- **Validation before commit:** schema-check; on failure, retry once; on second failure, keep
  the deterministic values (title from the existing derivation, excerpt-labeled summary,
  signature topics). A slow or failing model never blocks or blanks a chapter.
- **Thinking models:** the pass runs at low reasoning effort and tight `maxTokens`; on the
  local server this is the only model work this feature ever forces, and it is batched,
  below.
- **Topics are proposals:** they enter the chapter's frontmatter only through the
  canonicalizer (§6.3) — unknown labels pass as `unvetted`.

### 6.2 When it runs: idle-batched, never per-turn

**Measured constraint (r29-era):** the local server is **single-slot**
(`maxConcurrent: 1`). Per-turn model work would queue against the user's own conversation
turns. Therefore:

- **Per turn:** deterministic signature only (§4.1) — free, synchronous, no model.
- **Model enrichment:** batched at natural idle points — after a compaction/fork push
  completes, or on an idle debounce — processing *archived* chapters only. It can be
  disabled per-harness in config; a harness on a contended machine can run
  signatures-only and still contribute a fully functional corpus.
- **Re-runnable:** a command re-annotates a chapter (or the whole project) with a newer model
  or corrected vocabulary, overwriting only the model-owned fields (frontmatter provenance
  records each overwrite). The verbatim body is never touched.

### 6.3 Self-bootstrapping vocabulary (no seed list, no hand-editing)

Per the user requirement, the vocabulary is **plugin-owned and emergent** — the user neither
authors a seed list nor edits files:

1. **First runs:** no canonical vocabulary. Topic labels are raw deterministic candidates;
   enrichment topics enter flagged `unvetted`.
2. **Merge signals**, watched by the plugin against its own corpus:
   - two labels **co-occur** in the same chapter repeatedly;
   - two labels share **high normalized token overlap** across chapters;
   - **alias patterns** (substring/singular-plural: `auth` ⊂ `authentication`).
   Past threshold, the plugin writes a **curation entry** into `edits/<harness-id>/`
   (Layer 1, §10.1): `author: plugin`, `reason: <signal + counts>`, `merge: {from, to}`.
3. The derived index and `topics/vocabulary.json` reflect curation entries on the next build;
   the vocabulary file stays **diffable and git-revertable** — the user can see every
   decision the plugin made, and undo one, without ever having to make one.
4. Escape hatch (P3, optional): `/chapters-topic merge <a> <b>` — the same curation entry,
   human-authored.

Provenance in frontmatter (§2.4) is what makes all of this auditable: any label on any
chapter traces to a deterministic pass, a specific model run, or a specific curation entry.

## 7. Rules: chapters of a different kind

### 7.1 Model

Rules reuse the chapter machinery end-to-end — same file format, registry, budget preflight,
search, and sync. Frontmatter: `kind: rule`, plus `category`, `status`, and provenance.
**Rules are another form of chapter to search when needed** (user's framing, adopted); the
plugin's modularity is what makes this nearly free — the chapter code paths are parameterized
by `kind`, not duplicated.

**Two scopes, one store, one format** (Amendment 2026-10-20, §15). Session rules are *not* a
second subsystem: they are `kind: rule` files in the same `rules/<harness>/` tree, with the same
write-once immutability, the same `list` surface, the same search index. What differs is **how
they get authored and how they become active**:

| Tier | Authored by | Activation | Transport | Carried by |
|---|---|---|---|---|
| **project** | `/chapters-rule add`, `chapters_rule_propose` (agent) | human `approve` → per-machine curation fact (§7.2) | synced to the pool | continue **and** fork |
| **session** | `ADD RULE:` marker (deterministic), enrichment (optional) | **derived** (§7.5) — no fact, no approval | local only; never staged (§7.5) | continue only — dropped by fork (§7.6) |

Extra frontmatter on every rule file: `scope: project | session` (absent ⇒ `project`, so every
pre-existing record keeps working byte-identically), `session: <sessionId>` (session tier only),
`derivedFrom: human | marker | model`, `pinned: true` (§7.4). Same `category`, `status`,
`sha256`, provenance chain as before.

**Why the split is safe.** A rule that only ever governs one machine's session tree is not shared
state, so §11.3's blast-radius argument does not apply to it — and the per-machine approval
boundary of §7.2 is left exactly as the 2026-09-20 amendment set it. Cross-checkout carry of
*project* rules needed no new mechanism: `projectKey` is UUIDv5 over the canonicalized remote
(§2.3) and `harnessId` defaults to the hostname, so several checkouts of one repository already
resolve to one rule namespace on one machine. §7.8 is about making the cases where that identity
*diverges* loud, not about building propagation.

### 7.2 Lifecycle: proposed → core, approved in-session *(the project tier)*

This section governs `scope: project` — the shared, team-visible tier. The session tier's
activation is derived and needs no approval (§7.5).

- **Proposal:** a user command (`/chapters-rule add <category> <text>`) or an agent's async
  derivation from a completed session (P3, always `status: proposed`, provenance-tagged with
  the source session).
- **Review/approve:** entirely in-session DSH commands — the user never leaves the session,
  and **command output never enters the context window** (verified 2026-09-17: command results
  persist as `command/run` / `command/done` event types — a distinct type, not
  user/assistant/tool — which are neither prefilled to the model nor priced by the compaction
  engine; 24 such pairs observed in the r29 session's durable log from the e2e suite):
  - `/chapters-rule list` (`--proposed`, `--category <name>`) — table: id, status, category,
    one-line text, provenance.
  - `/chapters-rule approve <id>` — `proposed → core`.
  - `/chapters-rule revoke <id>` — core back to the file, out of the notice.
- **`core` is the only tier that renders into the continuation notice** (§7.3).
  **Amended 2026-09-20 (§15):** `approve` does not rewrite the rule file — it appends a
  `rule-status` curation fact to the APPROVING machine's own `edits/<harness>/curation.jsonl`.
  Effective status is per-machine (file otherwise `proposed`); a rule affects no other
  machine's notice until that machine's human approves. Reason: authorship partition — a
  shared-file status would let any machine rewrite another's authored bytes, which r37
  showed is exactly where transport bugs live. The human
  in the loop is the one who types `approve`; the git diff of the rule file is the audit
  trail. This is the trust boundary for shared state (§11.3).

### 7.3 The rules block: what a rebuilt head shows

One builder renders the rules block (`buildRulesSection`), and **both** places a head is rebuilt
use it — the continuation notice and the in-place compaction checkpoint (§7.6). The block is O(1)
in corpus size (§1 invariant 6) and, on an empty or unlinked corpus, renders **zero bytes**
(`kind: 'none'` → nothing at the call site): load-bearing for the tape corpus, which contains no
rules block anywhere (§13 P3).

Contents (all O(1), §1 invariant 6):

- **Active rules, verbatim,** selected by the three classes of §7.4 — pinned, then
  relevance-selected, then index-only. Project tier and session tier render under their own
  headers so the model can tell whose order it is reading.
- **A withheld line — mandatory.** When the caps drop anything, the block says so with numbers:
  `9 project rules active, 4 shown — /chapters-rule list`. Selection by relevance is legitimate
  (§7.4); *silent* selection is the exact failure this feature exists to remove, because a rule
  the human believes is active and is not, is worse than a rule that was never captured.
- **The token ceiling stays refuse-don't-truncate:** if the selected set exceeds
  `coreRulesBudgetTokens`, the builder returns `refusal` with per-rule token numbers, the caller
  omits the block rather than clipping (§1.2), and the refusal is reported — never swallowed.
  Omission stays non-blocking: rules are additive, and a broken mirror or an overflowing ruleset
  must not stop a continuation or a compaction.
- **Precedence line** (§7.7): session rules refine and add; they never override a project rule.
- **Rules category index:** category names + one-line essence + paths, with the instruction
  *load a rule category when this session's topics overlap a category* — i.e., the agent
  reads the full category from the repo when (and only when) relevant.
- **Search instructions** for the chapters index (one paragraph, pointing at
  `chapters_search` and the shard paths).
- **`Project: <slug> · <projectKey>` — prominently near the top** (user requirement): the
  agent always knows which corpus it is in and where searches point.
- The existing sections (chapters list with single-sentence title, short summary, file link,
  **message count** — not token count, since tokenization is not comparable across models —
  and parent/fork links) unchanged.

### 7.4 Topic-matched selection (raised from the old P3b sketch)

The record deferred "topic-matched auto-inclusion" because always-render-everything does not scale
against an O(1) head. With automatic capture the corpus of *active* rules now grows on its own, so
selection moves from garnish to requirement, and it is built here on machinery that already existed
purely for pull-based search.

Three render classes, in this order, under `projectRulesDisplayCap` / `sessionRulesDisplayCap`
(count) and `coreRulesBudgetTokens` (tokens):

1. **Pinned** (`pinned: true`, human-set via `/chapters-rule pin`) — always rendered, first.
   Ground rules are *old* by definition, so any scheme that ranks by recency or topicality evicts
   them first; the pinned class is the floor that keeps that from being a surprise.
2. **Relevance-selected** — `rules.selectRules`, the ONE selector for what a head shows:
   pinned first, then topicality against a term bag, then the pre-#50 category→id order. The term
   bag is the archived span's stored turn signatures for a rebuilt head and the task query for
   the `chapters_rules` door — both paths share the selector, so the head and the door can never
   disagree about what applies. `search.rankEntries` stays the *corpus* scorer (§8): ranking an
   unbounded archive against a query and selecting a bounded set for one head are different jobs,
   and this round kept one implementation of each rather than bending a rebuilt head to read index
   shards. What is forbidden is a **third** rule-picker living in a door or a checkpoint — a
   source-shape row fails if either stops calling the shared builder.
3. **Index-only** — everything else: category + one-line essence + path, loadable. The corpus
   grows without bound; the head does not.

`rulesRelevance: false` falls back to the pre-existing deterministic order (category, then id),
which is what the tapes were distilled against.

**Determinism is a requirement, not a preference.** Selection must be a pure function of (rule
files, stored topic signatures, caps, query) — no wall-clock timestamps, no map-iteration or
filesystem-readdir order — or two machines disagree about what the agent was told *and* every
replay prefix becomes unstable. Ranked-by-recency was rejected partly for this reason: recency
reads the clock.

### 7.5 Session rules: capture and derived activation

Two capture paths, deliberately different speeds (this is §6.2's single-slot constraint applied to
rules, not a new policy):

- **Marker — deterministic, instant, zero model tokens (§1 invariant 1).** A line in a
  *human-authored* message beginning `ADD RULE:` (§12 `rulesMarkerPrefix`) becomes an active
  session rule at the existing `turn/end` listener — the same one the topic signatures collect on
  (r35j). It is not a new archive door (§12 of `docs/architecture.md`: five moments, extended in
  place, never copied). The rule body is the human's own words, verbatim.
- **Enrichment — idle-batched, `rulesEnrichment` default ON.** The §6.1 pass carries a
  `rules: [{ text, category, quote }]` field through that pass's existing ladder: validation
  before commit, one retry, deterministic fallback, provenance chain, and the body-hash guard
  (mining writes its own rule files; it never touches chapter prose). `rules` is **optional in the
  output contract**, so every pre-existing stub, fake and tape still validates, and a malformed
  `rules` value cannot cost a chapter its annotation.
  **The gate is evidence, not a click: a mined rule activates only when its `quote` appears
  verbatim (case/whitespace-normalized) in the chapter's HUMAN bytes.** Assistant prose is
  inadmissible — the model restating an instruction it was handed is the amplification path, and
  an invented quote is a guess wearing a citation. Everything else is written `suggested: true`:
  reviewable in `list --scope session`, **inert in every head** until this machine's status fact
  says core, which is what `approve` is for on this tier. Activation rides a curation fact; the
  write-once file is never rewritten (§1.3).
  Two properties worth stating, because they were the design's point: a small model will produce
  mostly *suggestions* (exact quotes are hard for a 4B), so the tier degrades to a review queue
  rather than to unearned authority; and mining runs **before** the hash-guarded annotation write,
  so a chapter whose enrichment is refused still contributes its standing orders. That is the §1.4 division — model proposes, plugin commits — with the activation gate
  moved to machine-local, where a wrong guess costs one session and not a team's corpus.

**Activation is derived, never a curation fact.** A session rule is active iff `scope: session` ∧
its `session` is on the current session's ancestor path ∧ it is not revoked. No
`rule-status` entry is written for it: `edits/<harness>/curation.jsonl` travels in the pool, and
machine-local activation volume does not belong in a file reserved for human status decisions —
nor should it, since another machine reads only its own harness directory and would see nothing.
`revoke` on a session rule writes the one exception: a local fact, because the store is write-once
(§1.3) and a delete would be a rewrite.

**Transport exclusion happens at one point.** `planStoreToRepo` is the single store→repo path
mapper (`rules/<harness>/*.md → rules/<projectKey>/<harness>/*.md`), so it is the single place that
skips `scope: session`. No provider verb, no sync-loop edit, no second filter — proven over the
git integration *and* the TreeDX stub, because §5's exit criterion is transport-grade or it is
nothing. Session bytes therefore never become another machine's `proposed` noise, which is what
keeps §7.2's "stop re-reviewing a growing list" goal intact for teammates.

**Loss is expected and re-derivable.** The store root is gitignored inside a re-clonable directory
(`docs/architecture.md § Storage`), so deleting a checkout destroys its session rules with
everything else in it. The marker half re-derives deterministically by replaying the parser over
the durable log (invariant 1 is what makes that possible); the enrichment half re-derives by
re-running the pass. The correct description of that event is "the ruleset was rebuilt", never
"sessions were corrupted".

### 7.6 Carriage: where rules reach the model

Rules are delivered at the moments the head is rebuilt, plus on demand — **not** per request:

| Door | What renders | Mechanism |
|---|---|---|
| Continuation notice | project + session | `rulesSection` at the four door call sites (tools) — already shipped for project |
| Fork / branch notice | project only | the same `intent` axis that already decides plan bytes (§9–13 of `docs/plans-carriage.md`): `branch` ⇒ zero session bytes |
| In-place checkpoint | project + session | `rulesCarry`, the third lead section in `planSummarize`, beside `planCarry` and `plot` — both the composed and legacy paths |
| On demand | assembled set | `chapters_rules` tool (§8): verbatim text within budget + the withheld line |

**Why not "bundled with every request".** Two measured reasons, not stylistic. (a) Invariant 3:
the system prompt is process-global and `systemPrompt` is excluded from our injection list on
purpose — a per-session block cannot ride it, and the append-as-section precedent (`dsh-session-fork`)
was reviewed and rejected here. (b) Cache: on llama.cpp, the target hardware, a head-position
replacement reuses **nothing** (E3, r23/r28: `cacheReuse 0`), so a ruleset that churns mid-session
is a cache-wipe machine. Between rebuilds the human's original bytes are still live in the surface
anyway — they only genuinely die when the surface is replaced, and that is where they are now
re-stated. Plans arrived at the same conclusion for the same reason.

Empty set ⇒ the checkpoint carries zero rule bytes, which is what protects every already-committed
plot-carrying checkpoint (`src/engine-core.ts` records exactly that hazard).

### 7.7 Precedence and conflicts

Two live tiers means two sources of "must", and a small model degrades badly on a contradiction,
so precedence is stated in the block rather than left to the reader:

- **Project rules are the team's order. Session rules refine and add; they never override.**
- A session rule that conflicts with an active project rule is *rendered and flagged*, not
  resolved silently — the human's options are to promote a fix to the project rule or revoke the
  session rule.
- **`/chapters-rule conflicts`** spends one bounded `ctx.llm` stream call over the assembled set,
  reusing the conversation's own system prompt as the cache-friendly prefix (`docs/contract.md`),
  and returns a **report** of contradictory pairs with rule ids. Like `elicitedPlot`, this is an
  explicit, config-gated exception to zero-inference. It is never a mutation: rules are write-once
  (§1.3) and the only sanctioned change is a curation fact. Enrichment may flag the same pairs in
  its own pass; neither path edits a rule.
- Command output never enters the context window (§7.2 verified), so reviewing conflicts costs a
  human no session tokens.

### 7.8 Identity must fail loudly

The design goal "project rules carry across my checkouts of this repo" holds because identity is
remote-derived (§2.3). Where it does *not* hold, silence is the bug — ungoverned must never look
like governed:

| Divergence | Consequence | What the plugin must say |
|---|---|---|
| No readable remote ⇒ `path-derived` key | that checkout has a **private** rule namespace | `0 project rules — this checkout resolves project <key> from path <cwd>; link it with /chapters-link` |
| No `origin`, another remote listed first | key derives from the fork ⇒ a forked pool | report the remote string actually used |
| Linked via TreeDX rather than git | key is the **pool location** (`treedx/<host>/<repo>`), not the workspace remote | report `projectKeySource` so git/treedx keyed checkouts are visibly different projects |
| Fresh checkout, unlinked or not yet synced | no project ⇒ no rules at all | same explicit zero line, plus `/chapters-status` sync state |

`projectKeySource` (`override | remote | path-derived`) rides **`/chapters-status`** as an
`Identity:` line — naming the source AND where it came from (remote string / override / literal
path) — and the divergence branch is its own warning: `⚠ THIS CHECKOUT RESOLVES A DIFFERENT
PROJECT KEY … rules and chapters approved elsewhere will NOT appear here`. `/chapters-link`'s view
reports the same fact. The continuation head carries the zero-rules statement **only when the
session tier is governing that head**: bolting an "unlinked" line onto every unlinked workspace's
notice would spend real bytes on a warning most sessions do not need, while a head that already
carries local rules is exactly where a silent zero gets misread as "the team approved nothing".
`/chapters-rule active` prints the tier counts on demand, and `chapters_rules` names a missing
project in its note. A session-scoped archive depends on none of this — which is why an unlinked
checkout still gets its own rules.

### 7.9 Command surface, and what the agent is told

**Principle: the machinery is invisible; the query is encouraged.** Capture, activation, budgeting
and carriage happen without the agent doing anything — no tool it must remember to call, no
command it must issue, no bookkeeping it can get wrong. What it *is* told, in every rebuilt head,
is to **look the rules up before starting a task**: `chapters_rules` with the task description,
named in the notice's `## Finding things` block (§8). Everything else about rules reaches it as
prose it simply reads.

| Surface | Tier | Notes |
|---|---|---|
| `/chapters-rule add <category> <text>` | project | unchanged — the only human door that writes shared rule bytes |
| `/chapters-rule list [--scope project\|session] [--proposed] [--category <c>]` | both | table: id, scope, status, category, one-line text, provenance, source seq |
| `/chapters-rule active` | both | **exactly what is or will be rendered**, with the withheld count and why — the command that makes §7.3's honesty checkable |
| `/chapters-rule approve / revoke <id>` | project (approve) · both (revoke) | per-machine curation facts (§7.2, §15 2026-09-20) |
| `/chapters-rule pin / unpin <id>` | both | the §7.4 always-shown class; **human-set only** — an auto-pinned rule is an ungoverned always-shown rule |
| `/chapters-rule conflicts [--model <pin>]` | both | report-only (§7.7) |
| `chapters_rule_propose` (tool) | project | agent-facing, stays `proposed` and machine-inert until a human approves — unchanged contract, do not widen |
| `chapters_rules` (tool) | both | the assembly door: verbatim selected set within budget + the withheld line |

Encouragement lives in the **notice**, deliberately: notice prose costs nothing against the tape
corpus (measured 2026-10-11 — no committed tape prefix contains a seeded notice), while a persona
or tool-description edit forces a re-record of every affected project (§13). A new tool or tool
parameter does change the header, so this feature's schema edits are sequenced into **one**
re-record rather than scattered across several.


## 8. Search: `chapters_search`

### 8.1 Contract

```
chapters_search { query: string, maxTokens?: number, topic?: string, crossProject?: boolean }
→ { matches: [...], shown: n, total: m, budget: {requested, used, remaining} }
```

- `maxTokens` is **the agent's request** (user requirement: the model knows its own window;
  the plugin measures and packs to it, the same way the continuation budget preflight does).
  Default: small (config), overridable upward by the agent.
- **Deterministic scorer** (no model, reproducible, transparent):
  - term hits on **topic (×2 weight), title, summary, category** (rules: category + text);
  - **recency** boost: exponential decay on chapter date;
  - small bonus for `kind: rule, status: core`.
- **Output lines:** `score | date | kind | title | path (topics: …)` — packed until
  `maxTokens` is spent, most-relevant first; the response reports `total` so the agent can
  re-request with a larger `maxTokens` to page (transparent, no hidden truncation).
- **`topic: <name>`** reads an entire index shard (a bounded, alphabetical file).
- **Default filter: the caller's `projectKey`** — cross-project search is an explicit
  `crossProject: true`, so a small-model session never wanders into a foreign corpus by
  accident.
- **Zero new trust surface:** every `path` returned is a plain file the existing `read` tool
  opens (chapters in `.dsh-chapters/`, shards in `.dsh-knowledge/index/`). The search tool
  adds a scorer and a formatter; it adds no new way to read.

**`chapters_rules` — the head's selector, assembled (§7.4, §7.9).** One door whose output is *the
text of the rules that apply to this task*, verbatim, within budget, plus the per-tier counts it
withheld. It calls `renderRulesBlock` — the renderer the continuation notice and the compaction
checkpoint also use — and nothing else; a rule-picker living in a door or a checkpoint is forbidden
by the same argument that made `exit_plan_mode` and `chapters_continue` share one builder. §7.4
keeps `rankEntries` (corpus ranking) and `selectRules` (head selection) as one implementation of
each genuinely different job.

- **It reads both corpora, which is where the trap is.** Project rules come from the pool mirror
  under `rules/<projectKey>/<harness>/`; session rules live in the **workspace store** under
  `rules/<harness>/` and are never staged (§7.5), so they carry no `projectKey` path prefix. The
  `projectKey` prefix filter above must therefore not be the only scope for the session tier, or
  session rules become invisible to the very door whose job is to find them — a silent zero, the
  failure class §7.8 exists to eliminate. Scoping for session rules is by the ancestor-path
  activation predicate instead, never by path prefix.
- **It is the encouraged step, not a required one.** Capture and carriage never depend on it
  (§7.9); the notice names it in `## Finding things` as the thing to run before starting a task.

## 9. Redaction: minimal, deterministic, marked

User position, adopted: **credentials only, deterministic patterns only, everything else
byte-identical** — the character of the conversation is historical value and stays intact.

- **Patterns (deterministic):** `AKIA…` (AWS), `sk-…` (OpenAI-shape), `ghp_/gho_/
  github_pat_`, JWT `eyJ…` shape, `Authorization: Bearer …`, `token=…` in URLs, PEM private
  key blocks. Deliberately conservative; new patterns are config additions, not magic.
- **Marker format:** `⟦redacted:credential sha256=8f3a1c2b⟧` — (a) obviously not a real value
  to any model reading the chapter, (b) **deterministic per secret** (same secret → same
  marker, so diffs and cross-chapter greps stay stable), (c) leaks nothing but a prefix hash,
  which is also what lets a user ask "which secrets touched my sessions" without exposing
  them.
- **Applied once, at the archive chokepoint** — render → redact → write — covering chapters
  *and* artifacts, so a value is redacted at the moment it leaves the session log, wherever it
  appears.
- **Honest limit:** pattern-based redaction is a speed bump, not a guarantee. The doc that
  ships with the repo (and the notice) says the corpus is **plaintext memory**: per-project,
  private, user-created, with a known-small redaction carve-out.

## 10. The two-layer index

### 10.1 Layer 1 — editable, per-machine, append-only

`edits/<harness-id>/curation.jsonl` — one JSON line per index fact, **one writer per file,
ever** (§3.3), zero conflicts by construction:

```json
{"type":"topic-alias","from":"auth","to":"authentication","author":"plugin",
 "reason":"co-occurrence in 14 chapters","session":"…","at":"…"}
{"type":"group","chapters":["…a","…b"],"label":"jwt-refresh-work","author":"user","at":"…"}
{"type":"weight","topic":"auth","weight":2,"author":"user","at":"…"}
```

Fact types: `topic-alias` (merge/rename), `topic-pin`, `group` (sibling chapters that
belong together — the semantic grouping that composition cannot do alone), `weight`,
`note`, and the two rule facts (§7.2, §7.4): `rule-status` — per-machine approve/revoke,
the 2026-09-20 amendment's whole mechanism — and `rule-pin`, the always-rendered class,
which rides a fact for the same reason status does: a rule file is write-once and the
append-only rule has no exceptions. Authors are `plugin` or `user` (user entries via commands, P3). This is the
"improve over time" layer: curation accumulates as facts, and the derived index reflects
them — performance improves without anyone hand-editing, and every fact is inspectable and
revertable in git.

### 10.2 Layer 2 — compressed, derived, incremental

`index/<topic-shard>.md` — one shard per canonical topic (alphabetical segmentation:
bounded files, and writes from different chapters usually touch different shards). Shard
content: a header line (topic, count, last-updated) then one line per chapter:
`date | title | path | (kind) | recency-hint`.

**Build is incremental** (user requirement: generation time must not scale with the corpus):
`manifest.json` records, per input file, the content hash last processed. A build touches
only (a) new chapters/artifacts/collections and (b) new curation entries since the last
build — O(delta). Because inputs are append-only, "changed" ≈ "new" in practice.

**Full rebuild stays possible** (deterministic from the tree) as the *recovery* path — a
machine with a lost manifest regenerates, and any machine can repair a divergent derived
file by rebuild-and-commit rather than merge-resolving (§3.3). Incremental is the fast path;
rebuild is the repair path.

## 11. Trust and security

### 11.1 Credentials

Scoped, revocable, per-repo, per-harness (§2.1). No SSH. A compromised harness exposes at
most one repo token, revocable in one click.

### 11.2 Data exposure

The corpus is plaintext memory (chapters are verbatim by design). Mitigations are the
boundaries, not illusion: per-project repos, private, user-created; redaction carve-out
(§9); per-harness namespacing so one machine's sessions are always attributable.

### 11.3 The blast-radius rule

Everything in the corpus that a *model* can influence and that other machines will *follow*
needs a human gate:

- **Chapters:** low blast radius — evidence, provenance-tagged, attributable. No gate.
- **Topics/vocabulary:** medium — affects search, not behavior. Plugin-autonomous with
  git-visible curation entries (§6.3).
- **Rules:** high — they are prompts by another name, shared across machines. **Human
  `approve` is mandatory** (§7.2). A proposed rule that is never approved affects nothing.
- **Session rules** (§15 amendment 2026-10-20) are the deliberate exception, and the exception is
  *narrowed by scope, not by gate*: machine-local, never staged to the pool (§7.5), permanently
  active for one session tree, and visible/reversible with one command (`active`, `revoke`).
  Blast radius is that tree. Two properties keep it honest: model-derived rules auto-activate
  **only** when they quote human bytes verbatim, and a session rule never overrides a project rule
  (§7.7). What is *not* permitted is a session rule migrating into the shared tier on its own —
  promotion is a human act, exactly as approval is.

Git history + provenance makes every tier auditable and every mistake revertible.

## 12. Configuration surface

No hardcoded tunables (existing hard rule). New config, all with defaults documented in
`dev/` templates:

| Key | Meaning | Default |
|---|---|---|
| `knowledgeRemote` | the project's repo URL (or `/chapters-link`) | none (local-only) |
| `projectKeyOverride` | wins over §2.3 derivation | none |
| `mergeThreshold` (τ) | collection-merge overlap, §4.2 | tuned in P1 |
| `chapterLimit` | max chapter size (tokens, heuristic) before forced split | 8000 (today's `chapterTokenTarget`) |
| `coreRulesBudgetTokens` | cap on the notice's core-rules section | refused-with-numbers on overflow |
| `syncDebounceMs` | coalesce window for pushes | 30000 |
| `toolResultArtifactTokens` | arrival-time artifacting floor (architecture.md amendment 2026-09-19): tool results at/above this many estimated tokens are stored as artifacts and reference-stubbed BEFORE the next request composes — the blob never enters any prompt | 8000 |
| `elicitedPlot` | when a compaction region holds no model-authored `PLOT:` note, spend ONE bounded stream call (≤8K chars in, ≤220 tokens out) to mint the working plot carried into the checkpoint; the approved, config-killed exception to zero-inference | true |
| `enrichment.enabled` / `.model` | per-harness enrichment toggle + model pin (built flat: `enrichmentEnabled`, `enrichmentModel`) | enabled, conversation model |
| `enrichment.trigger` / `.idleMs` / `.batchCap` | P2 queue policy seam (built: `enrichmentTrigger/enrichmentIdleMs/enrichmentBatchCap`); realm owns auto, host plane is manual-only; `/chapters-enrich model` overrides durably | both / 60000 / 5 |
| `vocabulary.*` | built flat: `vocabApply` (false = **shadow**: candidates reported in the sync status line, nothing written), `vocabCoMin` (3), `vocabOverlapMin` (0.5); applied merges land as §10.1 `topic-alias` facts under `edits/<harness>/`; `topics/vocabulary.json` derived | shadow / 3 / 0.5 |
| `coreRulesBudgetTokens` | P3 §7.3 cap on the notice's core-rules block; overflow refuses with per-rule numbers | 1200 |
| `sessionRulesEnabled` | §7.5: the deterministic `ADD RULE:` capture path (zero model tokens) | true |
| `rulesMarkerPrefix` | §7.5 capture marker; matched at line start of **human-authored** messages only | `ADD RULE:` |
| `rulesEnrichment` | §7.5 model-derived capture: rides the §6.2 idle batch, never per-turn, and no mined rule activates without a verbatim human quote (unverified candidates are `suggested`, i.e. inert) | true |
| `rulesMinedPerChapter` | §7.5 cap on mined rules per chapter — the cap counts rules **written**, not candidates examined, so a duplicate cannot eat a chapter's budget | 3 |
| `projectRulesDisplayCap` / `sessionRulesDisplayCap` | §7.4 per-tier count caps on rules **rendered** into a rebuilt head; anything dropped is announced by count, never silently | 12 / 12 |
| `rulesRelevance` | §7.4 relevance selection on; off ⇒ deterministic category→id order (the order tapes were distilled against) | true |
| — | §7.7 `/chapters-rule conflicts` has **no key of its own**: one bounded stream call on the conversation route the session already has (so it rides that route's cached prefix), report-only. No route yet ⇒ the verb refuses honestly. A gate of its own was rejected: a human types the verb, so `elicitedPlot`'s reason for a switch does not apply | — |
| `rulesCoreBonus` | P3 §8 query-time rank bonus for rules effective-core on this machine (never baked into shared shards) | 0.15 |
| `redaction.patterns` | additive to the built-in list (§9) | built-ins |
| `search.defaultMaxTokens` | default pack size for `chapters_search` | small, config |
| `knowledgeProvider` | transport policy (Amendment 2026-09-21, transport): `auto` dispatches on the remote scheme; an explicit `git`/`treedx` must match it — contradictions refuse, nothing falls back into a wrong pool | auto |
| `treedxFetchTimeoutMs` / `treedxWorkspaceTtlSeconds` / `treedxLeaseRetries` / `treedxLeaseRetryDelayMs` | TreeDX transport tunables (provider.md); lease retries bound the one-writable-lease-per-branch contention window | 15000 / 900 / 3 / 1000 |

## 13. Phasing (each phase independently useful)

**P1 — Transport + deterministic corpus (zero new inference).**
Clone/sync loop (§3, §5); `projectKey` (§2.3); per-turn signatures at `turn/end` (§4.1);
topic-sequential composition replacing size-only splitting (§4.2–4.4) for the fork path
first (compaction spans use the same composer); derived sharded index + incremental manifest
(§10.2); `chapters_search` (§8); redaction at the archive chokepoint (§9); notice v2 —
`Project:` line, message counts, search instructions (§7.3).
*Exit criterion: two machines, one repo; a fork on machine A sees machine B's chapters via
search; sync failure degrades to local-only without breaking the fork.*

**P2 — Model enrichment + emergent vocabulary.**
Idle-batched enrichment pass (§6.1–6.2) with validation/fallback; provenance frontmatter
final; self-bootstrapping vocabulary + curation entries (§6.3); Layer 1 edit types finalized.
*Exit criterion: enriching a corpus is idempotent and re-runnable; vocabulary merges are
git-visible and revertible; disabling enrichment leaves a fully working corpus.*

**P2 STATUS (2026-09-20): BUILT.** The ladder (slice → validate → retry-once → keep
deterministic; `src/enrich.ts`), queue with the pluggable trigger seam (`both`/60s defaults,
realm owns auto, host is manual + `/chapters-enrich run|model|report`), provenance chains +
the body-hash-guarded frontmatter write as the ONLY sanctioned chapter mutation
(`enrich-store.ts`), the vocabulary canonicalizer shadow-by-default with applied merges as
git-visible `topic-alias` entries + derived `topics/vocabulary.json` (`vocabulary.ts` in the
sync pass), and index-level fragment stitching (pure read-view `stitchFragments` — adjacent
legacy fragments cohere into one search entry citing all members, nothing merged on disk).
Idempotent re-run / kill-switch parity / never-blank failure: unit + integration; the `enrich`
e2e project replays the whole ladder through the model tape. CLOSED 2026-09-20: two-machine grade proven (two-machine-enrich test — which caught and fixed r37, a commit-invisible-modification bug in the transport), and the four-project replay chain is green with zero misses.

**P3 — Rules.**
Rules-as-chapters (`kind: rule`); the in-session command family `/chapters-rule
list|add|approve|revoke` (§7.2 — command output verified context-free); core-rules section +
category index in the notice (§7.3); agent-side rule proposals (async, always `proposed`);
`/chapters-topic` escape hatch; topic-matched selection (§7.4 — deferred as P3b in this draft,
built later under P3c, not by design but by sequencing).
*Exit criterion: a rule proposed by a machine affects no other machine until a human types
`approve`; the core set overflows by refusing with numbers, never clipping.*

**P3 STATUS (2026-09-20): BUILT.** `src/rules.ts` (write-once proposed files, per-machine
status resolution, budgeted section with refuse-with-numbers) + `rules-commands.ts`
(`/chapters-rule add|list|approve|revoke`, host plane) + `chapters_rule_propose` tool +
notice seam (`assembleNotice` rulesSection — byte-identical ABSENT, golden-tested so the
tape corpus is untouched by construction) + transport (rules tree publishes; commit is
attempted even at copied===0 so fact-only passes travel — the change that made approvals
shareable) + scorer (category 1.5, rule bodies, per-machine core bonus at query time).
Exit-criterion tests: unit ('machine B sees nothing core'), transport-grade (three machines
over a real pool), e2e (`rules` project: UI add → approve → fork → the child's own log
carries the rule verbatim). §7.4 selection was left unbuilt in that round by design — the corpus
of active rules did not yet grow on its own.

**P3c — Two-tier rules (issue #50): BUILT, both capture speeds (2026-10-20).** §7.1's `scope`/`session`/
`derivedFrom`/`pinned` frontmatter (absent `scope` ⇒ `project`, so every pre-existing rule record
keeps working byte-identically); `ADD RULE:` capture at the existing `turn/end` listener;
`rulesEnrichment` capture behind the verbatim-quote gate (§7.5's second speed, default on,
unverified candidates inert); session-scope exclusion in
`planStoreToRepo`; the three render classes and per-tier caps in `buildRulesSection`; the third
checkpoint lead section; `intent` filtering at the four door sites; `chapters_rules`; the
`active`/`pin`/`conflicts` verbs; and §7.8's loud-identity lines.
*Exit criteria (each must be a red row before it is a fact):* an in-place compaction renders active
rules verbatim into the checkpoint; `chapters_continue` carries project **+ session** while
`chapters_fork` carries project only; `ADD RULE:` yields an active rule at **zero** model tokens;
no session rule file appears in the pool over **either** provider; an unlinked or `path-derived`
checkout says it rendered zero rules; the empty set still renders byte-identical ABSENT; selection
is byte-stable across two machines with the same inputs.
Build status, honestly split (each ✅ is a red-then-green row, not an intention):
✅ `scope`/`session`/`derivedFrom`/`pinned` frontmatter with absent-means-`project` byte-compat;
✅ tier-aware `buildRulesSection` with pinned→relevance→category/id selection, per-tier caps and the
announced withheld count; ✅ `ADD RULE:` capture at the existing `turn/end` listener (zero model
tokens); ✅ the one `planStoreToRepo` exclusion over **both** providers; ✅ `rulesCarry` as the third
checkpoint lead section on both paths; ✅ `intent` filtering at the doors through one
`renderRulesBlock`, with a source-shape row forbidding a door-local picker; ✅ `chapters_rules`;
✅ `active`/`pin`/`unpin`/`--scope`/`conflicts` and revoke-on-session; ✅ §7.8 identity lines at
`/chapters-status` and `/chapters-link`. ❌ the §6.1 `rules: []` enrichment field and its quote gate.
❌ the browser plane: `npm run test:e2e:replay` **refuses by name** on the pinned host (it predates
preset declaration rows — `tests/e2e/boot.ts:130`), so the `rules` journey and the R-rows over a
live model are unverified, and the new tool schema is a standing re-record owed the moment
`dev/dsh-host-lock` moves to 0.2.x. Sequencing then stays as planned: **one** whole-project
re-record, never a series of per-spec ones (the 2026-09-23 lesson: a tape records the context it was
distilled in).

## 14. Open risks (honest register)

| Risk | State |
|---|---|
| Pure-JS git SDK performance at repo scale; SSH-only remotes | accepted (user-directed); CLI fallback config-gated |
| Deterministic topic quality on pure-prose (non-code) sessions | degrades to today's time/size behavior; enrichment improves recall later |
| Pattern redaction is a speed bump, not a guarantee | documented in-repo; patterns are config-extensible |
| Single-slot model server contention | enrichment is idle-batched and per-harness disableable; signatures are model-free |
| Cross-model topic vocabulary drift | canonicalizer + provenance + re-run (§6.3) — mitigated by design, observed in practice at P2 |
| `mergeThreshold` mis-tune at archive time (composition is archive-time-only, §4.4) | signatures are stored with provenance; tune for future archives, inspect past ones |
| TreeDX service down or token expired (Amendment 2026-09-21, transport) | same §5.3 degradation (offline mirror, deferred push, auth re-link surfaced with numbers); no corpus loss |
| TreeDX corpus pull is per-file (`paths/list` + `files/read`): N+1 requests at large pools | acceptable at per-project corpus sizes (the record's own scaling premise); snapshot/`context` APIs are the Phase-F optimization |
| P3c: a model-captured rule encodes a **mis-generalization** permanently for the session tree ("never run two GPU suites at once" → "never run tests concurrently") | narrowed by the verbatim-quote activation gate (§7.5), by scope (local, never the shared tier), and by one-command visibility (`active`, `revoke`); the residual risk is a wrong rule you did not look at — which is why the count is capped and the withheld line is mandatory |
| P3c: relevance selection **ranks out the load-bearing rule**, reintroducing "lost in the noise" inside the fix for it | the pinned class is never subject to selection (§7.4); the withheld count renders even when nothing is selected |
| P3c: a new tool/param changes every replay prefix | one whole-project re-record, sequenced deliberately; notice prose stays free (measured 2026-10-11) |
| P3c: per-checkout identity divergence silently forks a project's rule namespace (§7.8) | stated, not assumed: `projectKeySource` reported in the zero-rules line, `active`, and `/chapters-status` |

## 15. Amendments

This record governs implementation. An amendment is a **human decision** — discussed,
accepted, and edited in with a commit message stating the reason — because the record's value
is that every architectural fact in it was chosen, not generated. Machine-derived knowledge
lives in the *corpus* (chapters, curation entries, vocabulary with provenance); machine
opinions about *this document* do not.

### Amendment 2026-09-21 — transport is pluggable; git is one provider

Accepted with the human-approved provider-plugin plan. §3.1/§3.2 stand as the git
provider's rules; they are now one implementation behind a seam
(`src/provider.ts`, contract in [provider.md](provider.md)). The six transport verbs
`runSync` already injected (`GitDriver`) define the provider interface; a second
implementation, `kind: 'treedx'`, transports the same mirror layout over TreeDX's
no-clone HTTP API (`src/treedx/`), selected by the `treedx+<url>/<repo>` remote
scheme (`/chapters-link mode 4`; §12 keys `knowledgeProvider`, `treedx*`). What the
amendment changes in the record, precisely:

- §3.1 holds unchanged: the store is truth, the mirror is transport — in TreeDX
  mode the mirror is a provider-materialized plain directory instead of a clone.
  Search, rules, index build, notice assembly, and the `read` path see no
  difference.
- §5.2's divergence rule generalizes: any head movement detected at pull or commit
  routes through the same rebuild-the-mirror-from-the-store path. Never a merge.
- §2.3's identity rule extends: TreeDX keys derive from the canonical
  `host[:port]/repo` string under a `treedx/` namespace prefix, so a service at a
  git-colliding URL is never the same pool.
- §11.3's blast-radius gate is provider-independent: per-machine rule approval is
  a local curation fact — no server, federated or otherwise, can pre-approve.
- §5.3's degradation semantics are identical, plus one auth class (a rejected
  token surfaces a re-link instruction; it never enters the conversation path).

The TreeDX backend's API-level facts (and what remains [LIVE-GATED] pending a real
container) are pinned in [spikes/treedx/FINDINGS.md](../spikes/treedx/FINDINGS.md);
transport-grade proof runs over the stub service (`treedx-{provider,sync,link}.test.ts`)
and the live exit criterion over `treedx-live.test.ts` when `scripts/treedx-local.sh`
brings the service up.

### Amendment 2026-09-21 — host-injected context is not conversation
Accepted with the same plan (the human directive: the knowledge layer must not
depend on any project's instruction files — every target project ships its own,
unpredictably). The archive guarantee restates: **every byte of the CONVERSATION
remains retrievable** in chapters or artifacts; host-injected context — project
instruction files (`agent-instructions` events and the `instructions from:`
reminder form), the runtime-context snapshot, the skill catalog, and this plugin's
own TOC notice — is re-derivable project state and is EXCLUDED at the render
chokepoint (`src/injections.ts`), each omission leaving a countable marker.
`stats.messages` counts conversation only, so TOC `(N msgs)` stays honest. The
durable session log is untouched by this (invariant: append-only) — originals live
in the parent session; the screen is archive-time bytes, applied before redaction
(§9) at the same chokepoint. The signature layer has applied the same predicate
since r28; the two now share one implementation so they can never drift. The
model-tape masking rule (AGENTS-BLIND, 2026-09-20) is the test-side half of the
same position: development artifacts, never product facts.

### Amendment 2026-09-20 — rule approval is a per-machine curation fact

Accepted as the P3 plan's single decision point (human-approved with the plan). §7.2's
file-status rewrite replaced by `rule-status` facts in each machine's own edits file
(see §7.2 note for the reason). Everything else in §7 stands.

### Amendment 2026-10-10 — plans are documents of a third kind

Human decision, recorded here because it widens the corpus: besides transcript chapters and curated
rules, a workspace's shared knowledge now also carries **plan documents** — one file per
`exit_plan_mode` submission, `kind: plan`, written into `chapters/` so the §4 transport, the §5
mirror and the §6 index carry and rank them with no special casing.

Rules of the amendment, all enforced by tests (verify.md P12–P14):

- **A plan document's body is the plan, byte for byte.** It is never a summary of one, and the
  enrichment ladder (§6.4) refuses to annotate it: a directive is approved text, and paraphrasing
  an order is the drift the whole store exists to prevent. The guard reads the file's own
  `kind: plan` frontmatter, so renaming cannot disarm it.
- **Superseding never overwrites.** A revised plan is a new document; the earlier one keeps its
  bytes and its status changes only in the sense that the newest submission is operative. The store
  stays append-only with no exceptions.
- **Numbering is its own** (`nextPlanNumber`, registry-allocated under a distinct attempt key,
  never a directory scan), so a plan never consumes a chapter number, never reorders the TOC, and
  never collides with a concurrent sibling. Files are `plan-<NNN>-<slug>.md` precisely so a listing
  cannot read as two chapters claiming the same number.
- **Redaction is unchanged and applies identically** (§9): the chokepoint runs over plan text on the
  way to both the blob and the document, so a credential pasted into a plan never reaches the pool.
  The one asymmetry a reader should know: a plan is *deliberately* a human-facing directive, so it
  keeps its own `sha256` (the blob's hash, identical bytes) plus `bodySha256` (the §2.2 anchor
  convention) — two handles, one purpose each, provably the same content.
- **Host-injected context is still not conversation** — but with the one named exception recorded in
  `docs/plans-carriage.md` § 13: the harness's own `plugin: plan-mode / form: notice` mode-flip
  sentence is session state worth keeping, so it archives verbatim. Instruction files, runtime
  snapshots and skill catalogs screen exactly as before, and the topic-signature layer (§4.1)
  keeps the strict predicate so injected text cannot move a chapter boundary.

Design detail and measurements: `docs/plans-carriage.md` §§ 9–13.

### Amendment 2026-10-11 — the index answers at home, and the child is told the verbs

Human directive: *"make sure everything is indexed correctly so that a new session can find the
plans, rules, and other important details when it is asked."* Auditing that claim found the index was
sound and the **access path was not**, in two specific ways — both now closed and pinned:

1. **`chapters_search` required a pool mirror.** With nothing linked it returned an empty list and a
   suggestion to go link a remote — while every chapter, every `kind: plan` document and every rule sat
   in the workspace store, indexable. Search now has two doors over **one shared scorer**
   (`rankEntries`): the materialized mirror when a project is linked, and `buildLocalCorpus` over the
   store when it is not. Deliberate details:
   - **artifacts are not indexed** (they answer to `chapters_artifact`; a blob indexed twice is a second
     index, which §6 forbids);
   - **the door is named in the answer** — "searched this machine's store (N indexed document(s); no pool
     mirror …)" — because a session must never read *this machine only* as *the whole project*;
   - **"nothing matched" and "nothing here" are different results** (`empty` + `documents`), since they
     imply different next actions;
   - if the pool yields nothing, the local store is consulted before answering empty.
2. **The continuation notice taught only `read`.** A child was told chapters exist and how to open one;
   it was never told `chapters_search` or `chapters_artifact` exist. An installed tool that is never
   mentioned is a tool a small model will not reach for, so the notice gains a three-line
   `## Finding things` block naming all three verbs, plus the one fact a child cannot infer — that plans
   are searchable **as plans** (`kind: plan`) and rules arrive from other machines. `retrievalHints`
   (default on) is the switch; off, the notice is byte-identical to the previous shape.

Measured, not assumed: no committed tape contains a seeded notice anywhere in its prefixes (checked
entry-by-entry across the corpus), so the notice change costs no re-record — and the eight-project chain
replays green with it. That is luck of coverage rather than design: no current journey makes a
*continuation child* speak, which is why the child-facing prose is now covered by golden rows here plus
the live-model leg, and why a child that answers a question in a browser is on the open list.

Also landed: **the kernel-drift gate** (`tests/unit/host-seed-contract.test.ts`) — the seeded
`plan/mode` continuation depends on the host knowing that type and treating it as log-only, read from the
kernel's own exported predicates (`KNOWN_SESSION_EVENT_TYPES`, `isSurfaceEligibleType`,
`isAppendSurfaceEvent`) rather than reimplemented, so a kernel change surfaces as a red row instead of a
child that silently stops being gated.

### Amendment 2026-10-20 — rules become two tiers: project (shared, approved) and session (local, derived)

Human directive, in the round that planned it: *"I end up giving the AI agent a bunch of rules
embedded in my requests… these rules just get lost in the noise."* Auditing where they actually get
lost found one concrete hole, not a vague one: the in-place checkpoint composes
`leadSections = [planSection, plotSection]` (`src/engine-core.ts`). **A plan survives a compaction
and a plot survives a compaction; a rule does not.** That, plus a rule set that only ever reaches a
child through the continuation notice with no relevance selection, is the whole motivation.

Six decisions, each narrowing a temptation the discussion produced:

1. **Two tiers, one store** (§7.1). Session rules are `kind: rule` files in the same tree with
   `scope: session` — same numbering, same write-once immutability, same `list`, same index. Absent
   `scope` means `project`, so every rule record on disk before this amendment keeps working with
   unchanged bytes. There is no second rules subsystem to drift.
2. **The global tier was not built, because it already existed.** The request was "carry across my
   checkouts of this repository", and `projectKey` is UUIDv5 over the *canonicalized remote* (§2.3)
   with `harnessId` defaulting to the hostname — so several checkouts of one repo already resolve to
   one rule namespace on one machine. The work became making the four ways that identity silently
   diverges say so (§7.8) instead of inventing a third namespace with a much larger blast radius.
3. **Session activation is derived, never a curation fact** (§7.5). Active iff `scope: session` ∧
   its session is on the current ancestor path ∧ not revoked. `edits/<harness>/curation.jsonl` is
   reserved for human status decisions *and it travels in the pool* — machine-local activation volume
   does not belong there. The 2026-09-20 amendment (approval is a per-machine fact, never a file
   rewrite) is **not** relaxed: it still governs every byte of the shared tier.
4. **Model-captured rules may auto-activate, and only on a verbatim quote** (§7.5, behind
   `rulesEnrichment`, default off — *decided and specified; the P3c build shipped the marker path
   first, so this half is still ahead of the code*). The rejected framing was "the model writes its own governing
   rules with no human gate"; the accepted one is that the machine-local, one-command-reversible,
   never-staged scope makes the blast radius one session tree — so the gate moves from *who clicks*
   to *what the rule is derived from*. An inferred rule with no human sentence behind it waits in
   `list --proposed`. And capture stays off the critical path entirely: the `ADD RULE:` marker is
   deterministic and costs zero model tokens (invariant 1), while the model pass rides §6.2's idle
   batch, because the local server is single-slot and per-turn work queues against the user's own
   turns.
5. **Rules are carried at the moments the head is rebuilt, never injected per request** (§7.6).
   Two measured reasons, not taste: invariant 3 (the system prompt is process-global and
   `systemPrompt` is excluded from our injections on purpose), and the llama.cpp number from
   E3/r23-r28 — a head-position replacement reuses **nothing** (`cacheReuse 0`), so a ruleset that
   churns mid-session is a cache-wipe machine on exactly the target hardware. Between rebuilds the
   human's own bytes are still in the surface; they die only when the surface is replaced, which is
   where they are now re-stated. `chapters_continue` carries both tiers, `chapters_fork` carries
   project only — the *same* `intent` axis that already decides plan bytes (`docs/plans-carriage.md`
   §§ 9–13), not a new distinction.
6. **§7.4 selection is raised from "P3b later" to required, with a floor.** Automatic capture means
   the active set now grows without a human noticing, so always-render-everything stops being
   affordable: pinned (human-set, always) → relevance-selected (the existing `search.rankEntries`,
   never a second ranker) → index-only. Per-tier count caps are **announced**, because selection
   that can silently drop the load-bearing rule would rebuild the original bug inside the fix —
   and a cap that *truncates* would violate §1.2, so the token ceiling still refuses with numbers
   and the count ceiling selects with a visible count. Selection must be a pure function of stored
   inputs (no clock, no readdir order) or two machines disagree about what the agent was told and
   the tape corpus cannot be stable.

Also recorded as accepted consequences: session-scope exclusion happens at the one store→repo mapper
(`planStoreToRepo`) and is proven over **both** providers; a session rule never overrides a project
rule, and conflicts are reported (`/chapters-rule conflicts`, one bounded stream call in the
`elicitedPlot` family) rather than resolved (§7.7); losing a checkout loses its session rules, which
is *re-derivation*, not corruption (§7.5, and the storage warning in `AGENTS.md`); and the agent-
facing surface stays minimal by decision — capture and carriage are invisible to the model, and the
one thing it is told to do is **look the rules up before starting a task** (§7.9), because a tool an
instruction never names does not exist to a small model.

Specification: §7.1 and §7.3–§7.9. Build status and exit criteria: §13 P3c (specified, not yet
built at the time of this amendment — this entry is the decision record, not a claim of behavior).

---

*Cross-references: invariants and the four invariants — `AGENTS.md`; budget math —
`docs/contract.md` (continuation budget) and `docs/architecture.md` (storage); the engine
seam the composer hooks into — `docs/host-compaction-seam.md`; measured claims cited as
`rNN` — `spikes/probe/FINDINGS.md`.*
