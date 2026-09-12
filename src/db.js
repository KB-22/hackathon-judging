'use strict';
/**
 * Database layer.
 *
 * One async query API (`q.one / q.all / q.run / q.id`, `db.tx`) backed by
 * either driver, chosen with DB_DRIVER:
 *   sqlite   (default) - single local file, zero setup, no network
 *   postgres           - Supabase / any PostgreSQL, via SUPABASE_DB_URL
 *
 * All SQL in the app is written in the subset both dialects accept:
 * `?` placeholders, lower(x) instead of COLLATE NOCASE, ON CONFLICT ...
 * DO NOTHING/UPDATE, and RETURNING id for inserts.
 *
 * Raw criterion marks are the only judging data ever stored. Totals are
 * derived by the v_score_totals view and normalization is computed at read
 * time, so the original marks can never be overwritten by a calculation.
 */
const path = require('node:path');

const DEFAULT_CRITERIA = [
  ['Problem Understanding & Relevance', 10, 'Clarity of the problem statement and its real-world relevance.'],
  ['Innovation & Originality', 15, 'Novelty of the idea and creative approach.'],
  ['Gemini API Integration', 15, 'Depth and quality of Gemini API usage in the solution.'],
  ['Technical Implementation', 15, 'Code quality, architecture and engineering soundness.'],
  ['Solution Effectiveness & Accuracy', 10, 'Does the solution actually solve the problem correctly?'],
  ['User Experience & Interface', 10, 'Usability, design and polish of the interface.'],
  ['GitHub Implementations', 10, 'Repository hygiene: commits, README, structure, collaboration.'],
  ['Scalability & Feasibility', 10, 'Potential to scale and practicality of deployment.'],
  ['Presentation & Demonstration', 5, 'Quality of the pitch and live demo.'],
];

const DEFAULT_SETTINGS = {
  event_name: 'Hackathon 2026',
  normalization_method: 'zscore',
  judging_locked: '0',
  allow_edit_after_submit: '1',
  total_marks: '100',
};

const DRIVER = (process.env.DB_DRIVER || 'sqlite').toLowerCase();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'judging.db');
const CONNECTION_STRING = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';

let driver = null;

function now() { return new Date().toISOString(); }

/** Opens the configured driver and makes sure the schema and defaults exist. */
async function init() {
  if (driver) return driver;
  if (DRIVER === 'postgres' || DRIVER === 'pg' || DRIVER === 'supabase') {
    driver = require('./drivers/postgres').create({ connectionString: CONNECTION_STRING });
    await assertPostgresSchema(driver);
  } else if (DRIVER === 'sqlite') {
    driver = require('./drivers/sqlite').create({ dbPath: DB_PATH });
  } else {
    throw new Error(`Unknown DB_DRIVER "${DRIVER}". Use "sqlite" or "postgres".`);
  }
  await seedDefaults(driver);
  return driver;
}

async function assertPostgresSchema(d) {
  let ok = false;
  try {
    ok = !!(await d.one("SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'settings'"));
  } catch (e) {
    const why = await require('./net-diagnose').explain(CONNECTION_STRING, e);
    throw new Error(`Cannot reach the Postgres database.\n\n${why}`);
  }
  if (!ok) {
    throw new Error('Connected to Postgres, but the judging tables are missing.\n' +
      'Create them first: npm run db:setup   (or paste sql/001_schema.sql into the Supabase SQL Editor).');
  }
}

/** Idempotent: seeds the 9 default criteria and the default settings. */
async function seedDefaults(d = driver) {
  const { c } = await d.one('SELECT COUNT(*) AS c FROM criteria');
  if (Number(c) === 0) {
    for (const [i, [name, max, desc]] of DEFAULT_CRITERIA.entries()) {
      await d.run('INSERT INTO criteria (name, max_marks, description, sort_order) VALUES (?, ?, ?, ?)', [name, max, desc, i + 1]);
    }
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await d.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
}

async function getSettings(q = driver) {
  const out = {};
  for (const r of await q.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

async function setSetting(key, value, q = driver) {
  await q.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(value), now()]);
}

async function audit({ user, action, entityType = null, entityId = null, details = null, ip = null }, q = driver) {
  await q.run(
    `INSERT INTO audit_log (user_id, username, role, action, entity_type, entity_id, details, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [user ? user.id : null, user ? user.username : null, user ? user.role : null, action, entityType,
      entityId == null ? null : Number(entityId), details == null ? null : JSON.stringify(details), ip]);
}

/**
 * Maps driver-specific constraint errors onto friendly API messages.
 * Returns null when the error is not a recognised constraint violation.
 */
function describeError(err) {
  const msg = String((err && err.message) || '');
  const code = err && err.code;
  if (code === '23505' || /UNIQUE constraint failed/i.test(msg)) {
    const field = code === '23505'
      ? (err.constraint || '').replace(/^ux_/, '').replace(/_/g, ' ')
      : (msg.split('failed:')[1] || '').trim();
    return { status: 409, error: `Duplicate value: ${field || 'this value'} must be unique` };
  }
  if (code === '23503' || /FOREIGN KEY constraint failed/i.test(msg)) {
    return { status: 409, error: 'Operation blocked: record is referenced by other data' };
  }
  if (code === '23514' || /CHECK constraint failed/i.test(msg)) {
    return { status: 400, error: 'Invalid value' };
  }
  if (code === '42P01' || /no such table/i.test(msg)) {
    return { status: 503, error: 'Database tables are missing - run npm run db:setup' };
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ENETUNREACH'].includes(code)) {
    return { status: 503, error: 'Database unreachable. Check the connection and try again.' };
  }
  return null;
}

module.exports = {
  init,
  seedDefaults,
  get q() {
    if (!driver) throw new Error('Database not initialised - call db.init() first');
    return driver;
  },
  tx: (fn) => module.exports.q.tx(fn),
  getSettings,
  setSetting,
  audit,
  describeError,
  now,
  close: async () => { if (driver) { await driver.close(); driver = null; } },
  describe: () => (driver ? driver.describe() : `${DRIVER} (not connected)`),
  DEFAULT_CRITERIA,
  DRIVER,
  DB_PATH,
};
