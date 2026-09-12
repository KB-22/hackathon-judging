'use strict';
/**
 * Seed script.
 *   npm run seed                  ensure the admin account exists
 *   npm run seed:demo             also load a demo dataset (6 judges, 12 teams, ~75% scored)
 *   node src/seed.js --demo --force   wipe existing judging data first
 *
 * Works against whichever driver DB_DRIVER selects.
 */
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
try {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile) && process.loadEnvFile) process.loadEnvFile(envFile);
} catch (_) { /* ignore */ }

const db = require('./db');
const { ensureAdmin } = require('./server');

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const force = args.includes('--force');

const JUDGE_PASSWORD = 'Judge@123';
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const half = x => Math.round(x * 2) / 2;

(async () => {
  await db.init();
  await ensureAdmin();

  if (!demo) {
    console.log(`Admin account ensured on ${db.describe()}. Use --demo to load sample data.`);
    await db.close();
    return;
  }

  const teamCount = Number((await db.q.one('SELECT COUNT(*) AS c FROM teams')).c);
  if (teamCount > 0 && !force) {
    console.error(`Database already has ${teamCount} team(s). Re-run with --force to wipe judging data and reseed.`);
    process.exit(1);
  }

  let summary;
  await db.tx(async t => {
    if (force) {
      for (const tbl of ['scores', 'assignments', 'teams', 'panels', 'faculties']) await t.run(`DELETE FROM ${tbl}`);
      await t.run("DELETE FROM users WHERE role = 'judge'");
    }

    const facs = [];
    for (const [name, code] of [['Faculty of Engineering & Technology', 'FET'], ['Faculty of Computer Applications', 'FCA'], ['Faculty of Management Studies', 'FMS']]) {
      facs.push(await t.id('INSERT INTO faculties (name, code) VALUES (?, ?)', [name, code]));
    }
    const panels = [];
    for (const [name, desc] of [['Panel A', 'Ground floor lab - Teams T01 to T06'], ['Panel B', 'Seminar hall - Teams T07 to T12']]) {
      panels.push(await t.id('INSERT INTO panels (name, description) VALUES (?, ?)', [name, desc]));
    }

    const judgeNames = ['Dr. Anita Sharma', 'Prof. Rohan Mehta', 'Ms. Priya Nair', 'Dr. Vikram Singh', 'Mr. Arjun Iyer', 'Dr. Kavya Reddy'];
    const hash = bcrypt.hashSync(JUDGE_PASSWORD, 10);
    const judges = [];
    for (const [i, name] of judgeNames.entries()) {
      judges.push(await t.id(
        "INSERT INTO users (username, password_hash, name, email, role, panel_id, faculty_id) VALUES (?, ?, ?, ?, 'judge', ?, ?)",
        [`judge${i + 1}`, hash, name, `judge${i + 1}@example.edu`, panels[i < 3 ? 0 : 1], facs[i % 3]]));
    }

    const projects = ['MediScan - Gemini powered triage assistant', 'FarmSense - crop advisory chatbot', 'LegalEase - contract summariser',
      'CampusPal - student helpdesk agent', 'EcoRoute - sustainable travel planner', 'CodeMentor - AI pair programmer',
      'FinLit - personal finance coach', 'AccessAI - sign language translator', 'StudyBuddy - adaptive quiz generator',
      'CivicVoice - grievance classifier', 'RecipeGen - multimodal cooking assistant', 'SafeCity - incident report analyser'];
    const teams = [];
    for (const [i, title] of projects.entries()) {
      teams.push(await t.id(
        'INSERT INTO teams (code, name, project_title, members, faculty_id, panel_id) VALUES (?, ?, ?, ?, ?, ?)',
        [`T${String(i + 1).padStart(2, '0')}`, title.split(' - ')[0], title, 'Member 1, Member 2, Member 3', facs[i % 3], panels[i < 6 ? 0 : 1]]));
    }

    const criteria = await t.all('SELECT id, max_marks FROM criteria WHERE is_active = 1 ORDER BY sort_order');
    const teamQuality = teams.map(() => rnd(0.45, 0.95));
    const judgeBias = [0.08, -0.10, 0.0, 0.12, -0.05, 0.03];   // lenient / strict judges, so normalization has work to do
    const judgeSpread = [1.0, 1.3, 0.8, 1.1, 1.0, 0.7];

    let submitted = 0, drafts = 0;
    for (const [ti, teamId] of teams.entries()) {
      const panelIdx = ti < 6 ? 0 : 1;
      for (const [ji, judgeId] of judges.entries()) {
        if ((ji < 3 ? 0 : 1) !== panelIdx) continue;
        await t.run('INSERT INTO assignments (judge_id, team_id) VALUES (?, ?)', [judgeId, teamId]);
        const r = Math.random();
        if (r > 0.85) continue;                                 // leave some pending
        const isDraft = r > 0.75;
        const items = {};
        let total = 0;
        for (const c of criteria) {
          const quality = clamp(teamQuality[ti] + judgeBias[ji] + (rnd(-0.15, 0.15) * judgeSpread[ji]), 0.2, 1);
          const m = half(clamp(quality * c.max_marks, 0, c.max_marks));
          items[c.id] = m; total += m;
        }
        const ts = new Date(Date.now() - Math.floor(rnd(0, 6 * 3600 * 1000))).toISOString();
        const sid = await t.id(
          'INSERT INTO scores (judge_id, team_id, status, comments, submitted_at) VALUES (?, ?, ?, ?, ?)',
          [judgeId, teamId, isDraft ? 'draft' : 'submitted', isDraft ? null : 'Solid demo, good Gemini usage.', isDraft ? null : ts]);
        for (const [cid, m] of Object.entries(items)) {
          await t.run('INSERT INTO score_items (score_id, criterion_id, marks) VALUES (?, ?, ?)', [sid, Number(cid), m]);
        }
        await t.run(`INSERT INTO score_history (score_id, judge_id, team_id, status, items_json, total, comments, changed_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [sid, judgeId, teamId, isDraft ? 'draft' : 'submitted', JSON.stringify(items), total, null, judgeId]);
        if (isDraft) drafts++; else submitted++;
      }
    }
    summary = { faculties: facs.length, panels: panels.length, judges: judges.length, teams: teams.length, submitted, drafts };
    await db.audit({ user: null, action: 'demo_seeded', details: summary }, t);
  });

  console.log(`Demo data loaded on ${db.describe()}:`);
  console.log(`  ${summary.faculties} faculties, ${summary.panels} panels, ${summary.judges} judges, ${summary.teams} teams, ${summary.submitted} submitted scores, ${summary.drafts} drafts.`);
  console.log(`\nJudge logins: judge1 ... judge6   password: ${JUDGE_PASSWORD}`);
  console.log(`Admin login : ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD || 'admin12345'} (unless already changed)\n`);
  await db.close();
})().catch(e => { console.error(`\nFailed: ${e.message}`); process.exit(1); });
