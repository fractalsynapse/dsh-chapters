/**
 * #386 — the release workflow's manual trigger published by default.
 *
 * `workflow_dispatch` took `dry_run` with `default: false`, so Actions → "Run workflow" — the obvious way
 * to check the release job still works — PUBLISHED, and versions/tags are immutable here (0.2.17/18/19 and
 * the stale-tree 0.2.20 are the record). One forgotten checkbox cost a version number forever.
 *
 * The safety property is about BEHAVIOUR under the two trigger paths, so the interesting rows below
 * EXTRACT THE ACTUAL SHELL from the workflow and RUN it in a temp directory against a fake manifest.
 * Asserting that the YAML contains `inputs.publish` would pass while the gate stayed broken -- and a
 * second draft of this file nearly did exactly that, because a `!inputs.dry_run` rewrite that dropped the
 * tag-push branch would have made CI green while the release job never published again.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const file = new URL('../../.github/workflows/release.yml', import.meta.url)
const src = readFileSync(file, 'utf8')

/**
 * Parse the workflow with PyYAML, via python3 -- the SAME parser `ci.yml`'s own "workflow files parse"
 * step uses, so the test and the gate agree on what valid YAML is.
 *
 * Why not `import YAML from 'yaml'`: it resolved cleanly on this machine and every row passed -- because
 * Node walked UP out of the project and found `/home/adrian/node_modules/yaml`, a stray install that
 * exists nowhere on CI. A `package.json` declaration would not rescue it either: `npm ci` fails when the
 * lock file is out of sync, and the lock cannot be regenerated in this sandbox (read-only npm cache).
 * So the dependency is python, which is already a build-time requirement of the very guard being tested.
 * The 6/6 I saw BEFORE noticing the resolution path is the story this release is named for.
 */
function parseWorkflow(path: string): unknown {
  const py = [
    'import json, sys, yaml',
    'd = yaml.safe_load(open(sys.argv[1]))',
  // YAML 1.1 (which PyYAML implements) turns the bare key `on:` into boolean True, so json.dumps emits
  // {"true": ...} and every `doc.on....` lookup is undefined. Values keep their real types -- only the
  // mapping KEY is repaired. GitHub's own parser treats `on:` as the string, which is why the workflow
  // is valid and only this test was wrong.
    'def fix(x):',
    '    if isinstance(x, dict):',
    '        return {("on" if k is True else "off" if k is False else k): fix(v) for k, v in x.items()}',
    '    if isinstance(x, list):',
    '        return [fix(i) for i in x]',
    '    return x',
    'print(json.dumps(fix(d)))',
  ].join('\n')
  const out = execFileSync('python3', ['-c', py, path], { encoding: 'utf8' })
  return JSON.parse(out)
}

const doc = parseWorkflow(file.pathname) as {
  on: { push: { tags: string[] }; workflow_dispatch: { inputs: Record<string, { type: string; default: unknown }> } }
  jobs: { publish: { steps: Array<{ name?: string; if?: string; run?: string }> } }
}
const steps = doc.jobs.publish.steps
const byName = (re: RegExp) => steps.find((s) => re.test(s.name ?? ''))

test('#386: the workflow still parses -- CI refuses a malformed one, and this file is the same guard early', () => {
  assert.ok(doc.on.push.tags.includes('*.*.*'), 'tag trigger intact')
  assert.ok(steps.length > 5, 'the job still has its steps')
})

test('#386: the safe path is the DEFAULT -- there is no longer an input whose absence means "publish"', () => {
  const inputs = doc.on.workflow_dispatch.inputs
  assert.equal(inputs['dry_run'], undefined,
    'dry_run must not come back: a boolean that means "publish" when unchecked is the defect')
  assert.ok(inputs['publish'] !== undefined, 'publishing is a positive input now')
  assert.equal(inputs['publish']!.default, false, 'and its DEFAULT rehearses')
  assert.equal(inputs['publish']!.type, 'boolean')
  // Two independent acts: opt in, then name the version.
  assert.ok(inputs['confirm_version'] !== undefined, 'a version confirmation input exists')
  assert.equal(inputs['confirm_version']!.type, 'string', 'typed, not ticked -- a checkbox cannot carry intent')
  assert.equal(inputs['confirm_version']!.default, '', 'and it starts EMPTY, so the default cannot match a real version')
})

test('#386: a TAG PUSH still publishes -- the gate is disjunction, not replacement', () => {
  const publishStep = byName(/^publish \(/)
  assert.ok(publishStep !== undefined, 'the publish step exists')
  const cond = publishStep!.if ?? ''
  assert.match(cond, /startsWith\(github\.ref, 'refs\/tags\/'\)/,
    'the tag path must remain sufficient -- a rewrite to `inputs.publish == true` alone would silently NEVER publish')
  assert.match(cond, /inputs\.publish == true/, 'and the dispatch path requires the positive input')
  assert.match(cond, /\|\|/, 'joined by OR, so each trigger is independently sufficient')
  // Same condition on the steps that describe the outcome, or CI would "verify" a publish that never ran.
  for (const re of [/verify the published bundle/, /^shipped$/]) {
    const s = byName(re)
    assert.ok(s !== undefined, `step ${String(re)} still present`)
    assert.equal(s!.if, cond, `its gate must match the publish gate, not diverge from it`)
  }
})

/** Run the confirmation shell with the workflow's own text, substituting GitHub's expression inputs. */
function runConfirmGate(inputs: { publish?: string; confirm_version?: string }): { code: number, out: string } {
  const step = byName(/manual publish confirmation/)
  assert.ok(step !== undefined && step.run !== undefined, 'the confirmation step must exist')
  const dir = mkdtempSync(join(tmpdir(), 'relgate-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }))
    const script = (step.run as string)
      .replace(/\$\{\{\s*inputs\.publish\s*\}\}/g, inputs.publish ?? '')
      .replace(/\$\{\{\s*inputs\.confirm_version\s*\}\}/g, inputs.confirm_version ?? '')
    writeFileSync(join(dir, 'gate.sh'), script)
    try {
      const out = execFileSync('bash', ['gate.sh'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (error) {
      const e = error as { status?: number, stdout?: string, stderr?: string }
      return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('#386: the confirmation gate is EXECUTED, and refuses every unconfirmed publish', () => {
  // Rehearsal: publish absent/false -> exit 0, and it says the publish step will be skipped.
  const rehearsal = runConfirmGate({ publish: 'false', confirm_version: '' })
  assert.equal(rehearsal.code, 0, `a rehearsal must pass: ${rehearsal.out}`)
  assert.match(rehearsal.out, /Rehearsal/, 'and name what it is')

  // The whole point: a dispatch with the input left alone does NOT publish.
  const nothingTicked = runConfirmGate({})
  assert.equal(nothingTicked.code, 0, 'empty inputs are a rehearsal, not a publish')
  assert.match(nothingTicked.out, /Rehearsal/)

  // Publish requested, version not typed -> refuse.
  const noVersion = runConfirmGate({ publish: 'true', confirm_version: '' })
  assert.equal(noVersion.code, 1, 'publish without the version confirmation must fail the run')
  assert.match(noVersion.out, /refusing to publish/)

  // Wrong version typed -> refuse (a typo of another number is not consent to this one).
  const wrongVersion = runConfirmGate({ publish: 'true', confirm_version: '9.9.8' })
  assert.equal(wrongVersion.code, 1, 'a mismatched version must fail')
  assert.match(wrongVersion.out, /refusing to publish/)

  // Exact version -> allowed.
  const confirmed = runConfirmGate({ publish: 'true', confirm_version: '9.9.9' })
  assert.equal(confirmed.code, 0, confirmed.out)
  assert.match(confirmed.out, /Publish CONFIRMED for 9\.9\.9/)
})

test('#386: the confirmation runs BEFORE the publish step, not after it', () => {
  // A gate that fires after the artifact is on the registry is documentation, not protection. Order is
  // the property, and it is the thing a later edit can break without touching either condition string.
  const gate = steps.findIndex((s) => /manual publish confirmation/.test(s.name ?? ''))
  const pub = steps.findIndex((s) => /^publish \(/.test(s.name ?? ''))
  assert.ok(gate >= 0 && pub >= 0, 'both steps exist')
  assert.ok(gate < pub, `confirmation (step ${String(gate)}) must precede publish (step ${String(pub)})`)
  const pack = steps.findIndex((s) => /pack preview/.test(s.name ?? ''))
  assert.ok(pack >= 0 && pack < pub, 'the pack preview still runs before publishing, on every path')
})

test('#386: nothing reachable still references the removed input', () => {
  // `!inputs.dry_run` on a step would now always be true (the input no longer exists), silently
  // un-gating the publish step -- the inverse of the intended fix. Only comments may mention it.
  const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('#'))
  const offenders = codeLines.filter((l) => l.includes('dry_run'))
  assert.deepEqual(offenders, [],
    `dry_run survives outside comments, so a step gate may be comparing an input that no longer exists: ${JSON.stringify(offenders.map((o) => o.trim().slice(0, 70)))}`)
})
