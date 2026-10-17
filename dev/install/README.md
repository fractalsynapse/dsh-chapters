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

### Uninstall

```bash
./dev/install/uninstall.sh          # remove plugins from web profile
./dev/install/uninstall.sh --full   # also remove DSH host installation
./dev/install/uninstall.sh --purge-home  # nuclear: remove entire $DSH_HOME
```

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
| `VLLM_GPU_MEM` | `0.90` | GPU memory utilization |
| `LLM_MODEL` | `qwen3-4b-instruct` | Default model for DSH |
| `SYSTEMONE_MODEL` | `qwen3-4b-systemone` | Decision model name |
| `QWEN_TOKEN_PLAN_API_KEY` | *(empty)* | Cloud marketplace key (optional) |
| `TINYFISH_API_KEY` | *(empty)* | Search plugin key (optional) |

## Directory Layout

```
dev/install/
├── README.md                    ← this file
├── install.sh                   ← native installer (targets web profile)
├── uninstall.sh                 ← removal script
├── Dockerfile                   ← DSH Web UI service image
├── docker-entrypoint.sh         ← container entrypoint
├── vllm.Dockerfile              ← vLLM model server image
├── test.Dockerfile              ← test runner image (Node+Playwright+Chromium)
├── compose.yml                  ← compose stack (Web UI + vLLM + test runner)
├── .env.example                 ← environment variable reference (not required at runtime)
└── profile-cordis.patch.yml     ← full Cordis patch (marketplace + plugins + dev)

.dsh/skills/
└── local-llm/
    └── SKILL.md                 ← agent skill for working with the local vLLM
```

## Prerequisites

- **Native install**: Node.js ≥ 22, npm ≥ 10, Git
- **Containerized**: Docker ≥ 24, Docker Compose v2, NVIDIA GPU + nvidia-container-toolkit
- **Optional**: `QWEN_TOKEN_PLAN_API_KEY` for cloud marketplace models
