/**
 * selector.js — Scene-guided context selection (EverMemOS-inspired)
 *
 * Retrieval hierarchy:
 *   1. Embed current query
 *   2. Score all MemScenes by cosine similarity → pick top K scenes
 *   3. Expand scenes → get their constituent turn IDs
 *   4. Fill rotating slots with turns from top scenes (decay-weighted)
 *   5. Fall back to raw turn similarity if no scenes exist yet
 *   6. Always append recency buffer (last N turns verbatim)
 */

const HistoryStore = require('./history.js');
const Embedder     = require('./embedder.js');

class Selector {
  constructor(config, historyStore, embedder) {
    this.cfg      = config.context;
    this.history  = historyStore;
    this.embedder = embedder;
  }

  async select(sessionKey, incoming) {
    const {
      tokenBudget, systemReserveTokens,
      recencyTurns, rotatingSlots, charsPerToken, minChunkChars
    } = this.cfg;

    // Split system from conversation
    const systemMsgs = incoming.filter(m => m.role === 'system');
    const convoMsgs  = incoming.filter(m => m.role !== 'system');
    const currentMsg = convoMsgs[convoMsgs.length - 1];
    const queryText  = currentMsg?.content ?? '';

    // Embed query
    const queryVec = await this.embedder.embed(queryText);

    // Recency buffer (always included)
    const recencyWindow = recencyTurns * 2;
    const recencyMsgs   = convoMsgs.slice(Math.max(0, convoMsgs.length - recencyWindow));

    // Budget accounting
    const systemTokens  = this._est(systemMsgs, charsPerToken);
    const recencyTokens = this._est(recencyMsgs, charsPerToken);
    let budget = tokenBudget - systemReserveTokens - systemTokens - recencyTokens;

    // Try scene-guided retrieval first
    const scenes = this.history.getScenes(sessionKey);
    let rotatingMsgs = [];

    if (scenes.length > 0 && queryVec) {
      rotatingMsgs = await this._sceneGuidedRetrieval(
        sessionKey, queryVec, scenes, rotatingSlots, budget, charsPerToken, minChunkChars
      );
    } else {
      // Fall back: raw turn similarity
      rotatingMsgs = await this._rawTurnRetrieval(
        sessionKey, queryVec, recencyMsgs.length, rotatingSlots, budget, charsPerToken, minChunkChars
      );
    }

    const final = [...systemMsgs, ...rotatingMsgs, ...recencyMsgs];

    const stats = this.history.stats(sessionKey);
    console.log(
      `[selector] session=${sessionKey.slice(0,8)} ` +
      `turns=${stats.turns} cells=${stats.cells} scenes=${stats.scenes} ` +
      `rotating=${rotatingMsgs.length} recency=${recencyMsgs.length} ` +
      `total_msgs=${final.length}`
    );

    return final;
  }

  async _sceneGuidedRetrieval(sessionKey, queryVec, scenes, maxSlots, budget, cpt, minChars) {
    // Score scenes
    const scored = scenes
      .map(s => {
        const sVec = HistoryStore.toFloat32(s.embedding);
        const sim  = sVec ? Embedder.cosine(queryVec, sVec) : 0;
        return { ...s, sim };
      })
      .sort((a, b) => b.sim - a.sim)
      .slice(0, maxSlots * 2); // oversample

    // Collect turn IDs from top scenes
    const turnIdSet = new Set();
    for (const scene of scored) {
      this.history.bumpSceneRecall(scene.id);
      let ids;
      try { ids = JSON.parse(scene.memcell_ids); } catch { continue; }

      // Get turn IDs from memcells in this scene
      const cellTurnIds = this.history.db.prepare(
        `SELECT DISTINCT turn_id FROM memcells WHERE id IN (${ids.map(() => '?').join(',')}) AND turn_id IS NOT NULL`
      ).all(...ids).map(r => r.turn_id);

      for (const id of cellTurnIds) turnIdSet.add(id);
      if (turnIdSet.size >= maxSlots * 4) break;
    }

    // Fetch those turns, score by sim + decay
    const candidateTurns = this.history.getTurnsByIds([...turnIdSet]);
    const allTurns       = this.history.getSessionTurns(sessionKey);
    const turnMap        = new Map(allTurns.map(t => [t.id, t]));

    const rankedTurns = candidateTurns
      .map(t => {
        const full  = turnMap.get(t.id);
        const tVec  = full?.embedding ? HistoryStore.toFloat32(full.embedding) : null;
        const sim   = tVec ? Embedder.cosine(queryVec, tVec) : 0.3;
        const decay = full?.importance ?? 0.5;
        return { ...t, score: sim * 0.7 + decay * 0.3 };
      })
      .sort((a, b) => b.score - a.score);

    return this._fillBudget(rankedTurns, maxSlots, budget, cpt, minChars, sessionKey);
  }

  async _rawTurnRetrieval(sessionKey, queryVec, recencyCount, maxSlots, budget, cpt, minChars) {
    const allTurns   = this.history.getSessionTurns(sessionKey);
    const candidates = allTurns.slice(0, Math.max(0, allTurns.length - recencyCount));

    const scored = candidates
      .filter(t => t.role === 'assistant' && t.content.length >= minChars)
      .map(t => {
        const tVec = HistoryStore.toFloat32(t.embedding);
        const sim  = tVec && queryVec ? Embedder.cosine(queryVec, tVec) : 0;
        return { ...t, score: sim };
      })
      .sort((a, b) => b.score - a.score);

    return this._fillBudget(scored, maxSlots, budget, cpt, minChars, sessionKey);
  }

  _fillBudget(rankedTurns, maxSlots, budget, cpt, minChars, sessionKey) {
    const selected = [];
    const seenIds  = new Set();

    for (const t of rankedTurns) {
      if (selected.length >= maxSlots) break;
      if (seenIds.has(t.id)) continue;
      const cost = Math.ceil((t.content?.length ?? 0) / cpt);
      if (cost > budget) continue;
      selected.push(t);
      seenIds.add(t.id);
      budget -= cost;
      this.history.bumpTurnRecall(t.id);
    }

    // Sort chronologically so context reads naturally
    selected.sort((a, b) => a.created_at - b.created_at);

    return selected.map(t => ({ role: t.role, content: t.content }));
  }

  _est(msgs, cpt) {
    return msgs.reduce((s, m) => s + Math.ceil((m.content?.length ?? 0) / cpt), 0);
  }
}

module.exports = Selector;
