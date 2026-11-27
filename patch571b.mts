import fs from 'node:fs'

let p = 'src/enrich-wire.ts'
let s = fs.readFileSync(p, 'utf8')
const need = (cond: boolean, label: string) => { if (!cond) { console.error('MISS:', label); process.exit(1) } }

// imports
need(s.includes("import { parseChapterFile, updateChapterFrontmatter } from './enrich-store.ts'"), 'imports')
s = s.replace("import { parseChapterFile, updateChapterFrontmatter } from './enrich-store.ts'",
  "import { parseChapterFile, updateChapterFrontmatter } from './enrich-store.ts'\nimport { sha256 } from './render.ts'")

// deps: planeId
need(s.includes("  projectCwds?: (() => string[]) | undefined"), 'plane-anchor')
s = s.replace("  projectCwds?: (() => string[]) | undefined",
  "  projectCwds?: (() => string[]) | undefined\n  /** #571: which pump surface this wiring is ('host' | 'realm') — names the lease holder. */\n  planeId?: string")

// runNow returns leaseHeldBy
need(s.includes("runNow(cwd?: string, limit?: number): Promise<{ processed: number; remaining: number; draining: boolean; alreadyRunning: boolean }>"), 'runIface')
s = s.replace("runNow(cwd?: string, limit?: number): Promise<{ processed: number; remaining: number; draining: boolean; alreadyRunning: boolean }>",
  "runNow(cwd?: string, limit?: number): Promise<{ processed: number; remaining: number; draining: boolean; alreadyRunning: boolean; leaseHeldBy?: string }>")
need(s.includes("      return { processed: 0, remaining, draining: d.started, alreadyRunning: d.alreadyRunning }"), 'runImpl')
s = s.replace("      return { processed: 0, remaining, draining: d.started, alreadyRunning: d.alreadyRunning }",
  "      return { processed: 0, remaining, draining: d.started, alreadyRunning: d.alreadyRunning, ...(d.leaseHeldBy !== undefined ? { leaseHeldBy: d.leaseHeldBy } : {}) }")

// queue deps: settings spine + planeId
need(s.includes("    ...(deps.setTimer !== undefined ? { setTimer: deps.setTimer } : {}),\n  })"), 'qdeps')
s = s.replace("    ...(deps.setTimer !== undefined ? { setTimer: deps.setTimer } : {}),\n  })",
  "    ...(deps.setTimer !== undefined ? { setTimer: deps.setTimer } : {}),\n    getSetting: (k) => deps.store.getSetting(k),\n    putSetting: async (k, v) => { await deps.store.putSetting(k, v ?? '') },\n    planeId: deps.planeId ?? 'host',\n  })")

// HEAL in the ladder: right after the plan-doc skip line
const planLine = "      if (doc.fmLines.some((l) => /^kind:\\s*plan\\s*$/.test(l))) return { ok: false, skipped: 'plan documents are directives — never annotated' }"
need(s.includes(planLine), 'plan-skip')
const heal = planLine + `
      // #571 HEAL (dual-queue split receipts): when the FILE already carries this model key's
      // annotation (the enrichment write landed but the registry commit did not — measured at
      // 354 records), the guarded rewrite would refuse FOREVER and head-block the queue. If the
      // file is body-self-consistent (the declared anchor matches the parsed body — so this is a
      // stale RECEIPT, not corruption) the ladder resyncs the registry record from the file and
      // counts it done, without any model call. Self-consistency failing stays a loud refusal:
      // real damage keeps the alarm that caught it.
      {
        const keyNow = modelKey()
        const genIdx = doc.fmLines.findIndex((l) => /^generated:/.test(l))
        const fileHasModelMark = genIdx >= 0 && doc.fmLines.slice(genIdx).some((l) => l.includes(\`model: \${keyNow}\`))
        if (fileHasModelMark) {
          const anchor = doc.fmLines.find((l) => /^(?:bodySha256|sha256):/.test(l))?.split(': ')[1]?.trim()
          const bodyText = doc.body
          const selfConsistent = anchor === undefined || anchor === sha256(bodyText) || anchor === sha256(bodyText.replace(/\\n$/, ''))
          if (selfConsistent) {
            const fmGet = (k: string): string | undefined => doc.fmLines.find((l) => l.startsWith(\`\${k}:\`))?.slice(k.length + 1).trim()
            const unq = (v: string | undefined): string | undefined => {
              if (v === undefined) return undefined
              try { return JSON.parse(v) as string } catch { return v.replace(/^"|"$/g, '') }
            }
            let topics: string[] | undefined
            const rawTopics = fmGet('topics')
            if (rawTopics !== undefined) { try { topics = JSON.parse(rawTopics) as string[] } catch { topics = undefined } }
            const atLine = doc.fmLines.slice(doc.fmLines.findIndex((l) => l.includes(\`model: \${keyNow}\`)) + 1, doc.fmLines.findIndex((l) => l.includes(\`model: \${keyNow}\`)) + 3).find((l) => /at:/.test(l))
            const at = atLine?.split(': ')[1]?.trim().replace(/^'|'$/g, '') ?? new Date().toISOString()
            const fileText = fs.readFileSync(file, 'utf8')
            await deps.store.mutate(sid, (fresh) => {
              const cur = fresh.chapters.find((c) => c.number === num)
              if (cur === undefined) return fresh
              return {
                ...fresh,
                chapters: fresh.chapters.map((c) => c.number === num
                  ? { ...c, title: unq(fmGet('title')) ?? c.title, summary: unq(fmGet('summary')) ?? c.summary, topics: topics ?? c.topics, generated: { ...(c.generated ?? {}), title: [{ by: 'model', model: keyNow, at }] }, sha256: sha256(fileText) }
                  : c),
              }
            })
            return { ok: true, resynced: true }
          }
        }
      }`
s = s.replace(planLine, heal)
fs.writeFileSync(p, s)
console.log('wire: heal + lease plumbing in')

// commands.ts: lease message + backoff wording
p = 'src/commands.ts'
s = fs.readFileSync(p, 'utf8')
need(s.includes("  runNow(cwd?: string, limit?: number): Promise<{ processed: number; remaining: number; draining: boolean; alreadyRunning: boolean }>"), 'cmdIface')
s = s.replace("  runNow(cwd?: string, limit?: number): Promise<{ processed: number; remaining: number; draining: boolean; alreadyRunning: boolean }>",
  "  runNow(cwd?: string, limit?: number): Promise<{ processed: number; remaining: number; draining: boolean; alreadyRunning: boolean; leaseHeldBy?: string }>")
const runMsg = "          return { kind: 'success', text: r.alreadyRunning\n            ? `enrichment: a drain is ALREADY RUNNING (${r.remaining} pending) — one pump at a time; /chapters-enrich report follows the count`\n            : `enrichment: draining ${scope} — ${r.remaining} pending, batches of ${String(config.enrich.batchCap())}, failure stops the pump; /chapters-enrich report follows the count` }"
need(s.includes(runMsg), 'runMsg')
s = s.replace(runMsg, "          return { kind: r.leaseHeldBy === undefined ? 'success' : 'error', text: r.leaseHeldBy !== undefined\n            ? `enrichment: \${r.leaseHeldBy} holds the drain lease — one pump over the shared registry at a time (#571); try again when it ends, /chapters-enrich report shows the holder's progress`\n            : r.alreadyRunning\n              ? `enrichment: a drain is ALREADY RUNNING (\${r.remaining} pending) — one pump at a time; /chapters-enrich report follows the count`\n              : `enrichment: draining \${scope} — \${r.remaining} pending, batches of \${String(config.enrich.batchCap())}, transient model failures back off 3x before the pump stops; /chapters-enrich report follows the count` }")
fs.writeFileSync(p, s)
console.log('commands: lease message in')

// index.ts + engine.ts wiring pass planeId
p = 'src/index.ts'
s = fs.readFileSync(p, 'utf8')
need(s.includes("      sessionCwdOf: async (sid) => (await readDurableSession((name) => { try { return ctx.get?.(name) } catch { return undefined } }, sid))?.header?.cwd ?? undefined,"), 'idx-anchor')
s = s.replace("      sessionCwdOf: async (sid) => (await readDurableSession((name) => { try { return ctx.get?.(name) } catch { return undefined } }, sid))?.header?.cwd ?? undefined,",
  "      sessionCwdOf: async (sid) => (await readDurableSession((name) => { try { return ctx.get?.(name) } catch { return undefined } }, sid))?.header?.cwd ?? undefined,\n      planeId: 'host', // #571")
fs.writeFileSync(p, s)
p = 'src/engine.ts'
s = fs.readFileSync(p, 'utf8')
need(s.includes("      sessionCwdOf: async (sid) => (await readDurableSession((name) => { try { return this.ctx.get?.(name) } catch { return undefined } }, sid))?.header?.cwd ?? undefined,"), 'eng-anchor')
s = s.replace("      sessionCwdOf: async (sid) => (await readDurableSession((name) => { try { return this.ctx.get?.(name) } catch { return undefined } }, sid))?.header?.cwd ?? undefined,",
  "      sessionCwdOf: async (sid) => (await readDurableSession((name) => { try { return this.ctx.get?.(name) } catch { return undefined } }, sid))?.header?.cwd ?? undefined,\n      planeId: 'realm', // #571")
fs.writeFileSync(p, s)
console.log('planes labeled')
