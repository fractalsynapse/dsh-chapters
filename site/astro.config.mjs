// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const SITE = 'https://treeseed-ai.github.io/dsh-chapters/';
const BASE = new URL(SITE).pathname; // '/dsh-chapters/' — one source for base + link rewriting

// Cookie-first theme sync: reads dsh-theme before paint, seeds Starlight's
// localStorage key from it, and mirrors localStorage back into the cookie for
// first-time visitors — the selection persists across reloads, tabs, and even
// a cleared localStorage.
const themeSyncScript = `(function () {
  var m = document.cookie.match(/(?:^|;\\s*)dsh-theme=([^;]+)/);
  var cookieTheme = m ? decodeURIComponent(m[1]) : null;
  try {
    if (cookieTheme === 'light' || cookieTheme === 'dark') {
      if (localStorage.getItem('starlight-theme') !== cookieTheme) {
        localStorage.setItem('starlight-theme', cookieTheme);
      }
      document.documentElement.dataset.theme = cookieTheme;
    } else {
      var stored = localStorage.getItem('starlight-theme');
      if (stored === 'light' || stored === 'dark') {
        document.cookie = 'dsh-theme=' + stored + '; path=/; max-age=31536000; SameSite=Lax';
      }
    }
  } catch (e) { /* private mode etc. — cookie path still stands alone */ }
})();`;


/** Rewrites internal markdown links (/foo) to carry the deploy base (/dsh-chapters/foo).
 * Starlight prefixes its own chrome; raw content links otherwise escape to the host root. */
function internalLinks() {
  const base = BASE;
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.type === 'link' && typeof child.url === 'string' && child.url.startsWith('/') && !child.url.startsWith('//')) {
        child.url = base + child.url.slice(1);
      }
      walk(child);
    }
  };
  return (tree) => walk(tree);
}


/** Belt-and-braces for the Pages subpath: after the static build, any anchor still pointing at a
 * root-level docs route gets the deploy base. Idempotent by construction (already-prefixed hrefs
 * don't match). */
function baseHrefFix() {
  const slugs = ['start', 'concepts', 'knowledge', 'reference', 'evidence', 'operations'];
  return {
    name: 'dsh-base-href-fix',
    hooks: {
    'astro:build:done': async ({ dir }) => {
      const { readdirSync, statSync, readFileSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const walk = (d) => readdirSync(d).flatMap((e) => {
        const p = join(d, e);
        return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.html') ? [p] : []);
      });
      const re = new RegExp(`href="/(?!${BASE.slice(1)})(${slugs.join('|')})/`, 'g');
      let touched = 0;
      for (const f of walk(dir.pathname ?? dir)) {
        const raw = readFileSync(f, 'utf8');
        const fixed = raw.replace(re, 'href="/dsh-chapters/$1/');
        if (fixed !== raw) { writeFileSync(f, fixed); touched++; }
      }
      if (process.env.DSH_BUILD_VERBOSE) console.log(`[dsh-base-href-fix] rewrote links in ${touched} pages`);
    },
    },
  };
}

export default defineConfig({
  site: SITE,
  base: BASE,
  integrations: [
    baseHrefFix(),
    starlight({
      title: 'dsh-chapters',
      description:
        'Long memory for local coding agents: verbatim archives, zero-token compaction, and cross-session knowledge pools — no API key, no vector DB, no cloud.',
      head: [
        { tag: 'script', content: themeSyncScript },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        { tag: 'link', attrs: { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap' } },
      ],
      favicon: '/favicon.svg',
      lastUpdated: true,
      editLink: { pattern: 'https://github.com/treeseed-ai/dsh-chapters/edit/main/site/$filepath' },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/treeseed-ai/dsh-chapters' },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/@treeseed/dsh-chapters' },
      ],
      sidebar: [
        { label: 'Part I · First Contact', items: [
          { label: '1. Quickstart', slug: 'start/quickstart' },
          { label: '2. Your first continuation', slug: 'start/first-continuation' },
          { label: '3. Link a knowledge pool', slug: 'start/link-pool' },
          { label: '4. FAQ & troubleshooting', slug: 'start/faq' },
        ]},
        { label: 'Part II · Concepts & Theory', items: [
          { label: '5. Why not summaries?', slug: 'concepts/why-not-summaries' },
          { label: '6. The four invariants', slug: 'concepts/invariants' },
          { label: '7. Continuation budget math', slug: 'concepts/budget' },
          { label: '8. Recursive context theory', slug: 'concepts/recursive-context' },
          { label: '9. Anatomy of the archive', slug: 'concepts/archive-anatomy' },
          { label: '28. Prompt recommendations', slug: 'concepts/prompt-recommendations' },
        ]},
        { label: 'Part III · The Knowledge Layer', items: [
          { label: '10. The pool', slug: 'knowledge/pool' },
          { label: '11. Providers: git vs TreeDX', slug: 'knowledge/providers' },
          { label: '12. Search', slug: 'knowledge/search' },
          { label: '13. Rules & governance', slug: 'knowledge/rules' },
          { label: '14. Enrichment ladder', slug: 'knowledge/enrichment' },
        ]},
        { label: 'Part IV · Reference', items: [
          { label: '15. Commands', slug: 'reference/commands' },
          { label: '16. Agent tools', slug: 'reference/tools' },
          { label: '17. Configuration', slug: 'reference/configuration' },
          { label: '18. The continuation notice, annotated', slug: 'reference/notice' },
        ]},
        { label: 'Part V · Evidence & Measurement', items: [
          { label: '19. Benchmarks', slug: 'evidence/benchmarks' },
          { label: '20. Field study: the TreeSeed run', slug: 'evidence/field-study' },
          { label: '21. Cache behavior on llama.cpp', slug: 'evidence/llamacpp-cache' },
          { label: '22. The alternatives, compared', slug: 'evidence/comparison' },
        ]},
        { label: 'Part VI · Operate & Extend', items: [
          { label: '23. Install, upgrade, provenance', slug: 'operations/install' },
          { label: '24. Developing the plugin', slug: 'operations/development' },
          { label: '25. Internals map', slug: 'operations/internals' },
          { label: '26. Changelog & release notes', slug: 'operations/changelog' },
          { label: '27. Security & privacy', slug: 'operations/security' },
        ]},
      ],
      components: {
        // Cookie-persisting replacement for the localStorage-only picker.
        ThemeSelect: './src/components/ThemeToggle.astro',
      },
      customCss: ['./src/styles/theme.css'],
      markdown: { remarkPlugins: [internalLinks] },
    }),
  ],
});
