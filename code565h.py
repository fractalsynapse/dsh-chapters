p = 'src/enrich-wire.ts'
s = open(p).read()
old = "  batchCap(): number"
assert s.count(old) == 1
s = s.replace(old, "  batchCap(): number\n  /** #565: the background drain's live state (surfaces and tests await it). */\n  isDraining(): boolean")
old2 = "    batchCap: () => deps.config.batchCap,"
assert s.count(old2) == 1
s = s.replace(old2, "    batchCap: () => deps.config.batchCap,\n    isDraining: () => queue.isDraining(),")
open(p, 'w').write(s)
print('wiring exposes isDraining')

import re
# update the six rows in both enrich test files: runNow now STARTS the drain; await it, then assert effects
for path in ['tests/unit/enrich-owning-cwd.test.ts', 'tests/unit/enrich-legacy-heal.test.ts']:
    s = open(path).read()
    # pattern: const r = await createEnrichWiring(...).runNow()  /  const r = await w.runNow()
    s = s.replace("""    const r = await createEnrichWiring(h.deps).runNow()
    assert.equal(r.processed, 1, 'the row located its own file — the cross-workspace skip is gone')""",
"""    const w = createEnrichWiring(h.deps)
    w.runNow()
    assert.equal(w.isDraining(), true, '#565: run starts a background drain')
    for (let i = 0; i < 60 && w.isDraining(); i += 1) await new Promise((res) => setImmediate(res))
    assert.equal(w.isDraining(), false)""")
    open(path, 'w').write(s)
print('pass 1')
