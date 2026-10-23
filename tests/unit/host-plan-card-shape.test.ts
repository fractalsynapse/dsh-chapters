/**
 * What the 0.2.x host puts on screen when a plan goes up for review (#56).
 *
 * `plans.spec` asserted that the LAST body line of the submission was inside the review card, and
 * it failed — correctly, but for a reason the spec did not know: on this host the review region is
 * a COMPACT card (title + first paragraph), and the whole document lives behind "View full plan"
 * in the sidebar. That is host UI drift, not lost carriage: the full bytes still reach the human,
 * somewhere else on the screen. The rows below pin WHERE, against the bundle the legs actually
 * run, so the next rename reddens a row instead of burning an acceptance evening.
 *
 * Resolved from `dev/dsh-host-lock/node_modules` — the host the rig boots — NOT from the repo's own
 * `node_modules`, which still carries the 0.1.5-rc.2 compile-time closure (docs/backlog.md #71).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

/**
 * Where the HOST packages actually live, in the order of "is this what the legs boot?":
 *  1. resolved from the `dsh` binary on PATH — literally the runtime `spawn('dsh', ['web'])`
 *     uses (measured here: /home/adrian/node_modules/@deepseek-ai/dsh/lib/bin.js);
 *  2. `dev/dsh-host-lock/node_modules` — the hermetic install CI builds;
 *  3. the repo's own `node_modules` — WRONG VERSION for host facts (0.1.5-rc.2 compile-time
 *     closure, docs/backlog.md #71), so it is consulted last and named in the failure text.
 */
/** The host version the repo pins for testing (`dev/dsh-host-lock/package.json`). */
function pinnedHostVersion(): string | null {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'dsh-host-lock', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>, devDependencies?: Record<string, string> }
    return p.dependencies?.['@deepseek-ai/dsh'] ?? p.devDependencies?.['@deepseek-ai/dsh'] ?? null
  } catch { return null }
}

function hostTree(): string {
  const candidates: string[] = []
  try {
    const bin = execSync('readlink -f "$(command -v dsh)"', { encoding: 'utf8' }).trim()
    if (bin) {
      const at = bin.indexOf('/@deepseek-ai/')
      if (at > 0) candidates.push(`${bin.slice(0, at)}/@deepseek-ai`)
    }
  } catch { /* no dsh on PATH — fall through to the installed trees */ }
  candidates.push(path.join(ROOT, 'dev', 'dsh-host-lock', 'node_modules', '@deepseek-ai'))
  candidates.push(path.join(ROOT, 'node_modules', '@deepseek-ai'))
  for (const c of candidates) {
    if (!fs.existsSync(path.join(c, 'dsh-client-ui-plan', 'lib', 'client.js'))) continue
    // #89: the comment above says the repo's own tree is the WRONG VERSION for host facts, and then
    // happily returned it. On a runner with no pinned-host install that fallback is what ran, and the
    // row failed against 0.1.5-rc.2 while claiming to read the host the rig boots. Read the pin, and
    // refuse a mismatch — a red that names its cause beats a red that looks like a product defect.
    const want = pinnedHostVersion()
    const got = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(c, 'dsh-client-ui-plan', 'package.json'), 'utf8')) as { version?: string }
      } catch { return null }
    })()?.version
    if (want !== null && got !== null && got !== want) {
      throw new Error(`host-plan-card-shape resolved a STALE host tree (${got}) where the rig pins ${want}.`
        + ' The deterministic CI job must install it — see the "install the pinned DSH host" step in'
        + ` .github/workflows/ci.yml. Tried: ${candidates.join(' , ')}`)
    }
    return c
  }
  throw new Error(`no pinned-host tree with dsh-client-ui-plan found; tried: ${candidates.join(' , ')}`)
}
const HOST = hostTree()

const read = (pkg: string): string => {
  const p = path.join(HOST, pkg, 'lib', 'client.js')
  assert.ok(fs.existsSync(p), `the pinned host must ship ${pkg}/lib/client.js (resolved from ${HOST})`)
  return fs.readFileSync(p, 'utf8')
}

test('the pinned host is present at all — no host, no assertion', () => {
  assert.ok(fs.existsSync(HOST), `no pinned host tree at ${HOST}: run the lock install before trusting this gate`)
})

test('the review takeover still renders the plan as first-line + first-paragraph', () => {
  const s = read('dsh-client-ui-user-questions')
  // the bundle form is `(0, pkg.extractMarkdownPlainText)(review.plan, { mode: "…" })` — the
  // call is separated from the name by `)(`, so a `\([^)]*` pattern matches nothing and the
  // row would "fail" against a host that is behaving exactly as pinned. Match the shipped text.
  assert.match(s, /extractMarkdownPlainText\)\([^,]+,\s*\{\s*mode:\s*["']first-line["']/,
    'the card title is the plan’s first line')
  assert.match(s, /extractMarkdownPlainText\)\([^,]+,\s*\{\s*mode:\s*["']first-paragraph["']/,
    'and its description is the FIRST PARAGRAPH — which is why asserting the last body line here was wrong')
})

test('the whole document is reachable through a named preview affordance', () => {
  const s = read('dsh-client-ui-plan')
  assert.match(s, /preview\.full/, 'the host exposes a full-plan preview entry')
  assert.match(s, /["']View full plan["']/, 'with the label the browser test clicks — if this string moves, the journey must move in the same change')
})

test('the browser journey asserts the card AND the full document, never one for the other', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'plans.spec.ts'), 'utf8')
  assert.match(spec, /View full plan/, 'it must open the full document')
  assert.match(spec, /first paragraph|firstParagraph|PARA1/i, 'and state what the collapsed card is expected to show')
  assert.doesNotMatch(spec, /and the body is on screen, not just the title/,
    'the old claim — last body line inside the card — is retired WITH ITS REASON, not silently')
})
