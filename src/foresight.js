/**
 * foresight.js — Future-intention extraction (EverMemOS-style Foresight).
 *
 * Runs in parallel with engram extraction. Each assistant turn is scanned
 * for statements about future plans, goals, or intended actions. These are
 * stored as foresights so the model always knows what it was about to do.
 *
 * Fields per foresight:
 *   - intention : what is planned (≤25 words)
 *   - target    : the object/subject (file, tool, project, system) or ""
 *   - timeframe : soon | days | weeks | months | ongoing
 *   - confidence: 0.0–1.0 — confidence ≥ 0.4 only, hedged language skipped
 *
 * IMPORTANT — own flag, not shared with extractor:
 *   This module now tracks its own `foresight_scanned` column. Previously
 *   it piggybacked on `turns.extracted`, which only the engram extractor
 *   set. Whichever extractor finished a turn first silently starved the
 *   other for that turn.
 */

const { chat, tryParseJsonArray } = require('./lib/ollama.js');
const { shouldProcessTurn } = require('./lib/heuristics.js');
const log = require('./lib/logger.js').make('foresight');

const VALID_TIMEFRAMES = ['soon', 'days', 'weeks', 'months', 'ongoing'];

const FORESIGHT_PROMPT = `Scan this AI assistant turn for future intentions — things the assistant or user plans to do, build, fix, or try.

For each genuine intention output a JSON object with:
  "intention": short description of what will be done (≤25 words)
  "target":    specific target — file, tool, project, system (empty string if none)
  "timeframe": one of: soon | days | weeks | months | ongoing
  "confidence": 0.0 to 1.0
    1.0 = definite plan ("I will now...", "next step is...", "let's do X")
    0.7 = likely plan ("we should...", "I'll probably...", "plan to...")
    0.4 = hedged ("might...", "could consider...", "eventually...")
    0.1 = hypothetical or rhetorical (skip these — output nothing)

Only extract intentions that are actionable and specific.
Skip intentions with confidence < 0.4.
If there are no genuine intentions, output an empty array.
Output ONLY a JSON array of objects. No explanation, no markdown.

Example:
[
  {"intention": "Add foresight extraction to the Anamnesis memory proxy", "target": "foresight.js", "timeframe": "soon", "confidence": 0.95},
  {"intention": "Evaluate gemma4:e2b as a replacement extraction model", "target": "gemma4:e2b", "timeframe": "days", "confidence": 0.7}
]

Turn to scan:
`;

class ForesightExtractor {
  constructor(config, historyStore) {
    this.cfg = config.foresight;
    this.ollamaUrl = config.embedding.ollamaUrl;
    this.history = historyStore;
    this._running = false;
    this._inflight = null;
  }

  async processBacklog() {
    const pending = this.history.getUnscannedAssistantTurns(this.cfg.startupBacklogLimit);
    if (!pending.length) return;
    log.info(`scanning ${pending.length} backlog turn(s) for intentions`);
    for (const turn of pending) await this._scanTurn(turn);
    log.info('backlog scan complete');
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
      log.info('flushing in-flight scan before shutdown...');
      await Promise.race([this._inflight, new Promise((r) => setTimeout(r, 15000))]);
    }
  }

  async _runBatch() {
    const turns = this.history.getUnscannedAssistantTurns(5);
    for (const turn of turns) await this._scanTurn(turn);
  }

  async _scanTurn(turn) {
    if (!shouldProcessTurn(turn.content)) {
      this.history.markForesightScanned(turn.id);
      return;
    }

    let items = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        items = await this._callLLM(turn.content);
        if (items !== null) break;
      } catch (err) {
        if (attempt === this.cfg.maxRetries)
          log.warn(`turn ${turn.id} failed after ${attempt + 1} attempts:`, err.message);
      }
    }

    if (!items?.length) {
      this.history.markForesightScanned(turn.id);
      return;
    }

    let count = 0;
    for (const item of items) {
      const intention = (item?.intention ?? '').trim();
      if (!intention || intention.length < 8) continue;

      const target = (item?.target ?? '').trim();
      const timeframe = VALID_TIMEFRAMES.includes(item?.timeframe) ? item.timeframe : 'soon';
      const confidence =
        typeof item?.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : 0.7;
      if (confidence < 0.4) continue;

      this.history.insertForesight(
        turn.session_key,
        turn.id,
        intention,
        target,
        timeframe,
        confidence
      );
      count++;
    }

    this.history.markForesightScanned(turn.id);
    if (count > 0)
      log.info(`turn ${turn.id} → ${count} foresight(s) (session=${turn.session_key.slice(0, 8)})`);
  }

  async _callLLM(content) {
    const truncated = content.length > 2500 ? content.slice(0, 2500) + '...' : content;
    const text = await chat(this.ollamaUrl, {
      model: this.cfg.model,
      messages: [{ role: 'user', content: FORESIGHT_PROMPT + truncated }],
      options: { temperature: 0.1, num_predict: 400 },
      timeoutMs: this.cfg.timeoutMs,
    });
    return tryParseJsonArray(text) ?? [];
  }
}

module.exports = ForesightExtractor;
