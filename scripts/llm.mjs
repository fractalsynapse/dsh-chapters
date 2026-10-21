#!/usr/bin/env node
/**
 * One resolver for "which model can this repo talk to right now", shared by every
 * dev/verification script. Local first, hosted fallback, no work per run.
 *
 *   local  http://localhost:8080/v1            the dev stress regime (32K/15K),
 *                                              `local` provider in dev/settings.yaml
 *   hosted https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
 *                                              the SAME provider that powers live
 *                                              sessions (`qwen-token-plan`)
 *
 * Why hosted is a legitimate fallback and not a cheat: the plugin itself already
 * resolves its enrichment/mining route to the conversation's model
 * (`enrich-wire.resolveRoute` → `conversationRoute()`), so measuring against
 * `qwen3.8-flash` measures the model the feature will actually run on. What the
 * local server still owns is the STRESS REGIME — a 32K window is a different
 * product fact than a 1M one, and the tape chain is distilled at the small window
 * on purpose. So: prefer local when it answers, fall back when it does not, and
 * never let a fallback silently impersonate the stress regime (the probe result
 * says which one it used, and scripts refuse the regime-dependent jobs without it
 * — see `requireLocal`).
 *
 * Credential, in resolution order (never printed, never committed):
 *   1. $DSH_LLM_API_KEY
 *   2. $QWEN_TOKEN_PLAN_API_KEY   (the profile's apiKeyEnv)
 *   3. $LOCAL_API_KEY              (the dev profile's local-provider apiKeyEnv)
 *   4. ~/.dsh/secrets/qwen-token-plan.key, or $LLM_KEY_FILE
 * The dev box's harness has the key in ITS process environment, which is not
 * visible to a sandboxed tool shell — option 4 exists so it is placed once, by the
 * owner, in a 0600 file, and every later run needs nothing.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LOCAL_BASE = process.env.LOCAL_LLM_BASE ?? 'http://localhost:8080/v1'
/*
 * Hosted candidates, tried IN ORDER and probed, because guessing wrong here costs
 * a confusing 401 at call time:
 *
 *   1. $DSH_LLM_BASE, if the operator says so explicitly.
 *   2. https://maas.qwencloudapi.com/compatible-mode/v1 — the canonical base URL,
 *      the one fed to the OpenAI client constructor by the harness provider config.
 *      Treat this as the answer when it authenticates.
 *   3. https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1 —
 *      the regional origin behind the same plan. Measured 2026-10-21 with one
 *      reset key: the canonical alias answered `401 Invalid API-key provided`
 *      while the regional origin answered `200`, for `qwen3.8-flash`. Same model,
 *      same completions, different front door — so the fallback is not a different
 *      service to measure against, it is the same service one hop earlier.
 *
 * A 404 is NOT a rejection: some hosts don't implement /models. `unknown` ranks
 * below any authenticated host but still beats nothing, so the real error surfaces
 * where it can be read.
 */
export const HOSTED_CANDIDATES = [
  process.env.DSH_LLM_BASE,
  'https://maas.qwencloudapi.com/compatible-mode/v1',
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
].filter((x) => x !== undefined && x !== '')
export const HOSTED_BASE = HOSTED_CANDIDATES[0]
export const HOSTED_MODEL = process.env.DSH_LLM_MODEL ?? 'qwen3.8-flash'
export const LOCAL_MODEL = process.env.LOCAL_LLM_MODEL ?? 'qwen3.8-flash-next'
const KEY_FILE = process.env.LLM_KEY_FILE ?? path.join(os.homedir(), '.dsh', 'secrets', 'qwen-token-plan.key')
const PROFILE_ENV_FILES = ['.bashrc', '.bash_profile', '.profile', '.zshenv']

/**
 * The key, or null — never logged, never embedded in an error message.
 *
 * Resolution order, cheapest and most explicit first. A tool shell is NOT a login
 * shell, so the `export` the harness's own environment carries (and that the
 * profile's `apiKeyEnv` reads) is simply absent here; the last two sources are
 * how a sandboxed run still finds the credential the user pointed it at, without
 * anyone pasting a secret into a chat or a committed file.
 */
export function apiKey() {
  if (process.env.DSH_LLM_API_KEY) return process.env.DSH_LLM_API_KEY
  if (process.env.QWEN_TOKEN_PLAN_API_KEY) return process.env.QWEN_TOKEN_PLAN_API_KEY
  if (process.env.LOCAL_API_KEY) return process.env.LOCAL_API_KEY
  const fromFile = tryRead(KEY_FILE)
  if (fromFile !== null) return fromFile
  for (const f of PROFILE_ENV_FILES) {
    const text = tryRead(path.join(os.homedir(), f))
    if (text === null) continue
    const m = /QWEN_TOKEN_PLAN_API_KEY\s*=\s*["']?([^\s"']+)/.exec(text)
    if (m !== null && m[1].length > 20) return m[1]
  }
  const creds = tryRead(path.join(os.homedir(), '.dsh', '.credentials.yaml'))
  if (creds !== null) {
    const m = /^\s*QWEN_TOKEN_PLAN_API_KEY:\s*(\S+)\s*$/m.exec(creds)
    if (m !== null && m[1].length > 20) return m[1]
  }
  return null
}

function tryRead(p) {
  try { return fs.readFileSync(p, 'utf8') || null } catch { return null }
}

/** Where the key came from, for the report — a PATH, never a value. */
export function apiKeySource() {
  if (process.env.DSH_LLM_API_KEY) return 'env:DSH_LLM_API_KEY'
  if (process.env.QWEN_TOKEN_PLAN_API_KEY) return 'env:QWEN_TOKEN_PLAN_API_KEY'
  if (tryRead(KEY_FILE) !== null) return `file:${KEY_FILE}`
  for (const f of PROFILE_ENV_FILES) {
    const text = tryRead(path.join(os.homedir(), f))
    if (text !== null && /QWEN_TOKEN_PLAN_API_KEY\s*=/.test(text)) return `file:~/${f}`
  }
  if (/QWEN_TOKEN_PLAN_API_KEY:/.test(tryRead(path.join(os.homedir(), '.dsh', '.credentials.yaml')) ?? '')) return 'file:~/.dsh/.credentials.yaml (refs)'
  return 'none'
}

async function reachable(base, ms = 1500) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    await fetch(`${base}/models`, { signal: ctrl.signal })
    return true // ANY HTTP answer means something is serving there, 401 included
  } catch {
    return false
  } finally { clearTimeout(t) }
}

/** Where we will actually talk, and why. */
export async function resolve({ prefer = 'local' } = {}) {
  const key = apiKey()
  const localUp = await reachable(LOCAL_BASE)
  if (prefer === 'local' && localUp) {
    return { base: LOCAL_BASE, model: LOCAL_MODEL, regime: 'local-stress', local: true }
  }
  const probed = await probeHosted(key)
  return {
    base: probed.base, model: HOSTED_MODEL, regime: 'hosted-session-model', local: false,
    probed: probed.probed,
    ...(localUp ? {} : { note: 'local server (:8080) is not answering — hosted fallback in use' }),
    ...(probed.note !== undefined ? { note: probed.note } : {}),
  }
}

/** Which hosted front door actually takes this credential. Cached per process. */
let hostedCache = null
async function probeHosted(key) {
  if (hostedCache !== null) return hostedCache
  const probed = []
  let fallback = null
  for (const base of HOSTED_CANDIDATES) {
    const label = base.replace('https://', '').split('/')[0]
    if (key === null) { probed.push(`${label}: no credential`); fallback ??= base; continue }
    try {
      const res = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000),
      })
      if (res.status === 401 || res.status === 403) { probed.push(`${label}: rejected`); fallback ??= base; continue }
      probed.push(res.ok ? `${label}: accepted` : `${label}: ${res.status} (route unknown)`)
      // a 2xx proves the credential; a 404 proves nothing but reachability, so it
      // is a fallback rather than a win
      if (res.ok) { hostedCache = { base, probed }; return hostedCache }
      fallback ??= base
    } catch (error) {
      probed.push(`${label}: unreachable (${String(error?.message ?? error).slice(0, 40)})`)
    }
  }
  const chosen = fallback ?? HOSTED_CANDIDATES[0]
  hostedCache = {
    base: chosen, probed,
    note: 'no hosted candidate authenticated on /models — using ' + chosen.replace('https://', '') +
      '; a 401 at call time means the credential is not valid for the hosts probed (' + probed.join(', ') + ')',
  }
  return hostedCache
}

/** One chat completion; returns text. Throws a readable error, key never included. */
export async function callChat(prompt, opts = {}) {
  const target = opts.target ?? await resolve({ prefer: opts.prefer ?? 'local' })
  const key = apiKey()
  if (key === null) {
    throw new Error(
      `no model credential in reach (probed: env vars, ${KEY_FILE}, ~/.bashrc-style profile exports, ` +
      '~/.dsh/.credentials.yaml). Place it once with umask 077 into ' + KEY_FILE +
      ', or export DSH_LLM_API_KEY. Values are never printed by this tooling.',
    )
  }
  const res = await fetch(`${target.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: opts.model ?? target.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: opts.maxTokens ?? 700,
      temperature: opts.temperature ?? 0,
    }),
  })
  const body = await res.text()
  if (!res.ok) {
    // 401/403 means the credential is absent or wrong for THIS endpoint; the
    // hosted provider also rejects a local-regime model id, so say which pair ran.
    throw new Error(`chat/completions ${res.status} on ${target.base} model ${target.model}: ${body.slice(0, 300)}`)
  }
  let json
  try { json = JSON.parse(body) } catch { throw new Error(`chat/completions returned non-JSON on ${target.base}: ${body.slice(0, 200)}`) }
  const text = json?.choices?.[0]?.message?.content ?? ''
  return { text, usage: json?.usage ?? null, target }
}

/** Guard for jobs that MUST run at the small window (compaction thresholds, tapes). */
export function requireLocal(target) {
  if (!target.local) throw new Error(`${target.regime}: this job measures the 32K stress regime and needs the local server (:8080) up — refusing to fake it against the hosted model`)
}
