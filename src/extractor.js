'use strict';

/**
 * extractor.js — Engram extraction with importance + category scoring.
 *
 * Each assistant turn is decomposed into atomic facts. Each fact gets:
 *   - importance: 0.0–1.0 (how durable/useful is this fact?)
 *   - category:   technical | decision | preference | personal | context | other
 *
 * Importance affects decay rate — high-importance facts resist pruning.
 * Category enables targeted retrieval and shields decisions/preferences
 * from decay-based pruning entirely.
 *
 * Resilience:
 *   - Turns are stored in SQLite BEFORE extraction — survives process death.
 *   - `extracted=0` turns are retried on next startup via processBacklog().
 *   - JSON parse failures retried up to maxRetries times.
 *   - shouldProcessTurn() filters trivial/noisy turns before hitting the LLM.
 */

const brain = require('./lib/brain.js');
const { ENGRAM_EXTRACTION } = require('./lib/prompts.js');
const { shouldProcessTurn } = require('./lib/heuristics.js');
const log = require('./lib/logger.js').make('extractor');

const CATEGORIES = ['technical', 'decision', 'preference', 'personal', 'context', 'other'];

class Extractor {
  constructor(config, historyStore, embedder) {
    this.cfg = config.extraction;
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
      log.info(`turn ${turn.id} → ${count} engram(s) (session=${turn.session_key.slice(0, 8)})`);
  }

  async _callLLM(content) {
    const truncated = content.length > 2500 ? content.slice(0, 2500) + '...' : content;
    const text = await brain.chat([{ role: 'user', content: ENGRAM_EXTRACTION + truncated }], {
      maxTokens: 500,
      temperature: 0.1,
      timeoutMs: this.cfg.timeoutMs,
    });
    return brain.tryParseJsonArray(text);
  }
}

module.exports = Extractor;
