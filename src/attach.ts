/**
 * Attaching a created child to the workspace — the loud version (#54).
 *
 * One step, five ways it can fail, and only one of them silent. AGENTS records that
 * `workspaceRegistry.createCanonical(cwd)` → `attachSession(id)` is precisely what makes a
 * programmatic session APPEAR in the UI ("an unattached session was the whole explanation
 * for round 6's 'not listed'"), yet the door called it through two optional chains inside a
 * `catch` that only warned the profile logger. On host 0.2.0-rc.2 the result is a child that
 * is created, durable, present in `session_projcache` — and absent from the sidebar after a
 * reload, while the door reports success. Silence in a required step is the bug; this module
 * is the fix.
 *
 * The rule it encodes: **verify the user-visible fact, not the absence of a throw.** A
 * successful `attachSession()` proves the method exists, not that the session is listed —
 * so the check is "does this child appear in `sessionQuery.listSessions()`", polled briefly
 * because the workspace catches up asynchronously.
 */

export interface AttachPorts {
  /** the host's `workspaceRegistry` service, as far as it was resolved */
  workspaceRegistry: unknown
  /** the host's `sessionQuery` service; absent ⇒ listing cannot be verified, said out loud */
  sessionQuery: unknown
  /** the host's `sessionController` service; its `list()` is the surface the BROWSER reads.
   *  Absent ⇒ the gateway half of the verification is UNVERIFIED, said out loud. */
  sessionController?: unknown
  /** the diagnostics seam (`src/diag.ts`): sink + logger, never throws */
  diagnostic(where: string, message: string, error?: unknown): void
  childId: string
  cwd: string
  /** test seams; production uses the defaults */
  pollIntervalMs?: number
  pollBudgetMs?: number
}

export interface AttachOutcome {
  /** the workspace actually took the session */
  attached: boolean
  /** it appears in the session list. `undefined` = UNVERIFIABLE, which is NOT `true`. */
  listed: boolean | undefined
  /** it appears in the GATEWAY list the browser renders and opens from. `undefined` = unverified.
   *  Written as `| undefined` deliberately: this repo compiles with
   *  `exactOptionalPropertyTypes`, where `?: boolean` forbids assigning undefined. */
  gatewayListed?: boolean | undefined
  /** user-visible words for anything short of attached+listed — these reach the door result */
  warnings: string[]
}

const shape = (v: unknown): string => {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v !== 'object') return typeof v
  const keys = Object.keys(v as Record<string, unknown>).slice(0, 6)
  return `${Array.isArray(v) ? 'array' : 'object'}{${keys.join(',')}}`
}

export async function attachCreatedChild(ports: AttachPorts): Promise<AttachOutcome> {
  const warnings: string[] = []
  const registry = ports.workspaceRegistry as
    { createCanonical?: (cwd: string) => unknown } | undefined

  if (typeof registry?.createCanonical !== 'function') {
    const reason = `child ${ports.childId} could NOT be attached to the workspace: no "workspaceRegistry" service (or it exposes no createCanonical) — it may never appear in the sidebar`
    ports.diagnostic('attach:workspaceRegistry', reason, `resolved=${shape(ports.workspaceRegistry)}`)
    return { attached: false, listed: undefined, warnings: [reason] }
  }

  let workspace: { attachSession?: (id: string) => unknown } | undefined
  try {
    workspace = await (registry.createCanonical as (cwd: string) => Promise<unknown>)(ports.cwd) as typeof workspace
  } catch (error) {
    const reason = `child ${ports.childId} could NOT be attached: createCanonical("${ports.cwd}") failed: ${String((error as Error)?.message ?? error)}`
    ports.diagnostic('attach:createCanonical', reason, error)
    return { attached: false, listed: undefined, warnings: [reason] }
  }

  if (typeof workspace?.attachSession !== 'function') {
    // THE 0.2.x hypothesis: the host reshaped this return. Before this module the optional
    // chain made it a no-op with no word said; now it is a named, diagnosable mismatch.
    const reason = `child ${ports.childId} could NOT be attached: createCanonical returned no "attachSession" method (got ${shape(workspace)}) — the host workspace API changed shape; the child is durable but may not appear in the sidebar`
    ports.diagnostic('attach:attachSession', reason, `workspace=${shape(workspace)}`)
    return { attached: false, listed: undefined, warnings: [reason] }
  }

  try {
    await workspace.attachSession(ports.childId)
  } catch (error) {
    const reason = `child ${ports.childId} attach was refused: ${String((error as Error)?.message ?? error)}`
    ports.diagnostic('attach:attachSession', reason, error)
    return { attached: false, listed: undefined, warnings: [reason] }
  }

  // Attached. Now the part the throw can't tell us: is it actually LISTED?
  const sq = ports.sessionQuery as { listSessions?: (signal?: unknown) => Promise<Array<{ header?: { id?: string } }>> } | undefined
  if (typeof sq?.listSessions !== 'function') {
    return {
      attached: true,
      listed: undefined,
      warnings: [`child ${ports.childId} attached, but its listing is UNVERIFIED — no sessionQuery service to ask`],
    }
  }
  const intervalMs = ports.pollIntervalMs ?? 150
  const budgetMs = ports.pollBudgetMs ?? 1500
  const deadline = Date.now() + budgetMs
  for (;;) {
    let ids: string[] = []
    try {
      ids = (await sq.listSessions() ?? []).map((r) => r?.header?.id ?? '')
    } catch (error) {
      // a failed LOOKUP is not a failed session — say which one happened
      const reason = `child ${ports.childId} attached, but its listing could not be verified: sessionQuery.listSessions failed: ${String((error as Error)?.message ?? error)}`
      ports.diagnostic('attach:verify', reason, error)
      return { attached: true, listed: undefined, warnings: [reason] }
    }
    if (ids.includes(ports.childId)) {
      // Listed by PERSISTENCE is not the same claim as listed to the BROWSER. The gateway's
      // `sessionController.list()` is the surface the client renders and can `open()` against,
      // and on 0.2.0-rc.2 a plugin-created child was present in one and absent from the other
      // (measured: the door's roster note said `MISSING, 1 sessions` while `listSessions`
      // listed it) — so a single boolean would have called that a success.
      const sc = ports.sessionController as { list?: () => Promise<Array<{ sessionId?: string, header?: { id?: string } }>> } | undefined
      if (typeof sc?.list !== 'function') {
        // Silence here is what cost a round of the 0.2.x hunt: "no warning" got read as "the
        // gateway lists it". An unverified surface is a STATE and must be delivered as one.
        const reason = `child ${ports.childId} is listed in the durable session corpus, but its presence in the gateway (browser) session list could not be verified — no "sessionController" service to ask`
        ports.diagnostic('attach:gatewayList', reason, `resolved=${shape(ports.sessionController)}`)
        return { attached: true, listed: true, gatewayListed: undefined, warnings: [reason] }
      }
      let gids: string[] = []
      try {
        gids = (await sc.list() ?? []).map((r) => r?.sessionId ?? r?.header?.id ?? '')
      } catch (error) {
        const reason = `child ${ports.childId} is listed, but the gateway session list could not be verified: ${String((error as Error)?.message ?? error)}`
        ports.diagnostic('attach:gatewayList', reason, error)
        return { attached: true, listed: true, gatewayListed: undefined, warnings: [reason] }
      }
      if (gids.includes(ports.childId)) return { attached: true, listed: true, gatewayListed: true, warnings: [] }
      const reason = `child ${ports.childId} is in the durable session list but NOT in the gateway's session list (sessionController.list returned ${String(gids.length)} sessions) — the browser cannot show or open it, so the door will not be able to switch`
      ports.diagnostic('attach:gatewayList', reason, `gateway=${gids.slice(0, 4).join(',')}`)
      return { attached: true, listed: true, gatewayListed: false, warnings: [reason] }
    }
    if (Date.now() + intervalMs > deadline) {
      const reason = `child ${ports.childId} was attached but does not appear in the session list within ${String(budgetMs)}ms (${String(ids.length)} sessions listed) — the archive is durable; the sidebar may not show it`
      ports.diagnostic('attach:verify', reason, `listed=${ids.slice(0, 4).join(',')}`)
      return { attached: true, listed: false, warnings: [reason] }
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
