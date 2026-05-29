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
   * Actual distillation pass body. Per spec §5.3:
   *   1. For each active session, fetch scenes for distillation.
   *   2. Greedily cluster by lessonClusterThreshold (cosine).
   *   3. For each cluster ≥ minScenesPerLesson, call the LLM and persist.
   */
  async _runOnce() {
    if (!this.cfg.enabled) return;
    if (!this.history?.getActiveSessions) return; // wiring not complete

    const minSize = this.cfg.minScenesPerLesson ?? 3;
    const threshold = this.cfg.lessonClusterThreshold ?? 0.78;

    for (const sessionKey of this.history.getActiveSessions()) {
      const scenes = (this.history.getScenesForDistillation?.(sessionKey) || []).filter(
        (s) => s.embedding && (!s.embedding_model || s.embedding_model === this.embedder.model)
      );
      if (scenes.length < minSize) continue;

      const decoded = scenes
        .map((s) => ({ ...s, vec: HistoryStore.toFloat32(s.embedding) }))
        .filter((s) => s.vec);

      const assigned = new Set();
      for (let i = 0; i < decoded.length; i++) {
        if (assigned.has(i)) continue;
        const cluster = [decoded[i]];
        assigned.add(i);
        for (let j = i + 1; j < decoded.length; j++) {
          if (assigned.has(j)) continue;
          if (Embedder.cosine(decoded[i].vec, decoded[j].vec) >= threshold) {
            cluster.push(decoded[j]);
            assigned.add(j);
          }
        }
        if (cluster.length < minSize) continue;

        let memcellIds = [];
        for (const s of cluster) {
          try {
            memcellIds = memcellIds.concat(JSON.parse(s.memcell_ids));
          } catch {
            // malformed JSON in memcell_ids; skip this scene's contribution
          }
        }
        await this.distillCluster(
          sessionKey,
          cluster.map((s) => ({ id: s.id, content: s.summary })),
          memcellIds
        );
      }
    }
  }

  /**
   * Ask the LLM for a single generalised rule from a cluster of related
   * scenes, validate the response, and persist. Returns the inserted
   * lesson id, or null when the response was 'NONE' / malformed / below
   * confidence floor.
   */
  async distillCluster(sessionKey, sceneItems, supportingMemcellIds) {
    if (!sceneItems?.length) return null;

    let text;
    try {
      text = await this._callLLM(sceneItems);
    } catch (err) {
      log.warn(`session=${sessionKey.slice(0, 8)} LLM error: ${err.message}`);
      return null;
    }

    if (!text || /^\s*NONE\s*$/i.test(text)) return null;

    const parsed = tryParseJsonObject(text);
    if (!parsed?.content || typeof parsed.content !== 'string') return null;
    if (parsed.content.length < 10 || parsed.content.length > 400) return null;

    const confidence =
      typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5;
    if (confidence < 0.5) return null;

    const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'other';
    const embedding = await this.embedder.embed(parsed.content).catch(() => null);

    const id = this.history.insertLesson({
      sessionKey,
      content: parsed.content,
      embedding,
      embeddingModel: this.embedder.model,
      category,
      confidence,
      supportingSceneIds: sceneItems.map((s) => s.id),
      supportingMemcellIds,
    });
    log.info(
      `session=${sessionKey.slice(0, 8)} new lesson (cat=${category}, conf=${confidence.toFixed(2)})`
    );
    return id;
  }

  async _callLLM(sceneItems) {
    const factList = sceneItems.map((s, i) => `${i + 1}. ${s.content}`).join('\n');
    return chat(this.ollamaUrl, {
      model: this.cfg.model,
      messages: [{ role: 'user', content: LESSON_PROMPT + factList }],
      options: { temperature: 0.1, num_predict: 300 },
      timeoutMs: 45000,
    });
  }
}

module.exports = Distiller;
module.exports.LESSON_PROMPT = LESSON_PROMPT;
module.exports.VALID_CATEGORIES = VALID_CATEGORIES;
