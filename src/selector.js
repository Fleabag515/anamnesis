/**
 * selector.js — working-set assembly (virtual-context v2).
 *
 * The context window is treated as a working set over three tiers:
 *
 *   verbatim   — stable system block, the task head, the last K exchanges
 *   compacted  — older exchanges of the *current* conversation, atomically
 *                replaced by one-line summaries; oversized tool results are
 *                spilled to the ArtifactStore and represented by handles the
 *                model can dereference via the injected `recall` tool
 *   retrieved  — episodic memory (scenes/foresights) and relevant past turns,
 *                quoted inside ONE <recall-context> block instead of being
 *                interleaved as fake conversation messages
 *
 * Prompt layout (prefix-stable between refreshes — llama.cpp prompt caching
 * actually hits on agentic step N+1):
 *
 *   [ system: persona + client system ]      ← byte-identical across steps
 *   [ system: <recall-context> ]             ← refreshed every N requests
 *   [ task head ]                            ← pinned verbatim
 *   [ kept / compacted middle, chronological ]
 *   [ last K exchanges verbatim ]
 *
 * Tool-call exchanges (assistant tool_calls + their `tool` results) are
 * grouped by lib/exchanges.js and always survive or evict as one unit, so
 * pairing can never break mid-window.
 */

'use strict';

const HistoryStore = require('./history.js');
const Embedder = require('./embedder.js');
const { extractContentText, stripThinkingTokens } = require('./lib/proxy-helpers.js');
const {
  groupUnits,
  taskHeadIndex,
  planEviction,
  compactUnit,
  unitText,
  contentToText,
} = require('./lib/exchanges.js');
const log = require('./lib/logger.js').make('selector');

// How many scenes to quote in the recall-context block.
const INJECTION_SCENES = 3;
// Minimum scene similarity to include.
const INJECTION_MIN_SIM = 0.45;
// Max share of the budget the recall-context block may take.
const INJECTION_MAX_SHARE = 0.15;

class Selector {
  constructor(config, historyStore, embedder, persona = null, governor = null, artifacts = null) {
    this.cfg = config.context ?? {};
    this.history = historyStore;
    this.embedder = embedder;
    this.persona = persona;
    this.governor = governor; // null in legacy tests → estimate-only path
    this.artifacts = artifacts;
    this._ctxCache = new Map(); // sessionKey -> {content, counter}
  }

  /**
   * Assemble the working set. Returns { messages, assessment }.
   */
  async select(sessionKey, incoming) {
    const pinnedExchanges = this.cfg.pinnedExchanges ?? this.cfg.recencyTurns ?? 3;
    const refreshTurns = this.cfg.memoryRefreshTurns ?? 4;
    const spillTokens = this.artifacts?.spillTokens ?? 1500;

    const systemMsgs = incoming.filter((m) => m.role === 'system');
    const convoMsgs = incoming.filter((m) => m.role !== 'system');
    const queryText = extractContentText(convoMsgs[convoMsgs.length - 1]?.content);
    const queryVec = queryText ? await this.embedder.embed(queryText).catch(() => null) : null;

    // ── Stable head ─────────────────────────────────────────────────────────
    const stableSystem = this._stableSystem(systemMsgs);

    // ── Semi-stable recall-context block (cached between refreshes) ─────────
    const budget = this.governor ? this.governor.budget() : (this.cfg.tokenBudget ?? 8192);
    const recallCtx = await this._recallContext(
      sessionKey,
      queryVec,
      refreshTurns,
      Math.floor(budget * INJECTION_MAX_SHARE)
    );

    // ── Unit structure ──────────────────────────────────────────────────────
    const units = groupUnits(convoMsgs);
    const headIdx = taskHeadIndex(units);
    const pinned = new Set();
    if (headIdx >= 0) pinned.add(headIdx);
    for (let i = Math.max(0, units.length - pinnedExchanges); i < units.length; i++) pinned.add(i);

    // ── Costing ─────────────────────────────────────────────────────────────
    const costs = await Promise.all(units.map((u) => this._count(unitText(u))));
    const overhead = units.map((u) => u.msgs.length * 4);
    for (let i = 0; i < costs.length; i++) costs[i] += overhead[i];

    const fixedCost =
      (await this._count(stableSystem.map((m) => m.content).join('\n'))) +
      (recallCtx ? await this._count(recallCtx) : 0) +
      [...pinned].reduce((s, i) => s + (costs[i] ?? 0), 0);

    const middleBudget = budget - fixedCost;

    // ── Emergency: even the pinned set is too big ───────────────────────────
    if (middleBudget < 0) {
      return this._emergency(sessionKey, stableSystem, units, headIdx, costs, budget);
    }

    // ── Eviction plan ───────────────────────────────────────────────────────
    const { keep, evict } = planEviction(units, costs, pinned, middleBudget);

    // Spill oversized tool results from evicted units, then compact.
    const compacted = new Map(); // unitIdx -> message
    for (const idx of evict) {
      const unit = units[idx];
      const notes = new Map();
      if (this.artifacts) {
        for (let k = 0; k < unit.msgs.length; k++) {
          const m = unit.msgs[k];
          if (m.role !== 'tool') continue;
          const text = contentToText(m.content);
          const est = await this._count(text);
          if (est >= spillTokens) {
            const toolName = this._toolNameFor(unit, m);
            const { handle } = this.artifacts.spill(sessionKey, {
              toolName,
              content: text,
              tokenEst: est,
            });
            notes.set(m.tool_call_id ?? k, handle);
          }
        }
      }
      compacted.set(idx, compactUnit(unit, notes));
    }

    // ── Assemble, chronological ─────────────────────────────────────────────
    const out = [...stableSystem];
    if (recallCtx) out.push({ role: 'system', content: recallCtx });

    const manyEvicted = evict.length > 4;
    let digestEmitted = false;
    for (let i = 0; i < units.length; i++) {
      if (keep.has(i)) {
        out.push(...units[i].msgs);
      } else if (manyEvicted) {
        if (!digestEmitted) {
          const lines = evict.map((idx) => compacted.get(idx).content).join('\n');
          out.push({
            role: 'assistant',
            content: `[${evict.length} earlier steps compacted to stay in context]\n${lines}`,
          });
          digestEmitted = true;
        }
      } else {
        out.push(compacted.get(i));
      }
    }

    // ── Assess + report ─────────────────────────────────────────────────────
    const used = fixedCost + [...keep].reduce((s, i) => s + (pinned.has(i) ? 0 : costs[i]), 0);
    const assessment = this.governor
      ? this.governor.assess(used + this.governor.completionReserve)
      : { level: 'ok', used, nCtx: budget, ratio: used / budget };

    log.debug(
      `session=${sessionKey.slice(0, 8)} units=${units.length} kept=${keep.size} ` +
        `evicted=${evict.length} used≈${used} budget=${budget} level=${assessment.level}`
    );

    return { messages: out, assessment };
  }

  // ─── Pieces ───────────────────────────────────────────────────────────────

  /** Persona + client system prompt — never varies per request. */
  _stableSystem(systemMsgs) {
    const charBlock = this.persona ? this.persona.getCharacterBlock() : '';
    const clientSystem = systemMsgs.map((m) => contentToText(m.content)).join('\n\n');
    const content = [charBlock.trim(), clientSystem.trim()].filter(Boolean).join('\n\n');
    return content ? [{ role: 'system', content }] : [];
  }

  /**
   * Episodic memory, foresights, and retrieved turn excerpts — one block,
   * quoted not interleaved, refreshed every `refreshTurns` requests so the
   * prompt prefix stays cacheable in between.
   */
  async _recallContext(sessionKey, queryVec, refreshTurns, maxTokens) {
    const cached = this._ctxCache.get(sessionKey);
    if (cached) {
      cached.counter++;
      if (cached.counter % refreshTurns !== 0) return cached.content;
    }

    const content = await this._buildRecallContext(sessionKey, queryVec, maxTokens);
    this._ctxCache.set(sessionKey, { content, counter: cached?.counter ?? 1 });
    return content;
  }

  async _buildRecallContext(sessionKey, queryVec, maxTokens) {
    const scenes = this.history.getScenes(sessionKey);
    const foresights = this.history.getActiveForesights(sessionKey, 3);
    const currentModel = this.embedder.model;
    const parts = [];

    if (scenes.length && queryVec) {
      const relevant = scenes
        .map((s) => ({ ...s, sim: this._sceneSim(s, queryVec, currentModel) }))
        .filter((s) => s.sim >= INJECTION_MIN_SIM)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, INJECTION_SCENES);
      if (relevant.length) {
        parts.push(
          'Memories — things you actually experienced in previous sessions:\n' +
            relevant.map((s) => `• [${s.title}] ${s.summary}`).join('\n')
        );
      }

      // Relevant past turns, quoted (never re-injected as fake messages).
      const excerpts = this._turnExcerpts(sessionKey, queryVec, currentModel, scenes);
      if (excerpts.length) {
        parts.push('Relevant earlier exchanges (quoted):\n' + excerpts.join('\n'));
      }
    }

    if (foresights.length) {
      parts.push(
        'Your own intentions — things you were planning to do:\n' +
          foresights
            .map((f) => `• [${f.timeframe}]${f.target ? ` (${f.target})` : ''} ${f.intention}`)
            .join('\n')
      );
    }

    if (this.artifacts) {
      const st = this.artifacts.stats(sessionKey);
      if (st && st.count > 0) {
        parts.push(
          `${st.count} archived artifact(s) from this session are available via the recall tool.`
        );
      }
    }

    if (!parts.length) return '';
    let block = `<recall-context>\n${parts.join('\n\n')}\n</recall-context>`;
    // Hard cap: quoted memory must never crowd out the live conversation.
    const cap = Math.max(400, maxTokens) * (this.governor?.charsPerToken ?? 3.5);
    if (block.length > cap) block = block.slice(0, cap) + '\n…</recall-context>';
    return block;
  }

  _sceneSim(s, queryVec, currentModel) {
    if (s.embedding_model && s.embedding_model !== currentModel) return 0.2;
    const sVec = HistoryStore.toFloat32(s.embedding);
    return sVec ? Embedder.constructor.cosine(queryVec, sVec) : 0;
  }

  /** Scene-guided turn retrieval, rendered as quoted excerpt lines. */
  _turnExcerpts(sessionKey, queryVec, currentModel, scenes, maxLines = 4) {
    const scored = scenes
      .map((s) => ({
        ...s,
        weightedSim: this._sceneSim(s, queryVec, currentModel) * (0.7 + s.avg_importance * 0.3),
      }))
      .sort((a, b) => b.weightedSim - a.weightedSim)
      .slice(0, maxLines * 2);

    const turnIdSet = new Set();
    for (const scene of scored) {
      this.history.bumpSceneRecall(scene.id);
      let ids;
      try {
        ids = JSON.parse(scene.engram_ids);
      } catch {
        continue;
      }
      if (!ids.length) continue;
      for (const id of this.history.getTurnIdsForMemcells(ids)) turnIdSet.add(id);
      if (turnIdSet.size >= maxLines * 3) break;
    }

    const allTurns = this.history.getSessionTurns(sessionKey);
    const turnMap = new Map(allTurns.map((t) => [t.id, t]));
    const ranked = this.history
      .getTurnsByIds([...turnIdSet])
      .map((t) => {
        const full = turnMap.get(t.id);
        if (full?.embedding_model && full.embedding_model !== currentModel) {
          return { ...t, score: (full?.importance ?? 0.5) * 0.5 };
        }
        const tVec = full?.embedding ? HistoryStore.toFloat32(full.embedding) : null;
        const sim = tVec ? Embedder.constructor.cosine(queryVec, tVec) : 0.3;
        return { ...t, score: sim * 0.7 + (full?.importance ?? 0.5) * 0.3 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxLines);

    return ranked.map((t) => {
      this.history.bumpTurnRecall(t.id);
      const text = stripThinkingTokens(t.content ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 280);
      return `• (${t.role}) "${text}"`;
    });
  }

  /** Keep the absolute minimum: system, head, digest, last two units. */
  async _emergency(sessionKey, stableSystem, units, headIdx, costs, budget) {
    const out = [...stableSystem];
    const lastTwo = new Set([units.length - 1, units.length - 2].filter((i) => i >= 0));
    if (headIdx >= 0 && !lastTwo.has(headIdx)) out.push(...units[headIdx].msgs);

    const middle = [];
    for (let i = 0; i < units.length; i++) {
      if (i === headIdx || lastTwo.has(i)) continue;
      middle.push(compactUnit(units[i]).content);
    }
    if (middle.length) {
      out.push({
        role: 'assistant',
        content:
          `[context emergency: ${middle.length} steps compacted — use recall for archived detail]\n` +
          middle.slice(-12).join('\n'),
      });
    }
    for (const i of [...lastTwo].sort((a, b) => a - b)) out.push(...units[i].msgs);

    const used = await this._count(out.map((m) => contentToText(m.content)).join('\n'));
    const assessment = this.governor
      ? this.governor.assess(used + this.governor.completionReserve)
      : { level: 'emergency', used, nCtx: budget, ratio: 1 };
    log.warn(`emergency compaction for session=${sessionKey.slice(0, 8)} used≈${used}`);
    return { messages: out, assessment: { ...assessment, level: 'emergency' } };
  }

  _count(text) {
    if (this.governor) return this.governor.count(text);
    return Promise.resolve(Math.ceil((text?.length ?? 0) / (this.cfg.charsPerToken ?? 3.5)));
  }

  _toolNameFor(unit, toolMsg) {
    const call = (unit.msgs[0].tool_calls ?? []).find((c) => c?.id === toolMsg.tool_call_id);
    return call?.function?.name ?? '';
  }
}

module.exports = Selector;
