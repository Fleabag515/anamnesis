# Anamnesis v0.5 — Multi-Character CLI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Anamnesis from a single manually-configured proxy into a multi-character platform with a one-liner installer, interactive CLI, character wizard, and universal import system.

**Architecture:** A single Node.js daemon (`src/daemon.js`) hosts one `http.Server` per active character on its own port, plus a control server on port 9000 that the CLI talks to. Characters are isolated namespaces with their own `~/.anamnesis/characters/<name>/` directory containing a per-character `config.json` and `history.db`.

**Tech Stack:** Node.js 18+, better-sqlite3, `prompts` (interactive wizard), `node-windows` (Windows service, optional), raw `http` module with hand-rolled router for control API. Test runner: `node --test`.

**Repo:** `/home/fleabag/anamnesis/`  
**Run tests:** `npm test` (= `node --test "test/**/*.test.js"`)  
**Spec:** `docs/superpowers/specs/2026-06-05-multi-character-cli-design.md`

---

## Chunk 1: Foundation

Library helpers and the proxy.js signal handler fix. Nothing here changes user-visible behaviour — it just makes the daemon architecture possible.

### File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/lib/registry.js` | Read/write `~/.anamnesis/registry.json` |
| Create | `src/lib/ports.js` | Port availability check + auto-increment scan |
| Create | `src/lib/pid.js` | PID file write/read/delete |
| Create | `src/lib/router.js` | Minimal HTTP router for control server (7 routes) |
| Modify | `src/proxy.js` | Move `process.on(SIGTERM/SIGINT)` behind `require.main` guard |
| Modify | `package.json` | Add `bin`, `prompts` dep, `node-windows` optional dep |
| Create | `test/lib/registry.test.js` | Unit tests for registry helpers |
| Create | `test/lib/ports.test.js` | Unit tests for port helpers |
| Create | `test/lib/router.test.js` | Unit tests for router |

---

### Task 1: `src/lib/registry.js` — character registry helpers

**Files:**
- Create: `src/lib/registry.js`
- Create: `test/lib/registry.test.js`

- [ ] **Write failing tests**

```js
// test/lib/registry.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Registry = require('../../src/lib/registry.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anamnesis-test-'));
}

test('load returns empty list when file absent', () => {
  const dir = tmpDir();
  const reg = new Registry(path.join(dir, 'registry.json'));
  assert.deepEqual(reg.list(), []);
});

test('add and persist a character', () => {
  const dir = tmpDir();
  const reg = new Registry(path.join(dir, 'registry.json'));
  reg.add({ name: 'mark', port: 8084, active: false });
  const reg2 = new Registry(path.join(dir, 'registry.json'));
  assert.equal(reg2.list().length, 1);
  assert.equal(reg2.list()[0].name, 'mark');
});

test('setActive updates active flag and persists', () => {
  const dir = tmpDir();
  const reg = new Registry(path.join(dir, 'registry.json'));
  reg.add({ name: 'mark', port: 8084, active: false });
  reg.setActive('mark', true);
  const reg2 = new Registry(path.join(dir, 'registry.json'));
  assert.equal(reg2.get('mark').active, true);
});

test('updatePort updates port and persists to disk', () => {
  const dir = tmpDir();
  const reg = new Registry(path.join(dir, 'registry.json'));
  reg.add({ name: 'mark', port: 8084, active: false });
  reg.updatePort('mark', 8085);
  // Verify in-memory
  assert.equal(reg.get('mark').port, 8085);
  // Verify persisted — fresh instance from same file
  const reg2 = new Registry(path.join(dir, 'registry.json'));
  assert.equal(reg2.get('mark').port, 8085);
});

test('remove deletes character and persists to disk', () => {
  const dir = tmpDir();
  const reg = new Registry(path.join(dir, 'registry.json'));
  reg.add({ name: 'mark', port: 8084, active: false });
  reg.remove('mark');
  assert.equal(reg.list().length, 0);
  // Verify persisted
  const reg2 = new Registry(path.join(dir, 'registry.json'));
  assert.equal(reg2.list().length, 0);
});

test('get returns undefined for unknown name', () => {
  const dir = tmpDir();
  const reg = new Registry(path.join(dir, 'registry.json'));
  assert.equal(reg.get('nobody'), undefined);
});
```

- [ ] **Run — expect FAIL** (module not found)

```bash
cd /home/fleabag/anamnesis
node --test "test/lib/registry.test.js" 2>&1 | tail -5
```

- [ ] **Implement `src/lib/registry.js`**

```js
'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(
  process.env.HOME || require('os').homedir(),
  '.anamnesis', 'registry.json'
);

class Registry {
  constructor(filePath = DEFAULT_PATH) {
    this._path = filePath;
    this._data = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this._path, 'utf8'));
    } catch {
      return { characters: [] };
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this._path), { recursive: true });
    fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2), 'utf8');
  }

  list() {
    return this._data.characters;
  }

  get(name) {
    return this._data.characters.find(c => c.name === name);
  }

  add(entry) {
    if (this.get(entry.name)) throw new Error(`character '${entry.name}' already exists`);
    this._data.characters.push(entry);
    this._save();
  }

  setActive(name, active) {
    const c = this.get(name);
    if (!c) throw new Error(`character '${name}' not found`);
    c.active = active;
    this._save();
  }

  updatePort(name, port) {
    const c = this.get(name);
    if (!c) throw new Error(`character '${name}' not found`);
    c.port = port;
    this._save();
  }

  update(name, fields) {
    const c = this.get(name);
    if (!c) throw new Error(`character '${name}' not found`);
    Object.assign(c, fields);
    this._save();
  }

  remove(name) {
    this._data.characters = this._data.characters.filter(c => c.name !== name);
    this._save();
  }

  usedPorts() {
    return new Set(this._data.characters.map(c => c.port));
  }
}

module.exports = Registry;
```

- [ ] **Run — expect PASS**

```bash
node --test "test/lib/registry.test.js" 2>&1 | tail -5
```

Expected: `# tests 6` all passing.

- [ ] **Commit**

```bash
git add src/lib/registry.js test/lib/registry.test.js
git commit -m "feat: add Registry helper for registry.json management"
```

---

### Task 2: `src/lib/ports.js` — port availability + auto-increment

**Files:**
- Create: `src/lib/ports.js`
- Create: `test/lib/ports.test.js`

- [ ] **Write failing tests**

```js
// test/lib/ports.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { isPortFree, findFreePort } = require('../../src/lib/ports.js');

// Helper: bind a port to make it busy
function occupy(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

test('isPortFree returns true for an unbound port', async () => {
  // Port 19999 is unlikely to be in use in a test environment
  const free = await isPortFree(19999);
  assert.equal(free, true);
});

test('isPortFree returns false for an occupied port', async () => {
  const server = await occupy(19998);
  try {
    const free = await isPortFree(19998);
    assert.equal(free, false);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('findFreePort returns requested port when free', async () => {
  const port = await findFreePort(19997, new Set());
  assert.equal(port, 19997);
});

test('findFreePort skips occupied ports', async () => {
  const server = await occupy(19996);
  try {
    const port = await findFreePort(19996, new Set());
    assert.ok(port > 19996);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('findFreePort skips ports in reserved set', async () => {
  const port = await findFreePort(19995, new Set([19995, 19994]));
  assert.ok(port !== 19995 && port !== 19994);
});
```

- [ ] **Run — expect FAIL**

```bash
node --test "test/lib/ports.test.js" 2>&1 | tail -5
```

- [ ] **Implement `src/lib/ports.js`**

```js
'use strict';

const net = require('net');

const BASE_PORT = 8084;
const MAX_SCAN  = 200; // give up after 200 attempts

/**
 * Returns true if nothing is bound to port on 127.0.0.1.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * Starting at `preferred`, scan upward until we find a port that is both
 * free on the OS and not in `reserved` (the set of ports already assigned
 * to other characters in the registry).
 *
 * @param {number} preferred
 * @param {Set<number>} reserved  — ports already in use by other characters
 * @returns {Promise<number>}
 */
async function findFreePort(preferred = BASE_PORT, reserved = new Set()) {
  for (let i = 0; i < MAX_SCAN; i++) {
    const candidate = preferred + i;
    if (reserved.has(candidate)) continue;
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(`could not find a free port starting from ${preferred} after ${MAX_SCAN} attempts`);
}

/**
 * Suggest the next port not already in a registry's used-port set.
 */
async function suggestPort(registry) {
  const used = registry.usedPorts();
  return findFreePort(BASE_PORT, used);
}

module.exports = { isPortFree, findFreePort, suggestPort };
```

- [ ] **Run — expect PASS**

```bash
node --test "test/lib/ports.test.js" 2>&1 | tail -5
```

- [ ] **Commit**

```bash
git add src/lib/ports.js test/lib/ports.test.js
git commit -m "feat: add ports helper — isPortFree, findFreePort, suggestPort"
```

---

### Task 3: `src/lib/pid.js` — PID file management

**Files:**
- Create: `src/lib/pid.js`

No separate test file — behaviour is trivially verified in daemon integration.

- [ ] **Implement `src/lib/pid.js`**

```js
'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(
  process.env.HOME || require('os').homedir(),
  '.anamnesis', 'daemon.pid'
);

function write(pidPath = DEFAULT_PATH) {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
}

function read(pidPath = DEFAULT_PATH) {
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function remove(pidPath = DEFAULT_PATH) {
  try { fs.unlinkSync(pidPath); } catch { /* already gone */ }
}

/** Returns true if the PID in the file corresponds to a running process. */
function isRunning(pidPath = DEFAULT_PATH) {
  const pid = read(pidPath);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = process exists (wrong user), ESRCH = gone
}

module.exports = { write, read, remove, isRunning, DEFAULT_PATH };
```

- [ ] **Commit**

```bash
git add src/lib/pid.js
git commit -m "feat: add PID file helper for daemon process management"
```

---

### Task 4: `src/lib/router.js` — minimal HTTP router

**Files:**
- Create: `src/lib/router.js`
- Create: `test/lib/router.test.js`

- [ ] **Write failing tests**

```js
// test/lib/router.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../../src/lib/router.js');

function fakeReq(method, url) {
  return { method, url };
}

function fakeRes() {
  const res = { headers: {}, body: null, status: null };
  res.writeHead = (s, h) => { res.status = s; Object.assign(res.headers, h || {}); };
  res.end = (b) => { res.body = b; };
  return res;
}

test('routes GET /characters to handler', async () => {
  const router = new Router();
  router.get('/characters', (req, res) => res.end('ok'));
  const res = fakeRes();
  await router.handle(fakeReq('GET', '/characters'), res);
  assert.equal(res.body, 'ok');
});

test('extracts :name param', async () => {
  const router = new Router();
  router.get('/characters/:name', (req, res) => res.end(req.params.name));
  const res = fakeRes();
  await router.handle(fakeReq('GET', '/characters/mark'), res);
  assert.equal(res.body, 'mark');
});

test('404 on unmatched route', async () => {
  const router = new Router();
  const res = fakeRes();
  await router.handle(fakeReq('GET', '/nope'), res);
  assert.equal(res.status, 404);
});

test('routes POST separately from GET', async () => {
  const router = new Router();
  router.get('/x', (req, res) => res.end('get'));
  router.post('/x', (req, res) => res.end('post'));
  const res = fakeRes();
  await router.handle(fakeReq('POST', '/x'), res);
  assert.equal(res.body, 'post');
});

test('routes DELETE', async () => {
  const router = new Router();
  router.delete('/characters/:name', (req, res) => res.end(req.params.name));
  const res = fakeRes();
  await router.handle(fakeReq('DELETE', '/characters/mark'), res);
  assert.equal(res.body, 'mark');
});
```

- [ ] **Run — expect FAIL**

```bash
node --test "test/lib/router.test.js" 2>&1 | tail -5
```

- [ ] **Implement `src/lib/router.js`**

```js
'use strict';

class Router {
  constructor() {
    this._routes = []; // { method, pattern, keys, handler }
  }

  _add(method, path, handler) {
    const keys = [];
    const src = path.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    this._routes.push({ method, re: new RegExp(`^${src}$`), keys, handler });
  }

  get(path, handler)    { this._add('GET',    path, handler); }
  post(path, handler)   { this._add('POST',   path, handler); }
  delete(path, handler) { this._add('DELETE', path, handler); }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    for (const route of this._routes) {
      if (route.method !== req.method) continue;
      const m = url.pathname.match(route.re);
      if (!m) continue;
      req.params = Object.fromEntries(route.keys.map((k, i) => [k, m[i + 1]]));
      req.query  = Object.fromEntries(url.searchParams);
      await route.handler(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
}

module.exports = { Router };
```

- [ ] **Run — expect PASS**

```bash
node --test "test/lib/router.test.js" 2>&1 | tail -5
```

- [ ] **Commit**

```bash
git add src/lib/router.js test/lib/router.test.js
git commit -m "feat: add minimal HTTP router for control server"
```

---

### Task 5: Fix `src/proxy.js` signal handlers + export `createCharacterServer`

The daemon will call `start(config)` for each character. The current signal handlers in `proxy.js` call `process.exit(0)` — fine for standalone mode but catastrophic in the daemon (one character error would kill everything). Move them behind a `require.main` guard.

**Files:**
- Modify: `src/proxy.js`

- [ ] **Verify current signal handler location**

```bash
grep -n 'SIGTERM\|SIGINT\|require.main' /home/fleabag/anamnesis/src/proxy.js
```

Expected: `process.on('SIGTERM', ...)`, `process.on('SIGINT', ...)`, and `if (require.main === module) start();` somewhere near the bottom.

- [ ] **Move signal handlers behind `require.main` guard**

Find this block in `src/proxy.js` (near the bottom, before `if (require.main === module) start()`):

```js
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { server, history, shutdown };
}

if (require.main === module) start();
```

Replace with:

```js
  if (require.main === module) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  return { server, history, shutdown };
}

if (require.main === module) start();
```

- [ ] **Verify standalone mode still works**

```bash
cd /home/fleabag/anamnesis
timeout 3 node src/proxy.js 2>&1 | head -5 || true
```

Expected: sees `[anamnesis] listening on 127.0.0.1:8084` then exits after 3s (timeout).

- [ ] **Run full test suite — expect no regressions**

```bash
npm test 2>&1 | tail -10
```

- [ ] **Commit**

```bash
git add src/proxy.js
git commit -m "fix: move signal handlers behind require.main guard — safe for daemon use"
```

---

### Task 6: Update `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Install `prompts`**

```bash
cd /home/fleabag/anamnesis
npm install prompts
```

- [ ] **Add `bin` and `node-windows` (optional) to `package.json`**

In `package.json`, add the `bin` field and mark `node-windows` as optional:

```json
{
  "bin": {
    "anamnesis": "src/cli.js"
  },
  "optionalDependencies": {
    "node-windows": "^1.0.0"
  }
}
```

- [ ] **Install optional dep**

```bash
npm install --save-optional node-windows
```

- [ ] **Verify `prompts` works**

```bash
node -e "const p = require('prompts'); console.log(typeof p)"
```

Expected: `function` or `object`.

- [ ] **Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add prompts dep, node-windows optional dep, bin entry for CLI"
```

---

## Chunk 2: Daemon + Character Manager

The daemon process and the character manager that owns start/stop/create/delete logic and port conflict resolution.

### File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/character-manager.js` | Create/delete characters, start/stop their `http.Server`, port conflict resolution |
| Create | `src/control-server.js` | REST API consumed by CLI (7 routes) |
| Create | `src/daemon.js` | Entry point: init, start control server, reactivate characters, handle shutdown |
| Create | `test/character-manager.test.js` | Unit tests for character CRUD + port conflict |

---

### Task 7: `src/character-manager.js`

**Files:**
- Create: `src/character-manager.js`
- Create: `test/character-manager.test.js`

`CharacterManager` owns the registry and the live map of running character servers. It is the only thing that calls `start()` from `proxy.js`.

- [ ] **Write failing tests**

```js
// test/character-manager.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Registry = require('../src/lib/registry.js');
const CharacterManager = require('../src/character-manager.js');

// Isolated temp dir for both registry and character files — no ~/.anamnesis/ writes
function tmpSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anamnesis-mgr-'));
  const reg = new Registry(path.join(dir, 'registry.json'));
  const mgr = new CharacterManager(reg, dir); // pass baseDir to avoid writing to real home
  return { dir, reg, mgr };
}

function minimalCharConfig(port = 19900, baseDir = os.tmpdir()) {
  return {
    proxy:     { port, host: '127.0.0.1' },
    upstream:  { baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'test', disableThinking: false },
    embedding: { ollamaUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-cpu:latest' },
    extraction: { model: 'qwen3:0.6b', maxRetries: 1, timeoutMs: 5000, startupBacklogLimit: 0 },
    context:   { tokenBudget: 4096, systemReserveTokens: 512, recencyTurns: 4, rotatingSlots: 2, charsPerToken: 3.5, minChunkChars: 50 },
    memory:    { consolidationIntervalMs: 999999, consolidationBatchSize: 10, sceneClusterThreshold: 0.72, minSceneSize: 2, decayPruneThreshold: 0.05 },
    history:   { dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anam-hist-')), 'history.db'), maxAgeDays: 30 },
    foresight: { model: 'qwen3:0.6b', maxRetries: 1, timeoutMs: 5000, startupBacklogLimit: 0 },
    persona:   { enabled: false },
  };
}

test('createCharacter adds entry to registry', () => {
  const { dir, reg, mgr } = tmpSetup();
  mgr.createCharacter('mark', minimalCharConfig(19900, dir));
  assert.ok(reg.get('mark'));
  assert.equal(reg.get('mark').name, 'mark');
});

test('createCharacter rejects duplicate names', () => {
  const { dir, mgr } = tmpSetup();
  mgr.createCharacter('mark', minimalCharConfig(19901, dir));
  assert.throws(() => mgr.createCharacter('mark', minimalCharConfig(19902, dir)), /already exists/);
});

test('createCharacter rejects invalid names', () => {
  const { dir, mgr } = tmpSetup();
  assert.throws(() => mgr.createCharacter('my character', minimalCharConfig(19903, dir)), /invalid name/i);
  assert.throws(() => mgr.createCharacter('../evil', minimalCharConfig(19904, dir)), /invalid name/i);
});

test('deleteCharacter removes from registry', () => {
  const { dir, reg, mgr } = tmpSetup();
  mgr.createCharacter('mark', minimalCharConfig(19905, dir));
  mgr.deleteCharacter('mark');
  assert.equal(reg.get('mark'), undefined);
});

test('deleteCharacter throws when character is active', async () => {
  const { dir, mgr } = tmpSetup();
  // We can't actually start a proxy (would need a real upstream), but we can
  // simulate an active character by injecting into the internal _running map
  mgr.createCharacter('mark', minimalCharConfig(19906, dir));
  mgr._running.set('mark', { shutdown: async () => {} }); // fake instance
  assert.throws(() => mgr.deleteCharacter('mark'), /stop .* before delet/i);
  mgr._running.delete('mark'); // cleanup
});

test('listCharacters returns all entries with running flag', () => {
  const { dir, mgr } = tmpSetup();
  mgr.createCharacter('mark', minimalCharConfig(19907, dir));
  mgr.createCharacter('aria', minimalCharConfig(19908, dir));
  const list = mgr.listCharacters();
  assert.equal(list.length, 2);
  assert.equal(list[0].running, false);
});

test('isActive returns false for stopped character', () => {
  const { dir, mgr } = tmpSetup();
  mgr.createCharacter('mark', minimalCharConfig(19909, dir));
  assert.equal(mgr.isActive('mark'), false);
});

test('stopCharacter sets active=false in registry', async () => {
  const { dir, reg, mgr } = tmpSetup();
  mgr.createCharacter('mark', minimalCharConfig(19910, dir));
  // Inject fake running instance
  mgr._running.set('mark', { shutdown: async () => {} });
  reg.setActive('mark', true);
  await mgr.stopCharacter('mark');
  assert.equal(mgr.isActive('mark'), false);
  assert.equal(reg.get('mark').active, false);
});
```

- [ ] **Run — expect FAIL**

```bash
node --test "test/character-manager.test.js" 2>&1 | tail -10
```

- [ ] **Implement `src/character-manager.js`**

```js
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { start: startProxy } = require('./proxy.js');
const { findFreePort }      = require('./lib/ports.js');
const log                   = require('./lib/logger.js').make('manager');

const NAME_RE = /^[a-z0-9_-]+$/i;
const DEFAULT_BASE = path.join(os.homedir(), '.anamnesis');

class CharacterManager {
  /**
   * @param {Registry} registry
   * @param {string}   baseDir  — root of ~/.anamnesis/ (injectable for tests)
   * @param {number}   controlPort — excluded from port suggestions to avoid self-conflict
   */
  constructor(registry, baseDir = DEFAULT_BASE, controlPort = 9000) {
    this._registry    = registry;
    this._baseDir     = baseDir;
    this._controlPort = controlPort;
    this._running     = new Map(); // name → { server, history, shutdown }
  }

  _characterDir(name) {
    return path.join(this._baseDir, 'characters', name);
  }

  _configPath(name) {
    return path.join(this._characterDir(name), 'config.json');
  }

  _loadConfig(name) {
    return JSON.parse(fs.readFileSync(this._configPath(name), 'utf8'));
  }

  _saveConfig(name, config) {
    const dir = this._characterDir(name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._configPath(name), JSON.stringify(config, null, 2), 'utf8');
  }

  createCharacter(name, config) {
    if (!NAME_RE.test(name)) throw new Error(`invalid name '${name}' — use letters, digits, hyphens, underscores only`);
    if (this._registry.get(name)) throw new Error(`character '${name}' already exists`);
    this._saveConfig(name, config);
    this._registry.add({ name, port: config.proxy.port, active: false });
    log.info(`created character '${name}' on port ${config.proxy.port}`);
  }

  async startCharacter(name) {
    if (this._running.has(name)) return; // already up
    const entry = this._registry.get(name);
    if (!entry) throw new Error(`character '${name}' not found`);

    const config = this._loadConfig(name);
    const reserved = this._registry.usedPorts();
    reserved.delete(entry.port);          // own port is not "foreign"
    reserved.add(this._controlPort);      // never steal the control server's port

    const freePort = await findFreePort(entry.port, reserved);
    if (freePort !== entry.port) {
      log.info(`port ${entry.port} in use — starting '${name}' on ${freePort} instead`);
      config.proxy.port = freePort;
      this._registry.updatePort(name, freePort);
      this._saveConfig(name, config);
    }

    const instance = await startProxy(config);
    this._running.set(name, instance);
    this._registry.setActive(name, true);
    log.info(`started '${name}' on port ${freePort}`);
    return freePort;
  }

  async stopCharacter(name) {
    const instance = this._running.get(name);
    if (!instance) return;
    await instance.shutdown('stop');
    this._running.delete(name);
    this._registry.setActive(name, false);
    log.info(`stopped '${name}'`);
  }

  deleteCharacter(name) {
    if (this._running.has(name)) throw new Error(`stop '${name}' before deleting`);
    const dir = this._characterDir(name);
    fs.rmSync(dir, { recursive: true, force: true });
    this._registry.remove(name);
    log.info(`deleted character '${name}'`);
  }

  listCharacters() {
    return this._registry.list().map(entry => ({
      ...entry,
      running: this._running.has(entry.name),
    }));
  }

  getCharacter(name) {
    const entry = this._registry.get(name);
    if (!entry) return null;
    return { ...entry, running: this._running.has(name) };
  }

  isActive(name) {
    return this._running.has(name);
  }

  async reactivateAll() {
    for (const entry of this._registry.list()) {
      if (entry.active) {
        try { await this.startCharacter(entry.name); }
        catch (e) { log.warn(`failed to reactivate '${entry.name}':`, e.message); }
      }
    }
  }

  async stopAll() {
    for (const name of [...this._running.keys()]) {
      await this.stopCharacter(name);
    }
  }
}

module.exports = CharacterManager;
```

- [ ] **Run — expect PASS**

```bash
node --test "test/character-manager.test.js" 2>&1 | tail -10
```

- [ ] **Commit**

```bash
git add src/character-manager.js test/character-manager.test.js
git commit -m "feat: add CharacterManager — create/start/stop/delete characters with port conflict resolution"
```

---

### Task 8: `src/control-server.js` — REST control API

**Files:**
- Create: `src/control-server.js`

The control server is an HTTP server using `src/lib/router.js`. It translates REST calls from the CLI into `CharacterManager` operations.

- [ ] **Implement `src/control-server.js`**

```js
'use strict';

const http = require('http');
const { Router } = require('./lib/router.js');
const log = require('./lib/logger.js').make('control');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', d => { buf += d; });
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); } catch { resolve({}); }
    });
  });
}

function createControlServer(manager, daemonStartedAt) {
  const router = new Router();

  // GET /status
  router.get('/status', (req, res) => {
    json(res, 200, {
      status: 'ok',
      uptime: Math.floor((Date.now() - daemonStartedAt) / 1000),
      active: manager.listCharacters().filter(c => c.running).length,
    });
  });

  // GET /characters
  router.get('/characters', (req, res) => {
    json(res, 200, { characters: manager.listCharacters() });
  });

  // GET /characters/:name
  router.get('/characters/:name', (req, res) => {
    const c = manager.getCharacter(req.params.name);
    if (!c) return json(res, 404, { error: `character '${req.params.name}' not found` });
    json(res, 200, c);
  });

  // POST /characters — create
  router.post('/characters', async (req, res) => {
    const body = await readBody(req);
    try {
      manager.createCharacter(body.name, body.config);
      json(res, 201, { name: body.name });
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  });

  // POST /characters/:name/start
  router.post('/characters/:name/start', async (req, res) => {
    const { name } = req.params;
    if (!manager.getCharacter(name)) return json(res, 404, { error: `character '${name}' not found` });
    try {
      const port = await manager.startCharacter(name);
      json(res, 200, { name, port });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  // POST /characters/:name/stop
  router.post('/characters/:name/stop', async (req, res) => {
    const { name } = req.params;
    if (!manager.getCharacter(name)) return json(res, 404, { error: `character '${name}' not found` });
    try {
      await manager.stopCharacter(name);
      json(res, 200, { name, stopped: true });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  // DELETE /characters/:name
  router.delete('/characters/:name', async (req, res) => {
    const { name } = req.params;
    try {
      if (manager.isActive(name)) await manager.stopCharacter(name);
      manager.deleteCharacter(name);
      json(res, 200, { name, deleted: true });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  const server = http.createServer(async (req, res) => {
    try {
      await router.handle(req, res);
    } catch (e) {
      log.error('control server error:', e.message);
      json(res, 500, { error: 'internal error' });
    }
  });

  return server;
}

module.exports = { createControlServer };
```

- [ ] **Smoke-test the control server compiles**

```bash
node -e "require('./src/control-server.js'); console.log('ok')"
```

Expected: `ok`

- [ ] **Commit**

```bash
git add src/control-server.js
git commit -m "feat: add control server — REST API for CLI→daemon communication"
```

---

### Task 9: `src/daemon.js` — daemon entry point

**Files:**
- Create: `src/daemon.js`

- [ ] **Implement `src/daemon.js`**

```js
#!/usr/bin/env node
'use strict';

const path    = require('path');
const os      = require('os');
const fs      = require('fs');

const Registry         = require('./lib/registry.js');
const pid              = require('./lib/pid.js');
const CharacterManager = require('./character-manager.js');
const { createControlServer } = require('./control-server.js');
const log              = require('./lib/logger.js').make('daemon');

const ANAMNESIS_DIR  = path.join(os.homedir(), '.anamnesis');
const DAEMON_CONFIG  = path.join(ANAMNESIS_DIR, 'daemon.json');
const REGISTRY_PATH  = path.join(ANAMNESIS_DIR, 'registry.json');

function loadDaemonConfig() {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  fs.mkdirSync(ANAMNESIS_DIR, { recursive: true });

  const daemonCfg     = loadDaemonConfig();
  const controlPort   = daemonCfg.controlPort || 9000;
  const controlHost   = '127.0.0.1';
  const startedAt     = Date.now();

  const registry = new Registry(REGISTRY_PATH);
  const manager  = new CharacterManager(registry, ANAMNESIS_DIR, controlPort);

  const controlServer = createControlServer(manager, startedAt);

  await new Promise((resolve, reject) => {
    controlServer.listen(controlPort, controlHost, resolve);
    controlServer.once('error', reject);
  });

  pid.write();
  log.info(`daemon listening on ${controlHost}:${controlPort}`);

  // Reactivate characters that were running before last stop
  await manager.reactivateAll();

  async function shutdown(signal) {
    log.info(`received ${signal}, shutting down...`);
    await manager.stopAll();
    // Wait for control server to finish draining in-flight requests before exiting
    await new Promise(resolve => controlServer.close(resolve));
    pid.remove();
    log.info('shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(e => {
  console.error('[daemon] fatal:', e.message);
  process.exit(1);
});
```

- [ ] **Smoke-test: daemon starts and responds on control port**

```bash
cd /home/fleabag/anamnesis
node src/daemon.js &
DAEMON_PID=$!
sleep 1
curl -s http://127.0.0.1:9000/status
kill $DAEMON_PID
```

Expected: `{"status":"ok","uptime":...,"active":0}`

- [ ] **Run full test suite**

```bash
npm test 2>&1 | tail -10
```

- [ ] **Commit**

```bash
git add src/daemon.js
git commit -m "feat: add daemon entry point — control server + character reactivation on startup"
```

---

## Chunk 3: CLI

The `anamnesis` CLI — thin client that talks to the daemon. All commands go through the control server at `127.0.0.1:9000`.

### File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/cli.js` | Entry point, command dispatch, daemon auto-start |
| Create | `src/lib/client.js` | HTTP client wrapper for control API calls |

---

### Task 10: `src/lib/client.js` — control API client

**Files:**
- Create: `src/lib/client.js`

- [ ] **Implement `src/lib/client.js`**

```js
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DAEMON_CONFIG = path.join(os.homedir(), '.anamnesis', 'daemon.json');

function getControlPort() {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_CONFIG, 'utf8')).controlPort || 9000;
  } catch { return 9000; }
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const port    = getControlPort();
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const client = {
  get:    (path)       => request('GET',    path),
  post:   (path, body) => request('POST',   path, body),
  delete: (path)       => request('DELETE', path),

  status:              () => client.get('/status'),
  listCharacters:      () => client.get('/characters'),
  getCharacter:   (name) => client.get(`/characters/${name}`),
  startCharacter: (name) => client.post(`/characters/${name}/start`),
  stopCharacter:  (name) => client.post(`/characters/${name}/stop`),
  createCharacter: (name, config) => client.post('/characters', { name, config }),
  deleteCharacter: (name) => client.delete(`/characters/${name}`),
};

module.exports = client;
```

- [ ] **Commit**

```bash
git add src/lib/client.js
git commit -m "feat: add control API client for CLI→daemon communication"
```

---

### Task 11: `src/cli.js` — CLI entry point and core commands

**Files:**
- Create: `src/cli.js`

- [ ] **Implement `src/cli.js`**

```js
#!/usr/bin/env node
'use strict';

const { execFileSync, spawn } = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const pid  = require('./lib/pid.js');
const client = require('./lib/client.js');

const DAEMON_JS = path.join(__dirname, 'daemon.js');

// ─── Daemon auto-start ───────────────────────────────────────────────────────

async function ensureDaemon() {
  if (pid.isRunning()) return; // already up

  // Check if systemd/Windows Service manages it
  const managed = isManagedService();
  if (managed) {
    console.error('daemon not running — start it with: anamnesis\n  or check: systemctl status anamnesis');
    process.exit(1);
  }

  // Spawn detached daemon
  const child = spawn(process.execPath, [DAEMON_JS], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ANAMNESIS_LOG: process.env.ANAMNESIS_LOG || 'info' },
  });
  child.unref();

  // Poll /status up to 5s
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await client.status();
      if (res.status === 200) return;
    } catch { /* not ready yet */ }
  }
  console.error('daemon failed to start — check ~/.anamnesis/daemon.log');
  process.exit(1);
}

function isManagedService() {
  try {
    execFileSync('systemctl', ['is-enabled', 'anamnesis'], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

// ─── Output helpers ──────────────────────────────────────────────────────────

function printCharacters(characters) {
  if (!characters.length) { console.log('No characters. Run: anamnesis new'); return; }
  const W = { name: 4, port: 4, status: 6 };
  for (const c of characters) {
    W.name = Math.max(W.name, c.name.length);
  }
  console.log(`${'NAME'.padEnd(W.name)}  ${'PORT'.padEnd(W.port)}  STATUS`);
  for (const c of characters) {
    const status = c.running ? 'active' : 'inactive';
    console.log(`${c.name.padEnd(W.name)}  ${String(c.port).padEnd(W.port)}  ${status}`);
  }
}

function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

// ─── Commands ────────────────────────────────────────────────────────────────

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
    if (!yes) {
      const { default: prompts } = await import('prompts');
      const { ok } = await prompts({ type: 'confirm', name: 'ok', message: `Delete '${name}' and all its memories?`, initial: false });
      if (!ok) { console.log('aborted'); return; }
    }
    await ensureDaemon();
    const r = await client.deleteCharacter(name);
    if (r.status !== 200) die(r.body.error || 'failed to delete');
    console.log(`✓ ${name} deleted`);
  },

  async logs([name]) {
    if (!name) die('usage: anamnesis logs <name>');
    // Tail journalctl for the anamnesis service, filtering by character name
    // Falls back to daemon log file if journalctl unavailable
    try {
      const child = spawn('journalctl', ['-u', 'anamnesis', '-f', '--no-pager', '-n', '50'], { stdio: 'inherit' });
      child.on('error', () => {
        console.log(`(journalctl not available — check ~/.anamnesis/daemon.log)`);
      });
    } catch {
      console.log(`check ~/.anamnesis/daemon.log`);
    }
  },

  async new(args) {
    const wizard = require('./wizard.js');
    await wizard.run(args);
  },

  async edit([name]) {
    if (!name) die('usage: anamnesis edit <name>');
    const wizard = require('./wizard.js');
    await wizard.edit(name);
  },

  async import(args) {
    const importer = require('./importers/index.js');
    await importer.runCli(args);
  },

  async install() {
    const svc = require('./service.js');
    await svc.install();
  },

  async uninstall() {
    const svc = require('./service.js');
    await svc.uninstall();
  },
};

// ─── Aliases ─────────────────────────────────────────────────────────────────

commands.ls      = commands.list;
commands.ps      = commands.status;
commands.run     = commands.start;
commands.kill    = commands.stop;
commands.rm      = commands.remove;

// ─── Entry point ─────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

if (!cmd) {
  // Bare `anamnesis` — start daemon / show status
  commands.status().catch(e => { console.error(e.message); process.exit(1); });
} else if (commands[cmd]) {
  commands[cmd](args).catch(e => { console.error('error:', e.message); process.exit(1); });
} else {
  console.error(`unknown command: ${cmd}`);
  console.error('commands: new, list, start, stop, restart, show, edit, remove, import, export, logs, status, install, uninstall');
  process.exit(1);
}
```

- [ ] **Smoke-test CLI compiles**

```bash
node src/cli.js 2>&1 | head -5 || true
```

- [ ] **Commit**

```bash
git add src/cli.js src/lib/client.js
git commit -m "feat: add anamnesis CLI — list, start/run, stop/kill, restart, show, remove/rm, logs, status/ps"
```

---

### Task 12: `src/service.js` — install/uninstall system service

**Files:**
- Create: `src/service.js`

- [ ] **Implement `src/service.js`**

```js
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
  // Requires elevation — detected in cli.js before calling this
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
```

- [ ] **Commit**

```bash
git add src/service.js
git commit -m "feat: add service.js — install/uninstall systemd (Linux) and Windows Service"
```

---

## Chunk 4: Character Creation Wizard

Interactive wizard for `anamnesis new` and `anamnesis edit`. Uses `prompts` for terminal interaction.

### File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/wizard.js` | Interactive character creation + edit wizard |
| Create | `src/lib/char-config.js` | Build default per-character config from wizard answers |

---

### Task 13: `src/lib/char-config.js` — character config builder

**Files:**
- Create: `src/lib/char-config.js`
- Create: `test/lib/char-config.test.js`

- [ ] **Write failing tests**

```js
// test/lib/char-config.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig } = require('../../src/lib/char-config.js');

test('buildConfig produces valid config shape', () => {
  const cfg = buildConfig({
    name: 'mark',
    port: 8084,
    upstreamUrl: 'http://127.0.0.1:8083/v1',
    apiKey: 'localqwen',
  });
  assert.equal(cfg.proxy.port, 8084);
  assert.equal(cfg.upstream.baseUrl, 'http://127.0.0.1:8083/v1');
  assert.equal(cfg.upstream.apiKey, 'localqwen');
  assert.ok(cfg.history.dbPath.includes('mark'));
  assert.ok(cfg.context.tokenBudget > 0);
});

test('buildConfig sets persona.source.inline when description provided', () => {
  const cfg = buildConfig({
    name: 'aria',
    port: 8085,
    upstreamUrl: 'http://127.0.0.1:8083/v1',
    apiKey: 'key',
    characterDescription: 'sarcastic hacker',
  });
  assert.equal(cfg.persona.source.type, 'inline');
  assert.equal(cfg.persona.source.inline.content, 'sarcastic hacker');
});

test('buildConfig disables persona when blank', () => {
  const cfg = buildConfig({
    name: 'blank',
    port: 8086,
    upstreamUrl: 'http://localhost:8083/v1',
    apiKey: 'k',
    blank: true,
  });
  assert.equal(cfg.persona.enabled, false);
});
```

- [ ] **Run — expect FAIL**

```bash
node --test "test/lib/char-config.test.js" 2>&1 | tail -5
```

- [ ] **Implement `src/lib/char-config.js`**

```js
'use strict';

const path = require('path');
const os   = require('os');

const DEFAULTS = {
  context:  { tokenBudget: 50000, systemReserveTokens: 4096, recencyTurns: 8, rotatingSlots: 6, charsPerToken: 3.5, minChunkChars: 50 },
  memory:   { consolidationIntervalMs: 120000, consolidationBatchSize: 50, sceneClusterThreshold: 0.72, minSceneSize: 2, decayPruneThreshold: 0.05 },
  extraction: { model: 'qwen3:0.6b', maxRetries: 2, timeoutMs: 45000, startupBacklogLimit: 200 },
  foresight:  { model: 'qwen3:0.6b', maxRetries: 2, timeoutMs: 45000, startupBacklogLimit: 200 },
  embedding:  { ollamaUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-cpu:latest' },
  history:    { maxAgeDays: 90 },
};

function buildConfig({ name, port, upstreamUrl, apiKey, characterDescription, blank, overrides = {} }) {
  const dbPath = path.join(os.homedir(), '.anamnesis', 'characters', name, 'history.db');

  let personaSource;
  if (blank) {
    personaSource = { enabled: false };
  } else if (characterDescription) {
    personaSource = {
      enabled: true,
      source: { type: 'inline', inline: { content: characterDescription }, openclaw: {}, file: {} },
      model: DEFAULTS.extraction.model,
      timeoutMs: DEFAULTS.foresight.timeoutMs,
      drift: { enabled: true, checkEveryNTurns: 4, driftThreshold: 0.55 },
      evolution: { enabled: true, consolidateAfterNObservations: 8, maxEvolutionChars: 600 },
      injection: { maxProfileChars: 700 },
    };
  } else {
    personaSource = {
      enabled: true,
      source: { type: 'auto', openclaw: { soulPath: '~/.openclaw/Mark/SOUL.md' }, file: { path: '~/.anamnesis/character.md' }, inline: { content: '' } },
      model: DEFAULTS.extraction.model,
      timeoutMs: DEFAULTS.foresight.timeoutMs,
      drift: { enabled: true, checkEveryNTurns: 4, driftThreshold: 0.55 },
      evolution: { enabled: true, consolidateAfterNObservations: 8, maxEvolutionChars: 600 },
      injection: { maxProfileChars: 700 },
    };
  }

  return {
    proxy:      { port, host: '127.0.0.1' },
    upstream:   { baseUrl: upstreamUrl, apiKey, disableThinking: true },
    embedding:  DEFAULTS.embedding,
    extraction: DEFAULTS.extraction,
    context:    DEFAULTS.context,
    memory:     DEFAULTS.memory,
    history:    { dbPath, maxAgeDays: DEFAULTS.history.maxAgeDays },
    foresight:  DEFAULTS.foresight,
    persona:    blank ? { enabled: false } : personaSource,
    ...overrides,
  };
}

module.exports = { buildConfig, DEFAULTS };
```

- [ ] **Run — expect PASS**

```bash
node --test "test/lib/char-config.test.js" 2>&1 | tail -5
```

- [ ] **Commit**

```bash
git add src/lib/char-config.js test/lib/char-config.test.js
git commit -m "feat: add char-config builder — assembles per-character config from wizard answers"
```

---

### Task 14: `src/wizard.js` — interactive character wizard

**Files:**
- Create: `src/wizard.js`

The wizard is interactive — not unit tested directly. Integration is verified by manual smoke test.

- [ ] **Implement `src/wizard.js`**

```js
'use strict';

const prompts   = require('prompts');
const path      = require('path');
const os        = require('os');
const fs        = require('fs');

const client         = require('./lib/client.js');
const { buildConfig } = require('./lib/char-config.js');
const { suggestPort } = require('./lib/ports.js');
const Registry       = require('./lib/registry.js');
const log            = require('./lib/logger.js').make('wizard');

const REGISTRY_PATH = path.join(os.homedir(), '.anamnesis', 'registry.json');
const NAME_RE = /^[a-z0-9_-]+$/i;

async function run(args) {
  // Parse --flags from args
  const flags = parseFlags(args);
  const registry = new Registry(REGISTRY_PATH);

  console.log('\n✨ anamnesis — new character\n');

  // Name
  let name = flags.name;
  if (!name) {
    ({ name } = await prompts({ type: 'text', name: 'name', message: 'Character name:', validate: v =>
      NAME_RE.test(v) ? true : 'letters, digits, hyphens, underscores only',
    }));
  }
  if (!name) process.exit(0);
  if (registry.get(name)) {
    console.error(`\n  a character named '${name}' already exists — use: anamnesis edit ${name}`);
    process.exit(1);
  }

  // Port
  const suggested = flags.port || await suggestPort(registry);
  let port = suggested;
  if (!flags.port) {
    ({ port } = await prompts({ type: 'number', name: 'port', message: 'Port:', initial: suggested }));
  }

  // Upstream
  let upstreamUrl = flags.upstream || '';
  if (!upstreamUrl) {
    ({ upstreamUrl } = await prompts({ type: 'text', name: 'upstreamUrl', message: 'Model endpoint URL:', initial: 'http://127.0.0.1:8083/v1' }));
  }

  let apiKey = flags.key || '';
  if (!apiKey) {
    ({ apiKey } = await prompts({ type: 'text', name: 'apiKey', message: 'API key:', initial: 'localqwen' }));
  }

  // Character setup
  let mode = flags.blank ? 'blank' : flags.description ? 'describe' : null;
  if (!mode) {
    ({ mode } = await prompts({
      type: 'select', name: 'mode', message: 'Character setup:',
      choices: [
        { title: 'Import from files or URLs', value: 'import' },
        { title: 'Describe the character concept', value: 'describe' },
        { title: 'Start blank — let it develop on its own', value: 'blank' },
      ],
    }));
  }

  let characterDescription = '';
  let importSources = [];

  if (mode === 'import') {
    const importer = require('./importers/index.js');
    const result = await importer.runWizard({ name });
    characterDescription = result.description;
    importSources = result.sources;
  } else if (mode === 'describe') {
    ({ characterDescription } = await prompts({
      type: 'text', name: 'characterDescription', message: 'Describe the character:',
    }));
  }
  // blank: characterDescription stays empty

  const config = buildConfig({
    name, port, upstreamUrl, apiKey,
    characterDescription: characterDescription || undefined,
    blank: mode === 'blank',
  });

  // Create via daemon API
  const createRes = await client.createCharacter(name, config);
  if (createRes.status !== 201) {
    console.error('failed to create character:', createRes.body.error);
    process.exit(1);
  }

  // Import memories if any
  if (importSources.length > 0) {
    const importer = require('./importers/index.js');
    await importer.importInto(name, importSources, characterDescription);
  }

  // Start?
  let startNow = flags.yes;
  if (!startNow) {
    ({ startNow } = await prompts({ type: 'confirm', name: 'startNow', message: `Start ${name} now?`, initial: true }));
  }
  if (startNow) {
    const startRes = await client.startCharacter(name);
    if (startRes.status === 200) {
      console.log(`\n✓ ${name} is running on http://127.0.0.1:${startRes.body.port}/v1\n`);
    } else {
      console.error('failed to start:', startRes.body.error);
    }
  } else {
    console.log(`\n✓ ${name} created. Start with: anamnesis start ${name}\n`);
  }
}

async function edit(name) {
  const registry = new Registry(REGISTRY_PATH);
  const entry = registry.get(name);
  if (!entry) { console.error(`character '${name}' not found`); process.exit(1); }

  const configPath = path.join(os.homedir(), '.anamnesis', 'characters', name, 'config.json');
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  console.log(`\n✏️  editing ${name}\n`);

  const { upstreamUrl } = await prompts({ type: 'text', name: 'upstreamUrl', message: 'Model endpoint URL:', initial: current.upstream.baseUrl });
  const { apiKey }      = await prompts({ type: 'text', name: 'apiKey',      message: 'API key:',           initial: current.upstream.apiKey });
  const { port }        = await prompts({ type: 'number', name: 'port',      message: 'Port:',             initial: current.proxy.port });
  const { tokenBudget } = await prompts({ type: 'number', name: 'tokenBudget', message: 'Token budget:',   initial: current.context.tokenBudget });

  current.upstream.baseUrl    = upstreamUrl;
  current.upstream.apiKey     = apiKey;
  current.proxy.port          = port;
  current.context.tokenBudget = tokenBudget;

  fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf8');
  registry.updatePort(name, port);
  console.log(`\n✓ ${name} updated`);

  // If running, restart on port change
  if (entry.active && port !== entry.port) {
    console.log('port changed — restarting...');
    await client.stopCharacter(name);
    await client.startCharacter(name);
    console.log(`✓ ${name} restarted on port ${port}`);
  }
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name')        flags.name        = args[++i];
    else if (args[i] === '--port')   flags.port        = parseInt(args[++i]);
    else if (args[i] === '--upstream') flags.upstream  = args[++i];
    else if (args[i] === '--key')    flags.key         = args[++i];
    else if (args[i] === '--blank')  flags.blank       = true;
    else if (args[i] === '--yes')    flags.yes         = true;
    else if (args[i] === '--description') flags.description = args[++i];
  }
  return flags;
}

module.exports = { run, edit };
```

- [ ] **Smoke-test wizard compiles**

```bash
node -e "require('./src/wizard.js'); console.log('ok')"
```

- [ ] **Commit**

```bash
git add src/wizard.js src/lib/char-config.js
git commit -m "feat: add character creation wizard — interactive new/edit with flag support"
```

---

## Chunk 5: Import System

Format-aware extraction + LLM understanding. Each format is a small adapter in `src/importers/`.

### File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/importers/detect.js` | Identify format from file extension + content sniffing |
| Create | `src/importers/text.js` | Plain text / markdown passthrough |
| Create | `src/importers/anamnesis-export.js` | Anamnesis own export — direct DB restore |
| Create | `src/importers/odysseus.js` | Odysseus memory JSON → memcells |
| Create | `src/importers/openclaw.js` | OpenClaw / Hermes SOUL.md passthrough |
| Create | `src/importers/characterai.js` | Character.AI JSON → text |
| Create | `src/importers/sillytavern.js` | SillyTavern PNG card → extract JSON from tEXt chunk |
| Create | `src/importers/index.js` | Import pipeline orchestrator, CLI entry, wizard integration |
| Create | `test/importers/detect.test.js` | Unit tests for format detection |
| Create | `test/importers/odysseus.test.js` | Unit tests for Odysseus adapter |
| Create | `test/importers/sillytavern.test.js` | Unit tests for SillyTavern adapter |
| Create | `test/importers/characterai.test.js` | Unit tests for Character.AI adapter |

---

### Task 15: Format detection

**Files:**
- Create: `src/importers/detect.js`
- Create: `test/importers/detect.test.js`

- [ ] **Write failing tests**

```js
// test/importers/detect.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectFormat } = require('../../src/importers/detect.js');

test('detects anamnesis export by key', () => {
  const buf = Buffer.from(JSON.stringify({ anamnesis_export: true, version: 1 }));
  assert.equal(detectFormat('export.json', buf), 'anamnesis-export');
});

test('detects odysseus by memories array', () => {
  const buf = Buffer.from(JSON.stringify({ memories: [], version: 1 }));
  assert.equal(detectFormat('dump.json', buf), 'odysseus');
});

test('detects characterai by participants key', () => {
  const buf = Buffer.from(JSON.stringify({ participants: [], histories: [] }));
  assert.equal(detectFormat('export.json', buf), 'characterai');
});

test('detects markdown as text', () => {
  const buf = Buffer.from('# Character\nShe is...');
  assert.equal(detectFormat('SOUL.md', buf), 'text');
});

test('detects .txt as text', () => {
  assert.equal(detectFormat('notes.txt', Buffer.from('hello')), 'text');
});

test('detects .png as sillytavern', () => {
  // PNG magic bytes
  const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(detectFormat('char.png', buf), 'sillytavern');
});

test('falls back to text for unknown json', () => {
  const buf = Buffer.from(JSON.stringify({ something: 'else' }));
  assert.equal(detectFormat('file.json', buf), 'text');
});
```

- [ ] **Run — expect FAIL**

```bash
node --test "test/importers/detect.test.js" 2>&1 | tail -5
```

- [ ] **Implement `src/importers/detect.js`**

```js
'use strict';

const path = require('path');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function detectFormat(filename, buf) {
  const ext = path.extname(filename).toLowerCase();

  // PNG — check magic bytes
  if (buf.slice(0, 8).equals(PNG_MAGIC)) return 'sillytavern';

  // JSON — check content
  if (ext === '.json' || (buf[0] === 0x7B)) {
    try {
      const obj = JSON.parse(buf.toString('utf8').slice(0, 2000));
      if (obj.anamnesis_export) return 'anamnesis-export';
      if (Array.isArray(obj.memories)) return 'odysseus';
      if (obj.participants && obj.histories) return 'characterai';
    } catch { /* not valid JSON */ }
  }

  // Text/markdown — everything else
  return 'text';
}

module.exports = { detectFormat };
```

- [ ] **Run — expect PASS**

```bash
node --test "test/importers/detect.test.js" 2>&1 | tail -5
```

- [ ] **Commit**

```bash
git add src/importers/detect.js test/importers/detect.test.js
git commit -m "feat: add import format detector"
```

---

### Task 16: Text, Anamnesis export, OpenClaw/Hermes adapters

**Files:**
- Create: `src/importers/text.js`
- Create: `src/importers/anamnesis-export.js`
- Create: `src/importers/openclaw.js`

- [ ] **Implement all three**

```js
// src/importers/text.js
'use strict';
// Plain text or markdown — pass through as-is
function extract(buf) { return { text: buf.toString('utf8'), direct: false }; }
module.exports = { extract };
```

```js
// src/importers/openclaw.js
'use strict';
// OpenClaw / Hermes SOUL.md — also plain text passthrough
function extract(buf) { return { text: buf.toString('utf8'), direct: false }; }
module.exports = { extract };
```

```js
// src/importers/anamnesis-export.js
'use strict';
/**
 * Anamnesis own export format — returns structured data for direct DB restore.
 * No LLM pass needed; restores memcells/scenes/foresights directly.
 */
function extract(buf) {
  const data = JSON.parse(buf.toString('utf8'));
  if (!data.anamnesis_export) throw new Error('not an anamnesis export file');
  const supported = [1];
  if (!supported.includes(data.version)) throw new Error(`unsupported export version ${data.version}`);
  return { text: null, direct: true, data };
}
module.exports = { extract };
```

- [ ] **Commit**

```bash
git add src/importers/text.js src/importers/openclaw.js src/importers/anamnesis-export.js
git commit -m "feat: add text, openclaw, and anamnesis-export import adapters"
```

---

### Task 17: Odysseus and Character.AI adapters

**Files:**
- Create: `src/importers/odysseus.js`
- Create: `src/importers/characterai.js`
- Create: `test/importers/odysseus.test.js`
- Create: `test/importers/characterai.test.js`

- [ ] **Write failing tests**

```js
// test/importers/odysseus.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('../../src/importers/odysseus.js');

test('extracts memories as direct memcells', () => {
  const data = {
    memories: [
      { id: 'a1', text: 'user likes coffee', timestamp: 1000, session_id: 's1' },
      { id: 'a2', text: 'user works at night', timestamp: 2000, session_id: 's1' },
    ],
  };
  const result = extract(Buffer.from(JSON.stringify(data)));
  assert.equal(result.direct, true);
  assert.equal(result.data.memcells.length, 2);
  assert.equal(result.data.memcells[0].content, 'user likes coffee');
});

test('returns summary text for preview', () => {
  const data = { memories: [{ id: 'x', text: 'hello', timestamp: 1000, session_id: 's' }] };
  const result = extract(Buffer.from(JSON.stringify(data)));
  assert.ok(result.summary.includes('1 memor'));
});
```

```js
// test/importers/characterai.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('../../src/importers/characterai.js');

test('flattens participants and histories to text', () => {
  const data = {
    participants: [{ name: 'Aria' }],
    histories: { histories: [{ msgs: [
      { src: { is_human: false, name: 'Aria' }, text: 'Hello!' },
      { src: { is_human: true,  name: 'User' }, text: 'Hi!' },
    ]}]},
  };
  const result = extract(Buffer.from(JSON.stringify(data)));
  assert.equal(result.direct, false);
  assert.ok(result.text.includes('Aria'));
  assert.ok(result.text.includes('Hello!'));
});
```

- [ ] **Run — expect FAIL**

```bash
node --test "test/importers/odysseus.test.js" "test/importers/characterai.test.js" 2>&1 | tail -10
```

- [ ] **Implement adapters**

```js
// src/importers/odysseus.js
'use strict';

function extract(buf) {
  const data = JSON.parse(buf.toString('utf8'));
  const memories = data.memories || [];
  const memcells = memories.map(m => ({
    content:    m.text,
    category:   'other',
    decay_score: 1.0,
    created_at: m.timestamp || Math.floor(Date.now() / 1000),
    session_key: m.session_id || 'imported',
  }));
  const summary = `${memcells.length} memor${memcells.length === 1 ? 'y' : 'ies'} from Odysseus export`;
  return { text: null, direct: true, summary, data: { memcells } };
}

module.exports = { extract };
```

```js
// src/importers/characterai.js
'use strict';

function extract(buf) {
  const data = JSON.parse(buf.toString('utf8'));
  const lines = [];

  // Participant names
  if (data.participants) {
    lines.push('Characters: ' + data.participants.map(p => p.name).join(', '));
  }

  // Chat histories
  const histories = data.histories?.histories || [];
  for (const h of histories) {
    for (const msg of (h.msgs || [])) {
      const speaker = msg.src?.name || (msg.src?.is_human ? 'User' : 'Character');
      lines.push(`${speaker}: ${msg.text}`);
    }
  }

  return { text: lines.join('\n'), direct: false };
}

module.exports = { extract };
```

- [ ] **Run — expect PASS**

```bash
node --test "test/importers/odysseus.test.js" "test/importers/characterai.test.js" 2>&1 | tail -10
```

- [ ] **Commit**

```bash
git add src/importers/odysseus.js src/importers/characterai.js \
        test/importers/odysseus.test.js test/importers/characterai.test.js
git commit -m "feat: add Odysseus and Character.AI import adapters"
```

---

### Task 18: SillyTavern PNG card adapter

Extracts the base64 JSON payload embedded in the `tEXt` PNG chunk with keyword `chara`. No extra dependencies — pure Buffer parsing.

**Files:**
- Create: `src/importers/sillytavern.js`
- Create: `test/importers/sillytavern.test.js`

- [ ] **Write failing tests**

```js
// test/importers/sillytavern.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract, extractCharaFromPng } = require('../../src/importers/sillytavern.js');

// Build a minimal fake PNG with a tEXt chunk containing 'chara\0<base64>'
function makeFakePng(charData) {
  const PNG_HEADER = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const b64 = Buffer.from(JSON.stringify(charData)).toString('base64');
  const keyword = 'chara';
  const payload = Buffer.concat([Buffer.from(keyword + '\0'), Buffer.from(b64)]);
  const type = Buffer.from('tEXt');
  const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
  // CRC is 4 bytes — we don't actually verify it in extract, so zeros are fine
  const crc = Buffer.alloc(4);
  const chunk = Buffer.concat([len, type, payload, crc]);
  return Buffer.concat([PNG_HEADER, chunk]);
}

test('extractCharaFromPng returns parsed character JSON', () => {
  const charData = { name: 'Aria', description: 'A cool character', personality: 'witty' };
  const png = makeFakePng(charData);
  const result = extractCharaFromPng(png);
  assert.deepEqual(result, charData);
});

test('extract returns text representation of character', () => {
  const charData = { name: 'Aria', description: 'cool', personality: 'witty', scenario: 'sci-fi', mes_example: '' };
  const png = makeFakePng(charData);
  const result = extract(png);
  assert.equal(result.direct, false);
  assert.ok(result.text.includes('Aria'));
  assert.ok(result.text.includes('cool'));
});

test('extract throws on PNG without chara chunk', () => {
  const PNG_HEADER = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  assert.throws(() => extract(PNG_HEADER), /no chara/i);
});
```

- [ ] **Run — expect FAIL**

```bash
node --test "test/importers/sillytavern.test.js" 2>&1 | tail -5
```

- [ ] **Implement `src/importers/sillytavern.js`**

```js
'use strict';

const PNG_HEADER = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);

/**
 * Walk PNG chunks and find the tEXt chunk with keyword 'chara'.
 * PNG chunk layout: 4-byte length | 4-byte type | <length> bytes data | 4-byte CRC
 */
function extractCharaFromPng(buf) {
  if (!buf.slice(0, 8).equals(PNG_HEADER)) throw new Error('not a PNG file');
  let offset = 8;
  while (offset < buf.length - 12) {
    const len  = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString('ascii');
    const data = buf.slice(offset + 8, offset + 8 + len);
    offset += 12 + len;

    if (type === 'tEXt') {
      const nullIdx = data.indexOf(0);
      if (nullIdx === -1) continue;
      const keyword = data.slice(0, nullIdx).toString('ascii');
      if (keyword !== 'chara') continue;
      const b64 = data.slice(nullIdx + 1).toString('ascii');
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    }
  }
  throw new Error('no chara tEXt chunk found in PNG — not a SillyTavern character card');
}

function extract(buf) {
  const char = extractCharaFromPng(buf);
  const lines = [];
  if (char.name)        lines.push(`Name: ${char.name}`);
  if (char.description) lines.push(`Description: ${char.description}`);
  if (char.personality) lines.push(`Personality: ${char.personality}`);
  if (char.scenario)    lines.push(`Scenario: ${char.scenario}`);
  if (char.mes_example) lines.push(`Example messages:\n${char.mes_example}`);
  if (char.system_prompt) lines.push(`System: ${char.system_prompt}`);
  // Include any extra fields
  for (const [k, v] of Object.entries(char)) {
    if (!['name','description','personality','scenario','mes_example','system_prompt','spec','spec_version'].includes(k)) {
      if (typeof v === 'string' && v.trim()) lines.push(`${k}: ${v}`);
    }
  }
  return { text: lines.join('\n\n'), direct: false };
}

module.exports = { extract, extractCharaFromPng };
```

- [ ] **Run — expect PASS**

```bash
node --test "test/importers/sillytavern.test.js" 2>&1 | tail -5
```

- [ ] **Commit**

```bash
git add src/importers/sillytavern.js test/importers/sillytavern.test.js
git commit -m "feat: add SillyTavern PNG card importer — extracts chara tEXt chunk"
```

---

### Task 19: Import orchestrator (`src/importers/index.js`)

**Files:**
- Create: `src/importers/index.js`

Ties together format detection, extraction, LLM understanding, and DB writing.

- [ ] **Implement `src/importers/index.js`**

```js
'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const os      = require('os');

const { detectFormat } = require('./detect.js');
const { chat }         = require('../lib/ollama.js');
const log              = require('../lib/logger.js').make('importer');

const ADAPTERS = {
  'text':            require('./text.js'),
  'openclaw':        require('./openclaw.js'),
  'anamnesis-export': require('./anamnesis-export.js'),
  'odysseus':        require('./odysseus.js'),
  'characterai':     require('./characterai.js'),
  'sillytavern':     require('./sillytavern.js'),
};

async function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function loadSource(source) {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    log.info(`fetching ${source}...`);
    return { filename: path.basename(new URL(source).pathname) || 'download', buf: await fetchUrl(source) };
  }
  if (!fs.existsSync(source)) throw new Error(`file not found: ${source}`);
  return { filename: path.basename(source), buf: fs.readFileSync(source) };
}

const EXTRACT_PROFILE_PROMPT = `You are extracting a character profile from source material.
Return ONLY valid JSON with these fields (all optional, omit if unknown):
{ "name": string, "personality": string, "speaking_style": string, "backstory": string, "relationships": string, "other": string }
No markdown fences. No explanation.`;

async function llmExtract(text, ollamaUrl = 'http://127.0.0.1:11434', model = 'qwen3:0.6b') {
  const messages = [
    { role: 'system', content: EXTRACT_PROFILE_PROMPT },
    { role: 'user',   content: text.slice(0, 12000) },
  ];
  const timeoutMs = 30000;
  const result = await Promise.race([
    chat(ollamaUrl, model, messages, false),
    new Promise((_, rej) => setTimeout(() => rej(new Error('LLM extraction timed out after 30s')), timeoutMs)),
  ]);
  try { return JSON.parse(result); } catch { return { other: result }; }
}

/**
 * Main import pipeline: load → detect → extract → (llm or direct) → return results
 */
async function importSources(sources, extraDescription = '') {
  const textParts  = [];
  const directData = [];
  const summaries  = [];

  // Validate all sources first
  for (const src of sources) {
    if (!src.startsWith('http://') && !src.startsWith('https://') && !fs.existsSync(src)) {
      throw new Error(`file not found: ${src}`);
    }
  }

  for (const src of sources) {
    const { filename, buf } = await loadSource(src);
    const format = detectFormat(filename, buf);
    const adapter = ADAPTERS[format] || ADAPTERS['text'];
    log.info(`${filename} → ${format}`);

    const result = adapter.extract(buf);
    if (result.direct) {
      directData.push(result.data);
      if (result.summary) summaries.push(result.summary);
    } else {
      textParts.push(result.text);
    }
  }

  if (extraDescription) textParts.push(extraDescription);

  let profile = null;
  if (textParts.length > 0) {
    const combined = textParts.join('\n\n---\n\n');
    log.info('running LLM extraction...');
    profile = await llmExtract(combined);
  }

  return { profile, directData, summaries, hasText: textParts.length > 0 };
}

/**
 * Write imported data into a character's history DB.
 */
function writeToDb(characterName, { profile, directData }) {
  const dbPath = path.join(os.homedir(), '.anamnesis', 'characters', characterName, 'history.db');
  if (!fs.existsSync(dbPath)) return; // character not yet started — skip

  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const insert = db.prepare(`
    INSERT OR IGNORE INTO memcells (session_key, content, decay_score, created_at)
    VALUES (?, ?, ?, ?)
  `);

  const importMany = db.transaction((cells) => {
    for (const cell of cells) {
      insert.run(cell.session_key || 'imported', cell.content, cell.decay_score || 1.0, cell.created_at || Math.floor(Date.now()/1000));
    }
  });

  for (const d of directData) {
    if (d.memcells) importMany(d.memcells);
  }

  db.close();
}

/** CLI entry: anamnesis import <sources...> [--into name] [--description text] [--yes] */
async function runCli(args) {
  const sources = [];
  let intoName = null;
  let description = '';
  let yes = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--into')         intoName    = args[++i];
    else if (args[i] === '--description') description = args[++i];
    else if (args[i] === '--yes')     yes = true;
    else sources.push(args[i]);
  }

  if (!sources.length) { console.error('usage: anamnesis import <file|url> [...] [--into name]'); process.exit(1); }

  console.log(`\nimporting ${sources.length} source(s)...\n`);
  const result = await importSources(sources, description);

  if (result.hasText && result.profile) {
    console.log('\nExtracted profile preview:');
    console.log(JSON.stringify(result.profile, null, 2));
  }
  if (result.summaries.length) {
    for (const s of result.summaries) console.log(`  ${s}`);
  }

  if (!yes) {
    const prompts = require('prompts');
    const { ok } = await prompts({ type: 'confirm', name: 'ok', message: 'Import this?', initial: true });
    if (!ok) { console.log('aborted'); return; }
  }

  if (intoName) {
    writeToDb(intoName, result);
    console.log(`\n✓ imported into '${intoName}'`);
  } else {
    console.log('\nNo --into specified. Use --into <name> to merge into an existing character, or run anamnesis new to create one.');
  }
}

/** Wizard integration: interactive source collection */
async function runWizard({ name }) {
  const prompts = require('prompts');
  const { sourceLine } = await prompts({ type: 'text', name: 'sourceLine', message: 'Files or URLs (space-separated):' });
  const sources = (sourceLine || '').split(/\s+/).filter(Boolean);
  const { desc } = await prompts({ type: 'text', name: 'desc', message: 'Add a written description? (optional):' });
  return { sources, description: desc || '' };
}

/** Import sources into a named character after wizard creation */
async function importInto(name, sources, description) {
  const result = await importSources(sources, description);
  writeToDb(name, result);
}

module.exports = { importSources, writeToDb, runCli, runWizard, importInto };
```

- [ ] **Smoke-test orchestrator compiles**

```bash
node -e "require('./src/importers/index.js'); console.log('ok')"
```

- [ ] **Run full test suite**

```bash
npm test 2>&1 | tail -10
```

- [ ] **Commit**

```bash
git add src/importers/index.js
git commit -m "feat: add import orchestrator — format detection, LLM extraction, direct DB restore"
```

---

## Chunk 6: Migration + Installers

Migration from v0.4, Linux/Mac installer, Windows installer.

### File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/migrator.js` | Detect v0.4 layout, migrate to v0.5 |
| Modify | `src/daemon.js` | Call migrator on startup if needed |
| Create | `install.sh` | Linux/Mac one-liner installer |
| Create | `install.ps1` | Windows PowerShell one-liner installer |

---

### Task 20: `src/migrator.js` — v0.4 → v0.5 migration

**Files:**
- Create: `src/migrator.js`

- [ ] **Implement `src/migrator.js`**

```js
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ANAMNESIS_DIR  = path.join(os.homedir(), '.anamnesis');
const REGISTRY_PATH  = path.join(ANAMNESIS_DIR, 'registry.json');
const OLD_DB_PATH    = path.join(ANAMNESIS_DIR, 'history.db');

// v0.4 config.json lived at the repo root
function findOldConfig() {
  // Try common install locations
  const candidates = [
    path.join(os.homedir(), 'anamnesis', 'config.json'),
    path.join('/opt', 'anamnesis', 'config.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { path: c, config: JSON.parse(fs.readFileSync(c, 'utf8')) };
  }
  return null;
}

function needsMigration() {
  // v0.5 registry exists → already migrated
  if (fs.existsSync(REGISTRY_PATH)) return false;
  // Old DB exists → needs migration
  if (fs.existsSync(OLD_DB_PATH)) return true;
  const old = findOldConfig();
  return !!old;
}

function migrate(log) {
  const old = findOldConfig();
  const characterName = 'default';
  const charDir = path.join(ANAMNESIS_DIR, 'characters', characterName);

  fs.mkdirSync(charDir, { recursive: true });
  log.info('migrating v0.4 layout to v0.5...');

  // Move old history.db
  if (fs.existsSync(OLD_DB_PATH)) {
    const newDbPath = path.join(charDir, 'history.db');
    fs.renameSync(OLD_DB_PATH, newDbPath);
    log.info(`moved history.db → characters/${characterName}/history.db`);
  }

  // Build per-character config from old config
  let charConfig;
  if (old) {
    charConfig = { ...old.config };
    charConfig.history = { ...charConfig.history, dbPath: path.join(charDir, 'history.db') };
  } else {
    // Minimal fallback
    charConfig = {
      proxy: { port: 8084, host: '127.0.0.1' },
      upstream: { baseUrl: 'http://127.0.0.1:8083/v1', apiKey: 'localqwen', disableThinking: true },
      history: { dbPath: path.join(charDir, 'history.db'), maxAgeDays: 90 },
    };
  }

  fs.writeFileSync(path.join(charDir, 'config.json'), JSON.stringify(charConfig, null, 2));

  // Write registry
  const registry = { characters: [{ name: characterName, port: charConfig.proxy?.port || 8084, active: false }] };
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));

  // Disable legacy systemd unit
  try {
    const { execSync } = require('child_process');
    execSync('systemctl stop anamnesis 2>/dev/null; systemctl disable anamnesis 2>/dev/null; true', { shell: true, stdio: 'pipe' });
    log.info('disabled legacy anamnesis.service');
  } catch { /* not on systemd or already removed */ }

  log.info(`migration complete — character '${characterName}' created from v0.4 data`);
  log.info(`start it with: anamnesis start ${characterName}`);
}

module.exports = { needsMigration, migrate };
```

- [ ] **Wire migration into `src/daemon.js`**

At the top of `main()` in `src/daemon.js`, before `const registry = new Registry(...)`:

```js
const { needsMigration, migrate } = require('./migrator.js');
if (needsMigration()) migrate(log);
```

- [ ] **Commit**

```bash
git add src/migrator.js src/daemon.js
git commit -m "feat: add v0.4→v0.5 migration — auto-detects old layout, imports as 'default' character"
```

---

### Task 21: `install.sh` — Linux/Mac one-liner installer

**Files:**
- Modify: `install.sh` (replace existing service-oriented script with a PATH-focused one; `anamnesis install` handles the service separately)

- [ ] **Rewrite `install.sh`**

```bash
#!/usr/bin/env bash
# install.sh — install the anamnesis CLI on Linux or macOS.
# Does NOT register a system service — run `anamnesis install` for that.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Fleabag515/anamnesis/main/install.sh | bash

set -euo pipefail

REPO="https://github.com/Fleabag515/anamnesis.git"
INSTALL_DIR="${ANAMNESIS_INSTALL_DIR:-$HOME/.local/share/anamnesis}"
BIN_DIR="${ANAMNESIS_BIN_DIR:-$HOME/.local/bin}"
MIN_NODE_MAJOR=18

# ─── Colour helpers ──────────────────────────────────────────────────────────
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; >&2; }

# ─── Locate / install Node ───────────────────────────────────────────────────
find_node() {
  # Prefer NVM LTS
  local nvm_root="${NVM_DIR:-$HOME/.nvm}"
  if [ -d "$nvm_root/versions/node" ]; then
    local pick
    pick="$(ls -1 "$nvm_root/versions/node" | grep -E '^v[0-9]*[02468]\.' | sort -V | tail -1 || true)"
    if [ -n "$pick" ] && [ -x "$nvm_root/versions/node/$pick/bin/node" ]; then
      echo "$nvm_root/versions/node/$pick/bin/node"; return
    fi
  fi
  command -v node 2>/dev/null || true
}

NODE_BIN="$(find_node)"
if [ -z "$NODE_BIN" ]; then
  yellow "Node.js not found — installing via nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install --lts
  NODE_BIN="$(find_node)"
fi

node_major="$("$NODE_BIN" -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  red "Node $node_major found but $MIN_NODE_MAJOR+ required. Install Node $MIN_NODE_MAJOR+ and retry."
  exit 1
fi

NPM_BIN="$(dirname "$NODE_BIN")/npm"
green "Node $("$NODE_BIN" --version) at $NODE_BIN"

# ─── Clone or update repo ────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  yellow "Updating existing install at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  yellow "Installing to $INSTALL_DIR..."
  git clone --depth=1 "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
"$NPM_BIN" install --omit=dev --silent

# ─── Create wrapper script on PATH ──────────────────────────────────────────
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/anamnesis" << WRAPPER
#!/usr/bin/env bash
exec "$NODE_BIN" "$INSTALL_DIR/src/cli.js" "\$@"
WRAPPER
chmod +x "$BIN_DIR/anamnesis"

# ─── Ensure BIN_DIR is on PATH ──────────────────────────────────────────────
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    if [ -f "$rc" ]; then
      echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$rc"
      yellow "Added $BIN_DIR to PATH in $rc"
      break
    fi
  done
fi

echo ""
green "✓ anamnesis installed"
echo "  Run: anamnesis new       — create your first character"
echo "  Run: anamnesis install   — register as a system service (optional)"
echo ""
echo "  If 'anamnesis' is not found, open a new terminal or run:"
echo "    export PATH=\"\$PATH:$BIN_DIR\""
```

- [ ] **Commit**

```bash
git add install.sh
git commit -m "feat: rewrite install.sh — PATH install only, service registration via anamnesis install"
```

---

### Task 22: `install.ps1` — Windows PowerShell installer

**Files:**
- Create: `install.ps1`

- [ ] **Implement `install.ps1`**

```powershell
# install.ps1 — install the anamnesis CLI on Windows.
# Run in PowerShell: irm https://raw.githubusercontent.com/Fleabag515/anamnesis/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'
$RepoUrl    = 'https://github.com/Fleabag515/anamnesis/archive/refs/heads/main.zip'
$InstallDir = "$env:LOCALAPPDATA\anamnesis"
$BinDir     = "$env:LOCALAPPDATA\anamnesis\bin"

Write-Host "`n✨ Installing anamnesis...`n" -ForegroundColor Cyan

# ─── Check / install Node ─────────────────────────────────────────────────────
$NodeBin = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $NodeBin) {
    Write-Host "Node.js not found — installing via winget..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
    $NodeBin = (Get-Command node).Source
}

$NodeVersion = & node --version
Write-Host "Node $NodeVersion found" -ForegroundColor Green

# ─── Download + extract ──────────────────────────────────────────────────────
$TmpZip = "$env:TEMP\anamnesis.zip"
Write-Host "Downloading..."
Invoke-WebRequest -Uri $RepoUrl -OutFile $TmpZip -UseBasicParsing

if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
Expand-Archive -Path $TmpZip -DestinationPath $env:TEMP -Force
Move-Item "$env:TEMP\anamnesis-main" $InstallDir -Force
Remove-Item $TmpZip

# ─── Install dependencies ─────────────────────────────────────────────────────
Set-Location $InstallDir
npm install --omit=dev --silent

# ─── Create wrapper batch file ───────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Wrapper = "@echo off`r`nnode `"$InstallDir\src\cli.js`" %*"
Set-Content -Path "$BinDir\anamnesis.cmd" -Value $Wrapper

# ─── Add to user PATH ─────────────────────────────────────────────────────────
$UserPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
if ($UserPath -notlike "*$BinDir*") {
    [System.Environment]::SetEnvironmentVariable('Path', "$UserPath;$BinDir", 'User')
    Write-Host "Added $BinDir to user PATH" -ForegroundColor Yellow
}

Write-Host "`n✓ anamnesis installed" -ForegroundColor Green
Write-Host "  Restart your terminal, then run: anamnesis new"
Write-Host "  To register as a Windows Service (run as Administrator): anamnesis install`n"
```

- [ ] **Commit**

```bash
git add install.ps1
git commit -m "feat: add Windows PowerShell installer"
```

---

### Task 23: Final verification

- [ ] **Run full test suite — all passing**

```bash
cd /home/fleabag/anamnesis
npm test 2>&1 | tail -15
```

Expected: all tests pass, no failures.

- [ ] **Smoke-test: daemon starts, character created via CLI**

```bash
# Start daemon
node src/daemon.js &
DAEMON_PID=$!
sleep 1

# Check status
node src/cli.js status

# Verify control API
curl -s http://127.0.0.1:9000/characters | python3 -m json.tool

# Tear down
kill $DAEMON_PID
```

- [ ] **Verify install.sh is executable and passes shellcheck (if available)**

```bash
chmod +x install.sh
shellcheck install.sh 2>/dev/null && echo "shellcheck ok" || echo "shellcheck not installed — skip"
```

- [ ] **Final commit**

```bash
git tag v0.5.0
git push origin main --tags
```
