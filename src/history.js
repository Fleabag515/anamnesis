/**
 * history.js — SQLite-backed memory store for Anamnesis.
 *
 * Schema overview:
 *   turns       — every prompt/response, raw text + embedding + token estimate.
 *                 `extracted` flags memcell-extraction status; `foresight_scanned`
 *                 flags future-intention scan status. These are *independent*
 *                 because the two extractors run in parallel and shouldn't
 *                 starve each other.
 *   memcells    — atomic facts derived from assistant turns. `embedding_model`
 *                 records which model produced the vector so we never compare
 *                 vectors from different model families.
 *   memscenes   — thematic clusters of memcells (turn → cell → scene).
 *   foresights  — extracted intentions / future plans.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const CATEGORIES = ['technical', 'decision', 'preference', 'personal', 'context', 'other'];
const TIMEFRAMES = ['soon', 'days', 'weeks', 'months', 'ongoing'];

class HistoryStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._init();
  }

  _init() {
    // 1. Base tables — no columns added here that aren't safe for old DBs;
    //    new columns are introduced via _migrate() so existing DBs upgrade.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key       TEXT    NOT NULL,
        role              TEXT    NOT NULL,
        content           TEXT    NOT NULL,
        embedding         BLOB,
        token_est         INTEGER NOT NULL DEFAULT 0,
        recall_count      INTEGER NOT NULL DEFAULT 0,
        importance        REAL    NOT NULL DEFAULT 0.5,
        extracted         INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL DEFAULT (unixepoch())
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

      CREATE TABLE IF NOT EXISTS foresights (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id       INTEGER REFERENCES turns(id) ON DELETE CASCADE,
        session_key   TEXT    NOT NULL,
        intention     TEXT    NOT NULL,
        target        TEXT    NOT NULL DEFAULT '',
        timeframe     TEXT    NOT NULL DEFAULT 'soon',
        confidence    REAL    NOT NULL DEFAULT 0.7,
        fulfilled     INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

    this._migrate();

    // Indices last, so all migrated columns are guaranteed to exist.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_turns_session       ON turns(session_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_extracted     ON turns(extracted);
      CREATE INDEX IF NOT EXISTS idx_turns_foresight     ON turns(foresight_scanned);
      CREATE INDEX IF NOT EXISTS idx_memcells_session    ON memcells(session_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_memcells_scene      ON memcells(scene_id);
      CREATE INDEX IF NOT EXISTS idx_memcells_cat        ON memcells(category);
      CREATE INDEX IF NOT EXISTS idx_memcells_turn       ON memcells(turn_id);
      CREATE INDEX IF NOT EXISTS idx_scenes_session      ON memscenes(session_key, updated_at);
      CREATE INDEX IF NOT EXISTS idx_foresights_session  ON foresights(session_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_foresights_active   ON foresights(session_key, fulfilled);
    `);
  }

  _migrate() {
    const has = (table, col) =>
      this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === col);

    // turns.foresight_scanned — replaces the previous abuse of turns.extracted
    // by the foresight extractor (which never set it, leading to a silent race).
    if (!has('turns', 'foresight_scanned')) {
      this.db.exec('ALTER TABLE turns ADD COLUMN foresight_scanned INTEGER NOT NULL DEFAULT 0');
      // For any existing turn that already has memcells, assume foresight has
      // also been processed — otherwise we'd re-scan the entire history.
      this.db.exec(`
        UPDATE turns SET foresight_scanned = 1
        WHERE extracted = 1
      `);
    }

    // memcells.importance / category — added in 0.2.0
    if (!has('memcells', 'importance'))
      this.db.exec('ALTER TABLE memcells ADD COLUMN importance REAL NOT NULL DEFAULT 0.5');
    if (!has('memcells', 'category'))
      this.db.exec("ALTER TABLE memcells ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");

    // memscenes.avg_importance — added in 0.2.0
    if (!has('memscenes', 'avg_importance'))
      this.db.exec('ALTER TABLE memscenes ADD COLUMN avg_importance REAL NOT NULL DEFAULT 0.5');

    // embedding_model — track which model produced each vector so we never
    // do cosine across incompatible vector spaces. Old NULL rows are treated
    // as legacy and skipped from similarity if cur. model differs.
    if (!has('turns', 'embedding_model'))
      this.db.exec('ALTER TABLE turns ADD COLUMN embedding_model TEXT');
    if (!has('memcells', 'embedding_model'))
      this.db.exec('ALTER TABLE memcells ADD COLUMN embedding_model TEXT');
    if (!has('memscenes', 'embedding_model'))
      this.db.exec('ALTER TABLE memscenes ADD COLUMN embedding_model TEXT');
  }

  // ─── Turns ────────────────────────────────────────────────────────────────

  insertTurn(sessionKey, role, content, embedding, tokenEst, embeddingModel = null) {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    return this.db
      .prepare(
        `
      INSERT INTO turns (session_key, role, content, embedding, token_est, embedding_model)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(sessionKey, role, content, blob, tokenEst, embeddingModel).lastInsertRowid;
  }

  getSessionTurns(sessionKey) {
    return this.db
      .prepare(
        `
      SELECT id, role, content, embedding, embedding_model, token_est, recall_count, importance, created_at
      FROM turns WHERE session_key=? ORDER BY created_at ASC, id ASC
    `
      )
      .all(sessionKey);
  }

  getUnextractedAssistantTurns(limit = 20) {
    return this.db
      .prepare(
        `
      SELECT id, session_key, role, content FROM turns
      WHERE extracted=0 AND role='assistant'
      ORDER BY created_at ASC LIMIT ?
    `
      )
      .all(limit);
  }

  getUnscannedAssistantTurns(limit = 20) {
    return this.db
      .prepare(
        `
      SELECT id, session_key, role, content FROM turns
      WHERE foresight_scanned=0 AND role='assistant'
      ORDER BY created_at ASC LIMIT ?
    `
      )
      .all(limit);
  }

  markExtracted(id) {
    this.db.prepare('UPDATE turns SET extracted=1 WHERE id=?').run(id);
  }
  markForesightScanned(id) {
    this.db.prepare('UPDATE turns SET foresight_scanned=1 WHERE id=?').run(id);
  }
  bumpTurnRecall(id) {
    this.db.prepare('UPDATE turns SET recall_count=recall_count+1 WHERE id=?').run(id);
  }

  // ─── MemCells ─────────────────────────────────────────────────────────────

  insertMemcell(
    sessionKey,
    turnId,
    content,
    embedding,
    importance = 0.5,
    category = 'other',
    embeddingModel = null
  ) {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    const cat = CATEGORIES.includes(category) ? category : 'other';
    return this.db
      .prepare(
        `
      INSERT INTO memcells (session_key, turn_id, content, embedding, importance, category, embedding_model)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(sessionKey, turnId, content, blob, importance, cat, embeddingModel).lastInsertRowid;
  }

  getUnclusteredMemcells(sessionKey, limit = 100) {
    return this.db
      .prepare(
        `
      SELECT id, content, embedding, embedding_model, importance FROM memcells
      WHERE session_key=? AND scene_id IS NULL
      ORDER BY created_at ASC LIMIT ?
    `
      )
      .all(sessionKey, limit);
  }

  getAllMemcells(sessionKey) {
    return this.db
      .prepare(
        `
      SELECT id, content, embedding, embedding_model, importance, category, scene_id, decay_score, created_at
      FROM memcells WHERE session_key=? ORDER BY created_at ASC
    `
      )
      .all(sessionKey);
  }

  assignMemcellToScene(id, sceneId) {
    this.db.prepare('UPDATE memcells SET scene_id=? WHERE id=?').run(sceneId, id);
  }

  /**
   * Look up the turn IDs that produced a set of memcells. Used by the
   * selector to expand a relevant scene back to the underlying conversation.
   * Replaces an earlier `selector.history.db.prepare(...)` reach into internals.
   */
  getTurnIdsForMemcells(memcellIds) {
    if (!memcellIds.length) return [];
    const ph = memcellIds.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT DISTINCT turn_id FROM memcells WHERE id IN (${ph}) AND turn_id IS NOT NULL`)
      .all(...memcellIds)
      .map((r) => r.turn_id);
  }

  updateDecayScores(sessionKey) {
    const now = Math.floor(Date.now() / 1000);
    const cells = this.db
      .prepare('SELECT id, created_at, recall_count, importance FROM memcells WHERE session_key=?')
      .all(sessionKey);
    const update = this.db.prepare('UPDATE memcells SET decay_score=? WHERE id=?');
    this.db.transaction(() => {
      for (const c of cells) {
        const ageDays = (now - c.created_at) / 86400;
        const halfLife = 30 + (c.importance ?? 0.5) * 60;
        const recency = Math.exp(-ageDays / halfLife);
        const recall = Math.log1p(c.recall_count) / 5;
        update.run(Math.min(1.0, recency + recall), c.id);
      }
    })();
  }

  pruneDecayedMemcells(sessionKey, threshold = 0.05) {
    return this.db
      .prepare(
        `
      DELETE FROM memcells
      WHERE session_key=? AND decay_score<? AND recall_count=0
        AND category NOT IN ('decision','preference')
    `
      )
      .run(sessionKey, threshold).changes;
  }

  // ─── MemScenes ────────────────────────────────────────────────────────────

  insertScene(
    sessionKey,
    title,
    summary,
    embedding,
    memcellIds,
    avgImportance = 0.5,
    embeddingModel = null
  ) {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    return this.db
      .prepare(
        `
      INSERT INTO memscenes (session_key, title, summary, embedding, memcell_ids, avg_importance, embedding_model)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        sessionKey,
        title,
        summary,
        blob,
        JSON.stringify(memcellIds),
        avgImportance,
        embeddingModel
      ).lastInsertRowid;
  }

  updateScene(
    sceneId,
    title,
    summary,
    embedding,
    memcellIds,
    avgImportance,
    embeddingModel = null
  ) {
    const blob = embedding ? Buffer.from(embedding.buffer) : null;
    this.db
      .prepare(
        `
      UPDATE memscenes
      SET title=?, summary=?, embedding=?, memcell_ids=?, avg_importance=?, embedding_model=?, updated_at=unixepoch()
      WHERE id=?
    `
      )
      .run(
        title,
        summary,
        blob,
        JSON.stringify(memcellIds),
        avgImportance,
        embeddingModel,
        sceneId
      );
  }

  getScenes(sessionKey) {
    return this.db
      .prepare(
        `
      SELECT id, title, summary, embedding, embedding_model, memcell_ids, avg_importance, recall_count, updated_at
      FROM memscenes WHERE session_key=? ORDER BY updated_at DESC
    `
      )
      .all(sessionKey);
  }

  bumpSceneRecall(id) {
    this.db.prepare('UPDATE memscenes SET recall_count=recall_count+1 WHERE id=?').run(id);
  }

  getTurnsByIds(ids) {
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT id, role, content, token_est FROM turns WHERE id IN (${ph})`)
      .all(...ids);
  }

  // ─── Foresights ───────────────────────────────────────────────────────────

  insertForesight(sessionKey, turnId, intention, target, timeframe, confidence) {
    const tf = TIMEFRAMES.includes(timeframe) ? timeframe : 'soon';
    return this.db
      .prepare(
        `
      INSERT INTO foresights (session_key, turn_id, intention, target, timeframe, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(sessionKey, turnId, intention, target || '', tf, confidence).lastInsertRowid;
  }

  getActiveForesights(sessionKey, limit = 10) {
    return this.db
      .prepare(
        `
      SELECT id, intention, target, timeframe, confidence, created_at
      FROM foresights
      WHERE session_key=? AND fulfilled=0
      ORDER BY created_at DESC LIMIT ?
    `
      )
      .all(sessionKey, limit);
  }

  markForesightFulfilled(id) {
    this.db.prepare('UPDATE foresights SET fulfilled=1 WHERE id=?').run(id);
  }

  // ─── Shared ───────────────────────────────────────────────────────────────

  /**
   * Decode a stored embedding BLOB into a Float32Array.
   *
   * Important: SQLite returns the BLOB as a Node Buffer, which is itself a
   * Uint8Array view into a (possibly shared) ArrayBuffer. Reading the raw
   * `.buffer` of that view exposes neighbouring bytes when the underlying
   * buffer is pooled — we copy via Float32Array.from(...) of a fresh view
   * sized exactly to the stored bytes so callers get an isolated, safely
   * owned vector.
   */
  static toFloat32(blob) {
    if (!blob) return null;
    if (blob.byteLength % 4 !== 0) return null;
    // Slice gives us an independent ArrayBuffer; safe to wrap as Float32.
    const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
    return new Float32Array(ab);
  }

  prune(maxAgeDays) {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
    return this.db.prepare('DELETE FROM turns WHERE created_at<?').run(cutoff).changes;
  }

  stats(sessionKey) {
    const q = (k) =>
      this.db.prepare(`SELECT COUNT(*) as n FROM ${k} WHERE session_key=?`).get(sessionKey).n;
    return {
      turns: q('turns'),
      cells: q('memcells'),
      scenes: q('memscenes'),
      foresights: this.db
        .prepare('SELECT COUNT(*) as n FROM foresights WHERE session_key=? AND fulfilled=0')
        .get(sessionKey).n,
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = HistoryStore;
