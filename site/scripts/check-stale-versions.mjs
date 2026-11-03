/**
 * Stale-version guard — run by `npm run build` before Astro builds the site.
 *
 * Why this exists: an install instruction with a version typed into it is a
 * sentence that goes wrong the moment a release ships, and it actively tells a
 * reader to install an outdated plugin. The site's rule is therefore:
 *
 *   instructions a human runs  → `@latest` (cannot go stale)
 *   naming the current release → interpolated at build time from the repo's own
 *                                package.json (`src/data/plugin-version.mjs`)
 *   the changelog (§26)        → literal versions, forever: it is the record
 *
 * So a pinned `@fractalsynapse/dsh-chapters@1.2.3` or a "latest is 1.2.3" anywhere
 * outside the changelog is a defect, and the build says so with the file and
 * line rather than shipping the lie. Patterns are narrow on purpose: a historical
 * attribution ("since 0.1.4 …") in a concepts or evidence page is a true record
 * of when something shipped, not an instruction, and stays legal.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const HERE = new URL('.', import.meta.url).pathname
const DOCS = join(HERE, '..', 'src', 'content', 'docs')
/** The record pages: version literals are the point of them. */
const EXEMPT = [join(DOCS, 'operations', 'changelog.md')]

const RULES = [
  { re: /@(?:fractalsynapse|treeseed)\/dsh-chapters@\d/, why: 'a pinned install/update instruction — say `@latest`, or interpolate the build-time version' },
  { re: /\b(?:latest|current) (?:release|version) is [v\d]/i, why: 'a hand-typed "latest is X" claim — it goes stale on the next ship' },
]

/** @returns {string[]} human-readable violations */
function scan(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) { scan(abs, out); continue }
    if (!/\.mdx?$/.test(entry) || EXEMPT.includes(abs)) continue
    const lines = readFileSync(abs, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.re.test(line)) out.push(`${relative(join(HERE, '..'), abs)}:${i + 1}: ${rule.re} — ${rule.why}\n    ${line.trim().slice(0, 140)}`)
      }
    })
  }
  return out
}

const violations = scan(DOCS)
if (violations.length > 0) {
  console.error(`\n[dsh-versions] ${violations.length} hand-typed version(s) in instructional pages:\n\n${violations.join('\n')}\n`)
  process.exit(1)
}
