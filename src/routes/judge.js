'use strict';
/**
 * Judge API. Every endpoint is scoped to the logged-in judge:
 *  - only teams in `assignments` for this judge are visible
 *  - only this judge's own scores are ever returned
 *  - no rankings, no other judges, no other panels
 */
const express = require('express');
const db = require('../db');
const { requireRole, ah } = require('../auth');

const router = express.Router();
router.use(requireRole('judge'));

const activeCriteria = q => q.all('SELECT id, name, description, max_marks, sort_order FROM criteria WHERE is_active = 1 ORDER BY sort_order, id');
const isAssigned = async (q, judgeId, teamId) => !!(await q.one('SELECT 1 AS x FROM assignments WHERE judge_id = ? AND team_id = ?', [judgeId, teamId]));

async function loadScore(q, judgeId, teamId) {
  const s = await q.one('SELECT * FROM v_score_totals WHERE judge_id = ? AND team_id = ?', [judgeId, teamId]);
  if (!s) return null;
  const items = {};
  for (const it of await q.all('SELECT criterion_id, marks FROM score_items WHERE score_id = ?', [s.score_id])) items[it.criterion_id] = it.marks;
  return { status: s.status, comments: s.comments, total: Number(s.total), items, created_at: s.created_at, updated_at: s.updated_at, submitted_at: s.submitted_at };
}

router.get('/overview', ah(async (req, res) => {
  const q = db.q;
  const [settings, me, criteria, teams] = await Promise.all([
    db.getSettings(q),
    q.one(`SELECT u.id, u.name, u.username, u.email, p.name AS panel_name, f.name AS faculty_name
           FROM users u LEFT JOIN panels p ON p.id = u.panel_id LEFT JOIN faculties f ON f.id = u.faculty_id
           WHERE u.id = ?`, [req.user.id]),
    activeCriteria(q),
    q.all(`SELECT t.id, t.code, t.name, t.project_title, t.members, t.notes, t.description,
                  f.name AS faculty_name, p.name AS panel_name,
                  vs.status, vs.total, vs.updated_at AS score_updated_at, vs.submitted_at
           FROM assignments a
           JOIN teams t ON t.id = a.team_id
           LEFT JOIN faculties f ON f.id = t.faculty_id
           LEFT JOIN panels p ON p.id = t.panel_id
           LEFT JOIN v_score_totals vs ON vs.judge_id = a.judge_id AND vs.team_id = a.team_id
           WHERE a.judge_id = ?
           ORDER BY lower(t.code), lower(t.name)`, [req.user.id]),
  ]);
  const submitted = teams.filter(t => t.status === 'submitted').length;
  res.json({
    judge: me,
    event_name: settings.event_name,
    judging_locked: settings.judging_locked === '1',
    allow_edit_after_submit: settings.allow_edit_after_submit !== '0',
    total_marks: Number(settings.total_marks || 100),
    criteria,
    teams: teams.map(t => ({ ...t, status: t.status || 'pending', total: t.status ? Number(t.total) : null })),
    progress: { assigned: teams.length, submitted, drafts: teams.filter(t => t.status === 'draft').length, pending: teams.length - submitted },
  });
}));

router.get('/scores/:teamId', ah(async (req, res) => {
  const q = db.q;
  const teamId = Number(req.params.teamId);
  if (!(await isAssigned(q, req.user.id, teamId))) return res.status(403).json({ error: 'This team is not assigned to you' });
  const team = await q.one(`SELECT t.id, t.code, t.name, t.project_title, t.members, t.notes, t.description,
                                   f.name AS faculty_name, p.name AS panel_name
                            FROM teams t LEFT JOIN faculties f ON f.id = t.faculty_id LEFT JOIN panels p ON p.id = t.panel_id
                            WHERE t.id = ?`, [teamId]);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json({ team, criteria: await activeCriteria(q), score: await loadScore(q, req.user.id, teamId) });
}));

router.put('/scores/:teamId', ah(async (req, res) => {
  const q = db.q;
  const teamId = Number(req.params.teamId);
  const judgeId = req.user.id;

  // These four reads do not depend on each other. Issuing them together turns
  // four network round trips into one, which matters on a remote database.
  const [assigned, settings, existing, criteria] = await Promise.all([
    isAssigned(q, judgeId, teamId),
    db.getSettings(q),
    q.one('SELECT * FROM scores WHERE judge_id = ? AND team_id = ?', [judgeId, teamId]),
    activeCriteria(q),
  ]);

  if (!assigned) return res.status(403).json({ error: 'This team is not assigned to you' });
  if (settings.judging_locked === '1') return res.status(423).json({ error: 'Judging is locked by the administrator' });
  if (existing && existing.status === 'submitted' && settings.allow_edit_after_submit === '0') {
    return res.status(409).json({ error: 'This score has already been submitted and cannot be edited' });
  }

  const submit = !!req.body?.submit;
  const rawItems = req.body?.items && typeof req.body.items === 'object' ? req.body.items : {};
  const comments = req.body?.comments == null ? null : String(req.body.comments).slice(0, 2000);

  const items = {};
  const errors = [];
  for (const c of criteria) {
    const v = rawItems[c.id];
    if (v === undefined || v === null || v === '') {
      if (submit) errors.push(`"${c.name}" is required`);
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) { errors.push(`"${c.name}" must be a number`); continue; }
    if (n < 0 || n > c.max_marks) { errors.push(`"${c.name}" must be between 0 and ${c.max_marks}`); continue; }
    if (Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) { errors.push(`"${c.name}" must be in steps of 0.5`); continue; }
    items[c.id] = Math.round(n * 2) / 2;
  }
  if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });

  const total = Object.values(items).reduce((s, x) => s + x, 0);
  const ts = db.now();
  const status = submit ? 'submitted' : 'draft';

  await db.tx(async t => {
    let scoreId;
    if (existing) {
      scoreId = existing.id;
      await t.run('UPDATE scores SET status = ?, comments = ?, updated_at = ?, submitted_at = ? WHERE id = ?',
        [status, comments, ts, submit ? ts : existing.submitted_at, scoreId]);
      await t.run('DELETE FROM score_items WHERE score_id = ?', [scoreId]);
    } else {
      scoreId = await t.id('INSERT INTO scores (judge_id, team_id, status, comments, created_at, updated_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [judgeId, teamId, status, comments, ts, ts, submit ? ts : null]);
    }
    // One multi-row insert rather than one per criterion: against a remote
    // database those nine round trips dominated the time a judge spends
    // waiting for "Submit" to complete.
    const entries = Object.entries(items);
    if (entries.length) {
      await t.run(
        `INSERT INTO score_items (score_id, criterion_id, marks) VALUES ${entries.map(() => '(?, ?, ?)').join(', ')}`,
        entries.flatMap(([cid, marks]) => [scoreId, Number(cid), marks]));
    }
    // Immutable journal entry: the original marks are never overwritten.
    await t.run(`INSERT INTO score_history (score_id, judge_id, team_id, status, items_json, total, comments, changed_by, changed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [scoreId, judgeId, teamId, status, JSON.stringify(items), total, comments, judgeId, ts]);
    await db.audit({ user: req.user, action: submit ? 'score_submitted' : 'score_saved', entityType: 'score', entityId: scoreId,
      details: { team_id: teamId, total, status }, ip: req.ip }, t);
  });

  res.json({ ok: true, score: await loadScore(q, judgeId, teamId) });
}));

module.exports = router;
