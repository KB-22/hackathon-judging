'use strict';
/**
 * Vercel serverless entry point.
 *
 * Vercel invokes this module for every request that is not a static file in
 * public/. The Express app is built once per warm container and reused, so the
 * database connection and the bootstrap queries only run on a cold start.
 *
 * Nothing is required at module scope on purpose. If a dependency or a source
 * file fails to load, a top-level require would take the whole function down
 * and Vercel would answer with an opaque FUNCTION_INVOCATION_FAILED 500. Doing
 * it inside the handler turns that into a readable 503 that names the cause.
 */

let appPromise = null;

/** Last-resort reporter: must not throw, whatever state the request is in. */
function reportBootFailure(res, err) {
  const message = String((err && err.stack) || (err && err.message) || err || 'Unknown startup error');
  console.error('[bootstrap failed]', message);
  try {
    if (res.headersSent) return res.end();
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    // These messages are written by this codebase (missing variable, missing
    // tables, unreachable host) and never contain the database password.
    res.end(JSON.stringify({
      error: 'The judging system could not start.',
      detail: String((err && err.message) || message).split('\n'),
      checklist: [
        'DB_DRIVER must be "postgres" (SQLite cannot run on Vercel)',
        'SUPABASE_DB_URL must be set, with any @ in the password written as %40',
        'SESSION_SECRET must be at least 32 characters',
        'ADMIN_PASSWORD must be at least 10 characters on the first deploy',
        'The tables must exist: run sql/000_setup_all.sql in the Supabase SQL Editor',
      ],
    }, null, 2));
  } catch (_) {
    try { res.end(); } catch (__) { /* nothing further can be done */ }
  }
}

/**
 * Restores the original request path.
 *
 * Everything is rewritten to this function, and Vercel has changed whether the
 * app sees the original path or the rewrite destination ("/api/index"). If it
 * sees the destination, every route would fall through to the 404 handler. The
 * rewrite therefore carries the real path in a `__p` query parameter, which we
 * put back here. Harmless under the older behaviour, where the path already
 * arrives intact.
 */
function restorePath(req) {
  if (!req.url) return;
  const url = new URL(req.url, 'http://localhost');
  if (!/^\/api\/index\/?$/.test(url.pathname)) return;
  const original = url.searchParams.get('__p');
  if (original === null) return;
  url.searchParams.delete('__p');
  const query = url.searchParams.toString();
  const path = original.startsWith('/') ? original : `/${original}`;
  req.url = query ? `${path}?${query}` : path;
}

module.exports = async (req, res) => {
  try {
    restorePath(req);
    if (!appPromise) {
      // Clearing the cached promise on failure lets the next request retry
      // rather than serving the same error until the container is recycled.
      const { createApp } = require('../src/server');
      appPromise = createApp().catch(err => { appPromise = null; throw err; });
    }
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    return reportBootFailure(res, err);
  }
};
