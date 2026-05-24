/**
 * foresight.js — Future-intention extraction (EverMemOS-style Foresight)
 *
 * Runs in parallel with memcell extraction. Each assistant turn is scanned
 * for statements about future plans, goals, or intended actions. These are
 * stored as foresights so the model always knows what it was about to do.
 *
 * Fields per foresight:
 *   - intention: what is planned (≤25 words)
 *   - target:    the object/subject of the intention (tool, file, project, etc.)
 *   - timeframe: soon | days | weeks | months | ongoing
 *   - confidence: 0.0–1.0 (how certain is this a real intention vs hedged language)
 *
 * Timeframe guide:
 *   soon     = within this conversation or immediately after
 *   days     = mentioned as happening in the next few days
 *   weeks    = next few weeks
 *   months   = longer-term
 *   ongoing  = recurring or habitual intention
 */

const http = require('http');

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

const VALID_TIMEFRAMES = ['soon', 'days', 'weeks', 'months', 'ongoing'];

// Mirror the same heuristic as extractor.js
function shouldScan(content) {
  if (!content || content.length < 80) return false;
  if (content.startsWith('<') && content.includes('</')) return false;
  if (content.split('\n').length < 2 && content.length < 200) return false;
  return true;
}

class ForesightExtractor {
  constructor(config, historyStore) {
    this.cfg       = config.foresight;
    this.ollamaUrl = config.embedding.ollamaUrl;
    this.history   = historyStore;
    this._running  = false;
    this._inflight = null;
  }

  async processBacklog() {
    const pending = this.history.getUnextractedTurns(this.cfg.startupBacklogLimit);
    // Only process turns that haven't had foresight extraction yet
    // We re-use the memcell extracted flag as a proxy — turns not yet extracted
    // by memcells haven't been seen by foresight either (both run together)
    const needsScan = pending.filter(t => t.role === 'assistant');
    if (!needsScan.length) return;
    console.log(`[foresight] scanning ${needsScan.length} backlog turns for intentions`);
    for (const turn of needsScan) await this._scanTurn(turn);
    console.log('[foresight] backlog scan complete');
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
      console.log('[foresight] flushing in-flight scan before shutdown...');
      await Promise.race([this._inflight, new Promise(r => setTimeout(r, 15000))]);
    }
  }

  async _runBatch() {
    // Pull the most recent assistant turns not yet foresight-scanned
    // We use a small batch (same as extractor) — runs in parallel
    const turns = this.history.getUnextractedTurns(5);
    const asst  = turns.filter(t => t.role === 'assistant');
    for (const turn of asst) await this._scanTurn(turn);
  }

  async _scanTurn(turn) {
    if (!shouldScan(turn.content)) return;

    let items = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        items = await this._callLLM(turn.content);
        if (items !== null) break;
      } catch (err) {
        if (attempt === this.cfg.maxRetries)
          console.warn(`[foresight] turn ${turn.id} failed after ${attempt + 1} attempts:`, err.message);
      }
    }

    if (!items?.length) return;

    let count = 0;
    for (const item of items) {
      const intention  = (item?.intention ?? '').trim();
      if (!intention || intention.length < 8) continue;

      const target     = (item?.target ?? '').trim();
      const timeframe  = VALID_TIMEFRAMES.includes(item?.timeframe) ? item.timeframe : 'soon';
      const confidence = typeof item?.confidence === 'number'
        ? Math.min(1, Math.max(0, item.confidence))
        : 0.7;

      if (confidence < 0.4) continue;

      this.history.insertForesight(turn.session_key, turn.id, intention, target, timeframe, confidence);
      count++;
    }

    if (count > 0)
      console.log(`[foresight] turn ${turn.id} → ${count} foresight(s) (session=${turn.session_key.slice(0,8)})`);
  }

  async _callLLM(content) {
    const truncated = content.length > 2500 ? content.slice(0, 2500) + '...' : content;
    const body = JSON.stringify({
      model:    this.cfg.model,
      messages: [{ role: 'user', content: FORESIGHT_PROMPT + truncated }],
      stream:   false,
      think:    false,
      options:  { temperature: 0.1, num_predict: 400 }
    });

    const raw    = await this._post('/api/chat', body);
    const parsed = JSON.parse(raw);
    const text   = (parsed?.message?.content ?? '').trim();

    if (!text) return [];

    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr : [];
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
      req.setTimeout(this.cfg.timeoutMs, () => { req.destroy(); reject(new Error('foresight timeout')); });
      req.write(body); req.end();
    });
  }
}

module.exports = ForesightExtractor;
