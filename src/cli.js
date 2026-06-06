#!/usr/bin/env node
'use strict';

const { execFileSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pid = require('./lib/pid.js');
const client = require('./lib/client.js');

const DAEMON_JS = path.join(__dirname, 'daemon.js');

// ─── Daemon auto-start ────────────────────────────────────────────────────────

async function ensureDaemon() {
  if (pid.isRunning()) return;

  const managed = isManagedService();
  if (managed) {
    console.error(
      'daemon not running — start it with: anamnesis\n  or check: systemctl status anamnesis'
    );
    process.exit(1);
  }

  const child = spawn(process.execPath, [DAEMON_JS], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ANAMNESIS_LOG: process.env.ANAMNESIS_LOG || 'info' },
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await client.status();
      if (res.status === 200) return;
    } catch {
      /* not ready yet */
    }
  }
  console.error('daemon failed to start — check ~/.anamnesis/daemon.log');
  process.exit(1);
}

function isManagedService() {
  try {
    execFileSync('systemctl', ['is-enabled', 'anamnesis'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function printCharacters(characters) {
  if (!characters.length) {
    console.log('No characters. Run: anamnesis new');
    return;
  }
  const W = { name: 4, port: 4 };
  for (const c of characters) W.name = Math.max(W.name, c.name.length);
  console.log(`${'NAME'.padEnd(W.name)}  ${'PORT'.padEnd(W.port)}  STATUS`);
  for (const c of characters) {
    console.log(
      `${c.name.padEnd(W.name)}  \x1b[1m${String(c.port).padEnd(W.port)}\x1b[0m  ${c.running ? '\x1b[32mactive\x1b[0m' : 'inactive'}`
    );
  }
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const commands = {
  async status() {
    await ensureDaemon();
    const r = await client.status();
    if (r.status !== 200) die('daemon not responding');
    const chars = (await client.listCharacters()).body.characters || [];
    console.log(`anamnesis daemon — uptime ${r.body.uptime}s, ${r.body.active} active`);
    printCharacters(chars);
  },

  async list() {
    await ensureDaemon();
    const r = await client.listCharacters();
    printCharacters(r.body.characters || []);
  },

  async start([name]) {
    if (!name) die('usage: anamnesis start <name>');
    await ensureDaemon();
    const r = await client.startCharacter(name);
    if (r.status !== 200) die(r.body.error || 'failed to start');
    console.log(`✓ ${name} running on http://127.0.0.1:${r.body.port}/v1`);
  },

  async stop([name]) {
    if (!name) die('usage: anamnesis stop <name>');
    await ensureDaemon();
    const r = await client.stopCharacter(name);
    if (r.status !== 200) die(r.body.error || 'failed to stop');
    console.log(`✓ ${name} stopped`);
  },

  async restart([name]) {
    if (!name) die('usage: anamnesis restart <name>');
    await commands.stop([name]);
    await commands.start([name]);
  },

  async show([name]) {
    if (!name) die('usage: anamnesis show <name>');
    await ensureDaemon();
    const r = await client.getCharacter(name);
    if (r.status === 404) die(`character '${name}' not found`);
    const c = r.body;
    console.log(`name:   ${c.name}`);
    console.log(`port:   ${c.port}`);
    console.log(`status: ${c.running ? 'active' : 'inactive'}`);
  },

  async remove([name, ...rest]) {
    if (!name) die('usage: anamnesis remove <name>');
    const yes = rest.includes('--yes');
    await ensureDaemon();
    if (!yes) {
      const prompts = require('prompts');
      const { ok } = await prompts({
        type: 'confirm',
        name: 'ok',
        message: `Delete '${name}' and all its memories?`,
        initial: false,
      });
      if (!ok) {
        console.log('aborted');
        return;
      }
    }
    const r = await client.deleteCharacter(name);
    if (r.status !== 200) die(r.body.error || 'failed to delete');
    console.log(`✓ ${name} deleted`);
  },

  async logs([name]) {
    if (!name) die('usage: anamnesis logs <name>');
    // MVP: tails full daemon journal. Per-character SSE streaming is post-MVP.
    console.log(`(showing all daemon logs — filter for '${name}' manually)\n`);
    try {
      const child = spawn('journalctl', ['-u', 'anamnesis', '-f', '--no-pager', '-n', '50'], {
        stdio: 'inherit',
      });
      child.on('error', () =>
        console.log('journalctl not available — check ~/.anamnesis/daemon.log')
      );
    } catch {
      console.log('check ~/.anamnesis/daemon.log');
    }
  },

  async new(args) {
    await ensureDaemon();
    const wizard = require('./wizard.js');
    await wizard.run(args);
  },

  async edit([name, ...rest]) {
    if (!name) die('usage: anamnesis edit <name>');
    await ensureDaemon();
    const wizard = require('./wizard.js');
    await wizard.edit(name);
  },

  async import(args) {
    const importer = require('./importers/index.js');
    await importer.runCli(args);
  },

  async export([name]) {
    if (!name) die('usage: anamnesis export <name>');
    console.log('export not yet implemented');
  },

  async install() {
    const svc = require('./service.js');
    await svc.install();
  },

  async uninstall() {
    const svc = require('./service.js');
    await svc.uninstall();
  },

  async update() {
    const { execSync } = require('child_process');
    const isWindows = process.platform === 'win32';

    const INSTALL_DIR = isWindows
      ? path.join(
          process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
          'anamnesis'
        )
      : path.join(os.homedir(), '.local', 'share', 'anamnesis');

    const isGitRepo = fs.existsSync(path.join(INSTALL_DIR, '.git'));

    if (isGitRepo) {
      // ── Git install (Linux / macOS / developer setup) ──────────────────────
      let current, remote;
      try {
        current = execSync('git rev-parse HEAD', { cwd: INSTALL_DIR, encoding: 'utf8' }).trim();
        remote = execSync('git ls-remote origin HEAD', { cwd: INSTALL_DIR, encoding: 'utf8' })
          .trim()
          .split('\t')[0];
      } catch {
        console.error('update failed: git error or no network access');
        process.exit(1);
      }

      if (current === remote) {
        console.log('anamnesis is up to date (' + current.slice(0, 7) + ')');
        return;
      }

      console.log('update available: ' + current.slice(0, 7) + ' → ' + remote.slice(0, 7));
      console.log('updating...');

      try {
        execSync('git pull --ff-only', { cwd: INSTALL_DIR, stdio: 'inherit' });
        execSync('npm install --omit=dev', { cwd: INSTALL_DIR, stdio: 'inherit' });
      } catch {
        console.error(
          'update failed — try manually: cd ~/.local/share/anamnesis && git pull && npm install --omit=dev'
        );
        process.exit(1);
      }
    } else if (isWindows) {
      // ── ZIP install (Windows installer) ────────────────────────────────────
      const REPO_URL = 'https://github.com/Fleabag515/anamnesis/archive/refs/heads/main.zip';
      const TmpZip = path.join(os.tmpdir(), 'anamnesis-update.zip');
      const TmpDir = path.join(os.tmpdir(), 'anamnesis-update');

      console.log('downloading update...');
      try {
        execSync(
          `powershell -Command "Invoke-WebRequest -Uri '${REPO_URL}' -OutFile '${TmpZip}' -UseBasicParsing"`,
          { stdio: 'inherit' }
        );
        execSync(
          `powershell -Command "if (Test-Path '${TmpDir}') { Remove-Item '${TmpDir}' -Recurse -Force }; Expand-Archive -Path '${TmpZip}' -DestinationPath '${TmpDir}' -Force"`,
          { stdio: 'inherit' }
        );
        execSync(
          `powershell -Command "Copy-Item '${TmpDir}\\anamnesis-main\\*' '${INSTALL_DIR}' -Recurse -Force"`,
          { stdio: 'inherit' }
        );
        execSync('npm install --omit=dev', { cwd: INSTALL_DIR, stdio: 'inherit' });
        execSync(
          `powershell -Command "Remove-Item '${TmpZip}','${TmpDir}' -Recurse -Force -ErrorAction SilentlyContinue"`,
          { stdio: 'pipe' }
        );
      } catch {
        console.error(
          'update failed — re-run the installer:\n  irm https://raw.githubusercontent.com/Fleabag515/anamnesis/main/install.ps1 | iex'
        );
        process.exit(1);
      }
    } else {
      console.error('update failed: not a git repo. Re-run the installer from the README.');
      process.exit(1);
    }

    console.log('updated — restart any running daemon: anamnesis restart');
  },
};

// ─── Aliases ──────────────────────────────────────────────────────────────────
commands.ls = commands.list;
commands.ps = commands.status;
commands.run = commands.start;
commands.kill = commands.stop;
commands.rm = commands.remove;

// ─── Entry point ─────────────────────────────────────────────────────────────

const [, , cmd, ...args] = process.argv;

if (!cmd) {
  commands.status().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (commands[cmd]) {
  commands[cmd](args).catch((e) => {
    console.error('error:', e.message);
    process.exit(1);
  });
} else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(`anamnesis — multi-character memory proxy

Usage: anamnesis <command> [options]

Commands:
  new                   Create a new character (interactive wizard)
  list, ls              List all characters and their status
  start <name>          Start a character's proxy
  stop <name>           Stop a character's proxy
  restart <name>        Restart a character's proxy
  status, ps            Show daemon status and active characters
  show <name>           Show character config
  edit <name>           Edit character settings (interactive)
  remove, rm <name>     Delete a character and its data
  import <name> <file>  Import memories from a file
  export <name>         Export character memories
  logs [name]           Tail logs
  install               Register anamnesis as a system service
  uninstall             Remove the system service
  update                Check for updates and install if available

Options:
  -h, --help            Show this help message`);
} else {
  console.error(`unknown command: ${cmd}`);
  console.error('run: anamnesis --help   for a list of commands');
  process.exit(1);
}
