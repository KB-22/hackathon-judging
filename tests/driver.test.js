'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { toPgPlaceholders } = require('../src/drivers/postgres');
const sqlite = require('../src/drivers/sqlite');

test('placeholder rewriting: ? becomes $1..$n in order', () => {
  assert.equal(toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.equal(toPgPlaceholders('INSERT INTO t (a,b,c) VALUES (?, ?, ?)'), 'INSERT INTO t (a,b,c) VALUES ($1, $2, $3)');
});

test('placeholder rewriting leaves ? inside string literals alone', () => {
  assert.equal(toPgPlaceholders("SELECT * FROM t WHERE a = 'is it? yes' AND b = ?"),
    "SELECT * FROM t WHERE a = 'is it? yes' AND b = $1");
  assert.equal(toPgPlaceholders(`SELECT "odd?col" FROM t WHERE x = ?`), `SELECT "odd?col" FROM t WHERE x = $1`);
  assert.equal(toPgPlaceholders("SELECT '' || ? FROM t"), "SELECT '' || $1 FROM t");
  assert.equal(toPgPlaceholders("SELECT 'it''s a ? mark' , ? FROM t"), "SELECT 'it''s a ? mark' , $1 FROM t");
});

test('placeholder rewriting skips comments', () => {
  assert.equal(toPgPlaceholders('SELECT 1 -- what? really\nWHERE a = ?'), 'SELECT 1 -- what? really\nWHERE a = $1');
  assert.equal(toPgPlaceholders('SELECT 1 /* huh? */ WHERE a = ?'), 'SELECT 1 /* huh? */ WHERE a = $1');
});

function tmpDb() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hj-')), 'test.db');
  return { path: p, cleanup: () => { try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch (_) {} } };
}

test('sqlite driver: one/all/run/id and the shared SQL subset', async (t) => {
  const { path: p, cleanup } = tmpDb();
  t.after(cleanup);
  const d = sqlite.create({ dbPath: p });

  const facId = await d.id('INSERT INTO faculties (name, code) VALUES (?, ?)', ['Eng', 'E']);
  assert.equal(typeof facId, 'number');

  const row = await d.one('SELECT * FROM faculties WHERE id = ?', [facId]);
  assert.equal(row.name, 'Eng');
  assert.ok(row.created_at, 'created_at default is populated');
  assert.deepEqual({ ...row, id: 0, created_at: 0, updated_at: 0 }.name, 'Eng'); // spreadable (no null prototype)

  assert.equal(await d.one('SELECT * FROM faculties WHERE id = ?', [9999]), null);
  assert.equal((await d.all('SELECT * FROM faculties')).length, 1);

  const upd = await d.run('UPDATE faculties SET name = ? WHERE id = ?', ['Engineering', facId]);
  assert.equal(upd.changes, 1);
  assert.equal((await d.run('UPDATE faculties SET name = ? WHERE id = ?', ['x', 9999])).changes, 0);

  // ON CONFLICT DO NOTHING, used by the assignment matrix, must be a no-op on conflict
  const panelId = await d.id('INSERT INTO panels (name) VALUES (?)', ['P1']);
  const teamId = await d.id('INSERT INTO teams (name, panel_id) VALUES (?, ?)', ['T', panelId]);
  const judgeId = await d.id("INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, 'judge')", ['j', 'h', 'J']);
  const ins = 'INSERT INTO assignments (judge_id, team_id) VALUES (?, ?) ON CONFLICT (judge_id, team_id) DO NOTHING';
  assert.equal((await d.run(ins, [judgeId, teamId])).changes, 1);
  assert.equal((await d.run(ins, [judgeId, teamId])).changes, 0, 'duplicate assignment is ignored');

  // lower() ordering replaces COLLATE NOCASE
  await d.run('INSERT INTO panels (name) VALUES (?)', ['a-panel']);
  const names = (await d.all('SELECT name FROM panels ORDER BY lower(name)')).map(r => r.name);
  assert.deepEqual(names, ['a-panel', 'P1']);

  await d.close();
});

test('sqlite driver: v_score_totals derives the raw total from criterion marks', async (t) => {
  const { path: p, cleanup } = tmpDb();
  t.after(cleanup);
  const d = sqlite.create({ dbPath: p });
  const teamId = await d.id('INSERT INTO teams (name) VALUES (?)', ['T']);
  const judgeId = await d.id("INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, 'judge')", ['j', 'h', 'J']);
  const c1 = await d.id('INSERT INTO criteria (name, max_marks) VALUES (?, ?)', ['A', 60]);
  const c2 = await d.id('INSERT INTO criteria (name, max_marks) VALUES (?, ?)', ['B', 40]);
  const sid = await d.id("INSERT INTO scores (judge_id, team_id, status) VALUES (?, ?, 'submitted')", [judgeId, teamId]);
  await d.run('INSERT INTO score_items (score_id, criterion_id, marks) VALUES (?, ?, ?)', [sid, c1, 55.5]);
  await d.run('INSERT INTO score_items (score_id, criterion_id, marks) VALUES (?, ?, ?)', [sid, c2, 30]);

  const total = await d.one('SELECT total FROM v_score_totals WHERE score_id = ?', [sid]);
  assert.equal(Number(total.total), 85.5);

  // A score with no items still appears, with a zero total.
  const sid2 = await d.id("INSERT INTO scores (judge_id, team_id, status) VALUES (?, ?, 'draft')",
    [judgeId, await d.id('INSERT INTO teams (name) VALUES (?)', ['T2'])]);
  assert.equal(Number((await d.one('SELECT total FROM v_score_totals WHERE score_id = ?', [sid2])).total), 0);
  await d.close();
});

test('sqlite driver: tx commits on success and rolls back on throw', async (t) => {
  const { path: p, cleanup } = tmpDb();
  t.after(cleanup);
  const d = sqlite.create({ dbPath: p });

  await d.tx(async q => { await q.run('INSERT INTO panels (name) VALUES (?)', ['kept']); });
  assert.equal((await d.all('SELECT * FROM panels')).length, 1);

  await assert.rejects(d.tx(async q => {
    await q.run('INSERT INTO panels (name) VALUES (?)', ['discarded']);
    throw new Error('boom');
  }), /boom/);
  const names = (await d.all('SELECT name FROM panels')).map(r => r.name);
  assert.deepEqual(names, ['kept'], 'the failed transaction left nothing behind');

  await d.close();
});
