# Tape provenance — `compose` project (#420, C3's vehicle)

**Distilled 2026-11-19** against host `0.2.0-rc.2` (`dev/dsh-host-lock`), plugin at the #421 fix
(`lib/compose.js` symbol-verified `intersects`/`clippedStart` BEFORE recording — a stale-`lib` run is
exactly how records #2/#3 tested code nobody had shipped; the builder now greps its own bytes).
Last recorded verdict: exit 0 (`1 passed`, 1.8 min live), **11 tape entries**; model-free replay
verdict: **`1 passed` (48.3 s), 0 misses** — promoted to a chain leg on that proof (#411 gate).

- **Regime as recorded (from `tests/e2e/rig-pins.ts`, the single authority):** port 41745, threshold
  **0.7**, arrival floor 1000000, maxRetries 3. Replay boots the SAME regime or the tape means
  something else than it recorded (#56). The threshold was corrected from 0.6 by measurement: at 0.6
  relief fired MID-topic-2 and the eager pass clipped topic-1's signature before topic-2's was ever
  stored — no span then held two whole signatures, and composition was unreachable (two live records
  proved it, see the lesson chain below).
- **Upstream:** hosted endpoint (`token-plan…`, model `qwen3.8-flash`), identity guard-PROVEN at
  record time (`listed, and answered as itself`, #406/#409). Re-record recipe:
  `LEG=compose MODE=record E2E_PROVIDER=harness bash scripts/e2e-one.sh`.
- **Window enforcement:** the rig refuses any chat request whose whole body exceeds
  `E2E_WINDOW_TOKENS` (32000) in record AND replay, and never records a refusal.
- **What this tape proves on replay:** the composed path itself — a pressure crossing with two stored
  signatures relieves into **>=2 chapters set-covering the pass** with a **turn-opening seam**
  (chapter `u2`), codeword-clean bodies, coverage invariant, post-relief session health. A code change
  that breaks composition turns this leg RED in seconds, model-free. The archive titles are the
  discussion's own sentences ("…read docs/architecture.md…", "…read docs/development…") — the first
  corpus leg where compaction and TOC separation are verified FROM the conversation itself.
- **Lesson chain retained** (the five live records that built this asset): #421 product defect
  (`inSpan` wholesale-excludes clipped signatures — composer ran and merged, zero reasons); geometry
  defect (eager 0.6 relief clips cold stores); process defect (stale `lib/` — live class must verify
  the artifact, not the source); predicate over-specification (seams tolerate absorbed `turn/end` and
  legitimate sparse-shadow gaps). Each retired by named bytes, not by retry.
