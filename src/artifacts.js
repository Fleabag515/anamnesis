/**
 * artifacts.js — the backing store for evicted context (the "swap").
 *
 * Big tool results (and any other oversized content) are *spilled* here
 * instead of being silently dropped: full text in SQLite, chunk-embedded in
 * the background, represented in the live prompt by a short handle the model
 * can dereference through the proxy-injected `recall` tool.
 *
 * Summaries are deliberately extractive (head/tail quotes, counts) — no LLM
 * in the synchronous path, nothing invented. The engram extractor still sees
 * the full stored text via the turns table, so semantic memory of tool
 * activity accrues exactly like chat memory does.
 */

'use strict';

const crypto = require('crypto');
const log = require('./lib/logger.js').make('artifacts');

const CHUNK_CHARS = 1200;

class ArtifactStore {
  constructor(config, history, embedder) {
    const a = config.artifacts ?? {};
    this.history = history;
    this.embedder = embedder;
    this.spillTokens = a.spillTokens ?? 1500;
    this.maxChunks = a.maxChunks ?? 16;
    this.defaultRecallChars = a.recallChars ?? 6000;
  }

  /**
   * Store `content` as an artifact (idempotent per session by content hash).
   * Returns {id, summary, tokenEst, handle} synchronously; chunk embedding
   * happens in the background.
   */
  spill(sessionKey, { toolName = '', content, tokenEst = 0, turnId = null }) {
    const text = String(content ?? '');
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    const existing = this.history.findArtifactByHash(sessionKey, hash);
    if (existing) {
      return {
        id: existing.id,
        summary: existing.summary,
        tokenEst: existing.token_est,
        handle: this.handleLine(existing),
      };
    }

    let id = crypto.randomBytes(4).toString('hex');
    while (this.history.getArtifact(id)) id = crypto.randomBytes(4).toString('hex');

    const summary = mechanicalSummary(text);
    this.history.insertArtifact({
      id,
      sessionKey,
      turnId,
      toolName,
      content: text,
      contentHash: hash,
      tokenEst,
      summary,
    });

    // Background: chunk + embed for semantic recall. Never blocks a request.
    setImmediate(() => this._embedChunks(id, text).catch((e) => log.warn('embed:', e.message)));

    const row = { id, tool_name: toolName, token_est: tokenEst, summary };
    return { id, summary, tokenEst, handle: this.handleLine(row) };
  }

  async _embedChunks(artifactId, text) {
    const chunks = chunkText(text, CHUNK_CHARS, this.maxChunks);
    for (let i = 0; i < chunks.length; i++) {
      const vec = await this.embedder.embed(chunks[i]).catch(() => null);
      this.history.insertArtifactChunk(artifactId, i, chunks[i], vec, this.embedder.model);
    }
  }

  /** The in-prompt representation of an evicted artifact. */
  handleLine(row) {
    const src = row.tool_name ? `${row.tool_name} result` : 'archived content';
    return (
      `[artifact ${row.id} · ${src} · ~${row.token_est} tok · evicted] ` +
      `${row.summary} — recall({"id":"${row.id}"}) to reload`
    );
  }

  /**
   * Resolve a recall tool call. Returns plain text for the tool message.
   * Never throws — errors come back as text the model can act on.
   */
  async recall(sessionKey, args = {}) {
    try {
      if (args.id) return this._recallById(String(args.id), args);
      if (args.query) return await this._recallByQuery(sessionKey, String(args.query));
      return 'recall: provide {"id":"…"} or {"query":"…"}.';
    } catch (e) {
      log.warn('recall:', e.message);
      return `recall failed: ${e.message}`;
    }
  }

  _recallById(id, { offset = 0, max_chars: maxChars = this.defaultRecallChars } = {}) {
    const row = this.history.getArtifact(id);
    if (!row) return `recall: no artifact "${id}" — it may have been pruned.`;
    this.history.bumpArtifactRecall(id);
    const start = Math.max(0, Number(offset) || 0);
    const cap = Math.max(200, Math.min(Number(maxChars) || this.defaultRecallChars, 24000));
    const slice = row.content.slice(start, start + cap);
    const remaining = row.content.length - (start + slice.length);
    let out = `[artifact ${id}`;
    if (row.tool_name) out += ` · ${row.tool_name}`;
    out += ` · chars ${start}–${start + slice.length} of ${row.content.length}]\n${slice}`;
    if (remaining > 0) {
      out += `\n[…${remaining} chars remain — recall({"id":"${id}","offset":${start + slice.length}}) to continue]`;
    }
    return out;
  }

  async _recallByQuery(sessionKey, query) {
    const queryVec = await this.embedder.embed(query).catch(() => null);
    const scored = [];

    if (queryVec) {
      const cosine = this.embedder.constructor.cosine;
      for (const ch of this.history.getArtifactChunksBySession(sessionKey)) {
        if (ch.embedding_model && ch.embedding_model !== this.embedder.model) continue;
        const vec = this.history.constructor.toFloat32(ch.embedding);
        if (!vec) continue;
        scored.push({ ...ch, sim: cosine(queryVec, vec) });
      }
      scored.sort((a, b) => b.sim - a.sim);
    }

    // best chunk per artifact, at most 3 distinct artifacts
    const seen = new Set();
    const top = [];
    for (const c of scored) {
      if (c.sim < 0.35 || seen.has(c.artifact_id)) continue;
      seen.add(c.artifact_id);
      top.push(c);
      if (top.length >= 3) break;
    }
    if (!top.length) {
      // Keyword fallback (also covers the window before background embedding lands).
      for (const r of this.history.likeSearchArtifacts(sessionKey, query, 3)) {
        top.push({ artifact_id: r.id, content: excerptAround(r.content, query), sim: 0 });
      }
    }
    if (!top.length) return `recall: nothing archived matches "${query}".`;

    const parts = [`recall results for "${query}":`];
    for (const c of top) {
      const row = this.history.getArtifact(c.artifact_id);
      if (!row) continue;
      this.history.bumpArtifactRecall(row.id);
      parts.push(
        `— [artifact ${row.id}${row.tool_name ? ` · ${row.tool_name}` : ''}] ` +
          `${c.content.trim().slice(0, 900)}\n  (recall({"id":"${row.id}"}) for the full text)`
      );
    }
    return parts.join('\n');
  }

  stats(sessionKey) {
    return this.history.artifactStats(sessionKey);
  }
}

/** Extractive summary: collapsed head + tail + size facts. Nothing invented. */
function mechanicalSummary(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const head = collapsed.slice(0, 240);
  const tail = collapsed.length > 420 ? collapsed.slice(-120) : '';
  const lines = (text.match(/\n/g) ?? []).length + 1;
  let s = `"${head}${collapsed.length > 240 ? '…' : ''}"`;
  if (tail) s += ` … "${tail}"`;
  s += ` (${text.length} chars, ${lines} lines)`;
  return s;
}

function chunkText(text, size, maxChunks) {
  const chunks = [];
  // Prefer newline boundaries so chunks stay semantically coherent.
  let i = 0;
  while (i < text.length && chunks.length < maxChunks) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > i + size * 0.5) end = nl;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

function excerptAround(text, term, span = 700) {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return text.slice(0, span);
  const start = Math.max(0, idx - Math.floor(span / 3));
  return text.slice(start, start + span);
}

module.exports = ArtifactStore;
module.exports.mechanicalSummary = mechanicalSummary;
module.exports.chunkText = chunkText;
