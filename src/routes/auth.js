'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { makeLoginLimiter, requireAuth, ah } = require('../auth');

const router = express.Router();
const limiter = makeLoginLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

const publicUser = u => ({
  id: u.id, username: u.username, name: u.name, role: u.role, email: u.email,
  panel_id: u.panel_id, faculty_id: u.faculty_id, must_change_password: !!u.must_change_password,
});

const regenerate = req => new Promise((res, rej) => req.session.regenerate(e => (e ? rej(e) : res())));
const save = req => new Promise((res, rej) => req.session.save(e => (e ? rej(e) : res())));

router.post('/login', ah(async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const key = `${req.ip}|${username.toLowerCase()}`;
  const lim = limiter.check(key);
  if (!lim.ok) return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lim.retryAfter / 60)} min.` });

  const user = await db.q.one('SELECT * FROM users WHERE lower(username) = lower(?)', [username]);
  const ok = user && user.is_active && bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    limiter.fail(key);
    await db.audit({ user: null, action: 'login_failed', details: { username }, ip: req.ip });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  limiter.clear(key);
  await regenerate(req);
  req.session.userId = user.id;
  await save(req);
  await db.q.run('UPDATE users SET last_login_at = ? WHERE id = ?', [db.now(), user.id]);
  await db.audit({ user, action: 'login', entityType: 'user', entityId: user.id, ip: req.ip });
  res.json({ user: publicUser(user) });
}));

router.post('/logout', ah(async (req, res) => {
  if (req.user) await db.audit({ user: req.user, action: 'logout', entityType: 'user', entityId: req.user.id, ip: req.ip });
  req.session.destroy(() => {
    res.clearCookie('hj.sid');
    res.json({ ok: true });
  });
}));

// Optional club/event logo at public/img/logo.png. Checked once per process so
// the pages never have to probe for a file that may not exist.
const fs = require('node:fs');
const path = require('node:path');
const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'img', 'logo.png');
let logoChecked = 0, hasLogo = false;
function logoExists() {
  if (Date.now() - logoChecked > 30000) { hasLogo = fs.existsSync(LOGO_PATH); logoChecked = Date.now(); }
  return hasLogo;
}

router.get('/me', ah(async (req, res) => {
  const settings = await db.getSettings();
  const base = { event_name: settings.event_name, logo: logoExists() };
  if (!req.user) return res.json({ user: null, ...base });
  res.json({ user: publicUser(req.user), ...base });
}));

router.post('/change-password', requireAuth, ah(async (req, res) => {
  const current = String(req.body?.current_password || '');
  const next = String(req.body?.new_password || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const user = await db.q.one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!bcrypt.compareSync(current, user.password_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
  await db.q.run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
    [bcrypt.hashSync(next, 10), db.now(), user.id]);
  await db.audit({ user: req.user, action: 'password_changed', entityType: 'user', entityId: user.id, ip: req.ip });
  res.json({ ok: true });
}));

module.exports = router;
