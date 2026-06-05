/**
 * selector.js — Scene-guided context selection with memory injection.
 *
 * Two-stage pipeline inspired by EverMemOS and claude-mem's before_prompt_build:
 *
 * Stage 1 — System-message injection:
 *   Find top relevant MemScenes, build a compact <memory> block, append it
 *   to the last system message. The model is explicitly *told* what it
 *   already knows. Only scenes above INJECTION_MIN_SIM are included, which
 *   prevents the "skiptracer" problem (irrelevant past context leaking in).
 *
 * Stage 2 — Rotating turn slots:
 *   Fill remaining token budget with turns from relevant scenes. Falls back
 *   to raw turn similarity if no scenes exist yet.
 *
 * Final context shape:
 *   [system + <memory> block] + [rotating relevant turns] + [last N turns verbatim]
 */

const HistoryStore = require('./history.js');
const Embedder = require('./embedder.js');
const { extractContentText } = require('./lib/proxy-helpers.js');
const log = require('./lib/logger.js').make('selector');

// How many scenes to summarise in the injection block.
const INJECTION_SCENES = 3;
// Minimum scene similarity to include in injection.
const INJECTION_MIN_SIM = 0.45;

class Selector {
  constructor(config, historyStore, embedder, persona = null) {
    this.cfg = config.context;
    this.history = historyStore;
    this.embedder = embedder;
    this.persona = persona; // PersonaManager instance or null
  }

  async select(sessionKey, incoming) {
    const {
      tokenBudget,
      systemReserveTokens,
      recencyTurns,
      rotatingSlots,
      charsPerToken,
      minChunkChars,
    } = this.cfg;

    const systemMsgs = incoming.filter((m) => m.role === 'system');
    const convoMsgs = incoming.filter((m) => m.role !== 'system');
    const currentMsg = convoMsgs[convoMsgs.length - 1];
    // Normalise possibly-array content (OpenAI multipart) into plain text
    // so the embedding sees the same string that gets stored as the turn.
    const queryText = extractContentText(currentMsg?.content);
    const queryVec = queryText ? await this.embedder.embed(queryText) : null;
    const currentModel = this.embedder.model;

    // Recency buffer — always included verbatim.
    const recencyWindow = recencyTurns * 2;
    const recencyMsgs = convoMsgs.slice(Math.max(0, convoMsgs.length - recencyWindow));

    const scenes = this.history.getScenes(sessionKey);

    // ─── Stage 1: build memory + foresight injection block ──────────────────
    const foresights = this.history.getActiveForesights(sessionKey, 3);
    const enrichedSystem = this._buildSystemWithMemory(
      systemMsgs,
      scenes,
      queryVec,
      currentModel,
      foresights
    );

    // ─── Budget accounting ─────────────────────────────────────────────────
    const systemTokens = this._est(enrichedSystem, charsPerToken);
    const recencyTokens = this._est(recencyMsgs, charsPerToken);
    const budget = tokenBudget - systemReserveTokens - systemTokens - recencyTokens;

    // ─── Stage 2: rotating turn slots ──────────────────────────────────────
    let rotatingMsgs = [];
    if (scenes.length > 0 && queryVec) {
      rotatingMsgs = this._sceneGuidedRetrieval(
        sessionKey,
        queryVec,
        currentModel,
        scenes,
        rotatingSlots,
        budget,
        charsPerToken,
        minChunkChars
      );
    } else {
      rotatingMsgs = this._rawTurnRetrieval(
        sessionKey,
        queryVec,
        currentModel,
        recencyMsgs.length,
        rotatingSlots,
        budget,
        charsPerToken,
        minChunkChars
      );
    }

    const final = [...enrichedSystem, ...rotatingMsgs, ...recencyMsgs];

    // Debug-level: noisy when many requests/sec. Bump ANAMNESIS_LOG=debug.
    const stats = this.history.stats(sessionKey);
    log.debug(
      `session=${sessionKey.slice(0, 8)} ` +
        `turns=${stats.turns} cells=${stats.cells} scenes=${stats.scenes} foresights=${stats.foresights} ` +
        `injected=${enrichedSystem.length > systemMsgs.length ? 'yes' : 'no'} ` +
        `rotating=${rotatingMsgs.length} recency=${recencyMsgs.length}`
    );

    return final;
  }

  /**
   * Append <memory> and <foresight> blocks to the last system message.
   */
  _buildSystemWithMemory(systemMsgs, scenes, queryVec, currentModel, foresights = []) {
    const hasMemory = scenes.length > 0 && queryVec;
    const hasForesight = foresights.length > 0;
    const _charBlock = this.persona ? this.persona.getCharacterBlock() : '';
    if (!hasMemory && !hasForesight) {
      if (!_charBlock) return systemMsgs;
      // Inject character block even when no memories or foresights are present
      if (systemMsgs.length === 0) return [{ role: 'system', content: _charBlock.trim() }];
      const _enriched = [...systemMsgs];
      _enriched[_enriched.length - 1] = {
        ..._enriched[_enriched.length - 1],
        content: _enriched[_enriched.length - 1].content + _charBlock,
      };
      return _enriched;
    }

    // Character block is always prepended (persona handles its own enabled check)
    const characterBlock = this.persona ? this.persona.getCharacterBlock() : '';
    let injection = characterBlock;

    if (hasMemory) {
      const relevant = scenes
        .map((s) => {
          if (s.embedding_model && s.embedding_model !== currentModel) {
            return { ...s, sim: 0 };
          }
          const sVec = HistoryStore.toFloat32(s.embedding);
          const sim = sVec ? Embedder.cosine(queryVec, sVec) : 0;
          return { ...s, sim };
        })
        .filter((s) => s.sim >= INJECTION_MIN_SIM)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, INJECTION_SCENES);

      if (relevant.length) {
        const memLines = relevant.map((s) => `• [${s.title}] ${s.summary}`).join('\n');
        injection += `\n\n<memory>\nRelevant context from previous sessions:\n${memLines}\n</memory>`;
      }
    }

    if (hasForesight) {
      const fLines = foresights
        .map((f) => {
          const tag = f.target ? ` (${f.target})` : '';
          return `• [${f.timeframe}]${tag} ${f.intention}`;
        })
        .join('\n');
      injection += `\n\n<foresight>\nPending intentions from recent context:\n${fLines}\n</foresight>`;
    }

    if (!injection) return systemMsgs;

    if (systemMsgs.length === 0) {
      return [{ role: 'system', content: injection.trim() }];
    }
    const enriched = [...systemMsgs];
    enriched[enriched.length - 1] = {
      ...enriched[enriched.length - 1],
      content: enriched[enriched.length - 1].content + injection,
    };
    return enriched;
  }

  _sceneGuidedRetrieval(
    sessionKey,
    queryVec,
    currentModel,
    scenes,
    maxSlots,
    budget,
    cpt,
    minChars
  ) {
    const scored = scenes
      .map((s) => {
        if (s.embedding_model && s.embedding_model !== currentModel) {
          return { ...s, weightedSim: 0 };
        }
        const sVec = HistoryStore.toFloat32(s.embedding);
        const sim = sVec ? Embedder.cosine(queryVec, sVec) : 0;
        return { ...s, weightedSim: sim * (0.7 + s.avg_importance * 0.3) };
      })
      .sort((a, b) => b.weightedSim - a.weightedSim)
      .slice(0, maxSlots * 2);

    const turnIdSet = new Set();
    for (const scene of scored) {
      this.history.bumpSceneRecall(scene.id);
      let ids;
      try {
        ids = JSON.parse(scene.memcell_ids);
      } catch {
        continue;
      }
      if (!ids.length) continue;

      for (const id of this.history.getTurnIdsForMemcells(ids)) turnIdSet.add(id);
      if (turnIdSet.size >= maxSlots * 4) break;
    }

    const candidateTurns = this.history.getTurnsByIds([...turnIdSet]);
    const allTurns = this.history.getSessionTurns(sessionKey);
    const turnMap = new Map(allTurns.map((t) => [t.id, t]));

    const ranked = candidateTurns
      .map((t) => {
        const full = turnMap.get(t.id);
        if (full?.embedding_model && full.embedding_model !== currentModel) {
          return { ...t, score: (full?.importance ?? 0.5) * 0.3 };
        }
        const tVec = full?.embedding ? HistoryStore.toFloat32(full.embedding) : null;
        const sim = tVec ? Embedder.cosine(queryVec, tVec) : 0.3;
        const imp = full?.importance ?? 0.5;
        return { ...t, score: sim * 0.7 + imp * 0.3 };
      })
      .sort((a, b) => b.score - a.score);

    return this._fillBudget(ranked, maxSlots, budget, cpt, minChars);
  }

  _rawTurnRetrieval(
    sessionKey,
    queryVec,
    currentModel,
    recencyCount,
    maxSlots,
    budget,
    cpt,
    minChars
  ) {
    const allTurns = this.history.getSessionTurns(sessionKey);
    const candidates = allTurns.slice(0, Math.max(0, allTurns.length - recencyCount));

    const scored = candidates
      .filter((t) => t.role === 'assistant' && t.content.length >= minChars)
      .map((t) => {
        if (t.embedding_model && t.embedding_model !== currentModel) {
          return { ...t, score: 0 };
        }
        const tVec = HistoryStore.toFloat32(t.embedding);
        const sim = tVec && queryVec ? Embedder.cosine(queryVec, tVec) : 0;
        return { ...t, score: sim };
      })
      .sort((a, b) => b.score - a.score);

    return this._fillBudget(scored, maxSlots, budget, cpt, minChars);
  }

  /**
   * Fill up to `maxSlots` from `ranked` (descending score) without exceeding
   * the token budget. When an item doesn't fit we `continue` rather than
   * `break` so a small high-value item can still slot in after a too-big
   * one is rejected — at the cost of slight non-monotonicity in selection
   * order. We re-sort the selected items by created_at so the conversation
   * reads chronologically when re-injected.
   */
  _fillBudget(ranked, maxSlots, budget, cpt, _minChars) {
    const selected = [];
    const seenIds = new Set();
    let remaining = budget;
    for (const t of ranked) {
      if (selected.length >= maxSlots) break;
      if (seenIds.has(t.id)) continue;
      const cost = Math.ceil((t.content?.length ?? 0) / cpt);
      if (cost > remaining) continue; // skip oversized; try the next, smaller item
      selected.push(t);
      seenIds.add(t.id);
      remaining -= cost;
      this.history.bumpTurnRecall(t.id);
    }
    selected.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    return selected.map((t) => ({ role: t.role, content: t.content }));
  }

  _est(msgs, cpt) {
    return msgs.reduce((s, m) => s + Math.ceil((m.content?.length ?? 0) / cpt), 0);
  }
}

module.exports = Selector;
