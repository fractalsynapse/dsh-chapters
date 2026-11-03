/**
 * The ONE build-time source of the plugin's version. Plain `.mjs` so both the
 * Astro config (a remark plugin needs it synchronously at config time) and the
 * TS data module can import it without a second copy of the logic.
 *
 * Why not the npm registry: a docs build that reaches the network can only ever
 * print a number that is true for the second it ran, and an offline build must
 * not hard-fail. The repo's own `package.json` is authoritative at every release
 * commit — `release.yml` refuses to publish unless the tag equals it — so the
 * version this site documents is the version that shipped. Anything a human is
 * told to RUN says `@latest` and needs no number at all.
 *
 * The search is deliberate: `import.meta.url` inside the bundler is NOT a stable
 * anchor (a naive `../../../package.json` silently lands on `site/package.json`,
 * version `0.0.1`), so every candidate is validated by its own package `name`
 * before it is trusted. Nothing is hardcoded and nothing is guessed.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_NAME = '@fractalsynapse/dsh-chapters'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Root-most candidates first: site/src/data → site/src → site → repo root. */
const CANDIDATES = [
  join(HERE, '..', '..', '..', 'package.json'),
  join(HERE, '..', '..', 'package.json'),
  join(HERE, '..', '..', '..', '..', 'package.json'),
  resolve(process.cwd(), '..', 'package.json'),
  resolve(process.cwd(), 'package.json'),
]

/**
 * Read + validate: the file must BE the plugin's manifest, not merely a manifest.
 * @returns {{ name: string, version: string, source: 'repo-package-json' | 'unknown', path: string }}
 */
export function readPluginVersion() {
  for (const path of CANDIDATES) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (parsed?.name === PLUGIN_NAME && typeof parsed.version === 'string' && parsed.version.length > 0) {
      return { name: PLUGIN_NAME, version: parsed.version, source: 'repo-package-json', path }
    }
  }
  return { name: PLUGIN_NAME, version: 'unversioned', source: 'unknown', path: '' }
}
