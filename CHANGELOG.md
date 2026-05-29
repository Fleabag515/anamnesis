# Changelog

All notable changes to this project are documented in this file.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0-alpha] — Unreleased

### Added (Phase α of Cognitive Loop — spec §12)

- `lessons` table + `memscenes.injection_score` column. Migration is
  additive; v0.4.0 DBs upgrade cleanly.
- `src/distiller.js` — background job that distils clusters of related
  scenes into generalised lessons. Silent population in α; no injection
  yet. LESSON_PROMPT pinned byte-identical to spec §5.3.
- `src/scaffold.js` — reasoning scaffold module: `isTrivial` (tier
  classification), `planBlock` (plan injection), `toolReflectionBlock`
  (post-tool-result reflection). Salvaged from the reasoning-proxy
  postmortem without re-enabling Qwen3 extended thinking.
- `cognitive.{lessons,reward,selector,scaffold}` config blocks.
  Phase-α-active keys: `cognitive.lessons.*` and `cognitive.scaffold.*`.
- Status endpoint adds `lessons` and `lessons_active` fields.
- Tests: `scaffold.test.js`, `distiller.test.js`,
  `test/integration/scaffold-gate.test.js`,
  `test/integration/status-endpoint.test.js`,
  `test/integration/v04-compat.test.js`.

### Compatibility

- v0.4.0 `config.json` (no `cognitive.*` block) boots unchanged.
- v0.4.0 DB schema migrates additively. No column or table is removed
  or has its type changed (§15).

## [0.3.0] — Unreleased

### Fixed

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
