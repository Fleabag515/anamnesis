#!/bin/bash
# install.sh — install context-weaver as a systemd service
set -e

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_USER="${SUDO_USER:-$(whoami)}"

# Use nvm's node if available (required for native module compilation)
NVM_NODE="/home/${SERVICE_USER}/.nvm/versions/node/v22.22.2/bin/node"
NVM_NPM="/home/${SERVICE_USER}/.nvm/versions/node/v22.22.2/bin/npm"
if [ ! -f "$NVM_NODE" ]; then
  NVM_NODE="$(which node)"
  NVM_NPM="$(which npm)"
fi

echo "Installing context-weaver from $INSTALL_DIR"
echo "Running as user: $SERVICE_USER"
echo "Node: $NVM_NODE"

# Install dependencies using nvm's npm
cd "$INSTALL_DIR"
"$NVM_NPM" install

# Write systemd unit
cat > /etc/systemd/system/context-weaver.service << UNIT
[Unit]
Description=Context Weaver — LLM context rotation proxy
After=network.target llama-qwen-v2.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NVM_NODE $INSTALL_DIR/src/proxy.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=context-weaver

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable context-weaver.service
systemctl restart context-weaver.service
sleep 2
systemctl status context-weaver.service --no-pager

echo ""
PORT=$("$NVM_NODE" -e "console.log(require('$INSTALL_DIR/config.json').proxy.port)")
echo "Done. context-weaver is running on port $PORT"
echo "Point OpenClaw's llamaserver baseUrl to: http://127.0.0.1:$PORT/v1"
