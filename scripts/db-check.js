'use strict';
/**
 * Connectivity + contents check for whichever driver is configured.
 *   npm run db:check                 (uses DB_DRIVER from .env)
 *   DB_DRIVER=postgres npm run db:check
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
try { if (fs.existsSync(path.join(root, '.env')) && process.loadEnvFile) process.loadEnvFile(path.join(root, '.env')); } catch (_) { /* ignore */ }

const db = require('../src/db');

(async () => {
  const t0 = Date.now();
  await db.init();
  console.log(`driver   : ${db.DRIVER}`);
  console.log(`database : ${db.describe()}`);
  console.log(`connected in ${Date.now() - t0} ms\n`);

  const tables = ['faculties', 'panels', 'users', 'teams', 'criteria', 'assignments', 'scores', 'score_items', 'score_history', 'audit_log', 'settings', 'sessions'];
  for (const t of tables) {
    const { c } = await db.q.one(`SELECT COUNT(*) AS c FROM ${t}`);
    console.log(`  ${t.padEnd(15)} ${String(c).padStart(6)}`);
  }
  const s = await db.getSettings();
  console.log(`\nevent    : ${s.event_name}`);
  console.log(`method   : ${s.normalization_method}`);
  console.log(`locked   : ${s.judging_locked === '1' ? 'yes' : 'no'}`);

  const panels = await db.q.all(`SELECT p.name,
    (SELECT COUNT(*) FROM teams t WHERE t.panel_id = p.id) AS teams,
    (SELECT COUNT(*) FROM users u WHERE u.panel_id = p.id AND u.role = 'judge') AS judges
    FROM panels p ORDER BY lower(p.name)`);
  if (panels.length) {
    console.log('\npanels:');
    for (const p of panels) console.log(`  ${p.name.padEnd(10)} ${p.teams} teams, ${p.judges} judges${p.teams < 20 || p.teams > 22 ? '   <-- outside the 20-22 target' : ''}`);
  }
  await db.close();
})().catch(e => { console.error(`\nFailed: ${e.message}`); process.exit(1); });
