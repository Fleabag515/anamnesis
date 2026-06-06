/**
 * consolidator.js — Episode building.
 *
 * Periodically clusters unclustered Engrams into thematic Episodes.
 * Uses cosine similarity to group related facts, then generates a title +
 * summary for each scene via an LLM call.
 *
 * Algorithm:
 *   1. Fetch all unclustered engrams for each active session.
 *   2. Build similarity graph between cells (cosine, single pass).
 *   3. Greedily cluster by sceneClusterThreshold.
 *   4. For each cluster ≥ minSceneSize: generate title+summary, upsert Episode.
 *   5. Update decay scores across all engrams, prune below threshold.
 *
 * Scheduling: self-rescheduling setTimeout chain with a `_running` guard so
 * a slow run can never overlap with the next tick (the previous setInterval
 * version could stack concurrent runs against the same session).
 */

const Embedder = require('./embedder.js');
const HistoryStore = require('./history.js');
const { generate, tryParseJsonObject } = require('./lib/ollama.js');
const log = require('./lib/logger.js').make('consolidator');

const SCENE_PROMPT = `You are a memory organizer. Given a list of related facts, create:
1. A short scene title (3-6 words, like a chapter heading)
2. A single summary sentence tying the facts together

Output ONLY valid JSON in this exact format:
{"title": "...", "summary": "..."}

Facts:
`;

class Consolidator {
  constructor(config, historyStore, embedder) {
    this.cfg = config;
    this.history = historyStore;
    this.embedder = embedder;
    this._timer = null;
    this._running = false;
    this._stopped = false;
  }

  start(intervalMs) {
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
        // Belt-and-braces: should be unreachable because we await `run()`
        // before scheduling the next timer, but guard regardless.
        this._scheduleNext(this._intervalMs);
        return;
      }
      this._running = true;
      try {
        await this.run();
      } catch (e) {
        log.warn('run error:', e.message);
      } finally {
        this._running = false;
        this._scheduleNext(this._intervalMs);
      }
    }, delayMs);
  }

  async run() {
    const sessions = this.history.db
      .prepare('SELECT DISTINCT session_key FROM engrams WHERE scene_id IS NULL')
      .all()
      .map((r) => r.session_key);

    for (const sessionKey of sessions) {
      await this._consolidateSession(sessionKey);
      this.history.updateDecayScores(sessionKey);
      const pruned = this.history.pruneDecayedMemcells(
        sessionKey,
        this.cfg.memory.decayPruneThreshold
      );
      if (pruned > 0)
        log.info(`session=${sessionKey.slice(0, 8)} pruned ${pruned} decayed engram(s)`);
    }
  }

  async _consolidateSession(sessionKey) {
    const cells = this.history.getUnclusteredMemcells(
      sessionKey,
      this.cfg.memory.consolidationBatchSize
    );
    if (cells.length < this.cfg.memory.minSceneSize) return;

    const currentModel = this.embedder.model;
    const decoded = cells
      .map((c) => ({ ...c, vec: HistoryStore.toFloat32(c.embedding) }))
      // Skip cells whose embedding came from a different model — cosine
      // across model families is meaningless. They'll re-cluster naturally
      // once the next batch from the current model arrives.
      .filter((c) => c.vec && (!c.embedding_model || c.embedding_model === currentModel));

    const threshold = this.cfg.memory.sceneClusterThreshold;
    const clusters = [];
    const assigned = new Set();

    for (let i = 0; i < decoded.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [decoded[i]];
      assigned.add(i);
      for (let j = i + 1; j < decoded.length; j++) {
        if (assigned.has(j)) continue;
        const sim = Embedder.cosine(decoded[i].vec, decoded[j].vec);
        if (sim >= threshold) {
          cluster.push(decoded[j]);
          assigned.add(j);
        }
      }
      clusters.push(cluster);
    }

    let sceneCount = 0;
    for (const cluster of clusters) {
      if (cluster.length < this.cfg.memory.minSceneSize) continue;

      const facts = cluster.map((c) => c.content);
      const sceneData = await this._generateScene(facts);
      if (!sceneData) continue;

      const avgImportance = cluster.reduce((s, c) => s + (c.importance ?? 0.5), 0) / cluster.length;
      const sceneEmbed = await this.embedder.embed(sceneData.summary);
      const cellIds = cluster.map((c) => c.id);

      const sceneId = this.history.insertScene(
        sessionKey,
        sceneData.title,
        sceneData.summary,
        sceneEmbed,
        cellIds,
        avgImportance,
        currentModel
      );
      for (const cell of cluster) this.history.assignMemcellToScene(cell.id, sceneId);
      sceneCount++;
    }

    if (sceneCount > 0)
      log.info(
        `session=${sessionKey.slice(0, 8)} built ${sceneCount} new scene(s) from ${cells.length} engram(s)`
      );
  }

  async _generateScene(facts) {
    const factList = facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
    try {
      const text = await generate(this.cfg.embedding.ollamaUrl, {
        model: this.cfg.extraction.model,
        prompt: SCENE_PROMPT + factList,
        options: { temperature: 0.2, num_predict: 256 },
        timeoutMs: 90000,
      });
      const parsed = tryParseJsonObject(text);
      if (!parsed?.title || !parsed?.summary) return null;
      return { title: String(parsed.title), summary: String(parsed.summary) };
    } catch {
      return null;
    }
  }
}

module.exports = Consolidator;
