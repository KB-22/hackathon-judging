'use strict';
/**
 * PostgreSQL / Supabase driver.
 *
 * The app writes dialect-neutral SQL with `?` placeholders; this driver
 * rewrites them to $1..$n and normalises result shapes so callers cannot tell
 * which database they are on.
 *
 * Connect with the direct Postgres connection string (Supabase Dashboard ->
 * Project Settings -> Database -> Connection string). That connection is the
 * table owner and therefore bypasses Row Level Security, which is exactly what
 * a trusted backend needs - the public anon key is locked out of these tables.
 */
const { Pool, types } = require('pg');

// bigint (count(*), sessions.expires_at) and numeric arrive as strings by
// default; the app expects numbers.
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));    // int8
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));   // numeric

/**
 * Rewrite `?` placeholders to $1..$n, skipping anything inside single-quoted
 * strings, double-quoted identifiers, dollar-quoted blocks and comments.
 */
function toPgPlaceholders(sql) {
  let out = '', n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {                       // string / identifier
      const quote = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; } // escaped quote
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1); i = j; continue;
    }
    if (c === '-' && sql[i + 1] === '-') {              // line comment
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? sql.length : j;
      out += sql.slice(i, end); i = end - 1; continue;
    }
    if (c === '/' && sql[i + 1] === '*') {              // block comment
      const j = sql.indexOf('*/', i);
      const end = j === -1 ? sql.length : j + 2;
      out += sql.slice(i, end); i = end - 1; continue;
    }
    if (c === '?') { out += `$${++n}`; continue; }
    out += c;
  }
  return out;
}

const withReturningId = sql => (/returning\s/i.test(sql) ? sql : `${sql} RETURNING id`);

function sslFor(connectionString) {
  if (process.env.PGSSL_DISABLE === '1') return false;
  // Supabase terminates TLS at the pooler with a certificate chain Node does
  // not ship a root for. Verification can be turned on with PGSSL_STRICT=1
  // once you have downloaded the project CA certificate.
  if (process.env.PGSSL_STRICT === '1') return true;
  return /supabase|amazonaws|render|neon|railway/i.test(connectionString || '') ? { rejectUnauthorized: false } : false;
}

/**
 * Builds the shared query API over any `(text, values) => {rows, rowCount}`
 * runner. Exported so tests can drive it with an in-process Postgres.
 */
function buildApi(runner) {
  return {
    dialect: 'postgres',
    async one(sql, params = []) { const r = await runner(toPgPlaceholders(sql), params); return r.rows[0] ?? null; },
    async all(sql, params = []) { const r = await runner(toPgPlaceholders(sql), params); return r.rows; },
    async run(sql, params = []) { const r = await runner(toPgPlaceholders(sql), params); return { changes: r.rowCount ?? 0 }; },
    async id(sql, params = []) {
      const r = await runner(toPgPlaceholders(withReturningId(sql)), params);
      return r.rows[0] ? Number(r.rows[0].id) : null;
    },
    async exec(sql) { await runner(sql, []); },
  };
}

/**
 * Serverless hosts scale by running many short-lived instances, so each one
 * must hold as few database connections as possible or the pooler runs out.
 * One connection per instance is the standard pattern; override with PG_POOL_MAX.
 */
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
const DEFAULT_MAX = Number(process.env.PG_POOL_MAX) || (IS_SERVERLESS ? 1 : 10);

function create({ connectionString, max = DEFAULT_MAX }) {
  if (!connectionString) throw new Error('SUPABASE_DB_URL (or DATABASE_URL) is required when DB_DRIVER=postgres');
  const pool = new Pool({
    connectionString,
    max,
    ssl: sslFor(connectionString),
    connectionTimeoutMillis: IS_SERVERLESS ? 10000 : 15000,
    idleTimeoutMillis: IS_SERVERLESS ? 10000 : 30000,
    // Supabase's transaction pooler (port 6543) does not support named prepared
    // statements; node-postgres only uses unnamed ones, so both poolers work.
    application_name: 'hackathon-judging',
  });
  pool.on('error', err => console.error('[db] idle client error:', err.message));

  const scoped = buildApi;
  const poolRunner = (text, values) => pool.query(text, values);

  return {
    ...scoped(poolRunner),
    async tx(fn) {
      const client = await pool.connect();
      const clientRunner = (text, values) => client.query(text, values);
      try {
        await client.query('BEGIN');
        const r = await fn(scoped(clientRunner));
        await client.query('COMMIT');
        return r;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      } finally { client.release(); }
    },
    async close() { await pool.end(); },
    describe: () => {
      try {
        const u = new URL(connectionString);
        return `postgres:${u.host}${u.pathname}`;
      } catch (_) { return 'postgres'; }
    },
  };
}

module.exports = { create, toPgPlaceholders, buildApi };
