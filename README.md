# Anamnesis

_From Greek ἀνάμνησις — the deep recollection of what the mind already knows._

A self-organizing memory proxy for LLM agents. Inspired by EverMemOS-style
hierarchical memory (turn → memcell → memscene) with explicit foresight
extraction, Anamnesis sits between any OpenAI-compatible client and any
OpenAI-compatible backend and gives the model persistent, structured,
intelligently-retrieved memory across unlimited context and sessions.

## Architecture

```
client ──→ Anamnesis :8084 ──→ llama-server / Ollama / OpenAI / …
              │
              ├── turns       (raw episodic trace, SQLite)
              ├── memcells    (atomic facts extracted by LLM)
              ├── memscenes   (thematic clusters, self-organizing)
              ├── foresights  (extracted future intentions)
              └── decay       (intelligent forgetting via score decay)
```

### Memory pipeline

```
Turn received
    │
    ├─→ Store raw turn + embedding (sync, survives crashes)
    │
    └─→ [background] MemCell extraction       (extracted flag)
              │
              ├─→ Foresight scan in parallel  (foresight_scanned flag)
              │
              └─→ [periodic] MemScene consolidation
                      │
                      └─→ Decay scoring + pruning
```

### Retrieval (per request)

```
Query embedding
    │
    ├─→ Score all MemScenes by cosine similarity
    │       └─→ Expand top scenes → constituent turn IDs
    │               └─→ Rank by sim + importance, fill budget
    │
    └─→ Fallback: raw turn similarity (no scenes yet)

Final context window:
  [ system + <memory> + <foresight> ] + [ rotating relevant turns ] + [ last N turns verbatim ]
```

## What makes this different from a sliding window

|                       | Sliding window      | Anamnesis                               |
| --------------------- | ------------------- | --------------------------------------- |
| Old turns             | Dropped permanently | Stored forever, retrieved when relevant |
| Retrieval             | Recency only        | Scene-guided cosine similarity          |
| Memory structure      | Flat                | Hierarchical (turn → cell → scene)      |
| Forgetting            | Hard cutoff         | Soft decay by age + recall frequency    |
| Background processing | None                | MemCell + Foresight extraction          |
| Streaming             | Native              | Native SSE pass-through                 |

## Install

```bash
sudo bash install.sh
```

This installs an `anamnesis.service` systemd unit and starts it on port 8084.
Point your OpenAI-compatible client's `baseUrl` at `http://127.0.0.1:8084/v1`.

For a non-systemd run:

```bash
npm install
node src/proxy.js
# or, with watch reload:
npm run dev
```

## Config (`config.json`)

| Key                              | Default                             | Description                                                                     |
| -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| `proxy.port` / `proxy.host`      | `8084` / `127.0.0.1`                | Where Anamnesis listens                                                         |
| `upstream.baseUrl`               | `http://127.0.0.1:8083`             | Any OpenAI-compatible endpoint                                                  |
| `upstream.apiKey`                | `localqwen`                         | Bearer token sent upstream. Empty = passthrough of client's own `Authorization` |
| `upstream.disableThinking`       | `true`                              | Inject `chat_template_kwargs:{enable_thinking:false}` for Qwen3-style models    |
| `embedding.ollamaUrl` / `.model` | `:11434` / `nomic-embed-cpu:latest` | Ollama embedding endpoint                                                       |
| `extraction.model`               | `qwen3:0.6b`                        | Small LLM for memcell extraction                                                |
| `foresight.model`                | `qwen3:0.6b`                        | Small LLM for intention extraction                                              |
| `context.tokenBudget`            | `65536`                             | Total token budget given to upstream                                            |
| `context.recencyTurns`           | `8`                                 | Turn pairs always in context, verbatim                                          |
| `context.rotatingSlots`          | `6`                                 | Old turns added via scene retrieval                                             |
| `memory.consolidationIntervalMs` | `120000`                            | How often scenes are rebuilt                                                    |
| `memory.sceneClusterThreshold`   | `0.72`                              | Cosine sim threshold for clustering                                             |
| `memory.decayPruneThreshold`     | `0.05`                              | Score below which non-critical cells are pruned                                 |
| `history.dbPath`                 | `~/.anamnesis/history.db`           | SQLite path; supports `~`, `$HOME`, `${HOME}`                                   |
| `history.maxAgeDays`             | `90`                                | Raw turn retention                                                              |

### Environment

| Var             | Values                              | Notes                                                         |
| --------------- | ----------------------------------- | ------------------------------------------------------------- |
| `ANAMNESIS_LOG` | `error` / `warn` / `info` / `debug` | Default `info`. `debug` enables per-request selector tracing. |

## Status endpoint

```
GET http://127.0.0.1:8084/anamnesis/status
→ {
    "status": "ok",
    "turns": 142, "cells": 831, "scenes": 24, "foresights": 3,
    "upstream": "http://127.0.0.1:8083",
    "embedding_model": "nomic-embed-cpu:latest"
  }
```

## Development

```bash
npm test         # node:test suite over pure helpers
npm run lint     # ESLint flat config
npm run format   # Prettier --write
```

CI (`.github/workflows/ci.yml`) runs the same on every push.

## Roadmap

- [x] Streaming response storage (SSE pass-through + delta accumulation)
- [x] Foresight signals (predict likely future context needs)
- [x] Cognitive Loop α — lessons tier + reasoning scaffold (see [docs/specs/2026-05-24-cognitive-loop-design.md](docs/specs/2026-05-24-cognitive-loop-design.md))
- [ ] Cognitive Loop β/γ/1.0 — lesson injection, reward signal, hierarchical selector
- [ ] Cross-session scene merging
- [ ] Client plugin wrapper
- [ ] Web UI for browsing the memory graph

## License

[MIT](./LICENSE)
