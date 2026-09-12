'use strict';
/** Loads judging data from the database and runs the pure scoring engine over it. */
const db = require('./db');
const scoring = require('./scoring');

async function loadData(q = db.q) {
  const [teams, judges, faculties, panels, criteria, assignments, totals, items] = await Promise.all([
    q.all('SELECT * FROM teams ORDER BY lower(name)'),
    q.all("SELECT id, username, name, email, panel_id, faculty_id, is_active, last_login_at FROM users WHERE role = 'judge' ORDER BY lower(name)"),
    q.all('SELECT * FROM faculties ORDER BY lower(name)'),
    q.all('SELECT * FROM panels ORDER BY lower(name)'),
    q.all('SELECT * FROM criteria WHERE is_active = 1 ORDER BY sort_order, id'),
    q.all('SELECT judge_id, team_id, created_at FROM assignments'),
    q.all('SELECT * FROM v_score_totals'),
    q.all('SELECT score_id, criterion_id, marks FROM score_items'),
  ]);
  const itemsBy = new Map();
  for (const it of items) {
    if (!itemsBy.has(it.score_id)) itemsBy.set(it.score_id, {});
    itemsBy.get(it.score_id)[it.criterion_id] = it.marks;
  }
  const scores = totals.map(t => ({
    score_id: t.score_id, judge_id: t.judge_id, team_id: t.team_id, status: t.status, total: Number(t.total),
    comments: t.comments, created_at: t.created_at, updated_at: t.updated_at, submitted_at: t.submitted_at,
    items: itemsBy.get(t.score_id) || {},
  }));
  return { teams, judges, faculties, panels, criteria, assignments, scores };
}

async function dashboard(filters = {}, q = db.q) {
  const [settings, data] = await Promise.all([db.getSettings(q), loadData(q)]);
  const result = scoring.computeAnalytics(data, settings.normalization_method || 'zscore', filters);
  result.settings = {
    event_name: settings.event_name,
    normalization_method: settings.normalization_method,
    judging_locked: settings.judging_locked === '1',
    allow_edit_after_submit: settings.allow_edit_after_submit !== '0',
    total_marks: Number(settings.total_marks || 100),
  };
  result.filters = filters;
  result.generated_at = new Date().toISOString();
  return result;
}

module.exports = { loadData, dashboard };
