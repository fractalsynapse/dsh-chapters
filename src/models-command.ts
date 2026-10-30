/**
 * #173 — the /chapters-models pure core: discovery for the three model settings.
 *
 * The three keys (`enrichment.model`, `rules.model`, the prompt model) all take a `provider/model`
 * route, and before this command nothing in the product told a human which identifiers this host
 * accepts — a wrong guess failed at call time as a routing error. This mirrors the host's own
 * sanctioned discovery tool (`list_subagent_models` in
 * examples/dsh/packages/subagent/tool-subagent/src/list-models.ts): `listProviders()` is SYNC,
 * `listModels(provider)` is the ADVISORY catalog, and `resolveModelInfo(provider, model)` is the
 * exact-route drill-down that adds what only the adapter knows (context window, reasoning efforts).
 *
 * Two honesty rules the rendering never drops: catalog membership is advisory — the host routes
 * unlisted ids, so an empty catalog means "no selection offered", never "nothing works" — and a
 * capability the adapter does not advertise is REPORTED ABSENT, not guessed. Like every
 * /chapters-* command this is deterministic text: it never enters the model's context.
 * Pure core; the thin registration lives in commands.ts and the wiring in index.ts.
 */

export interface ModelsProviderInfo { readonly id: string; readonly name: string }

/** Host-shaped `LlmModelInfo` (examples/dsh/packages/llm/llm/src/types.ts:348). */
export interface ModelsModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
}

/** Host-shaped `LlmResolvedModelInfo` — the fields this command consumes, no more. */
export interface ModelsResolvedInfo extends ModelsModelInfo {
  readonly context?: { readonly contextWindow?: number } | undefined
  readonly reasoning?: {
    readonly efforts?: readonly { readonly id: string; readonly name: string; readonly description?: string }[] | undefined
    readonly defaultEffort?: string | undefined
  } | undefined
}

/** The `llm` service surface this command rides — stub it in the HOST's shape, never an easier one. */
export interface ModelsLlm {
  listProviders(): readonly ModelsProviderInfo[]
  listModels(provider: string): Promise<readonly ModelsModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<ModelsResolvedInfo>
}

/** Where the value the human sees right now came from — rendered, because "set" and "fell back" differ. */
export type CurrentSource = 'settings' | 'config' | 'conversation-route' | 'rides-enrichment' | 'off'

export interface ModelsIo {
  /** Absent on planes without the host llm service — the command refuses cleanly, never crashes. */
  llm?: ModelsLlm | undefined
  /** The three settings' effective values, pre-resolved by the wiring (config → settings → fallback). */
  current: {
    enrichment: { value: string; source: CurrentSource }
    rules: { value: string; source: CurrentSource }
    prompt: { value: string; source: CurrentSource }
  }
}

export interface ModelsReply { kind: 'success' | 'error'; text: string }

const USAGE = 'usage: /chapters-models [<provider> [<model>]] — a paste-ready provider/model id works as one arg'

const ADVISORY = 'catalog membership is advisory: the host routes unlisted model ids too, and an empty catalog means no selection is offered — not that nothing works.'

function currentFooter(current: ModelsIo['current']): string {
  const line = (label: string, v: { value: string; source: CurrentSource }, unset: string, setter: string): string =>
    `  ${label.padEnd(16)} ${v.value !== '' ? `${v.value} (from ${v.source})` : unset}\n  ${''.padEnd(16)} set with: ${setter}`
  return 'current model settings:\n'
    + line('enrichment.model', current.enrichment, '(unset — rides the conversation route)', '/chapters-enrich model <provider/model> | clear') + '\n'
    + line('rules.model', current.rules, '(unset — mining rides the enrichment call)', '/chapters-rule model <provider/model> | clear') + '\n'
    + line('prompt model', current.prompt, 'OFF — setting a model IS the enable (§28)', '/chapters-prompt model <provider/model> | off')
}

function modelLine(provider: string, m: ModelsModelInfo): string {
  return `  ${provider}/${m.id} — ${m.name}${m.description === undefined || m.description === '' ? '' : `: ${m.description}`}`
}

export async function modelsCommand(io: ModelsIo, args: string, signal?: AbortSignal): Promise<ModelsReply> {
  const llm = io.llm
  if (llm === undefined) {
    return { kind: 'error', text: `the llm service is unavailable on this plane — cannot enumerate models.\n${currentFooter(io.current)}` }
  }
  const parts = args.trim().split(/\s+/).filter((p) => p.length > 0)
  // One arg carrying a slash is a paste-ready id — this command's own output format.
  let provider: string | undefined
  let model: string | undefined
  if (parts.length === 1 && parts[0]!.includes('/')) {
    const i = parts[0]!.indexOf('/')
    provider = parts[0]!.slice(0, i)
    model = parts[0]!.slice(i + 1)
  } else if (parts.length === 1) {
    provider = parts[0]
  } else if (parts.length === 2) {
    provider = parts[0]; model = parts[1]
  } else if (parts.length > 2) {
    return { kind: 'error', text: USAGE }
  }
  const providers = llm.listProviders()
  if (provider === undefined) {
    const sections: string[] = []
    for (const p of providers) {
      const models = await llm.listModels(p.id)
      sections.push(`provider ${p.id} — ${p.name}\n`
        + (models.length === 0
          ? `  (no advertised models for ${p.id} — ${ADVISORY})`
          : models.map((m) => modelLine(p.id, m)).join('\n')))
    }
    const body = providers.length === 0
      ? `(no LLM providers are registered on this host — ${ADVISORY})`
      : sections.join('\n\n')
    return { kind: 'success', text: `${body}\n\n${ADVISORY}\n\n${currentFooter(io.current)}` }
  }
  if (provider.length === 0 || (model !== undefined && model.length === 0)) {
    return { kind: 'error', text: USAGE }
  }
  const known = providers.find((p) => p.id === provider)
  if (known === undefined) {
    const available = providers.map((p) => p.id).join(', ') || '(none)'
    return { kind: 'error', text: `LLM provider "${provider}" is not registered; available providers: ${available}` }
  }
  if (model === undefined) {
    const models = await llm.listModels(known.id)
    const body = models.length === 0
      ? `(no advertised models for ${known.id} — ${ADVISORY})`
      : `provider ${known.id} — ${known.name}\n${models.map((m) => modelLine(known.id, m)).join('\n')}\n\n${ADVISORY}`
    return { kind: 'success', text: `${body}\n\n${currentFooter(io.current)}` }
  }
  try {
    const info = await llm.resolveModelInfo(known.id, model, signal)
    const efforts = info.reasoning?.efforts ?? []
    const lines = [
      `${known.id}/${info.id} — ${info.name}${info.description === undefined || info.description === '' ? '' : `: ${info.description}`}`,
      `context window: ${info.context?.contextWindow !== undefined ? `${String(info.context.contextWindow)} tokens` : 'not advertised by this adapter'}`,
      efforts.length === 0
        ? 'reasoning efforts: (no advertised reasoning efforts)'
        : `reasoning efforts:\n${efforts.map((e) => `  ${e.id}${info.reasoning?.defaultEffort === e.id ? ' (default)' : ''} — ${e.name}${e.description === undefined || e.description === '' ? '' : `: ${e.description}`}`).join('\n')}`,
    ]
    return { kind: 'success', text: `${lines.join('\n')}\n\n${currentFooter(io.current)}` }
  } catch (error) {
    return { kind: 'error', text: `resolveModelInfo(${known.id}, ${model}) failed: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
  }
}
