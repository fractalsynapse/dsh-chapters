/**
 * A rig fault must end the RUN, not just the request (#108).
 *
 * The capability and persona pins answer 503 instantly, and that was described as "fails fast" — true of the
 * proxy, false of the run: after the refusal the browser keeps waiting for UI that no answer will ever
 * render, so `a-knowledge-loop` still spends its full timeout on a fork-door click, once per spec, in a leg
 * that has four. Measured on CI run 40151570099: 22+ minutes with the pins already firing.
 *
 * So the miss journal is watched. One matching line and the Playwright process stops: the diagnosis is
 * printed, the remaining specs do not run, and nobody reads a browser timeout as a product bug again.
 */
import fs from 'node:fs'

export const RIG_FAULT_PATTERN = /RIG-CAPABILITIES|PERSONA-MISMATCH|PERSONA-RECORD-REFUSED/

/** The first rig-fault line in journal text, or null. Whitespace-only content is not a fault. */
export function findRigFault(text: string): string | null {
  for (const line of text.split('\n')) {
    if (RIG_FAULT_PATTERN.test(line)) return line.trim().slice(0, 400)
  }
  return null
}

/**
 * Watch `journalPath` and report the first fault. A missing file is NOT a fault (CI removes the journal before
 * each chain); a file created mid-watch is read, so a proxy that writes the journal lazily is still caught.
 * Returns a disposer; the caller decides whether the watch keeps the process alive.
 */
export function watchRigFault(journalPath: string, onFault: (line: string) => void): () => void {
  let done = false
  const check = (): void => {
    if (done) return
    let text: string
    try { text = fs.readFileSync(journalPath, 'utf8') } catch { return }
    const fault = findRigFault(text)
    if (fault !== null) { done = true; onFault(fault) }
  }
  let watcher: fs.FSWatcher | undefined
  try { watcher = fs.watch(journalPath, { persistent: false }, check) } catch { /* created later; the interval covers it */ }
  const timer = setInterval(check, 1000)
  timer.unref()
  return () => { done = true; clearInterval(timer); watcher?.close() }
}
