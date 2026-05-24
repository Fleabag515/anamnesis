#!/usr/bin/env bash
# install.sh — install Anamnesis as a systemd user/system service.
#
# Picks the newest Node version available on PATH or under NVM. The previous
# hard-coded `v22.22.2` path was a portability bug — anyone without that
# exact NVM install would silently fall through to whatever `which node`
# returned (or fail).
#
# Usage:
#   sudo bash install.sh           # install + enable + start

set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_USER="${SUDO_USER:-$(whoami)}"
SERVICE_NAME="anamnesis"

# ─── Locate node ────────────────────────────────────────────────────────────
# Try NVM (latest installed version) first because the project requires
# native module compilation against a specific Node ABI; fall back to PATH.
NVM_DIR_USER="/home/${SERVICE_USER}/.nvm"
NODE_BIN=""
NPM_BIN=""

if [ -d "${NVM_DIR_USER}/versions/node" ]; then
  LATEST_NODE="$(ls -1 "${NVM_DIR_USER}/versions/node" | sort -V | tail -n1 || true)"
  if [ -n "${LATEST_NODE}" ] && [ -x "${NVM_DIR_USER}/versions/node/${LATEST_NODE}/bin/node" ]; then
    NODE_BIN="${NVM_DIR_USER}/versions/node/${LATEST_NODE}/bin/node"
    NPM_BIN="${NVM_DIR_USER}/versions/node/${LATEST_NODE}/bin/npm"
  fi
fi

if [ -z "${NODE_BIN}" ]; then
  NODE_BIN="$(command -v node || true)"
  NPM_BIN="$(command -v npm || true)"
fi

if [ -z "${NODE_BIN}" ] || [ -z "${NPM_BIN}" ]; then
  echo "Could not locate node/npm. Install Node 18+ (or NVM) first." >&2
  exit 1
fi

echo "Installing ${SERVICE_NAME} from ${INSTALL_DIR}"
echo "Running as user: ${SERVICE_USER}"
echo "Node: ${NODE_BIN} ($(${NODE_BIN} --version))"

# ─── Install dependencies ───────────────────────────────────────────────────
cd "${INSTALL_DIR}"
"${NPM_BIN}" install --omit=dev

# ─── Write systemd unit ─────────────────────────────────────────────────────
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "${UNIT_PATH}" << UNIT
[Unit]
Description=Anamnesis — self-organizing memory proxy for LLM agents
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=ANAMNESIS_LOG=info
ExecStart=${NODE_BIN} ${INSTALL_DIR}/src/proxy.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"
sleep 2
systemctl status "${SERVICE_NAME}.service" --no-pager || true

PORT="$("${NODE_BIN}" -e "console.log(require('${INSTALL_DIR}/config.json').proxy.port)")"
echo ""
echo "Done. ${SERVICE_NAME} is running on port ${PORT}"
echo "Point your OpenAI-compatible client baseUrl to: http://127.0.0.1:${PORT}/v1"
