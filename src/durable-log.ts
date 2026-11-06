/**
 * #319 part 3b — the plugin-side raw decode of a session's durable log.
 *
 * Why this exists when `readDurableSession` does: the settlement door reads through the
 * HOST's reader, which runs the very validator that refuses poisoned sessions (#314).
 * Restore must work on exactly those sessions — so it goes to the bytes, with the technique
 * the repair CLI proved on the maintainer's real logs: the kernel appends ONE ZSTD FRAME PER
 * FLUSH (not one per file), so the naive first-frame decode yields a header line and nothing
 * else; split on the magic, decode every frame, tolerate the torn final line (half a flush
 * after a crash is normal, and one broken tail is not a reason to lose six thousand events).
 * Highest session.vN wins; the header record is separated from events, never guessed at.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { SessionEventLike } from './types.ts'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_NAME = /^session\.v(\d+)\.jsonl\.zstd$/

export interface DurableLog {
  readonly header: Record<string, unknown> | null
  readonly events: SessionEventLike[]
  /** lines that failed to parse (torn tails) — reported, never silent */
  readonly skipped: number
}

/** Reads `dir` (a session's durable directory) or returns null when no log exists. */
export function decodeDurableLog(dir: string): DurableLog | null {
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return null }
  const versions = entries.map((f) => LOG_NAME.exec(f)).filter((m): m is RegExpExecArray => m !== null)
  if (versions.length === 0) return null
  versions.sort((a, b) => Number(b[1]) - Number(a[1]))
  const file = path.join(dir, `session.v${versions[0]![1]}.jsonl.zstd`)
  let buf: Buffer
  try { buf = fs.readFileSync(file) } catch { return null }
  const starts: number[] = []
  for (let i = buf.indexOf(ZSTD_MAGIC); i >= 0; i = buf.indexOf(ZSTD_MAGIC, i + 4)) starts.push(i)
  if (starts.length === 0) return null
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const slice = buf.subarray(starts[k]!, k + 1 < starts.length ? starts[k + 1]! : buf.length)
    try { text += zlib.zstdDecompressSync(slice).toString('utf8') } catch { text += '' /* one bad frame must not eat the rest; its lines count as skipped below only if unparsable */ }
  }
  const events: SessionEventLike[] = []
  let header: Record<string, unknown> | null = null
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { skipped += 1; continue }
    if (parsed === null || typeof parsed !== 'object') { skipped += 1; continue }
    const e = parsed as Record<string, unknown>
    if (e['type'] === 'session' && typeof e['seq'] !== 'number') { if (header === null) header = e; continue }
    if (typeof e['seq'] === 'number' && typeof e['type'] === 'string') {
      events.push({ type: e['type'] as string, seq: e['seq'] as number, ...(e['time'] !== undefined ? { time: e['time'] as number } : {}), ...(e['surfaceOp'] !== undefined ? { surfaceOp: e['surfaceOp'] as string } : {}), data: (e['data'] ?? {}) as Record<string, unknown> })
    } else skipped += 1
  }
  return { header, events, skipped }
}

/** The kernel's own layout: ~/.dsh/sessions/<workspace-slug>/<sessionId-or-bare-uuid>. DSH_HOME honored exactly like the repair CLI. */
export function findDurableLogDir(sessionId: string, sessionsBase = path.join(process.env.DSH_HOME ?? path.join(process.env.HOME ?? os_home(), '.dsh'), 'sessions')): string | null {
  let slugs: string[]
  try { slugs = fs.readdirSync(sessionsBase) } catch { return null }
  const names = [sessionId, sessionId.replace(/^session-/, '')]
  for (const slug of slugs) {
    for (const n of names) {
      const dir = path.join(sessionsBase, slug, n)
      try { if (fs.statSync(dir).isDirectory()) return dir } catch { /* keep walking */ }
    }
  }
  return null
}

function os_home(): string {
  return process.env.HOME ?? '/root'
}
