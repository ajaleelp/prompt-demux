#!/usr/bin/env bash
# Install the prompt-demux plugin globally for OpenCode.
# Copies a shim into ~/.config/opencode/plugins/ that points at THIS repo,
# so dialing works in every project. Also installs a default prompt-demux.json
# if none exists at ~/.config/opencode/prompt-demux.json.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_SRC="$REPO_DIR/opencode-plugin/src/main.ts"
GLOBAL_PLUGIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/prompt-demux.json"

if [[ ! -f "$PLUGIN_SRC" ]]; then
  echo "error: plugin source not found at $PLUGIN_SRC" >&2
  exit 1
fi

if [[ ! -d "$REPO_DIR/opencode-plugin/node_modules/@opencode-ai/plugin" ]]; then
  echo "error: @opencode-ai/plugin not installed. Run: cd $REPO_DIR/opencode-plugin && npm install" >&2
  exit 1
fi

mkdir -p "$GLOBAL_PLUGIN_DIR"

SHIM="$GLOBAL_PLUGIN_DIR/prompt-demux.ts"
cat > "$SHIM" <<EOF
// Installed by scripts/install-global.sh from $REPO_DIR
export { PromptDemuxPlugin } from "$PLUGIN_SRC"
EOF
echo "wrote $SHIM"

if [[ ! -f "$GLOBAL_CONFIG" ]]; then
  cp "$REPO_DIR/prompt-demux.json" "$GLOBAL_CONFIG"
  echo "wrote default $GLOBAL_CONFIG"
else
  echo "skipped: $GLOBAL_CONFIG already exists (delete it to reinstall defaults)"
fi

cat <<'MSG'

Done. Restart OpenCode (fully quit, ⌘Q in the Desktop app), then pick an
Prompt Demux model (e.g. prompt-demux/auto) from the model dropdown.

Your project-level prompt-demux.json still takes precedence over the global one.
MSG