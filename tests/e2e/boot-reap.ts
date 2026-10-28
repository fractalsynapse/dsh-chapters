/**
 * Reaping the rig's OWN orphaned boots, as a pure decision + a thin executor.
 *
 * Why: every leg pins a port (`rig-pins.ts`), and a boot orphaned by a crashed or Ctrl-C'd run holds that
 * port forever. Today the boot fails fast and tells the operator to `pkill -f "dsh web --port 41731"` —
 * which is advice that bites back: a maintainer's shell, and an agent's tool call, both contain that pattern
 * in their own command line, so `pkill -f` reliably matches the thing that is doing the killing. Measured
 * today: my own `pkill` killed my own check. Worse, the live harness in this same process tree is
 * `node …/dsh web --no-open` — a loose pattern would take the session down with it.
 *
 * So the candidate set is computed from parsed `ps` rows against explicit rules, never from a regex the
 * caller guesses at, and the executor refuses anything that is not unmistakably this repo's orphan for
 * THIS port.
 */

export interface PsRow { pid: number, ppid: number, args: string }

/** Parse `ps -eo pid=,ppid=,args=` output. Unparseable lines are skipped, never guessed. */
export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (m === null) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! })
  }
  return rows
}

/** The pid chain from `self` upward, inclusive — what must never be signalled. */
export function ancestorChain(rows: readonly PsRow[], self: number): Set<number> {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const chain = new Set<number>([self])
  let cur = byPid.get(self)
  // Stop at pid 0: it is the kernel's swapper, not a process, and `systemd` (pid 1) is already the useful
  // boundary. Walking past it would put 0 in a "pids to signal" set, which is exactly the kind of
  // almost-right list that only shows up when something is already dead.
  while (cur !== undefined && cur.ppid > 0 && !chain.has(cur.ppid)) {
    chain.add(cur.ppid)
    cur = byPid.get(cur.ppid)
  }
  return chain
}

/**
 * Which pids are THIS repo's orphaned boot on THIS port.
 *
 * All four conditions, because each one closes a real failure:
 *  - runs the e2e host for exactly this port (`--port <port>`, not a prefix of another number),
 *  - its command line references `root` (the repo's own host lock path), so another project's rig is untouchable,
 *  - it is not self, not an ancestor of self, and not the session's own harness,
 *  - and it is a `dsh web` process, so a grep/editor holding the port is left alone for the operator.
 */
export function orphanBootPids(rows: readonly PsRow[], root: string, port: number, self: number, protectedPids: ReadonlySet<number>): number[] {
  const portFlag = new RegExp(`--port\\s+${String(port)}\\b`)
  return rows
    .filter((r) => r.pid !== self && !protectedPids.has(r.pid))
    .filter((r) => /(^|[\s/])dsh(\s+web|\s*$)/.test(r.args) || /\/dsh(\s|$)|dsh\/|\.bin\/dsh/.test(r.args))
    .filter((r) => /\bweb\b/.test(r.args))
    .filter((r) => portFlag.test(r.args))
    .filter((r) => r.args.includes(root))
    .map((r) => r.pid)
}


/**
 * The executor. TERM first, give it a moment, KILL anything still holding the port, and report exactly which
 * pids were signalled — a reaper that acts silently is how a rig starts looking like it is stealing servers.
 * Returns the pids it reaped (possibly empty, in which case the caller throws its old, more precise error).
 */
export async function reapOrphanBoots(port: number, root: string, log: (line: string) => void): Promise<number[]> {
  const { execFileSync } = await import('node:child_process')
  const rows = parsePs(execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }))
  const targets = orphanBootPids(rows, root, port, process.pid, ancestorChain(rows, process.pid))
  if (targets.length === 0) return []
  const net = await import('node:net')
  const holding = (): Promise<boolean> => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => { s.destroy(); resolve(false) })
  })
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); log(`[e2e] reaped orphan boot pid=${String(pid)} (SIGTERM) for port ${String(port)}`) } catch { /* already gone */ }
  }
  for (let i = 0; i < 10 && (await holding()); i++) await sleep(300)
  for (const pid of targets) {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); log(`[e2e] orphan boot pid=${String(pid)} ignored TERM; SIGKILL`); } catch { /* exited */ }
  }
  for (let i = 0; i < 10 && (await holding()); i++) await sleep(300)
  return targets
}
