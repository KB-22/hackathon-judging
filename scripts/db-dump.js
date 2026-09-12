'use strict';
/**
 * Dumps the local SQLite event as a PostgreSQL script you can paste straight
 * into the Supabase SQL Editor. Use this when the network blocks port 5432 and
 * `npm run db:push` therefore cannot connect - the SQL Editor works over HTTPS.
 *
 *   npm run db:dump                 -> writes sql/002_data.sql
 *   npm run db:dump -- out.sql      -> writes somewhere else
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
try { if (fs.existsSync(path.join(root, '.env')) && process.loadEnvFile) process.loadEnvFile(path.join(root, '.env')); } catch (_) { /* ignore */ }

const sqlite = require('../src/drivers/sqlite');

// Parents before children so foreign keys resolve as the script runs.
const TABLES = ['faculties', 'panels', 'users', 'teams', 'criteria', 'assignments',
  'scores', 'score_items', 'score_history', 'audit_log', 'settings'];
const IDENTITY_TABLES = TABLES.filter(t => t !== 'settings');
const BATCH = 40;

const dbPath = process.env.DB_PATH || path.join(root, 'data', 'judging.db');
const outFile = process.argv[2] || path.join(root, 'sql', '002_data.sql');

/** Postgres literal. Strings use standard single quotes with '' escaping. */
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

(async () => {
  if (!fs.existsSync(dbPath)) { console.error(`No SQLite database at ${dbPath}`); process.exit(1); }
  const src = sqlite.create({ dbPath });

  const out = [];
  out.push('-- ===========================================================================');
  out.push('--  Hack Days judging data, exported from the local SQLite database.');
  out.push(`--  Generated ${new Date().toISOString()}`);
  out.push('--');
  out.push('--  HOW TO USE (no open database port required):');
  out.push('--    1. Supabase Dashboard -> SQL Editor -> run sql/001_schema.sql first');
  out.push('--    2. Then paste THIS file and run it');
  out.push('--');
  out.push('--  Replaces any existing judging data. Password hashes are bcrypt, so the');
  out.push('--  judge logins already handed out keep working.');
  out.push('-- ===========================================================================');
  out.push('');
  out.push('BEGIN;');
  out.push('');
  out.push(`TRUNCATE TABLE ${TABLES.join(', ')}, sessions RESTART IDENTITY CASCADE;`);
  out.push('');

  let grandTotal = 0;
  for (const table of TABLES) {
    const rows = await src.all(`SELECT * FROM ${table}`);
    out.push(`-- ${table}: ${rows.length} row(s)`);
    if (!rows.length) { out.push(''); continue; }
    const cols = Object.keys(rows[0]);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      out.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES`);
      out.push(chunk.map(r => `  (${cols.map(c => lit(r[c])).join(', ')})`).join(',\n') + ';');
    }
    out.push('');
    grandTotal += rows.length;
    console.log(`  ${table.padEnd(15)} ${rows.length}`);
  }

  out.push('-- Move identity sequences past the explicit ids inserted above.');
  for (const table of IDENTITY_TABLES) {
    out.push(`SELECT setval(pg_get_serial_sequence('public.${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false);`);
  }
  out.push('');
  out.push('COMMIT;');
  out.push('');
  out.push('-- Verify:');
  out.push("SELECT 'teams' AS table, COUNT(*) FROM teams");
  out.push("UNION ALL SELECT 'judges', COUNT(*) FROM users WHERE role = 'judge'");
  out.push("UNION ALL SELECT 'panels', COUNT(*) FROM panels");
  out.push("UNION ALL SELECT 'assignments', COUNT(*) FROM assignments");
  out.push("UNION ALL SELECT 'scores', COUNT(*) FROM scores;");
  out.push('');

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, out.join('\n'), 'utf8');
  const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`\n${grandTotal} rows -> ${path.relative(root, outFile)} (${kb} KB)`);
  console.log('Paste it into the Supabase SQL Editor after sql/001_schema.sql.');
  await src.close();
})().catch(e => { console.error(`\nFailed: ${e.message}`); process.exit(1); });
