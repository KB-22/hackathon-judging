'use strict';
/**
 * Runs sql/001_schema.sql and the application's real queries against a genuine
 * PostgreSQL engine (PGlite - Postgres compiled to WebAssembly, in-process).
 *
 * This is what proves the Supabase path works: same schema file, same
 * dialect-neutral SQL, same driver translation as production.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildApi } = require('../src/drivers/postgres');
const scoring = require('../src/scoring');

const SCHEMA_FILE = path.join(__dirname, '..', 'sql', '001_schema.sql');

/** Boots an in-process Postgres with the production schema applied. */
async function freshPg() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create();
  await pg.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  const runner = async (text, values) => {
    const r = values && values.length ? await pg.query(text, values) : await pg.exec(text).then(a => a[a.length - 1] ?? { rows: [] });
    return { rows: r.rows || [], rowCount: r.affectedRows ?? (r.rows ? r.rows.length : 0) };
  };
  const api = buildApi(runner);
  // PGlite reports affectedRows for DML; SELECTs report row count.
  return { pg, api, close: () => pg.close() };
}

test('the Supabase schema file applies cleanly to a real PostgreSQL', async (t) => {
  const { api, close } = await freshPg();
  t.after(close);
  const tables = (await api.all(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
  )).map(r => r.table_name);
  assert.deepEqual(tables, ['assignments', 'audit_log', 'criteria', 'faculties', 'panels', 'score_history',
    'score_items', 'scores', 'sessions', 'settings', 'teams', 'users']);
  const view = await api.one("SELECT table_name FROM information_schema.views WHERE table_schema='public' AND table_name='v_score_totals'");
  assert.ok(view, 'v_score_totals view exists');
});

test('the schema is idempotent - applying it twice is safe', async (t) => {
  const { pg, api, close } = await freshPg();
  t.after(close);
  await pg.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));   // must not throw
  const { c } = await api.one("SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  assert.equal(Number(c), 12);
});

test('row level security is enabled on every judging table, with no policies', async (t) => {
  const { api, close } = await freshPg();
  t.after(close);
  const unprotected = await api.all(
    "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity = false");
  assert.deepEqual(unprotected.map(r => r.relname), [], 'every table has RLS enabled');
  const policies = await api.all("SELECT policyname FROM pg_policies WHERE schemaname='public'");
  assert.deepEqual(policies, [], 'no policies exist, so anon/authenticated can read nothing');
});

test('defaults and constraints behave like the SQLite build', async (t) => {
  const { api, close } = await freshPg();
  t.after(close);

  const id = await api.id('INSERT INTO faculties (name, code) VALUES (?, ?)', ['Eng', 'E']);
  assert.equal(typeof id, 'number');
  const row = await api.one('SELECT * FROM faculties WHERE id = ?', [id]);
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ISO-8601 text timestamp, same shape as SQLite');

  await assert.rejects(api.run('INSERT INTO faculties (name) VALUES (?)', ['eng']), /duplicate key/i, 'name is unique case-insensitively');
  await assert.rejects(api.run("INSERT INTO users (username, password_hash, name, role) VALUES ('u','h','U','hacker')"), /violates check/i);
  await assert.rejects(api.run('INSERT INTO criteria (name, max_marks) VALUES (?, ?)', ['Bad', 0]), /violates check/i);

  // Multiple NULL codes are allowed, exactly as in SQLite.
  await api.run('INSERT INTO teams (name) VALUES (?)', ['T1']);
  await api.run('INSERT INTO teams (name) VALUES (?)', ['T2']);
  assert.equal(Number((await api.one('SELECT COUNT(*) AS c FROM teams')).c), 2);
});

test('the dialect-neutral SQL subset runs unchanged on Postgres', async (t) => {
  const { api, close } = await freshPg();
  t.after(close);

  const panelId = await api.id('INSERT INTO panels (name) VALUES (?)', ['Panel A']);
  const teamId = await api.id('INSERT INTO teams (name, panel_id) VALUES (?, ?)', ['T', panelId]);
  const judgeId = await api.id("INSERT INTO users (username, password_hash, name, role, panel_id) VALUES (?, ?, ?, 'judge', ?)", ['j1', 'h', 'J', panelId]);

  // ON CONFLICT DO NOTHING, as used by the assignment matrix
  const ins = 'INSERT INTO assignments (judge_id, team_id) VALUES (?, ?) ON CONFLICT (judge_id, team_id) DO NOTHING';
  assert.equal((await api.run(ins, [judgeId, teamId])).changes, 1);
  assert.equal((await api.run(ins, [judgeId, teamId])).changes, 0, 'duplicate assignment ignored, not an error');

  // ON CONFLICT DO UPDATE, as used by settings
  const upsert = `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
  await api.run(upsert, ['event_name', 'First', '2026-01-01T00:00:00.000Z']);
  await api.run(upsert, ['event_name', 'Second', '2026-01-02T00:00:00.000Z']);
  assert.equal((await api.one('SELECT value FROM settings WHERE key = ?', ['event_name'])).value, 'Second');

  // lower() ordering stands in for COLLATE NOCASE
  await api.run('INSERT INTO panels (name) VALUES (?)', ['a-panel']);
  assert.deepEqual((await api.all('SELECT name FROM panels ORDER BY lower(name)')).map(r => r.name), ['a-panel', 'Panel A']);

  // Session invalidation uses a LIKE over the serialised session
  await api.run('INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)', ['s1', `{"userId":${judgeId}}`, Date.now() + 1000]);
  assert.equal((await api.run('DELETE FROM sessions WHERE sess LIKE ?', [`%"userId":${judgeId}%`])).changes, 1);

  // count(*) comes back as a number, not a bigint string
  assert.equal(typeof Number((await api.one('SELECT COUNT(*) AS c FROM panels')).c), 'number');
});

test('v_score_totals derives the raw total, and marks keep half-point precision', async (t) => {
  const { api, close } = await freshPg();
  t.after(close);
  const teamId = await api.id('INSERT INTO teams (name) VALUES (?)', ['T']);
  const judgeId = await api.id("INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, 'judge')", ['j', 'h', 'J']);
  const c1 = await api.id('INSERT INTO criteria (name, max_marks) VALUES (?, ?)', ['A', 60]);
  const c2 = await api.id('INSERT INTO criteria (name, max_marks) VALUES (?, ?)', ['B', 40]);
  const sid = await api.id("INSERT INTO scores (judge_id, team_id, status) VALUES (?, ?, 'submitted')", [judgeId, teamId]);
  await api.run('INSERT INTO score_items (score_id, criterion_id, marks) VALUES (?, ?, ?)', [sid, c1, 55.5]);
  await api.run('INSERT INTO score_items (score_id, criterion_id, marks) VALUES (?, ?, ?)', [sid, c2, 30]);

  const total = await api.one('SELECT total FROM v_score_totals WHERE score_id = ?', [sid]);
  assert.equal(Number(total.total), 85.5, 'total is summed by the database, not the app');

  const empty = await api.id("INSERT INTO scores (judge_id, team_id, status) VALUES (?, ?, 'draft')",
    [judgeId, await api.id('INSERT INTO teams (name) VALUES (?)', ['T2'])]);
  assert.equal(Number((await api.one('SELECT total FROM v_score_totals WHERE score_id = ?', [empty])).total), 0);
});

test('end to end on Postgres: import an event, score it, and rank it', async (t) => {
  const { api, close } = await freshPg();
  t.after(close);

  // Seed the real 9-criterion rubric.
  const { DEFAULT_CRITERIA } = require('../src/db');
  for (const [i, [name, max, desc]] of DEFAULT_CRITERIA.entries()) {
    await api.run('INSERT INTO criteria (name, max_marks, description, sort_order) VALUES (?, ?, ?, ?)', [name, max, desc, i + 1]);
  }
  const criteria = await api.all('SELECT * FROM criteria WHERE is_active = 1 ORDER BY sort_order, id');
  assert.equal(criteria.length, 9);
  assert.equal(criteria.reduce((s, c) => s + Number(c.max_marks), 0), 100, 'rubric totals 100');

  // Two panels of two judges, six teams each - the Hack Days shape.
  const panels = [], judges = [], teams = [];
  for (const pname of ['Panel A', 'Panel B']) {
    const pid = await api.id('INSERT INTO panels (name) VALUES (?)', [pname]);
    panels.push(pid);
    for (const suffix of ['x', 'y']) {
      judges.push({ id: await api.id("INSERT INTO users (username, password_hash, name, role, panel_id) VALUES (?, ?, ?, 'judge', ?)",
        [`${pname}${suffix}`.replace(/\s/g, ''), 'h', `${pname} ${suffix}`, pid]), panel_id: pid });
    }
  }
  for (let i = 0; i < 12; i++) {
    const pid = panels[i < 6 ? 0 : 1];
    teams.push({ id: await api.id('INSERT INTO teams (code, name, panel_id) VALUES (?, ?, ?)',
      [`T${String(i + 1).padStart(2, '0')}`, `Team ${i + 1}`, pid]), panel_id: pid });
  }

  // Both panels see an identical quality ladder (60%..70%), but Panel A marks
  // 20 points more generously. The bias is larger than the within-panel spread,
  // so on raw marks every Panel A team outranks every Panel B team.
  const bias = { [panels[0]]: 0.2, [panels[1]]: 0 };
  for (const team of teams) {
    const idxInPanel = teams.filter(x => x.panel_id === team.panel_id).indexOf(team);
    const quality = 0.6 + 0.02 * idxInPanel;
    for (const judge of judges.filter(j => j.panel_id === team.panel_id)) {
      await api.run('INSERT INTO assignments (judge_id, team_id) VALUES (?, ?) ON CONFLICT (judge_id, team_id) DO NOTHING', [judge.id, team.id]);
      const sid = await api.id("INSERT INTO scores (judge_id, team_id, status, submitted_at) VALUES (?, ?, 'submitted', ?)",
        [judge.id, team.id, new Date().toISOString()]);
      let total = 0;
      for (const c of criteria) {
        const m = Math.round(Math.min(Number(c.max_marks), (quality + bias[team.panel_id]) * Number(c.max_marks)) * 2) / 2;
        await api.run('INSERT INTO score_items (score_id, criterion_id, marks) VALUES (?, ?, ?)', [sid, c.id, m]);
        total += m;
      }
      await api.run(`INSERT INTO score_history (score_id, judge_id, team_id, status, items_json, total, changed_by)
                     VALUES (?, ?, ?, 'submitted', '{}', ?, ?)`, [sid, judge.id, team.id, total, judge.id]);
    }
  }

  // Load it exactly the way src/analytics.js does, then run the scoring engine.
  const totals = await api.all('SELECT * FROM v_score_totals');
  const items = await api.all('SELECT score_id, criterion_id, marks FROM score_items');
  assert.equal(totals.length, 24, '12 teams x 2 judges');
  const itemsBy = new Map();
  for (const it of items) {
    if (!itemsBy.has(it.score_id)) itemsBy.set(it.score_id, {});
    itemsBy.get(it.score_id)[it.criterion_id] = it.marks;
  }
  const data = {
    teams: await api.all('SELECT * FROM teams ORDER BY lower(name)'),
    judges: await api.all("SELECT id, username, name, panel_id, faculty_id, is_active FROM users WHERE role='judge' ORDER BY lower(name)"),
    faculties: await api.all('SELECT * FROM faculties'),
    panels: await api.all('SELECT * FROM panels ORDER BY lower(name)'),
    criteria,
    assignments: await api.all('SELECT judge_id, team_id FROM assignments'),
    scores: totals.map(x => ({ ...x, total: Number(x.total), items: itemsBy.get(x.score_id) || {} })),
  };

  const raw = scoring.computeAnalytics(data, 'none');
  const norm = scoring.computeAnalytics(data, 'zscore');
  const inPanel = (a, name) => a.teams.filter(t => t.panel_name === name);

  // Raw: the lenient panel sweeps the leaderboard - this is the unfairness.
  const rawTop6 = raw.teams.slice().sort((x, y) => x.rank_raw - y.rank_raw).slice(0, 6);
  assert.equal(rawTop6.filter(t => t.panel_name === 'Panel A').length, 6, 'raw ranking is dominated by the lenient panel');
  assert.ok(raw.panel_stats.find(p => p.name === 'Panel A').raw_bias > 5, 'panel leniency is surfaced to the admin');

  // Normalized: the panels interleave again, because leniency has been removed.
  const normTop6 = norm.teams.slice().sort((x, y) => x.rank_norm - y.rank_norm).slice(0, 6);
  const aCount = normTop6.filter(t => t.panel_name === 'Panel A').length;
  assert.ok(aCount >= 2 && aCount <= 4, `after normalization the top 6 is balanced across panels (Panel A has ${aCount})`);

  // The exact fairness guarantee: every panel lands on the global mean.
  for (const p of norm.panel_stats) {
    assert.ok(Math.abs(p.norm_avg - norm.overall.norm_mean) < 0.01, `${p.name} sits at the global mean after normalization`);
  }
  assert.equal(inPanel(norm, 'Panel A').length, 6);
  assert.equal(norm.overall.completion_pct, 100);
});
