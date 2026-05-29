/**
 * distiller.js — Phase α: silent population of the `lessons` table from
 * clusters of related memscenes. Spec §5.3.
 *
 * Scheduling pattern matches consolidator.js (self-rescheduling
 * setTimeout chain + _running guard). Never overlaps.
 *
 * Phase α: this module ONLY writes to `lessons`. It does NOT inject
 * lessons into requests; the selector still runs the v0.4.0 path.
 */

const HistoryStore = require('./history.js');
const Embedder = require('./embedder.js');
const { chat, tryParseJsonObject } = require('./lib/ollama.js');
const log = require('./lib/logger.js').make('distiller');

/**
 * LESSON_PROMPT — verbatim from spec §5.3. MUST stay byte-identical to
 * the spec text. Pin via a test in Task 10.
 */
const LESSON_PROMPT = `You are extracting a single generalised rule from a cluster of related
observations about an AI assistant's ongoing relationship with a user.

OUTPUT ONLY one of:
  (a) A JSON object: {"content": "…", "confidence": 0.0-1.0, "category": "…"}
  (b) The literal string: NONE

Rules for "content":
  - At most 80 words.
  - State the rule plainly. Examples:
      "User runs Node services as systemd units under /home/fleabag/."
      "User prefers concise code reviews that lead with bugs over style."
  - Categories: technical | decision | preference | personal | context | other

CRITICAL — scope boundary:
  Lessons are about THE USER, THE DOMAIN, or THE TOOL ENVIRONMENT.
  Lessons are NEVER about the AI assistant itself — not its voice, its
  tone, its personality, its evolution, its writing style, its
  archetypal patterns. Those belong to a separate persona system and
  MUST NOT appear in lessons. If the cluster is principally about how
  the AI behaves rather than what it knows, output NONE.

Be conservative. If the cluster supports no clear generalisation, or
supports one only with low confidence (<0.5), output NONE.

OBSERVATIONS:
`;

const VALID_CATEGORIES = ['technical', 'decision', 'preference', 'personal', 'context', 'other'];

class Distiller {
  constructor(config, historyStore, embedder) {
    this.cfg = config.cognitive?.lessons || {};
    this.ollamaUrl = config.embedding?.ollamaUrl || 'http://127.0.0.1:11434';
    this.history = historyStore;
    this.embedder = embedder;
    this._timer = null;
    this._running = false;
    this._stopped = false;
  }

  start(intervalMs) {
    if (this._timer) return; // idempotent
    this._stopped = false;
    this._intervalMs = intervalMs;
    log.info(`running every ${intervalMs / 1000}s`);
    this._scheduleNext(intervalMs);
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  _scheduleNext(delayMs) {
    if (this._stopped) return;
    this._timer = setTimeout(async () => {
      if (this._running) {
        this._scheduleNext(this._intervalMs);
        return;
      }
      try {
        await this.run();
      } catch (e) {
        log.warn('run error:', e.message);
      } finally {
        this._scheduleNext(this._intervalMs);
      }
    }, delayMs);
  }

  /**
   * Public single-flight wrapper. Delegates to `_runOnce` (which is the
   * monkey-patch hook in tests).
   */
  async run() {
    if (this._running) return;
    this._running = true;
    try {
      await this._runOnce();
    } finally {
      this._running = false;
    }
  }

  /**
   * Actual distillation pass body. Empty in the skeleton — populated in
   * Task 9 with the cluster + persist logic.
   */
  async _runOnce() {
    // populated in Task 9
  }
}

module.exports = Distiller;
module.exports.LESSON_PROMPT = LESSON_PROMPT;
module.exports.VALID_CATEGORIES = VALID_CATEGORIES;
