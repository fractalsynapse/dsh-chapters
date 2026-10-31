/**
 * The host's Tooltip seat, resolved OPTIONALLY (#194-compat — measured on 0.2.1-rc.5, not guessed):
 *
 * `@deepseek-ai/dsh-client-ui-primitives` exists in the 0.2.0-rc.2 host tree and is ABSENT from the
 * entire 0.2.1-rc.5 install tree — no successor package exports `Tooltip`. Our bundle's static
 * import becomes a LAZY require in the built CJS: the bundle loads and components run, but the
 * first render that touches `Tooltip` throws, and React's error boundary swallows the subtree
 * silently. Measured symptoms on 0.2.1: door registration fully healthy (inject returned a
 * disposer; the factory ran; both register effects are functions) yet the assistant-actions region
 * renders ZERO entries, and the dock renders no row — because both wrap their buttons in Tooltip.
 *
 * The fix keeps one resolution point and one fallback (#59 — never per-component try/catch):
 * probe the module once; when it is absent, buttons carry the platform's own `title` tooltip, so
 * hover text survives on every host and the fancy tooltip survives where it exists.
 */
import { createElement as h, type ComponentType, type ReactElement } from 'react'

declare const require: ((id: string) => Record<string, unknown>) | undefined

export type TooltipLike = ComponentType<{ label: string; side?: string; portal?: boolean; delayMs?: number; children: ReactElement<Record<string, unknown>> }>

/**
 * The tooltip recipe, field for field the goal bar's own (GoalBar.tsx:101-142: `portal`,
 * `side="bottom"`, `delayMs={500}`) — the shipped occupant of the same dock strip, whose tooltips
 * are NOT covered by the composer. `portal` is the load-bearing one: it renders the popup at
 * document level instead of inside our dock's stacking context, which is exactly the maintainer's
 * report (#210: "the hoverover tooltips are covered by the main chat input container"). Our old
 * compile-time types rejected portal/delayMs at the overload; the runtime host always accepted
 * them, and since the seat is typed by us, the recipe is pinned by a row instead of by luck.
 */
export function tooltipPropsFor(label: string): { label: string; side: 'bottom'; portal: true; delayMs: 500 } {
  return { label, side: 'bottom', portal: true, delayMs: 500 }
}

let resolved: TooltipLike | null | undefined // undefined = not probed yet

export function resolveTooltip(): TooltipLike | null {
  if (resolved !== undefined) return resolved
  resolved = null
  try {
    if (typeof require === 'function') {
      const mod = require('@deepseek-ai/dsh-client-ui-primitives') as { Tooltip?: unknown } | undefined
      const T = mod?.Tooltip
      if (typeof T === 'function' || typeof T === 'object') resolved = T as TooltipLike
    }
  } catch {
    resolved = null // absent host: the native-title fallback stands
  }
  return resolved
}

/** Wrap in the host Tooltip when it exists; otherwise return the child (which must carry `title`). */
export function withTooltip(label: string, child: ReactElement<Record<string, unknown>>): ReactElement {
  const T = resolveTooltip()
  return T !== null ? h(T, { ...tooltipPropsFor(label), children: child }) : child
}

/** The native-tooltip attribute, present ONLY when the host seat is absent — no double tooltips. */
export function nativeTitle(label: string): { title: string } | Record<string, never> {
  return resolveTooltip() === null ? { title: label } : {}
}
