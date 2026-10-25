#!/usr/bin/env bash
# Bootstrap the dsh-chapters DEV profile: a fresh scratch DSH_HOME wired for
# the REAL target — the Local Qwen model at a 32K window, the Chapters preset
# as the default preset, and this plugin linked in. Nothing touches ~/.dsh.
#
#   scripts/bootstrap-dev-profile.sh [--home .dshdev-local] [--with-probe] [--force]
#
#   --with-probe   also link the probe (scripted rounds only — the probe
#                  self-exits, so a probe-mounted home is NOT browser-safe)
#   --force        re-template settings.yaml even if it already exists
#
# Then:  scripts/dsh-scratch.sh --home .dshdev-local web --port 0 --no-open
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_ARG=".dshdev-local"
WITH_PROBE=0
FORCE=0
while [[ $# -gt 0 ]]; do case "$1" in
  --home) HOME_ARG="$2"; shift 2;;
  --with-probe) WITH_PROBE=1; shift;;
  --force) FORCE=1; shift;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done
[[ "$HOME_ARG" = /* ]] || HOME_ARG="$ROOT/$HOME_ARG"
mkdir -p "$HOME_ARG"

cd "$ROOT"
if [[ ! -f lib/index.js ]]; then npm run build; fi

# Build the profile's plugin wiring with NPM, not 'dsh plugin add'. That
# command is a thin forwarder to PNPM (bin.js:105), and this repo is npm —
# never pnpm, never a monorepo. Measured 2026-09-24 with a PATH tripwire over
# `dsh web`: the host never invokes pnpm at BOOT, only at that add command. A
# profile is just a package.json carrying `dsh.profile.bundles` plus a
# resolvable node_modules; npm's `file:` install symlinks dsh-chapters exactly
# as the pnpm `link:` did, so we write it directly and stay on npm.
mkdir -p "$HOME_ARG/profiles/web"
# #108: PACK, do not link. A `file:<directory>` dependency installs as a symlink, so the mounted plugin's
# realpath is the repo — its peer deps install into the repo's node_modules and every later require walks up
# into the developer's HOME/node_modules (289 packages here, none on a runner). Measured consequence: the same
# pinned host composed a 7,276-char agent header on a laptop and 2,783 on CI, so a corpus distilled locally
# cannot replay anywhere else. A tarball is EXTRACTED into the profile, so resolution ends at the profile.
# The tarball ships `files` = lib/…, so lib/ must be current or the rig silently tests an old plugin.
[[ -f lib/index.js ]] || { echo "bootstrap-dev-profile: lib/index.js is missing — run \`npm run build\` first (the packed tarball ships lib/, so a stale build would test yesterday's plugin)" >&2; exit 2; }
PROF_ABS="$(cd "$HOME_ARG/profiles/web" && pwd)"
find "$PROF_ABS" -maxdepth 1 -name '*.tgz' -delete
TARBALL="$(cd "$ROOT" && npm pack --pack-destination "$PROF_ABS" 2>/dev/null | tail -1)"
[[ -n "$TARBALL" && -f "$PROF_ABS/$TARBALL" ]] || { echo "bootstrap-dev-profile: npm pack produced no tarball into $PROF_ABS" >&2; exit 2; }
node -e '
  const fs = require("node:fs")
  const [root, home, tarball] = process.argv.slice(1)
  // #108: the peers our plugin needs must resolve INSIDE the profile, or the mount isolation just breaks the
  // rig instead of fixing it (measured: with the tarball mount the profile held 0 @deepseek-ai packages and
  // every host import was UNRESOLVABLE from the plugin). Versions come from the hermetic lock, one per name,
  // so the profile resolves exactly what the pinned host carries — no developer tree anywhere in the chain.
  const lockNm = root + "/dev/dsh-host-lock/node_modules"
  const pluginPkg = JSON.parse(fs.readFileSync(root + "/package.json", "utf8"))
  const peers = Object.keys(pluginPkg.peerDependencies ?? {})
  const pinned = {}
  for (const name of peers) {
    let v = null
    try { v = JSON.parse(fs.readFileSync(lockNm + "/" + name + "/package.json", "utf8")).version } catch { /* not in the lock */ }
    if (v === null) throw new Error(`bootstrap-dev-profile: peer ${name} is not installed in dev/dsh-host-lock — run (cd dev/dsh-host-lock && npm ci)`)
    pinned[name] = v
  }
  const file = home + "/profiles/web/package.json"
  let pkg = { name: "dsh-profile-web", private: true, dependencies: {} }
  try { pkg = JSON.parse(fs.readFileSync(file, "utf8")) } catch { /* fresh profile */ }
  pkg.name ??= "dsh-profile-web"; pkg.private = true
  pkg.dependencies ??= {}
  // a relative `file:` resolves against this package.json, i.e. the profile directory itself
  pkg.dependencies["@treeseed/dsh-chapters"] = "file:" + tarball
  for (const [name, v] of Object.entries(pinned)) pkg.dependencies[name] = v
  fs.writeFileSync(home + "/profiles/web/peers.json", JSON.stringify(pinned, null, 2))
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  pkg.dsh.profile.bundles = [...new Set(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@treeseed/dsh-chapters", ...(pkg.dsh.profile.bundles || [])])]
  pkg.dsh.profile.patchReload ??= "live"
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2))
' "$ROOT" "$HOME_ARG" "$TARBALL"
(cd "$HOME_ARG/profiles/web" && npm install --no-audit --no-fund --loglevel=error)
[[ -f "$HOME_ARG/profiles/web/cordis.yml" ]] || printf '[]\n' > "$HOME_ARG/profiles/web/cordis.yml"

# Profile-level defaults: Local model + Chapters preset, so every new session
# in this profile runs the deterministic compaction engine out of the box.
if [[ -f "$HOME_ARG/profiles/web/cordis.patch.yml" ]] && ! grep -q "dsh-chapters DEV profile patch" "$HOME_ARG/profiles/web/cordis.patch.yml"; then
  # The HOST scaffolds a starter patch (comments + an empty `[]`) when it
  # initializes a profile (measured 2026-09-23: the scaffold made this guard
  # exit 2 on every clean CI machine before CI ever shipped). Only a patch
  # carrying real human entries is a refusal.
  if grep -vE '^[[:space:]]*(#.*|\[\])?$' "$HOME_ARG/profiles/web/cordis.patch.yml" | grep -q .; then
    echo "refusing to overwrite an existing custom patch: $HOME_ARG/profiles/web/cordis.patch.yml" >&2
    exit 2
  fi
fi
cp "$ROOT/dev/profile-cordis.patch.yml" "$HOME_ARG/profiles/web/cordis.patch.yml"
if [[ -f "$HOME_ARG/settings.yaml" && "$FORCE" -ne 1 ]]; then
  echo "settings: keeping your tuned $HOME_ARG/settings.yaml (use --force to re-template)"
else
  cp "$ROOT/dev/settings.yaml" "$HOME_ARG/settings.yaml"
fi

# Register THIS checkout as a workspace so `New session` binds immediately.
# A fresh home has no storages/workspace.json, and the web UI then shows
# "Choose workspace" — the New-session draft never commits to a session, so
# EVERY browser spec dies at newSessionWithTurn (measured 2026-09-23: passed
# for weeks only because the dev home had accumulated the file by hand; CI
# builds it clean). Written only if absent, so a warm home's real session
# list is never clobbered. The e2e boot copies this exact file into each
# throwaway home (storages/workspace.json is the one storages file it keeps).
if [[ ! -f "$HOME_ARG/storages/workspace.json" ]]; then
  mkdir -p "$HOME_ARG/storages"
  node -e '
    const crypto = require("node:crypto")
    const id = crypto.randomUUID(), now = new Date().toISOString()
    const seed = {
      unit: { name: "workspace", version: 2 },
      global: { initialized: true, workspaceIds: [id], archivedSessionIds: [] },
      tables: { workspaces: { [id]: { path: process.argv[1], title: require(process.argv[1] + "/package.json").name, createdAt: now, updatedAt: now, sessionIds: [] } } },
    }
    require("node:fs").writeFileSync(process.argv[2], JSON.stringify(seed, null, 2))
  ' "$ROOT" "$HOME_ARG/storages/workspace.json"
  echo "workspace: registered $ROOT in the home (browser specs need it bound)"
fi

# Credential refs (LOCAL_API_KEY for the local server's auth; openrouter as a
# fallback). Read-only from the live home; the copy lives only in the scratch home.
if [[ ! -f "$HOME_ARG/.credentials.yaml" && -f "$HOME/.dsh/.credentials.yaml" ]]; then
  cp "$HOME/.dsh/.credentials.yaml" "$HOME_ARG/.credentials.yaml"
  echo "credentials: copied refs from the live home (local server key + openrouter fallback)"
fi

if [[ "$WITH_PROBE" -eq 1 ]]; then
  # same npm mechanism as the plugin above — no pnpm anywhere in this script
  node -e '
    const fs = require("node:fs")
    const [root, home] = process.argv.slice(1)
    const file = home + "/profiles/web/package.json"
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
    pkg.dependencies["dsh-chapters-probe"] = "file:" + root + "/spikes/probe"
    pkg.dsh.profile.bundles = [...new Set([...pkg.dsh.profile.bundles, "dsh-chapters-probe"])]
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2))
  ' "$ROOT" "$HOME_ARG"
  (cd "$HOME_ARG/profiles/web" && npm install --no-audit --no-fund --loglevel=error)
fi

echo
echo "dev profile ready: $HOME_ARG"
echo "  model:    local/qwen3.8-flash-next @ 32K (the target regime)"
echo "  preset:   chapters (default) — deterministic compaction engine on every new session"
echo "start:      scripts/dsh-scratch.sh --home $(realpath -m --relative-to="$ROOT" "$HOME_ARG") web --port 0 --no-open"
