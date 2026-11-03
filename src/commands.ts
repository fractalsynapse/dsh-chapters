/**
 * Host-side slash commands for the knowledge layer (knowledge-repo.md §5, §2).
 * Both render as command flow nodes — verified to stay OUT of the model's
 * context (record §7.2: in-session UX, zero context cost).
 *
 *   /chapters-link                              show upstream + mirror status
 *   /chapters-link <local-path>                 bind a path upstream (no creds)
 *   /chapters-link <https-url> <token>          bind a network git upstream
 *   /chapters-link treedx+<url>/<repo> <token>  bind a TreeDX service upstream
 *   /chapters-status                            last sync result
 *   /chapters-models [<provider> [<model>]]     discover the ids the three model setters accept (#173)
 *   /chapters-enrich run | model … | report     P2 enrichment surface (record §6.2)
 *   /chapters-prompt model … | off | suggest    prompt recommendations (#71, site §28)
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_CLONE_DIR, planStoreToRepo, projectForCwd, readSyncStatus, readToken, runSync, writeToken,
  type ProjectRecord, type SyncScheduler,
} from './sync.ts'
import { classifyOffer } from './prompt-state.ts'
import { isLocalUpstreamUrl, readOrigin, resolveLocalUpstreamPath } from './gitops.ts'
import { parseKnowledgeRemote, projectKeyForTarget, projectKeyFromRemote, resolveProject } from './repo.ts'
import { createTreeDxClient } from './treedx/client.ts'
import { resolveRepoId } from './treedx/provider.ts'
import { readState } from './treedx/state.ts'
import { selectProvider } from './provider.ts'
import type { DomainLike } from './store.ts'
import type { ToolsCtx } from './tools.ts'
import type { PromptCommandSurface } from './prompt.ts'
import { modelsCommand, type ModelsIo } from './models-command.ts'
import type { SessionEventLike } from './types.ts'
import { resolveStoreRoot } from './store.ts'
import { diagnosticStatusLine } from './diag.ts'
import { registryHealth } from './repair.ts'
import { removedGuard } from './removal.ts'
import { applyRemoval, planRemoval, readMissingAccess, resolveRemovalId, type RemovalTarget } from './removal.ts'
import { ancestorPath, buildIndex, isRemovedChapter } from './registry.ts'
import { resolveStoredPath, verifyChapter } from './archive.ts'
import { searchKnowledge, searchLocalStore } from './search.ts'
import { makeArchiveFs, type RegistryStore } from './store.ts'
import type { SessionState } from './registry.ts'

/** Structural slice of EnrichWiring the commands need (keeps queue types out). */
export interface EnrichCommandSurface {
  runNow(cwd?: string): Promise<{ processed: number; remaining: number }>
  setModelOverride(v: string | null): Promise<void>
  modelOverride(): string | null
  statusLine(): string
  pendingCount(): Promise<number>
}

export interface HostCommandsConfig {
  artifactStoreRoot: string
  harnessId: string
  /** The sync scheduler to arm after a link (record §5). */
  scheduler?: SyncScheduler
  /** P2 enrichment command surface (host plane; manual-drain semantics). */
  enrich?: EnrichCommandSurface
  /** #173: model-catalog discovery, re-read per invocation (settings mutate under it). */
  models?: () => ModelsIo
  /** P3 rule lifecycle family, bound to a workspace (S2 module underneath). */
  rules?: (cwd: string, args: string, sessionId?: string) => Promise<{ kind: 'success' | 'error'; text: string }>
  /** Door 5 (issue #47): whether subagent settlements auto-archive. Reported in
   *  /chapters-status because it runs WITHOUT a human seeing it happen. */
  subagentAutoSave?: boolean
  /** #71: prompt recommendations surface (host plane; pull transport — the
   *  client composer ghost executes `suggest`). Reported by /chapters-status. */
  prompt?: PromptCommandSurface
  /** §7.8: fed to `resolveProject` so the identity line reports the SAME key the
   * plugin binds by, not a naive re-derivation. */
  projectKeyOverride?: string
  /** #255: the plane's registry store handle — `/chapters-remove` mutates through it
   * (one serialized section per row, #59). Absent ⇒ the command refuses cleanly. */
  store?: RegistryStore
  /** #255: cap for removal report/print arms. Reuses the repair report row — one
   * knob for "how many lines may a command print", not two (#117 family). */
  reportMaxLines?: number
}

type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/** Door 5 state, stated with its config name so a user can flip it (issue #47). */
const AUTO_SAVE_LINE = (config: HostCommandsConfig): string =>
  `\nSubagent auto-save: ${config.subagentAutoSave === false ? 'OFF (subagentAutoSave: false)' : 'ON — chapters-preset children archive their completed turns at settlement'}`
type CommandsService = { register?: (def: unknown) => (() => void) | unknown } | undefined

const cwdOf = (agent: unknown): string =>
  ((agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd ?? process.cwd())


/** branch name (or short oid) the mirror's HEAD points at. */
function readMirrorHead(mirrorAbs: string): string | null {
  try {
    const head = fs.readFileSync(path.join(mirrorAbs, '.git', 'HEAD'), 'utf8').trim()
    const m = /^ref: refs\/heads\/(.+)$/.exec(head)
    return m?.[1] ?? head.slice(0, 8)
  } catch { return null }
}

/** store files not yet present in the mirror (the honest pending-push view). */
function countPending(mirrorAbs: string, storeDir: string, projectKey: string): number {
  try {
    return planStoreToRepo(storeDir, projectKey).filter((f) => !fs.existsSync(path.join(mirrorAbs, f.rel))).length
  } catch { return -1 }
}

export function registerHostCommands(
  ctx: ToolsCtx,
  domain: DomainLike,
  config: HostCommandsConfig,
): () => void {
  const commands = ctx.get?.('commands') as CommandsService
  const disposers: (() => void)[] = []
  if (commands?.register === undefined) return () => {}

  /**
   * /chapters-link — the upstream configuration surface, three modes:
   *   (no args)      show the current upstream + mirror state (git-status-like)
   *   <local-path>   bind the pool to a directory upstream (bare repo created
   *                  on demand; no credentials — §2.1's local upstreams)
   *   <url> <token>  bind to an http(s) upstream; the token is REQUIRED unless
   *                  the host is loopback, and is stored in the DSH home, 0600
   */
  const linkCommand = {
    name: 'chapters-link',
    description: 'Show / set this project\u2019s knowledge upstream: /chapters-link [path | <https-url> <token> | treedx+<url>/<repo> <token>]',
    input: { hint: '[path | <https-remote-url> <token> | treedx+<url>/<repo> <token>]' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      const parts = (invocation.rawInput ?? '').trim().split(/\s+/).filter((p) => p.length > 0)
      const cwd = cwdOf(invocation.agent)
      const table = domain.table('projects')
      try {
        // ---- mode 1: no args — the git-status-like view
        if (parts.length === 0) {
          const rec = projectForCwd(table.entries(), cwd)
          if (rec === undefined) {
            return { kind: 'success', text: 'Upstream: none — this workspace is knowledge-local (chapters, forks, signatures all work; nothing syncs).\nSet one: /chapters-link <path> or /chapters-link <https-url> <token>' }
          }
          const mirrorAbs = path.join(cwd, DEFAULT_CLONE_DIR)
          const treedx = (rec.kind ?? 'git') === 'treedx'
          const tstate = treedx ? readState(mirrorAbs) : null
          const head = treedx ? (tstate?.head !== null && tstate?.head !== undefined ? tstate.head.slice(0, 10) : null) : readMirrorHead(mirrorAbs)
          const origin = treedx ? tstate?.origin ?? null : readOrigin(mirrorAbs)
          const status = readSyncStatus(cwd, config.artifactStoreRoot)
          const pending = countPending(mirrorAbs, resolveStoreRoot(cwd, config.artifactStoreRoot), rec.projectKey)
          const hasToken = readToken(cwd, config.artifactStoreRoot, rec.projectKey) !== undefined
          const local = isLocalUpstreamUrl(rec.remote)
          const lines = [
            `Provider: ${rec.kind ?? 'git'}`,
            `Upstream: ${rec.remote}`,
            `Bound:    ${rec.slug} · key ${rec.projectKey} · since ${rec.linkedAt}`,
            // §7.8 IDENTITY MUST FAIL LOUDLY. Project rules carry across checkouts
            // because the key derives from the canonicalized REMOTE — so the four
            // ways it can diverge (no remote ⇒ path-derived, a fork listed first,
            // a TreeDX link keyed on the pool, an unlinked clone) are reported here
            // rather than leaving a checkout silently owning its own namespace.
            (() => {
              const derived = resolveProject(cwd, config.projectKeyOverride !== undefined && config.projectKeyOverride !== '' ? config.projectKeyOverride : undefined)
              const where = derived.projectKeySource === 'remote' ? `remote ${derived.remote ?? ''}`
                : derived.projectKeySource === 'override' ? 'config override'
                  : `PATH ${cwd} (not the remote — unstable across machines)`
              return derived.projectKey === rec.projectKey
                ? `Identity: ${derived.projectKeySource} — matches the bound key (${where})`
                : `Identity: ${derived.projectKeySource}  ⚠ THIS CHECKOUT RESOLVES A DIFFERENT PROJECT KEY (${derived.projectKey.slice(0, 8)}… vs bound ${rec.projectKey.slice(0, 8)}…) — rules and chapters approved elsewhere will NOT appear here. ${where}`
            })(),
            diagnosticStatusLine(),
            `Mirror:   ${fs.existsSync(mirrorAbs) ? DEFAULT_CLONE_DIR : '(not created yet)'}` +
              (treedx ? `  head ${head ?? (tstate === null ? 'not cloned' : 'empty repo')}${tstate?.offline === true ? ' · OFFLINE (push deferred)' : ''}` : `  branch ${head ?? 'main'}`) +
              (origin !== null && origin !== (treedx ? rec.remote : local ? resolveLocalUpstreamPath(rec.remote, cwd) : rec.remote) ? `  [origin drift: ${origin} — will rebuild]` : ''),
            `Sync:     ${status === null ? 'never run' : `${status.mode} @ ${status.at}`}${status !== null && !status.lastOk ? ` — ${status.detail}` : ''}`,
            `Pending:  ${pending} file(s) not yet mirrored${hasToken || local ? '' : '  ⚠ no credentials — /chapters-link ' + (treedx ? 'treedx+<url>/<repo> <token>' : '<url> <token>')}`,
            `Harness:  ${rec.harnessId}`,
          ]
          return { kind: 'success', text: lines.join('\n') }
        }

        // ---- mode 2: local-path upstream
        const target = parts[0]!
        if (!/^https?:\/\//.test(target) && (target.startsWith('/') || target === '~' || target.startsWith('~/') || target.startsWith('./') || target.startsWith('../') || /^file:\/\/\//.test(target))) {
          const resolved = resolveLocalUpstreamPath(target, cwd)
          const record: ProjectRecord = {
            projectKey: projectKeyFromRemote(`file://${resolved}`),
            slug: path.basename(resolved).replace(/\.git$/, ''),
            remote: resolved,
            harnessId: config.harnessId,
            linkedAt: new Date().toISOString(),
            cwd,
          }
          table.put(record.projectKey, record)
          const sync = await syncNow(cwd, record, undefined)
          return { kind: 'success', text: `Linked to local upstream ${resolved} (a bare pool repo is created there if absent; no credentials needed).\nKey: ${record.projectKey}\nSync: ${sync.mode} \u2014 ${sync.steps.join(' \u2192 ') || sync.detail}` }
        }

        // ---- mode 4: TreeDX service upstream (§15 amendment)
        if (target.startsWith('treedx+')) {
          const parsed = parseKnowledgeRemote(target) // throws on a malformed form — caught below
          const token = parts[1]
          if (token === undefined || token === '') {
            return { kind: 'error', text: 'TreeDX always needs a bearer token: /chapters-link treedx+<url>/<repo> <token> (a local dev container: scripts/treedx-local.sh token mints one)' }
          }
          if (parsed.treedx === undefined) return { kind: 'error', text: 'internal: treedx+ target did not parse to a service target' }
          const client = createTreeDxClient({ baseUrl: parsed.treedx.baseUrl, token, fetchTimeoutMs: 15000 })
          // Resolve-or-create the managed repository — linking is an explicit
          // human act (§2.1), so creating the named pool is in scope here and
          // ONLY here. 409 (exists) is a success path. One shared live-shaped
          // catalog parser with the transport (repoCatalog/resolveRepoId) —
          // the first live run broke precisely on parser drift.
          let repoId = await resolveRepoId(client, parsed.treedx.repoName)
          let resolveNote = ''
          if (repoId === '') {
            const created = await client.post('/api/v1/repos', {
              repositoryName: parsed.treedx.repoName, source: { type: 'empty' }, placement: { mode: 'local' },
            })
            if (!created.ok && created.code !== 'conflict' && created.status !== 409) {
              return { kind: 'error', text: `TreeDX repository '${parsed.treedx.repoName}' not found and create failed (${created.detail}) — check the URL/token or create it server-side.` }
            }
            resolveNote = '\nCreated the managed repository (born with refs/heads/main).'
            repoId = await resolveRepoId(client, parsed.treedx.repoName)
          }
          const record: ProjectRecord = {
            projectKey: projectKeyForTarget(parsed),
            slug: parsed.treedx.repoName,
            remote: target,
            kind: 'treedx',
            ...(repoId !== '' ? { repoId } : {}),
            harnessId: config.harnessId,
            linkedAt: new Date().toISOString(),
            cwd,
          }
          writeToken(record.projectKey, token)
          table.put(record.projectKey, record)
          const sync = await syncNow(cwd, record, token)
          return {
            kind: 'success',
            text: `Linked to TreeDX ${parsed.treedx.baseUrl} repo '${parsed.treedx.repoName}'${repoId !== '' ? ` (${repoId})` : ''}.\nKey: ${record.projectKey}\nCredentials stored (DSH home, 0600).${resolveNote}\nSync: ${sync.mode} — ${sync.steps.join(' → ') || sync.detail}` +
              (sync.ok || sync.mode === 'local-only' ? '' : '\nThe service may be down or the token wrong — /chapters-status carries the detail; nothing else is affected.'),
          }
        }

        // ---- mode 3: https upstream — token required unless loopback
        if (!/^https?:\/\//.test(target)) {
          return { kind: 'error', text: 'usage: /chapters-link [<local-path> | <https-url> <token>] \u2014 (no args shows the current upstream)' }
        }
        const token = parts[1]
        const host = (() => { try { return new URL(target).hostname } catch { return '' } })()
        const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
        if (token === undefined && !loopback) {
          return { kind: 'error', text: 'A credential is required for a network upstream: /chapters-link <url> <token> (stored 0600 under the DSH home \u2014 never in the project). Local paths need none: /chapters-link ./vendor/kb.git' }
        }
        const resolved = resolveProject(cwd, undefined, target)
        const record: ProjectRecord = {
          projectKey: resolved.projectKey,
          slug: (resolved.remote ?? target).split('/').pop()!.replace(/\.git$/, ''),
          remote: target,
          harnessId: config.harnessId,
          linkedAt: new Date().toISOString(),
          cwd,
        }
        if (token !== undefined) writeToken(record.projectKey, token)
        table.put(record.projectKey, record)
        const sync = await syncNow(cwd, record, token ?? readToken(cwd, config.artifactStoreRoot, record.projectKey))
        const hint = sync.ok || sync.mode === 'local-only'
          ? ''
          : '\nThe upstream may not exist yet \u2014 create the private repo (GitHub creates one on push for a suitably-scoped token), or point at a local path: /chapters-link ./vendor/kb.git'
        return { kind: 'success', text: `Linked to ${target}.\nKey: ${record.projectKey}${token === undefined ? '\n(no credentials: loopback upstream)' : '\nCredentials stored (DSH home, 0600).'}\nSync: ${sync.mode} \u2014 ${sync.steps.join(' \u2192 ') || sync.detail}${hint}` }
      } catch (error) {
        return { kind: 'error', text: `chapters-link failed: ${String((error as Error)?.message ?? error)}`.slice(0, 300) }
      }
    },
  }

  /** one immediate sync pass for a fresh record (explicit project wins). */
  async function syncNow(cwd: string, record: ProjectRecord, token: string | undefined | null) {
    if (config.scheduler !== undefined) return config.scheduler.run(cwd, 'link', record)
    return runSync({
      cwd, storeRoot: config.artifactStoreRoot, cloneDir: DEFAULT_CLONE_DIR,
      project: record, ...(token !== undefined && token !== null ? { token } : {}),
      // #255: the guard reads removed stubs from the registry rows this command already holds —
      // a deletion must never be rehydrated back into the store on the pass that publishes it.
      removed: removedGuard(domain.table('sessions').entries() as Iterable<[string, SessionState]>),
      force: true,
    })
  }

  const statusCommand = {
    name: 'chapters-status',
    description: 'Show the knowledge-repo mirror status for this project.',
    input: { hint: '[prints project, remote, and last sync result]' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      const cwd = cwdOf(invocation.agent)
      const project = projectForCwd(domain.table('projects').entries(), cwd)
      const status = readSyncStatus(cwd, config.artifactStoreRoot)
      // #61: this command used to RETURN here when nothing was linked — one sentence, and every health
      // line below it (Enrichment, Diagnostics, Auto-save, Findings) was unreachable precisely for the
      // users who most needed it. An unlinked project is a STATE, not an absence of health.
      const lines: string[] = []
      if (project === undefined && status === null) {
        lines.push('No knowledge repository is linked yet. Link one with /chapters-link <https-remote-url> [token] — '
          + 'until then this project\u2019s chapters, rules and index stay on THIS machine only.')
      }
      if (project !== undefined) {
        const pending = config.scheduler?.hasPending(cwd) === true
        lines.push(`Project: ${project.slug} \u00B7 key ${project.projectKey}`)
        lines.push(`Remote: ${project.remote}`)
        try { lines.push(`Provider: ${selectProvider(project).describe(project)}`) }
        catch { lines.push('Provider: (kind unrecognized — sync will refuse loudly, nothing silently reroutes)') }
        // #50 §7.8 IDENTITY MUST FAIL LOUDLY. Project rules carry across checkouts
        // because the key is UUIDv5 over the canonicalized REMOTE — so the ways it
        // can silently diverge (no readable remote ⇒ path-derived, a fork listed
        // before origin, a TreeDX link keyed on the pool location) are reported
        // here instead of leaving a checkout owning a private rules namespace while
        // its developer believes the team's rules apply.
        {
          const derived = resolveProject(cwd, config.projectKeyOverride !== undefined && config.projectKeyOverride !== '' ? config.projectKeyOverride : undefined)
          const where = derived.projectKeySource === 'remote' ? `remote ${derived.remote ?? ''}`
            : derived.projectKeySource === 'override' ? 'config override'
              : `PATH ${cwd} (not the remote — unstable across machines)`
          lines.push(derived.projectKey === project.projectKey
            ? `Identity: ${derived.projectKeySource} — matches the bound key (${where})`
            : `Identity: ${derived.projectKeySource}  ⚠ THIS CHECKOUT RESOLVES A DIFFERENT PROJECT KEY (${derived.projectKey.slice(0, 8)}… vs bound ${project.projectKey.slice(0, 8)}…) — rules and chapters approved elsewhere will NOT appear here. ${where}`)
        }
        lines.push(pending ? 'Sync: a push is pending (debounced)' : `Sync: ${status?.mode ?? 'never run'}${pending ? '' : ''}`)
      }
      if (status !== null) {
        lines.push(`Last sync: ${status.at} \u2014 ${status.lastOk ? 'synced' : `${status.mode ?? 'local-only'}: ${status.detail}`}`)
        lines.push(`  ${(status.steps ?? []).join(' \u2192 ')}`)
      }
      // #61: an unwired surface is STATED, not omitted. A reader who sees no enrichment line cannot tell
      // whether enrichment is off, broken, or simply not printed here — which is how "the feature never
      // ran" hides for three days behind a logger nobody reads.
      lines.push(config.enrich !== undefined ? config.enrich.statusLine() : 'Enrichment: not wired on this plane (no model route registered)')
      lines.push(config.prompt !== undefined ? config.prompt.statusLine() : 'Prompt suggestions: not wired on this plane')
      // #225: the prompt PLANE block — model, transport, door sightings, and THIS session's last
      // persisted verdict. The maintainer asked why hundreds of pulls never produced an offer;
      // from here that question is one command wide, answered by facts instead of archaeology.
      if (config.prompt !== undefined) {
        const plane = config.prompt as typeof config.prompt & Partial<import('./prompt.ts').PromptStatusExtras>
        if (typeof plane.planeStatus === 'function') for (const l of plane.planeStatus()) lines.push(l)
        if (typeof plane.sessionRow === 'function') {
          const sessId = (invocation.agent as { session?: { id?: string } })?.session?.id
            ?? (invocation.agent as { agent?: { session?: { id?: string } } })?.agent?.session?.id
          if (sessId !== undefined) { try { lines.push(await plane.sessionRow(sessId)) } catch { /* the block degrades to what it has */ } }
        }
      }
      lines.push(diagnosticStatusLine())
      lines.push(AUTO_SAVE_LINE(config))
      // Findings, read-only, from the #60 auditor's row-level view. What a status cannot check WITHOUT
      // the durable log is named as unchecked rather than counted as clean: coverage holes, orphan
      // files and dead citations need `/chapters-repair audit`.
      {
        const states = [...(domain.table('sessions').entries() as Iterable<[string, SessionState]>)]
          .map(([, st]) => st)
          .filter((st) => (st as { rootSession?: string }).rootSession !== undefined)
        const health = registryHealth(states)
        const dead = states.reduce((m, st) => m + (st.chapters?.length ?? 0), 0)
        lines.push(`Findings (registry-level, this machine): ${health.text}`)
        lines.push(`  NOT checked here: coverage holes, orphan files, dead citations — run /chapters-repair audit${dead === 0 ? ' (no chapter records at all yet)' : ''}`)
      }
      // #255: removals are a STATE — printed in every condition, unlinked included (#61).
      {
        const storeDir0 = cwd === '' ? '' : resolveStoreRoot(cwd, config.artifactStoreRoot)
        const stubs = storeDir0 === '' ? 0 : [...(domain.table('sessions').entries() as Iterable<[string, SessionState]>)]
          .filter(([, st]) => st.rootSession !== undefined && fs.existsSync(path.join(storeDir0, st.rootSession)))
          .reduce((m, [, st]) => m + (st.chapters ?? []).filter(isRemovedChapter).length, 0)
        const mal = storeDir0 === '' ? null : readMissingAccess(storeDir0, 0)
        lines.push(`Removals (this project): ${stubs} removed stub(s); missing-access ledger: ${mal === null ? 'no workspace cwd on this session' : mal.total === 0 ? 'empty (it fills at the next TOC build that cites a vanished chapter — /chapters-remove report)' : `${mal.total} line(s) at ${mal.file}`}`)
      }
      // The retrievability line: a long session that has never tripped an archive moment is the field
      // case #61 found (2,363 events, 414 tool calls, `chapters: []`) — knowledge that exists only in
      // the log and is invisible to every search on this machine.
      {
        const session = (invocation.agent as { agent?: { session?: { id?: string; snapshotEvents?: () => readonly unknown[] } }; session?: { id?: string; snapshotEvents?: () => readonly unknown[] } })
        const sess = session.session ?? session.agent?.session
        const events = sess?.snapshotEvents?.() ?? []
        const ends = events.filter((e) => (e as { type?: string }).type === 'turn/end').length
        const mine = sess?.id !== undefined
          ? ((domain.table('sessions').get(sess.id) as SessionState | undefined)?.chapters.length ?? 0)
          : 0
        if (mine === 0 && ends > 0) {
          lines.push(`This session: ${events.length} events, ${ends} completed turn(s), 0 chapters — NOTHING it does is retrievable. /chapters-save archives it, or /chapters-continue opens a child on the archive.`)
        } else if (mine > 0) {
          lines.push(`This session: ${events.length} events, ${ends} completed turn(s), ${mine} chapter record(s) archived.`)
        }
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  }

  const enrichCommand = {
    name: 'chapters-enrich',
    description: 'P2 chapter enrichment (record \u00A76): run a batch now, set the model, or report pending work.',
    input: { hint: 'run | model <provider/model | clear> | report' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      if (config.enrich === undefined) return { kind: 'error', text: 'enrichment is not wired on this plane' }
      const parts = (invocation.rawInput ?? '').trim().split(/\s+/).filter((p) => p.length > 0)
      const verb = parts[0] ?? 'help'
      try {
        if (verb === 'model') {
          const arg = parts[1]
          if (arg === undefined) {
            const o = config.enrich.modelOverride()
            return { kind: 'success', text: `enrichment model: ${o ?? 'conversation default'}${o === undefined || o === null ? '' : ' (override)'}` }
          }
          await config.enrich.setModelOverride(arg === 'clear' ? null : arg)
          return { kind: 'success', text: arg === 'clear' ? 'enrichment model reset to the conversation default' : `enrichment model set to ${arg} (pending chapters re-qualify under the new key)` }
        }
        if (verb === 'run') {
          const r = await config.enrich.runNow(cwdOf(invocation.agent))
          return { kind: 'success', text: `enrichment: processed ${r.processed} chapter(s); ${r.remaining} pending` }
        }
        if (verb === 'report') {
          return { kind: 'success', text: `${config.enrich.statusLine()}\npending: ${await config.enrich.pendingCount()} chapter(s)` }
        }
        return { kind: 'success', text: 'usage: /chapters-enrich run | model <provider/model | clear> | report' }
      } catch (error) {
        return { kind: 'error', text: `chapters-enrich failed: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
      }
    },
  }

  // #173: the discovery surface for the three model settings. Pure core in models-command.ts;
  // this shell only refuses when the catalog is not wired and re-reads the io per invocation.
  // #221 ANCHOR RPC: the door buttons need the durable seq of the assistant message they were
  // clicked under. The client only ever sees `messageId` (a uuid — measured in the host's own
  // TurnTailNodeView); the seq lives in the session log, which only the server reads. This command
  // is that lookup: `chapters-anchor <messageId>` answers with the bare seq, nothing else. It is
  // plugin-private by naming (no slash menu pretension beyond its purpose) and idempotent.
  const anchorCommand = {
    name: 'chapters-anchor',
    description: 'Resolve an assistant messageId to its durable seq (the continuation doors use it to anchor at the clicked message).',
    input: { hint: '<messageId>' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      const messageId = (invocation.rawInput ?? '').trim()
      if (messageId === '') return { kind: 'error', text: 'chapters-anchor: usage /chapters-anchor <messageId>' }
      const session = (invocation.agent as { session?: { snapshotEvents?: () => readonly unknown[] } })?.session
        ?? (invocation.agent as { agent?: { session?: { snapshotEvents?: () => readonly unknown[] } } })?.agent?.session
      if (session === undefined || typeof session.snapshotEvents !== 'function') {
        return { kind: 'error', text: 'chapters-anchor: no session context — run it in a session' }
      }
      try {
        for (const ev of session.snapshotEvents()) {
          const e = ev as { type?: string; seq?: number; data?: { message?: { id?: string } } }
          if (e.type !== 'assistant/message') continue
          if (e.data?.message?.id === messageId && typeof e.seq === 'number') return { kind: 'success', text: String(e.seq) }
        }
        return { kind: 'error', text: `chapters-anchor: messageId ${messageId.slice(0, 12)}… not found in this session` }
      } catch (error) {
        return { kind: 'error', text: `chapters-anchor failed: ${String((error as Error)?.message ?? error).slice(0, 120)}` }
      }
    },
  }

  const modelsCatalogCommand = {
    name: 'chapters-models',
    description: 'Discover the provider/model identifiers the enrichment, rules-mining, and prompt settings accept, with capabilities and current values: /chapters-models [<provider> [<model>]]',
    input: { hint: '[<provider> [<model>]] — a paste-ready provider/model id works as one arg' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      if (config.models === undefined) return { kind: 'error', text: 'the model catalog is not wired on this plane' }
      return modelsCommand(config.models(), invocation.rawInput ?? '')
    },
  }

  const promptCommand = {
    name: 'chapters-prompt',
    description: 'Prompt recommendations (#71, site \u00A728): set the defining model, turn the composer ghost off, or answer the client\u2019s pull.',
    input: { hint: 'model [provider/model | clear] | off | suggest' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      if (config.prompt === undefined) return { kind: 'error', text: 'prompt recommendations are not wired on this plane' }
      const parts = (invocation.rawInput ?? '').trim().split(/\s+/).filter((p) => p.length > 0)
      const verb = parts[0] ?? 'help'
      try {
        if (verb === 'model') {
          const arg = parts[1]
          if (arg === undefined) {
            const { spec, source } = config.prompt.effective()
            return { kind: 'success', text: spec === ''
              ? `prompt model: OFF${source === 'override' ? ' (stored override — /chapters-prompt model <provider/model> to enable)' : ' (unset — set one with /chapters-prompt model <provider/model>)'}`
              : `prompt model: ${spec} (${source}) — ON` }
          }
          if (arg === 'clear') {
            await config.prompt.setModel(null)
            const { spec } = config.prompt.effective()
            return { kind: 'success', text: spec === ''
              ? 'prompt model override cleared — the config default is unset, so suggestions are OFF'
              : `prompt model override cleared — now following the config default (${spec}, ON)` }
          }
          // #188: the caps ride WITH the model — `/chapters-prompt model <id> [maxChars [contextChars]]`.
          // Explicit numbers store beside prompt.model in the settings table; omitted numbers derive from the
          // selected model's real context window (window × promptContextRatio) at suggestion time, and the
          // config keys are the no-window fallback. Resolution and sources: `/chapters-prompt state`.
          const maxArg = parts[2]
          const ctxArg = parts[3]
          if (parts.length > 4 || (maxArg !== undefined && !/^[1-9][0-9]*$/.test(maxArg)) || (ctxArg !== undefined && !/^[1-9][0-9]*$/.test(ctxArg))) {
            return { kind: 'error', text: `model takes <provider/model> [maxChars [contextChars]] — positive integers (got: ${parts.slice(1).join(' ')})` }
          }
          await config.prompt.setModel(arg)
          if (config.prompt.setCaps !== undefined && (maxArg !== undefined || ctxArg !== undefined)) {
            await config.prompt.setCaps({
              ...(maxArg !== undefined ? { maxChars: maxArg } : {}),
              ...(ctxArg !== undefined ? { contextChars: ctxArg } : {}),
            })
          }
          const capsNote = maxArg !== undefined || ctxArg !== undefined
            ? ` Caps stored beside the model${maxArg !== undefined ? `: suggestion ${maxArg} chars` : ''}${ctxArg !== undefined ? `${maxArg !== undefined ? ',' : ':'} context budget ${ctxArg} chars` : ''}.`
            : " Caps derive from this model's context window (window × promptContextRatio); pass numbers to pin them."
          // #225: enabling is a PLANE-WIDE write; the bar for THIS session only learns about it by
          // pulling (and with the ambient clock gone by default, that means next page load). The
          // maintainer enabled at 18:16 and saw nothing appear — correct per schedule, terrible per
          // experience. So the enable path writes the row and mirrors the record right here, making
          // the bar visible immediately where push exists; pull hosts get the same answer from the
          // state verb on their next sanctioned moment.
          const enHolder = invocation.agent as { agent?: { session?: unknown }; session?: unknown }
          const enSess = (enHolder.session ?? enHolder.agent?.session) as { id?: string } | undefined
          if (enSess?.id !== undefined && config.prompt.bar !== undefined) {
            try { await config.prompt.bar.setOn(enSess.id, enSess) } catch { /* the enable itself succeeded */ }
          }
          return { kind: 'success', text: `prompt model set to ${arg} — this ENABLES the composer ghost (one bounded call per turn boundary; /chapters-prompt off disables).${capsNote} If the bar is hidden, it reappears at the next page reload.` }
        }
        if (verb === 'off') {
          await config.prompt.setModel('')
          // #194: the global switch alone leaves a PUSHED bar showing its last offer forever — no row
          // write means no record. The calling session's row goes off too (what `setOff` exists for),
          // so the record carries the truth to this bar; other open sessions converge through the
          // pull staleness guard on next activation (documented in the contract's push lock).
          const offHolder = invocation.agent as { agent?: { session?: { id?: string } }; session?: { id?: string } }
          const offSessId = offHolder.session?.id ?? offHolder.agent?.session?.id
          if (offSessId !== undefined && config.prompt.bar !== undefined) {
            await config.prompt.bar.setOff(offSessId, offHolder.session ?? offHolder.agent?.session)
          }
          return { kind: 'success', text: 'prompt suggestions OFF (stored override; /chapters-prompt model clear restores the config default)' }
        }
        // #113: the bar's three pulls. `state` answers in k: v lines so ONE output serves both the human
        // typing it and the component rendering it — a separate JSON verb would be a second contract to keep
        // in step, and the goal bar's own dock reads plainly-worded state for the same reason.
        if (verb === 'state') {
          const sessId = (invocation.agent as { agent?: { session?: { id?: string } }; session?: { id?: string } })
            .session?.id ?? (invocation.agent as { agent?: { session?: { id?: string } } }).agent?.session?.id
          if (sessId === undefined || config.prompt.bar === undefined) {
            return { kind: 'error', text: 'state needs a session scope and the chapters prompt store — run it inside a session' }
          }
          // #231: the state reply comes from the ROW — a durable read with no side effects. The full
          // `bar.read` (row + live loop status) is consulted ONLY when the row is absent, which is also
          // the one moment worth mirroring: an empty row means "this session has never been served",
          // so the mirror writes the record that makes future mounts push-fed. A ready offer was NEVER
          // re-read or re-mirrored here before — every pull cost a store read and (on push hosts) a
          // duplicate record append. On the maintainer's host that path ran every minute for hours.
          let st = await config.prompt.bar.peekRow(sessId)
          if (st === null) {
            st = await config.prompt.bar.read(sessId)
            const sessObj = (invocation.agent as { session?: unknown }).session
              ?? (invocation.agent as { agent?: { session?: unknown } }).agent?.session
            if (sessObj !== undefined && typeof (config.prompt.bar.read as { mirror?: unknown }).mirror === 'function') {
              void (config.prompt.bar.read as unknown as { mirror: (sessionId: string, session: unknown) => void }).mirror(sessId, sessObj)
            }
          }
          const { spec, source } = config.prompt.effective()
          // #113: `off` must mean OFF. A session with a defining model and no stored offer is `idle` — enabled,
          // awaiting its first turn — and collapsing that into `off` is what made the bar look switched-off
          // while the config row was present. The distinction is the human's only signal that the feature is
          // live but has nothing to say yet, so it is made here, at the one place the state is rendered.
          const resting = st.status === 'off' && spec !== '' ? { ...st, status: 'idle' as const } : st
          return { kind: 'success', text: [
            `suggested next step: ${resting.status}`,
            `  model: ${spec !== '' ? spec : 'unset'} (${source}) — ${spec === '' ? 'the bar is absent' : 'one offer per completed turn'}`,
            `  autorun: ${st.autorun}${st.autorun === 'armed' ? ` (${String(st.fired)} round(s) started this process)` : ''}`,
            `  turn: ${st.turnSeq === null ? '-' : String(st.turnSeq)}`,
            // #113: intent and the revision it was cut against, because they decide whether autorun may act.
            // A `goal-edit` offer is held for a keystroke — the host reserves goal edits for a human turn —
            // and the bar must be able to say that without re-parsing the prompt.
            `  intent: ${st.intent}${st.intent === 'goal-edit' ? ' — re-cuts the goal, so Run it yourself; autorun will not' : ''}`,
            `  goal: ${st.goalRevision === null ? 'none' : `revision ${String(st.goalRevision)}`}`,
            // #229: the heartbeat the server has configured rides EVERY state reply — the client's
            // schedule is the operator's setting, not a compile-time guess. Zero (the default) means
            // no ambient clock exists at all; the sanctioned moments still do.
            `  heartbeat: ${String((config.prompt.bar as { quietHeartbeatSec?: number }).quietHeartbeatSec ?? 0)}s`,
            ...(st.error === '' ? [] : [`  error: ${st.error}`]),
            ...(st.text === '' ? [] : ['  prompt:', ...st.text.split('\n').map((l) => `    ${l}`)]),
          ].join('\n') }
        }
        if (verb === 'run') {
          // The bar's Run button. Session-scoped like `state`, because "the offer on screen" is a per-session
          // fact and a global command would run whatever the last session happened to be shown.
          const runId = (invocation.agent as { agent?: { session?: { id?: string } }; session?: { id?: string } })?.session?.id
            ?? (invocation.agent as { agent?: { session?: { id?: string } } })?.agent?.session?.id
          if (runId === undefined || config.prompt.bar === undefined) {
            return { kind: 'error', text: 'run needs a session scope and the chapters prompt store' }
          }
          console.error(`[chapters-prompt] /run invoked for session=${String(runId)}`)
          const res = await config.prompt.bar.runNow(runId)
          console.error(`[chapters-prompt] /run result ok=${String(res.ok)} reason=${String(res.reason ?? '')}`)
          return res.ok
            ? { kind: 'success', text: `running the suggested next step as your own turn:\n${res.text}` }
            : { kind: 'error', text: `cannot run: ${res.reason ?? 'the offer is no longer available'}` }
        }
        if (verb === 'autorun') {
          const arg = parts[1]
          const sessId = (invocation.agent as { agent?: { session?: { id?: string } }; session?: { id?: string } })
            .session?.id ?? (invocation.agent as { agent?: { session?: { id?: string } } }).agent?.session?.id
          const on = arg === 'on' || arg === 'arm'
          const off = arg === 'off' || arg === 'disarm'
          if (sessId === undefined || config.prompt.bar === undefined) {
            return { kind: 'error', text: 'autorun needs a session scope — run it inside the session you want to drive' }
          }
          if (!on && !off) {
            return { kind: 'error', text: `autorun needs 'on' or 'off' (got ${arg ?? 'nothing'}) — /chapters-prompt autorun on starts the loop, off leaves the offers in place and stops the running` }
          }
          const { spec } = config.prompt.effective()
          if (on && spec === '') {
            return { kind: 'error', text: 'cannot arm autorun with no prompt model — the loop has nothing to generate offers. /chapters-prompt model <provider/model> first' }
          }
          // #194: the live session rides along so the autorun flip can mirror to the push transport.
          const sessObj = (invocation.agent as { session?: unknown }).session
            ?? (invocation.agent as { agent?: { session?: unknown } }).agent?.session
          const live = config.prompt.bar.setAutorun(sessId, on, sessObj)
          return { kind: 'success', text: on
            ? `autorun ARMED for ${sessId} — each completed turn's offer runs for you, until you stop it or send a prompt yourself.` + (live.displaced
                ? ' The goal remains the objective; its own auto-continuation is disarmed, so the suggestion loop now drives the worker. Re-arm it with /goal resume.'
                : ' The goal still owns the turn; this loop yields to it until the goal is paused, completed, or disarmed.') + ' State: /chapters-prompt state'
            : `autorun disarmed for ${sessId} — offers still appear each turn; nothing runs itself (${String(live.fired)} round(s) were started this process)` }
        }
        if (verb === 'on') {
          if (config.prompt.bar === undefined) return { kind: 'error', text: 'the chapters prompt store is unavailable in this context' }
          const { spec } = config.prompt.effective()
          if (spec === '') {
            return { kind: 'error', text: 'nothing to turn on: the prompt model is unset. /chapters-prompt model <provider/model> sets it, and setting it IS the enable' }
          }
          const holder = invocation.agent as { agent?: { session?: { id?: string } }; session?: { id?: string } }
          const sessId = holder.session?.id ?? holder.agent?.session?.id
          if (sessId !== undefined) await config.prompt.bar.setOn(sessId, holder.session ?? holder.agent?.session)
          return { kind: 'success', text: `suggestions ON (${spec}) — the next completed turn offers a next step; /chapters-prompt state shows it, /chapters-prompt autorun on runs them. If the bar is hidden, it reappears at the next page reload.` }
        }
        if (verb === 'suggest') {
          const holder = invocation.agent as { agent?: { session?: { id?: string; snapshotEvents?: () => readonly unknown[] } }; session?: { id?: string; snapshotEvents?: () => readonly unknown[] } }
          const sess = holder.session ?? holder.agent?.session
          if (sess?.id === undefined) return { kind: 'error', text: 'suggest needs a session scope — run it inside a session (the composer ghost calls this verb; humans rarely do)' }
          const events = (sess.snapshotEvents?.() ?? []) as readonly SessionEventLike[]
          const titleEvent = [...events].reverse().find((e) => e.type === 'session/title')
          const title = titleEvent !== undefined && typeof titleEvent.data.title === 'string' ? titleEvent.data.title : undefined
          const r = await config.prompt.suggest({ id: sess.id, title, cwd: cwdOf(invocation.agent), events: [...events] })
          // #113: this returned `text: r.text` — ONE bare line, which the composer ellipsized with no way to
          // recover it. /chapters-status gets an expander because it answers with a labelled multi-line block,
          // so this does the same: the prompt verbatim inside a fence, then the facts that bound it (which
          // model, from which source, against which cap, for which session). Stating the cap matters because an
          // over-cap answer is refused and retried, never truncated — the number belongs in the output.
          const F = String.fromCharCode(96).repeat(3)
          const { spec, source } = config.prompt.effective()
          const lim = config.prompt.limits !== undefined ? await config.prompt.limits(null) : undefined
          const who = `${title !== undefined && title !== '' ? `\u201c${title}\u201d ` : ''}(${sess.id})`
          const capLine = lim !== undefined
            ? `  caps: suggestion ${String(lim.maxChars)} chars (${lim.sources.maxChars}) · context budget ${String(lim.contextChars)} chars (${lim.sources.contextChars}) — over-cap is refused and retried, never truncated`
            : '  caps: (not reported by this surface)'
          const meta = `  model: ${spec !== '' ? spec : 'unset'} (${source})\n${capLine}`
          if (r.ok) {
            // #225: `suggest` used to print the offer inside a fence with instructions to COPY IT
            // INTO THE COMPOSER by hand — an affordance dead since the ghost chip was removed. The
            // human asked for a suggestion; the answer is the BAR SHOWING IT, so this writes the
            // offer through the same row + mirror path the turn-end runner uses and reports the
            // facts compactly. Run stays the one way an offer becomes a turn (host rule: no plugin
            // submits without a keystroke).
            const sugHolder = invocation.agent as { agent?: { session?: unknown }; session?: unknown }
            const sugSess = (sugHolder.session ?? sugHolder.agent?.session) as { id?: string } | undefined
            const offer = classifyOffer(r.text)
            if (sugSess?.id !== undefined && config.prompt.bar !== undefined) {
              try { await config.prompt.bar.setSuggested?.(sugSess.id, r.text, sugSess) } catch { /* the answer still prints below */ }
            }
            return { kind: 'success', text: [
              `/chapters-prompt suggest — the next prompt for ${who} is on the bar:`,
              `  ${offer.text.split('\n')[0]!.slice(0, 140)}`,
              meta,
            ].join('\n') }
          }
          if (r.quiet === true) {
            // Nothing to offer is an ANSWER to an explicit request, not a failure. With the ghost gone there is
            // no automated caller that reads a success line as an offer — that collision is what made wiring
            // `quiet` wrong last time, and removing the chip is what unblocked it.
            return { kind: 'success', text: [`/chapters-prompt suggest — nothing to offer yet for ${who}`, '', `  ${r.text}`, '', meta].join('\n') }
          }
          return { kind: 'error', text: `chapters-prompt: ${r.text}\n  model: ${spec !== '' ? spec : 'unset'} (${source})` }
        }
        return { kind: 'success', text: 'usage: /chapters-prompt model [provider/model | clear] | off | suggest' }
      } catch (error) {
        return { kind: 'error', text: `chapters-prompt failed: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
      }
    },
  }

  /**
   * #255: `/chapters-remove` — the operator door that deletes BAD chapters from THIS project's
   * memory. The field case is the wrong-project prompt; supersede (#60) keeps bytes, this removes
   * them. Verbs: `list [sessionId]`, `find <query>`, `[dry-run] <id…>`, `apply <id…>`, `report`,
   * `restore <journal-id>`. Dry-run is the default; `apply` is the only word that deletes. Scope
   * is same-project by construction: only rows whose store tree exists under THIS workspace resolve.
   */
  const removeCommand = {
    name: 'chapters-remove',
    description: 'Delete bad chapters from this project\u2019s memory (#255): list | find | dry-run | apply | report | restore.',
    input: { hint: '[list [sessionId] | find <query> | [dry-run] <id…> | apply <id…> | report | restore <journal-id>]' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      const cwd = cwdOf(invocation.agent)
      const cap = config.reportMaxLines ?? 40
      const err = (t: string): CommandResult => ({ kind: 'error', text: t })
      if (cwd === '') return err('chapters-remove: this session has no workspace cwd — nowhere to act')
      if (config.store === undefined) return err('chapters-remove: this plane carries no registry handle — nothing was written')
      const wrapped = invocation.agent as { session?: { id?: string }; agent?: { session?: { id?: string } } }
      const callerId = wrapped.session?.id ?? wrapped.agent?.session?.id
      const storeDir = resolveStoreRoot(cwd, config.artifactStoreRoot)
      // Same-project scope (#255): a row resolves iff its store tree exists under this workspace.
      // Session ids are globally unique, so the tree-exists test cannot cross projects.
      const allRows = [...(domain.table('sessions').entries() as Iterable<[string, SessionState]>)]
      const rows: [string, SessionState][] = allRows.filter(([, st]) =>
        st.rootSession !== undefined && st.rootSession !== '' && fs.existsSync(path.join(storeDir, st.rootSession)))
      const parts = (invocation.rawInput ?? '').trim().split(/\s+/).filter((p) => p.length > 0)
      const verb = parts[0] ?? ''
      const argTail = parts.slice(1)
      const fmtBytes = (n: number): string => n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`

      if (verb === 'list') {
        const focus = argTail[0] ?? callerId
        if (focus === undefined) return err('chapters-remove list: no session context — pass list <sessionId> whose ancestor path names the chapters to review')
        const byId = new Map(rows)
        if (byId.get(focus) === undefined) return err(`chapters-remove list: session ${focus} has no row under this project's store (${storeDir}) — removal is same-project only; run it in the project that owns the session`)
        let pathIds: string[]
        try { pathIds = ancestorPath((id) => byId.get(id), focus) } catch (error) { return err(`chapters-remove list: ${String((error as Error)?.message ?? error)}`) }
        const entries = buildIndex(pathIds, (id) => byId.get(id), () => 'ok' as const)
        const afs = makeArchiveFs(cwd)
        const lines: string[] = []
        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i]!
          const rec = byId.get(e.authorSession)?.chapters.find((c) => c.number === e.number)
          const verdict = rec !== undefined ? await verifyChapter(afs, rec) : 'missing'
          lines.push(`  ${String(i + 1)}. ${e.authorSession}:${e.number} · ${verdict} · ${e.title} — ${e.summary}\n      ${e.path}`)
        }
        const stubs = rows.reduce((m, [, st]) => m + st.chapters.filter(isRemovedChapter).length, 0)
        const head = entries.length === 0
          ? 'chapters-remove list: no ACTIVE chapters on this ancestor path — nothing removable here.'
          : `chapters-remove list (${pathIds.join(' → ')}) — ${entries.length} active chapter(s), reading order = TOC order; the ids are what dry-run/apply accept:`
        return { kind: 'success', text: [head, ...lines, `  +${stubs} removed stub(s) on this project (uncited by design; ledger: /chapters-remove report)`].join('\n') }
      }

      if (verb === 'find') {
        const query = argTail.join(' ')
        if (query === '') return err('chapters-remove find: needs a query — /chapters-remove find <words>')
        const project = projectForCwd(domain.table('projects').entries(), cwd)
        const lines: string[] = []
        const push = (rawPath: string, title: string, kindLabel: string): void => {
          if (kindLabel === 'rule') { lines.push(`  ${rawPath} · ${title} — rules are revoked via /chapters-rule, not removed here`); return }
          const res = resolveRemovalId(rawPath, rows, cwd, callerId)
          lines.push('target' in res
            ? `  ${rawPath} → removable id ${res.target.sessionId}:${res.target.record.number} · ${title}`
            : `  ${rawPath} · ${title} — not removable from this tree (${res.refusal.split('\n')[0]})`)
        }
        if (project !== undefined) {
          const out = searchKnowledge(path.join(cwd, DEFAULT_CLONE_DIR), query, 600, { projectKey: project.projectKey })
          for (const r of out.results) push(r.path, r.title, r.kind)
          if (out.total === 0) return { kind: 'success', text: `chapters-remove find "${query}" — no matches in the pool mirror. Nothing was written.` }
          const withheldF = Math.max(0, out.results.length - cap)
          return { kind: 'success', text: [
            `chapters-remove find "${query}" — ${out.total} hit(s) in the pool mirror, ${lines.length} shown:`,
            ...lines.slice(0, cap),
            ...(withheldF > 0 ? [`  … ${withheldF} more withheld by the report cap (${cap})`] : []),
            '  next: /chapters-remove <removable id> (dry-run), then apply <id>',
          ].join('\n') }
        }
        const out = searchLocalStore(storeDir, query, 600)
        for (const r of out.results) push(r.path, r.title, r.kind)
        if (out.total === 0) return { kind: 'success', text: `chapters-remove find "${query}" — no matches in this project's local store (${out.documents} document(s) scanned; no pool linked). Nothing was written.` }
        const withheldL = Math.max(0, out.results.length - cap)
        return { kind: 'success', text: [
          `chapters-remove find "${query}" — ${out.total} hit(s) in the LOCAL store (knowledge-local: no pool linked), ${lines.length} shown:`,
          ...lines.slice(0, cap),
          ...(withheldL > 0 ? [`  … ${withheldL} more withheld by the report cap (${cap})`] : []),
          '  next: /chapters-remove <removable id> (dry-run), then apply <id>',
        ].join('\n') }
      }

      // dry-run is the DEFAULT: a first token that is not a verb but looks like an id (path,
      // `session:number`, pool tail, or a bare ordinal) resolves as `[dry-run] <id…>`. A token
      // that is neither never guesses — it hits the unknown-verb refusal below.
      const looksLikeId = !['list', 'find', 'report', 'restore', 'apply', 'dry-run'].includes(verb) && /[:/.0-9]/.test(verb)
      if (verb === '' || verb === 'dry-run' || verb === 'apply' || looksLikeId) {
        const ids = verb === 'apply' ? argTail : parts.filter((p) => p !== 'dry-run')
        if (ids.length === 0) return err('usage: /chapters-remove list [sessionId] | find <query> | [dry-run] <id…> | apply <id…> | report | restore <journal-id>')
        const targets: RemovalTarget[] = []
        const refusals: string[] = []
        for (const raw of ids) {
          const res = resolveRemovalId(raw, rows, cwd, callerId)
          if ('target' in res) targets.push(res.target)
          else refusals.push(res.refusal)
        }
        if (refusals.length > 0) return err(`chapters-remove: NOTHING WRITTEN — ${refusals.length} unresolved id(s):\n  ${refusals.join('\n  ')}${targets.length > 0 ? `\n  (${targets.length} did resolve; drop the bad ids and re-run)` : ''}`)
        const plan = planRemoval({ targets, rows, cwd })
        const bytes = plan.chapterFiles.reduce((s, f) => s + f.bytes, 0) + plan.blobFiles.reduce((s, f) => s + f.bytes, 0)
        const header = [`chapters-remove ${verb === 'apply' ? 'APPLY' : 'dry-run'} — ${targets.length} chapter(s) from ${new Set(targets.map((t) => t.sessionId)).size} tree(s):`]
        const set = [
          ...plan.chapterFiles.map((f) => `  chapter  ${f.stored} (${fmtBytes(f.bytes)})`),
          ...plan.blobFiles.map((f) => `  blob     ${f.stored} (${fmtBytes(f.bytes)}) — orphaned: no active chapter names it`),
          ...plan.missing.map((m) => `  absent   ${m} — the record cites it, the disk does not have it; the stub closes the claim anyway`),
          `  total leaving the store: ${fmtBytes(bytes)} across ${plan.chapterFiles.length + plan.blobFiles.length} file(s); blobs shared with a surviving chapter are NEVER deleted (orphan math)`,
        ]
        const dang = plan.dangling.length > 0
          ? [`  dangling after removal (${plan.dangling.length}) — surviving chapters that still cite a removed file ("does the referrer stay?" is the operator's call):`,
            ...plan.dangling.slice(0, cap).map((d) => `    ${d.referrer} cites ${d.needle}`),
            ...(plan.dangling.length > cap ? [`    … ${plan.dangling.length - cap} more (all of them land in /chapters-remove report)`] : [])]
          : ['  no surviving chapter cites these files']
        if (verb !== 'apply') return { kind: 'success', text: [...header, ...set, ...dang, '  NOTHING WRITTEN. apply: /chapters-remove apply <the same ids>'].join('\n') }
        const project = projectForCwd(domain.table('projects').entries(), cwd)
        const mirrorAbs = path.join(cwd, DEFAULT_CLONE_DIR)
        const out = await applyRemoval({
          store: config.store,
          cwd, rows, storeDir,
          ...(project !== undefined && fs.existsSync(mirrorAbs) ? { cloneDir: mirrorAbs, projectKey: project.projectKey } : {}),
          now: () => new Date().toISOString(),
        }, plan)
        let syncLine = '  pool: unlinked project — store-only removal; this machine\u2019s memory is what got cleaned'
        if (project !== undefined) {
          try {
            const res = config.scheduler !== undefined
              ? await config.scheduler.run(cwd, 'removal', project)
              : await syncNow(cwd, project, readToken(cwd, config.artifactStoreRoot, project.projectKey))
            syncLine = `  sync: ${res.steps.join('') !== '' ? res.steps.join(' → ') : res.detail}${res.ok ? '' : ' ⚠ the deletion is applied locally; the pool push FAILED — /chapters-status carries the detail'}`
          } catch (error) {
            syncLine = `  sync: pass threw (${String((error as Error)?.message ?? error)}) — local removal is complete; run /chapters-link or let the scheduler retry`
          }
        }
        return { kind: 'success', text: [
          ...header, ...set, ...dang,
          `  removed ${out.removed.length} file(s), stubbed ${out.stubbed.length === 0 ? 'NONE (see problems)' : out.stubbed.join(', ')}`,
          `  journal: ${out.journalId !== '' ? `${out.journalId} — reversal: /chapters-remove restore ${out.journalId}` : 'NOT WRITTEN — nothing was deleted'}`,
          out.problems.length > 0 ? `  PROBLEMS (${out.problems.length}): ${out.problems.join(' | ')}` : '  no problems',
          syncLine,
          '  every TOC built from here on omits the removed chapter(s); already-seeded children keep their recorded text (invariant 1) and their misses land in /chapters-remove report',
        ].join('\n') }
      }

      if (verb === 'report') {
        const r = readMissingAccess(storeDir, cap)
        if (r.total === 0) return { kind: 'success', text: `chapters-remove report: the missing-access ledger is empty — no removal citations and no dead-citation misses recorded on this project yet. File when written: ${r.file}` }
        return { kind: 'success', text: [
          `chapters-remove report — ${r.total} line(s) at ${r.file}, last ${r.lines.length}:`,
          ...r.lines,
          ...(r.withheld > 0 ? [`  … ${r.withheld} earlier line(s) withheld by the report cap (${cap}) — read the file for all`] : []),
          '  verdicts: dead-citation = a TOC cite whose bytes vanished (decide: repair or remove the referrer); removed= = the removal ledger',
        ].join('\n') }
      }

      if (verb === 'restore') {
        if (argTail[0] === undefined) return err('chapters-remove restore: needs a journal id (printed by apply; journals live under <store>/<tree>/removals/)')
        return err('restore: not wired on this build yet') // replaced by the re-derivation arm (Task 7)
      }

      return err(`chapters-remove: unknown verb "${verb}" — usage: list [sessionId] | find <query> | [dry-run] <id…> | apply <id…> | report | restore <journal-id>`)
    },
  }

  try {
    const d1 = commands.register(linkCommand)
    if (typeof d1 === 'function') disposers.push(d1 as () => void)
    const d2 = commands.register(statusCommand)
    if (typeof d2 === 'function') disposers.push(d2 as () => void)
    const dRemove = commands.register(removeCommand)
    if (typeof dRemove === 'function') disposers.push(dRemove as () => void)
    const d3 = commands.register(enrichCommand)
    if (typeof d3 === 'function') disposers.push(d3 as () => void)
    const d3b = commands.register(promptCommand)
    if (typeof d3b === 'function') disposers.push(d3b as () => void)
    const d3d = commands.register(anchorCommand)
    if (typeof d3d === 'function') disposers.push(d3d as () => void)
    const d3c = commands.register(modelsCatalogCommand)
    if (typeof d3c === 'function') disposers.push(d3c as () => void)
    if (config.rules !== undefined) {
      const rulesFn = config.rules
      const rulesCommandDef = {
        name: 'chapters-rule',
        description: 'Rules (record \u00A77): project tier propose/approve/revoke per machine; session tier review, pin, conflict report.',
        input: { hint: 'add <category> <text> | list [--all|--proposed|--category <c>|--scope project|session] | view <id> | active | approve <id> | revoke <id> | pin <id> | unpin <id> | conflicts' },
        async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
          // the session id reaches the resolver because the SESSION tier activates
          // by ancestry (§7.5): `active` cannot answer without knowing which tree
          // is asking. Command output never enters the model context (§7.2).
          const sessionId = (invocation.agent as { session?: { id?: string } } | undefined)?.session?.id
          const r = await rulesFn(cwdOf(invocation.agent), invocation.rawInput ?? '', sessionId)
          return { kind: r.kind, text: r.text }
        },
      }
      const d4 = commands.register(rulesCommandDef)
      if (typeof d4 === 'function') disposers.push(d4 as () => void)
    }
  } catch (error) {
    // LOUD on the operator's console too — a swallowed register error here is
    // how r35g's silent command-absence cost an extra boot to diagnose.
    const message = `dsh-chapters: host command registration failed (${String(error)})`
    ctx.logger?.warn?.(message)
    console.error(message)
  }
  return () => { for (const d of disposers) d() }
}
