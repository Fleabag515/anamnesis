/**
 * history.js — SQLite-backed memory store for Anamnesis
 *
 * Three-tier storage inspired by EverMemOS:
 *
 *   turns      — raw conversation turns (episodic trace)
 *   memcells   — atomic facts extracted from turns (semantic atoms)
 *   memscenes  — thematic clusters of memcells (consolidated scenes)
 *
 * Decay scoring enables intelligent forgetting:
 *   score = (recency_weight * age_factor) + (recall_weight * recall_count) + importance
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

class HistoryStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._init();
  }

  _init() {
    this.db.exec(`
      -- Raw conversation turns
      CREATE TABLE IF NOT EXISTS turns (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key   TEXT    NOT NULL,
        role          TEXT    NOT NULL,
        content       TEXT    NOT NULL,
        embedding     BLOB,
        token_est     INTEGER NOT NULL DEFAULT 0,
        recall_count  INTEGER NOT NULL DEFAULT 0,
        importance    REAL    NOT NULL DEFAULT 0.5,
        extracted     INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch())
      );

      -- Atomic facts extracted from turns by LLM
      CREATE TABLE IF NOT EXISTS memcells (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id       INTEGER REFERENCES turns(id) ON DELETE CASCADE,
        session_key   TEXT    NOT NULL,
        content       TEXT    NOT NULL,
        embedding     BLOB,
        recall_count  INTEGER NOT NULL DEFAULT 0,
        decay_score   REAL    NOT NULL DEFAULT 1.0,
        scene_id      INTEGER,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch())
      );

      -- Thematic clusters of memcells
      CREATE TABLE IF NOT EXISTS memscenes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key   TEXT    NOT NULL,
        title         TEXT    NOT NULL,
        summary       TEXT    NOT NULL,
        embedding     BLOB,
        memcell_ids   TEXT    NOT NULL DEFAULT '[]',
        recall_count  INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_turns_session    ON turns(session_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_extracted  ON turns(extracted);
      CREATE INDEX IF NOT EXISTS idx_memcells_session ON memcells(session_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_memcells_scene   ON memcells(scene_id);
      CREATE INDEX IF NOT EXISTS idx_scenes_session   ON memscenes(session_key, updated_at);
    `);
  }

  // ─── Turns ────────────────────────────────────────────────────────────────

  insertTurn(sessionKey, role, content, embedding, tokenEst) {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    const info = this.db.prepare(`
      INSERT INTO turns (session_key, role, content, embedding, token_est)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionKey, role, content, blob, tokenEst);
    return info.lastInsertRowid;
  }

  getSessionTurns(sessionKey) {
    return this.db.prepare(`
      SELECT id, role, content, embedding, token_est, recall_count, importance, created_at
      FROM turns WHERE session_key = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionKey);
  }

  getUnextractedTurns(limit = 20) {
    return this.db.prepare(`
      SELECT id, session_key, role, content FROM turns
      WHERE extracted = 0 AND role = 'assistant'
      ORDER BY created_at ASC LIMIT ?
    `).all(limit);
  }

  markExtracted(turnId) {
    this.db.prepare('UPDATE turns SET extracted = 1 WHERE id = ?').run(turnId);
  }

  bumpTurnRecall(turnId) {
    this.db.prepare('UPDATE turns SET recall_count = recall_count + 1 WHERE id = ?').run(turnId);
  }

  // ─── MemCells ─────────────────────────────────────────────────────────────

  insertMemcell(sessionKey, turnId, content, embedding) {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    const info = this.db.prepare(`
      INSERT INTO memcells (session_key, turn_id, content, embedding)
      VALUES (?, ?, ?, ?)
    `).run(sessionKey, turnId, content, blob);
    return info.lastInsertRowid;
  }

  getUnclusteredMemcells(sessionKey, limit = 100) {
    return this.db.prepare(`
      SELECT id, content, embedding FROM memcells
      WHERE session_key = ? AND scene_id IS NULL
      ORDER BY created_at ASC LIMIT ?
    `).all(sessionKey, limit);
  }

  getAllMemcells(sessionKey) {
    return this.db.prepare(`
      SELECT id, content, embedding, scene_id, decay_score, created_at
      FROM memcells WHERE session_key = ?
      ORDER BY created_at ASC
    `).all(sessionKey);
  }

  assignMemcellToScene(memcellId, sceneId) {
    this.db.prepare('UPDATE memcells SET scene_id = ? WHERE id = ?').run(sceneId, memcellId);
  }

  updateDecayScores(sessionKey) {
    const now = Math.floor(Date.now() / 1000);
    const cells = this.db.prepare(
      'SELECT id, created_at, recall_count FROM memcells WHERE session_key = ?'
    ).all(sessionKey);

    const update = this.db.prepare('UPDATE memcells SET decay_score = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      for (const c of cells) {
        const ageDays  = (now - c.created_at) / 86400;
        const recency  = Math.exp(-ageDays / 30);          // 30-day half-life
        const recall   = Math.log1p(c.recall_count) / 5;   // log-scaled recall boost
        const score    = Math.min(1.0, recency + recall);
        update.run(score, c.id);
      }
    });
    tx();
  }

  pruneDecayedMemcells(sessionKey, threshold = 0.05) {
    const { changes } = this.db.prepare(`
      DELETE FROM memcells WHERE session_key = ? AND decay_score < ? AND recall_count = 0
    `).run(sessionKey, threshold);
    return changes;
  }

  // ─── MemScenes ────────────────────────────────────────────────────────────

  insertScene(sessionKey, title, summary, embedding, memcellIds) {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    const info = this.db.prepare(`
      INSERT INTO memscenes (session_key, title, summary, embedding, memcell_ids)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionKey, title, summary, blob, JSON.stringify(memcellIds));
    return info.lastInsertRowid;
  }

  updateScene(sceneId, title, summary, embedding, memcellIds) {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    this.db.prepare(`
      UPDATE memscenes SET title=?, summary=?, embedding=?, memcell_ids=?, updated_at=unixepoch()
      WHERE id=?
    `).run(title, summary, blob, JSON.stringify(memcellIds), sceneId);
  }

  getScenes(sessionKey) {
    return this.db.prepare(`
      SELECT id, title, summary, embedding, memcell_ids, recall_count, updated_at
      FROM memscenes WHERE session_key = ?
      ORDER BY updated_at DESC
    `).all(sessionKey);
  }

  bumpSceneRecall(sceneId) {
    this.db.prepare('UPDATE memscenes SET recall_count = recall_count + 1 WHERE id = ?').run(sceneId);
  }

  getTurnsByIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT id, role, content, token_est FROM turns WHERE id IN (${placeholders})`
    ).all(...ids);
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  static toFloat32(blob) {
    if (!blob) return null;
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }

  prune(maxAgeDays) {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
    const { changes } = this.db.prepare(
      'DELETE FROM turns WHERE created_at < ?'
    ).run(cutoff);
    return changes;
  }

  stats(sessionKey) {
    const turns   = this.db.prepare('SELECT COUNT(*) as n FROM turns WHERE session_key=?').get(sessionKey).n;
    const cells   = this.db.prepare('SELECT COUNT(*) as n FROM memcells WHERE session_key=?').get(sessionKey).n;
    const scenes  = this.db.prepare('SELECT COUNT(*) as n FROM memscenes WHERE session_key=?').get(sessionKey).n;
    return { turns, cells, scenes };
  }
}

module.exports = HistoryStore;
