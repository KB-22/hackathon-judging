'use strict';
/**
 * Vercel serverless entry point.
 *
 * Vercel invokes this module for every request that is not a static file in
 * public/. The Express app is built once per warm container and reused, so the
 * database connection and the bootstrap queries only run on a cold start.
 */
const { createApp } = require('../src/server');

let appPromise = null;

function bootErrorPage(res, err) {
  // The message is written by us (missing env var, missing tables, unreachable
  // host) and never contains the database password, so it is safe to show and
  // saves a trip to the deployment logs during first-time setup.
  const message = String((err && err.message) || 'Unknown startup error');
  console.error('[bootstrap failed]', err);
  res.statusCode = 503;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({
    error: 'The judging system could not start.',
    detail: message.split('\n'),
    hint: 'Check the Environment Variables in Vercel: DB_DRIVER=postgres, SUPABASE_DB_URL, SESSION_SECRET, ADMIN_PASSWORD.',
  }, null, 2));
}

module.exports = async (req, res) => {
  try {
    if (!appPromise) {
      // Clear the cached promise on failure so the next request retries
      // instead of serving the same error until the container is recycled.
      appPromise = createApp().catch(err => { appPromise = null; throw err; });
    }
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    return bootErrorPage(res, err);
  }
};
