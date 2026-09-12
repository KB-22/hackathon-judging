'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeScores, rank, computeAnalytics, mean, stddev } = require('../src/scoring');

const S = (judge_id, team_id, total, extra = {}) => ({ judge_id, team_id, total, status: 'submitted', items: {}, ...extra });

test('mean / stddev basics', () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(stddev([2, 4, 4, 4, 5, 5, 7, 9]), 2);
  assert.equal(stddev([5]), 0);
});

test('zscore: a strict judge and a lenient judge with the same ordering produce identical normalized scores', () => {
  // Judge 1 lenient (80,90,100), Judge 2 strict (40,50,60) - same relative ordering, same spread.
  const scores = [S(1, 'a', 80), S(1, 'b', 90), S(1, 'c', 100), S(2, 'a', 40), S(2, 'b', 50), S(2, 'c', 60)];
  const n = normalizeScores(scores, 'zscore');
  const byTeam = t => n.filter(s => s.team_id === t).map(s => s.normalized);
  for (const t of ['a', 'b', 'c']) assert.equal(byTeam(t)[0], byTeam(t)[1]);
  // Global mean preserved
  assert.ok(Math.abs(mean(n.map(s => s.normalized)) - 70) < 1e-6);
});

test('meanshift removes bias only', () => {
  const scores = [S(1, 'a', 80), S(1, 'b', 90), S(2, 'a', 40), S(2, 'b', 50)];
  const n = normalizeScores(scores, 'meanshift');
  const gm = 65;
  assert.equal(n.find(s => s.judge_id === 1 && s.team_id === 'a').normalized, 80 - 85 + gm);
  assert.equal(n.find(s => s.judge_id === 2 && s.team_id === 'a').normalized, 40 - 45 + gm);
});

test('minmax rescales each judge to 0..100', () => {
  const n = normalizeScores([S(1, 'a', 60), S(1, 'b', 80), S(1, 'c', 70)], 'minmax');
  assert.deepEqual(n.map(s => s.normalized), [0, 100, 50]);
});

test('a judge with a single score is left raw; constant judge gets global mean under zscore', () => {
  const n = normalizeScores([S(1, 'a', 77), S(2, 'a', 50), S(2, 'b', 50), S(2, 'c', 50)], 'zscore');
  assert.equal(n[0].normalized, 77);
  const gm = mean([77, 50, 50, 50]);
  assert.ok(Math.abs(n[1].normalized - gm) < 1e-6);
});

test('none method returns raw', () => {
  const n = normalizeScores([S(1, 'a', 10), S(1, 'b', 20)], 'none');
  assert.deepEqual(n.map(s => s.normalized), [10, 20]);
});

test('rank uses competition ranking with ties', () => {
  const r = rank([{ id: 1, v: 90 }, { id: 2, v: 95 }, { id: 3, v: 90 }, { id: 4, v: 80 }, { id: 5, v: null }], x => x.v);
  assert.equal(r.get(2), 1); assert.equal(r.get(1), 2); assert.equal(r.get(3), 2); assert.equal(r.get(4), 4); assert.equal(r.has(5), false);
});

function fixture() {
  const criteria = [{ id: 1, name: 'A', max_marks: 50 }, { id: 2, name: 'B', max_marks: 50 }];
  const faculties = [{ id: 1, name: 'F1' }, { id: 2, name: 'F2' }];
  const panels = [{ id: 1, name: 'P1' }, { id: 2, name: 'P2' }];
  const judges = [
    { id: 1, name: 'J1', username: 'j1', panel_id: 1 }, { id: 2, name: 'J2', username: 'j2', panel_id: 1 },
    { id: 3, name: 'J3', username: 'j3', panel_id: 2 },
  ];
  const teams = [
    { id: 1, name: 'T1', code: 'T1', faculty_id: 1, panel_id: 1 }, { id: 2, name: 'T2', code: 'T2', faculty_id: 2, panel_id: 1 },
    { id: 3, name: 'T3', code: 'T3', faculty_id: 1, panel_id: 2 },
  ];
  const assignments = [{ judge_id: 1, team_id: 1 }, { judge_id: 1, team_id: 2 }, { judge_id: 2, team_id: 1 }, { judge_id: 2, team_id: 2 }, { judge_id: 3, team_id: 3 }];
  const scores = [
    S(1, 1, 80, { items: { 1: 40, 2: 40 } }), S(1, 2, 60, { items: { 1: 30, 2: 30 } }),
    S(2, 1, 70, { items: { 1: 35, 2: 35 } }), S(2, 2, 50, { items: { 1: 25, 2: 25 }, status: 'draft' }),
    S(3, 3, 90, { items: { 1: 45, 2: 45 } }),
  ];
  return { criteria, faculties, panels, judges, teams, assignments, scores };
}

test('computeAnalytics: aggregates, completion and ranking', () => {
  const a = computeAnalytics(fixture(), 'none');
  assert.equal(a.overall.assignments, 5);
  assert.equal(a.overall.submitted, 4);
  assert.equal(a.overall.drafts, 1);
  assert.equal(a.overall.pending, 1);
  const t1 = a.teams.find(t => t.id === 1);
  assert.equal(t1.raw_avg, 75); assert.equal(t1.submitted_count, 2); assert.equal(t1.is_complete, true);
  assert.equal(t1.criterion_avg[1], 37.5);
  const t3 = a.teams.find(t => t.id === 3);
  assert.equal(t3.rank_norm, 1); assert.equal(t1.rank_norm, 2);
  const t2 = a.teams.find(t => t.id === 2);
  assert.equal(t2.submitted_count, 1); assert.equal(t2.draft_count, 1); assert.equal(t2.is_complete, false);
  const j2 = a.judges.find(j => j.id === 2);
  assert.equal(j2.assigned_count, 2); assert.equal(j2.submitted_count, 1); assert.equal(j2.draft_count, 1); assert.equal(j2.completion_pct, 50);
  assert.equal(a.completion.find(c => c.judge_id === 2 && c.team_id === 2).status, 'draft');
  assert.equal(a.faculty_stats.find(f => f.id === 1).team_count, 2);
  assert.equal(a.panel_stats.find(p => p.id === 2).top_team.id, 3);
});

test('computeAnalytics: filters narrow the view but keep global ranks', () => {
  const a = computeAnalytics(fixture(), 'none', { panel_id: 1 });
  assert.deepEqual(a.teams.map(t => t.id).sort(), [1, 2]);
  assert.equal(a.teams.find(t => t.id === 1).rank_norm, 2); // still ranked globally behind T3
  assert.deepEqual(a.judges.map(j => j.id).sort(), [1, 2]);
  assert.equal(a.overall.submitted, 3);
  const byJudge = computeAnalytics(fixture(), 'none', { judge_id: 3 });
  assert.deepEqual(byJudge.teams.map(t => t.id), [3]);
  assert.equal(byJudge.scores.length, 1);
});

test('a lenient panel is neutralised: same relative quality in both panels yields identical normalized scores', () => {
  // Panel 1 (judges 1,2) is lenient by +20 on every team; Panel 2 (judges 3,4) is strict. Each panel scores its own 3 teams.
  const scores = [
    S(1, 'a', 90), S(1, 'b', 80), S(1, 'c', 70), S(2, 'a', 92), S(2, 'b', 82), S(2, 'c', 72),
    S(3, 'x', 70), S(3, 'y', 60), S(3, 'z', 50), S(4, 'x', 72), S(4, 'y', 62), S(4, 'z', 52),
  ];
  const judges = [{ id: 1, panel_id: 1 }, { id: 2, panel_id: 1 }, { id: 3, panel_id: 2 }, { id: 4, panel_id: 2 }];
  for (const method of ['zscore', 'panel_zscore', 'meanshift']) {
    const n = normalizeScores(scores, method, judges);
    const teamAvg = t => mean(n.filter(s => s.team_id === t).map(s => s.normalized));
    assert.ok(Math.abs(teamAvg('a') - teamAvg('x')) < 1e-6, `${method}: top teams of both panels should tie`);
    assert.ok(Math.abs(teamAvg('c') - teamAvg('z')) < 1e-6, `${method}: bottom teams of both panels should tie`);
    assert.ok(teamAvg('a') > teamAvg('b') && teamAvg('b') > teamAvg('c'), `${method}: within-panel order preserved`);
  }
});

test('zscore falls back to a mean shift when a judge has fewer than 3 scores (unstable SD)', () => {
  const n = normalizeScores([S(1, 'a', 90), S(1, 'b', 89), S(2, 'a', 60), S(2, 'b', 40), S(2, 'c', 50)], 'zscore');
  const gm = mean([90, 89, 60, 40, 50]);
  // judge 1 has 2 scores with SD 0.5: rescaling would explode; instead shift by mean only
  assert.ok(Math.abs(n[0].normalized - (90 - 89.5 + gm)) < 1e-6);
  assert.ok(Math.abs(n[1].normalized - (89 - 89.5 + gm)) < 1e-6);
});

test('computeAnalytics exposes judge and panel bias', () => {
  const a = computeAnalytics(fixture(), 'zscore');
  const j1 = a.judges.find(j => j.id === 1); // scored 80 and 60 -> mean 70; global mean of submitted (80,60,70,90) = 75
  assert.equal(j1.bias, -5);
  const p2 = a.panel_stats.find(p => p.id === 2); // only team 3 scored 90
  assert.equal(p2.raw_bias, 15);
});
