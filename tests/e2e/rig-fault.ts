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

/**
 * In replay, a miss IS a rig fault: the tape is supposed to answer every request the journey makes, so a miss
 * means the leg stopped being the recorded conversation. Measured 2026-10-26: `heavy` passed the chain with two
 * `MISS tape=heavy` lines in the journal — a green that had not earned itself.
 *
 * Deliberately separate from `RIG_FAULT_PATTERN` rather than folded into it: in record and heal a miss IS the
 * mechanism (forward live, append to the tape). Only the caller who knows the mode can say which faults count.
 */
export const REPLAY_MISS_PATTERN = /\bMISS tape=/

/** The first fault line in journal text under `pattern`, or null. Whitespace-only content is not a fault. */
export function findRigFault(text: string, pattern: RegExp = RIG_FAULT_PATTERN): string | null {
  for (const line of text.split('\n')) {
    if (pattern.test(line)) return line.trim().slice(0, 400)
  }
  return null
}

export interface FaultGuardDeps {
  /** the miss journal the proxy writes (`ROOT/var/e2e-tape-misses.log`). */
  journal: string
  /**
   * The boot's stop, or `null` while the boot has not returned yet. Awaited BEFORE `exit`, because an abort
   * that leaves the server on the leg's port makes the NEXT leg fail with "port already in use" — a rig
   * fault must never manufacture a flake. Measured 2026-10-24: a guard installed before the boot, holding a
   * late-bound `stopBoot`, fired against a journal line that predated the boot and exited with the child
   * already spawned and nothing wired to stop it. So the guard ASKS for the stop until one exists
   * (`waitMs`), then uses it — and gives up rather than hanging.
   */
  getStopBoot: () => (() => void | Promise<void>) | null
  exit: (code: number) => void
  /**
   * Which lines count. Defaults to the persona/capability faults; replay legs pass an additive pattern that
   * also treats `MISS tape=` as fatal, because in that mode a miss means the journey left the recording.
   */
  pattern?: RegExp
  /** how long to wait for a boot to exist before giving up and leaving anyway */
  waitMs?: number
  log?: (message: string) => void
  intervalMs?: number
}

/**
 * Watch → report → **stop the boot** → exit. `exit` and `stopBoot` are injected so the ordering is a tested
 * property rather than something `process.exit` hides: a fault must reap the server before it leaves.
 */
/** Journal size in bytes, or 0 when it does not exist yet — the guard is installed before the proxy opens it. */
function fileSize(file: string): number {
  try { return fs.statSync(file).size } catch { return 0 }
}

export function installRigFaultGuard(deps: FaultGuardDeps): () => void {
  let done = false
  const pattern = deps.pattern ?? RIG_FAULT_PATTERN
  // Baseline the journal at install: it is append-only ACROSS legs, so without an offset the first replay leg
  // would abort on some earlier leg's routine miss — a rig fault that manufactures itself. Rotated or
  // truncated (size shrank) re-baselines rather than silently going blind, and the guard still reads nothing
  // it never saw the chance to react to.
  let baseline = fileSize(deps.journal)
  const check = (): void => {
    if (done) return
    const size = fileSize(deps.journal)
    if (size < baseline) baseline = 0
    let text: string
    try { text = fs.readFileSync(deps.journal, 'utf8').slice(baseline) } catch { return }
    if (text.trim() === '') return
    baseline = size
    const fault = findRigFault(text, pattern)
    if (fault === null) return
    done = true
    void (async () => {
      const stop = await waitForStop(deps.getStopBoot, deps.waitMs ?? 5000)
      if (stop !== null) { try { await stop() } catch { /* a failed stop must not mask the fault; the exit below still happens */ } }
      deps.log?.(`[e2e] RIG FAULT — aborting this leg instead of waiting out browser timeouts:\n  ${fault}`)
      deps.exit(1)
    })()
  }
  let watcher: fs.FSWatcher | undefined
  try { watcher = fs.watch(deps.journal, { persistent: false }, check) } catch { /* created later; the poll covers it */ }
  const timer = setInterval(check, deps.intervalMs ?? 1000)
  timer.unref()
  return () => { done = true; clearInterval(timer); watcher?.close() }
}

/** Poll for a stop until one exists or the window closes; never throws, never hangs past `waitMs`. */
async function waitForStop(get: () => (() => void | Promise<void>) | null, waitMs: number): Promise<(() => void | Promise<void>) | null> {
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    let stop: (() => void | Promise<void>) | null = null
    try { stop = get() } catch { stop = null }
    if (stop !== null) return stop
    if (Date.now() >= deadline) return null
    await new Promise<void>((r) => setTimeout(r, 50))
  }
}
