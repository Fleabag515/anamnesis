/**
 * extractor.js — MemCell extraction pipeline
 *
 * Asynchronously processes unextracted turns and distils them into
 * atomic MemCells using a fast LLM (gemma4:e2b via Ollama).
 *
 * Each assistant turn is decomposed into 3-6 atomic facts, each
 * independently embeddable and retrievable.
 */

const http = require('http');

const EXTRACT_PROMPT = `You are a memory extraction system. Given a conversation turn, extract 3-6 atomic, self-contained facts or decisions. Each fact should:
- Be a single complete statement
- Make sense without the surrounding conversation
- Capture something meaningful (not filler words)
- Be concise (under 30 words)

Output ONLY a JSON array of strings. No other text. Example:
["The user prefers dark mode interfaces.", "Redis was chosen over Memcached for session storage.", "The deployment target is Ubuntu 22.04."]

Conversation turn to extract from:
`;

class Extractor {
  constructor(ollamaUrl, model, historyStore, embedder) {
    this.ollamaUrl = ollamaUrl;
    this.model     = model;
    this.history   = historyStore;
    this.embedder  = embedder;
    this._running  = false;
  }

  /**
   * Process a batch of unextracted turns in the background.
   * Safe to call repeatedly — skips if already running.
   */
  async processBatch() {
    if (this._running) return;
    this._running = true;
    try {
      const turns = this.history.getUnextractedTurns(10);
      for (const turn of turns) {
        await this._extractTurn(turn);
      }
    } finally {
      this._running = false;
    }
  }

  async _extractTurn(turn) {
    try {
      const facts = await this._callLLM(turn.content);
      if (!facts?.length) {
        this.history.markExtracted(turn.id);
        return;
      }

      for (const fact of facts) {
        if (typeof fact !== 'string' || fact.trim().length < 10) continue;
        const embedding = await this.embedder.embed(fact.trim());
        this.history.insertMemcell(turn.session_key, turn.id, fact.trim(), embedding);
      }

      this.history.markExtracted(turn.id);
      console.log(`[extractor] turn ${turn.id} → ${facts.length} memcells`);
    } catch (err) {
      console.warn(`[extractor] failed on turn ${turn.id}:`, err.message);
      // Mark extracted anyway to avoid retry loops on broken turns
      this.history.markExtracted(turn.id);
    }
  }

  async _callLLM(content) {
    // Truncate very long turns to keep extraction fast
    const truncated = content.length > 3000 ? content.slice(0, 3000) + '...' : content;
    const body = JSON.stringify({
      model:  this.model,
      prompt: EXTRACT_PROMPT + truncated,
      stream: false,
      options: { temperature: 0.1, num_predict: 512 }
    });

    const raw = await this._post('/api/generate', body);
    const parsed = JSON.parse(raw);
    const text = parsed.response?.trim() ?? '';

    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    return JSON.parse(match[0]);
  }

  _post(path, body) {
    return new Promise((resolve, reject) => {
      const url  = new URL(this.ollamaUrl);
      const opts = {
        hostname: url.hostname,
        port:     url.port || 80,
        path,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const req = http.request(opts, res => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => resolve(buf));
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('extractor LLM timeout')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = Extractor;
