'use strict';
/**
 * Copies everything from the local SQLite database into Supabase/Postgres,
 * preserving ids so assignments and scores stay linked.
 *
 *   npm run db:push -- --force        (--force wipes the Postgres tables first)
 *
 * Use it once, after npm run db:setup, to move an event that was already
 * prepared locally (teams, judges, panels, assignments, scores) into the cloud.
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
try { if (fs.existsSync(path.join(root, '.env')) && process.loadEnvFile) process.loadEnvFile(path.join(root, '.env')); } catch (_) { /* ignore */ }

const sqliteDriver = require('../src/drivers/sqlite');
const pgDriver = require('../src/drivers/postgres');

// Parents before children: foreign keys must resolve as we go.
const TABLES = ['faculties', 'panels', 'users', 'teams', 'criteria', 'assignments',
  'scores', 'score_items', 'score_history', 'audit_log', 'settings'];
const IDENTITY_TABLES = TABLES.filter(t => t !== 'settings');

const force = process.argv.includes('--force');
const dbPath = process.env.DB_PATH || path.join(root, 'data', 'judging.db');
const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

if (!url) { console.error('Missing SUPABASE_DB_URL in .env - see npm run db:setup for where to find it.'); process.exit(1); }
if (!fs.existsSync(dbPath)) { console.error(`No SQLite database at ${dbPath}`); process.exit(1); }

(async () => {
  const src = sqliteDriver.create({ dbPath });
  const dst = pgDriver.create({ connectionString: url, max: 4 });

  const hasSchema = await dst.one("SELECT 1 AS ok FROM information_schema.tables WHERE table_schema='public' AND table_name='settings'");
  if (!hasSchema) { console.error('Postgres tables are missing. Run: npm run db:setup'); process.exit(1); }

  const existing = Number((await dst.one('SELECT COUNT(*) AS c FROM teams')).c)
    + Number((await dst.one('SELECT COUNT(*) AS c FROM scores')).c);
  if (existing > 0 && !force) {
    console.error(`Postgres already holds data (${existing} team/score rows). Re-run with --force to replace it.`);
    process.exit(1);
  }

  console.log(`source: sqlite:${dbPath}`);
  console.log(`target: ${dst.describe()}\n`);

  await dst.tx(async t => {
    if (force) {
      await t.exec(`TRUNCATE TABLE ${TABLES.join(', ')}, sessions RESTART IDENTITY CASCADE`);
      console.log('cleared target tables');
    }
    for (const table of TABLES) {
      const rows = await src.all(`SELECT * FROM ${table}`);
      if (!rows.length) { console.log(`  ${table.padEnd(15)} 0`); continue; }
      const cols = Object.keys(rows[0]);
      const placeholders = `(${cols.map(() => '?').join(', ')})`;
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${placeholders}`;
      for (const r of rows) await t.run(sql, cols.map(c => r[c]));
      console.log(`  ${table.padEnd(15)} ${rows.length}`);
    }
    // Identity columns were fed explicit ids; move each sequence past them.
    for (const table of IDENTITY_TABLES) {
      await t.run(
        `SELECT setval(pg_get_serial_sequence('public.${table}', 'id'),
                       COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
    }
    console.log('\nid sequences reset');
  });

  const teams = (await dst.one('SELECT COUNT(*) AS c FROM teams')).c;
  const judges = (await dst.one("SELECT COUNT(*) AS c FROM users WHERE role='judge'")).c;
  const assigns = (await dst.one('SELECT COUNT(*) AS c FROM assignments')).c;
  const scores = (await dst.one('SELECT COUNT(*) AS c FROM scores')).c;
  console.log(`\nIn Supabase now: ${teams} teams, ${judges} judges, ${assigns} assignments, ${scores} scores.`);
  console.log('Set DB_DRIVER=postgres in .env and restart: npm start');

  await src.close();
  await dst.close();
})().catch(e => { console.error(`\nFailed: ${e.message}`); process.exit(1); });
