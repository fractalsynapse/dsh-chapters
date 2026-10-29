---
title: "24. Developing the plugin"
description: The build-test loop that doesn't restart the harness, the tape-replay acceptance system, and the rules that keep it honest.
lastUpdated: true
---

One package, plain npm, no monorepo:

```bash
npm ci && npm run build && npm test          # the deterministic suite: unit + integration, no model
npm run coverage:ci                          # the ≥85% gate, same numbers CI enforces
npm run test:e2e:replay                      # the browser acceptance chain, off model TAPES
```

(Deliberately no test count here: a number typed into a page goes stale on the next commit, and the honest
figure lives in the release ledger on [§26](/operations/changelog/).)

## Development environments

Three setup modes live in `dev/install/` — pick whichever fits your workflow. All three install the same
plugin set (dsh-chapters, dsh-codegraph, dsh-tinyfish-search) with the full Cordis configuration mirror.

### Centralized (your live profile)

Installs directly into your existing `web` profile. Edits in this checkout are reflected after rebuild
via the `link:` protocol — no republish needed. Best for day-to-day development on your main machine.

```bash
./dev/install/install.sh
dsh web
```

### Compartmentalized (isolated DSH_HOME)

Same installer, different home. Your live sessions and config stay untouched. Best for testing changes
that might break things, or running multiple configurations side by side.

```bash
DSH_HOME=/tmp/dsh-dev ./dev/install/install.sh
DSH_HOME=/tmp/dsh-dev dsh web
```

### Containerized (full stack with vLLM + test runner)

A self-contained Docker Compose platform with three services:

| Service | Port | Purpose |
|---------|------|---------|
| `vllm` | 8080 | Qwen3-4B-AWQ model server (inference + systemone endpoints) |
| `dsh-web` | 3080 | DSH Web UI, pre-configured to use vllm |
| `dsh-test` | *(none)* | Node.js 22 + Playwright + Chromium for acceptance tests |

No external API keys required. Model weights cache in a Docker volume after first download. Environment
variables are read from your shell — no `.env` file needed.

```bash
cd dev/install
docker compose up -d                                    # start everything
docker compose run --rm dsh-test npm run test:e2e:replay  # run tests
docker compose exec dsh-test bash                        # interactive test shell
```

Requires Docker ≥ 24, Compose v2, NVIDIA GPU with nvidia-container-toolkit. Full documentation in
[`dev/install/README.md`](https://github.com/treeseed-ai/dsh-chapters/tree/main/dev/install).

### Containerized SDK API service (headless harness for external systems)

A fourth mode hosts the harness as an **SDK JSON-RPC API** instead of a Web UI — for another system
that uses DeepSeek Harness as its agent runtime. `compose.sdk.yml` runs the same image in a gateway
role: one WebSocket listener (`:8765`, token-authenticated before any spawn) that per connection
launches `dsh --profile sdk` and relays the stdio protocol verbatim. The `sdk` profile carries the
identical configuration to the Web UI profile — Alibaba/Qwen token-plan marketplace, local vLLM
provider, and all three dev plugins including dsh-chapters — so hosted agents get the same tools and
zero-inference chapter compaction, tuned for small local models.

The model server is NOT part of this stack (#27): boot `compose.vllm.yml` (its own file,
its own GPU reservation), or point `LLM_BASE_URL` at any OpenAI-compatible server already
running on the host — another project's vLLM included. The stacks share one network so the
default `vllm` hostname resolves across files; an external URL works without joining.

```bash
cd dev/install
docker compose -f compose.vllm.yml up -d                    # optional shared model server
GATEWAY_TOKEN=$(openssl rand -hex 16) docker compose -f compose.sdk.yml up -d
```

The serving side is stock host (`@deepseek-ai/dsh-sdk-jsonrpc-server`); only the thin relay is ours.
TypeScript consumers don't speak the raw wire: the connector (`dev/install/sdk-gateway/connector.ts`)
offers a `HarnessClient`-shaped `connectToGateway({url, token}).run(prompt)` over one WebSocket, and
its usage guide records the four measured caller rules (profile provider routes, flat event envelope,
one-connection runtime lifetime, no mid-turn cancel):
[`CONNECTOR.md`](https://github.com/treeseed-ai/dsh-chapters/blob/main/dev/install/sdk-gateway/CONNECTOR.md).
Deeper integration is possible and measured: the harness is library-first internally (the SDK server is
a plugin calling `ctx.agents.create()` on an in-process Cordis tree; `boot()` from app-boot is the
embedder entry), so a Hono-style Node app can embed the runtime instead of spawning children — shapes,
costs, and the npm dist-tag pin trap are in
[`dev/install/sdk-embedding-analysis.md`](https://github.com/treeseed-ai/dsh-chapters/blob/main/dev/install/sdk-embedding-analysis.md).
Callers use `@deepseek-ai/dsh-sdk-client` with `provider: 'local'` or `'qwen-token-plan'` at
`initialize` — never `deepseek-official`. One connection owns one runtime process; sessions survive
reconnection through `session/resume`. Why stdio-shaped hosting looks like this, the alternatives
(ACP, socat), and the measured host facts:
[`dev/install/sdk-service-analysis.md`](https://github.com/treeseed-ai/dsh-chapters/blob/main/dev/install/sdk-service-analysis.md).

## CodeGraph — structural code search

The installer includes [`@jiangzhenguo/dsh-codegraph`](https://github.com/jiangzhenguo/dsh-codegraph),
which builds an AST-level index of every symbol and call edge in the project. Instead of running dozens
of grep/glob/read round-trips to find a function or trace a flow, the agent calls `codegraph_explore`
with a natural-language description and gets back verbatim source plus call paths — including
dynamic-dispatch hops that text search cannot follow.

The plugin is configured with `surface: core` (four tools: `status`, `init`, `sync`, `explore`) and
`frontload: true` (injects structural context into prompts so the agent starts with code structure).
The index lives at `.codegraph/codegraph.db` and updates incrementally via `codegraph_sync` after edits.

## The tape system (why CI has no LLM)

**A live leg asserts invariants, not a tally.** When a browser journey waits on a model-driven turn, the number of
internal steps it takes belongs to the run: two live runs of the oversized-turn leg on one commit and one realm produced
8 and 38 relief passes. The assertion that bounded it (`passes ≤ 30`) therefore failed with nothing broken. What the leg
asserts instead is what the mechanism promises — every pass removes at least one node, no node is shadowed twice, and
relief leaves the surface under the realm's trigger, read from the engine's own decision note, which is written during
the run rather than parsed after it. A count may remain as a runaway guard, commented as one.

E2E browser tests would normally need a live model, a GPU, and minutes per spec. Instead, recorded model exchanges are committed under `tests/fixtures/model-tape/` and replayed by a proxy; every request must match a recorded exchange after **normalization on both sides** (volatile values — ports, paths, token counts — are masked out), or the run fails loudly with a miss journal + diff dump (candidates sorted by shared prefix). Usage numbers ride the tape, so token-meter thresholds fire at identical steps — *threshold behavior* under test with zero model calls. E2E_MODEL=record distills fresh tapes from the local model — once per scenario, whole projects at a time (specs share a boot); re-record when **product prompts** change — doc edits are free with one measured exception: near-threshold scenarios (`heavy`, `fanout`) digest injected docs into model-visible checkpoints.

## The discipline, condensed

- **the point of a test is to test, not skip** — a test that skips for a missing dep is a bug report;
- **measure before you attribute** — three "bug" reports this year were each a different thing (a unit mismatch, a capacity fact, and a real defect) — the audits that decode provider units from meter units are in the repo history;
- **a tape records the context it was distilled in** — one journey per boot, never two GPU suites at once;
- **loud beats lossy** — refusals carry numbers; degradations name their step.

The contributor-facing full loop: `docs/development.md` and `AGENTS.md` in the repo (the site you're reading is *for users*; those are for the agents and humans working *on* it). Next: [25. Internals map](/operations/internals/).
