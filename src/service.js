'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DAEMON_JS  = path.join(__dirname, 'daemon.js');
const NODE_BIN   = process.execPath;
const IS_WINDOWS = process.platform === 'win32';

async function install() {
  if (IS_WINDOWS) {
    await installWindows();
  } else {
    installLinux();
  }
}

function installLinux() {
  if (process.getuid && process.getuid() !== 0) {
    console.error('error: anamnesis install requires root — run with sudo');
    process.exit(1);
  }
  const unit = `[Unit]
Description=Anamnesis — multi-character memory proxy daemon
After=network.target

[Service]
Type=simple
User=${os.userInfo().username}
ExecStart=${NODE_BIN} ${DAEMON_JS}
Restart=on-failure
RestartSec=5
Environment=ANAMNESIS_LOG=info
StandardOutput=journal
StandardError=journal
SyslogIdentifier=anamnesis

[Install]
WantedBy=multi-user.target
`;
  fs.writeFileSync('/etc/systemd/system/anamnesis.service', unit, 'utf8');
  execSync('systemctl daemon-reload');
  execSync('systemctl enable anamnesis');
  execSync('systemctl restart anamnesis');
  console.log('✓ anamnesis service installed and started');
  console.log('  check status: systemctl status anamnesis');
}

async function installWindows() {
  try {
    require('child_process').execSync('net session', { stdio: 'pipe' });
  } catch {
    console.error('error: anamnesis install requires Administrator — right-click and "Run as Administrator"');
    process.exit(1);
  }
  let Service;
  try {
    ({ Service } = require('node-windows'));
  } catch {
    console.error('node-windows not available — run: npm install node-windows');
    process.exit(1);
  }
  const svc = new Service({ name: 'Anamnesis', script: DAEMON_JS });
  await new Promise((resolve) => {
    svc.on('install', () => { svc.start(); resolve(); });
    svc.install();
  });
  console.log('✓ Anamnesis Windows Service installed and started');
}

async function uninstall() {
  if (IS_WINDOWS) {
    await uninstallWindows();
  } else {
    uninstallLinux();
  }
}

function uninstallLinux() {
  try { execSync('systemctl stop anamnesis'); } catch { /* not running */ }
  try { execSync('systemctl disable anamnesis'); } catch { /* not enabled */ }
  try { fs.unlinkSync('/etc/systemd/system/anamnesis.service'); } catch { /* already gone */ }
  try { execSync('systemctl daemon-reload'); } catch { /* ignore */ }
  console.log('✓ anamnesis service uninstalled (data preserved in ~/.anamnesis/)');
}

async function uninstallWindows() {
  let Service;
  try { ({ Service } = require('node-windows')); } catch { return; }
  const svc = new Service({ name: 'Anamnesis', script: DAEMON_JS });
  await new Promise(resolve => { svc.on('uninstall', resolve); svc.uninstall(); });
  console.log('✓ Anamnesis Windows Service uninstalled (data preserved)');
}

module.exports = { install, uninstall };
