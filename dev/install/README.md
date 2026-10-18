# DSH Chapters — Complete Development & Test Platform

A self-contained development environment for dsh-chapters: DSH Web UI, local vLLM
model server (Qwen3-4B-AWQ), and a CI-capable test runner with Playwright + Chromium.
Everything runs locally — no external API keys required for core operation.

## Quick Start

### Native Install (development on host)

```bash
# From the repo root:
./dev/install/install.sh

# Start the Web UI:
dsh web
```

The installer adds three plugins to your existing `web` profile (additive only — your
existing config is preserved):

| Plugin | Source | What It Provides |
|--------|--------|-----------------|
| `@treeseed/dsh-chapters` | Linked from this checkout | Chapter archiving, zero-token compaction, knowledge pool, continuation/fork tools |
| `@jiangzhenguo/dsh-codegraph` | GitHub | Pre-indexed code knowledge graph — structural code search via `codegraph_*` tools instead of grep/glob |
| `dsh-tinyfish-search` | npm | Web search capability for agents |

Plus the full Cordis configuration: Alibaba/Qwen token plan marketplace (8 models),
UI settings, directory-picker pinning, agent-loop config, and dev overrides for the
local vLLM server.

### Containerized Platform (full stack)

```bash
cd dev/install
docker compose up -d
```

Environment variables are read from your **parent shell** — no `.env` file needed.
Export your vars before running Compose and they're picked up automatically. The
`.env.example` file exists only as a reference of available variables and their defaults.

This starts three services:
- **vllm** — Qwen3-4B-AWQ model server on port 8080 (inference + systemone)
- **dsh-web** — DSH Web UI on port 3080, pre-configured to use vllm
- **dsh-test** — Test runner with Node.js + Playwright + Chromium

If the host's own DSH GUI already owns port 3080 (it does on a dev box running this
harness), start the containerized UI on another host port instead of stopping your session:

```bash
DSH_PORT=3081 docker compose up -d    # UI published at http://localhost:3081
```

`DSH_PORT` only picks the host side of the mapping; the container always binds 3080 internally.
On machines where a local proxy intercepts Docker's published ports (see Troubleshooting), reach
the UI with `docker exec dsh-chapters-dev curl -s http://127.0.0.1:3080/` or an SSH tunnel.

### Running Tests

```bash
# E2E replay tests (no LLM needed — uses recorded tapes)
docker compose run --rm dsh-test npm run test:e2e:replay

# Unit tests
docker compose run --rm dsh-test npm run test:unit

# Coverage gate
docker compose run --rm dsh-test npm run coverage:ci

# Interactive shell
docker compose exec dsh-test bash
```

### Troubleshooting

**`dsh-vllm` exits with `invalid human_readable_int_or_auto value: '${MAX_MODEL_LEN}'`.**
The image was built from an old `vllm.Dockerfile` that passed literal `${VAR}` strings to vLLM
(exec-form `CMD` does not interpolate). Fixed by rebuilding the image:

```bash
cd dev/install
docker compose build --no-cache vllm
docker compose up -d
```

Verify the container is serving before starting the dependents:

```bash
docker compose ps            # vllm should be healthy (model load takes ~2 min)
curl -s http://localhost:8080/health
```

If a stale `dsh-vllm` container keeps getting reused, remove it first:
`docker rm -f dsh-vllm`.

**`dsh-web` restarts with `error: too many arguments ... web`.** The image was built before the
launcher fix: host 0.2.x boots a profile with `dsh web --host … --port …` (the old
`dsh --profile web web` form is rejected). Rebuild: `docker compose build dsh-web`.

**The UI binds loopback inside the container.** Host 0.2.x deliberately refuses `--host 0.0.0.0`
(remote code execution exposure). Normally you reach it through the published port mapping
(`http://localhost:3080`). On some machines a local proxy intercepts Docker's published ports and
resets host-side connections (measured on this box 2026-10-17 — even an unrelated test listener was
unreachable from the host, so this is not a compose bug). Workarounds that always work:

```bash
docker exec dsh-chapters-dev curl -s http://127.0.0.1:3080/   # from inside the network
ssh -L 3080:127.0.0.1:3080 <this-host>                        # tunnel to the bind directly
```

The token URL printed by `docker logs dsh-chapters-dev` (`dsh web: http://…/?token=…`) is what the
browser opens; the same exchange works over the tunnel.

**`dsh-vllm` exits with `--enable-auto-tool-choice requires --tool-call-parser`.**
Also the old image: newer vLLM (≥ 0.31) refuses auto tool choice without naming a parser.
The fixed image passes `--tool-call-parser hermes`, the format Qwen3 emits natively.
Rebuild as above.

**Server is healthy but `The model 'qwen3-4b-instruct' does not exist`.**
Model aliases were passed wrong: vLLM's `--served-model-name` is *variadic* — one flag,
space-separated values. A comma-joined value registers a single alias literally named `"a,b"`,
and repeated flags keep only the last value. The fixed image and `.env.example` use
`VLLM_SERVED_NAMES=qwen3-4b-instruct qwen3-4b-systemone`; rebuild and confirm both ids appear
under `curl localhost:8080/v1/models`.

**`Free memory on device cuda:0 ... less than desired GPU memory utilization`.**
vLLM reserves a fraction of the GPU's *free* memory at startup; on a GPU shared with the desktop
compositor even 0.75 can be too much when other apps hold VRAM. Lower it further (e.g. `0.6`) or
close the competing GPU users. The stack default is already `0.75` (chosen for a 16 GB GPU under a
desktop session); if you carried an older `.env` with `VLLM_GPU_MEM=0.90`, bring it down.

### Uninstall

```bash
./dev/install/uninstall.sh          # remove plugins from web profile
./dev/install/uninstall.sh --full   # also remove DSH host installation
./dev/install/uninstall.sh --purge-home  # nuclear: remove entire $DSH_HOME
```

### SDK API Service (headless, for external systems)

A second Compose definition hosts the harness as an **SDK JSON-RPC API** — no Web UI — so another
system drives it with `@deepseek-ai/dsh-sdk-client`. It carries the same configuration as the Web UI
profile: the Alibaba/Qwen token-plan marketplace, the local vLLM provider, and all dev plugins
(`dsh-chapters`, `dsh-codegraph`, `dsh-tinyfish-search`). Tuned for small local models.

```bash
cd dev/install
docker compose -f compose.sdk.yml up -d       # vllm + dsh-agent-api (gateway on :8765)
```

The load-bearing fact: **the SDK server is stdio-only by design** — `dsh --profile sdk` speaks
newline-delimited JSON-RPC over its own stdin/stdout; there is no port or HTTP route anywhere in
`@deepseek-ai/dsh-sdk-jsonrpc-server`. The `dsh-agent-api` service therefore runs a thin **gateway**:
one WebSocket listener that, per connection, spawns a `dsh --profile sdk` child via the official
`HarnessClient({ dshBin })` and relays frames verbatim. One connection = one runtime lifetime;
`shutdown` or socket loss ends that child. Sessions persist under `$DSH_HOME/sessions` (shared volume),
so a fresh connection recovers any session with `session/resume`.

Caller example (any machine that can reach the published port):

```ts
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'

// connector(): spawn a local pipe process whose stdout feeds the WS and whose
// stdin is written by the WS messages — HarnessClient speaks to the pipes.
const client = new HarnessClient({ /* transport wired to the WS relay */ })
client.start()
await client.initialize({
  cwd: '/workspace',
  provider: 'local',                 // NOT 'deepseek-official' — see below
  model: 'qwen3-4b-instruct',
})
const { messageId } = await client.request('session/prompt', {
  sessionId: 'my-task-1',
  contentBlocks: [{ type: 'text', text: 'summarize README.md' }],
})
// notifications stream as session.event / session.status until the agent idles
```

Two protocol facts callers must know (verified against host 0.2.x sources):

- **Provider routes are the profile's configured names** — `local` (vLLM) or `qwen-token-plan`
  (Alibaba). `initialize` validates them against registered adapters; `deepseek-official` falls back
  to a DeepSeek adapter that has no credential here and fails at first call.
- **No mid-turn cancel exists on the wire.** Abandoning a turn means closing the connection (which
  reaps the child); follow-up work resumes via `session/resume`. Full analysis and alternatives
  (ACP, socat relay): [sdk-service-analysis.md](sdk-service-analysis.md).

Auth: the gateway rejects connections before spawning anything unless the `Sec-WebSocket-Protocol`
handshake carries `dsh-auth.<token>` matching `GATEWAY_TOKEN` (compose env; keep it private — this is
a remote-code-execution surface, bind through loopback publishing only).

Coexistence with the Web UI: run one role per `$DSH_HOME` mount at a time. Sharing sessions/storage
volumes between a live `dsh-web` and `dsh-agent-api` is not tested; give each stack its own home if
both must run simultaneously.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Docker Compose Stack                    │
│                                                         │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────┐   │
│  │  vllm    │◄───│ dsh-web  │    │    dsh-test      │   │
│  │  :8080   │    │  :3080   │    │  Node+Playwright │   │
│  │          │    │          │    │  +Chromium       │   │
│  │ Qwen3-4B │    │ DSH Web  │    │                  │   │
│  │ -AWQ     │    │ UI       │    │ test:e2e:replay  │   │
│  │          │    │          │    │ test:unit        │   │
│  │ •instruct│    │ chapters │    │ coverage:ci      │   │
│  │ •system1 │    │ codegraph│    │                  │   │
│  └──────────┘    │ tinyfish │    └──────────────────┘   │
│                  └──────────┘                            │
│                        ▲                                 │
│                   Browser :3080                          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│           compose.sdk.yml — SDK API Stack                │
│                                                         │
│  ┌──────────┐    ┌────────────────────────────┐         │
│  │  vllm    │◄───│ dsh-agent-api              │         │
│  │  :8080   │    │  gateway :8765 (WS)        │         │
│  │          │    │   └─ spawn per connection: │         │
│  │          │    │      dsh --profile sdk     │         │
│  │          │    │      (stdio JSON-RPC)      │         │
│  └──────────┘    └────────────────────────────┘         │
│                        ▲                                │
│        @deepseek-ai/dsh-sdk-client over WS relay        │
└─────────────────────────────────────────────────────────┘
```

## Model Server (vLLM)

The bundled vLLM serves [Qwen/Qwen3-4B-AWQ](https://huggingface.co/Qwen/Qwen3-4B-AWQ)
under two model names:

| Model ID | Purpose |
|----------|---------|
| `qwen3-4b-instruct` | General inference, agent conversations |
| `qwen3-4b-systemone` | Decision model, classification, routing |

Both resolve to the same weights. See the [`local-llm` skill](../../.dsh/skills/local-llm/SKILL.md)
for detailed API examples, endpoint selection guidance, and configuration reference.

Model weights are cached in the `dsh-vllm-cache` Docker volume — downloads once (~3 GB),
subsequent boots are instant.

**Requirements**: NVIDIA GPU with ≥4 GB VRAM, nvidia-container-toolkit installed.

## CodeGraph Integration

The [`@jiangzhenguo/dsh-codegraph`](https://github.com/jiangzhenguo/dsh-codegraph) plugin
provides a pre-indexed code knowledge graph that replaces grep/glob/read workflows with
structural code queries. It registers `codegraph_*` tools that the agent uses automatically.

### What It Does

CodeGraph builds an AST-level index of every symbol and call edge in the project. When the
agent needs to find a function, understand a flow, or trace callers/callees, it calls
`codegraph_explore` instead of running dozens of grep/glob/read round-trips. One call returns
relevant symbols' verbatim source plus the call paths between them — including dynamic-dispatch
hops that grep cannot follow.

### Tools Registered

| Tool | Purpose |
|------|---------|
| `codegraph_status` | Check if the project is indexed |
| `codegraph_init` | Build the initial index (run once per project) |
| `codegraph_sync` | Incrementally update after edits |
| `codegraph_explore` | Natural-language code search → source + call paths |

With `surface: core` (our config), only these four tools are registered. The full surface
adds `query`, `node`, `files`, `callers`, `callees`, `impact`, `affected`, `index`, and `uninit`.

### Configuration (in Cordis patch)

```yaml
- id: dsh-codegraph
  name: dsh-codegraph
  config:
    guideSearch: true    # steers agent toward codegraph over grep
    surface: core        # minimal tool set (status/init/sync/explore)
    frontload: true      # injects structural context into prompts
```

### How It Helps Development

- **Faster code navigation**: one `codegraph_explore` call replaces 5–20 grep/glob/read cycles
- **Accurate call tracing**: follows dynamic dispatch, re-exports, and barrel files that text search misses
- **Prompt efficiency**: frontload mode injects relevant structural context so the agent starts with code structure rather than discovering it mid-turn
- **Index persistence**: the `.codegraph/` directory is gitignored and survives across sessions; `codegraph_sync` updates incrementally after edits

The index for this project lives at `.codegraph/codegraph.db` (~11 MB). After cloning,
run `codegraph_init` once (or let the agent do it automatically when it detects an
unindexed project).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DSH_PORT` | `3080` | DSH Web UI port |
| `VLLM_PORT` | `8080` | vLLM model server port |
| `VLLM_MODEL_ID` | `Qwen/Qwen3-4B-AWQ` | HuggingFace model |
| `VLLM_MAX_MODEL_LEN` | `32768` | Context window |
| `VLLM_GPU_MEM` | `0.75` | GPU memory utilization (raise to 0.90 on a dedicated GPU) |
| `LLM_MODEL` | `qwen3-4b-instruct` | Default model for DSH |
| `SYSTEMONE_MODEL` | `qwen3-4b-systemone` | Decision model name |
| `QWEN_TOKEN_PLAN_API_KEY` | *(empty)* | Cloud marketplace key (optional) |
| `TINYFISH_API_KEY` | *(empty)* | Search plugin key (optional) |
| `GATEWAY_PORT` | `8765` | SDK gateway WebSocket port (compose.sdk.yml) |
| `GATEWAY_TOKEN` | *(empty → refuses clients)* | Shared secret for the SDK gateway |
| `DSH_ROLE` | `web` | Entrypoint role: `web` (UI) or `gateway` (SDK API service) |
| `DSH_SDK_PROFILE` | `sdk` | Profile name the gateway spawns (`dsh --profile sdk`) |
| `GATEWAY_IDLE_MS` | `1800000` | Idle socket TTL before the runtime child is reaped (30 min) |
| `DSH_HOME_VERSION_PIN` | — | Pin `DSH_HOST_VERSION` to the exact host; the SDK client enforces an exact same-version match with it |

## Directory Layout

```
dev/install/
├── README.md                    ← this file
├── install.sh                   ← native installer (targets web profile)
├── uninstall.sh                 ← removal script
├── Dockerfile                   ← DSH service image (web UI + SDK gateway roles)
├── docker-entrypoint.sh         ← container entrypoint (generates profiles; role dispatch)
├── vllm.Dockerfile              ← vLLM model server image
├── test.Dockerfile              ← test runner image (Node+Playwright+Chromium)
├── compose.yml                  ← compose stack (Web UI + vLLM + test runner)
├── compose.sdk.yml              ← compose stack (SDK API gateway + vLLM)
├── sdk-gateway/                 ← WebSocket↔stdio relay for the SDK profile
│   ├── gateway.ts               ← the gateway server
│   └── smoke.mts                ← end-to-end smoke client (GPU box only)
├── .env.example                 ← environment variable reference (not required at runtime)
├── profile-cordis.patch.yml     ← full Cordis patch (marketplace + plugins + dev)
└── sdk-service-analysis.md      ← SDK integration analysis (host facts, options, effort)

.dsh/skills/                     ← all agent skills (see below)
skills-lock.json                 ← lock file for upstream-installed skills
```

## Skills

Skills live in `.dsh/skills/<name>/SKILL.md`. Two categories:

### Project-owned (maintained in this repo, NOT in skills-lock.json)

These are authored or customized locally. `npx skills update` will not touch them.

| Skill | Origin | Notes |
|-------|--------|-------|
| `release-workflow` | Authored locally | Mandatory Git/GitHub workflow |
| `local-llm` | Authored locally | vLLM endpoint guidance |
| `find-skills` | Forked from vercel-labs/skills | Modified to require user approval before install |
| `gh-cli` | Pre-existing | GitHub CLI reference |

### Upstream-tracked (installed via `npx skills`, tracked in skills-lock.json)

These are installed from skills.sh and pinned by content hash. Run `npx skills update`
to update them. The lock file ensures reproducible installs across clones.

| Skill | Source | Installs |
|-------|--------|----------|
| `brainstorming` | obra/superpowers | 395K |
| `writing-plans` | obra/superpowers | 275.7K |
| `verification-before-completion` | obra/superpowers | 242.6K |
| `writing-skills` | obra/superpowers | 211.7K |
| `doc-coauthoring` | anthropics/skills | 91.5K |
| `documentation-writer` | github/awesome-copilot | 27.5K |
| `github-ops` | affaan-m/ecc | 8.3K |

**Updating**: `npx skills update` refreshes upstream-tracked skills only. Project-owned
skills are updated by editing them directly and committing. If an upstream update breaks
a customization, re-fork and re-apply the modification.

## Prerequisites

- **Native install**: Node.js ≥ 22, npm ≥ 10, Git
- **Containerized**: Docker ≥ 24, Docker Compose v2, NVIDIA GPU + nvidia-container-toolkit
- **Optional**: `QWEN_TOKEN_PLAN_API_KEY` for cloud marketplace models
