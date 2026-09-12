'use strict';
/**
 * Applies sql/001_schema.sql (or any file passed as an argument) to the
 * Supabase/Postgres database in SUPABASE_DB_URL.
 *
 *   npm run db:setup
 *   npm run db:setup -- sql/900_reset_scores.sql
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const root = path.join(__dirname, '..');
try { if (fs.existsSync(path.join(root, '.env')) && process.loadEnvFile) process.loadEnvFile(path.join(root, '.env')); } catch (_) { /* ignore */ }

const file = process.argv[2] || path.join(root, 'sql', '001_schema.sql');
const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

if (!url) {
  console.error(`
Missing SUPABASE_DB_URL.

  1. Supabase Dashboard -> Project Settings -> Database -> Connection string
  2. Choose "Session pooler" and copy the URI
  3. Replace [YOUR-PASSWORD] with your database password
  4. Put it in .env as:  SUPABASE_DB_URL=postgresql://...

Alternative with no credentials needed: open the Supabase SQL Editor and paste
the contents of sql/001_schema.sql.
`);
  process.exit(1);
}
if (!fs.existsSync(file)) { console.error(`SQL file not found: ${file}`); process.exit(1); }

(async () => {
  const client = new Client({
    connectionString: url,
    ssl: process.env.PGSSL_STRICT === '1' ? true : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  const shown = url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:****@');
  console.log(`Connecting to ${shown}`);
  await client.connect();
  const sql = fs.readFileSync(file, 'utf8');
  console.log(`Applying ${path.relative(root, file)} (${sql.length} bytes)...`);
  const result = await client.query(sql);
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  if (last && last.rows && last.rows.length) {
    console.log('\nTables in schema "public":');
    for (const r of last.rows) console.log('  -', Object.values(r).join(' '));
  }
  await client.end();
  console.log('\nDone. Now point the app at Postgres by setting DB_DRIVER=postgres in .env, then: npm start');
})().catch(async e => {
  console.error(`\nFailed: ${e.message}\n`);
  console.error(await require('../src/net-diagnose').explain(url, e));
  process.exit(1);
});
