'use strict';
const session = require('express-session');
const db = require('./db');

/** Database-backed session store, so logins survive restarts and redeploys. */
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

class DbStore extends session.Store {
  constructor() {
    super();
    // Timers do not run between serverless invocations, so there the sweep is
    // done opportunistically on writes instead of on a schedule.
    if (!IS_SERVERLESS) {
      const timer = setInterval(() => this.prune(), 10 * 60 * 1000);
      if (timer.unref) timer.unref();
    }
  }
  get(sid, cb) {
    db.q.one('SELECT sess, expires_at FROM sessions WHERE sid = ?', [sid])
      .then(row => {
        if (!row) return cb(null, null);
        if (Number(row.expires_at) < Date.now()) return this.destroy(sid, () => cb(null, null));
        cb(null, JSON.parse(row.sess));
      })
      .catch(e => cb(e));
  }
  set(sid, sess, cb) {
    const maxAge = sess.cookie && sess.cookie.maxAge ? Number(sess.cookie.maxAge) : 12 * 3600 * 1000;
    db.q.run(
      `INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`,
      [sid, JSON.stringify(sess), Date.now() + maxAge])
      .then(() => {
        // Roughly one write in fifty also clears expired rows, so the table
        // cannot grow without bound where the timer never fires.
        if (IS_SERVERLESS && Math.random() < 0.02) this.prune();
        cb && cb(null);
      })
      .catch(e => cb && cb(e));
  }
  destroy(sid, cb) {
    db.q.run('DELETE FROM sessions WHERE sid = ?', [sid]).then(() => cb && cb(null)).catch(e => cb && cb(e));
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  prune() { db.q.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]).catch(() => {}); }
}

function sessionMiddleware() {
  const secret = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
  if (!process.env.SESSION_SECRET) console.warn('[warn] SESSION_SECRET not set - using an insecure default. Set it in .env for a real event.');
  // Serverless hosts always terminate TLS, so the cookie must be marked secure
  // there or browsers will refuse to store it on the https origin.
  const onHttps = process.env.COOKIE_SECURE === '1'
    || !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
  return session({
    store: new DbStore(),
    name: 'hj.sid',
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: onHttps,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: onHttps,
      maxAge: 12 * 60 * 60 * 1000,
    },
  });
}

/** Loads the current user fresh on every request, so deactivation applies at once. */
async function loadUser(req, res, next) {
  req.user = null;
  try {
    if (req.session && req.session.userId) {
      const u = await db.q.one(
        `SELECT id, username, name, role, email, panel_id, faculty_id, is_active, must_change_password
         FROM users WHERE id = ?`, [req.session.userId]);
      if (u && u.is_active) req.user = u;
      else req.session.destroy(() => {});
    }
    next();
  } catch (e) { next(e); }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

/** In-memory login rate limiter: max N failures per ip+username per window. */
function makeLoginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, 60 * 1000);
  if (timer.unref) timer.unref();
  return {
    check(key) {
      const t = Date.now();
      const h = hits.get(key);
      if (!h || h.reset < t) return { ok: true };
      if (h.count >= max) return { ok: false, retryAfter: Math.ceil((h.reset - t) / 1000) };
      return { ok: true };
    },
    fail(key) {
      const t = Date.now();
      const h = hits.get(key);
      if (!h || h.reset < t) hits.set(key, { count: 1, reset: t + windowMs });
      else h.count++;
    },
    clear(key) { hits.delete(key); },
  };
}

/** CSRF guard for the JSON API: state-changing calls must originate from our own pages. */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin') || (req.get('referer') ? safeOrigin(req.get('referer')) : null);
  const host = req.get('host');
  if (origin) {
    let oh; try { oh = new URL(origin).host; } catch (_) { oh = null; }
    if (oh !== host) return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  if (req.get('x-requested-with') !== 'fetch') return res.status(403).json({ error: 'Missing request header' });
  next();
}
function safeOrigin(u) { try { return new URL(u).origin; } catch (_) { return null; } }

/** Wraps an async route handler so rejections reach Express's error handler. */
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { sessionMiddleware, loadUser, requireAuth, requireRole, makeLoginLimiter, csrfGuard, DbStore, ah };
