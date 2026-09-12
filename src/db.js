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
/** True on Vercel / Lambda / Netlify: read-only disk, containers come and go. */
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
/**
 * True on any public hosting platform, serverless or not. Render, Railway, Fly
 * and Heroku run a long-lived process, so SQLite can work there - but only with
 * a persistent disk attached. Without one the container filesystem is wiped on
 * every deploy, restart and idle spin-down, which would silently destroy a
 * judging session. Either way the app is publicly reachable, so it must not
 * come up with default credentials.
 */
const IS_HOSTED = IS_SERVERLESS || !!(
  process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME ||
  process.env.DYNO || process.env.KOYEB_APP_NAME || process.env.NODE_ENV === 'production');
const IS_POSTGRES = ['postgres', 'pg', 'supabase'].includes(DRIVER);
/** Escape hatch for a host with a real persistent disk mounted at DB_PATH. */
const ALLOW_EPHEMERAL_SQLITE = process.env.ALLOW_EPHEMERAL_SQLITE === '1';

let driver = null;
let bootstrapInfo = null;

function now() { return new Date().toISOString(); }

/** Opens the configured driver and makes sure the schema and defaults exist. */
async function init() {
  if (driver) return driver;
  if (!IS_POSTGRES && DRIVER !== 'sqlite') {
    throw new Error(`Unknown DB_DRIVER "${DRIVER}". Use "sqlite" or "postgres".`);
  }
  if (!IS_POSTGRES && IS_SERVERLESS) {
    throw new Error(
      'DB_DRIVER=sqlite cannot run on a serverless host. The filesystem is read-only and each\n' +
      'invocation may get a fresh container, so every score would be lost immediately.\n' +
      'Set DB_DRIVER=postgres and SUPABASE_DB_URL in the project environment variables.');
  }
  if (!IS_POSTGRES && IS_HOSTED && !ALLOW_EPHEMERAL_SQLITE) {
    throw new Error(
      'Refusing to start: this looks like a hosted deployment but DB_DRIVER is sqlite.\n' +
      'Container filesystems are wiped on every deploy, restart and idle spin-down, so the\n' +
      'database would start empty each time and judging scores would be lost without warning.\n\n' +
      'Set DB_DRIVER=postgres and SUPABASE_DB_URL in the service environment variables.\n' +
      'If you genuinely have a persistent disk mounted at DB_PATH, set ALLOW_EPHEMERAL_SQLITE=1.');
  }
  driver = IS_POSTGRES
    ? require('./drivers/postgres').create({ connectionString: CONNECTION_STRING })
    : require('./drivers/sqlite').create({ dbPath: DB_PATH });
  bootstrapInfo = await bootstrap(driver);
  // Open the pool up front on a long-running server: a query costs
  // milliseconds but a new connection to a distant region costs seconds, so
  // paying it once at startup keeps every page load fast.
  if (driver.warm) {
    const t = Date.now();
    const opened = await driver.warm();
    if (opened) console.log(`[db] pre-opened ${opened} connections in ${Date.now() - t} ms`);
  }
  return driver;
}

/**
 * Single round trip that both proves the schema is present and reports what
 * still needs seeding. Kept to one query because it runs on every serverless
 * cold start.
 */
async function bootstrap(d) {
  let counts;
  try {
    counts = await d.one(`SELECT
      (SELECT COUNT(*) FROM criteria) AS criteria,
      (SELECT COUNT(*) FROM settings) AS settings,
      (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins`);
  } catch (e) {
    if (!IS_POSTGRES) throw e;
    const text = `${e.message || ''} ${e.code || ''}`;
    if (/does not exist|42P01|no such table/i.test(text)) {
      throw new Error(
        'Connected to Postgres, but the judging tables are missing.\n' +
        'Create them with `npm run db:setup`, or paste sql/001_schema.sql into the Supabase SQL Editor.');
    }
    const why = await require('./net-diagnose').explain(CONNECTION_STRING, e);
    throw new Error(`Cannot reach the Postgres database.\n\n${why}`);
  }

  if (Number(counts.criteria) === 0) {
    for (const [i, [name, max, desc]] of DEFAULT_CRITERIA.entries()) {
      await d.run('INSERT INTO criteria (name, max_marks, description, sort_order) VALUES (?, ?, ?, ?)', [name, max, desc, i + 1]);
    }
  }
  if (Number(counts.settings) < Object.keys(DEFAULT_SETTINGS).length) {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      await d.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [k, v]);
    }
  }
  return { admins: Number(counts.admins) };
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
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET'].includes(code)) {
    return { status: 503, error: 'Database unreachable. Please try again in a moment.' };
  }
  return null;
}

module.exports = {
  init,
  bootstrap,
  get q() {
    if (!driver) throw new Error('Database not initialised - call db.init() first');
    return driver;
  },
  get bootstrapInfo() { return bootstrapInfo; },
  tx: (fn) => module.exports.q.tx(fn),
  getSettings,
  setSetting,
  audit,
  describeError,
  now,
  close: async () => { if (driver) { await driver.close(); driver = null; bootstrapInfo = null; } },
  describe: () => (driver ? driver.describe() : `${DRIVER} (not connected)`),
  DEFAULT_CRITERIA,
  DEFAULT_SETTINGS,
  DRIVER,
  DB_PATH,
  IS_SERVERLESS,
  IS_HOSTED,
  IS_POSTGRES,
};
