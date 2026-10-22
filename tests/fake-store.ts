/**
 * Give a hand-rolled registry double the ONE verb production now requires.
 *
 * #59 made every registry mutation go through `RegistryStore.mutate(sessionId, fn)` — a serialized
 * section over a fresh read — because whole-row `get → hold across an await → put` silently erased
 * other doors' committed state (measured in the SAIP field data). Test doubles written against the
 * older two-verb shape have no `mutate`, so they fail at the call site, which is exactly the point:
 * the interface grew and the doubles must grow with it.
 *
 * This helper implements the semantics production relies on (read, apply, write back) without a
 * queue, so a double stays a double. Do NOT use it to paper over a production object that forgot to
 * serialize — `src/store.ts` is the real implementation and its own rows cover the section.
 */
export function withMutate<S extends {
  get(id: string): Promise<any>
  put(id: string, state: any): Promise<unknown> | void
}>(store: S): S & { mutate(id: string, fn: (state: any) => any): Promise<any> } {
  return {
    ...store,
    async mutate(id: string, fn: (state: any) => any): Promise<any> {
      const before = await store.get(id)
      const next = await fn(structuredClone(before))
      if (next === undefined) return before
      await store.put(id, next)
      return next
    },
  } as S & { mutate(id: string, fn: (state: any) => any): Promise<any> }
}
