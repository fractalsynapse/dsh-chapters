/**
 * The rig capability pin (#108).
 *
 * The composed agent header IS part of what a tape measures: which capabilities the host mounted decides how
 * a session behaves, so a corpus recorded under a six-section header cannot replay on a rig that composes
 * three. That is exactly how PR #107 went red on CI while green on the laptop that recorded it, and the run
 * said so only as `divergeAt=msg0` plus a 25-minute browser hang.
 *
 * This module turns that into a named check at the first agent-persona request of every boot, in both record
 * and replay. It reports the divergence; making the two machines RESOLVE the same bundle tree is still open
 * on #108.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rig-capabilities.json')

/** name → marker text, from the tracked fixture. Read once at import; a missing file is a rig fault. */
export const REQUIRED_CAPABILITIES: Record<string, string> = (() => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { required?: Record<string, string> }
  if (raw.required === undefined || Object.keys(raw.required).length === 0) {
    throw new Error(`rig-capabilities: ${path.relative(process.cwd(), FIXTURE)} declares no required sections`)
  }
  return raw.required
})()

/** The stored/live head as text: a tape prefix head is already a masked STRING, a live request is an object. */
export function incomingHead(incoming: unknown[]): string | null {
  const first: unknown = Array.isArray(incoming) ? incoming[0] : undefined
  if (typeof first === 'string') return first
  if (typeof first === 'object' && first !== null) {
    try { return JSON.stringify(first) } catch { return null }
  }
  return null
}

export interface CapabilityReport { present: string[]; missing: string[] }

export function headerCapabilities(head: string): CapabilityReport {
  const present: string[] = [], missing: string[] = []
  for (const [name, marker] of Object.entries(REQUIRED_CAPABILITIES)) {
    (head.includes(marker) ? present : missing).push(name)
  }
  return { present, missing }
}

/** null when this is not the harness agent's own header (auxiliary turns are not capability-bearing). */
export function capabilitiesOf(incoming: unknown[]): CapabilityReport | null {
  const head = incomingHead(incoming)
  if (head === null || !head.startsWith('{"role":"system"')) return null
  if (!head.includes('You are an AI agent powered by DeepSeek Harness')) return null
  return headerCapabilities(head)
}
