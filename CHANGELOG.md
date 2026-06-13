# Changelog

All notable changes to this project are documented in this file.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]
### Fixed
- `disableThinking: true` now also sends `reasoning: "off"` in the upstream request body,
  fixing abliterated Gemma 4 models where `enable_thinking: false` alone inserts an empty
  `<|channel>thought\n<channel|>` prefix that causes the model to loop indefinitely.
  The `reasoning` field is a llama.cpp per-request parameter; servers that don't recognise
  it silently ignore it, so this is safe for all backends including OpenAI-compatible ones.

 — Unreleased

### Added
- **Control API: `PATCH /characters/:name`** — update a character's config (deep-merged)
  at runtime via the daemon instead of editing `config.json` on disk. Backed by a new
  `CharacterManager.updateConfig(name, patch)` (persists + syncs the registry port; the
  caller restarts the proxy to apply). Fills the gap clients previously worked around.

### Fixed
- **`anamnesis edit <name>` crash**: `edit()` referenced an undefined `entry` when
  restarting an active character (ReferenceError). It now looks the character up first.
- **Log spam**: per-request outgoing-message dump moved from `info` to `debug`
  (kept `daemon.log` growing ~1 MB/session at the default level).
- Lint cleanup (unused vars, prefer-const).


### Fixed

- **Thinking-token contamination** (`stripThinkingTokens`): assistant responses
  are now stripped of internal-reasoning blocks before being stored in memory.
  Without this, models that emit thinking tokens inline in `content` —
  Gemma 4 (`<|channel>thought … <channel|>`) and Qwen3 / DeepSeek-R1
  (`<think> … </think>`) — would persist those tokens to the turn history,
  which caused the model to keep generating thinking blocks on every future
  turn. The stripping runs unconditionally (regardless of `disableThinking`)
  so a mis-configured upstream or a model that ignores `enable_thinking:false`
  can never corrupt the memory store. `stripThinkingTokens` lives in
  `lib/proxy-helpers.js` and is covered by twelve unit tests.
  The same stripping is also applied in `selector.js` when turns are
  read back out of the database for context injection, so contaminated
  rows written before this fix are silently sanitised on the way out
  without requiring a manual database migration.

- **Streaming**: SSE responses are now piped through to the client unbuffered.
  Previously every chunk was concatenated before the response head was sent,
  defeating `stream=true` entirely. Streamed assistant turns are now
  reconstructed from delta frames and persisted to memory like non-streamed ones.
- **Foresight extractor** no longer shares the `extracted` flag with the
  memcell extractor. A new `foresight_scanned` column on `turns` means each
  pipeline tracks its own state and can no longer starve the other.
- **Consolidator** uses a self-rescheduling `setTimeout` chain with a
  `_running` guard instead of `setInterval`. Slow Ollama calls can no longer
  cause overlapping consolidation runs on the same session.
- **Auth header**: an empty `upstream.apiKey` now means _passthrough_ — the
  client's own `Authorization` header reaches upstream. Previously it was
  silently stripped.
- **Hardcoded paths**: `config.json` ships `~/.anamnesis/history.db` and the
  proxy expands `~`, `$HOME`, `${HOME}` in any string value. `install.sh`
  picks the latest Node from `~/.nvm/versions/node` instead of pinning
  `v22.22.2`.

### Added

- `embedding_model` column on `turns`, `memcells`, and `memscenes`. Selector
  and consolidator skip vectors produced by a different model so similarity
  scores can't be silently meaningless after a model swap.
- `lib/ollama.js`, `lib/heuristics.js`, `lib/logger.js`, `lib/proxy-helpers.js`
  — shared modules consolidating duplicate HTTP/heuristic/log code that had
  drifted across extractor, foresight, embedder, and consolidator.
- `ANAMNESIS_LOG` environment variable (`error|warn|info|debug`) gates
  per-request selector tracing for production deployments.
- `node:test` suite with focused coverage of pure helpers (session keys,
  SSE accumulator, cosine, decay scoring, JSON-from-prose parsing).
- `.editorconfig`, `.prettierrc`, `eslint.config.js`, and a GitHub Actions
  workflow running tests and linting on Node 18/20/22.
- Top-level `LICENSE` (MIT) — the package.json had declared MIT for a while
  but the licence file itself was missing.

### Changed

- `install.sh` writes a unit named `anamnesis.service` (was
  `context-weaver.service`, a leftover from an earlier project).
- Session keys are now `auth:<sha256(token).slice(0,16)>` instead of the
  last 16 bytes of the bearer token verbatim. Same uniqueness guarantee,
  no credential bytes leaked into log lines or `session_key` rows.
- Consolidator now computes `avg_importance` from cluster members instead
  of always storing the default `0.5`.

## [0.2.0]

Initial public release with memcell + memscene + foresight pipeline.
