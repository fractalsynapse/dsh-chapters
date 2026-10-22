/**
 * The plugin's own version, stamped into chapter provenance (#61).
 *
 * This audit had to *infer* which build wrote which registry row from file mtimes, because `generated:`
 * recorded a model name and a timestamp and nothing else. Attribution is a fact the writer knows and the
 * reader cannot recover later, so it belongs in the bytes. A row in tests asserts this literal equals
 * `package.json`'s version — the one place a hand-mirrored constant must never be allowed to drift.
 */
export const PLUGIN_VERSION = '0.1.24'
