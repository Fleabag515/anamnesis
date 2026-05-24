# Anamnesis

*From Greek ἀνάμνησις — the deep recollection of what the mind already knows.*

A self-organizing memory proxy for LLM agents. Inspired by [EverMemOS](https://arxiv.org/abs/2601.02163), Anamnesis gives Mark persistent, structured, intelligently-retrieved memory across unlimited context and sessions.

## Architecture

```
OpenClaw ──→ Anamnesis :8084 ──→ llama-server :8083
                 │
                 ├── turns       (raw episodic trace, SQLite)
                 ├── memcells    (atomic facts extracted by LLM)
                 ├── memscenes   (thematic clusters, self-organizing)
                 └── decay       (intelligent forgetting via score decay)
```

### Memory Pipeline

```
Turn received
    │
    ├─→ Store raw turn + embedding
    │
    └─→ [background] MemCell extraction (gemma4:e2b)
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
    │               └─→ Rank by sim + decay weight
    │
    └─→ Fallback: raw turn similarity (no scenes yet)

Final context window:
  [ system ] + [ rotating relevant turns ] + [ last 8 turns verbatim ]
```

## What makes this different from a sliding window

| | Sliding window | Anamnesis |
|---|---|---|
| Old turns | Dropped permanently | Stored forever, retrieved when relevant |
| Retrieval | Recency only | Scene-guided cosine similarity |
| Memory structure | Flat | Hierarchical (turn → cell → scene) |
| Forgetting | Hard cutoff | Soft decay by age + recall frequency |
| Background processing | None | MemCell extraction + scene consolidation |

## Install

```bash
sudo bash install.sh
```

Then point OpenClaw's `llamaserver.baseUrl` to `http://127.0.0.1:8084/v1`.

## Config (`config.json`)

| Key | Default | Description |
|-----|---------|-------------|
| `context.tokenBudget` | 65536 | Total token budget |
| `context.recencyTurns` | 8 | Turn pairs always in context |
| `context.rotatingSlots` | 6 | Old turns added via scene retrieval |
| `extraction.model` | `gemma4:e2b` | Ollama model for MemCell extraction |
| `memory.consolidationIntervalMs` | 120000 | How often scenes are rebuilt (ms) |
| `memory.sceneClusterThreshold` | 0.72 | Cosine sim threshold for clustering |
| `memory.decayPruneThreshold` | 0.05 | Score below which cells are pruned |
| `history.maxAgeDays` | 90 | Raw turn retention |

## Status

```
GET http://127.0.0.1:8084/anamnesis/status
→ { "status": "ok", "turns": 142, "cells": 831, "scenes": 24 }
```

## Roadmap

- [ ] Streaming response storage
- [ ] Foresight signals (predict likely future context needs)
- [ ] Cross-session scene merging
- [ ] OpenClaw plugin wrapper
- [ ] Web UI for browsing memory graph
