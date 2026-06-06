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
- `embedding.ollamaUrl`, `embedding.model` config keys
- `extraction.model`, `foresight.model`, `persona.model` config keys (single bundled model now)

### Added
- `src/lib/brain.js` — unified inference interface, replaces ollama.js
- `src/lib/inference-engine.js` — node-llama-cpp wrapper for LLM tasks
- `src/lib/local-embedder.js` — @huggingface/transformers wrapper for embeddings
- `src/lib/model-manager.js` — GGUF download, cache, and integrity verification
- `src/lib/prompts.js` — all system prompts centralized in one file

### Modified
- `src/extractor.js` — replace `require('./lib/ollama')` with `require('./lib/brain')`;
  drop `this.ollamaUrl` and `this.embedder` constructor args; use `brain.embed()` directly
- `src/foresight.js` — replace ollama require; drop `this.ollamaUrl`, `this.cfg.model`
- `src/consolidator.js` — replace ollama require; `generate()` calls become `brain.generate()`
- `src/persona.js` — replace ollama require; drop `this.ollama` and `this.model`;
  all `chat(this.ollama, { model: this.model, messages })` calls become `brain.chat(messages)`
- `src/importers/index.js` — replace ollama require; fix broken `llmExtract()` call
  (currently calls `chat(url, model, messages, false)` with positional args — must be
  updated to `brain.chat(messages)`)
- `src/embedder.js` — replace Ollama HTTP call with `brain.embed()`; constructor
  simplified to `new Embedder()` (no URL/model args); `this.model` becomes the
  hardcoded constant `'Xenova/all-MiniLM-L6-v2'`
- `src/proxy.js` — call `brain.init(config)` at startup; pass brain instance into
  `Embedder` constructor (or import brain directly in embedder.js); update status
  response to return `brain.embeddingModel()` instead of `config.embedding.model`
- `src/lib/char-config.js` — remove `embedding` section entirely; remove
  `extraction.model`, `foresight.model`, `persona.model`; add `inference.gpuLayerBudgetMB`
- `src/consolidator.js` — `generate()` changed to use chat template (see below)

---

## Models

### LLM — Qwen2.5-1.5B-Instruct Q4_K_M
- **Purpose:** Engram extraction, foresight, episode consolidation, persona drift/evolution, import parsing
- **Format:** GGUF (native llama.cpp format)
- **Source:** HuggingFace — `bartowski/Qwen2.5-1.5B-Instruct-GGUF`
- **File:** `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf`
- **Size:** ~900MB
- **Expected file size (bytes):** hardcoded in `model-manager.js` alongside checksum
- **SHA256:** hardcoded in `model-manager.js` (verified on download completion)
- **Cache location:** `~/.anamnesis/models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf`
- **HuggingFace CDN:** supports HTTP `Range` requests — verified; used for resume

Qwen2.5-1.5B-Instruct is chosen for its reliable structured JSON output, which is the
primary requirement for all of Anamnesis's extraction tasks. Q4_K_M quantization gives
the best quality-per-size tradeoff at this scale.

### Embeddings — all-MiniLM-L6-v2
- **Purpose:** Embedding turns, engrams, and episode summaries for cosine similarity retrieval
- **Format:** ONNX (via @huggingface/transformers)
- **Source:** HuggingFace — `Xenova/all-MiniLM-L6-v2`
- **Size:** ~23MB (cached by transformers.js in `~/.cache/huggingface/`)
- **Runtime:** Pure WASM, CPU-only, no native compilation

---

## Architecture

### `src/lib/brain.js` — Unified Interface

The public API surface. Replaces `ollama.js` as the import target for all callers.
Callers only need a one-line `require` change (plus dropping URL/model args from call sites).

```js
// Lifecycle
brain.init(config)              // called once by daemon at startup; kicks off model load
brain.embeddingModel()          // → string — for status endpoint and stored vector tagging

// LLM calls — no URL or model argument; brain routes internally
brain.chat(messages, opts)      // → Promise<string>  opts: { maxTokens, temperature, timeoutMs }
brain.generate(prompt, opts)    // → Promise<string>  opts: { maxTokens, temperature, timeoutMs }

// Embeddings
brain.embed(text)               // → Promise<Float32Array | null>

// Utilities (unchanged from ollama.js)
brain.tryParseJsonArray(text)   // → Array | null
brain.tryParseJsonObject(text)  // → Object | null
```

`brain.isReady()` is **not** exported. It is used internally only. The "ready" signal is
communicated implicitly: `embed()` returns null when not ready (callers handle it);
`chat()`/`generate()` queue internally and resolve once ready (see queue spec below).

**Queue behavior:**
- While models are loading or downloading, `chat()` and `generate()` calls are held in an
  internal queue (max depth: 200, matching `startupBacklogLimit`)
- Each queued call carries its own resolve/reject pair
- **Caller-side `timeoutMs` is ignored while queued** — `brain.js` strips `timeoutMs`
  from queued calls and applies it only once the call is actually sent to `inference-engine.js`
- This means a caller may await a `brain.chat()` call for minutes during first-run download
  without timing out. This is intentional: the alternative (timeout + mark turn as
  processed-with-no-data) produces worse outcomes than waiting
- If the model download fails permanently (after retries), queued calls are rejected with
  a descriptive error that callers log and swallow — same path as any other LLM timeout

### `src/lib/model-manager.js` — Download & Cache

Responsible for ensuring models are present on disk before use.

**Startup sequence:**
1. Check `~/.anamnesis/models/<filename>` exists and its file size matches the expected size
2. If size matches: verify SHA256 checksum
3. If size mismatch or checksum fails: begin download (or resume)
4. **Resuming:** if a partial file exists, its size is known; issue `Range: bytes=<size>-`
   to continue from where the previous download stopped. Expected file size is hardcoded
   in `model-manager.js` so the range request is always correct without inspecting the server
5. Log download progress to daemon.log at 10% intervals
6. On completion: re-verify SHA256; if it fails, delete and restart download
7. Signal `inference-engine.js` that the file is ready

**Error handling:**
- Retries up to 3 times with exponential backoff (1s, 4s, 16s)
- If all retries fail: log error to daemon.log; queued `brain.chat()` calls are rejected;
  the daemon stays up and continues as a pass-through proxy

**Download implementation:** Node built-in `https` module, streaming to disk — no
memory buffering of the 900MB file.

### `src/lib/inference-engine.js` — LLM Inference

Wraps `node-llama-cpp`. Manages one loaded model instance shared across all callers.

**GPU strategy:**

GPU layer offloading is probed at startup. Anamnesis caps its VRAM usage at
`config.inference.gpuLayerBudgetMB` (default: 512MB). Each layer of Qwen2.5-1.5B uses
approximately 55MB of VRAM.

`gpuLayers = Math.floor(gpuLayerBudgetMB / 55)`

VRAM detection:
- **Linux/Windows:** `nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits`
  — uses free VRAM, not total, to avoid competing with a running LLM
- **macOS (Apple Silicon):** `system_profiler SPDisplaysDataType` does **not** report
  unified memory. On Apple Silicon, `node-llama-cpp` with `gpu: 'metal'` is used with
  `gpuLayers` set to `config.inference.gpuLayerBudgetMB / 55` directly (user-controlled
  since free unified memory is not easily queryable). Default 512MB budget = ~9 layers.
- **Probe failure:** if the probe command fails or returns no data, `gpuLayers = 0` (CPU only)

GPU detection result is logged to daemon.log at startup:
`[inference-engine] gpuLayers=9 (budget=512MB, platform=metal)`

**Context management:**
- Context window: 2048 tokens (sufficient for all Anamnesis tasks)
- One shared context is reused across all calls (cheaper than per-call contexts)
- Calls are serialized — `brain.js` queues concurrent requests

**`generate()` vs `chat()`:**
`consolidator.js` currently uses `generate()` (raw completion). With Qwen2.5-1.5B-Instruct,
raw prompts without the instruct chat template produce degraded output. Therefore:
- `brain.generate(prompt, opts)` internally wraps the prompt as a single `user` message
  and calls `inference-engine.chat()` with the instruct template
- This means `consolidator.js` callers don't need to change their call sites — the
  prompt string is wrapped transparently
- `prompts.js` episode prompts are written as plain strings (not message arrays), which
  `brain.generate()` wraps before sending

**Interface:**
```js
engine.chat(messages, opts)    // → Promise<string>  messages: [{role, content}]
engine.generate(prompt, opts)  // → Promise<string>  wraps as user message internally
engine.isLoaded()              // → boolean (used by brain.js internally only)
```

### `src/lib/local-embedder.js` — Embeddings

Wraps `@huggingface/transformers`. Provides the same interface as the current `Embedder`
class. `embedder.js` is simplified to delegate to brain; it is no longer a standalone
HTTP client.

```js
// brain.embed() delegates to local-embedder internally
localEmbedder.embed(text)     // → Promise<Float32Array | null>
localEmbedder.MODEL_NAME      // = 'Xenova/all-MiniLM-L6-v2' (constant, for vector tagging)
```

Embeddings are mean-pooled and L2-normalized (standard for cosine similarity).

**`embedder.js` after this change:**
```js
// Simplified — no URL, no HTTP, no constructor args
class Embedder {
  get model() { return brain.embeddingModel(); }
  embed(text) { return brain.embed(text); }
  static cosine(a, b) { /* unchanged */ }
}
module.exports = new Embedder();  // singleton, imported by proxy.js / selector.js / consolidator.js
```

`proxy.js` construction changes from:
```js
const embedder = new Embedder(config.embedding.ollamaUrl, config.embedding.model);
```
to:
```js
const embedder = require('./embedder.js');  // singleton, brain already initialized
```

### `src/lib/prompts.js` — Centralized Prompts

All system prompts moved from inline in task files to one location.

```js
module.exports = {
  ENGRAM_EXTRACTION,   // system prompt for extracting engrams from a turn
  FORESIGHT,           // system prompt for extracting future intentions
  EPISODE_TITLE,       // system prompt for naming an episode cluster
  EPISODE_SUMMARY,     // system prompt for summarizing an episode
  PERSONA_DRIFT,       // system prompt for drift detection
  PERSONA_EVOLUTION,   // system prompt for profile evolution
  IMPORT_EXTRACTION,   // system prompt for extracting memories from imported text
};
```

All prompts use Qwen2.5-1.5B-Instruct's native chat template (applied by node-llama-cpp
automatically — prompts are plain strings, not template strings).

### Status Endpoint Update

`proxy.js` status response currently returns `embedding_model: config.embedding.model`.
After this change, `config.embedding` is removed. The status response is updated to:
```js
embedding_model: brain.embeddingModel()   // → 'Xenova/all-MiniLM-L6-v2'
```
`brain.embeddingModel()` returns the constant string even before models are fully loaded.

---

## Configuration Changes

**Removed from `char-config.js`:**
- `embedding` section (entire — `ollamaUrl`, `model`)
- `extraction.model`
- `foresight.model`
- `persona.model`
- `extraction.ollamaUrl` (was never in char-config but was a hardcoded fallback in persona.js)

**Added:**
```json
"inference": {
  "gpuLayerBudgetMB": 512,
  "_note": "Max VRAM Anamnesis may use for inference. 0 = CPU only."
}
```

Existing user configs with old keys (`embedding.ollamaUrl`, `extraction.model`, etc.)
will have those keys silently ignored — no migration script needed.

---

## `importers/index.js` — Call Site Fix

The existing `llmExtract()` function has a bug independent of this feature:
```js
// Current (broken):
chat(ollamaUrl, model, messages, false)   // positional args don't match ollama.js signature

// Fixed:
brain.chat(messages, { timeoutMs: 45000 })
```

This fix is included in this feature's scope.

---

## First-Run Experience

1. User runs `anamnesis new` or `anamnesis start <name>`
2. Daemon starts; `brain.init()` runs; model-manager checks `~/.anamnesis/models/`
3. GGUF not present → background download begins; logged to daemon.log
4. Proxy works immediately for chat passthrough — upstream LLM is unaffected
5. `brain.chat()` calls queue silently during download and model load
6. When ready, queue drains; memories start appearing in context
7. `anamnesis logs` shows download progress if the user is curious

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

No compilation required on supported platforms. Falls back to build-from-source
if no prebuilt matches (requires C++ compiler — documented in README).

---

## Testing Strategy

- **Unit: `model-manager.js`** — mock `https`, filesystem; test download, retry, checksum
  verification, partial file resume (Range header logic)
- **Unit: `brain.js`** — mock `inference-engine.js` and `local-embedder.js`; test queue
  behavior while not-ready (calls held, not dropped); test that queued calls resolve after
  engine signals ready; test that `timeoutMs` is applied post-queue not pre-queue
- **Unit: `prompts.js`** — verify all exports are non-empty strings
- **Unit: `local-embedder.js`** — mock `@huggingface/transformers`; test null return when
  not loaded; test Float32Array shape when loaded
- **Integration (local only, CI-skipped):** load real model, run one engram extraction,
  verify JSON output structure matches expected schema

CI tests cover queue logic, routing, and download management with mocks. Model inference
itself is not tested in CI (files too large).

---

## Roadmap Note

`prompts.js` is the foundation for future fine-tuning. Once stable, extraction outputs
can be scored and used to fine-tune a smaller model specifically for Anamnesis's tasks —
potentially dropping to ~200MB while matching 1.5B quality on these narrow tasks.
