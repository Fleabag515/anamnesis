/**
 * extractor.js — MemCell extraction pipeline
 *
 * Processes unextracted turns into atomic MemCells via a fast local LLM.
 * Designed to be non-blocking: triggers asynchronously after each turn,
 * and processes the backlog on startup so nothing is lost across restarts.
 *
 * Resilience:
 *   - Turns are always stored in SQLite BEFORE extraction is attempted
 *   - extracted=0 turns survive process death and are retried on next startup
 *   - JSON parse failures retry up to config.extraction.maxRetries times
 *   - On SIGTERM, flushInFlight() waits for the current batch to finish
 */

const http = require('http');

const EXTRACT_PROMPT = `Extract 3-6 atomic, self-contained facts from this conversation turn.

Rules:
- Each fact must stand alone without needing the conversation for context
- Be specific and concrete (include names, values, decisions where present)
- Skip filler, greetings, and meta-commentary
- Under 30 words each

Output ONLY a JSON array of strings. No explanation, no markdown.
Example: ["Redis was chosen over Memcached for session storage.", "The API rate limit is 100 req/min.", "User prefers TypeScript over JavaScript."]

Turn:
`;

class Extractor {
  constructor(config, historyStore, embedder) {
    this.cfg      = config.extraction;
    this.ollamaUrl = config.embedding.ollamaUrl;
    this.history  = historyStore;
    this.embedder = embedder;
    this._running = false;
    this._inflight = null;
  }

  /**
   * Process backlog of unextracted turns at startup.
   * Runs eagerly up to startupBacklogLimit — doesn't block server start.
   */
  async processBacklog() {
    const pending = this.history.getUnextractedTurns(this.cfg.startupBacklogLimit);
    if (pending.length === 0) return;
    console.log(`[extractor] processing ${pending.length} unextracted turns from backlog`);
    for (const turn of pending) {
      await this._extractTurn(turn);
    }
    console.log('[extractor] backlog cleared');
  }

  /**
   * Process a small batch of unextracted turns asynchronously.
   * Safe to call rapidly — skips if already running.
   * Returns a promise you can await for graceful shutdown.
   */
  processBatch() {
    if (this._running) return this._inflight ?? Promise.resolve();
    this._running = true;
    this._inflight = this._runBatch().finally(() => {
      this._running  = false;
      this._inflight = null;
    });
    return this._inflight;
  }

  /**
   * Wait for any in-flight extraction to complete (for graceful shutdown).
   */
  async flushInFlight() {
    if (this._inflight) {
      console.log('[extractor] flushing in-flight extraction before shutdown...');
      await Promise.race([
        this._inflight,
        new Promise(r => setTimeout(r, 15000)) // 15s max
      ]);
    }
  }

  async _runBatch() {
    const turns = this.history.getUnextractedTurns(5);
    for (const turn of turns) {
      await this._extractTurn(turn);
    }
  }

  async _extractTurn(turn) {
    let facts = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        facts = await this._callLLM(turn.content);
        if (facts?.length) break;
      } catch (err) {
        if (attempt === this.cfg.maxRetries) {
          console.warn(`[extractor] turn ${turn.id} failed after ${attempt + 1} attempts:`, err.message);
        }
      }
    }

    if (!facts?.length) {
      this.history.markExtracted(turn.id);
      return;
    }

    let count = 0;
    for (const fact of facts) {
      if (typeof fact !== 'string' || fact.trim().length < 10) continue;
      const embedding = await this.embedder.embed(fact.trim()).catch(() => null);
      this.history.insertMemcell(turn.session_key, turn.id, fact.trim(), embedding);
      count++;
    }

    this.history.markExtracted(turn.id);
    if (count > 0)
      console.log(`[extractor] turn ${turn.id} (${turn.session_key.slice(0,8)}) → ${count} memcells`);
  }

  async _callLLM(content) {
    const truncated = content.length > 2500 ? content.slice(0, 2500) + '...' : content;
    const body = JSON.stringify({
      model:  this.cfg.model,
      prompt: EXTRACT_PROMPT + truncated,
      stream: false,
      options: { temperature: 0.1, num_predict: 400 }
    });

    const raw    = await this._post('/api/generate', body);
    const parsed = JSON.parse(raw);
    const text   = (parsed.response ?? '').trim();

    // Try to extract a JSON array from anywhere in the response
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return null;

    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr : null;
  }

  _post(path, body) {
    return new Promise((resolve, reject) => {
      const url  = new URL(this.ollamaUrl);
      const opts = {
        hostname: url.hostname,
        port:     url.port || 80,
        path,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const req = http.request(opts, res => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => resolve(buf));
      });
      req.on('error', reject);
      req.setTimeout(this.cfg.timeoutMs, () => {
        req.destroy();
        reject(new Error(`extractor LLM timeout after ${this.cfg.timeoutMs}ms`));
      });
      req.write(body);
      req.end();
    });
  }
}

module.exports = Extractor;
