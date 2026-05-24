/**
 * embedder.js — Ollama embedding client.
 *
 * Thin wrapper over Ollama's /api/embed. Exposes `.model` so callers can
 * tag stored vectors with the model that produced them — that way we can
 * skip cosine similarity against vectors from an incompatible model (which
 * would otherwise return arithmetic-noise values).
 */

const { post } = require('./lib/ollama.js');
const log = require('./lib/logger.js').make('embedder');

class Embedder {
  constructor(ollamaUrl, model) {
    this.ollamaUrl = ollamaUrl;
    this.model = model;
  }

  /**
   * Embed a single string. Returns Float32Array or null on failure.
   * Failures are logged and swallowed — the caller decides whether a
   * missing embedding is fatal (selector skips those rows in similarity).
   */
  async embed(text) {
    if (!text) return null;
    const body = JSON.stringify({ model: this.model, input: text });
    try {
      const raw = await post(this.ollamaUrl, '/api/embed', body, { timeoutMs: 30000 });
      const data = JSON.parse(raw);
      const vec = data.embeddings?.[0] ?? data.embedding;
      if (!vec) return null;
      return new Float32Array(vec);
    } catch (err) {
      log.warn('embed failed:', err.message);
      return null;
    }
  }

  /**
   * Cosine similarity between two Float32Arrays.
   * Returns 0 for missing vectors or mismatched lengths so callers can
   * always pass the result straight into a sort comparator.
   */
  static cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }
}

module.exports = Embedder;
