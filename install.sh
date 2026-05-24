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
# Prefer NVM's latest *LTS* version (even-major releases: 18, 20, 22, 24, …)
# over odd-major dev releases (19, 21, 23, 25). The service is long-running
# and depends on a native addon (better-sqlite3) whose ABI is pinned to the
# build-time Node — silently picking a non-LTS minor a user just happens to
# have installed would force a rebuild on every install.sh run.
NVM_DIR_USER="/home/${SERVICE_USER}/.nvm"
NODE_BIN=""
NPM_BIN=""

pick_nvm_node() {
  local versions_dir="$1"
  local filter="$2"  # extended regex; empty = anything
  local pick
  if [ -z "$filter" ]; then
    pick="$(ls -1 "$versions_dir" 2>/dev/null | sort -V | tail -n1 || true)"
  else
    pick="$(ls -1 "$versions_dir" 2>/dev/null | grep -E "$filter" | sort -V | tail -n1 || true)"
  fi
  if [ -n "$pick" ] && [ -x "$versions_dir/$pick/bin/node" ]; then
    echo "$versions_dir/$pick"
  fi
}

if [ -d "${NVM_DIR_USER}/versions/node" ]; then
  # First try: LTS only (even-major). Matches v<…><0|2|4|6|8>.x.x
  # so v18 / v20 / v22 / v24 win over v17 / v19 / v21 / v23 / v25.
  LTS_PREFIX="$(pick_nvm_node "${NVM_DIR_USER}/versions/node" '^v[0-9]*[02468]\.')"
  if [ -n "$LTS_PREFIX" ]; then
    NODE_BIN="${LTS_PREFIX}/bin/node"
    NPM_BIN="${LTS_PREFIX}/bin/npm"
  else
    # No LTS installed; fall back to whatever's newest under NVM.
    ANY_PREFIX="$(pick_nvm_node "${NVM_DIR_USER}/versions/node" '')"
    if [ -n "$ANY_PREFIX" ]; then
      NODE_BIN="${ANY_PREFIX}/bin/node"
      NPM_BIN="${ANY_PREFIX}/bin/npm"
    fi
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
