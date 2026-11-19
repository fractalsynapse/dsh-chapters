/**
 * Harness-native model routing for the e2e rig (#56/#108 lineage, 2026-10-25).
 *
 * WHY THIS EXISTS. The rig's provider came from one tracked block only — `local`, `baseURL:
 * http://localhost:8080/v1` — chosen because a GitHub runner has no credentials and can start a llama.cpp
 * server. On the maintainer's machine that choice is actively wrong: this plugin is developed INSIDE DSH,
 * against a route the running harness already holds (`qwen-token-plan`, `apiKeyEnv:
 * QWEN_TOKEN_PLAN_API_KEY`, default `qwen3.8-flash`). Distilling or running live legs through a DIFFERENT
 * model than the product runs against is also how the #90 `reasoning_content` divergence class was born — the
 * blind list masks a shape mismatch instead of removing it.
 *
 * PURE MODULE, ON PURPOSE: the YAML composition and the credential resolution are decisions, and a decision
 * that only exists inside `boot.ts` can only be tested by booting a browser. `tests/unit/harness-provider.test.ts`
 * holds them instead.
 */

export interface ProviderRoute {
  /** provider id as the profile names it, e.g. 'qwen-token-plan' */
  id: string
  /** the model the rig should drive, e.g. 'qwen3.8-flash' */
  model: string
  /** env var the host reads the key from, e.g. 'QWEN_TOKEN_PLAN_API_KEY' */
  apiKeyEnv: string
  /** omitted when the host plugin resolves the endpoint (our own live profile is exactly that case) */
  baseURL?: string | undefined
  /**
   * The provider block and the default-model block **verbatim from the source profile** (#124 follow-up).
   * Inventing a block is how harness-native mode broke nine legs at once: I synthesized
   * `api: openai-completions` with no `baseURL` because the live profile declares neither — the endpoint is
   * resolved by the host's own provider plugin — so the rig booted a provider that could never answer,
   * produced no assistant message, and every journey then "failed" at a missing door, a missing plan card, a
   * missing marker. The rig must carry the SAME config this session is actually running on, edited only
   * where the stress regime says to edit it.
   */
  providerBlock: string
  defaultModelBlock: string
}

/**
 * Read `providers:`/`agent-default-model` facts out of a profile YAML without a YAML dependency.
 * Deliberately conservative: an unrecognizable block returns null, and the caller fails LOUDLY. Guessing a
 * route here would produce a rig that talks to the wrong model and still goes green — the #54 lesson
 * ("a spec that skips because it is looking at the wrong endpoint is a spec that is not run").
 */
export function routeFromProfile(yaml: string): ProviderRoute | null {
  const lines = yaml.split('\n')
  // 1. the default model row answers "which provider and model does THIS host actually run?"
  let provider: string | null = null
  let model: string | null = null
  const dm = lines.findIndex((l) => /^- id: agent-default-model\s*$/.test(l))
  if (dm !== -1) {
    for (let k = dm + 1; k < lines.length && !/^\S/.test(lines[k]!); k++) {
      const l = lines[k]!
      if (/^\s{4}config:/.test(l)) continue
      const pv = /^\s+provider:\s*(\S+)\s*$/.exec(l)
      const mv = /^\s+model:\s*(\S+)\s*$/.exec(l)
      if (provider === null && pv !== null) provider = pv[1]!
      if (model === null && mv !== null) model = mv[1]!
    }
  }
  if (provider === null || model === null) return null
  // 2. that provider's own block, located by indentation under `providers:` — never by guessing structure
  //    from a regex over the whole document (my first pass returned null on the real profile, which is how
  //    a fragile parser announces itself).
  // The doubled `\\s` is load-bearing: this pattern is built from a STRING. In a template literal a single
  // `\s` loses its backslash before RegExp ever sees it, becoming `s{6}` — six literal 's' characters. It
  // matched nothing and returned null, which my own row caught: a parser that fails silently is worse than
  // one that throws.
  const start = lines.findIndex((l) => new RegExp(`^\\s{6}${provider}:\\s*$`).test(l))
  if (start === -1) return null
  let apiKeyEnv: string | undefined
  let baseURL: string | undefined
  for (let k = start + 1; k < lines.length; k++) {
    const l = lines[k]!
    if (!/^\s{8}/.test(l)) break // dedent ends the provider block
    const ak = /^\s{8}apiKeyEnv:\s*(\S+)\s*$/.exec(l)
    if (ak !== null) apiKeyEnv = ak[1]
    const bu = /^\s{8}baseURL:\s*(\S+)\s*$/.exec(l)
    if (bu !== null) baseURL = bu[1]
  }
  // An unusable route is reported as null, not half-built: a provider with no `apiKeyEnv` cannot be
  // authenticated by a throwaway home, and inventing one is the #54 class in a new costume.
  if (apiKeyEnv === undefined) return null
  const blockAt = (startIdx: number): string => {
    let end = startIdx + 1
    while (end < lines.length && !/^\S/.test(lines[end]!)) end++
    return lines.slice(startIdx, end).join('\n')
  }
  const providerStart = lines.findIndex((l) => new RegExp(`^\\s{6}${provider}:\\s*$`).test(l))
  const defaultStart = lines.findIndex((l) => /^- id: agent-default-model\s*$/.test(l))
  if (providerStart === -1 || defaultStart === -1) return null
  const providerBlock = blockAt(providerStart)
  const defaultModelBlock = blockAt(defaultStart)
  return {
    id: provider, model, apiKeyEnv,
    ...(baseURL !== undefined ? { baseURL } : {}),
    providerBlock, defaultModelBlock,
  }
}

export interface KeyResolution {
  key: string | null
  /** where it came from, for the terminal line: 'env' | 'file' | null */
  source: 'env' | 'file' | null
  /** what the human must do when it is null — never a silent skip */
  remedy: string | null
}

/**
 * Credential resolution, in the order the maintainer chose.
 *
 *  1. **the parent environment** — `QWEN_TOKEN_PLAN_API_KEY`, the same way the harness itself gets it. When
 *     you run a leg from your own shell this is the only source needed.
 *  2. **an untracked local file** (default `.dshdev-local/e2e.env`, gitignored next to the rest of the
 *     untracked home) — accepted because the maintainer asked for it to be available even when env is.
 *  3. **nothing** → `key: null` with a remedy naming both. NO fallback to `localhost:8080`, and no `skip`: a
 *     rig that quietly runs the wrong model, or quietly does not run, is the failure mode this whole file
 *     exists to end.
 *
 * The key value is never part of `remedy`, and callers must never print `key`.
 */
export function resolveKey(env: NodeJS.ProcessEnv, fileText: string | null, envName: string): KeyResolution {
  const fromEnv = (env[envName] ?? '').trim()
  if (fromEnv !== '') return { key: fromEnv, source: 'env', remedy: null }
  if (fileText !== null) {
    const line = new RegExp(`^\\s*(?:export\\s+)?${envName}\\s*=\\s*(.+?)\\s*$`, 'm').exec(fileText)?.[1]?.replace(/^["']|["']$/g, '')
    if (line !== undefined && line !== '') return { key: line, source: 'file', remedy: null }
  }
  return {
    key: null,
    source: null,
    remedy: `export ${envName}=… in the shell you launch this from, or write it to .dshdev-local/e2e.env `
      + `(gitignored, next to the untracked dev home). Nothing was guessed and no route was substituted.`,
  }
}

/** Parse one `KEY=value` line set from an env file without executing it (no `source`, no shell). */
export function readEnvFile(text: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/gm)) {
    out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * The profile block for a harness-native boot. The pinned context window is KEPT — the stress regime is what
 * makes the pressure and cache legs mean anything (`boot.ts`'s comment is explicit: a hosted endpoint would
 * swallow a 33K prompt and the `context-overflow` trigger would never fire).
 */
export function harnessProviderPatch(route: ProviderRoute, windowTokens: number): string {
  // Copy, then edit the ONE thing the stress regime requires. Nothing else is synthesized: no `api:`, no
  // `baseURL`, no ordering, because those choices belong to the host's provider plugin and my guess was the
  // bug. The context window is replaced on both blocks so the rig still refuses an over-window request the
  // way the tape's own run did (#78).
  const pinWindow = (block: string): string => block
    .replace(/contextWindow: \d+/g, `contextWindow: ${String(windowTokens)}`)
    .replace(/maxTokens: \d+/g, 'maxTokens: 15000')
  return [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    pinWindow(route.providerBlock).replace(/^\s{6}/, '      '),
    pinWindow(route.defaultModelBlock),
    '',
  ].join('\n')
}

/** One readable terminal line about the route, with the key NEVER shown. */
export function describeRoute(route: ProviderRoute, resolved: KeyResolution, mode: string): string {
  const where = resolved.key === null ? 'MISSING' : `${String(resolved.key.length)} chars from ${String(resolved.source)}`
  return `[provider] ${route.id}/${route.model} · window pinned · mode=${mode} · ${route.apiKeyEnv}: ${where}`
    + (route.baseURL !== undefined ? ` · ${route.baseURL}` : ' · endpoint resolved by the host plugin')
}

/**
 * The plan's OpenAI-compatible endpoint, read out of the installed provider module rather than typed in.
 * The profile carries no `baseURL` for this provider (the plugin resolves it), and hard-coding a region URL
 * here is the drift this repo keeps being bitten by: the day the route moves, the rig would quietly talk to
 * the wrong host. Returns null when the module cannot be read, and the caller refuses rather than guessing.
 */
export function endpointFromProviderModule(providerModuleText: string): string | null {
  return /baseUrl:\s*"(https?:\/\/[^"]+)"/.exec(providerModuleText)?.[1] ?? null
}

/**
 * #414 — collapse a booted rig profile onto EXACTLY ONE route answer, before the host starts.
 *
 * The measured void this closes: the live+harness branch replaced the `llm-pi-ai` provider block
 * while the seeded `agent-default-model: provider: local` row survived — the session composed a
 * provider whose block no longer existed, and the turn died at `no credential for provider route
 * "local"` with zero requests sent. Boot's comment already demanded the invariant ("which model
 * powered this leg must have exactly one answer"); this is the function that enforces it, and
 * boot refuses at STARTUP on a non-null error — named in seconds, not via a 15-minute marker wait.
 *
 * Both seed shapes are real: the tracked seed carries NO llm-pi-ai block (boot's tracked branch
 * appends one at boot), while an already-booted profile HAS one (replace in place — never
 * duplicate). The emitted patch carries the route's own default row, so a profile whose default
 * row was deleted is RESTORED rather than fatalized. Idempotence is asserted: re-applying the
 * alignment to its own output changes no byte, so a collapse can never oscillate.
 */
export function applyHarnessRoute(
  profileText: string,
  route: ProviderRoute,
  windowTokens: number,
): { text: string, error: string | null } {
  const patch = harnessProviderPatch(route, windowTokens)
  const text = /^- id: llm-pi-ai\s*$/m.test(profileText)
    ? profileText.replace(/- id: llm-pi-ai\n(?:.*\n)*?(?=- id: |\Z)/, patch)
    : `${patch}\n${profileText}`
  // Collapse agent-default-model rows to exactly one, and it must be the route's.
  const lines = text.split('\n')
  const isStart = (l: string): boolean => /^- id: agent-default-model\s*$/.test(l)
  const blockEnd = (s: number): number => {
    let e = s + 1
    while (e < lines.length && !/^\S/.test(lines[e]!)) e += 1
    return e
  }
  const providerOf = (s: number): string | null => {
    for (let k = s; k < blockEnd(s); k += 1) {
      const m = /^\s+provider:\s*(\S+)\s*$/.exec(lines[k]!)
      if (m !== null) return m[1] ?? null
    }
    return null
  }
  const starts = lines.map((l, i) => isStart(l) ? i : -1).filter((i) => i >= 0)
  const keepers = starts.filter((s) => providerOf(s) === route.id)
  const droppable = starts.filter((s) => !keepers.includes(s))
    .concat(keepers.slice(0, Math.max(0, keepers.length - 1))) // multiples of the route's: keep the LAST
  for (const s of droppable.sort((a, b) => b - a)) lines.splice(s, blockEnd(s) - s)
  const collapsed = lines.join('\n')
  // Verify the invariant rather than trust the rewrite: exactly one row, naming the route, whose
  // provider block is actually present. Any other answer is a startup refusal, by name.
  const remaining = (collapsed.match(/^- id: agent-default-model\s*$/gm) ?? []).length
  if (remaining !== 1) {
    return { text: collapsed, error: `expected exactly one agent-default-model row after alignment, found ${String(remaining)}` }
  }
  if (!new RegExp(`^- id: agent-default-model\\n(?:[^\\n]*\\n)*?\\s+provider:\\s*${route.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(collapsed)) {
    return { text: collapsed, error: `the remaining agent-default-model row does not name the harness route "${route.id}"` }
  }
  if (!new RegExp(`^\\s{6}${route.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`, 'm').test(collapsed)) {
    return { text: collapsed, error: `provider "${route.id}" has no block in the booted profile — the default row could never authenticate` }
  }
  return { text: collapsed, error: null }
}
