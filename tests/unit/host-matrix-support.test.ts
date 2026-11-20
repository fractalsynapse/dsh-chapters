/**
 * #443 — the matrix's judgment layer, without a boot.
 *
 * The sweep's value is ATTRIBUTION: a red cell must name the seam. These rows pin the classifier
 * against the REAL boot-line texts, including the two incidents of 2026-11-19 verbatim — the
 * home-contamination BROKEN line (#437) and the rig's floor refusal — so the negative control the
 * issue asks for (a cell that must go red for a named reason) is proven here on fixture bytes as
 * well as live on a below-floor version.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUPPORT_FLOOR, versionGe, matrixTargets, classifyBootState, cellVerdict, isFloorRefusal, matrixPort,
} from '../../tests/e2e/host-matrix-support.ts'

test('#443: the target list is every registry version at/above the floor, sorted, prereleases included', () => {
  const json = JSON.stringify(['0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.4', '0.2.1-rc.4', '0.2.2-rc.5', 'garbage-not-a-version'.replace('garbage-not-a-version', '0.1.6-alpha.1')])
  assert.deepEqual(matrixTargets(json), ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.4', '0.2.1-rc.4', '0.2.2-rc.5'])
  assert.ok(matrixTargets(json).every((v) => !v.startsWith('0.1.')),
    '#446 maintainer decision: 0.1.* is deprecated — the DEFAULT list (no explicit controls) never includes one')
  assert.deepEqual(matrixTargets(json, { includeBelowFloor: ['0.1.7-rc.2'] }),
    ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.4', '0.2.1-rc.4', '0.2.2-rc.5', '0.1.7-rc.2'],
    'below-floor controls APPEND when explicitly requested, never interleave into the supported block')
  assert.deepEqual(matrixTargets('not json'), [], 'a dead registry answers with an empty list, not a throw')
})

test('#443: versionGe honors prerelease ordering (rc < final, alpha < rc)', () => {
  assert.equal(versionGe('0.2.0', '0.2.0-rc.2'), true, 'a final beats its own rcs')
  assert.equal(versionGe('0.2.0-rc.1', '0.2.0'), false, 'and the floor means the floor')
  assert.equal(versionGe('0.2.1-alpha.4', '0.2.1-rc.1'), false)
  assert.equal(versionGe('0.2.2-rc.5', SUPPORT_FLOOR), true)
  assert.equal(versionGe('0.1.9.0', SUPPORT_FLOOR), false)
})

/** The exact line src/preset.ts emits, measured in the #437 incident (home contamination). */
const BROKEN_LINE = 'dsh-chapters: preset "chapters" is DECLARED BUT BROKEN — tool-schedule (@deepseek-ai/dsh-tool-schedule): never started — sessions choosing it will not compose. A preset row whose child plugin no longer resolves fails here; the plugin drops rows this host cannot import, so this line means a package that resolves but will not activate — re-anchor the preset-chapters row against this host. Details: tool-schedule (@deepseek-ai/dsh-tool-schedule): never started'

test('#443: classifyBootState reads the four real boot states', () => {
  const b1 = classifyBootState(BROKEN_LINE)
  assert.equal(b1.state, 'broken', 'the #437 line verbatim classifies broken')
  assert.deepEqual(b1.dropped, ['@deepseek-ai/dsh-tool-schedule'], 'the Details clause NAMED the unactivatable row — attribution, not just the fact')
  const b2 = classifyBootState('dsh-chapters: preset "chapters" is DECLARED BUT BROKEN — Cannot read properties of undefined (reading \'parent\') — sessions choosing it will not compose. … Details: Cannot read properties of undefined (reading \'parent\')')
  assert.equal(b2.state, 'broken')
  assert.match(b2.dropped[0] ?? '', /Cannot read properties/, 'a host-INTERNAL fault is still attributed verbatim (0.2.2-alpha.2 measured)')
  assert.equal(classifyBootState('dsh-chapters: preset "chapters" registered as a declaration row').state, 'registered')
  assert.equal(classifyBootState('dsh-chapters: this host cannot register preset declaration rows (before 0.2.0) — every chapters session…').state, 'unsupported')
  const pruned = classifyBootState('dsh-chapters: preset "chapters" registered — dropped 2 row(s) this host cannot import: tool-schedule (@deepseek-ai/dsh-tool-schedule), planning (cordis:group) (one unresolvable row would…)')
  assert.equal(pruned.state, 'pruned', 'pruned is registered-with-attribution, a DISTINCT state from success')
  assert.deepEqual(pruned.dropped, ['@deepseek-ai/dsh-tool-schedule', 'cordis:group'], 'and every dropped row rides the verdict — silent drops are the #57 class')
  assert.equal(classifyBootState('chapters-tools registered; turn/end door armed').state, 'absent', 'no preset line is a STATE the sweep reports, never a silent pass')
})

test('#443: cellVerdict attributes before it concludes (the table says WHY)', () => {
  const ok = { installOk: true, bootOk: true, preset: 'registered' as const, dropped: [], composed: true }
  assert.deepEqual(cellVerdict(ok), { verdict: 'pass', why: 'composed' })
  // The healthy registration line is logger.info — it rides the HOST's log stream, not the stderr
  // pipe the cell can read. An `absent` classification with a composed session is therefore the
  // healthy shape; `absent` WITHOUT composition is the unattributable one that stays red.
  const quiet = cellVerdict({ ...ok, preset: 'absent' as const })
  assert.equal(quiet.verdict, 'pass', 'composed + no loud failure line = pass, stated as such')
  assert.match(quiet.why, /info line|log stream/, 'and the why says where the quiet line lives')
  // The strict probe (#443 sweep round 1): a session that exists but never recorded
  // agentPreset=chapters is NOT composed — the below-floor false-pass this closes.
  const silent = cellVerdict({ ...ok, preset: 'absent' as const, composed: false, composeError: 'agent-preset/selected never became "chapters" (seen: null)' })
  assert.equal(silent.verdict, 'fail-compose', 'no boot line and no chapters header is a compose failure with its own reason, not a boot failure')
  assert.match(silent.why, /never became "chapters"/, 'and the probe text rides through')
  assert.equal(cellVerdict({ ...ok, composed: false, composeError: 'new-session click never set dsh.sessions.current' }).verdict, 'fail-compose')
  assert.match(cellVerdict({ ...ok, composed: false, composeError: 'new-session click never set dsh.sessions.current' }).why, /new-session click/, 'the probe error text rides the why')
  assert.match(cellVerdict({ ...ok, composed: false, composeError: 'x' }).why, /: x$/, 'verbatim, whatever it says')
  assert.deepEqual(cellVerdict({ ...ok, preset: 'broken' as const, dropped: ['@deepseek-ai/dsh-tool-schedule'] }),
    { verdict: 'fail-broken-preset', why: 'DECLARED BUT BROKEN — rows this host cannot activate: @deepseek-ai/dsh-tool-schedule' })
  assert.equal(cellVerdict({ ...ok, preset: 'unsupported' as const }).verdict, 'fail-unsupported')
  assert.equal(cellVerdict({ installOk: false, bootOk: true, preset: 'registered', dropped: [], composed: true }).verdict, 'fail-install')
  const pruned = cellVerdict({ ...ok, preset: 'pruned' as const, dropped: ['@deepseek-ai/dsh-tool-schedule'] })
  assert.equal(pruned.verdict, 'pass', 'pruned rows on a host that never shipped them is drift NAMED, not a failure')
  assert.match(pruned.why, /pruned as unshipped/)
})

test('#443: the rig floor refusal is recognized, not crashed on', () => {
  const refusal = 'Error: e2e: the pinned host (@deepseek-ai/dsh 0.1.7-rc.2) cannot register preset declaration rows; this plugin supports >= 0.2.0. Move dev/dsh-host-lock to a 0.2.x host and re-distill the tapes.'
  assert.equal(isFloorRefusal(refusal), true)
  assert.equal(isFloorRefusal('some other boot failure'), false)
})

test('#443: matrix ports live in their own band, clear of the rig chain', () => {
  assert.equal(matrixPort(0), 41900)
  assert.ok(matrixPort(31) > 41746, 'never collides with the rig band 41731-41746')
  // proxy = boot + 1000 must also stay out of the rig proxies
  assert.ok(matrixPort(0) + 1000 > 42731)
})
