'use strict';
/**
 * SQLite driver (Node's built-in node:sqlite - no native build step).
 * Exposes the same async interface as the Postgres driver so the rest of the
 * app is dialect-agnostic. Queries use `?` placeholders in both drivers.
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const TS = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS faculties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  code TEXT UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (${TS}),
  updated_at TEXT NOT NULL DEFAULT (${TS})
);

CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (${TS}),
  updated_at TEXT NOT NULL DEFAULT (${TS})
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','judge')),
  panel_id INTEGER REFERENCES panels(id) ON DELETE SET NULL,
  faculty_id INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (${TS}),
  updated_at TEXT NOT NULL DEFAULT (${TS})
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  project_title TEXT,
  members TEXT,
  description TEXT,
  faculty_id INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
  panel_id INTEGER REFERENCES panels(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (${TS}),
  updated_at TEXT NOT NULL DEFAULT (${TS})
);

CREATE TABLE IF NOT EXISTS criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  max_marks REAL NOT NULL CHECK (max_marks > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (${TS}),
  updated_at TEXT NOT NULL DEFAULT (${TS})
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (${TS}),
  UNIQUE (judge_id, team_id)
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  comments TEXT,
  created_at TEXT NOT NULL DEFAULT (${TS}),
  updated_at TEXT NOT NULL DEFAULT (${TS}),
  submitted_at TEXT,
  UNIQUE (judge_id, team_id)
);

CREATE TABLE IF NOT EXISTS score_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  score_id INTEGER NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  criterion_id INTEGER NOT NULL REFERENCES criteria(id) ON DELETE RESTRICT,
  marks REAL NOT NULL CHECK (marks >= 0),
  UNIQUE (score_id, criterion_id)
);

CREATE TABLE IF NOT EXISTS score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  score_id INTEGER NOT NULL,
  judge_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  items_json TEXT NOT NULL,
  total REAL NOT NULL,
  comments TEXT,
  changed_by INTEGER,
  changed_at TEXT NOT NULL DEFAULT (${TS})
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (${TS})
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (${TS})
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assign_judge ON assignments(judge_id);
CREATE INDEX IF NOT EXISTS idx_assign_team ON assignments(team_id);
CREATE INDEX IF NOT EXISTS idx_scores_team ON scores(team_id);
CREATE INDEX IF NOT EXISTS idx_scores_judge ON scores(judge_id);
CREATE INDEX IF NOT EXISTS idx_items_score ON score_items(score_id);
CREATE INDEX IF NOT EXISTS idx_history_score ON score_history(score_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

CREATE VIEW IF NOT EXISTS v_score_totals AS
  SELECT s.id AS score_id, s.judge_id, s.team_id, s.status, s.comments,
         s.created_at, s.updated_at, s.submitted_at,
         COALESCE(SUM(si.marks), 0) AS total
  FROM scores s LEFT JOIN score_items si ON si.score_id = s.id
  GROUP BY s.id;
`;

/** `INSERT ... ` -> `INSERT ... RETURNING id` unless already present. */
const withReturningId = sql => (/returning\s/i.test(sql) ? sql : `${sql} RETURNING id`);
const plain = row => (row ? { ...row } : row); // strip null-prototype for safe spreading

function create({ dbPath }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // Additive migrations for databases created by earlier versions.
  const teamCols = db.prepare('PRAGMA table_info(teams)').all().map(c => c.name);
  if (!teamCols.includes('description')) db.exec('ALTER TABLE teams ADD COLUMN description TEXT');

  const cache = new Map();
  const prep = sql => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };

  let inTx = false;
  const api = {
    dialect: 'sqlite',
    async one(sql, params = []) { return plain(prep(sql).get(...params)) ?? null; },
    async all(sql, params = []) { return prep(sql).all(...params).map(plain); },
    async run(sql, params = []) { const r = prep(sql).run(...params); return { changes: Number(r.changes) }; },
    async id(sql, params = []) { const r = plain(prep(withReturningId(sql)).get(...params)); return r ? Number(r.id) : null; },
    async exec(sql) { cache.clear(); db.exec(sql); },
  };

  return {
    ...api,
    async tx(fn) {
      if (inTx) return fn(api); // already inside a transaction: join it
      db.exec('BEGIN');
      inTx = true;
      try {
        const r = await fn(api);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      } finally { inTx = false; }
    },
    async close() { try { db.close(); } catch (_) { /* ignore */ } },
    describe: () => `sqlite:${dbPath}`,
  };
}

module.exports = { create };
