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

- A **control server** listens on `127.0.0.1:9000` — a small REST API the CLI uses
- Each active character runs its own `http.Server` instance bound to its assigned port
- All characters share the Ollama/embedding connection pool (resource efficiency)

The daemon is registered as:
- **Linux**: systemd unit (`anamnesis.service`)
- **Windows**: Windows Service via `node-windows`

### 2.2 Data Layout

```
~/.anamnesis/
  registry.json                  ← all known characters, active state, ports
  characters/
    <name>/
      config.json                ← per-character: upstream URL, port, persona settings
      history.db                 ← per-character: turns, memcells, scenes, foresights
```

`registry.json` is the source of truth for the CLI. The daemon reads it on startup and reactivates characters that were active when it last stopped.

### 2.3 Control API (port 9000)

Internal REST API consumed only by the CLI:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/characters` | List all characters + status |
| POST | `/characters/:name/start` | Activate character, bind its port |
| POST | `/characters/:name/stop` | Deactivate character, release port |
| GET | `/characters/:name` | Character details + memory stats |
| DELETE | `/characters/:name` | Delete character + all data |
| GET | `/status` | Daemon health, uptime, active count |
| GET | `/characters/:name/logs` | Recent log lines for a character |

---

## 3. Installer

Three installation paths, all landing the same end state: `anamnesis` available as a CLI command.

### 3.1 Linux / Mac (curl)
```bash
curl -fsSL https://raw.githubusercontent.com/Fleabag515/anamnesis/main/install.sh | bash
```
- Detects Node 18+ (installs via nvm if missing)
- Clones repo to `~/.anamnesis-bin/` (or `/opt/anamnesis`)
- Runs `npm install --omit=dev`
- Symlinks `anamnesis` binary onto PATH

### 3.2 Windows (PowerShell)
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
- Works on all platforms for users who already have Node 18+
- No shell script required

### 3.4 Post-install

All three paths end the same way — `anamnesis` is on PATH but the daemon is not yet a service. The user runs `anamnesis install` when they want it to persist across reboots. This separation keeps the installer simple and non-intrusive.

---

## 4. CLI Commands

All commands send requests to the daemon's control port. If the daemon isn't running when a command is issued, the CLI starts it automatically.

```
anamnesis                        # start daemon; runs first-launch wizard if unconfigured
anamnesis new [name]             # create a new character (interactive wizard)
anamnesis list, ls               # list all characters with ports and active/inactive status
anamnesis start, run <name>      # activate character — start listening on its port
anamnesis stop, kill <name>      # deactivate character — release its port
anamnesis restart <name>         # stop + start
anamnesis show <name>            # character details: profile, port, memory stats, upstream
anamnesis edit <name>            # re-run interactive config pre-filled with current values
anamnesis remove, rm <name>      # delete character and all its memories (with confirmation)
anamnesis import <sources...>    # import character/memories (see Section 6)
anamnesis export <name>          # export character profile + memories to a portable file
anamnesis logs <name>            # tail live logs for a character
anamnesis status, ps             # daemon health, all active characters and their ports
anamnesis install                # register daemon as system service (systemd / Windows Service)
anamnesis uninstall              # remove system service registration (data is preserved)
```

### Flag convention

All interactive commands accept flags for scripting:
```bash
anamnesis new --name mark --port 8084 --upstream http://127.0.0.1:8083/v1 --key localqwen --blank
anamnesis new --name aria --port 8085 --upstream http://127.0.0.1:8083/v1 --description "sarcastic British hacker"
anamnesis import soul.md --into mark --yes   # --yes skips confirmation prompts
```

---

## 5. Character Creation Wizard

`anamnesis new` (or `anamnesis new <name>`) runs an interactive wizard. Each prompt is pre-answered with a sensible default; the user can accept or override.

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
? Files or URLs (space-separated, or drag and drop): soul.md card.png
? Add a written description? (optional): she's also a coffee addict

→ Detecting formats... soul.md (markdown), card.png (SillyTavern card)
→ Extracting... done
→ Running LLM understanding...

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
conversations over time — memcells, drift observations, and evolution
notes build up organically into whoever they become.

────────────────────────────────────────────────────────────────────────────
? Start mark now? (Y/n)
✓ mark is running on http://127.0.0.1:8084/v1
```

---

## 6. Import System

`anamnesis import` accepts any number of files and/or URLs, plus an optional written description, and optionally targets an existing character with `--into`.

```bash
anamnesis import soul.md memories.json https://example.com/card.png \
  --description "she's also a coffee addict" \
  --into mark
```

Can also be run against an active character mid-conversation — new facts are merged into the character's memcells immediately.

### 6.1 Stage 1 — Extraction (format-aware)

Each source is identified and its text payload extracted before the LLM sees it:

| Format | Detection | Extraction method |
|--------|-----------|-------------------|
| SillyTavern character card | `.png` with `chara` EXIF metadata | Decode base64 JSON from PNG metadata |
| Character.AI export | JSON with `participants`, `histories` keys | Parse JSON, flatten to text |
| Odysseus memory JSON | JSON with `memories[]` array | Map entries to text, timestamps preserved |
| OpenClaw / Hermes SOUL.md | Markdown with SOUL.md filename or OpenClaw markers | Read as-is |
| Anamnesis export | JSON with `anamnesis_export` key | Structured restore directly to DB |
| Plain text / markdown | Everything else | Read as-is |
| URL | Any of the above fetched from HTTP | Fetch, then run through format detection |

The extractor system is modular — each format is a small adapter (`src/importers/<format>.js`) that takes a buffer and returns a string. Adding support for a new format is adding one file.

### 6.2 Stage 2 — LLM Understanding

All extracted text is concatenated (along with any `--description` content) and passed to the model with a structured extraction prompt. The model returns a JSON character profile: name, personality traits, speaking style, backstory, relationships, any other relevant details.

The user sees a preview and confirms before anything is written to the DB. Memories from structured sources (Odysseus JSON, Anamnesis export) are loaded directly into the character's memcells rather than re-extracted, preserving their original fidelity.

---

## 7. Cross-Platform Service Management

| Platform | Service mechanism | Install command | Auto-start on boot |
|----------|------------------|-----------------|-------------------|
| Linux | systemd unit file | `anamnesis install` | Yes (systemctl enable) |
| Windows | Windows Service via `node-windows` | `anamnesis install` (run as Admin) | Yes |
| Any | Run in foreground | `anamnesis` | No (terminal only) |

`anamnesis uninstall` removes the service registration. Character data in `~/.anamnesis/` is never touched by install/uninstall.

---

## 8. What Stays the Same

The core proxy pipeline (memcell extraction, scene consolidation, foresight injection, persona drift/evolution, rolling token budget) is unchanged. The character's `config.json` contains the same tunables as the current `config.json` — token budget, recency turns, extraction model, embedding model, etc. — just scoped per character instead of global.

The `anamnesis edit <name>` command exposes these tunables interactively, pre-filled with current values.

---

## 9. Out of Scope (this version)

- Web UI / dashboard
- Character sharing / marketplace
- Cloud sync of memories
- Multi-user / auth on the control port
- macOS launchd service (foreground mode works on Mac; service install is Linux + Windows only)
