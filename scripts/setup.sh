#!/usr/bin/env bash
# One-command setup: plugin deps + global install.
#
# You must have: Node 22+, a TypeSafe API key (https://typesafe.ai) exported as
# TYPESAFE_API_KEY in the environment OpenCode runs in, and an OpenCode account.
# Usage: ./scripts/setup.sh [-y]   (add -y to skip the confirmation prompt)
set -euo pipefail

ASSUME_YES="${ASSUME_YES:-}"
if [[ "${1:-}" == "-y" || "${1:-}" == "--yes" ]]; then ASSUME_YES=1; fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "========================================================"
echo " prompt-demux setup"
echo "========================================================"
echo ""
echo "This will install the OpenCode plugin:"
echo "  - npm install in opencode-plugin/ (pulls @opencode-ai/plugin)"
echo "  - a GLOBAL shim so dialing works in every project:"
echo "      ~/.config/opencode/plugins/prompt-demux.ts"
echo "  - a default config (only if you have none):"
echo "      ~/.config/opencode/prompt-demux.json"
echo ""
echo "  Classification is done by TypeSafe Jev (https://typesafe.ai)."
echo "  Your message text and the last few turns of the session are sent"
echo "  to api.typesafe.ai for tiering. Set TYPESAFE_API_KEY before"
echo "  launching OpenCode; without it everything dials MEDIUM."
echo ""
if [[ -z "$ASSUME_YES" ]]; then
  read -rp "Proceed? [y/N] " confirm || confirm="n"
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo ""
echo "==> [1/2] Plugin dependencies"
cd opencode-plugin
npm install >/dev/null 2>&1 || npm install
cd ..

echo ""
echo "==> [2/2] Global install (shim + optional config)"
bash scripts/install-global.sh

if [[ -z "${TYPESAFE_API_KEY:-}" ]]; then
  echo ""
  echo "!! TYPESAFE_API_KEY is not set in this shell. Export it (e.g. in ~/.zshrc)"
  echo "   before launching OpenCode, or every message will dial MEDIUM."
fi

echo ""
echo "========================================================"
echo " Setup complete."
echo ""
echo " Next steps:"
echo "   1. Fully quit OpenCode (Cmd-Q) and reopen it."
echo "   2. In the model dropdown, pick 'Prompt Demux Auto'."
echo "   3. Send a message — easy ones dial @low, hard ones @max"
echo "      (or whatever your configured mode maps)."
echo ""
echo " To see dialing in action from the CLI:"
echo "   opencode run -m prompt-demux/auto 'thanks' --print-logs | grep -E 'dialed|routed'"
echo "========================================================"
