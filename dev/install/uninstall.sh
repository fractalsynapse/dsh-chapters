#!/usr/bin/env bash
# dsh-chapters development uninstaller
#
# Removes dsh-chapters from the web profile. By default, only removes the plugin
# dependency and bundle entry from the web profile's package.json, plus the dev
# Cordis patch entries. With --full, also removes the global DSH host installation.
# With --purge-home, removes the entire $DSH_HOME (dangerous).
#
# Usage: ./dev/install/uninstall.sh [--full] [--purge-home] [--dsh-home PATH]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Defaults ───────────────────────────────────────────────────────────────────
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
PROFILE_NAME="web"
FULL_UNINSTALL=false
PURGE_HOME=false

# ── Parse flags ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)        FULL_UNINSTALL=true; shift ;;
    --purge-home)  PURGE_HOME=true; shift ;;
    --dsh-home)    DSH_HOME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--full] [--purge-home] [--dsh-home PATH]"
      echo ""
      echo "Removes dsh-chapters from the web profile."
      echo ""
      echo "Options:"
      echo "  --full           Also uninstall the global @deepseek-ai/dsh package"
      echo "  --purge-home     Remove the entire \$DSH_HOME directory (implies --full)"
      echo "  --dsh-home PATH  DSH home directory (default: ~/.dsh)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ "$PURGE_HOME" == true ]]; then
  FULL_UNINSTALL=true
fi

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"

# ── Helpers ────────────────────────────────────────────────────────────────────
info()  { printf '\033[1;34m[uninstall]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[   ok ]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[ warn ]\033[0m %s\n' "$*"; }
skip()  { printf '\033[0;90m[ skip ]\033[0m %s\n' "$*"; }

confirm() {
  local prompt="$1"
  printf '%s [y/N] ' "$prompt"
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ── Step 1: Remove plugin from web profile ────────────────────────────────────
PKG_JSON="$PROFILE_DIR/package.json"

if [[ -f "$PKG_JSON" ]]; then
  info "Removing dsh-chapters from web profile..."

  # Remove dependency and bundle entry via node
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$PKG_JSON', 'utf8'));

    // Remove dependency
    if (pkg.dependencies) {
      delete pkg.dependencies['@treeseed/dsh-chapters'];
    }

    // Remove from bundles
    if (pkg.dsh?.profile?.bundles) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(
        b => b !== '@treeseed/dsh-chapters'
      );
    }

    fs.writeFileSync('$PKG_JSON', JSON.stringify(pkg, null, 2) + '\n');
  "
  ok "Plugin removed from package.json"

  # Remove dev Cordis patch entries (the block added by install.sh)
  PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
  if [[ -f "$PATCH_FILE" ]]; then
    if grep -q "dsh-chapters dev entries" "$PATCH_FILE" 2>/dev/null; then
      info "Removing dev Cordis patch entries..."
      # Remove from the marker comment to end of file (our appended block)
      sed -i '/# ── dsh-chapters dev entries/,$ d' "$PATCH_FILE"
      # Also remove the preset selection block if we added it
      sed -i '/selectedDefault: chapters/,/^$/d' "$PATCH_FILE" 2>/dev/null || true
      ok "Dev patch entries removed from cordis.patch.yml"
    else
      skip "No dev patch entries found in cordis.patch.yml"
    fi
  fi

  # Remove dev settings block (the local provider we appended)
  SETTINGS_FILE="$PROFILE_DIR/settings.yaml"
  if [[ -f "$SETTINGS_FILE" ]]; then
    if grep -q "dsh-chapters dev: local LLM provider" "$SETTINGS_FILE" 2>/dev/null; then
      info "Removing dev LLM settings..."
      sed -i '/# ── dsh-chapters dev: local LLM provider/,$ d' "$SETTINGS_FILE"
      ok "Dev LLM settings removed from settings.yaml"
    else
      skip "No dev LLM settings found in settings.yaml"
    fi
  fi
else
  skip "Web profile package.json not found: $PKG_JSON"
fi

# ── Step 2: Full uninstall (optional) ─────────────────────────────────────────
if [[ "$FULL_UNINSTALL" == true ]]; then
  if command -v dsh &>/dev/null; then
    info "Uninstalling global @deepseek-ai/dsh..."
    npm uninstall -g @deepseek-ai/dsh 2>/dev/null && \
      ok "DSH host uninstalled" || \
      warn "Could not uninstall DSH host (may need sudo or different prefix)"
  else
    skip "DSH host not installed globally"
  fi
fi

# ── Step 3: Purge DSH_HOME (optional, dangerous) ──────────────────────────────
if [[ "$PURGE_HOME" == true ]]; then
  if [[ -d "$DSH_HOME" ]]; then
    warn "This will DELETE everything in $DSH_HOME:"
    warn "  sessions, storage, credentials, all profiles, skills"
    if confirm "Are you sure you want to purge $DSH_HOME?"; then
      rm -rf "$DSH_HOME"
      ok "DSH home purged: $DSH_HOME"
    else
      skip "Purge cancelled"
    fi
  else
    skip "DSH home not found: $DSH_HOME"
  fi
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
printf '\033[1;32m✓ Uninstall complete.\033[0m\n'
echo ""

if [[ "$PURGE_HOME" != true && -d "$DSH_HOME" ]]; then
  echo "  The web profile still exists with your other plugins/config."
  echo "  To remove everything: $0 --purge-home"
  echo ""
fi
