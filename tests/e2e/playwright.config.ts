/**
 * Two projects, two boots (see boot.ts): the main suite (identity, forks,
 * knowledge loop, oversized-turn, fan-out) and the arrival-artifact suite,
 * which pins a low arrival floor on the engine row. Each project owns its
 * server; var/e2e-boot.json carries the current URL to openApp().
 * PLAYWRIGHT_BROWSERS_PATH must point at var/ms-playwright (workspace-cached
 * browsers); run via `npx playwright test -c tests/e2e/playwright.config.ts`.
 */
import { defineConfig } from '@playwright/test'
import { rigEnv } from './rig-pins.ts'

export default defineConfig({
  testDir: '.',
  timeout: 300_000,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'var/e2e-results.json' }]],
  use: { headless: true, viewport: { width: 1360, height: 900 } },
  globalSetup: './globalSetup.ts',
  projects: [
    // #56: the regime is AUTHORITY, not a runner flag. Pins lived in three places — this
    // config's comment claimed distill "mirrors npm run test:e2e exactly", and nothing
    // enforced it. Measured: `test:e2e` boots suite/rules/fork with NO threshold, while
    // distill recorded them at 0.75/0.9/0.75 — so replay ran a different realm than the
    // tape was distilled under, the surface diverged (stubs appearing where none were
    // recorded), and the proxy MISSed. Playwright merges project `env` into every worker,
    // so record, replay, coverage and a manual run now boot the SAME world.
    { name: 'suite', env: rigEnv('suite'), testIgnore: ['**/artifact-arrival.spec.ts', '**/oversized-turn.spec.ts', '**/enrich.spec.ts', '**/rules.spec.ts', '**/subagent-fanout.spec.ts', '**/explore.spec.ts', '**/fork-button.spec.ts', '**/cache-trajectory.spec.ts', '**/plans.spec.ts', '**/prompt-bar.spec.ts', '**/prompt-off.spec.ts'] },
    // fork-button rides its OWN boot (2026-09-25, the fanout lesson applied
    // again): knowledge's fork child becomes the workspace's restore target,
    // so a shared boot records/replays whoever ran first's shape — the fork
    // spec's draft landed INSIDE knowledge's child on replay (tape diff proof:
    // its request's msg0 was the child's TOC notice). One boot, one journey.
    { name: 'fork', env: rigEnv('fork'), testMatch: ['**/fork-button.spec.ts'] },
    // explore.spec is the selector-archaeology DEV fixture (its header says so):
    // one plain turn + an aria dump, zero acceptance assertions beyond what
    // fork-button proves on the same machinery. Its live turn grew unbounded
    // on the suite boot's arrival floor (the read stubs, qwen then explores the
    // artifact API past any cap) — so it runs ON DEMAND only, never in the CI
    // chain (2026-09-25): npx playwright test --project=explore-dev
    { name: 'explore-dev', testMatch: ['**/explore.spec.ts'], use: { baseURL: undefined } },
    // plans: the session-plan carriage journey (docs/plans-carriage.md), IN THE
    // CHAIN since 2026-10-10. Its tape was distilled from the scripted upstream
    // (tests/e2e/stub-model.ts) because the box's :8080 model server dropped the
    // stream mid-journey — read tests/fixtures/model-tape/plans/PROVENANCE.md for
    // what that does and does not prove, and how to re-record from the live model.
    // Own boot, own port, own tape, like every other project (one journey, one boot).
    // Its threshold is pinned to 0.99 (not the 0.9 stress regime) on purpose: this
    // journey must never be interrupted by pressure compaction. The hosted runner
    // measured its header a little differently and fired a plot-elicitation call the
    // tape had never seen — a MISS that was real, and entirely avoidable (0.1.10).
    { name: 'plans', env: rigEnv('plans'), testMatch: ['**/plans.spec.ts'] },
    // cache-trajectory measures PHYSICAL prefix caching — live mode only, never
    // in the replay chain (tapes record usage bytes; they cannot show a warm cache).
    { name: 'cache', testMatch: ['**/cache-trajectory.spec.ts'], timeout: 900_000 },
    // heavy: oversized compaction scenarios boot at threshold 0.5 (trigger
    // 16K of 32K) so the crossing arrives in the FIRST chunks — capture on
    // the live model stays in minutes, and replay of the tape is identical.
    { name: 'heavy', env: rigEnv('heavy'), testMatch: ['**/oversized-turn.spec.ts'] },
    { name: 'arrival', env: rigEnv('arrival'), testMatch: ['**/artifact-arrival.spec.ts'] },
    // fanout: the two-subagent research journey gets its OWN boot and tape
    // (2026-09-23, lesson of the suite-context chains): its child sessions
    // make the deepest request arrays on this hardware, and sharing the suite
    // boot made its tape record the shape of whoever ran first. Same 0.75
    // stress pin as the suite; E2E_TAPE=fanout in the scripts chain.
    { name: 'fanout', env: rigEnv('fanout'), testMatch: ['**/subagent-fanout.spec.ts'] },
    // enrich: the P2 enrichment ladder end-to-end; boots with
    // enrichmentEnabled TRUE (its tape carries the ladder's model call).
    { name: 'enrich', env: rigEnv('enrich'), testMatch: ['**/enrich.spec.ts'] },
    // rules: the P3 lifecycle in the browser over a local-path pool.
    { name: 'rules', env: rigEnv('rules'), testMatch: ['**/rules.spec.ts'] },
    // The docked Suggested Next Step bar (#113). Its own boot, because the bar only exists when a defining
    // model is configured — sharing a boot would make other legs acquire a component nobody distilled for.
    { name: 'prompt', env: rigEnv('prompt'), testMatch: ['**/prompt-bar.spec.ts'] },
    // Same journey, switch off: the bar must be absent. See tests/e2e/prompt-off.spec.ts.
    { name: 'prompt-off', env: rigEnv('prompt-off'), testMatch: ['**/prompt-off.spec.ts'] },
    // #138: LIVE-only goal journeys (see the pin comment). Deliberately absent from `scripts/chain-replay.sh`'s leg
    // list, so the model-free acceptance job does NOT cover these two claims — a live run does. Recorded, not hidden.
    { name: 'prompt-goal-live', env: rigEnv('prompt-goal-live'), testMatch: ['**/prompt-goal-live.spec.ts'] },
  ],
})
