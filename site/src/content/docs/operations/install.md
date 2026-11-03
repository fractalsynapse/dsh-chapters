---
title: "23. Install, upgrade, provenance"
description: Every install path, how versions move, and why you can verify what you installed.
lastUpdated: true
---

## Requirements

DeepSeek Harness (`@deepseek-ai/dsh`) ≥ 0.1.5-rc.x, Node ≥ 24. The plugin ships as one npm package: [`@fractalsynapse/dsh-chapters`](https://www.npmjs.com/package/@fractalsynapse/dsh-chapters).

## Install / update — the path this project uses

A harness profile is a plain npm directory: `package.json` (carrying the `dsh.profile.bundles` list) plus
its own `node_modules`, under `<DSH home>/profiles/<profile>/`. So installing or bumping the plugin is an
`npm` call *in that directory*, then a restart — bundles load at boot and nothing hot-swaps:

```bash
cd ~/.dsh/profiles/web
npm i @fractalsynapse/dsh-chapters@latest     # install, or bump to whatever npm calls latest
npm ls @fractalsynapse/dsh-chapters           # what is actually in this profile
# restart dsh web — the running process holds the old bundle until then
```

`@latest` rather than a pinned number, on purpose: an install instruction with a version typed into it is
a sentence that silently becomes wrong the moment a release ships. Pin deliberately only when you are
reproducing someone else's profile.

If the profile has never carried this plugin, `npm i` puts it on disk but the profile must also *name* it:
its `package.json` lists the bundles to load under `dsh.profile.bundles`, and `@fractalsynapse/dsh-chapters` has
to appear there. That is exactly what this repo's own `scripts/bootstrap-dev-profile.sh` writes for a dev
profile (same mechanism, with a `file:` dependency pointed at the working tree instead of a published
version).

## The host's own plugin commands

`dsh plugin` exists and is the host's surface for this job:

```bash
dsh plugin --profile web add @fractalsynapse/dsh-chapters     # host forwards the arguments to its own installer
dsh plugin --profile web list                           # enabled state for that profile
dsh plugin --profile web remove @fractalsynapse/dsh-chapters
```

**Honest note, stated as what works rather than as a defect report:** in this project's own use, the npm
path above is the one that has installed and updated the plugin successfully; the `dsh plugin add` path has
never been observed working here, and this repo does not rely on it. That is a report of what we use. The
host's plugin command forwards its arguments to a package manager that is not npm (`bin.js:105` of the
installed host, and this repo is npm-only and never a monorepo — see the repo's `docs/development.md`),
which is the extent of what we have established: **we have not reproduced the failure, have no diagnosis
for it, and are not claiming this page fixes anything.** If it works for you, it works for you — the end
state is the same directory `npm ls` reads.

## Restart and check

Restart the harness. Expect on boot: engine-constructed lines in the server log, the six `chapters_*`
tools, the six `/chapters-*` commands, **both** archive buttons on assistant rows (*Fork with chapters* and
*Continue with chapters* — one deterministic door, two intents), and the optional `chapters` preset that
routes `/compact` through the zero-token engine.

### The preset lines are the ones to read

"Enabled and running" in Settings is **not** evidence that the preset exists, and a missing preset is the
one failure a user feels as corruption: every chapters session refuses to open with
`agent-preset/not-found`, while its log and chapters sit there intact. So the plugin prints what it
mounted and then asks the host's own roster:

```
dsh-chapters: preset "chapters" registered as a declaration row
dsh-chapters: preset "chapters" is in the host roster — 30 mounted rows all active
```

The second line counts the rows on purpose: **declared and usable are different facts.** A row can resolve
and still never activate, and the roster alone cannot see that. Anything other than the above is a named
problem:

| line | what it means |
|---|---|
| `registered — dropped N row(s) this host cannot import: …` | healthy, and the host is missing packages the composition asked for. They are dropped rather than mounted, because **one** unresolvable row makes the whole preset broken |
| `DECLARED BUT BROKEN — <row>: <host reason>` | a row mounted but refused to activate: a package that renamed a config key or a subpath. Re-anchor the row against this host |
| `N of M rows NOT active (…)` | declared and *not* usable — the host's inventory, quoted, naming the rows |
| `NOT in the host roster (roster: …)` | the preset was never created, with the ids that do exist listed |
| `this host cannot register preset declaration rows (before 0.2.0)` | below the support floor: the harness boots, the `chapters_*` tools and `/chapters-*` commands work, and no `chapters` preset can exist there |

The preset is an ordinary Loader entry — `preset-chapters`, shipped in this bundle's patch layer — so it
is visible in the plugin list and the config editor, overridable from your own profile patch, and
switch-off-able with `disabled: true` on that row if you would rather author the composition yourself.

## If the new-workspace directory picker dies before you can choose a folder

This is a host bug, not a plugin bug — no part of this plugin renders that dialog — but it blocks
installation, so here is what was measured. The workspace directory picker is a *client* bundle that takes
its icons from the shell's client module table, and the two must come from the same host generation: the
0.1.x picker asks for `IconFolderOpen16`/`IconFolderClose16`, while a 0.2.0 shell exports only the
`…Regular` spellings, with no compat alias either way. The slot boundary catches it, so you see the dialog
render and then go blank, and the server log records `slot entry crashed in
'sidebar.workspaces.directoryFlow'` with `Minified React error #130 … got: undefined`.

Upgrading the host does not necessarily fix it, because a stale **profile-local** copy of the picker keeps
shadowing the upgraded global install. Two steps, in order:

1. look for stale copies and remove them, then restart:
   `ls ~/.dsh/profiles/*/node_modules/@deepseek-ai | grep picker`
2. if you want the in-browser browser-style picker regardless of what machine the harness runs on, pin it
   deliberately in `~/.dsh/profiles/<profile>/cordis.patch.yml` (the same file the config editor writes):

   ```yaml
   - id: directory-picker
     disabled: true
   - insert:
       - id: directory-picker-browse
         name: '@deepseek-ai/dsh-host-directory-picker-browse'
       - id: directory-picker-browse-surface
         name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
   ```

   Without that pin, the host's auto resolver picks a *native* dialog (GTK/zenity) whenever the harness
   process can see a display — which means the folder chooser opens on the server's desktop, not in your
   browser.

## Supply chain, auditable

- every CI-published version carries an **npm provenance attestation** (SLSA v1, signed from the CI run's OIDC identity) linking the tarball to the exact repo, workflow, commit, and CI run that built it — publish auth itself is an npm org token in the `Production` environment since #261 (before that, trusted publishing), and no long-lived token is ever stored in the repo;
- the package moved org with the repository: **`@fractalsynapse/dsh-chapters`** from 0.2.18. The old `@treeseed/dsh-chapters` stays at 0.2.16 permanently — an install from before the move updates once, then goes stale; switch it with `dsh plugin --profile web add @fractalsynapse/dsh-chapters` (remove the old one after);
- `npm audit signatures` on an installed tree verifies it;
- releases publish from a green `main`: the release workflow itself blocks on the **full deterministic suite — unit + integration, under the ≥85% coverage gate** — and CI runs the **browser acceptance chain replayed from committed model tapes** on every push to `main`, so a release is always cut from a green acceptance run — no LLM, no GPU, no key, and a *loud* failure (503 on tape miss) rather than a skip. The current row count lives in the release ledger ([§26](/operations/changelog/)), not here: a count typed into a page goes stale exactly like a version does;

## Versioning & the changelog

Semver, tag = version, bare — the release workflow refuses to publish when the tag and `package.json`
disagree. That gate is also why this site can read its own version from the repo manifest at build time
instead of asking npm: at any release commit, the number in the manifest *is* the number that shipped.

**No page on this site tells a human to install a numbered version.** Instructions say `@latest`, which
cannot go stale; the one place that names the current release — the *Getting started* card on the home page —
interpolates it at build time. [§26](/operations/changelog/) keeps its literal version headings, and the
evidence pages keep the version each measured run ran on, for the same reason: those are records, not
instructions. What may not come back is a pinned install instruction —
`site/scripts/check-stale-versions.mjs` fails the site build if one is typed in.

Real incidents, real fixes, recorded honestly in [§26](/operations/changelog/) — including which versions to
avoid or upgrade past.

## Uninstall

`npm uninstall @fractalsynapse/dsh-chapters` in the profile directory — or `dsh plugin --profile web remove
@fractalsynapse/dsh-chapters` if that path works for you. Either way the archive it wrote is plain Markdown under
`.dsh-chapters/` and any pool you linked; removing the plugin never removes your data, by design.

Next: [24. Developing the plugin](/operations/development/).
