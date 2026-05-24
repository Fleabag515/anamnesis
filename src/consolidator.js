/**
 * consolidator.js — MemScene building
 *
 * Periodically clusters unclustered MemCells into thematic MemScenes.
 * Uses cosine similarity to group related facts, then generates a title
 * and summary for each scene via LLM.
 *
 * Algorithm:
 *   1. Fetch all unclustered memcells for each active session
 *   2. Build similarity graph between cells
 *   3. Greedily cluster by similarity threshold
 *   4. For each cluster ≥ minSize: generate title+summary, upsert MemScene
 *   5. Update decay scores across all memcells
 */

const http      = require('http');
const Embedder  = require('./embedder.js');
const HistoryStore = require('./history.js');

const SCENE_PROMPT = `You are a memory organizer. Given a list of related facts, create:
1. A short scene title (3-6 words, like a chapter heading)
2. A single summary sentence tying the facts together

Output ONLY valid JSON in this exact format:
{"title": "...", "summary": "..."}

Facts:
`;

class Consolidator {
  constructor(config, historyStore, embedder) {
    this.cfg      = config;
    this.history  = historyStore;
    this.embedder = embedder;
    this._timer   = null;
  }

  start(intervalMs) {
    this._timer = setInterval(() => this.run().catch(e =>
      console.warn('[consolidator] run error:', e.message)
    ), intervalMs);
    console.log(`[consolidator] running every ${intervalMs / 1000}s`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  async run() {
    // Find all sessions with unclustered memcells
    const sessions = this.history.db.prepare(`
      SELECT DISTINCT session_key FROM memcells WHERE scene_id IS NULL
    `).all().map(r => r.session_key);

    for (const sessionKey of sessions) {
      await this._consolidateSession(sessionKey);
      this.history.updateDecayScores(sessionKey);
      const pruned = this.history.pruneDecayedMemcells(
        sessionKey, this.cfg.memory.decayPruneThreshold
      );
      if (pruned > 0)
        console.log(`[consolidator] session=${sessionKey.slice(0,8)} pruned ${pruned} decayed memcells`);
    }
  }

  async _consolidateSession(sessionKey) {
    const cells = this.history.getUnclusteredMemcells(
      sessionKey, this.cfg.memory.consolidationBatchSize
    );
    if (cells.length < this.cfg.memory.minSceneSize) return;

    // Decode embeddings
    const decoded = cells.map(c => ({
      ...c,
      vec: HistoryStore.toFloat32(c.embedding)
    })).filter(c => c.vec);

    // Greedy clustering by cosine similarity
    const threshold = this.cfg.memory.sceneClusterThreshold;
    const clusters  = [];
    const assigned  = new Set();

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

      const facts     = cluster.map(c => c.content);
      const sceneData = await this._generateScene(facts);
      if (!sceneData) continue;

      const sceneEmbed = await this.embedder.embed(sceneData.summary);
      const cellIds    = cluster.map(c => c.id);

      const sceneId = this.history.insertScene(
        sessionKey,
        sceneData.title,
        sceneData.summary,
        sceneEmbed,
        cellIds
      );

      for (const cell of cluster) {
        this.history.assignMemcellToScene(cell.id, sceneId);
      }
      sceneCount++;
    }

    if (sceneCount > 0)
      console.log(`[consolidator] session=${sessionKey.slice(0,8)} built ${sceneCount} new scenes from ${cells.length} memcells`);
  }

  async _generateScene(facts) {
    const factList = facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
    const body = JSON.stringify({
      model:  this.cfg.extraction.model,
      prompt: SCENE_PROMPT + factList,
      stream: false,
      options: { temperature: 0.2, num_predict: 256 }
    });

    try {
      const raw    = await this._post('/api/generate', body);
      const parsed = JSON.parse(raw);
      const text   = parsed.response?.trim() ?? '';
      const match  = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  _post(path, body) {
    return new Promise((resolve, reject) => {
      const url  = new URL(this.cfg.embedding.ollamaUrl);
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
      req.setTimeout(90000, () => { req.destroy(); reject(new Error('consolidator timeout')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = Consolidator;
