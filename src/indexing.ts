/**
 * Layer 2 of the two-layer index (knowledge-repo.md §10.2): the compressed,
 * searchable, sharded index derived from chapter frontmatter + Layer-1
 * curation facts. PURE + DETERMINISTIC: same inputs → same shards, and an
 * empty manifest rebuilds the whole index identically (the recovery path).
 *
 * Shards are one file per canonical topic (alphabetical — bounded files,
 * writes from different chapters usually touch different shards). Layer 1
 * (`edits/<harness>/curation.jsonl`) is where humans and the plugin inject
 * aliases, weights, pins, and group facts; this module applies them.
 */

export interface IndexEntry {
  /** Repo-relative chapter path (chapters/<key>/<session>/<file>). */
  path: string
  title: string
  topics: string[]
  /** `plan` comes from the file's OWN `kind:` frontmatter (plans live beside
   * chapters in the store), so it is never inferred from the directory. */
  kind: 'chapter' | 'rule' | 'plan'
  /** P3: rule category (chapters omit). */
  category?: string
  /** Milliseconds; missing → sorts first within its topic shard. */
  mtime?: number
  /** S5 stitch view: additional member paths (this entry's `path` is the
   * canonical first member). Single-file entries omit it. */
  paths?: string[]
  /** CodeGraph symbols verified against the project index at archive time.
   *  Absent on chapters archived before CodeGraph integration or when the
   *  project was not indexed. Used by search scoring. */
  codegraphSymbols?: string[]
}

/**
 * S5 (record §4.3 boundary): fragment coherence at the INDEX level only.
 * Legacy compaction fragments (turn-blind slices titled 'Earlier history'/
 * 'Conversation span') that sit adjacent by chapter number within one
 * session tree cohere into a single search entry citing every member file.
 * Nothing on disk merges, no chapter is rewritten, the split rule is
 * untouched — a pure function of what is already stored, so it is idempotent
 * and vanishes if any member is reverted.
 */
const FRAGMENT_TITLE = /^(?:Earlier history|Conversation span)/
function chapterNumber(path: string): number | null {
  const base = path.split('/').pop() ?? ''
  const n = /^(\d+)-/.exec(base)
  return n !== null ? Number(n[1]) : null
}

export function stitchFragments(entries: readonly IndexEntry[]): IndexEntry[] {
  // group by session directory, keep input order
  const byDir = new Map<string, IndexEntry[]>()
  const loose: IndexEntry[] = []
  for (const e of entries) {
    const dir = e.path.split('/').slice(0, -1).join('/')
    const isFrag = FRAGMENT_TITLE.test(e.title)
    if (!isFrag || chapterNumber(e.path) === null) { loose.push(e); continue }
    const list = byDir.get(dir)
    if (list === undefined) byDir.set(dir, [e])
    else list.push(e)
  }
  const out = [...loose]
  for (const [dir, frags] of byDir) {
    const sorted = [...frags].sort((a, b) => (chapterNumber(a.path) ?? 0) - (chapterNumber(b.path) ?? 0))
    let i = 0
    while (i < sorted.length) {
      let j = i
      while (j + 1 < sorted.length &&
        (chapterNumber(sorted[j + 1]!.path) ?? -1) === (chapterNumber(sorted[j]!.path) ?? -1) + 1) j++
      const run = sorted.slice(i, j + 1)
      if (run.length > 1) {
        const head = run[0]!
        out.push({
          ...head,
          title: `${head.title} — ${run.length} consecutive parts (stitched)`,
          topics: [...new Set(run.flatMap((r) => r.topics))],
          paths: run.map((r) => r.path),
        })
      } else if (run.length === 1) out.push(run[0]!)
      i = j + 1
    }
    void dir
  }
  // stable, deterministic: original entry order by path
  out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return out
}

export type CurationFact =
  | { type: 'topic-alias'; from: string; to: string; at: string }
  | { type: 'topic-pin'; topic: string; at: string }
  | { type: 'topic-weight'; topic: string; weight: number; at: string }
  | { type: 'group'; topics: string[]; at: string }
  | { type: 'note'; topic: string; text: string; at: string }
  /** P3 §15 amendment: per-machine rule status; index layers ignore it (only rules.ts + the scorer consume it) */
  | { type: 'rule-status'; rule: string; status: string; at: string }
  /** #50 §7.4: a rule pin — per-machine, last-write-wins, never a file rewrite */
  | { type: 'rule-pin'; rule: string; pinned: boolean; at: string }

export interface IndexManifest {
  [inputPath: string]: { hash: string; at: string }
}

export interface IndexBuild {
  /** topic → shard file content */
  shards: Map<string, string>
  manifest: IndexManifest
  /** True when any shard content changed (commit only when true). */
  changed: boolean
  topics: string[]
}

const hashOf = (text: string): string => {
  // FNV-1a 32-bit — deterministic, no crypto import needed in the pure core;
  // collision-resistance is not a security property here, only change-detection.
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export const hashEntry = (e: IndexEntry): string =>
  hashOf(`${e.path}|${e.title}|${[...e.topics].sort().join(',')}|${e.kind}|${e.mtime ?? 0}`)

/** Minimal frontmatter reader for the `key: value` lines render.ts writes. */
export function parseFrontmatter(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (m === null) return out
  const body = m[1] ?? ''
  for (const line of body.split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1]!
    let value = kv[2]!.trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value.slice(1, -1).split(',').map((v) => v.trim().replace(/^"|"$/g, '')).filter((v) => v.length > 0)
    } else {
      out[key] = value.replace(/^"|"$/g, '')
    }
  }
  return out
}

/** A chapter file's text → IndexEntry (topics from frontmatter, kind from `kind:`). */
export function entryFromChapter(path: string, text: string, mtime?: number): IndexEntry {
  const fm = parseFrontmatter(text)
  const topics = fm.topics
  const codegraphSymbols = fm.codegraphSymbols
  return {
    path,
    title: typeof fm.title === 'string' ? fm.title : path,
    topics: Array.isArray(topics) ? topics : [],
    // Three document kinds share the one store: transcript chapters, curated rules,
    // and plan DIRECTIVES (`kind: plan`, docs/plans-carriage.md § 11). A plan document
    // is searchable AS A PLAN, which is the whole point of giving it a kind.
    kind: fm.kind === 'rule' ? 'rule' : fm.kind === 'plan' ? 'plan' : 'chapter',
    ...(typeof fm.category === 'string' && fm.category !== '' ? { category: fm.category } : {}),
    ...(mtime !== undefined ? { mtime } : {}),
    ...(Array.isArray(codegraphSymbols) && codegraphSymbols.length > 0 ? { codegraphSymbols } : {}),
  }
}

/** Layer-1 parse: one JSON fact per line; malformed lines are skipped (logged by the caller). */
export function parseCuration(text: string): CurationFact[] {
  const facts: CurationFact[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const fact = JSON.parse(trimmed) as CurationFact
      if (typeof fact?.type === 'string') facts.push(fact)
    } catch {
      /* malformed line: skipped, not fatal (append-only appenders may race) */
    }
  }
  return facts
}

/**
 * Build the sharded index. Aliases canonicalize topics (from→to, transitive),
 * pinned topics sort first inside their position, weights scale the sort
 * within a topic, and the manifest tracks per-entry hashes for the
 * incremental fast path (an empty manifest = full rebuild = identical output).
 */
export function buildIndexShards(
  entries: readonly IndexEntry[],
  curation: readonly CurationFact[],
  manifest: IndexManifest = {},
): IndexBuild {
  const alias = new Map<string, string>()
  for (const f of curation) {
    if (f.type === 'topic-alias') alias.set(f.from, f.to)
  }
  const canonical = (topic: string): string => {
    let t = topic
    let guard = 0
    while (alias.has(t) && guard < 16) { t = alias.get(t)!; guard += 1 }
    return t
  }
  const pins = new Set(curation.filter((f) => f.type === 'topic-pin').map((f) => f.topic))
  const weights = new Map<string, number>()
  for (const f of curation) {
    if (f.type === 'topic-weight') weights.set(canonical(f.topic), f.weight)
  }

  const byTopic = new Map<string, IndexEntry[]>()
  const manifestNext: IndexManifest = { ...manifest }
  let changed = false
  for (const e of entries) {
    const hash = hashEntry(e)
    const prev = manifest[e.path]
    if (prev !== undefined && prev.hash === hash) {
      // unchanged entry: keep its shard content contribution by still
      // including it (shards are rebuilt from entries, not diffs — the
      // manifest gates the COMMIT, shard content is always whole)
    } else {
      changed = true
    }
    manifestNext[e.path] = { hash, at: new Date().toISOString() }
    for (const rawTopic of e.topics) {
      const topic = canonical(rawTopic)
      if (topic === '') continue
      const list = byTopic.get(topic) ?? []
      list.push(e)
      byTopic.set(topic, list)
    }
  }
  // entries gone from the input drop out of the shards but stay in the
  // manifest? No — the index is a pure function of current entries: prune.
  for (const path of Object.keys(manifestNext)) {
    if (!entries.some((e) => e.path === path)) delete manifestNext[path]
  }

  const shards = new Map<string, string>()
  const topicNames = [...byTopic.keys()].sort()
  for (const topic of topicNames) {
    const entriesForTopic = byTopic.get(topic)!
    const weight = weights.get(topic) ?? 1
    entriesForTopic.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    const lines = entriesForTopic.map((e) =>
      `${e.mtime !== undefined ? new Date(e.mtime).toISOString().slice(0, 10) : '----'} | ${e.kind} | ${e.title} | ${e.path}`)
    const header = [
      `# topic: ${topic}`,
      pins.has(topic) ? '(pinned)' : '',
      `entries: ${entriesForTopic.length} · weight ${weight}`,
      '',
    ].filter((l) => l !== '').join('\n')
    shards.set(topic, `${header}\n${lines.join('\n')}\n`)
  }
  void canonical
  return { shards, manifest: manifestNext, changed, topics: topicNames }
}
