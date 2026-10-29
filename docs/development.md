# Development and Test Loop

The problem is real: **this repository is edited from inside a running DeepSeek Harness, and a plugin
only takes effect after that host restarts.** Restarting it would kill the session doing the work. So
the loop has to be built so that it never touches the host it runs in. Everything below was verified on
this machine, not assumed.

## Environment Facts (checked, not inferred)

| Thing | Value |
|---|---|
| Host serving this session | the GLOBAL npm install — but the PREFIX IS NOT PART OF THE FACT. Resolve it: `readlink -f $(command -v dsh)`, then read that package's `version`. On this box today: `/home/adrian/node_modules/@deepseek-ai/dsh`, **0.2.0-rc.2**, listening on `127.0.0.1:3080`. This row used to assert `/usr/lib/...` and `0.1.5-rc.1` as if they were the machine; a drift gate that hardcoded that path then skipped forever while the package sat in the repo's own `node_modules` (#54). |
| Profile root | `~/.dsh` (`DSH_HOME` default) — `profiles/`, `sessions/`, `storages/`, `.credentials.yaml` |
| Sandbox effect | `~/.dsh` is **read-only** from the agent sandbox: `dsh web --help` died with `EROFS: read-only file system, open '/home/adrian/.dsh/profiles/web/cordis.yml'` |
| Dev fork | `~/Projects/deepseek-harness` — git `fb2c4b9e69` (2026-09-10), **0.1.5-rc.2**, pnpm workspace, `node_modules` installed |
| `/app/checkout` | **does not exist on this machine.** It appeared in my *session context* as a presumed harness checkout, not in this repository's docs — I checked, and no file here references it. The real fork is the row above |

Two consequences worth stating plainly:

1. **The sandbox is an ally, not an obstacle.** Because `~/.dsh` is read-only to an agent shell, the
   accidental self-destruct path — installing into the live profile and restarting the host running the
   work — is *structurally unavailable*. The dev loop is the only loop available.
2. **The fork is newer than the host** (rc.2 vs rc.1), and `examples/deepseek-harness` is a third
   snapshot. Line numbers in `docs/contract.md` come from the `examples/` copy. Treat any of the three as
   truth only for the question you asked it; resolve real behaviour against the version you are actually
   booting.
3. **Check the binary you are measuring, not just the code you changed.** #54 lost hours to
   `.dshdev-local/profiles/web/node_modules/@treeseed/dsh-chapters` having become a COPIED tree
   dated six days earlier: every browser journey, probe and re-distill attempt was running a build
   predating the feature under test, and drew confident conclusions about the HOST — including a
   seed-admission refusal the current code does not produce (`tests/e2e/boot.ts` refuses to spawn
   on a copied tree now, and names the re-link command). The general habit: where a built artifact
   is loaded by path, link it or assert its version — an old binary passes every test you write
   against it and reports them as facts.

## The Isolation Mechanism: `DSH_HOME`

`dsh --help` documents profiles as "the profile under `$DSH_HOME/profiles` to boot", and `DSH_HOME`
relocates the entire root — profiles, sessions, storages, credentials. Verified:

```bash
mkdir -p .dshdev
DSH_HOME=$PWD/.dshdev dsh web --port 0 --no-open
# → dsh web: http://127.0.0.1:32869/?token=…
```

A **fresh, fully isolated instance** booted: it created its own `profiles/web` under `.dshdev`, chose a
free port, minted its own token, and left `~/.dsh` and the `:3080` host untouched. `--port 0` means the OS
picks, so nothing conflicts. This is the whole answer: we get a disposable harness.

`.dshdev/` is gitignored. Never point `DSH_HOME` at `~/.dsh`, and never run `dsh plugin --profile web add`
without it — that is the command that mutates the profile this session is living in.

### The dev profile for the real target: `scripts/bootstrap-dev-profile.sh`

Everything so far measured on cloud models; the plugin's target is the user's **Local
qwen3.8-flash-next** at the **64K window the user actually runs** (32K was tried and
rejected as too small for real work — the 27-tool header alone is ~13–15K; the user
confirmed the model is configured for 64K). `dev/settings.yaml` +
`dev/profile-cordis.patch.yml` mirror the live `~/.dsh` Local-provider block exactly —
same model, window (64K, just under the server's real `n_ctx: 65536`), and timeouts — and
make **Chapters the default preset** and **Local the default model**, so nothing there is
"enabled by remembering". The r27 gold run proves the engine's pressure math at this exact
regime (threshold 57,600; a 93K-token session compacts before its first request).
Bootstrap is write-if-missing for your tuned settings; `--force` re-templates. Build + link +
settings + credential-refs copy in one shot:

```bash
scripts/bootstrap-dev-profile.sh            # -> .dshdev-local (browser-safe: no probe)
scripts/bootstrap-dev-profile.sh --with-probe   # scripted rounds only (probe self-exits)
```

### The `dev/install/` platform (three development modes)

`dev/install/` provides a unified installer and containerized platform that replaces ad-hoc bootstrap
for new developers. Three modes, same plugin set (dsh-chapters + dsh-codegraph + dsh-tinyfish-search),
same Cordis configuration mirror:

| Mode | Command | When to use |
|------|---------|-------------|
| **Centralized** | `./dev/install/install.sh && dsh web` | Day-to-day dev on your main machine; modifies your live web profile additively |
| **Compartmentalized** | `DSH_HOME=/tmp/dsh-dev ./dev/install/install.sh` | Isolated testing without touching live sessions; throwaway or persistent alternate home |
| **Containerized** | `cd dev/install && docker compose up -d` | Full stack: vLLM (Qwen3-4B-AWQ, inference + systemone), DSH Web UI, Playwright test runner |

The containerized stack is self-contained — no external API keys required for core operation. The vLLM
service serves two model names (`qwen3-4b-instruct` for inference, `qwen3-4b-systemone` for decisions)
from the same weights, cached in a Docker volume. The test runner mounts the repo source read-only so
edits are reflected without rebuild. Environment variables are read from the parent shell — no `.env`
file needed. See `dev/install/README.md` for full documentation and `.dsh/skills/local-llm/SKILL.md`
for the agent skill covering endpoint usage.

The legacy `scripts/bootstrap-dev-profile.sh` still works for the probe-based isolation loop described
below; `dev/install/` is the recommended path for new setups.

### CodeGraph — structural code search

All three dev modes install `@jiangzhenguo/dsh-codegraph`, which builds an AST-level index of every
symbol and call edge in the project (`.codegraph/codegraph.db`). The agent uses `codegraph_explore`
instead of grep/glob/read to find symbols, understand flows, and trace callers/callees — including
dynamic-dispatch hops that text search misses. Configured with `surface: core` (status/init/sync/explore)
and `frontload: true` (structural context injected into prompts). After editing source, run
`codegraph_sync` so subsequent queries reflect the new code. The index is gitignored and persists
across sessions.

### The `docs/superpowers/` plan directory

The upstream `writing-plans` / `brainstorming` skills (`.dsh/skills/`, from obra/superpowers — see
dev/install README § Skills) default their artifacts to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`
and `docs/superpowers/specs/…`. Those files are **tracked**: they are per-feature design records, and a
later session may re-reference them for the *why* behind an implementation. Two rules keep them honest:

1. A plan is stamped with a `**Status:**` header when its work lands (implemented → commit refs +
   pointers to the shipped code/tests/site docs), so nobody executes a spent to-do list.
2. The durable cross-session record remains the chapters store and `docs/` proper; a superpowers plan
   is a working artifact of one pre-implementation session, not a second index. If it rots into
   contradiction with the shipped code, update or supersede it in place via git history — never rewrite
   silently.

### Is the corpus anchored to the host we pin? (`tests/fixtures/model-tape/CORPUS_HOST`)

Tape matching is normalized request-PREFIX matching, and the prefixes carry the host's
system-prompt composition. So moving `dev/dsh-host-lock`, editing the preset persona, or changing a
tool description invalidates the whole corpus — and a replay failure then describes an *earlier*
change, not the one under review. `scripts/corpus-anchor.mjs` states the provenance in one file and
answers the question in exactly one place; two consumers use it:

- `tests/e2e/boot.ts` **refuses replay by name** when `host` ≠ the pinned version, quoting the
  recorded `reason` and the tracking issue. `E2E_MODEL=record` is deliberately exempt — re-distilling
  is the way out, and a gate that blocked it would strand itself.
- `.github/workflows/ci.yml`'s `host-capability` job sets `corpus-anchored`, the `e2e-replay` job
  requires it, and the run log gets a step summary plus a `::warning::` naming the issue. Skipped,
  visibly — the same discipline as the preset-row refusal it sits beside: never silently green,
  never permanently red.

The gate lifts with no code change: re-distill the eight projects
(`scripts/distill-tapes.sh`), write the new `host =` line, done. Current state: pinned
`0.2.0-rc.2`, corpus distilled `0.1.5-rc.1`, tracked by
[issue #56](https://github.com/treeseed-ai/dsh-chapters/issues/56) (with the door-selector blocker
[#57](https://github.com/treeseed-ai/dsh-chapters/issues/57) inside it). Rows in
`tests/unit/corpus-anchor.test.ts` assert both directions — matching lifts, missing/garbled
provenance refuses, and the committed repo state is reported honestly as NOT anchored.

### Reading a distill while it runs (#54)

`scripts/distill-tapes.sh` writes each leg's FULL playwright output to `var/distill/<proj>-<hhmmss>.log`
(never `tail`, which buffers until the leg ends) and prints a 60-second heartbeat: tape-entry count
plus the last line of `var/e2e-upstream.log`. That journal is the proxy's own record of every upstream
attempt — `START / FIRSTBYTE / STALLED / DONE / DEAD`, with elapsed ms and byte counts — and the proxy
now bounds the wait at `E2E_UPSTREAM_TIMEOUT_MS` (default 600000, 10 minutes: generous for a cold
prefill at the stress regime, short enough that a hung connection ends the run with an answer instead
of silently consuming the harness's own 3600000 ms profile timeout).

So the question "is this turn slow, or is the connection dead?" is a lookup:

| journal shape | meaning |
|---|---|
| `START` then `FIRSTBYTE` | answered; `DONE elapsed=… bytes=…` says how long and how much |
| `START`, `STALLED elapsed=…ms bytes=0`, then `DEAD` | upstream never responded — a hang, not a slow model |
| `START`, `FIRSTBYTE`, then `STALLED … bytes=N` growing | real streaming progress; leave it alone |
| no journal line at all | the request never reached the proxy (boot/port/profile problem) |

### Three test layers (and why the third exists)

| Layer | Command | Runs | Covers |
|---|---|---|---|
| unit | `npm test` (`tests/unit`) | node --test, no build, no network | pure core: registry, render, archive, notice, engine-core, tools, commands |
| integration | (today: probe rounds — see spikes/probe/README pattern) | boots real hosts in scratch homes | host wiring, realm mounts, provider economics |
| e2e (tape — the default loop) | `npm run test:e2e:replay` | same boots with `E2E_MODEL=replay`; model turns answered from `tests/fixtures/model-tape/<project>` via the record/replay proxy (`tests/e2e/model-proxy.ts`) — seconds, deterministic |
| e2e (distillation — occasional) | `npm run test:e2e:record` | `E2E_MODEL=record`: forwards every exchange to the real Local model and appends the tape. Run once per scenario; wipe `var/model-tape` first for a clean corpus; tapes are isolated per project (eight: suite/heavy/arrival/fanout/enrich/rules/fork/plans); re-record when scenarios, prompts, or thresholds change. The GPU model is the DISTILLER, never the test oracle (user directive 2026-09-19) |
| e2e | `npm run test:e2e` (`tests/e2e`, EIGHT projects: suite/heavy/arrival/fanout/enrich/rules/fork/plans) | Playwright + workspace-cached chromium vs a throwaway `var/e2e-home-<port>` rebuilt per boot (port-keyed so no boot can stomp another's state) (isolated from live agents — see FINDINGS 2026-09-19) | the browser: identity, fork button + switch, knowledge loop end-to-end, the oversized turn (mid-turn compactions), the subagent fan-out, arrival-time artifacting (low-floor project) |

The e2e layer exists because client-plane facts were being GUESSED (services, methods, tooltips,
switching) and every guess cost the user a browser round-trip. Playwright answers those in seconds
and its suite is the regression net for all future UI surface. Each project boots through
`boot.ts` (probe bundle removed first — it would otherwise kill the test server mid-suite; per-
project env pins: suite threshold 0.75, heavy 0.5 + arrival floor off, arrival floor 500 at the
production 0.9; homes are port-keyed). `discovery.spec.ts` keeps a health assertion on client-entry
activation, `fork-button.spec.ts` proves the click end-to-end on durable + visible planes, and the
heavy specs pin their claims to DURABLE facts (own-log turn/end, registry chapters, coverage) —
never to model verbosity. ACCEPTANCE DEFAULTS TO THE TAPE (`test:e2e:replay`, model turns served
from `tests/fixtures/model-tape/<project>` in seconds — explore: 14.7 s replayed vs 1.7 min live); the live
chain remains the distiller (`test:e2e:record`) and the ultimate witness. AGENTS-BLIND
masking (user decision 2026-09-20, reaffirmed 2026-10-01 with no exceptions): the tapes
stand in for ANOTHER project — a workspace docs edit (AGENTS.md, skill catalogs) NEVER
requires a re-record. The delimiter mask strips injected doc blocks from matching on both
sides, and a compaction summary that paraphrases doc prose (observed 2026-09-23 in
`heavy`/`fanout`) rides the tape as recorded model output — replay-side requests never
regenerate it, so committed tapes stay green across doc edits. Never gate a doc edit on
a distillation.

Re-record discipline (learned the hard way 2026-09-22/23):
- **A tape records the CONTEXT it was distilled in.** A spec replayed in a different
  predecessor set (or a different boot port before HOSTPORT-BLIND landed) sees different
  injected presence and misses. Re-record the whole project, not a single spec, when specs
  share a boot — and never run two GPU-consuming suites concurrently (RR2=137 + timeout
  cascades: a fanout that passes alone failed at 1.1 h while a heal chain shared the server).
  **Home freshness is part of the context** (measured 2026-09-29): the host injects
  skill-catalog-changed and runtime-context snapshot notices on the FIRST boot against a
  fresh/absent throwaway home. Distilling against a stale home produced a tape without those
  messages that a pristine replay then demanded — structural message-count divergence, which
  no content mask can bridge. Discipline: `rm -rf var/e2e-home-<port>` before RECORD and
  before the verifying REPLAY, so both sides saw the same boot world. Hosted CI is inherently
  pristine: a locally-distilled tape that passes only on an accumulated home is a red flag,
  not a pass.
- **Ports are parameterized end to end**: the model proxy derives `E2E_PROXY_PORT = boot port
  + 1000` (a hard-coded 41799 turned one killed run's orphan into EADDRINUSE for every later
  boot), and `boot.ts` fails FAST with a named-port message when the boot port is already
  owned (an orphan's silence cost 20+ minutes of opaque hangs). Kill leftovers:
  `pkill -f "dsh web --port 417"`.
- **The tape's matching is normalized on BOTH sides** — legacy stored prefixes are re-run
  through `substituteAll` at load, so a new volatile rule (HOSTPORT-BLIND, `e2e-home-\d+`)
  repairs older tapes without a re-record. Prefer that route over distilling again.
- **When a browser scenario fails, suspect its own tooling before the product.** The
  parked-for-eras `rules` e2e was a spec reading zstd-compressed directories as flat files
  (fixed 2026-09-23 with the session.ts `zstd -dc` route + dynamic rule-id capture); the
  enrich e2e exposed two REAL product bugs (the frontmatter-anchor convention mismatch and
  the missing host-plane route) that every deterministic layer had missed because each side
  only ever tested against its own convention. The e2e is the integration witness — keep it.

### The coverage ledgers (added 2026-09-23 by the coverage audit; gated same day)

- `npm run coverage:ci` — **the gate CI enforces.** `c8 --check-coverage
  --statements 85 --branches 85 --functions 85 --lines 85` over the whole
  deterministic suite (unit + integration in one process graph; live TreeDX
  rows self-skip when the container is down, so it passes on a runner with no
  TreeDX and no LLM). Below any threshold it exits non-zero; the report lands
  in `var/coverage/` and the summary is posted to the CI job page. Current
  ledger: **97.98% stmts / 85.61% branch / 93.62% funcs** across 450 tests.
  The branch number is the binding one (defensive `??`/ternary arms dominate
  the miss count); it is deliberately kept above 85 by the `*-branches.test.ts`
  sweep files rather than by lowering the bar.
- `npm run coverage` — the same deterministic suite under node's native
  `--experimental-test-coverage` (a quick second opinion; no gate).
- `npm run coverage:e2e` — replays the **nine** browser segments with
  `E2E_COVERAGE=1`, which makes every boot write NODE_V8_COVERAGE profiles
  under `var/e2e-cov/<port>` (flushed on the boot's clean exit), then runs
  `scripts/e2e-coverage.mjs` → **c8 with real source maps** (tsconfig
  `sourceMap: true`; lib/*.js maps back to src/*.ts) for istanbul-grade
  per-module Stmts/Branch/Funcs. Read it as "covered by SOME boot of the
  suite" (a union), and mind the script header's c8 gotcha: include/exclude
  filters apply BEFORE remapping, so `--include=src/**` would silently
  zero every row.
  **Ledger, re-measured 2026-10-23 on the PINNED hermetic host (`97c7c79`, strict replay
  rc 0 / zero misses, all nine segments): 78.26% stmts / 59.01% branch / 71.38% funcs.** Per module:
  engine.ts 87.93/55.06, index.ts 85.78/52.43, rules.ts 88.83/58.87,
  store.ts 91.64/79.59, continue-core.ts 94.05/66.66, arrival.ts 94.87/60.60,
  sync.ts 83.95/59.89, tools.ts 64.06/49.66.
  **This is a slip, stated as one:** the 2026-09-25 ledger read 80/62 overall
  (tools 72/49, engine 81/59, index 86/55). Statements and branches both went
  DOWN while engine's statement coverage rose — because the re-anchored legs
  are shorter, not weaker: `heavy` replays in 4 tape entries (2 compaction
  triples, and it now answers) where the old corpus carried 16–22, and a
  shorter conversation walks fewer engine arms. Nothing here is gated — the
  gated ledger is `coverage:ci` at 85/85/85/85 on the deterministic plane —
  so the honest reading is: *e2e coverage tracks how much conversation the
  corpus replays, and a faster-converging corpus covers less of the engine by
  accident.* Recovering the number means adding breadth deliberately (more
  distinct journeys, or longer ones with their own claim), never padding a
  leg to fatten a percentage.
  Both ledgers together are the coverage claim; neither alone is honest.

### Release status (measured 2026-09-25)

`@treeseed/dsh-chapters@0.1.0` is LIVE on npmjs.org — published manually from
the CI-verified tag (`npm publish --access public --provenance=false`; the
registry shasum matches the CI tree byte-for-byte, install-smoke green).
Manual because the Production environment's NPM_TOKEN cannot CREATE a
package it is not scoped to (E404 = granular-token scope limitation, not a
secret problem) — and that whole class of auth is now gone: **CI publishes
run on npm TRUSTED PUBLISHING (OIDC)**. release.yml carries no token;
setup-node gets `registry-url` but never a `token:` (any `_authToken` in an
npmrc overrides the OIDC path), `id-token: write` is the credential, and the
npm side must register this package's Trusted Publisher as: repo
`treeseed-ai/dsh-chapters`, branch `main`, workflow `release.yml`,
environment `Production`. Prerelease versions publish under a matching
dist-tag so 'latest' stays stable. `0.1.1` is the first OIDC + provenance
ship; `0.1.0` itself carries no attestation.

### Hosted CI
**The rig writes into its own port's store, never the project's (#61 item 8).** Each boot pins
`artifactStoreRoot` to `var/e2e-home-<port>/chapters` through the profile patch
(`tests/e2e/boot.ts::applyRigPluginPatch`), and CI brackets the replay job with
`scripts/assert-store-untouched.mjs snapshot` / `verify` — a listing comparison (names, sizes, mtimes)
that fails the job if the production `.dsh-chapters/` changed, including the pristine-runner case where
the store did not exist and a run CREATED one. Before this, every acceptance run left its chapters in the
repo's real store: 42 test trees and 29 of 47 live registry rows with e2e-shaped ids, which #60's auditor
then reported as 441 `test-litter` findings. Contamination like that does not just waste disk; it teaches
people to ignore a report that is telling them the truth about something else.
 (`.github/workflows/`, wired + dress-rehearsed 2026-09-23)

- **`ci.yml`** — two jobs. `test`: `npm ci` (all deps public on
  registry.npmjs.org — **no install secret**), typecheck, build,
  `bash scripts/ci-gate.sh` (the 85/85/85/85 gate — since 0.1.6 the gate
  ANNOTATES its own failure: metric lines, the pass/fail tally, up to 24
  failing-test lines and c8's threshold verdicts as `::error::`, because on the
  0.1.6 tag a red gate left nothing behind but "exit code 1" while every local
  reproduction of the same SHA was green; the summary step now runs
  `if: always()`). `e2e-replay`: materializes the pinned host from
  `dev/dsh-host-lock` (`npm ci`, hermetic — `npm i -g` rewrites the plugin tree and the
  host's caret ranges float), plus chromium's apt libs, then `scripts/ci-replay.sh`, which
  READS the version out of that lock rather than repeating it (#54 removed the second
  literal; three copies of a pin is how it goes stale in three places) — eight browser
  segments served entirely from the committed tapes. **No LLM, no key, no GPU:** in
  replay mode `localModelUp()` short-circuits to true (specs RUN, they do not
  skip) and a tape miss is a loud proxy 503, so a scenario that legitimately
  changed fails the job instead of silently passing.
### Distilling tapes WITHOUT the GPU box (#54)

`E2E_MODEL=record` drives the real model once per scenario to make a tape. Until #54 that
meant the local vLLM server had to be up. It no longer does, because the tape proxy
translates on the way out instead of asking the fixture to change:

```bash
E2E_MODEL=record E2E_TAPE=rules E2E_PORT=41735 E2E_THRESHOLD=0.9 \
  E2E_UPSTREAM=https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode \
  E2E_UPSTREAM_MODEL=qwen3.8-flash PLAYWRIGHT_BROWSERS_PATH=$PWD/var/ms-playwright \
  E2E_UPSTREAM_KEY="$(node -e "import('./scripts/llm.mjs').then(m=>process.stdout.write(m.apiKey()||''))")" \
  npx playwright test -c tests/e2e/playwright.config.ts --project=rules
```

- `E2E_UPSTREAM` is the endpoint WITHOUT the `/v1` suffix (the proxy appends the request
  path, which already carries it).
- `E2E_UPSTREAM_KEY` is the credential the PROXY presents. The profile keeps `apiKeyEnv:
  LOCAL_API_KEY` and the boot still injects its `e2e-tape-proxy-dummy` when none is
  configured — a real secret never enters a fixture profile.
- `E2E_UPSTREAM_MODEL` rewrites the requested id, so the profile can keep pinning
  `qwen3.8-flash-next` (the 32K stress-regime name) while a hosted endpoint is addressed by
  the id it serves. **The tape records the profile's name**, because a tape is a fixture of
  this rig, not of whatever service distilled it.
- A remote `E2E_UPSTREAM` in record mode with no key refuses at boot in one line, instead of
  discovering it 401 times across eight projects.
- `scripts/llm.mjs` is the same resolution the dev scripts use (local server preferred, hosted
  fallback, credential resolved from env → key file → profile export → harness store, value
  never printed).

Three 0.2.x host drifts the first boots found, all rig-side, all now handled — each is the
kind that produces a wrong conclusion instead of an error:

1. **the durable log is `session.v4.jsonl.zstd`.** Five places hardcoded `session.v3…`, so
   every log-backed assertion decoded nothing and reported "the archive never landed".
   `sessionLogFileFor()` resolves the highest `session.v<N>.jsonl.zstd`; a row scans
   `tests/e2e/` for a hand-built versioned path (comment lines excluded — prose may name the
   formats it explains).
2. **the host opens a Preview Notice, and it is a focus trap** — the 2026-09-18 saga with a
   new member. Dismissal now targets `[role=dialog]`-shaped elements and presses the control
   that acknowledges *that* dialog; matching "any div mentioning a notice" matched the app
   wrapper and pressed an unrelated 'Close'.
3. **provider config must ride `cordis.patch.yml`.** A profile-dir `settings.yaml` is read by
   nothing on 0.2.x, so `dev/settings.yaml`'s `llm-pi-ai` block was invisible: the host had no
   `local` provider and the browser opened on "Add an API key to get started" with the
   composer never reachable. `dev/profile-cordis.patch.yml` now defines the provider, and
   `tests/e2e/boot.ts` guarantees the block in the copied home before rewriting the window
   pins and the proxy `baseURL`.

- **`release.yml`** — bare-semver tag (`0.1.0`, matching the Production
     environment's `*.*.*` tag protection) or manual dispatch → the full
     gated deterministic suite as publish blocker → `npm publish
     --provenance`. Two token facts learned the hard way (measured on the
     first ship): the token must be written into the file npm actually reads
     (setup-node exports `NPM_CONFIG_USERCONFIG` — `~/.npmrc` is ignored),
     and the FIRST publish of a new package name needs a granular token with
     'Read and publish' over ALL packages (a package-scoped token 404s — it
     cannot be scoped to a package that does not exist yet; narrow it to
     `dsh-chapters` after the first ship).
  --provenance`. Auth path B is OIDC trusted publishing (no long-lived
  secret); path A uses `NPM_TOKEN` if configured.
- The dress rehearsal on a pristine machine caught three real blockers, all
  fixed and pinned: (1) `bootstrap-dev-profile.sh` refused the comments-only
  `cordis.patch.yml` scaffold that `dsh plugin add` lays down on a fresh home
  — the guard now only protects patches with real entries; (2) a credential-
  less home boots but every session dies composing the local provider —
  tape-mode boots now inject a dummy `LOCAL_API_KEY` (the proxy ignores
  auth; a real env key always wins); (3) **a fresh home has no registered
  workspace**, so the UI's New-session draft never commits — every browser
  spec dies at `newSessionWithTurn` (this had been masked for weeks by
  accumulated state in the dev home — the exact class of drift CI exists to
  catch). The bootstrap now seeds `storages/workspace.json` (exact host
  schema: ISO dates, `updatedAt`, registered path = the checkout) when absent.

### Safe default guard

Prefix every harness command with `DSH_HOME=$PWD/.dshdev` — or do not type it at all:
**`scripts/dsh-scratch.sh` is that wrapper** (`--home .dshdev2` for a parallel profile; it refuses any
resolved home under the real `~/.dsh` and execs `dsh` with `DSH_HOME` exported).

This stopped being advice the hard way: during Stage 0 a bare `dsh plugin --profile web add ...` (no
`DSH_HOME`) targeted the LIVE profile — the sandbox's read-only `~/.dsh` turned it into a harmless
`pnpm failed` and the live `package.json` mtime proved nothing was touched, but "the sandbox protects us"
is not a guard rail. Any future command form that can reach `~/.dsh` must route through the wrapper.

## Test Layers

Adopted from how the reference plugins actually iterate (they mostly *avoid* restarting the host):
`dsh-session-fork` has ~8,000 lines across 28 `bun test` files and **every test file header says "no
cordis"** — logic takes an injected `Ports` interface and only `makePorts(ctx)` touches the kernel. Copy
that shape, and fix its one gap (§L1).

### L0 — Pure logic, no cordis, no harness

Ranges validation, the chapter renderer, TOC assembly, budget math, slug/number allocation. Fast, CI-able,
no DSH at all. Structure for it from day one:

```ts
// src/continue.ts — no cordis import anywhere in this module
export interface ContinuePorts {
  readSession(id: string): Promise<SourceLog | null>
  createContinuation(opts: { sessionId: string; seed: readonly SessionEvent[]; cwd?: string }): Promise<void>
  reserveNumbers(key: string, count: number): Promise<number[]>
  putRegistry(state: SessionState): Promise<void>
}
export async function runContinue(ports: ContinuePorts, args: ContinueArgs): Promise<ContinueResult>
```

`src/index.ts` is then the **only** cordis-facing file — a thin adapter, deliberately untested.

### L1 — A *stateful* seed fake (where the reference plugin fell short)

`dsh-session-fork`'s `createChildFromSeed` fake records `cut` as a number and validates nothing: it proves
*which* port calls happened in *what* order, never what the kernel does with a seed. Our seed is one
synthetic event, so a ~30-line fake can close that hole cheaply — **materialize** the seed and assert:

- seqs contiguous from `0`, our notice at `seq = 0`
- `surfaceOp: 'append'`
- `inheritedEventCount` equals `seed.length`
- the message source we emit is inside the kernel's accepted vocabulary

That last bullet is `dsh-session-fork`'s most expensive lesson: a retired message source **bricked 66
stored logs** which then refused to load, and they now pin the rule in a `format-watch` test because the
validator isn't published. Our TOC is a synthetic `user/message` — pin the vocabulary test *first*, not
after a chain of corrupted session files. Their `replaySurface()` idea (re-fold the durable log, assert it
equals the live surface) is the right invariant to steal wholesale.

### L2 — Boot-time probe in an isolated profile → **this is how Phase 0 runs**

No LLM, no tokens, no HTTP driving, no restart of anything:

1. Write the probe as a minimal plugin whose `apply()` runs the experiment during boot and writes JSON
   facts to a file in the workspace.
2. Install into the **scratch** profile. `dsh plugin add` runs pnpm and may reach for the network; if it
   does, bypass it by symlinking the package into `.dshdev/profiles/web/node_modules/` and adding its id
   via a `--patch` overlay (`dsh --patch <file>` applies an extra patch layer at boot).
3. `DSH_HOME=$PWD/.dshdev dsh web --port 0 --no-open`, let it boot, read the JSON.

Phase 0 questions it answers: is an unseeded/one-event-seeded `agents.create` durable, listed, and
resumable; does `Session.create` accept the seed; does workspace attach work; does the child's header match.

### L3 — Headless one-shot with a real model (only when a measurement needs it)

`dsh --profile headless "…"` boots a profile, answers one task, prints, and exits — scriptable. The
headless bundle emits JSON with `usage.cacheReadTokens`, which is the only way to get the cache numbers
G1–G3 in `docs/verify.md` without a browser.

Costs real model tokens and needs credentials: `$DSH_HOME/.credentials.yaml` is *inside* the relocated
root, so a scratch home starts unauthenticated. **Copying the user's credentials into a scratch root is
their call — ask before doing it, and ask before spending tokens on a measured run.** Prefer L0/L1 for
correctness and reserve L3 for the few numeric assertions.

### L4 — Upstream drift pins

The habit that lets you iterate against a moving host without booting it: text-pin what you depend on in
the *installed* bundles and fail loudly on drift.

- `parity`-style: run the real published package against any vendored copy of its logic.
- `upstream-watch`-style: assert literal call sites still look the way our assumption says (e.g. that
  `session.fork` still seeds with `events.slice(0, cut)` — the fact invariant 2 rests on).
- `vendor`-style: pin `file:line` + SHA markers in a header comment and assert they still exist.

On failure, the procedure is *re-read upstream and re-anchor*, never "relax the assertion".

## Speed Notes — What Made This Fast

Learned while running eleven probe boots. Each is a concrete loop improvement, not a preference.

**One env var is the whole isolation story.** `DSH_HOME=$PWD/.dshdev` cost nothing to adopt and removed
the restart problem entirely. Every harness command in this repo should carry it — wrap them in
`scripts/` or a `Makefile` so the bare form never appears in a doc or a shell history.

**Failures before the provider are free.** Round 10's every turn errored on `{{model}}` assembly and
spent **zero** tokens. A probe that fails early costs a boot, not a bill — which means it is cheap to
probe aggressively and wrong. Prefer a probe that might error over reading five more source files.

**Plain `.js` probes beat a build step.** The spike needed no TypeScript, no `tsc`, no `lib/` output:
write `lib/roundN.js`, point `package.json` `main` at it, boot, read JSON. Ten seconds of edit-build-test
with no compile errors to fight. Keep the *real* plugin in TypeScript; keep the *spike* in JS.

**Reading the host's own session logs is the fastest source of truth.** `~/.dsh/sessions/<projectKey>/<id>/session.v3.jsonl.zstd`
shows exactly what a real `user/message` looks like, which `source.kind` values are in play, and how large a
request header actually is — all without a model call. Two gotchas that each cost a cycle:

- `zstd -dc <path>` **fails** on these paths: they begin `--home-…` and are parsed as flags. Use
  `zstd -dc -- <path>`.
- Paths are bucketed by `projectKey(cwd)` (`session-persistence-jsonl/src/format.ts:224`), so a project
  directory is encoded with `-` separators, e.g. `--home-adrian-Projects-dsh-chapter-fork--`.

**`Function.prototype.toString` is useless on the bundled host** — service methods report
`function () { [native code] }`. Do not plan to discover signatures by introspection; grep the
`examples/deepseek-harness` checkout instead. Three signatures cost one wasted boot each when guessed:
`listSessions(signal?)` is **positional**, `agents.resume({ resumeSessionId })` is an **options object**,
and `create` needs `agentOptions` plus a preset.

**TypeScript tests run with zero install and zero build — use this before reaching for vitest.**
`node --test tests/unit/*.test.ts` executes `.ts` directly on Node 24 via type stripping, so the pure core
(`src/render.ts`, `src/types.ts`) is covered by 15 tests in ~135 ms with **no `node_modules` at all**. That
keeps the L0/L1 layer free: no dependency resolution, no bundler, no config, and it works inside the agent
sandbox where an install may not. `npm test` is wired to it.

Reserve the vitest/bun decision for when kernel-facing mocks need more than Node's runner gives, and note
that `npm run typecheck` **does** need `typescript` + `@types/node` installed — a separate step from
testing, deliberately not taken yet.

**Keep probe turns tiny.** `Reply with exactly: ALPHA. No explanation.` finishes in one step and a few
tokens, so a measurement that needs five real turns still costs pocket change.

**Instrument the metric, not just the code.** The cache numbers only became readable once the formula was
pinned: `totalPrompt = inputTokens + cacheReadTokens`, `hit = cacheReadTokens / totalPrompt`. Dividing by
the uncached delta instead produces values like 1721% and quietly wrong conclusions — which is exactly what
happened in these notes before it was caught.

## Implementation Status (kept current)

| Layer | State |
|---|---|
| `src/types.ts`, `src/render.ts` — pure chapter renderer, ranges, fence safety, artifact deferral | **done**, 15 tests |
| `src/archive.ts` — reserve→write→verify ordering, dedup, idempotent retry, coverage, tamper detection | **done**, 11 tests |
| `src/notice.ts` + `test/notice.test.ts` — TOC-notice builder, kernel-rejection reproduction, vocabulary pins + drift guard (Phase 0b check 5) | **done**, 10 tests |
| `src/registry.ts` + `src/store.ts` — pure numbering/ancestry/plan state; zod domain spec, storage-domain + node-fs adapters | **done**, 13 + 7 tests; durability witness passed |
| `src/engine-core.ts` + `src/engine.ts` — ChaptersCompactionEngine | **done & boot-proven** (r18/r19: realm subpath row mounts; real cascade finalizes; catch-path fix — FINDINGS § Phase 1) |
| preset delivery | **0.1.18: the preset IS a declaration row** — `preset-chapters` in `cordis.patch.yml`, mounted by `@treeseed/dsh-chapters/preset` (`src/preset.ts`), which registers what the host can load and drops what it cannot. The `presets/chapters/` + copy-on-boot mechanism is deleted with the 0.2.0 floor. Verify.md P24 (rows + three-host boots) |
| `npm test` (unit + integration) | **188 passing, <2 s** — unit imports no harness services; integration runs the sync loop against a fake git driver AND a real git smart-HTTP server (git-http-backend on loopback; the git binary is test-only scaffolding, the product stays pure-JS) |
| 20-check verify.md pass | **r26/26b**: 18 mechanical on `.dshdev2` (refusals with numbers, tamper marks, idempotent retry, cross-boot registry + resume); human rows per verify.md evidence map |
| dsh-session-fork coexistence | **moot at this version** (r26a pair-boot): the example fails to boot the installed host ALONE (unguarded `webServer` read in the installed dsh-client-connection) — assumed-neutral until a version-matched pair-boot |
| `scripts/dsh-scratch.sh` | **done** — refuses any DSH_HOME under the live `~/.dsh`; the near-miss is in FINDINGS |
| `chapters_segment` / `chapters_continue` / `chapters_fork` tools (`src/tools.ts` → `continue-core.ts`) | **done & boot-proven** (r22 9/9 full loop incl. child read-back; r24 fork siblings reserve nothing; r25 durable title; r26/26b checklist pass) |
| E3: header cache across a compaction | **measured, per-machine (r23 cloud, r28 local)**: cloud held 7,424 cached across the replacement (refill 13,658 → ~7,000); local llama.cpp reuses NOTHING across a head replacement (0 cached) but steady-state turns cost only the new content. Never quote one machine's number for the other |
| Fork + Continue buttons | **shipped** (client bundle + slots; `remote.commands` trigger — `connection.rpc.handle` from a plugin is broken on this host, r26a; the buttons ride the command path instead). Both deterministic doors are rows over ONE client runner (`src/client/doors.ts` + the `DOOR_ACTIONS` table): `/chapters-continue` shipped as a composer command only, so its child was created correctly with no visible affordance |
| Long-context mechanics (architecture amendments) | **built + verified**: arrival-time artifacting (`src/arrival.ts`, `chapters_artifact`; e2e artifact-arrival green — 373KB book never prefilled, cache intact) and plot carriage (persona PLOT: + elicited fallback); e2e = 7 specs / 2 projects on a throwaway per-boot home (188 unit/integration) |
| Knowledge layer P1 (record §13) | **complete**: project identity, redaction, live turn signatures, topic-sequential composition (fork proven live, r36; engine wired, r29), sharded index + incremental manifest, `chapters_search`, `/chapters-link`+`/chapters-status`+notice v2 (Project line, `(N msgs)`), the sync loop with §5.3 local-only degradation + diverged-rebuild, both schedulers and all §5.1 triggers wired. 9/9 live (r35j) + the two-machine exit criterion PROVEN as a browser journey (e2e suite green 2026-09-18) (composer→real remote→machine B searches) |
| Topic mapping (composer) | **live-verified at the fork (r36)**: same-topic turns merge into one chapter on real signatures; topic changes split; pressure fragments stay legacy (measured, documented §4.2/4.3 + FINDINGS r28-36) — engine composition (r29) waits for deep selections |
| `npm run typecheck` / `npm run build` | **working** — typescript 5.9 + @types/node + host packages as devDeps; `.ts`-import convention kept via `rewriteRelativeImportExtensions` |

Two bugs the pure tests caught that would have been expensive later, which is the argument for this order:

1. `coverage()` started its cursor at the first chapter, so a chapter set that skipped the **opening** of a
   conversation reported no gap — silent history loss, exactly the failure the plugin exists to prevent.
2. Substring assertions against `/chapters/` matched the store root `.dsh-chapters/` first. Worth knowing
   as a general hazard: **the default store root name contains the word `chapters`**, so any path matching
   in real code must anchor on the separator.

## Unavoidably Manual

Say it rather than pretend the suite covers it:

| Needs a human | Why |
|---|---|
| Sidebar listing and visual resume of a continuation | no client-side harness reaches the real module loader contract |
| Cache/prefill economics across process generations | inherently multi-process; a restart recomposes every header |
| TOC readability and whether the model actually reloads chapters | judgement about prose and behaviour |
| The Phase 0 verdict itself, read from probe output | L2 produces the facts; a human confirms the interpretation |

## The TreeDX dev loop (knowledge transport provider #2)

The TreeDX transport (`src/treedx/`, contract in `docs/provider.md`) is developed against an
**in-process stub service** — `tests/integration/treedx-stub-server.ts` — which is part of the
normal `npm test` loop (real HTTP on loopback, no docker, ~400 ms). The stub's semantics are
the documented ones (bearer 401, one writable lease per branch, fail-closed moved-base commit,
UTF-8 1 MiB File cap); when a real service disagrees, the live test below catches it and the
stub changes to match — never the other way.

The real service, for the exit-criterion run:

```bash
# the HOST user drives docker (the agent sandbox has the docker group stripped; its
# HTTP view of the booted service is fine — that is where live tests execute from)
scripts/treedx-local.sh up                     # builds examples/treedx (dev target); FIRST BOOT compiles the Rust NIF — minutes
scripts/treedx-local.sh token                  # dev-token (30d), writes var/treedx-dev.env (gitignored, 0600)
scripts/treedx-local.sh smoke                  # the six-step transport walk via curl
node --test tests/integration/treedx-live.test.ts   # the §13 exit criterion over the real API
scripts/treedx-local.sh down                   # stop; the data volume persists (down -v wipes)
```

`treedx-live.test.ts` skips ONLY when unconfigured (no env, no `var/treedx-dev.env`):
configured-but-unreachable FAILS loudly — the skip flag is decided at load time, and a
test that silently declines to witness after being told to run is broken tooling (a real
bug class caught 2026-09-21, by the human, by running it). Proven live 2026-09-21:
6/6 live tests green, full suite 286/286 with zero skips.
`dev/treedx.compose.yaml` exists because the cloned repo's own `compose.yaml` is bound to the
Treeseed platform network + connected auth and will not boot standalone (measured; recorded in
`spikes/treedx/FINDINGS.md` §Environment). The cloned checkout under `examples/treedx/` is
gitignored reference material — the live loop works from any path via `TREEDX_LOCAL_*` overrides.

## Command Reference

```bash
# disposable instance — prefer the wrapper (DSH_HOME is its problem, not yours):
#   NOTE: .dshdev mounts dsh-chapters-probe, whose rounds process.exit when done — fine for
#   scripted one-shot boots, WRONG for an interactive test (the server dies seconds after the
#   URL prints). Manual testing belongs to .dshdev2 (plugin only; probe removed 2026-09-17).
scripts/dsh-scratch.sh web --port 0 --no-open                    # .dshdev (probe home)
scripts/dsh-scratch.sh --home .dshdev2 web --port 0 --no-open    # clean home for the real plugin

# manual form, if the wrapper is unavailable:
mkdir -p .dshdev
DSH_HOME=$PWD/.dshdev dsh web --port 0 --no-open

# inspect the composed bundle tree of a profile without booting it
DSH_HOME=$PWD/.dshdev dsh --profile web --dump-config | head

# add our plugin to the SCRATCH profile only
scripts/dsh-scratch.sh --home .dshdev2 plugin --profile web add "link:$(pwd)"

# one-shot headless run (needs credentials in the scratch root; costs tokens)
DSH_HOME=$PWD/.dshdev dsh --profile headless "list your tools"

# unit tests
bun test        # or vitest — decide in Phase 0, see docs/architecture.md § Open Questions
```

**Never** run `dsh plugin --profile web add` or `dsh web` without `DSH_HOME=` set to the scratch root:
that is the profile and port this session is running on.

## Correction to Earlier Claims in This Repo

Two things I asserted before checking, now that they are checkable:

1. **"`dsh web` runs in a tmux pane on the dev fork at `/app/checkout`"** — wrong for this machine. There
   is no `tmux` binary and no `/app/checkout`; the harness serving this session is the global npm install
   on `:3080`. The dev fork is `~/Projects/deepseek-harness`.
2. **An isolated instance's port.** I first reported `34159` from a garbled read; the actual boot printed
   `32869`. The curl to `34159` failing was the tell — it was my number, not the server's.

Both are worth recording rather than quietly fixing, since the whole point of this file is that its
commands were *verified*.

## Suggested Additions to the Other Docs

`docs/contract.md`'s file:line citations are from the `examples/` snapshot (rc.1-era), not the rc.2 fork —
re-anchor them against whichever version a test actually boots.

### Running the TS tests on this box (node 22, no native type stripping)

Measured 2026-10-16: `npm test` (`node --test tests/unit/*.test.ts`) needs node ≥ 23 for type
stripping, and this machine's `/usr/bin/node` is **v22.22.1 compiled WITHOUT TypeScript support**
(`ERR_NO_TYPESCRIPT`, not merely a missing flag). The package's `engines` floor is node 24, and CI
installs it; locally, run the same files through `tsx`:

```bash
npm install --no-save --no-audit --no-fund tsx unrun     # both, in ONE command
node --import tsx --test tests/unit/*.test.ts tests/integration/*.test.ts
npx c8 --check-coverage --statements 85 --branches 85 --functions 85 --lines 85 \
  node --import tsx --test tests/unit/*.test.ts tests/integration/*.test.ts
```

Two traps measured while finding that:

- **`npm install --no-save A` then `--no-save B` removes A.** npm prunes what is not in the manifest,
  so unsaved helpers must be installed in a single command (`unrun` disappeared the moment `tsx` was
  added, and `npm run build` — which bundles the client through `tsdown` — failed with
  `Cannot find module "unrun"`).
- `tsconfig.test.json` (committed) transpiles `src` + `tests` to `var/tsbuild` with `--noCheck` for
  the rare case you want emitted JS instead of a loader. It is NOT how the suite is meant to run;
  tests import `.ts` sources directly and are not typechecked by design (`npm run typecheck` covers
  `src/` only).

Never fix a missing test runner by editing the tests. The suite is the contract; the runner is local.

### Verifying against a host version that is not the installed one

A preset/delivery change must be proven on EVERY host release the package claims to serve, and the
installed host is one data point. Recipe measured 2026-10-16 (this is how 0.1.17 was verified on
0.2.0-rc.2, 0.2.1-alpha.4 and the pinned 0.1.5-rc.1 in one sitting):

```bash
# 1. a second host, installed as its own tree — never over the running one
mkdir -p var/host-versions/a4 && cd var/host-versions/a4
echo '{"name":"a4-host","private":true,"dependencies":{"@deepseek-ai/dsh":"0.2.1-alpha.4"}}' > package.json
npm install --no-audit --no-fund           # ~1 min, 616 packages
# 2. a THROWAWAY home for it (profiles/web/package.json listing the bundles + this plugin),
#    then boot THAT bin with DSH_HOME pointed at the new home:
DSH_HOME=$PWD/var/a4-home DSH_CHAPTERS_WITNESS=$PWD/var/a4-home/w.json \
  node var/host-versions/a4/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 0 --no-open
```

The witness JSON is the answer — `presetRegister`, `presetDroppedRows`, `presetRoster` and
`presetInventoryRows`/`presetUnusableRows` say what a log line only hints at, and `presetUnusableRows: []`
is the assertion that the composition actually ACTIVATES rather than merely being declared.

Three traps, all paid for:

- **Never symlink a host tree into an npm-managed profile's `node_modules`.** `npm install` treats what it
  does not recognize as extraneous and **deletes it through the link** — it ate a 500-package host closure
  this way ("the closure is gone, `ls` returns nothing"). Copy instead (`cp -r`), or point the boot's own
  installation anchor at the other tree and install ONLY the plugin into the profile.
- **`npm pack` + install-from-tarball, not `file:`-linked sources.** The artifact users get is the packed
  `files` list; a linked working tree hides a missing `files` entry (e.g. an asset the preset needs).
- Boot with `timeout 45 …` and read the exit code: **124 means it stayed up** (healthy), `1` means the
  plugin tree refused to load. A crashed boot and a slow boot both print to the same log; the code is the
  difference between "no preset" and "no harness".

Prune after: `var/host-versions/`, the throwaway homes and `var/coverage` are all regenerable in minutes and
together cost ~2 GB — this repository's contract is the *measurements written down*, not their scratch.

### The rig's regime has ONE table (`tests/e2e/rig-pins.ts`) — added 2026-10-23 (#56)

Three copies had silently diverged: `scripts/distill-tapes.sh`'s `THRESH`/`EXTRA` tables, the inline
env in `npm run test:e2e`, and `boot.ts`'s defaults — under a comment claiming distill "mirrors
`npm run test:e2e`'s pins exactly". Measured result: replay booted `suite`/`rules`/`fork` with **no
threshold** while their tapes had been recorded at 0.75/0.9/0.75. The realm differed, replay's requests
carried `[dsh:artifact …]` stubs the tapes contain none of, and the chain failed as tape MISSes that
look exactly like prompt drift.

`RIG_PINS` is now the single source, with two consumers: `playwright.config.ts` derives each project's
`env` through `rigEnv(proj)` (so workers see it), and `globalSetup` resolves the selected project from
`fullConfig.argv` and calls `applyRigEnv()` **before booting**. The second half is not optional —
Playwright applies project `env` to workers, and the object handed to `globalSetup` exposes an
UNFILTERED `projects` list whose entries carry no `env` (measured: 11 projects for a
`--project=heavy` run). "Just put it in the config" looked fixed and was not: the boot kept using
defaults. An explicit command-line value still wins, so re-tuning one leg never needs an edit; an
unknown project derives nothing instead of inventing defaults.

Rows: `tests/unit/e2e-pins-single-authority.test.ts` (table contents, `rigEnv` derivation, argv parsing
in both `--project=x` and `--project x` forms, apply-not-clobber, unknown-project, both consumers
reading the table, a literal `env: { 'E2E_TAPE' … }` block failing, and the runners carrying no copy).
`npm run test:e2e`'s per-leg header now prints the EFFECTIVE regime read from the table, so a tape's
provenance is auditable from the runner log alone.

### Provenance is generated (`scripts/write-provenance.mjs`), never hand-authored (#56)

`PROVENANCE.md` lives inside each project directory — and the runner `rm -rf`s that directory before
recording. The re-anchor commit therefore deleted `plans/PROVENANCE.md` and `prompt/PROVENANCE.md`,
which are precisely the records stating those legs were distilled from the SCRIPTED stub rather than
a live model. A claim about what a tape means must not be destroyed by the act of re-making the tape:
the file is generated from the pin table plus the recorded verdict, and
`tests/unit/tape-provenance.test.ts` fails if any project lacks it or if the runner stops
regenerating it.

### The pool mirror must be per-boot too, or notices are not reproducible (#85)

`artifactStoreRoot` has been pinned per port since #61, and I believed that made a boot's state
test-local. It did not: the compaction/continuation notice composes its `## CORE RULES` block from
`path.join(cwd, DEFAULT_CLONE_DIR)` (`src/engine.ts`) — a **fixed path in whatever project the rig is
running in**. In this repo that directory holds real development state, so a leg's notice content
depended on rules that had nothing to do with the leg: measured 2026-10-23, `heavy`'s recorded notice
carried `[dev2/001] (security) Never log raw tokens…` while the replayed notice carried none, the two
texts agreeing to character 346 and diverging there. Same build, same pins, same tapes — a different
repo.

The realm config key `knowledgeMirrorDir` (default `.dsh-knowledge`, unchanged for real installs) now
feeds that read, and `boot.ts` pins it to `var/e2e-home-<port>/knowledge`. The rule generalizes: any
path a boot reads to build model-visible text must be per-port or per-session, because a tape is a
claim about ONE world. `tests/unit/e2e-store-root.test.ts` keeps the pins honest, and
`tests/unit/preset-declaration.test.ts` refuses a config key that drifts out of the preset row.

### Don't push while an acceptance run is the thing you're waiting on (#89, measured against myself)

`.github/workflows/ci.yml` sets `concurrency: ci-<ref>` with `cancel-in-progress: true`. Twice on
2026-10-23 I pushed a small commit (a docs line, a corrected message) while the ~25-minute acceptance
chain was mid-flight, and GitHub cancelled the run that held the answer — then the new run restarted
from zero. The commit was never the problem; the wait was. Batch the push: while a long gate is
running, either finish what you're doing locally first or park the commit, and push once. Same rule in
the other direction: don't judge a fix by the run it cancelled — re-read which head each verdict belongs
to before believing a green.

### Throwaway homes live outside the repository — `E2E_HOME_ROOT` (#89)

`e2eHomeRoot()` defaults to `os.tmpdir()/dsh-e2e`, and CI sets `E2E_HOME_ROOT=/tmp/dsh-e2e` explicitly
so the diagnostics it uploads are the ones it booted. Not tidiness: Node resolves `@deepseek-ai/*`
bundles by walking UP from the profile directory, so a home under `var/` reaches this repo's
`node_modules` (0.1.5-rc.2 by lockfile) and then the developer's `~/node_modules`. On the machine that
recorded the first re-anchored corpus, that second hop is a **linked dev build of the harness whose
version string equals the pin** — so the boot mounted tool guidance (goals, ralph, subagents, web
search, glob/grep, job output) the published tarball does not have.

Measured by moving nothing but the home's location:

| home root | system header composed by the SAME pinned binary | `suite` strict replay |
|---|---|---|
| `var/e2e-home-41731` | 7,276 chars | 4 passed, zero misses |
| `/tmp/dsh-e2e/e2e-home-41731` | 2,783 chars (CI's shape) | `commonPrefix=1`, `divergeAt=msg1` |

That is the whole "green on my laptop, impossible on CI" class in two rows of one table, and why
`tests/unit/e2e-host-binary.test.ts` now asserts hermeticity structurally: the home root must be
outside `ROOT`, and no ancestor of the home may contain `@deepseek-ai` packages — if one ever does, the
row names the path instead of agreeing silently. Pinning the *binary* (`resolveHostBinary`) was not
enough; the ancestor chain is part of the identity, and AGENTS' warning that these bundles' version
strings are not identity turns out to apply one directory level up from any lockfile.

Consequence, stated plainly: changing this changes what every boot composes, so the entire corpus was
re-distilled afterward. A rule that doesn't cost a re-record is probably not a reproducibility rule.

## One build per corpus (#90, measured 2026-10-24)

A tape records what the **plugin** asked, not just what the model answered. So a corpus is only coherent
if every leg in it was distilled against one `lib/`. This was violated all day by well-meaning
incrementalism — re-recording whichever leg a fix touched — and the cost was invisible until a replay
missed on a *post-compaction* surface: a 4-message request with `commonPrefix=0` against a tape that held
the 6-message pre-compaction form. Record ran on a build whose last-resort deferral always abstained
(`resolveConfig` defaults `maxTokens` to `headroomTokens` = 65,536, so the coexistence ceiling was
underivable); replay ran on a build where it is derivable (11,880) and can fire. Both behaviors are
correct. The corpus spanning them is not.

Rules that follow, in the order they bite:

1. **Two questions, two answers — `npm run corpus:check` (#156).** A rebuild changes the *bundle*; that alone does **not**
   make the corpus stale, it makes the *stamp* stale: the check prints an `ADVISORY` and the replay still runs, then
   `npm run corpus:stamp` re-records `BUILD_STAMP.json` (`lib` + `promptAnchor`) once the legs are green. What does
   invalidate a corpus is the **prompt-byte anchor** moving — tool and command `description`s, dock `label`s, the preset
   persona, and the realm keys whose values reach the model (`thresholdRatio`, `retain*`, `headroom*`, artifact/defer
   tokens, …). Then `verdictFor` refuses with `REFUSED: model-facing bytes moved …` and **all** affected projects must be
   re-distilled before anything is trusted, because a partial re-record yields a mixed corpus and matching happens across
   the whole set. The rule in `AGENTS.md` — "re-record when PRODUCT prompt bytes change" — is now a computed quantity
   rather than a judgement call; logging keys, store paths and `maxBytes` are deliberately outside the anchor, and a
   manifest file that contributes no tokens fails its own row, so a silently-dead extraction rule cannot masquerade as
   protection.
2. **`PROVENANCE.md` per leg is necessary, not sufficient.** It records the host and regime; it cannot
   say "this leg predates three plugin commits". The stamp is what says that, and #156's split is what stops the stamp from
   crying wolf on every rebuild.
3. **Test-only changes (`tests/e2e/**`) need no re-record** — normalization folds apply at load to both
   sides. Product-behavior changes do. The distinction is exactly AGENTS' "re-record when PRODUCT prompt
   bytes change", generalized: anything that changes what the plugin *sends*.
4. If a green replay is ever obtained on a corpus whose legs have different build stamps, treat it as
   unexplained rather than as evidence.

## Harness-native acceptance (`E2E_PROVIDER=harness`)

The rig used to have exactly one model route: a tracked profile block pinning `local` at
`http://localhost:8080/v1`, because a GitHub runner has no credentials and can start a llama.cpp server. On
this machine that made acceptance a second-class citizen — the model was almost never up, live legs
`test.skip`-ed themselves (which reads like a pass), and re-distilling meant standing up an inference server
before you could look at UI.

`E2E_PROVIDER=harness` takes the route from **the profile this host is actually running** — read from
`$DSH_HOME/profiles/web/cordis.patch.yml` (override with `E2E_AMBIENT_PROFILE`) — and the credential from, in
order:

1. **the parent environment**, `QWEN_TOKEN_PLAN_API_KEY` — the same way this harness instance got it. When you
   run a leg from your own shell, this is the only step.
2. `.dshdev-local/e2e.env`, untracked and gitignored, parsed **without executing it** (`readEnvFile` — values
   are data, never a shell).
3. otherwise the boot **refuses**, naming the remedy. No fallback to `local`, no silent skip, no guessed route.

What it deliberately keeps: the **pinned 32K stress window**. `harnessProviderPatch` rewrites
`contextWindow` rather than inheriting the endpoint's 196K, because the whole pressure/cache journey exists to
observe `context-overflow` — a hosted window would swallow a 33K prompt and the leg would measure a boot where
nothing is wrong.

Commands (all of them print one `[provider] …` line naming provider, model, window and where the key came
from, with the credential's length but never its value):

| command | mode | what it's for |
|---|---|---|
| `npm run e2e:harness:live` | live | a real look at the UI on the model the product runs against |
| `npm run e2e:harness:heal` | replay + fallback | tape hits replay, **misses go live and are appended** — a self-healing pass instead of a full re-record (the switch existed in code but was never surfaced) |
| `npm run corpus:heal -- --project=<leg>` | replay + fallback | one leg, when you know which one drifted |
| `npm run corpus:record -- --project=<leg>` | record | re-distill one leg after a deliberate product-prompt change |

Why this is more than convenience: the `#90 REASONING-BLIND` entry in the tape's blind list masks
`reasoning_content` shape differences. Tapes distilled through a different provider than the product uses will
always need masks; distilling through the product's own route removes a class of divergence instead of hiding
it. Stated as strong inference from the measurement, to be confirmed the first time a harness-native
re-distill stops needing that mask.

Note on what an agent shell can see: the harness **withholds** `QWEN_TOKEN_PLAN_API_KEY` from tool processes
(measured — the harness's own process env has it, the agent's child shell does not). So a distill or live run
from inside an agent session needs the `.dshdev-local/e2e.env` path, or the operator runs it. Reading the key
out of the parent process's environment is technically possible for the same user and is deliberately **not**
done: the withholding looks intentional, and reaching around it to move a credential into a tool shell would be
exactly the kind of quiet workaround this project documents itself out of.

## The provider identity is part of the tape key

A tape is matched on the **request**, and the request's first message is the composed system header — which
states the provider and model. So a corpus distilled with one provider row cannot replay under another, and the
failure does not look like configuration: it looks like a corrupt tape, because matching dies at
`commonPrefix=0` and every leg then reports its own downstream symptom (no assistant message, no fork door, no
plan card, a post-compaction turn that never answers).

Measured the hard way on 2026-10-27: re-distilling the corpus with `E2E_PROVIDER=harness` while hosted CI
replays in the tracked-local shape produced `MISS tape=suite … tied=[every entry]` on CI and a green chain
locally — the same command, two different headers. The fix is placement, not normalization:

- **the host profile stays on the fixture provider** (`local/qwen3.8-flash-next`) in record and replay, so the
  header is identical on every machine and in CI;
- **the real endpoint lives in the tape proxy** — `E2E_UPSTREAM` derived from the installed provider module and
  `E2E_UPSTREAM_MODEL` translating the fixture name — so the model answering is the maintainer's while the
  bytes being recorded are the rig's;
- `E2E_HARNESS_PROFILE=1` restores the profile rewrite for **live** runs, where there is no tape to stay
  identical with and the point is genuinely to exercise the ambient provider.

Two consequences worth holding onto: the `reasoning`/`retryPolicy` fields of the synthesized row change product
behavior (`maxRetries: 0` versus the host default), so "same model, different row" is not a neutral edit; and
a re-distill must run the leg to **green** — a tape distilled by a failing journey is an incomplete capture, and
replaying it back as a miss blames the artifact for a run that never finished.

## Two rig rules from the 2026-10-27 mount chase

**A boot must resolve what its profile declares, before the host starts.** The booted profile's preset names 28
`@deepseek-ai/*` plugin packages, and none of them is a dependency of this repository. On a development host they
resolve out of `~/node_modules`; on a CI runner they resolve nowhere, `pruneUnresolvableRows()` drops them
without complaint, and the session composes a 7-tool surface where a laptop gets 34. Because the system header
is message 0 of every request — the thing tapes match on — that asymmetry makes a locally recorded corpus
unreplayable in CI, which is what every `commonPrefix=0` on this branch actually was. `linkPinnedToolPackages()`
now symlinks the pinned install's packages into `node_modules/@deepseek-ai` **before** `spawn`, skipping anything
the repo already provides (never replace a hoisted dependency with a symlink and risk the build under test), and
`var/e2e-tool-links-<port>.log` records `rows/linked/skippedAlreadyPresent/missingFromPin` for every boot. The
ordering is not ceremonial: linking after the URL line was measured to change nothing, because the host has
already mounted by then.

**Normalize, THEN diff.** Comparing two machines' RAW header dumps showed an 18-character gap — exactly the
length of the two checkout paths — and produced a duplicate blind for a fold that already existed
(`<DSH-CHECKOUT>`, `model-proxy.ts:159`). The #89 ordering row caught the collision the moment it shipped; the
procedure error was mine and is the one to remember: run the text through `substituteAll` before concluding a
fold is missing. One predicate per semantic decision, and a fold that already exists is not a missing fold.

## A recorded journey must not depend on when the host compacts

**Symptom that gives it away:** the acceptance run misses a *different set of legs* each time, while message 0 keeps
matching. That is not an unblinded identity token and not a matcher bug. It means the two machines ran the same
journey and both compacted — at different moments. A checkpoint rewrites the surface, so the same assistant turn
lands at message index 6 here and index 2 there, and the surface is the tape key.

**The rule:** a leg that is NOT testing the machinery pins `noAuxModel`. It is a rig-side alias, translated at
profile-write time into the realm keys the engine really reads — `auto: false` + `elicitedPlot: false`,
`tests/e2e/rig-preset-pin.ts:79`, declared at `src/engine.ts:287` — so the request sequence in the tape is the whole
story regardless of how large a runner's header happens to be.

**The exceptions are measured, not preferred:** `heavy`, `suite`, `arrival` and `fanout` stay unpinned, because
pinning them deletes the behavior under test — a pinned `suite` never renders its fork door, a pinned `arrival`
never gets its stub pair, a pinned `fanout` loses parent synthesis, and `heavy`'s journey *is* the pressure one. Same
family as setting the arrival floor below the chunk size and calling the passing row a result. The drift row
(`only the pressure journeys leave model-involving machinery enabled`, `tests/unit/rig-pins.test.ts`) names offenders
in its failure text and asserts those four stay unpinned.

**And the method trap I walked into, recorded so it costs the next reader nothing:** I searched `src/` for the string
`noAuxModel`, found none, and concluded the switch was decorative — then shipped a "fix" folding a check into
`overTrigger`, a local that is computed and dropped, plus a guard test asserting the plugin must contain the alias's
literal name. Absence of a NAME in a source directory is not absence of an EFFECT: read what the rig writes into the
profile it boots, not what it calls the field on the way in.

**Why the transcript has to travel with the artifact:** this took three runs to see because the workspace-only
artifact never contained the booted home's session logs. `scripts/chain-replay.sh` now copies each leg's
`session.v4.jsonl.zstd` files and registry into `var/e2e-session-logs/<leg>-<port>` (six files, under 4 MB each) so
the runner's own history sits next to the tape diffs and the misses. When a miss claims "the conversation had
already taken a different shape", the answer is in that transcript — read it, don't theorize about it.
