/**
 * extractor.js — MemCell extraction with importance + category scoring.
 *
 * Each assistant turn is decomposed into atomic facts. Each fact gets:
 *   - importance: 0.0–1.0 (how durable/useful is this fact?)
 *   - category:   technical | decision | preference | personal | context | other
 *
 * Importance affects decay rate — high-importance facts resist pruning.
 * Category enables targeted retrieval (e.g. "only preferences" for
 * personalization) and shields decisions/preferences from decay-based
 * pruning entirely.
 *
 * Resilience:
 *   - Turns are stored in SQLite BEFORE extraction — survives process death.
 *   - `extracted=0` turns are retried on next startup via processBacklog().
 *   - JSON parse failures retried up to maxRetries times.
 *   - shouldProcessTurn() filters trivial/noisy turns before hitting Ollama.
 */

const { chat, tryParseJsonArray } = require('./lib/ollama.js');
const { shouldProcessTurn } = require('./lib/heuristics.js');
const log = require('./lib/logger.js').make('extractor');

const CATEGORIES = ['technical', 'decision', 'preference', 'personal', 'context', 'other'];

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

class Extractor {
  constructor(config, historyStore, embedder) {
    this.cfg = config.extraction;
    this.ollamaUrl = config.embedding.ollamaUrl;
    this.history = historyStore;
    this.embedder = embedder;
    this._running = false;
    this._inflight = null;
  }

  async processBacklog() {
    const pending = this.history.getUnextractedAssistantTurns(this.cfg.startupBacklogLimit);
    if (!pending.length) return;
    log.info(`processing ${pending.length} unextracted turn(s) from backlog`);
    for (const turn of pending) await this._extractTurn(turn);
    log.info('backlog cleared');
  }

  processBatch() {
    if (this._running) return this._inflight ?? Promise.resolve();
    this._running = true;
    this._inflight = this._runBatch().finally(() => {
      this._running = false;
      this._inflight = null;
    });
    return this._inflight;
  }

  async flushInFlight() {
    if (this._inflight) {
      log.info('flushing in-flight extraction before shutdown...');
      await Promise.race([this._inflight, new Promise((r) => setTimeout(r, 15000))]);
    }
  }

  async _runBatch() {
    const turns = this.history.getUnextractedAssistantTurns(5);
    for (const turn of turns) await this._extractTurn(turn);
  }

  async _extractTurn(turn) {
    if (!shouldProcessTurn(turn.content)) {
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
          log.warn(`turn ${turn.id} failed after ${attempt + 1} attempts:`, err.message);
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

      const importance =
        typeof item?.importance === 'number' ? Math.min(1, Math.max(0, item.importance)) : 0.5;
      const category = CATEGORIES.includes(item?.category) ? item.category : 'other';

      const embedding = await this.embedder.embed(fact.trim()).catch(() => null);
      this.history.insertMemcell(
        turn.session_key,
        turn.id,
        fact.trim(),
        embedding,
        importance,
        category,
        this.embedder.model
      );
      count++;
    }

    this.history.markExtracted(turn.id);
    if (count > 0)
      log.info(`turn ${turn.id} → ${count} memcell(s) (session=${turn.session_key.slice(0, 8)})`);
  }

  async _callLLM(content) {
    const truncated = content.length > 2500 ? content.slice(0, 2500) + '...' : content;
    const text = await chat(this.ollamaUrl, {
      model: this.cfg.model,
      messages: [{ role: 'user', content: EXTRACT_PROMPT + truncated }],
      options: { temperature: 0.1, num_predict: 500 },
      timeoutMs: this.cfg.timeoutMs,
    });
    return tryParseJsonArray(text);
  }
}

module.exports = Extractor;
