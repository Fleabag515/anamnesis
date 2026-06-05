# Anamnesis v0.5 — Multi-Character CLI Design

**Date:** 2026-06-05  
**Status:** Approved  
**Scope:** One-liner installer, `anamnesis` CLI, multi-character daemon, character wizard, universal import system

---

## 1. Overview

Anamnesis v0.5 transforms the project from a manually-configured single-character proxy into a fully managed multi-character platform. A user installs it with one command, runs an interactive wizard to create characters, and points any OpenAI-compatible client at each character's dedicated port. No config file editing required.

---

## 2. Architecture

### 2.1 Daemon

One `anamnesis` Node.js process runs as a background system service. Inside it:

- A **control server** listens on `127.0.0.1:9000` (configurable, see 2.4) — a small REST API the CLI uses
- Each active character runs its own `http.Server` instance bound to its assigned port
- All characters share a **singleton `Embedder` instance** and a **singleton `http.Agent`** (`keepAlive: true`) injected into each character pipeline via constructor argument

The daemon is registered as:
- **Linux**: systemd unit (`anamnesis.service`)
- **Windows**: Windows Service via `node-windows`

### 2.2 Data Layout

```
~/.anamnesis/
  daemon.json                    ← daemon-level config (control port, etc.)
  daemon.pid                     ← written on start, deleted on clean exit
  registry.json                  ← all known characters, active state, ports
  characters/
    <name>/
      config.json                ← per-character: upstream URL, port, persona settings, tunables
      history.db                 ← per-character: turns, memcells, scenes, foresights
```

`registry.json` is the source of truth for the CLI. **Active state is written on every start/stop operation** (not only at shutdown), so the file is always current even if the daemon is killed with SIGKILL. On startup the daemon reactivates all characters whose `active` field is `true`.

If `~/.anamnesis/` does not exist, the daemon creates it (and `registry.json` with an empty characters array) on first launch. Every component that reads `registry.json` must handle the not-yet-initialized case by treating it as empty.

### 2.3 Control API (port 9000)

Internal REST API consumed only by the CLI. A minimal router (e.g. `find-my-way`, `trouter`, or a small hand-rolled dispatcher) handles the routes — raw `http` route parsing alone is not worth the boilerplate for 7 parameterized routes.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/characters` | List all characters + status |
| POST | `/characters/:name/start` | Activate character — bind its port |
| POST | `/characters/:name/stop` | Deactivate character — release port |
| GET | `/characters/:name` | Character details + memory stats |
| DELETE | `/characters/:name` | Stop (if running) + delete character + all data |
| GET | `/status` | Daemon health, uptime, active character count |
| GET | `/characters/:name/logs` | SSE stream of live log lines for a character |

### 2.4 Daemon Config (`~/.anamnesis/daemon.json`)

```json
{
  "controlPort": 9000
}
```

Created with defaults on first launch if absent. The control port is configurable here so users with a conflict on 9000 can move it.

---

## 3. Installer

Three installation paths, all landing the same end state: `anamnesis` available as a CLI command. The daemon is **not** registered as a service by any of these — that is done separately via `anamnesis install`.

### 3.1 Linux / Mac (curl)
```bash
curl -fsSL https://raw.githubusercontent.com/Fleabag515/anamnesis/main/install.sh | bash
```
- Detects Node 18+ (installs via nvm if missing)
- Clones repo (or downloads release archive)
- Runs `npm install --omit=dev`
- Symlinks `src/cli.js` onto PATH as `anamnesis`
- If a legacy `anamnesis.service` systemd unit exists (from v0.4), disables and removes it

### 3.2 Windows (PowerShell, run as Administrator)
```powershell
irm https://raw.githubusercontent.com/Fleabag515/anamnesis/main/install.ps1 | iex
```
- Checks for Node 18+ (installs via winget if missing)
- Downloads and extracts release archive
- Adds `anamnesis` to user PATH via registry

### 3.3 npm (all platforms)
```bash
npm install -g anamnesis
```
Works on all platforms for users who already have Node 18+. Requires a `"bin": { "anamnesis": "src/cli.js" }` field in `package.json` and a `#!/usr/bin/env node` shebang at the top of `src/cli.js`.

---

## 4. CLI Commands

The CLI (`src/cli.js`) is a thin client that talks to the daemon's control port. 

**Daemon startup handshake:** If the daemon is not running when a command is issued, the CLI forks `src/daemon.js` as a detached child, then polls `GET /status` on port 9000 at 200ms intervals for up to 5 seconds. If the daemon does not respond within 5 seconds, the CLI exits with an error: `"daemon failed to start — check logs at ~/.anamnesis/daemon.log"`. The PID file at `~/.anamnesis/daemon.pid` is checked before forking to avoid double-spawning.

**Note:** In a systemd-managed environment, if `anamnesis install` has been run, the daemon is managed by systemd. If port 9000 is unreachable after `anamnesis install`, the CLI prints: `"daemon not running — start it with 'anamnesis' or check 'systemctl status anamnesis'"` rather than auto-spawning (which would conflict with systemd management).

```
anamnesis                        # start daemon; runs setup wizard on first launch;
                                 # if daemon already running, prints status
anamnesis new [name]             # create a new character (interactive wizard)
anamnesis list, ls               # list all characters: name, port, active/inactive, memory count
anamnesis start, run <name>      # activate character — start listening on its port
anamnesis stop, kill <name>      # deactivate character — release its port
anamnesis restart <name>         # stop + start
anamnesis show <name>            # character details: profile, port, memory stats, upstream URL
anamnesis edit <name>            # re-run interactive config pre-filled with current values
anamnesis remove, rm <name>      # stop (if active) + delete character and all data (with confirmation)
anamnesis import <sources...>    # import character/memories (see Section 6)
anamnesis export <name>          # export character profile + memories to a portable JSON file
anamnesis logs <name>            # tail live SSE log stream for a character
anamnesis status, ps             # daemon health, all active characters and their ports
anamnesis install                # register daemon as system service (systemd / Windows Service)
anamnesis uninstall              # remove system service registration (data is preserved)
```

**Bare `anamnesis` behavior:**
- First launch (no `~/.anamnesis/` or empty registry): runs setup wizard, asks to create first character
- Daemon not running, registry exists: starts daemon, prints summary of known characters
- Daemon already running: prints same output as `anamnesis status`

### Editable fields in `anamnesis edit`

The edit wizard pre-fills all prompts with current values. Hitting enter keeps the existing value. Editable fields:

- Upstream model URL and API key
- Token budget, recency turns, rotating slots
- Extraction model, embedding model
- Persona settings (source type, drift threshold, evolution settings)
- Port — **if the character is active, changing the port stops it, rebinds to the new port, and restarts it**

### Flag convention

All interactive commands accept flags for non-interactive/scripting use:
```bash
anamnesis new --name mark --port 8084 --upstream http://127.0.0.1:8083/v1 --key localqwen --blank
anamnesis new --name aria --port 8085 --upstream http://127.0.0.1:8083/v1 --description "sarcastic British hacker"
anamnesis import soul.md --into mark --yes   # --yes skips all confirmation prompts
anamnesis remove mark --yes
```

---

## 5. Character Names

Character names must match `/^[a-z0-9_-]+$/i` (letters, digits, hyphens, underscores). This is enforced at creation time. Names are used as filesystem directory names and control API path segments — spaces, slashes, and special characters are rejected with a clear error.

Duplicate name detection: if `anamnesis new mark` is run and `mark` already exists in `registry.json`, the wizard immediately exits with: `"a character named 'mark' already exists — use 'anamnesis edit mark' to modify it"`.

---

## 6. Character Creation Wizard

`anamnesis new` (or `anamnesis new <name>`) runs an interactive wizard. Each prompt is pre-answered with a sensible default; the user can accept or override.

Port suggestion: the daemon's control API provides the next available port by scanning all ports already in `registry.json` and returning the next unused value starting from 8084.

```
? Character name: mark
? Port (suggested: 8084):
? Model endpoint URL: http://127.0.0.1:8083/v1
? API key: localqwen

? Character setup:
  ❯ Import from files or URLs
    Describe the character concept
    Start blank — let it develop on its own

─── Import ─────────────────────────────────────────────────────────────────
? Files or URLs (space-separated): soul.md card.png https://example.com/lore.md
? Add a written description? (optional): she's also a coffee addict

→ Validating sources... ✓ soul.md ✓ card.png ✓ https://example.com/lore.md
→ Detecting formats... soul.md (markdown), card.png (SillyTavern card), lore.md (plain text)
→ Extracting text payloads...
→ Running LLM extraction... (30s timeout — fails with actionable error if model unreachable)

  Preview:
  Name: Aria
  Personality: sardonic, quick-witted, caffeine-dependent
  Style: clipped sentences, dry humour, occasional British spelling
  Backstory: ...

? Accept this profile? (Y/n/edit)

─── Describe ───────────────────────────────────────────────────────────────
? Describe the character: a sarcastic British hacker who...
→ Extracting profile... (preview + confirm as above)

─── Blank ──────────────────────────────────────────────────────────────────
No profile injected. The character accumulates identity purely from
conversations over time.

────────────────────────────────────────────────────────────────────────────
? Start mark now? (Y/n)
✓ mark is running on http://127.0.0.1:8084/v1
```

---

## 7. Import System

### 7.1 Command

```bash
anamnesis import <file|url> [<file|url> ...] [--description "text"] [--into <name>]
```

Accepts multiple sources in one shot. `--into` merges into an existing character. Without `--into`, the user is asked to provide a character name and the command creates a new character (same flow as `anamnesis new` with import pre-selected). Writes to a running character's DB are serialized — if the character is active, the import is queued through the same write path as normal request processing to avoid SQLite contention.

### 7.2 Stage 1 — Extraction (format-aware)

All sources are validated before any extraction begins — missing files and unreachable URLs cause a fast-fail with a list of bad paths. Then each source is identified and its text payload extracted:

| Format | Detection | Extraction method |
|--------|-----------|-------------------|
| SillyTavern character card | `.png` with `chara` EXIF metadata | Decode base64 JSON from PNG metadata |
| Character.AI export | JSON with `participants` + `histories` keys | Parse JSON, flatten to text |
| Odysseus memory JSON | JSON with `memories[]` array | Map entries to text; **loaded directly into memcells, bypassing LLM** |
| OpenClaw / Hermes SOUL.md | Markdown, filename or OpenClaw markers | Read as-is |
| Anamnesis export | JSON with `anamnesis_export` key | **Restored directly to DB, bypassing LLM** (see 7.4) |
| Plain text / markdown | Everything else | Read as-is |
| URL | Any of the above fetched via HTTP | Fetch (200 required), then format detection |

The extractor system is modular — each format is a small adapter (`src/importers/<format>.js`) that takes a buffer and returns a string (or null for direct-DB formats). Adding a new format is adding one file.

### 7.3 Stage 2 — LLM Understanding

All plain-text payloads are concatenated (along with any `--description` content) and passed to the model with a structured extraction prompt (30-second timeout). The model returns a JSON character profile: name, personality traits, speaking style, backstory, relationships, and any other relevant details.

**For structured-source imports** (Odysseus JSON, Anamnesis export): no LLM pass is run. Instead, the user sees a data summary — record counts, date range, memory categories — and confirms before anything is written.

User sees a preview and confirms before any data is written to the DB.

### 7.4 Export Format

`anamnesis export <name>` produces a versioned JSON file:

```json
{
  "anamnesis_export": true,
  "version": 1,
  "exported_at": "<ISO timestamp>",
  "character": {
    "name": "mark",
    "config": { ... }
  },
  "profile": { ... },
  "memcells": [
    { "content": "...", "category": "personal", "decay_score": 0.9, "created_at": 1234567890 }
  ],
  "scenes": [ ... ],
  "foresights": [ ... ]
}
```

The `version` field is incremented if the schema changes. The importer checks `version` and errors on unsupported versions.

---

## 8. Port Conflict Resolution

Anamnesis handles port conflicts automatically without user intervention. There are four scenarios:

**Scenario 1 — Port taken by an external process**
When `anamnesis start <name>` catches `EADDRINUSE`, the daemon scans upward from the requested port (8084 → 8085 → 8086 …) until it finds a free port, binds there, updates the character's stored port in `registry.json`, and reports back: *"port 8084 was in use — started mark on 8085 instead."* The new port is persisted so subsequent starts use it automatically.

**Scenario 2 — Two characters with the same port in registry**
At daemon startup, before binding any character, all active characters are scanned for port collisions. Any duplicate is reassigned via the same auto-increment scan and its entry updated in `registry.json`. The user is informed of any reassignments in the startup log.

**Scenario 3 — Port taken by another active Anamnesis character**
Caught by scenario 2 at startup. If it occurs mid-session (two characters started in rapid succession), the second start catches `EADDRINUSE` and falls through to scenario 1.

**Scenario 4 — Port held after unclean daemon shutdown**
Non-issue: the OS releases TCP ports immediately when a process dies. On restart the port is free.

The net result: `anamnesis start <name>` never fails due to a port conflict — it always finds a free port and tells you where it landed.

---

## 9. Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Port already in use on `start` | Auto-increment to next free port, update registry, inform user (see Section 8) |
| Daemon not running, auto-start fails | CLI prints: "daemon failed to start — check ~/.anamnesis/daemon.log" |
| Daemon managed by systemd, not running | CLI prints: "daemon not running — start it with 'anamnesis' or check 'systemctl status anamnesis'" |
| Import file not found | Fast-fail before any extraction: lists all bad paths |
| Import URL returns non-200 | Fast-fail before any extraction |
| LLM unreachable during wizard | 30s timeout then: "model at <url> did not respond — check your upstream URL" |
| Character name already exists on `new` | "a character named '<name>' already exists — use 'anamnesis edit <name>' to modify it" |
| `anamnesis install` on Windows without elevation | Detects non-elevated execution and prints: "this command requires Administrator — right-click and 'Run as Administrator'" |
| `~/.anamnesis/` does not exist | Daemon creates it (and empty `registry.json`) on first launch |

---

## 9. Cross-Platform Service Management

| Platform | Mechanism | Install command | Auto-start on boot |
|----------|-----------|-----------------|-------------------|
| Linux | systemd unit file | `anamnesis install` | Yes (`systemctl enable`) |
| Windows | Windows Service via `node-windows` | `anamnesis install` (as Administrator) | Yes |
| Any | Run in foreground | `anamnesis` | No |

`anamnesis uninstall` removes the service registration. Character data in `~/.anamnesis/` is never touched by install or uninstall.

---

## 10. Implementation Notes

### Config injection refactor (significant)

The current codebase loads a single `config.json` from the repo root and passes it through as a module-level object. In v0.5, each character has its own `config.json`. **Every pipeline module** (`HistoryStore`, `Embedder`, `Selector`, `Extractor`, `ForesightExtractor`, `PersonaManager`, `Consolidator`) must accept config as a constructor argument rather than reading a global. This is the largest refactoring task in v0.5 — "what stays the same" refers to the logic and algorithms, not the module interfaces.

### Per-character DB connection

Each character's `HistoryStore` holds a single `better-sqlite3` connection as a singleton within the daemon. The connection is not opened per-request. Concurrent writes within a character (e.g., an import running while a chat request arrives) are serialized by the event loop; WAL mode handles concurrent reads without issue.

### Legacy migration (v0.4 → v0.5)

On first launch of v0.5, if a repo-root `config.json` exists and `registry.json` does not:
1. Read the existing config and detect the persona name (or use hostname as fallback)
2. Create a character entry using the existing config values
3. Move `~/.anamnesis/history.db` (or wherever `history.dbPath` pointed) into `~/.anamnesis/characters/<name>/history.db`
4. Write `registry.json` with that character as the single entry
5. Disable and remove the legacy `anamnesis.service` systemd unit if present

---

## 11. Out of Scope (this version)

- Web UI / dashboard
- Character sharing / marketplace
- Cloud sync of memories
- Multi-user / auth on the control port
- macOS launchd service (foreground mode works on Mac; service install is Linux + Windows only)
