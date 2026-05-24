/**
 * history.js — SQLite-backed memory store for Anamnesis
 */

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const CATEGORIES = ['technical','decision','preference','personal','context','other'];

class HistoryStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._init();
  }

  _init() {
    // 1. Create tables
    this.db.exec(`
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
    `);

    // 2. Migrate — add new columns to existing tables if absent
    this._migrate();

    // 3. Create indices (after migration so all columns exist)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_turns_session    ON turns(session_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_extracted  ON turns(extracted);
      CREATE INDEX IF NOT EXISTS idx_memcells_session ON memcells(session_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_memcells_scene   ON memcells(scene_id);
      CREATE INDEX IF NOT EXISTS idx_memcells_cat     ON memcells(category);
      CREATE INDEX IF NOT EXISTS idx_scenes_session   ON memscenes(session_key, updated_at);
    `);
  }

  _migrate() {
    const cols = this.db.prepare("PRAGMA table_info(memcells)").all().map(c => c.name);
    if (!cols.includes('importance'))
      this.db.exec("ALTER TABLE memcells ADD COLUMN importance REAL NOT NULL DEFAULT 0.5");
    if (!cols.includes('category'))
      this.db.exec("ALTER TABLE memcells ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");

    const sceneCols = this.db.prepare("PRAGMA table_info(memscenes)").all().map(c => c.name);
    if (!sceneCols.includes('avg_importance'))
      this.db.exec("ALTER TABLE memscenes ADD COLUMN avg_importance REAL NOT NULL DEFAULT 0.5");
  }

  // ─── Turns ────────────────────────────────────────────────────────────────

  insertTurn(sessionKey, role, content, embedding, tokenEst) {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    return this.db.prepare(`
      INSERT INTO turns (session_key, role, content, embedding, token_est)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionKey, role, content, blob, tokenEst).lastInsertRowid;
  }

  getSessionTurns(sessionKey) {
    return this.db.prepare(`
      SELECT id, role, content, embedding, token_est, recall_count, importance, created_at
      FROM turns WHERE session_key=? ORDER BY created_at ASC, id ASC
    `).all(sessionKey);
  }

  getUnextractedTurns(limit = 20) {
    return this.db.prepare(`
      SELECT id, session_key, role, content FROM turns
      WHERE extracted=0 AND role='assistant'
      ORDER BY created_at ASC LIMIT ?
    `).all(limit);
  }

  markExtracted(id)  { this.db.prepare('UPDATE turns SET extracted=1 WHERE id=?').run(id); }
  bumpTurnRecall(id) { this.db.prepare('UPDATE turns SET recall_count=recall_count+1 WHERE id=?').run(id); }

  // ─── MemCells ─────────────────────────────────────────────────────────────

  insertMemcell(sessionKey, turnId, content, embedding, importance = 0.5, category = 'other') {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    const cat  = CATEGORIES.includes(category) ? category : 'other';
    return this.db.prepare(`
      INSERT INTO memcells (session_key, turn_id, content, embedding, importance, category)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionKey, turnId, content, blob, importance, cat).lastInsertRowid;
  }

  getUnclusteredMemcells(sessionKey, limit = 100) {
    return this.db.prepare(`
      SELECT id, content, embedding, importance FROM memcells
      WHERE session_key=? AND scene_id IS NULL
      ORDER BY created_at ASC LIMIT ?
    `).all(sessionKey, limit);
  }

  getAllMemcells(sessionKey) {
    return this.db.prepare(`
      SELECT id, content, embedding, importance, category, scene_id, decay_score, created_at
      FROM memcells WHERE session_key=? ORDER BY created_at ASC
    `).all(sessionKey);
  }

  assignMemcellToScene(id, sceneId) {
    this.db.prepare('UPDATE memcells SET scene_id=? WHERE id=?').run(sceneId, id);
  }

  updateDecayScores(sessionKey) {
    const now   = Math.floor(Date.now() / 1000);
    const cells = this.db.prepare(
      'SELECT id, created_at, recall_count, importance FROM memcells WHERE session_key=?'
    ).all(sessionKey);
    const update = this.db.prepare('UPDATE memcells SET decay_score=? WHERE id=?');
    this.db.transaction(() => {
      for (const c of cells) {
        const ageDays  = (now - c.created_at) / 86400;
        const halfLife = 30 + (c.importance ?? 0.5) * 60; // 30-90 day half-life by importance
        const recency  = Math.exp(-ageDays / halfLife);
        const recall   = Math.log1p(c.recall_count) / 5;
        update.run(Math.min(1.0, recency + recall), c.id);
      }
    })();
  }

  pruneDecayedMemcells(sessionKey, threshold = 0.05) {
    return this.db.prepare(`
      DELETE FROM memcells
      WHERE session_key=? AND decay_score<? AND recall_count=0
        AND category NOT IN ('decision','preference')
    `).run(sessionKey, threshold).changes;
  }

  // ─── MemScenes ────────────────────────────────────────────────────────────

  insertScene(sessionKey, title, summary, embedding, memcellIds, avgImportance = 0.5) {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    return this.db.prepare(`
      INSERT INTO memscenes (session_key, title, summary, embedding, memcell_ids, avg_importance)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionKey, title, summary, blob, JSON.stringify(memcellIds), avgImportance).lastInsertRowid;
  }

  updateScene(sceneId, title, summary, embedding, memcellIds, avgImportance) {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    this.db.prepare(`
      UPDATE memscenes
      SET title=?, summary=?, embedding=?, memcell_ids=?, avg_importance=?, updated_at=unixepoch()
      WHERE id=?
    `).run(title, summary, blob, JSON.stringify(memcellIds), avgImportance, sceneId);
  }

  getScenes(sessionKey) {
    return this.db.prepare(`
      SELECT id, title, summary, embedding, memcell_ids, avg_importance, recall_count, updated_at
      FROM memscenes WHERE session_key=? ORDER BY updated_at DESC
    `).all(sessionKey);
  }

  bumpSceneRecall(id) { this.db.prepare('UPDATE memscenes SET recall_count=recall_count+1 WHERE id=?').run(id); }

  getTurnsByIds(ids) {
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT id, role, content, token_est FROM turns WHERE id IN (${ph})`).all(...ids);
  }

  static toFloat32(blob) {
    if (!blob) return null;
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }

  prune(maxAgeDays) {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
    return this.db.prepare('DELETE FROM turns WHERE created_at<?').run(cutoff).changes;
  }

  stats(sessionKey) {
    const q = k => this.db.prepare(`SELECT COUNT(*) as n FROM ${k} WHERE session_key=?`).get(sessionKey).n;
    return { turns: q('turns'), cells: q('memcells'), scenes: q('memscenes') };
  }
}

module.exports = HistoryStore;
