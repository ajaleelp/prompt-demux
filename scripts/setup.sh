#!/usr/bin/env bash
# One-command setup: classifier service (venv + deps + model) + plugin deps + global install.
# Use this if you just cloned the repo and want routing working end-to-end.
#
# You must have: Python 3.9+, Node 22+, and an OpenRouter key in OpenCode.
# Usage: ./scripts/setup.sh [-y]   (add -y to skip the confirmation prompt)
set -euo pipefail

ASSUME_YES="${ASSUME_YES:-}"
if [[ "${1:-}" == "-y" || "${1:-}" == "--yes" ]]; then ASSUME_YES=1; fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "========================================================"
echo " opencode-prompt-demux setup"
echo "========================================================"
echo ""
echo "This will install:"
echo ""
echo "  1. The classifier service (Python):"
echo "     - create classifier-service/venv"
echo "     - pip install onnxruntime, fastapi, uvicorn, ..."
echo "     - DOWNLOAD the classifier model from Hugging Face"
echo "       (~750 MB total, SHA-verified, saved to classifier-service/model/)"
echo "     - start a local server on http://127.0.0.1:8010"
echo ""
echo "  2. The OpenCode plugin (TypeScript):"
echo "     - npm install in opencode-plugin/ (pulls @opencode-ai/plugin)"
echo "     - install a GLOBAL shim so routing works in every project:"
echo "         ~/.config/opencode/plugins/prompt-demux.ts"
echo "       and a default config (only if you have none):"
echo "         ~/.config/opencode/prompt-demux.json"
echo ""
echo "  Nothing is sent anywhere except your own OpenCode chats."
echo "  The classifier runs 100% locally on your machine (CPU)."
echo ""
if [[ -z "$ASSUME_YES" ]]; then
  read -rp "Proceed? [y/N] " confirm || confirm="n"
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo ""
echo "==> [1/4] Python venv + dependencies"
python3 -m venv classifier-service/venv
classifier-service/venv/bin/pip install --upgrade pip >/dev/null
classifier-service/venv/bin/pip install -q -r classifier-service/requirements.txt

echo ""
echo "==> [2/4] Downloading classifier model (~750 MB) ..."
if [[ -f classifier-service/model/onnx/model.onnx ]]; then
  echo "    already present at classifier-service/model/ — skipping download."
else
  classifier-service/venv/bin/python classifier-service/download_model.py
fi

echo ""
echo "==> [3/4] Plugin dependencies"
cd opencode-plugin
npm install >/dev/null 2>&1 || npm install
cd ..

echo ""
echo "==> [4/4] Global install (shim + optional config)"
bash scripts/install-global.sh

echo ""
echo "==> Starting the classifier service in the background ..."
if curl -s --max-time 2 http://127.0.0.1:8010/health >/dev/null 2>&1; then
  echo "    classifier already running on :8010"
else
  nohup classifier-service/venv/bin/python classifier-service/server.py \
    >/tmp/prompt-demux-classifier.log 2>&1 &
  disown
  echo "    started (log: /tmp/prompt-demux-classifier.log)"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -s --max-time 1 http://127.0.0.1:8010/health >/dev/null 2>&1; then
      echo "    health OK -> $(curl -s http://127.0.0.1:8010/health)"
      break
    fi
    sleep 1
  done
fi

echo ""
echo "========================================================"
echo " Setup complete."
echo ""
echo " Next steps:"
echo "   1. Fully quit OpenCode (Cmd-Q) and reopen it."
echo "   2. In the model dropdown, pick 'Prompt Demux Auto'."
echo "   3. Send a message — easy ones hit glm-5.3-flash, hard"
echo "      ones hit kimi-k3 (or your configured mode)."
echo ""
echo " To see routing in action from the CLI:"
echo "   opencode run -m prompt-demux/auto 'thanks' --print-logs | grep routed"
echo ""
echo " Restart the classifier later with:"
echo "   classifier-service/venv/bin/python classifier-service/server.py"
echo "========================================================"