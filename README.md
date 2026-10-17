# dsh-chapters

**Long memory for local AI: a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin that archives agent conversations as verbatim chapters, continues sessions from a Table of
Contents at zero inference-token cost, and turns that archive into a shared, searchable knowledge
pool.** Published on npm as [`@treeseed/dsh-chapters`](https://www.npmjs.com/package/@treeseed/dsh-chapters);
source at [treeseed-ai/dsh-chapters](https://github.com/treeseed-ai/dsh-chapters).

> **All documentation lives on the documentation site — this README is a doorway, not a duplicate.**
> ### 📖 https://treeseed-ai.github.io/dsh-chapters/

## Install (the whole setup)

```bash
dsh plugin --profile web add @treeseed/dsh-chapters      # install into your harness profile
dsh plugin --profile web update @treeseed/dsh-chapters   # keep current — restart `dsh web` after
```

`--profile <name>` is required on every `dsh plugin` command (`web` = the browser harness profile).
After restart you have the fork button, six agent tools, four `/chapters-*` commands — and the
optional `chapters` preset that routes `/compact` through the zero-token engine.

## Find the right page for your question

| You want to… | Go to |
|---|---|
| understand what this is / why (the ten benefits) | [Home → “What it gives you”](https://treeseed-ai.github.io/dsh-chapters/) |
| install, upgrade, uninstall, verify provenance | [§23 Install, upgrade, provenance](https://treeseed-ai.github.io/dsh-chapters/operations/install/) |
| run your first compaction/continuation | [§1 Quickstart](https://treeseed-ai.github.io/dsh-chapters/start/quickstart/) → [§2 Your first continuation](https://treeseed-ai.github.io/dsh-chapters/start/first-continuation/) |
| link a shared knowledge pool (git or TreeDX) | [§3 Link a knowledge pool](https://treeseed-ai.github.io/dsh-chapters/start/link-pool/) · [§10 The pool](https://treeseed-ai.github.io/dsh-chapters/knowledge/pool/) |
| run any command — exact syntax, scope, outputs | [§15 Commands](https://treeseed-ai.github.io/dsh-chapters/reference/commands/) |
| know what the agent-facing tools do | [§16 Agent tools](https://treeseed-ai.github.io/dsh-chapters/reference/tools/) |
| tune a threshold, budget, or trigger | [§17 Configuration](https://treeseed-ai.github.io/dsh-chapters/reference/configuration/) |
| understand *why not summaries* / the economics | [§5 Why not summaries?](https://treeseed-ai.github.io/dsh-chapters/concepts/why-not-summaries/) |
| read the design rules the system won't break | [§6 The four invariants](https://treeseed-ai.github.io/dsh-chapters/concepts/invariants/) |
| the theory behind retrieval-over-compression (RLM) | [§8 Recursive context theory](https://treeseed-ai.github.io/dsh-chapters/concepts/recursive-context/) |
| propose/approve rules for agents | [§13 Rules & governance](https://treeseed-ai.github.io/dsh-chapters/knowledge/rules/) |
| debug something (“seems broken, is it?”) | [§4 FAQ & troubleshooting](https://treeseed-ai.github.io/dsh-chapters/start/faq/) |
| prompt-cache / llama.cpp behavior | [§21 Cache behavior on llama.cpp](https://treeseed-ai.github.io/dsh-chapters/evidence/llamacpp-cache/) |
| see measured results (production run + benchmarks) | [§19 Benchmarks](https://treeseed-ai.github.io/dsh-chapters/evidence/benchmarks/) · [§20 Field study](https://treeseed-ai.github.io/dsh-chapters/evidence/field-study/) |
| compare with other memory approaches | [§22 The alternatives, compared](https://treeseed-ai.github.io/dsh-chapters/evidence/comparison/) |
| check security/privacy boundaries | [§27 Security & privacy](https://treeseed-ai.github.io/dsh-chapters/operations/security/) |
| release history & known-fixed incidents | [§26 Changelog](https://treeseed-ai.github.io/dsh-chapters/operations/changelog/) |
| **develop the plugin itself** | [§24 Developing](https://treeseed-ai.github.io/dsh-chapters/operations/development/) → the engineering specs below |

## Developing / contributing

Three ways to set up a development environment — pick whichever fits your workflow:

| Mode | Best for | Command |
|------|----------|---------|
| **Centralized** (your live profile) | Day-to-day development on your main machine | `./dev/install/install.sh && dsh web` |
| **Compartmentalized** (isolated DSH_HOME) | Testing changes without touching your live sessions | `DSH_HOME=/tmp/dsh-dev ./dev/install/install.sh` |
| **Containerized** (full stack) | Isolated platform with vLLM + Playwright + Chromium | `cd dev/install && docker compose up -d` |

All three install the same plugin set: dsh-chapters, [dsh-codegraph](https://github.com/jiangzhenguo/dsh-codegraph)
(structural code search via pre-indexed AST graph), and dsh-tinyfish-search. Full details in
[`dev/install/README.md`](dev/install/README.md). The containerized stack additionally ships its own
vLLM model server (Qwen3-4B-AWQ with inference + systemone endpoints), a DSH Web UI service, and a
CI-capable test runner — everything runs locally with no external API keys required.

The site's Part VI covers the daily loop; the repository itself holds the engineering truth for agents:

- **[`AGENTS.md`](AGENTS.md)** — working spec for AI agents developing this repo (invariants, budget, hard rules)
- **[`docs/`](docs/)** — deep specs: `contract.md` (host API facts), `architecture.md` (mechanics), `development.md` (build/test loop + tape system), `verify.md` (every claim's procedure), `knowledge-repo.md` (design record), `host-compaction-seam.md`, `provider.md`
- **[`dev/install/`](dev/install/)** — installer, containerized platform, and local-llm skill
- **benchmarks**: `npm run bench` — three arms, local model, never CI ([protocol](benchmarks/README.md))

Feature requests and bugs: [open an issue](https://github.com/treeseed-ai/dsh-chapters/issues) —
measured reports get measured answers.

## License

Apache-2.0 — see [LICENSE](LICENSE). Your conversations, chapters, and knowledge pools stay yours.
