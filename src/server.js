'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const bcrypt = require('bcryptjs');

// Load .env if present (Node 20.12+ / 22+).
try {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile) && process.loadEnvFile) process.loadEnvFile(envFile);
} catch (_) { /* ignore */ }

const db = require('./db');
const { sessionMiddleware, loadUser, csrfGuard, ah } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const VIEWS = path.join(__dirname, '..', 'views');
const PUBLIC = path.join(__dirname, '..', 'public');

/** Creates the first admin account if none exists yet. */
async function ensureAdmin() {
  const { c } = await db.q.one("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'");
  if (Number(c) > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  await db.q.run(
    "INSERT INTO users (username, password_hash, name, role, must_change_password) VALUES (?, ?, 'Administrator', 'admin', 1)",
    [username, bcrypt.hashSync(password, 10)]);
  await db.audit({ user: null, action: 'admin_bootstrapped', entityType: 'user', details: { username } });
  console.log(`\n[setup] Created initial admin -> username: ${username}  password: ${password}`);
  console.log('[setup] Change this password after first login (Settings > My account).\n');
}

async function createApp() {
  await db.init();
  await ensureAdmin();

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(express.json({ limit: '2mb' }));
  app.use(sessionMiddleware());
  app.use(loadUser);

  // Liveness/readiness probe for hosted deployments.
  app.get('/healthz', ah(async (req, res) => {
    await db.q.one('SELECT 1 AS ok');
    res.json({ ok: true, driver: db.DRIVER, database: db.describe() });
  }));

  // ---- API ----
  app.use('/api', csrfGuard);
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/admin/export', require('./routes/export'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/judge', require('./routes/judge'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- Pages (role-gated shells) ----
  const homeFor = u => (u.role === 'admin' ? '/admin' : '/judge');
  app.get('/', (req, res) => (req.user ? res.redirect(homeFor(req.user)) : res.sendFile(path.join(VIEWS, 'login.html'))));
  app.get('/admin', (req, res) => (req.user && req.user.role === 'admin' ? res.sendFile(path.join(VIEWS, 'admin.html')) : res.redirect('/')));
  app.get('/judge', (req, res) => (req.user && req.user.role === 'judge' ? res.sendFile(path.join(VIEWS, 'judge.html')) : res.redirect('/')));
  app.use(express.static(PUBLIC, { index: false, maxAge: 0 }));
  app.use((req, res) => res.status(404).sendFile(path.join(VIEWS, '404.html')));

  // ---- Errors ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    const known = db.describeError(err);
    if (known) return res.status(known.status).json({ error: known.error });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

async function main() {
  const app = await createApp();
  const settings = await db.getSettings();
  const server = app.listen(PORT, () => {
    console.log(`${settings.event_name} - judging system on http://localhost:${PORT}`);
    console.log(`database: ${db.describe()}`);
  });
  const shutdown = async (sig) => {
    console.log(`\n${sig} received, shutting down.`);
    server.close(async () => { await db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch(e => { console.error(`\n[fatal] ${e.message}\n`); process.exit(1); });
}

module.exports = { createApp, ensureAdmin };
