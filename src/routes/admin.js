'use strict';
/** Admin API: faculties, panels, users, teams, criteria, assignments, settings, dashboard, audit. */
const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const analytics = require('../analytics');
const scoring = require('../scoring');
const { requireRole, ah } = require('../auth');

const router = express.Router();
router.use(requireRole('admin'));

// ---------- helpers ----------
const str = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
const intOrNull = v => (v === undefined || v === null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);
const bool = v => ((v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0);
const TABLES = new Set(['faculties', 'panels', 'teams', 'users', 'criteria']); // guards the refExists identifier

function generatePassword(len = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}
const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, what = 'Record') => res.status(404).json({ error: `${what} not found` });
async function refExists(q, table, id) {
  if (id == null) return true;
  if (!TABLES.has(table)) throw new Error(`Unknown table ${table}`);
  return !!(await q.one(`SELECT 1 AS x FROM ${table} WHERE id = ?`, [id]));
}
const countOf = async (q, sql, params = []) => Number((await q.one(sql, params)).c);

// ---------- meta ----------
router.get('/meta', ah(async (req, res) => {
  const q = db.q;
  const [s, faculties, panels, criteria, judges, teams, teamsC, judgesC, facC, panC, assignC, subC] = await Promise.all([
    db.getSettings(q),
    q.all('SELECT * FROM faculties ORDER BY lower(name)'),
    q.all('SELECT * FROM panels ORDER BY lower(name)'),
    q.all('SELECT * FROM criteria WHERE is_active = 1 ORDER BY sort_order, id'),
    q.all("SELECT id, name, username, panel_id, faculty_id, is_active FROM users WHERE role = 'judge' ORDER BY lower(name)"),
    q.all('SELECT id, code, name, faculty_id, panel_id FROM teams ORDER BY lower(code), lower(name)'),
    countOf(q, 'SELECT COUNT(*) AS c FROM teams'),
    countOf(q, "SELECT COUNT(*) AS c FROM users WHERE role = 'judge'"),
    countOf(q, 'SELECT COUNT(*) AS c FROM faculties'),
    countOf(q, 'SELECT COUNT(*) AS c FROM panels'),
    countOf(q, 'SELECT COUNT(*) AS c FROM assignments'),
    countOf(q, "SELECT COUNT(*) AS c FROM scores WHERE status = 'submitted'"),
  ]);
  res.json({
    faculties, panels, criteria, judges, teams,
    settings: { ...s, judging_locked: s.judging_locked === '1', allow_edit_after_submit: s.allow_edit_after_submit !== '0' },
    methods: scoring.METHODS,
    counts: { teams: teamsC, judges: judgesC, faculties: facC, panels: panC, assignments: assignC, scores_submitted: subC },
    driver: db.DRIVER,
  });
}));

// ---------- faculties ----------
router.get('/faculties', ah(async (req, res) => {
  res.json(await db.q.all(`SELECT f.*,
    (SELECT COUNT(*) FROM teams t WHERE t.faculty_id = f.id) AS team_count,
    (SELECT COUNT(*) FROM users u WHERE u.faculty_id = f.id AND u.role = 'judge') AS judge_count
    FROM faculties f ORDER BY lower(f.name)`));
}));
router.post('/faculties', ah(async (req, res) => {
  const name = str(req.body?.name), code = str(req.body?.code, 30);
  if (!name) return badRequest(res, 'Name is required');
  const id = await db.q.id('INSERT INTO faculties (name, code) VALUES (?, ?)', [name, code]);
  await db.audit({ user: req.user, action: 'faculty_created', entityType: 'faculty', entityId: id, details: { name, code }, ip: req.ip });
  res.status(201).json(await db.q.one('SELECT * FROM faculties WHERE id = ?', [id]));
}));
router.put('/faculties/:id', ah(async (req, res) => {
  const q = db.q, id = Number(req.params.id);
  if (!(await refExists(q, 'faculties', id))) return notFound(res, 'Faculty');
  const name = str(req.body?.name), code = str(req.body?.code, 30);
  if (!name) return badRequest(res, 'Name is required');
  await q.run('UPDATE faculties SET name = ?, code = ?, updated_at = ? WHERE id = ?', [name, code, db.now(), id]);
  await db.audit({ user: req.user, action: 'faculty_updated', entityType: 'faculty', entityId: id, details: { name, code }, ip: req.ip });
  res.json(await q.one('SELECT * FROM faculties WHERE id = ?', [id]));
}));
router.delete('/faculties/:id', ah(async (req, res) => {
  const q = db.q, id = Number(req.params.id);
  if (!(await refExists(q, 'faculties', id))) return notFound(res, 'Faculty');
  await q.run('DELETE FROM faculties WHERE id = ?', [id]);
  await db.audit({ user: req.user, action: 'faculty_deleted', entityType: 'faculty', entityId: id, ip: req.ip });
  res.json({ ok: true });
}));

// ---------- panels ----------
router.get('/panels', ah(async (req, res) => {
  res.json(await db.q.all(`SELECT p.*,
    (SELECT COUNT(*) FROM teams t WHERE t.panel_id = p.id) AS team_count,
    (SELECT COUNT(*) FROM users u WHERE u.panel_id = p.id AND u.role = 'judge') AS judge_count
    FROM panels p ORDER BY lower(p.name)`));
}));
router.post('/panels', ah(async (req, res) => {
  const name = str(req.body?.name), description = str(req.body?.description, 500);
  if (!name) return badRequest(res, 'Name is required');
  const id = await db.q.id('INSERT INTO panels (name, description) VALUES (?, ?)', [name, description]);
  await db.audit({ user: req.user, action: 'panel_created', entityType: 'panel', entityId: id, details: { name }, ip: req.ip });
  res.status(201).json(await db.q.one('SELECT * FROM panels WHERE id = ?', [id]));
}));
router.put('/panels/:id', ah(async (req, res) => {
  const q = db.q, id = Number(req.params.id);
  if (!(await refExists(q, 'panels', id))) return notFound(res, 'Panel');
  const name = str(req.body?.name), description = str(req.body?.description, 500);
  if (!name) return badRequest(res, 'Name is required');
  await q.run('UPDATE panels SET name = ?, description = ?, updated_at = ? WHERE id = ?', [name, description, db.now(), id]);
  await db.audit({ user: req.user, action: 'panel_updated', entityType: 'panel', entityId: id, details: { name }, ip: req.ip });
  res.json(await q.one('SELECT * FROM panels WHERE id = ?', [id]));
}));
router.delete('/panels/:id', ah(async (req, res) => {
  const q = db.q, id = Number(req.params.id);
  if (!(await refExists(q, 'panels', id))) return notFound(res, 'Panel');
  await q.run('DELETE FROM panels WHERE id = ?', [id]);
  await db.audit({ user: req.user, action: 'panel_deleted', entityType: 'panel', entityId: id, ip: req.ip });
  res.json({ ok: true });
}));

// ---------- users (judges & admins) ----------
const USER_SELECT = `SELECT u.id, u.username, u.name, u.email, u.role, u.panel_id, u.faculty_id, u.is_active, u.must_change_password,
  u.last_login_at, u.created_at, u.updated_at, p.name AS panel_name, f.name AS faculty_name,
  (SELECT COUNT(*) FROM assignments a WHERE a.judge_id = u.id) AS assigned_count,
  (SELECT COUNT(*) FROM scores s WHERE s.judge_id = u.id AND s.status = 'submitted') AS submitted_count,
  (SELECT COUNT(*) FROM scores s WHERE s.judge_id = u.id AND s.status = 'draft') AS draft_count
  FROM users u LEFT JOIN panels p ON p.id = u.panel_id LEFT JOIN faculties f ON f.id = u.faculty_id`;

router.get('/users', ah(async (req, res) => {
  const role = req.query.role === 'admin' ? 'admin' : req.query.role === 'judge' ? 'judge' : null;
  res.json(role
    ? await db.q.all(`${USER_SELECT} WHERE u.role = ? ORDER BY lower(u.name)`, [role])
    : await db.q.all(`${USER_SELECT} ORDER BY u.role, lower(u.name)`));
}));

router.post('/users', ah(async (req, res) => {
  const q = db.q;
  const name = str(req.body?.name), username = str(req.body?.username, 60), email = str(req.body?.email, 200);
  const role = req.body?.role === 'admin' ? 'admin' : 'judge';
  const panel_id = intOrNull(req.body?.panel_id), faculty_id = intOrNull(req.body?.faculty_id);
  if (!name || !username) return badRequest(res, 'Name and username are required');
  if (!/^[A-Za-z0-9._@-]{3,60}$/.test(username)) return badRequest(res, 'Username must be 3-60 chars: letters, digits, . _ @ -');
  if (Number.isNaN(panel_id) || Number.isNaN(faculty_id)) return badRequest(res, 'Invalid panel/faculty');
  if (!(await refExists(q, 'panels', panel_id)) || !(await refExists(q, 'faculties', faculty_id))) return badRequest(res, 'Panel or faculty does not exist');
  let password = str(req.body?.password, 200);
  if (!password) password = generatePassword();
  if (password.length < 8) return badRequest(res, 'Password must be at least 8 characters');

  const id = await q.id(`INSERT INTO users (username, password_hash, name, email, role, panel_id, faculty_id, must_change_password)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [username, bcrypt.hashSync(password, 10), name, email, role, panel_id, faculty_id, bool(req.body?.must_change_password)]);
  await db.audit({ user: req.user, action: 'user_created', entityType: 'user', entityId: id, details: { username, name, role, panel_id, faculty_id }, ip: req.ip });
  const user = await q.one(`${USER_SELECT} WHERE u.id = ?`, [id]);
  res.status(201).json({ user, password }); // plain password returned exactly once, for the admin to hand over
}));

router.put('/users/:id', ah(async (req, res) => {
  const q = db.q, id = Number(req.params.id);
  const u = await q.one('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) return notFound(res, 'User');
  const name = str(req.body?.name) ?? u.name;
  const username = str(req.body?.username, 60) ?? u.username;
  const email = req.body?.email === undefined ? u.email : str(req.body.email, 200);
  const panel_id = req.body?.panel_id === undefined ? u.panel_id : intOrNull(req.body.panel_id);
  const faculty_id = req.body?.faculty_id === undefined ? u.faculty_id : intOrNull(req.body.faculty_id);
  const is_active = req.body?.is_active === undefined ? u.is_active : bool(req.body.is_active);
  if (!/^[A-Za-z0-9._@-]{3,60}$/.test(username)) return badRequest(res, 'Invalid username');
  if (Number.isNaN(panel_id) || Number.isNaN(faculty_id)) return badRequest(res, 'Invalid panel/faculty');
  if (!(await refExists(q, 'panels', panel_id)) || !(await refExists(q, 'faculties', faculty_id))) return badRequest(res, 'Panel or faculty does not exist');
  if (u.id === req.user.id && !is_active) return badRequest(res, 'You cannot deactivate your own account');
  if (u.role === 'admin' && !is_active) {
    if (await countOf(q, "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1") <= 1) {
      return badRequest(res, 'At least one active admin is required');
    }
  }
  await q.run('UPDATE users SET name = ?, username = ?, email = ?, panel_id = ?, faculty_id = ?, is_active = ?, updated_at = ? WHERE id = ?',
    [name, username, email, panel_id, faculty_id, is_active, db.now(), id]);
  if (!is_active) await q.run('DELETE FROM sessions WHERE sess LIKE ?', [`%"userId":${id}%`]);
  await db.audit({ user: req.user, action: 'user_updated', entityType: 'user', entityId: id, details: { name, username, panel_id, faculty_id, is_active }, ip: req.ip });
  res.json(await q.one(`${USER_SELECT} WHERE u.id = ?`, [id]));
}));

router.post('/users/:id/reset-password', ah(async (req, res) => {
  const q = db.q, id = Number(req.params.id);
  const u = await q.one('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) return notFound(res, 'User');
  let password = str(req.body?.password, 200) || generatePassword();
  if (password.length < 8) return badRequest(res, 'Password must be at least 8 characters');
  await q.run('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?',
    [bcrypt.hashSync(password, 10), bool(req.body?.must_change_password), db.now(), id]);
  await q.run('DELETE FROM sessions WHERE sess LIKE ?', [`%"userId":${id}%`]);
  await db.audit({ user: req.user, action: 'password_reset', entityType: 'user', entityId: id, ip: req.ip });
  res.json({ ok: true, password });
}));

router.delete('/users/:id', ah(async (req, res) => {
  const q = db.q, id = Number(req.params.id);
  const u = await q.one('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) return notFound(res, 'User');
  if (u.id === req.user.id) return badRequest(res, 'You cannot delete your own account');
  if (u.role === 'admin' && await countOf(q, "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1") <= 1) {
    return badRequest(res, 'At least one active admin is required');
  }
  const scoreCount = await countOf(q, 'SELECT COUNT(*) AS c FROM scores WHERE judge_id = ?', [id]);
  if (scoreCount > 0 && req.query.force !== '1') {
    return res.status(409).json({ error: `This judge has ${scoreCount} score(s). Deactivate the account instead, or delete with force to remove their scores.`, scores: scoreCount });
  }
  await db.tx(async t => {
    await t.run('DELETE FROM scores WHERE judge_id = ?', [id]); // score_history rows are kept
    await t.run('DELETE FROM users WHERE id = ?', [id]);
    await t.run('DELETE FROM sessions WHERE sess LIKE ?', [`%"userId":${id}%`]);
    await db.audit({ user: req.user, action: 'user_deleted', entityType: 'user', entityId: id, details: { username: u.username, scores_removed: scoreCount }, ip: req.ip }, t);
  });
  res.json({ ok: true });
}));

// ---------- teams ----------
const TEAM_SELECT = `SELECT t.*, f.name AS faculty_name, p.name AS panel_name,
  (SELECT COUNT(*) FROM assignments a WHERE a.team_id = t.id) AS assigned_count,
  (SELECT COUNT(*) FROM scores s WHERE s.team_id = t.id AND s.status = 'submitted') AS submitted_count
  FROM teams t LEFT JOIN faculties f ON f.id = t.faculty_id LEFT JOIN panels p ON p.id = t.panel_id`;

router.get('/teams', ah(async (req, res) => {
  res.json(await db.q.all(`${TEAM_SELECT} ORDER BY lower(t.code), lower(t.name)`));
}));

async function teamPayload(body, q) {
  const name = str(body?.name), code = str(body?.code, 30), project_title = str(body?.project_title, 300);
  const members = str(body?.members, 1000), notes = str(body?.notes, 2000), description = str(body?.description, 4000);
  const faculty_id = intOrNull(body?.faculty_id), panel_id = intOrNull(body?.panel_id);
  if (!name) return { error: 'Team name is required' };
  if (Number.isNaN(faculty_id) || Number.isNaN(panel_id)) return { error: 'Invalid faculty/panel' };
  if (!(await refExists(q, 'faculties', faculty_id)) || !(await refExists(q, 'panels', panel_id))) return { error: 'Faculty or panel does not exist' };
  return { name, code, project_title, members, notes, description, faculty_id, panel_id };
}

router.post('/teams', ah(async (req, res) => {
  const q = db.q;
  const p = await teamPayload(req.body, q);
  if (p.error) return badRequest(res, p.error);
  const id = await q.id('INSERT INTO teams (name, code, project_title, members, notes, description, faculty_id, panel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [p.name, p.code, p.project_title, p.members, p.notes, p.description, p.faculty_id, p.panel_id]);
  await db.audit({ user: req.user, action: 'team_created', entityType: 'team', entityId: id, details: p, ip: req.ip });
  res.status(201).json(await q.one(`${TEAM_SELECT} WHERE t.id = ?`, [id]));
}));

router.put('/teams/:id', ah(async (req, res) => {
  const q = db.q, id = Number(req.params.id);
  if (!(await refExists(q, 'teams', id))) return notFound(res, 'Team');
  const p = await teamPayload(req.body, q);
  if (p.error) return badRequest(res, p.error);
  await q.run(`UPDATE teams SET name = ?, code = ?, project_title = ?, members = ?, notes = ?, description = ?,
               faculty_id = ?, panel_id = ?, updated_at = ? WHERE id = ?`,
    [p.name, p.code, p.project_title, p.members, p.notes, p.description, p.faculty_id, p.panel_id, db.now(), id]);
  await db.audit({ user: req.user, action: 'team_updated', entityType: 'team', entityId: id, details: p, ip: req.ip });
  res.json(await q.one(`${TEAM_SELECT} WHERE t.id = ?`, [id]));
}));

router.delete('/teams/:id', ah(async (req, res) => {
  const q = db.q, id = Number(req.params.id);
  const t = await q.one('SELECT * FROM teams WHERE id = ?', [id]);
  if (!t) return notFound(res, 'Team');
  const scoreCount = await countOf(q, 'SELECT COUNT(*) AS c FROM scores WHERE team_id = ?', [id]);
  if (scoreCount > 0 && req.query.force !== '1') {
    return res.status(409).json({ error: `This team has ${scoreCount} score(s). Delete with force to remove them (history is kept).`, scores: scoreCount });
  }
  await q.run('DELETE FROM teams WHERE id = ?', [id]);
  await db.audit({ user: req.user, action: 'team_deleted', entityType: 'team', entityId: id, details: { name: t.name, code: t.code, scores_removed: scoreCount }, ip: req.ip });
  res.json({ ok: true });
}));

/** Bulk import rows [{name, code, project_title, members, description, faculty, panel}]. */
router.post('/teams/import', ah(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return badRequest(res, 'No rows supplied');
  if (rows.length > 2000) return badRequest(res, 'Too many rows (max 2000)');
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  await db.tx(async t => {
    for (const [i, row] of rows.entries()) {
      const name = str(row.name), code = str(row.code, 30);
      if (!name) { result.skipped++; result.errors.push(`Row ${i + 1}: missing name`); continue; }
      let faculty_id = null, panel_id = null;
      const fac = str(row.faculty), pan = str(row.panel);
      if (fac) {
        const f = await t.one('SELECT id FROM faculties WHERE lower(name) = lower(?) OR lower(code) = lower(?)', [fac, fac]);
        faculty_id = f ? f.id : await t.id('INSERT INTO faculties (name) VALUES (?)', [fac]);
      }
      if (pan) {
        const p = await t.one('SELECT id FROM panels WHERE lower(name) = lower(?)', [pan]);
        panel_id = p ? p.id : await t.id('INSERT INTO panels (name) VALUES (?)', [pan]);
      }
      const existing = code ? await t.one('SELECT id FROM teams WHERE lower(code) = lower(?)', [code]) : null;
      if (existing) {
        await t.run(`UPDATE teams SET name = ?, project_title = ?, members = ?, description = COALESCE(?, description),
                     faculty_id = ?, panel_id = ?, updated_at = ? WHERE id = ?`,
          [name, str(row.project_title, 300), str(row.members, 1000), str(row.description, 4000), faculty_id, panel_id, db.now(), existing.id]);
        result.updated++;
      } else {
        await t.run('INSERT INTO teams (name, code, project_title, members, description, faculty_id, panel_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [name, code, str(row.project_title, 300), str(row.members, 1000), str(row.description, 4000), faculty_id, panel_id]);
        result.created++;
      }
    }
    await db.audit({ user: req.user, action: 'teams_imported', entityType: 'team', details: result, ip: req.ip }, t);
  });
  res.json(result);
}));

// ---------- assignments ----------
const INSERT_ASSIGNMENT = 'INSERT INTO assignments (judge_id, team_id, assigned_by) VALUES (?, ?, ?) ON CONFLICT (judge_id, team_id) DO NOTHING';

router.get('/assignments', ah(async (req, res) => {
  res.json(await db.q.all('SELECT judge_id, team_id, created_at FROM assignments'));
}));

router.post('/assignments/toggle', ah(async (req, res) => {
  const q = db.q;
  const judge_id = intOrNull(req.body?.judge_id), team_id = intOrNull(req.body?.team_id);
  if (!judge_id || !team_id) return badRequest(res, 'judge_id and team_id are required');
  const judge = await q.one("SELECT id FROM users WHERE id = ? AND role = 'judge'", [judge_id]);
  if (!judge || !(await refExists(q, 'teams', team_id))) return badRequest(res, 'Judge or team does not exist');

  if (req.body?.assigned) {
    await q.run(INSERT_ASSIGNMENT, [judge_id, team_id, req.user.id]);
    await db.audit({ user: req.user, action: 'assignment_added', entityType: 'assignment', details: { judge_id, team_id }, ip: req.ip });
  } else {
    const sc = await countOf(q, 'SELECT COUNT(*) AS c FROM scores WHERE judge_id = ? AND team_id = ?', [judge_id, team_id]);
    if (sc > 0 && req.body?.force !== true) {
      return res.status(409).json({ error: 'A score exists for this judge/team. Remove with force to also delete the score (history is kept).' });
    }
    await db.tx(async t => {
      await t.run('DELETE FROM scores WHERE judge_id = ? AND team_id = ?', [judge_id, team_id]);
      await t.run('DELETE FROM assignments WHERE judge_id = ? AND team_id = ?', [judge_id, team_id]);
      await db.audit({ user: req.user, action: 'assignment_removed', entityType: 'assignment', details: { judge_id, team_id, scores_removed: sc }, ip: req.ip }, t);
    });
  }
  res.json({ ok: true });
}));

router.post('/assignments/bulk', ah(async (req, res) => {
  const judgeIds = (Array.isArray(req.body?.judge_ids) ? req.body.judge_ids : []).map(Number).filter(Number.isInteger);
  const teamIds = (Array.isArray(req.body?.team_ids) ? req.body.team_ids : []).map(Number).filter(Number.isInteger);
  const mode = req.body?.mode === 'remove' ? 'remove' : 'add';
  if (!judgeIds.length || !teamIds.length) return badRequest(res, 'Select at least one judge and one team');
  let changed = 0, blocked = 0;
  await db.tx(async t => {
    for (const j of judgeIds) {
      for (const tm of teamIds) {
        if (mode === 'add') {
          changed += (await t.run(INSERT_ASSIGNMENT, [j, tm, req.user.id])).changes;
        } else {
          if (await t.one('SELECT 1 AS x FROM scores WHERE judge_id = ? AND team_id = ?', [j, tm])) { blocked++; continue; }
          changed += (await t.run('DELETE FROM assignments WHERE judge_id = ? AND team_id = ?', [j, tm])).changes;
        }
      }
    }
    await db.audit({ user: req.user, action: mode === 'add' ? 'assignments_bulk_added' : 'assignments_bulk_removed',
      entityType: 'assignment', details: { judge_ids: judgeIds, team_ids: teamIds, changed, blocked }, ip: req.ip }, t);
  });
  res.json({ ok: true, changed, blocked });
}));

/** Assign every team in a panel to every active judge in that panel. */
router.post('/assignments/panel/:panelId', ah(async (req, res) => {
  const q = db.q, panelId = Number(req.params.panelId);
  if (!(await refExists(q, 'panels', panelId))) return notFound(res, 'Panel');
  const judges = (await q.all("SELECT id FROM users WHERE role = 'judge' AND is_active = 1 AND panel_id = ?", [panelId])).map(r => r.id);
  const teams = (await q.all('SELECT id FROM teams WHERE panel_id = ?', [panelId])).map(r => r.id);
  if (!judges.length || !teams.length) return badRequest(res, 'The panel needs at least one active judge and one team');
  let changed = 0;
  await db.tx(async t => {
    for (const j of judges) for (const tm of teams) changed += (await t.run(INSERT_ASSIGNMENT, [j, tm, req.user.id])).changes;
    await db.audit({ user: req.user, action: 'assignments_panel_auto', entityType: 'panel', entityId: panelId,
      details: { judges: judges.length, teams: teams.length, changed }, ip: req.ip }, t);
  });
  res.json({ ok: true, changed, judges: judges.length, teams: teams.length });
}));

// ---------- criteria ----------
router.get('/criteria', ah(async (req, res) => {
  const q = db.q;
  const [criteria, settings, scores] = await Promise.all([
    q.all('SELECT * FROM criteria WHERE is_active = 1 ORDER BY sort_order, id'),
    db.getSettings(q),
    countOf(q, 'SELECT COUNT(*) AS c FROM scores'),
  ]);
  res.json({ criteria, total_marks: Number(settings.total_marks || 100), scores_exist: scores > 0 });
}));

router.put('/criteria', ah(async (req, res) => {
  const q = db.q;
  const list = Array.isArray(req.body?.criteria) ? req.body.criteria : [];
  if (!list.length) return badRequest(res, 'At least one criterion is required');
  const total_marks = Number((await db.getSettings(q)).total_marks || 100);
  const clean = list.map((c, i) => ({
    id: intOrNull(c.id), name: str(c.name), description: str(c.description, 500),
    max_marks: Number(c.max_marks), sort_order: i + 1,
  }));
  for (const c of clean) {
    if (!c.name) return badRequest(res, 'Every criterion needs a name');
    if (!Number.isFinite(c.max_marks) || c.max_marks <= 0) return badRequest(res, `"${c.name}" needs a positive max marks`);
  }
  const sum = clean.reduce((s, c) => s + c.max_marks, 0);
  if (Math.abs(sum - total_marks) > 1e-9) return badRequest(res, `Max marks must total ${total_marks} (currently ${sum})`);

  const existing = await q.all('SELECT * FROM criteria WHERE is_active = 1');
  const scoresExist = await countOf(q, 'SELECT COUNT(*) AS c FROM scores') > 0;
  const keepIds = new Set(clean.filter(c => c.id).map(c => c.id));
  const removed = existing.filter(e => !keepIds.has(e.id));
  const added = clean.filter(c => !c.id);
  const maxChanged = clean.filter(c => c.id && existing.find(e => e.id === c.id && e.max_marks !== c.max_marks));
  if (scoresExist && (removed.length || added.length || maxChanged.length)) {
    return res.status(409).json({ error: 'Scores already exist: you may rename/reorder criteria, but cannot add, remove or change max marks. Delete all scores first if the rubric must change.' });
  }

  await db.tx(async t => {
    for (const r of removed) {
      const used = await countOf(t, 'SELECT COUNT(*) AS c FROM score_items WHERE criterion_id = ?', [r.id]);
      if (used) await t.run('UPDATE criteria SET is_active = 0, updated_at = ? WHERE id = ?', [db.now(), r.id]);
      else await t.run('DELETE FROM criteria WHERE id = ?', [r.id]);
    }
    for (const c of clean) {
      if (c.id) {
        await t.run('UPDATE criteria SET name = ?, description = ?, max_marks = ?, sort_order = ?, updated_at = ? WHERE id = ?',
          [c.name, c.description, c.max_marks, c.sort_order, db.now(), c.id]);
      } else {
        await t.run('INSERT INTO criteria (name, description, max_marks, sort_order) VALUES (?, ?, ?, ?)',
          [c.name, c.description, c.max_marks, c.sort_order]);
      }
    }
    await db.audit({ user: req.user, action: 'criteria_updated', entityType: 'criteria',
      details: { count: clean.length, removed: removed.length, added: added.length }, ip: req.ip }, t);
  });
  res.json({ criteria: await q.all('SELECT * FROM criteria WHERE is_active = 1 ORDER BY sort_order, id') });
}));

// ---------- settings ----------
router.put('/settings', ah(async (req, res) => {
  const q = db.q, b = req.body || {}, changes = {};
  if (b.event_name !== undefined) { const v = str(b.event_name, 120); if (!v) return badRequest(res, 'Event name cannot be empty'); changes.event_name = v; }
  if (b.normalization_method !== undefined) {
    if (!scoring.METHODS.includes(b.normalization_method)) return badRequest(res, `Method must be one of ${scoring.METHODS.join(', ')}`);
    changes.normalization_method = b.normalization_method;
  }
  if (b.judging_locked !== undefined) changes.judging_locked = String(bool(b.judging_locked));
  if (b.allow_edit_after_submit !== undefined) changes.allow_edit_after_submit = String(bool(b.allow_edit_after_submit));
  for (const [k, v] of Object.entries(changes)) await db.setSetting(k, v, q);
  await db.audit({ user: req.user, action: 'settings_updated', entityType: 'settings', details: changes, ip: req.ip });
  const s = await db.getSettings(q);
  res.json({ ...s, judging_locked: s.judging_locked === '1', allow_edit_after_submit: s.allow_edit_after_submit !== '0' });
}));

// ---------- dashboard & scores ----------
function filtersFrom(query) {
  const out = {};
  for (const k of ['faculty_id', 'panel_id', 'judge_id', 'team_id']) if (query[k] !== undefined && query[k] !== '') out[k] = Number(query[k]);
  return out;
}
router.get('/dashboard', ah(async (req, res) => { res.json(await analytics.dashboard(filtersFrom(req.query))); }));

router.get('/scores/:judgeId/:teamId', ah(async (req, res) => {
  const q = db.q;
  const judgeId = Number(req.params.judgeId), teamId = Number(req.params.teamId);
  const s = await q.one('SELECT * FROM v_score_totals WHERE judge_id = ? AND team_id = ?', [judgeId, teamId]);
  const items = s ? await q.all('SELECT criterion_id, marks FROM score_items WHERE score_id = ?', [s.score_id]) : [];
  const history = (await q.all(`SELECT h.*, u.name AS changed_by_name FROM score_history h LEFT JOIN users u ON u.id = h.changed_by
                                WHERE h.judge_id = ? AND h.team_id = ? ORDER BY h.changed_at DESC, h.id DESC`, [judgeId, teamId]))
    .map(h => ({ ...h, items: JSON.parse(h.items_json) }));
  res.json({ score: s ? { ...s, total: Number(s.total), items: Object.fromEntries(items.map(i => [i.criterion_id, i.marks])) } : null, history });
}));

router.delete('/scores/:judgeId/:teamId', ah(async (req, res) => {
  const q = db.q;
  const judgeId = Number(req.params.judgeId), teamId = Number(req.params.teamId);
  const s = await q.one('SELECT * FROM v_score_totals WHERE judge_id = ? AND team_id = ?', [judgeId, teamId]);
  if (!s) return notFound(res, 'Score');
  await db.tx(async t => {
    // Journal the deletion before removing the row, so nothing is lost.
    await t.run(`INSERT INTO score_history (score_id, judge_id, team_id, status, items_json, total, comments, changed_by, changed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.score_id, judgeId, teamId, 'deleted', '{}', 0, `Deleted by admin ${req.user.username}`, req.user.id, db.now()]);
    await t.run('DELETE FROM scores WHERE id = ?', [s.score_id]);
    await db.audit({ user: req.user, action: 'score_deleted', entityType: 'score', entityId: s.score_id,
      details: { judge_id: judgeId, team_id: teamId, total: Number(s.total) }, ip: req.ip }, t);
  });
  res.json({ ok: true });
}));

// ---------- audit ----------
router.get('/audit', ah(async (req, res) => {
  const q = db.q;
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const action = str(req.query.action, 60);
  const [rows, total, actions] = await Promise.all([
    action
      ? q.all('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ? OFFSET ?', [action, limit, offset])
      : q.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]),
    countOf(q, 'SELECT COUNT(*) AS c FROM audit_log'),
    q.all('SELECT DISTINCT action FROM audit_log ORDER BY action'),
  ]);
  res.json({
    rows: rows.map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null })),
    total,
    actions: actions.map(r => r.action),
  });
}));

/** Danger zone: wipe all scores (score_history and audit_log are preserved). */
router.post('/danger/clear-scores', ah(async (req, res) => {
  if (req.body?.confirm !== 'CLEAR SCORES') return badRequest(res, 'Confirmation phrase mismatch');
  const n = await countOf(db.q, 'SELECT COUNT(*) AS c FROM scores');
  await db.tx(async t => {
    await t.run('DELETE FROM scores');
    await db.audit({ user: req.user, action: 'all_scores_cleared', entityType: 'score', details: { removed: n }, ip: req.ip }, t);
  });
  res.json({ ok: true, removed: n });
}));

module.exports = router;
