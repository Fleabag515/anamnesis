# Bundled Inference Engine — Design Spec

**Date:** 2026-06-06
**Feature:** v0.6 — Self-contained LLM + embedding inference, zero external dependencies

---

## Goal

Anamnesis currently requires Ollama running locally with two models pulled. This is a hard
dependency that most users won't have — and it means extraction silently fails until they
figure out what's missing. This feature removes that dependency entirely.

After this feature, Anamnesis is fully self-contained:
- No Ollama required
- No external services required beyond the upstream LLM the user is already chatting through
- On first run, two models download silently in the background
- Extraction queues until the models are ready, then drains automatically
- The user never has to configure, install, or think about inference

---

## What Changes

### Removed
- `src/lib/ollama.js` — Ollama-specific HTTP client
- All `require('./lib/ollama.js')` imports across the codebase
- `embedding.ollamaUrl` config key
- `extraction.ollamaUrl` config key (was implicit)

### Added
- `src/lib/brain.js` — unified inference interface, replaces ollama.js
- `src/lib/inference-engine.js` — node-llama-cpp wrapper for LLM tasks
- `src/lib/local-embedder.js` — @huggingface/transformers wrapper for embeddings
- `src/lib/model-manager.js` — GGUF download, cache, and integrity verification
- `src/lib/prompts.js` — all system prompts centralized in one file

### Modified (surgical, call-site only)
- `src/extractor.js` — `require('./lib/ollama')` → `require('./lib/brain')`
- `src/foresight.js` — same
- `src/consolidator.js` — same
- `src/persona.js` — same
- `src/importers/index.js` — same
- `src/embedder.js` — delegates `embed()` to `brain.embed()` instead of calling Ollama
- `src/lib/char-config.js` — remove `ollamaUrl` from defaults
- `src/proxy.js` — update brain initialization

---

## Models

### LLM — Qwen2.5-1.5B-Instruct Q4_K_M
- **Purpose:** Engram extraction, foresight, episode consolidation, persona drift/evolution, import parsing
- **Format:** GGUF (native llama.cpp format)
- **Source:** HuggingFace — `bartowski/Qwen2.5-1.5B-Instruct-GGUF`
- **File:** `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf`
- **Size:** ~900MB
- **Cache location:** `~/.anamnesis/models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf`

Qwen2.5-1.5B-Instruct is chosen for its reliable structured JSON output, which is the
primary requirement for all of Anamnesis's extraction tasks. Q4_K_M quantization gives
the best quality-per-size tradeoff at this scale.

### Embeddings — all-MiniLM-L6-v2
- **Purpose:** Embedding turns, engrams, and episode summaries for cosine similarity retrieval
- **Format:** ONNX (via @huggingface/transformers)
- **Source:** HuggingFace — `Xenova/all-MiniLM-L6-v2`
- **Size:** ~23MB (cached by transformers.js in `~/.cache/huggingface/`)
- **Runtime:** Pure WASM, CPU-only, no native compilation

This model is specifically trained for semantic sentence similarity, making it substantially
better for retrieval than using the LLM model for embeddings. Its small size (~23MB) means
it typically loads in under a second and adds negligible memory footprint.

---

## Architecture

### `src/lib/brain.js` — Unified Interface

The public API surface. Replaces `ollama.js` as the import target for all callers.
Exports identical function signatures so callers need only a one-line `require` change.

```js
// Public API — same signatures as ollama.js
brain.chat(messages, opts)           // → Promise<string>
brain.generate(prompt, opts)         // → Promise<string>
brain.embed(text)                    // → Promise<Float32Array | null>
brain.tryParseJsonArray(text)        // → Array | null  (pure utility, no change)
brain.tryParseJsonObject(text)       // → Object | null (pure utility, no change)

// Lifecycle
brain.init(config)                   // called once by daemon on startup
brain.isReady()                      // → boolean — true once models are loaded
```

Internally `brain.js` holds references to one `InferenceEngine` and one `LocalEmbedder`.
While the engine is loading/downloading, `chat()` and `generate()` queue calls internally
(max queue depth: 200, same as `startupBacklogLimit`). `embed()` returns `null` if not
ready (existing callers already handle null vectors gracefully).

### `src/lib/model-manager.js` — Download & Cache

Responsible for ensuring models are present on disk before use.

**Startup sequence:**
1. Check `~/.anamnesis/models/<filename>` exists
2. If exists: verify SHA256 checksum against a hardcoded expected value
3. If missing or corrupt: begin download from HuggingFace CDN
4. Log download progress to daemon.log (percentage every 10%)
5. On completion: re-verify checksum, signal ready

**Download:**
- Uses Node's built-in `https` module — no additional dependencies
- Streams directly to disk (no memory buffering of 900MB)
- Resumes partial downloads if the file exists but is incomplete (via HTTP Range header)
- Retries up to 3 times with exponential backoff on network errors

**Error handling:**
- If download fails after retries: log error, extraction stays queued indefinitely
- Does not crash the daemon — Anamnesis still works as a pass-through proxy

### `src/lib/inference-engine.js` — LLM Inference

Wraps `node-llama-cpp`. Manages one loaded model instance shared across all callers
(loading a GGUF is expensive; we do it once at startup).

**GPU strategy:**
1. On startup, probe available VRAM:
   - Linux: parse `nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits`
   - macOS: parse `system_profiler SPDisplaysDataType` for unified memory
   - Windows: parse `nvidia-smi` output
   - If probe fails: assume CPU-only
2. Each layer of Qwen2.5-1.5B uses approximately 50–60MB of VRAM
3. Calculate `gpuLayers = Math.floor(Math.min(availableVramMB, 512) / 55)`
   - Caps GPU usage at ~512MB VRAM regardless of what's free
   - On a system with 12GB VRAM, this offloads ~9 layers (of ~28 total) — meaningful speedup
   - On a system with 24GB VRAM, same cap — Anamnesis stays invisible
   - On CPU-only: gpuLayers = 0
4. Log the layer count and VRAM budget to daemon.log at startup

**Context management:**
- Context window: 2048 tokens (sufficient for all Anamnesis tasks; keeps memory low)
- One context per task type (extraction, foresight, consolidation, persona) — prevents
  cross-contamination between task prompts
- Contexts are created lazily and reused across calls

**Interface:**
```js
engine.chat(messages, { maxTokens, temperature })   // → Promise<string>
engine.generate(prompt, { maxTokens, temperature }) // → Promise<string>
engine.isLoaded()                                   // → boolean
```

### `src/lib/local-embedder.js` — Embeddings

Wraps `@huggingface/transformers`. Provides the same interface as the current `Embedder`
class so `proxy.js`, `selector.js`, and `consolidator.js` need no changes beyond
initialization.

```js
localEmbedder.embed(text)   // → Promise<Float32Array | null>
localEmbedder.model         // → string (model name, for tagging stored vectors)
```

The model is loaded once via `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')`.
Embeddings are mean-pooled and L2-normalized to match standard cosine similarity usage.
Loading is async but fast (~500ms). During loading, `embed()` returns `null` — existing
callers already handle null vectors by skipping cosine similarity for that row.

### `src/lib/prompts.js` — Centralized Prompts

All system prompts currently scattered inline across `extractor.js`, `foresight.js`,
`consolidator.js`, and `persona.js` are moved here. This makes tuning straightforward
without touching task logic.

```js
prompts.ENGRAM_EXTRACTION    // system prompt for extracting engrams from a turn
prompts.FORESIGHT            // system prompt for extracting future intentions
prompts.EPISODE_TITLE        // system prompt for naming an episode cluster
prompts.EPISODE_SUMMARY      // system prompt for summarizing an episode
prompts.PERSONA_DRIFT        // system prompt for drift detection
prompts.PERSONA_EVOLUTION    // system prompt for profile evolution
```

Each prompt is tuned specifically for Qwen2.5-1.5B-Instruct's instruction format
(`<|im_start|>system` / `<|im_end|>` chat template). This is the main place we iterate
on quality — better prompts = better memory without touching any other code.

---

## Configuration Changes

The `embedding.ollamaUrl` and implicit `extraction.ollamaUrl` keys are removed from
`char-config.js` defaults and all character configs. The new config surface is minimal:

```json
"inference": {
  "gpuLayerBudgetMB": 512,
  "_note": "Max VRAM Anamnesis may use for inference. 0 = CPU only."
}
```

Everything else is automatic. Model paths, download URLs, and checksums are hardcoded
in `model-manager.js` — users never configure them.

---

## First-Run Experience

1. User runs `anamnesis new` or `anamnesis start <name>`
2. Daemon starts normally
3. In the background, `model-manager.js` begins downloading the GGUF
4. `daemon.log` shows: `[model-manager] downloading Qwen2.5-1.5B-Instruct-Q4_K_M.gguf (0%)...`
5. Extraction calls queue silently — the proxy works immediately for chat passthrough
6. When download completes (~minutes depending on connection), extraction drains
7. User notices nothing — memories start appearing in context organically

If the user runs `anamnesis logs`, they'll see download progress. Otherwise it's invisible.

---

## Dependencies

```json
"node-llama-cpp": "^3.x",
"@huggingface/transformers": "^3.x"
```

`node-llama-cpp` ships prebuilt native binaries for:
- Linux x64 (CPU, CUDA)
- macOS arm64 (Metal), macOS x64 (CPU)
- Windows x64 (CPU, CUDA)

No compilation required on supported platforms. If a prebuilt isn't available,
it falls back to building from source (requires a C++ compiler).

---

## Migration for Existing Users

Existing users who had Ollama configured will have `embedding.ollamaUrl` and related
keys in their `~/.anamnesis/characters/<name>/config.json`. These keys are simply ignored
after this change — the new inference layer reads no Ollama config. No migration script
needed; old keys are harmless.

---

## Testing Strategy

- **Unit tests** for `model-manager.js`: mock filesystem + network, test download retry
  logic, checksum verification, partial resume
- **Unit tests** for `brain.js`: mock `inference-engine.js` and `local-embedder.js`,
  verify queue behavior while not-ready, verify correct routing
- **Unit tests** for `prompts.js`: verify prompt strings are non-empty and contain
  expected structural markers
- **Integration test** (CI-skipped, local only): load real model, run one extraction,
  verify JSON output structure

The inference engine itself is not unit-tested against a real model in CI — model files
are too large. CI tests cover the surrounding logic (queue, routing, download management)
with mocks.

---

## Roadmap Note

`prompts.js` is the foundation for future fine-tuning work. Once the system is stable,
we can collect extraction outputs, score them for quality, and use that dataset to
fine-tune a smaller model specifically for Anamnesis's tasks — potentially reducing the
model size to ~200MB while matching the quality of the 1.5B model on these narrow tasks.
