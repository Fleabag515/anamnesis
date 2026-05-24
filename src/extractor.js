/**
 * extractor.js — MemCell extraction with importance + category scoring
 *
 * Each assistant turn is decomposed into atomic facts. Each fact gets:
 *   - importance: 0.0–1.0 (how durable/useful is this fact?)
 *   - category: one of technical|decision|preference|personal|context|other
 *
 * Importance affects decay rate — high-importance facts resist pruning.
 * Category enables targeted retrieval (e.g. "only preferences" for personalization).
 *
 * Resilience:
 *   - Turns stored in SQLite BEFORE extraction — survives process death
 *   - extracted=0 turns retried on next startup via processBacklog()
 *   - JSON parse failures retried up to maxRetries times
 *   - shouldExtract() filters trivial/noisy turns before hitting Ollama
 */

const http = require('http');

const EXTRACT_PROMPT = `Extract 3-6 atomic, self-contained facts from this AI assistant turn.

For each fact output a JSON object with:
  "fact": the statement (under 30 words, stands alone without context)
  "importance": 0.0 to 1.0
    1.0 = permanent truth (a decision made, a hard constraint, a user preference)
    0.7 = useful context (a tool chosen, an approach taken)
    0.4 = situational detail (a step done, a value used)
    0.1 = ephemeral (a greeting, a filler statement, a status update)
  "category": one of: technical | decision | preference | personal | context | other

Skip filler, greetings, and meta-commentary entirely.
Output ONLY a JSON array of objects. No explanation, no markdown.

Example:
[
  {"fact": "User prefers dark mode interfaces.", "importance": 0.9, "category": "preference"},
  {"fact": "Redis was chosen over Memcached for session storage.", "importance": 0.8, "category": "decision"},
  {"fact": "The deployment target is Ubuntu 22.04.", "importance": 0.7, "category": "technical"}
]

Turn to extract from:
`;

// Don't waste an Ollama call on these
function shouldExtract(content) {
  if (!content || content.length < 80) return false;           // too short
  if (content.startsWith('<') && content.includes('</')) return false; // XML response
  if (content.split('\n').length < 2 && content.length < 200) return false; // one-liner
  return true;
}

class Extractor {
  constructor(config, historyStore, embedder) {
    this.cfg       = config.extraction;
    this.ollamaUrl = config.embedding.ollamaUrl;
    this.history   = historyStore;
    this.embedder  = embedder;
    this._running  = false;
    this._inflight = null;
  }

  async processBacklog() {
    const pending = this.history.getUnextractedTurns(this.cfg.startupBacklogLimit);
    if (!pending.length) return;
    console.log(`[extractor] processing ${pending.length} unextracted turns from backlog`);
    for (const turn of pending) await this._extractTurn(turn);
    console.log('[extractor] backlog cleared');
  }

  processBatch() {
    if (this._running) return this._inflight ?? Promise.resolve();
    this._running  = true;
    this._inflight = this._runBatch().finally(() => {
      this._running  = false;
      this._inflight = null;
    });
    return this._inflight;
  }

  async flushInFlight() {
    if (this._inflight) {
      console.log('[extractor] flushing in-flight extraction before shutdown...');
      await Promise.race([this._inflight, new Promise(r => setTimeout(r, 15000))]);
    }
  }

  async _runBatch() {
    const turns = this.history.getUnextractedTurns(5);
    for (const turn of turns) await this._extractTurn(turn);
  }

  async _extractTurn(turn) {
    if (!shouldExtract(turn.content)) {
      this.history.markExtracted(turn.id);
      return;
    }

    let facts = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        facts = await this._callLLM(turn.content);
        if (facts?.length) break;
      } catch (err) {
        if (attempt === this.cfg.maxRetries)
          console.warn(`[extractor] turn ${turn.id} failed after ${attempt + 1} attempts:`, err.message);
      }
    }

    if (!facts?.length) {
      this.history.markExtracted(turn.id);
      return;
    }

    let count = 0;
    for (const item of facts) {
      const fact = typeof item === 'string' ? item : item?.fact;
      if (!fact || fact.trim().length < 10) continue;

      const importance = typeof item?.importance === 'number'
        ? Math.min(1, Math.max(0, item.importance))
        : 0.5;
      const category = ['technical','decision','preference','personal','context','other']
        .includes(item?.category) ? item.category : 'other';

      const embedding = await this.embedder.embed(fact.trim()).catch(() => null);
      this.history.insertMemcell(turn.session_key, turn.id, fact.trim(), embedding, importance, category);
      count++;
    }

    this.history.markExtracted(turn.id);
    if (count > 0)
      console.log(`[extractor] turn ${turn.id} → ${count} memcells (session=${turn.session_key.slice(0,8)})`);
  }

  async _callLLM(content) {
    const truncated = content.length > 2500 ? content.slice(0, 2500) + '...' : content;
    const body = JSON.stringify({
      model:   this.cfg.model,
      prompt:  EXTRACT_PROMPT + truncated,
      stream:  false,
      options: { temperature: 0.1, num_predict: 500 }
    });

    const raw    = await this._post('/api/generate', body);
    const parsed = JSON.parse(raw);
    const text   = (parsed.response ?? '').trim();

    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return null;
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr : null;
  }

  _post(path, body) {
    return new Promise((resolve, reject) => {
      const url  = new URL(this.ollamaUrl);
      const opts = {
        hostname: url.hostname, port: url.port || 80, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const req = http.request(opts, res => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => resolve(buf));
      });
      req.on('error', reject);
      req.setTimeout(this.cfg.timeoutMs, () => { req.destroy(); reject(new Error('extractor timeout')); });
      req.write(body); req.end();
    });
  }
}

module.exports = Extractor;
