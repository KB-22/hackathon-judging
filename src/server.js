'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const bcrypt = require('bcryptjs');

// Load .env when running locally. On a host, environment variables come from
// the platform and there is no .env file, which is fine.
try {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile) && process.loadEnvFile) process.loadEnvFile(envFile);
} catch (_) { /* ignore */ }

const db = require('./db');
const { sessionMiddleware, loadUser, csrfGuard, ah } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const VIEWS = path.join(__dirname, '..', 'views');
const PUBLIC = path.join(__dirname, '..', 'public');
const VIEW_FILES = ['login.html', 'admin.html', 'judge.html', '404.html'];

/**
 * Read the HTML shells once, at boot. Two reasons: no disk read per request,
 * and if a deployment failed to bundle views/ we fail loudly at startup
 * instead of serving 404s to judges mid-event.
 */
function loadViews() {
  const out = {};
  for (const f of VIEW_FILES) {
    const p = path.join(VIEWS, f);
    if (!fs.existsSync(p)) {
      throw new Error(`Missing view file ${f}. On Vercel this means views/ was not included in the ` +
        'function bundle - check the "includeFiles" entry in vercel.json.');
    }
    out[f] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

const isDeployed = () => db.IS_HOSTED;

/**
 * Checked before any database work, so a misconfigured deployment fails on the
 * config rather than on a confusing connection error.
 */
function assertSessionSecret() {
  if (!isDeployed()) return;
  if ((process.env.SESSION_SECRET || '').length < 32) {
    throw new Error(
      'SESSION_SECRET must be set to a long random string before deploying.\n' +
      'Without it, session cookies are signed with a public default and anyone could forge an admin login.\n' +
      'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
}

/** Only relevant on the very first deploy, when no admin row exists yet. */
function assertAdminPassword(adminCount) {
  if (!isDeployed() || adminCount !== 0) return;
  if ((process.env.ADMIN_PASSWORD || '').length < 10) {
    throw new Error(
      'No admin account exists yet and ADMIN_PASSWORD is unset or shorter than 10 characters.\n' +
      'Set ADMIN_USERNAME and a strong ADMIN_PASSWORD in the project environment variables,\n' +
      'otherwise the first deploy would create a well-known default admin on a public URL.');
  }
}

/** Creates the first admin account if none exists yet. */
async function ensureAdmin(adminCount) {
  const count = adminCount === undefined
    ? Number((await db.q.one("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")).c)
    : adminCount;
  if (count > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  await db.q.run(
    "INSERT INTO users (username, password_hash, name, role, must_change_password) VALUES (?, ?, 'Administrator', 'admin', 1)",
    [username, bcrypt.hashSync(password, 10)]);
  await db.audit({ user: null, action: 'admin_bootstrapped', entityType: 'user', details: { username } });
  console.log(`[setup] Created initial admin -> username: ${username}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`[setup] password: ${password}  (change it after first login)`);
}

async function createApp() {
  assertSessionSecret();
  const views = loadViews();
  await db.init();
  const adminCount = db.bootstrapInfo ? db.bootstrapInfo.admins : undefined;
  assertAdminPassword(adminCount);
  await ensureAdmin(adminCount);

  const app = express();
  app.disable('x-powered-by');
  // Behind Vercel/nginx the client IP and protocol arrive in X-Forwarded-*.
  // Without this, rate limiting and the audit log would record the proxy's IP
  // and secure cookies would be dropped.
  if (db.IS_HOSTED || process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

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

  // Liveness/readiness probe.
  app.get('/healthz', ah(async (req, res) => {
    await db.q.one('SELECT 1 AS ok');
    res.json({ ok: true, driver: db.DRIVER, database: db.describe(), serverless: db.IS_SERVERLESS });
  }));

  // ---- API ----
  app.use('/api', csrfGuard);
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/admin/export', require('./routes/export'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/judge', require('./routes/judge'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- Pages (role-gated shells) ----
  const html = (res, file, status = 200) => res.status(status).type('html').send(views[file]);
  const homeFor = u => (u.role === 'admin' ? '/admin' : '/judge');
  app.get('/', (req, res) => (req.user ? res.redirect(homeFor(req.user)) : html(res, 'login.html')));
  app.get('/admin', (req, res) => (req.user && req.user.role === 'admin' ? html(res, 'admin.html') : res.redirect('/')));
  app.get('/judge', (req, res) => (req.user && req.user.role === 'judge' ? html(res, 'judge.html') : res.redirect('/')));
  // On Vercel, public/ is served by the CDN before a request ever reaches this
  // function; this middleware is the local-development path.
  app.use(express.static(PUBLIC, { index: false, maxAge: 0 }));
  app.use((req, res) => html(res, '404.html', 404));

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

module.exports = { createApp, ensureAdmin, assertSessionSecret, assertAdminPassword, loadViews };
