/**
 * The chapters preset id — ONE source, client-safe.
 *
 * The literal 'chapters' had durable meaning in three places (the server's preset declaration, the
 * seventh archive moment's header gate, and the client's door visibility predicate per #372), and
 * #353 already caught a second literal copy drifting outside its predicate. `src/preset.ts` is the
 * declaration's home but imports cordis — the client bundle cannot load it — so the id lives HERE,
 * with zero imports, and preset.ts re-exports it so every existing server importer is unchanged.
 *
 * @module dsh-chapters/src/preset-id
 */
export const CHAPTERS_PRESET_ID = 'chapters'
