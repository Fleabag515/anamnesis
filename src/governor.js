/**
 * governor.js — the Context Governor.
 *
 * Replaces the static `context.tokenBudget` with *discovery*: ask the
 * upstream what its real context window is, count tokens with the upstream's
 * real tokenizer, and meter usage against watermarks. When the upstream is
 * elastic (the Pleiades engine), sustained pressure asks it to upshift to a
 * larger context gear via POST /resize.
 *
 * Probe surface (all optional, all failures tolerated):
 *   GET  {root}/props                  llama-server & Pleiades engine → n_ctx
 *   POST {root}/tokenize               llama-server → {tokens:[…]}
 *   POST {root}/extras/tokenize/count  llama-cpp-python server → {count}
 *   POST {root}/resize                 Pleiades engine only (elastic)
 *
 * {root} is upstream.baseUrl without a trailing /v1 — these endpoints live
 * beside the OpenAI surface, not under it.
 *
 * Degradation ladder: real n_ctx + real tokenizer → real n_ctx + char
 * estimate → config hint + char estimate. The char ratio self-tunes from
 * `usage.prompt_tokens` ground truth when responses carry it.
 */

'use strict';

const crypto = require('crypto');
const log = require('./lib/logger.js').make('governor');

const LEVELS = ['ok', 'compact', 'aggressive', 'emergency'];

class ContextGovernor {
  constructor(config) {
    const ctx = config.context ?? {};
    const elastic = config.elastic ?? {};
    this.upstreamRoot = String(config.upstream?.baseUrl ?? '')
      .replace(/\/$/, '')
      .replace(/\/v1$/, '');

    // Watermarks as fractions of the discovered window.
    const wm = ctx.watermarks ?? {};
    this.watermarks = {
      compact: wm.compact ?? 0.7,
      aggressive: wm.aggressive ?? 0.85,
      emergency: wm.emergency ?? 0.95,
    };

    this.completionReserve = ctx.completionReserve ?? 4096;
    // Discovery fallbacks: explicit hint, then the legacy budget key, then 8k.
    this.nCtxHint = ctx.nCtxHint ?? ctx.tokenBudget ?? 8192;
    this.charsPerToken = ctx.charsPerToken ?? 3.5;

    this.elastic = {
      enabled: elastic.enabled ?? true,
      pressureCooldownMs: elastic.pressureCooldownMs ?? 120000,
      rediscoverMs: elastic.rediscoverMs ?? 300000,
      maxNCtx: elastic.maxNCtx ?? 0, // 0 = trust the engine's own ceiling
    };

    this.nCtx = this.nCtxHint;
    this.discovered = false; // true once /props answered
    this.tokenizer = 'estimate'; // 'llama-server' | 'llama-cpp-python' | 'estimate'
    this.resizable = false;

    this._cache = new Map(); // sha1 -> count (LRU-ish, capped)
    this._cacheCap = 4096;
    this._lastProbe = 0;
    this._lastPressure = 0;
    this._probing = null;
  }

  /** Probe the upstream. Never throws; safe to call eagerly and repeatedly. */
  async init() {
    return this.discover();
  }

  async discover() {
    if (this._probing) return this._probing; // collapse concurrent probes
    this._probing = this._discover().finally(() => {
      this._probing = null;
      this._lastProbe = Date.now();
    });
    return this._probing;
  }

  async _discover() {
    if (!this.upstreamRoot) return;
    // 1. n_ctx from /props (llama-server and the Pleiades engine both serve it)
    try {
      const r = await this._fetch(`${this.upstreamRoot}/props`, { method: 'GET' }, 2500);
      if (r.ok) {
        const j = await r.json();
        const n = j?.n_ctx ?? j?.default_generation_settings?.n_ctx;
        if (Number.isFinite(n) && n > 0) {
          if (n !== this.nCtx) log.info(`discovered n_ctx=${n} (was ${this.nCtx})`);
          this.nCtx = n;
          this.discovered = true;
        }
        this.resizable = j?.resizable === true;
      }
    } catch {
      /* upstream down or not llama-server-shaped — keep hint */
    }
    // 2. tokenizer endpoint
    if (this.tokenizer === 'estimate') {
      if (await this._tryTokenize('llama-server')) this.tokenizer = 'llama-server';
      else if (await this._tryTokenize('llama-cpp-python')) this.tokenizer = 'llama-cpp-python';
    }
    log.debug(
      `governor: n_ctx=${this.nCtx} (${this.discovered ? 'discovered' : 'hint'}) ` +
        `tokenizer=${this.tokenizer} resizable=${this.resizable}`
    );
  }

  async _tryTokenize(kind) {
    try {
      const n = await this._countRemote('ping', kind);
      return Number.isFinite(n) && n > 0;
    } catch {
      return false;
    }
  }

  async _countRemote(text, kind = this.tokenizer) {
    if (kind === 'llama-server') {
      const r = await this._fetch(
        `${this.upstreamRoot}/tokenize`,
        { method: 'POST', body: JSON.stringify({ content: text }) },
        4000
      );
      if (!r.ok) throw new Error(`tokenize ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j?.tokens)) throw new Error('tokenize: no tokens[]');
      return j.tokens.length;
    }
    if (kind === 'llama-cpp-python') {
      const r = await this._fetch(
        `${this.upstreamRoot}/extras/tokenize/count`,
        { method: 'POST', body: JSON.stringify({ input: text }) },
        4000
      );
      if (!r.ok) throw new Error(`tokenize/count ${r.status}`);
      const j = await r.json();
      const n = j?.count;
      if (!Number.isFinite(n)) throw new Error('tokenize/count: no count');
      return n;
    }
    throw new Error('no tokenizer');
  }

  /** Estimate-only counter (sync, used as fallback and for tiny strings). */
  estimate(text) {
    return Math.ceil((text?.length ?? 0) / this.charsPerToken);
  }

  /**
   * Count tokens in `text` — real tokenizer when available, cached by content
   * hash. Falls back to the char estimate on any failure (and downgrades the
   * tokenizer so we stop hammering a dead endpoint until the next probe).
   */
  async count(text) {
    if (!text) return 0;
    if (this.tokenizer === 'estimate' || text.length < 24) return this.estimate(text);
    const key = crypto.createHash('sha1').update(text).digest('base64');
    const hit = this._cache.get(key);
    if (hit !== undefined) {
      // refresh recency
      this._cache.delete(key);
      this._cache.set(key, hit);
      return hit;
    }
    try {
      const n = await this._countRemote(text);
      this._cache.set(key, n);
      if (this._cache.size > this._cacheCap) {
        const oldest = this._cache.keys().next().value;
        this._cache.delete(oldest);
      }
      return n;
    } catch (e) {
      log.warn(`tokenizer fell back to estimate: ${e.message}`);
      this.tokenizer = 'estimate';
      return this.estimate(text);
    }
  }

  /** Per-message protocol overhead (role tokens, separators) — flat approx. */
  messageOverhead(count) {
    return count * 4;
  }

  /** Usable prompt budget right now. */
  budget() {
    this._maybeReprobe();
    return Math.max(512, this.nCtx - this.completionReserve);
  }

  /** Classify usage against watermarks → {level, used, nCtx, ratio}. */
  assess(usedTokens) {
    const ratio = usedTokens / Math.max(1, this.nCtx);
    let level = 'ok';
    if (ratio >= this.watermarks.emergency) level = 'emergency';
    else if (ratio >= this.watermarks.aggressive) level = 'aggressive';
    else if (ratio >= this.watermarks.compact) level = 'compact';
    return { level, used: usedTokens, nCtx: this.nCtx, ratio };
  }

  static levelAtLeast(level, floor) {
    return LEVELS.indexOf(level) >= LEVELS.indexOf(floor);
  }

  /**
   * Self-tune the char-ratio estimator from ground truth (`usage.prompt_tokens`
   * reported by the upstream vs what we predicted). EMA, clamped to sane range.
   */
  observePromptUsage(estimated, actual) {
    if (!Number.isFinite(estimated) || !Number.isFinite(actual)) return;
    if (estimated <= 0 || actual <= 0) return;
    const impliedRatio = this.charsPerToken * (estimated / actual);
    this.charsPerToken = Math.min(6, Math.max(2, 0.7 * this.charsPerToken + 0.3 * impliedRatio));
  }

  /**
   * Ask an elastic upstream for a bigger window. Fire-and-forget with a
   * cooldown; quietly permanent-noops when the upstream can't resize.
   */
  signalPressure() {
    if (!this.elastic.enabled || !this.resizable) return;
    const now = Date.now();
    if (now - this._lastPressure < this.elastic.pressureCooldownMs) return;
    this._lastPressure = now;
    const target = this.elastic.maxNCtx
      ? Math.min(this.nCtx * 2, this.elastic.maxNCtx)
      : this.nCtx * 2;
    log.info(`pressure sustained at n_ctx=${this.nCtx} — requesting upshift to ${target}`);
    this._fetch(
      `${this.upstreamRoot}/resize`,
      { method: 'POST', body: JSON.stringify({ n_ctx: target }) },
      120000
    )
      .then(async (r) => {
        if (r.ok) {
          await this.discover();
          log.info(`upstream resized; n_ctx now ${this.nCtx}`);
        } else if (r.status === 404 || r.status === 501) {
          this.resizable = false;
        } else {
          log.warn(`resize rejected: ${r.status}`);
        }
      })
      .catch((e) => log.warn(`resize failed: ${e.message}`));
  }

  _maybeReprobe() {
    if (Date.now() - this._lastProbe > this.elastic.rediscoverMs) {
      this.discover().catch(() => {});
    }
  }

  _fetch(url, opts, timeoutMs) {
    return fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** For /anamnesis/status. */
  describe() {
    return {
      n_ctx: this.nCtx,
      n_ctx_source: this.discovered ? 'discovered' : 'hint',
      tokenizer: this.tokenizer,
      chars_per_token: Number(this.charsPerToken.toFixed(2)),
      resizable: this.resizable,
      budget: this.budget(),
      watermarks: this.watermarks,
    };
  }
}

module.exports = ContextGovernor;
