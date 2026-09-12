'use strict';
/**
 * Hack Days Solan 2026 - event setup from the Google Form registrations workbook.
 *
 *   npm run import -- "<path to responses .xlsx>" [--force] [--panels 3]
 *
 * What it does:
 *  - sets the event name
 *  - with --force, wipes existing teams/judges/panels/faculties/scores first
 *  - creates the judging panels, each pairing one JUIT faculty member with one
 *    industry expert, from the "Meet the Judges" line-up
 *  - imports every registered team as T01..Tnn with members and project description
 *  - splits teams evenly across panels in registration order and assigns each
 *    team to both judges of its panel, warning if a panel falls outside 20-22
 *  - writes judge credentials to data/judge-credentials.txt
 *
 * Runs against whichever driver DB_DRIVER selects, so it works on SQLite or Supabase.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
try {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile) && process.loadEnvFile) process.loadEnvFile(envFile);
} catch (_) { /* ignore */ }

const db = require('./db');
const { ensureAdmin } = require('./server');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const force = args.includes('--force');
if (!file || !fs.existsSync(file)) {
  console.error('Usage: npm run import -- "<responses.xlsx>" [--force]');
  process.exit(1);
}

const EVENT_NAME = 'Hack Days Solan 2026';
const TARGET_MIN = 20, TARGET_MAX = 22;   // teams per panel
const FACULTIES = [['JUIT Solan', 'JUIT'], ['Industry Experts', 'IND']];
const PANELS = [
  { name: 'Panel A', description: 'JUIT faculty + industry expert', judges: [
    { username: 'pkgupta', name: 'Prof. Dr. Pradeep Kumar Gupta', title: 'Professor & Head CSE, JUIT', faculty: 'JUIT' },
    { username: 'vkholi', name: 'Vijayent Kholi', title: 'Principal Cyber Security Engineer, Ford Motor USA', faculty: 'IND' }] },
  { name: 'Panel B', description: 'JUIT faculty + industry expert', judges: [
    { username: 'asharma', name: 'Dr. Aman Sharma', title: 'Assistant Professor, JUIT', faculty: 'JUIT' },
    { username: 'kanika', name: 'Kanika', title: 'Automation Specialist II, Ubor Hyderabad', faculty: 'IND' }] },
  { name: 'Panel C', description: 'JUIT faculty + industry expert', judges: [
    { username: 'anita', name: 'Dr. Anita', title: 'Assistant Professor, JUIT', faculty: 'JUIT' },
    { username: 'atiwari', name: 'Achyut Tiwari', title: 'Founder & CEO, GeoLiquefy', faculty: 'IND' }] },
];

function genPassword(len = 10) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += a[crypto.randomInt(a.length)];
  return s;
}
const cell = v => (v == null ? '' : String(v.text ?? (v.result !== undefined ? v.result : v)).trim());
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const header = ws.getRow(1).values.map(cell);
  const col = re => header.findIndex(h => re.test(h));
  const C = {
    team: col(/^team name/i), title: col(/^project title/i), desc: col(/^project description/i),
    problem: col(/what problem/i), gemini: col(/how do you plan to use/i), features: col(/what specific features/i),
    m1: col(/member 1 .*full name/i), m1roll: col(/member 1 .*roll/i),
    m2: col(/member 2 .*full name/i), m2roll: col(/member 2 .*roll/i),
  };
  if (C.team < 0) { console.error('Could not find a "Team Name" column. Header:', header); process.exit(1); }

  const rows = [];
  ws.eachRow((r, i) => { if (i === 1) return; const v = r.values.map(cell); if (v[C.team]) rows.push(v); });
  console.log(`Found ${rows.length} registrations in "${ws.name}".`);

  await db.init();
  await ensureAdmin();

  const existingTeams = Number((await db.q.one('SELECT COUNT(*) AS c FROM teams')).c);
  if (existingTeams > 0 && !force) {
    console.error(`Database already has ${existingTeams} team(s). Re-run with --force to replace all judging data.`);
    process.exit(1);
  }

  const creds = [];
  await db.tx(async t => {
    if (force) {
      for (const tbl of ['scores', 'assignments', 'teams', 'panels', 'faculties']) await t.run(`DELETE FROM ${tbl}`);
      await t.run("DELETE FROM users WHERE role = 'judge'");
      await t.run('DELETE FROM sessions');
    }
    await db.setSetting('event_name', EVENT_NAME, t);

    const facId = {};
    for (const [name, code] of FACULTIES) facId[code] = await t.id('INSERT INTO faculties (name, code) VALUES (?, ?)', [name, code]);

    const panelIds = [], judgeIdsByPanel = [];
    for (const p of PANELS) {
      const pid = await t.id('INSERT INTO panels (name, description) VALUES (?, ?)', [p.name, p.description]);
      panelIds.push(pid);
      const ids = [];
      for (const j of p.judges) {
        const pw = genPassword();
        const id = await t.id(
          "INSERT INTO users (username, password_hash, name, role, panel_id, faculty_id) VALUES (?, ?, ?, 'judge', ?, ?)",
          [j.username, bcrypt.hashSync(pw, 10), j.name, pid, facId[j.faculty]]);
        ids.push(id);
        creds.push({ panel: p.name, ...j, password: pw });
      }
      judgeIdsByPanel.push(ids);
    }

    const perPanel = Math.ceil(rows.length / PANELS.length);
    for (const [i, v] of rows.entries()) {
      const code = `T${String(i + 1).padStart(2, '0')}`;
      const members = [[C.m1, C.m1roll], [C.m2, C.m2roll]]
        .map(([n, r]) => (n >= 0 && v[n] ? `${v[n]}${r >= 0 && v[r] ? ` (${v[r]})` : ''}` : null))
        .filter(Boolean).join(', ');
      const description = [
        C.desc >= 0 && v[C.desc] ? v[C.desc] : null,
        C.problem >= 0 && v[C.problem] ? `Problem: ${v[C.problem]}` : null,
        C.gemini >= 0 && v[C.gemini] ? `Gemini API plan: ${clip(v[C.gemini], 1200)}` : null,
        C.features >= 0 && v[C.features] ? `Gemini-powered features: ${clip(v[C.features], 1200)}` : null,
      ].filter(Boolean).join('\n\n');
      const pIdx = Math.min(Math.floor(i / perPanel), PANELS.length - 1);
      const tid = await t.id(
        'INSERT INTO teams (code, name, project_title, members, description, faculty_id, panel_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [code, clip(v[C.team], 120), clip(C.title >= 0 ? v[C.title] : '', 300) || null, members || null,
          clip(description, 4000) || null, facId.JUIT, panelIds[pIdx]]);
      for (const jid of judgeIdsByPanel[pIdx]) {
        await t.run('INSERT INTO assignments (judge_id, team_id) VALUES (?, ?)', [jid, tid]);
      }
    }
    await db.audit({ user: null, action: 'registrations_imported',
      details: { teams: rows.length, judges: creds.length, panels: PANELS.length, file: path.basename(file) } }, t);
  });

  const out = path.join(__dirname, '..', 'data', 'judge-credentials.txt');
  const lines = [`${EVENT_NAME} - judge logins (generated ${new Date().toISOString()})`, 'Login URL: http://<server>:3000/', ''];
  for (const c of creds) {
    lines.push(`${c.panel.padEnd(8)} ${c.name.padEnd(32)} ${c.title.padEnd(52)} username: ${c.username.padEnd(10)} password: ${c.password}`);
  }
  fs.writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
  console.log(`\n${lines.join('\n')}`);

  const counts = await db.q.all(`SELECT p.name, (SELECT COUNT(*) FROM teams t WHERE t.panel_id = p.id) AS c
                                 FROM panels p ORDER BY lower(p.name)`);
  console.log(`\nImported ${rows.length} teams, each assigned to its panel's 2 judges (database: ${db.describe()}).`);
  for (const p of counts) {
    const n = Number(p.c);
    console.log(`  ${p.name}: ${n} teams${n < TARGET_MIN || n > TARGET_MAX ? `   <-- outside the ${TARGET_MIN}-${TARGET_MAX} target, rebalance under Admin > Teams` : ''}`);
  }
  console.log(`\nCredentials saved to ${out} - distribute them, then delete the file.`);
  await db.close();
})().catch(e => { console.error(`\nFailed: ${e.message}`); process.exit(1); });
