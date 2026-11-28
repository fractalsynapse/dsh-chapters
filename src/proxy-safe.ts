/**
 * #545: proxy-safe service binding.
 *
 * The host calls cordis SERVICES through interface proxies — measured stack on the maintainer's
 * machine and reproduced in the rig: `command-compact → cordis Object.apply → Proxy.compactNow`,
 * where the engine's ES private access (`this.#observeRoute`) throws
 * `TypeError: Receiver must be an instance of class ChaptersCompactionEngine` even though
 * `instanceof` answers true. ES private brands demand the ACTUAL instance; a proxy receiver,
 * however faithful, is not it. The host's own compaction engine survives the same call because
 * it uses zero ES privates (grep-verified: no brands, no WeakSet lowering) — the architecture's
 * rule is therefore: anything serving a host interface must keep private access on the real
 * receiver. Binding every public prototype method to the instance at construction does exactly
 * that: the proxy's get finds an OWN bound function, and `this` inside is the instance the
 * brands were minted for.
 *
 * One helper, one decision (#59): any plugin class that serves a host interface calls this in
 * its constructor. Today that is ChaptersCompactionEngine; tomorrow's service class has the
 * same trap already solved.
 */
import { Service } from '@deepseek-ai/cordis'

export function bindPublicMethods(instance: object): void {
  let proto: object | null = Object.getPrototypeOf(instance)
  while (proto !== null && proto !== Service.prototype && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue
      const desc = Object.getOwnPropertyDescriptor(proto, key)
      if (desc === undefined) continue
      // FIRST-WRITER WINS: the walk starts at the most-derived prototype, and a later base
      // class must NOT overwrite the wrapper already installed for an override (measured:
      // re-installing from BasicCompactionEngine.prototype shadowed our compactIfNeeded
      // override and the base's pressure check threw with the very headroom default #140
      // exists to zero). Own already means bound — skip.
      if (Object.prototype.hasOwnProperty.call(instance, key)) continue
      if (typeof desc.value === 'function') {
        // LATE-DISPATCH wrapper, not a captured bind: the call resolves the CURRENT prototype
        // method at call time and applies it to the real instance. A captured bind would shadow
        // prototype stubs installed after construction (measured: 22 engine-test doubles went
        // silently inert) — late dispatch keeps both the brands and the test seams alive.
        const owner = proto
        ;(instance as Record<string, unknown>)[key] = function (this: unknown, ...args: unknown[]): unknown {
          // resolve on the PROTOTYPE owner at call time — never via the instance, whose own
          // wrapper would self-recurse.
          const current: unknown = Object.getOwnPropertyDescriptor(owner, key)?.value
          if (typeof current === 'function') return Reflect.apply(current as (this: unknown, ...a: unknown[]) => unknown, instance, args)
          return undefined
        }
      } else if (desc.get !== undefined || desc.set !== undefined) {
        // Accessors run with the RECEIVER as `this` — a getter that touches a private brand
        // would throw the same way. Re-define them own, bound to the real instance.
        const bound: PropertyDescriptor & { get?: () => unknown; set?: (v: unknown) => void } = {
          enumerable: desc.enumerable === true,
          configurable: true,
        }
        if (desc.get !== undefined) bound.get = desc.get.bind(instance)
        if (desc.set !== undefined) bound.set = desc.set.bind(instance)
        Object.defineProperty(instance, key, bound)
      }
    }
    proto = Object.getPrototypeOf(proto)
  }
}
