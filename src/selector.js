/**
 * selector.js — Scene-guided context selection with memory injection
 *
 * Two-stage pipeline inspired by EverMemOS + claude-mem's before_prompt_build:
 *
 * Stage 1 — System message injection:
 *   Find top relevant MemScenes, build a compact <memory> block, and
 *   append it to the system message. This mirrors claude-mem's approach:
 *   the model is explicitly told what it knows before the conversation starts.
 *
 * Stage 2 — Rotating turn slots:
 *   Fill remaining token budget with turns from relevant scenes.
 *   Falls back to raw turn similarity if no scenes exist yet.
 *
 * Final context shape:
 *   [system + <memory> block] + [rotating relevant turns] + [last N turns verbatim]
 */

const HistoryStore = require('./history.js');
const Embedder     = require('./embedder.js');

// How many scenes to summarise in the injection block
const INJECTION_SCENES = 3;
// Minimum scene similarity to include in injection
const INJECTION_MIN_SIM = 0.45;

class Selector {
  constructor(config, historyStore, embedder) {
    this.cfg      = config.context;
    this.history  = historyStore;
    this.embedder = embedder;
  }

  async select(sessionKey, incoming) {
    const { tokenBudget, systemReserveTokens, recencyTurns, rotatingSlots, charsPerToken, minChunkChars } = this.cfg;

    const systemMsgs = incoming.filter(m => m.role === 'system');
    const convoMsgs  = incoming.filter(m => m.role !== 'system');
    const currentMsg = convoMsgs[convoMsgs.length - 1];
    const queryText  = currentMsg?.content ?? '';

    const queryVec = await this.embedder.embed(queryText);

    // Recency buffer — always included verbatim
    const recencyWindow = recencyTurns * 2;
    const recencyMsgs   = convoMsgs.slice(Math.max(0, convoMsgs.length - recencyWindow));

    // Load scenes once — used by both injection and rotation
    const scenes = this.history.getScenes(sessionKey);

    // ─── Stage 1: Build memory + foresight injection block ───────────────────
    const foresights     = this.history.getActiveForesights(sessionKey, 3);
    const enrichedSystem = this._buildSystemWithMemory(systemMsgs, scenes, queryVec, foresights);

    // ─── Budget accounting ────────────────────────────────────────────────────
    const systemTokens  = this._est(enrichedSystem, charsPerToken);
    const recencyTokens = this._est(recencyMsgs, charsPerToken);
    let budget = tokenBudget - systemReserveTokens - systemTokens - recencyTokens;

    // ─── Stage 2: Rotating turn slots ────────────────────────────────────────
    let rotatingMsgs = [];
    if (scenes.length > 0 && queryVec) {
      rotatingMsgs = await this._sceneGuidedRetrieval(sessionKey, queryVec, scenes, rotatingSlots, budget, charsPerToken, minChunkChars);
    } else {
      rotatingMsgs = await this._rawTurnRetrieval(sessionKey, queryVec, recencyMsgs.length, rotatingSlots, budget, charsPerToken, minChunkChars);
    }

    const final = [...enrichedSystem, ...rotatingMsgs, ...recencyMsgs];

    const stats = this.history.stats(sessionKey);
    console.log(
      `[selector] session=${sessionKey.slice(0,8)} ` +
      `turns=${stats.turns} cells=${stats.cells} scenes=${stats.scenes} foresights=${stats.foresights} ` +
      `injected=${enrichedSystem.length > systemMsgs.length ? 'yes' : 'no'} ` +
      `rotating=${rotatingMsgs.length} recency=${recencyMsgs.length}`
    );

    return final;
  }

  /**
   * Append a <memory> block (and optional <foresight> block) to the last system message.
   * Only includes scenes above the similarity threshold, so irrelevant
   * memories are never injected (preventing the "skiptracer" problem).
   */
  _buildSystemWithMemory(systemMsgs, scenes, queryVec, foresights = []) {
    const hasMemory    = scenes.length > 0 && queryVec;
    const hasForesight = foresights.length > 0;
    if (!hasMemory && !hasForesight) return systemMsgs;

    let injection = '';

    // ─── Memory block ────────────────────────────────────────────────────────
    if (hasMemory) {
      const relevant = scenes
        .map(s => {
          const sVec = HistoryStore.toFloat32(s.embedding);
          const sim  = sVec ? Embedder.cosine(queryVec, sVec) : 0;
          return { ...s, sim };
        })
        .filter(s => s.sim >= INJECTION_MIN_SIM)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, INJECTION_SCENES);

      if (relevant.length) {
        const memLines = relevant.map(s => `• [${s.title}] ${s.summary}`).join('\n');
        injection += `\n\n<memory>\nRelevant context from previous sessions:\n${memLines}\n</memory>`;
      }
    }

    // ─── Foresight block ─────────────────────────────────────────────────────
    if (hasForesight) {
      const fLines = foresights.map(f => {
        const tag = f.target ? ` (${f.target})` : '';
        return `• [${f.timeframe}]${tag} ${f.intention}`;
      }).join('\n');
      injection += `\n\n<foresight>\nPending intentions from recent context:\n${fLines}\n</foresight>`;
    }

    if (!injection) return systemMsgs;

    // Append to the last system message (or create one if none exist)
    if (systemMsgs.length === 0) {
      return [{ role: 'system', content: injection.trim() }];
    }

    const enriched = [...systemMsgs];
    enriched[enriched.length - 1] = {
      ...enriched[enriched.length - 1],
      content: enriched[enriched.length - 1].content + injection
    };
    return enriched;
  }

  async _sceneGuidedRetrieval(sessionKey, queryVec, scenes, maxSlots, budget, cpt, minChars) {
    const scored = scenes
      .map(s => {
        const sVec = HistoryStore.toFloat32(s.embedding);
        // Weight similarity by scene's average importance
        const sim  = sVec ? Embedder.cosine(queryVec, sVec) : 0;
        return { ...s, weightedSim: sim * (0.7 + s.avg_importance * 0.3) };
      })
      .sort((a, b) => b.weightedSim - a.weightedSim)
      .slice(0, maxSlots * 2);

    const turnIdSet = new Set();
    for (const scene of scored) {
      this.history.bumpSceneRecall(scene.id);
      let ids;
      try { ids = JSON.parse(scene.memcell_ids); } catch { continue; }
      if (!ids.length) continue;

      const ph = ids.map(() => '?').join(',');
      const cellTurnIds = this.history.db.prepare(
        `SELECT DISTINCT turn_id FROM memcells WHERE id IN (${ph}) AND turn_id IS NOT NULL`
      ).all(...ids).map(r => r.turn_id);

      for (const id of cellTurnIds) turnIdSet.add(id);
      if (turnIdSet.size >= maxSlots * 4) break;
    }

    const candidateTurns = this.history.getTurnsByIds([...turnIdSet]);
    const allTurns       = this.history.getSessionTurns(sessionKey);
    const turnMap        = new Map(allTurns.map(t => [t.id, t]));

    const ranked = candidateTurns.map(t => {
      const full  = turnMap.get(t.id);
      const tVec  = full?.embedding ? HistoryStore.toFloat32(full.embedding) : null;
      const sim   = tVec ? Embedder.cosine(queryVec, tVec) : 0.3;
      const imp   = full?.importance ?? 0.5;
      return { ...t, score: sim * 0.7 + imp * 0.3 };
    }).sort((a, b) => b.score - a.score);

    return this._fillBudget(ranked, maxSlots, budget, cpt, minChars, sessionKey);
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

  _fillBudget(ranked, maxSlots, budget, cpt, minChars, sessionKey) {
    const selected = [];
    const seenIds  = new Set();
    for (const t of ranked) {
      if (selected.length >= maxSlots) break;
      if (seenIds.has(t.id)) continue;
      const cost = Math.ceil((t.content?.length ?? 0) / cpt);
      if (cost > budget) continue;
      selected.push(t);
      seenIds.add(t.id);
      budget -= cost;
      this.history.bumpTurnRecall(t.id);
    }
    selected.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    return selected.map(t => ({ role: t.role, content: t.content }));
  }

  _est(msgs, cpt) {
    return msgs.reduce((s, m) => s + Math.ceil((m.content?.length ?? 0) / cpt), 0);
  }
}

module.exports = Selector;
