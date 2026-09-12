'use strict';
/**
 * Exercises the Vercel serverless entry point (api/index.js) the way the
 * platform does: one handler invoked per request, app built once per container.
 * Also pins the deployment guards that stop an insecure public deploy.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

/** Forgets every cached module under src/ and api/ so env changes take effect. */
function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/](src|api)[\\/]/.test(key)) delete require.cache[key];
  }
}

/** Runs the Vercel handler behind a throwaway HTTP server. */
async function withHandler(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  resetModules();
  const handler = require('../api/index.js');
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise(r => server.close(r));
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    resetModules();
  }
}

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hj-vercel-')), 'test.db');
}

const LOCAL_ENV = () => ({
  DB_DRIVER: 'sqlite',
  DB_PATH: tmpDbPath(),
  SESSION_SECRET: 'x'.repeat(64),
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'a-strong-admin-password',
  VERCEL: '',
  NODE_ENV: '',
});

test('the serverless handler serves the login page and the health probe', async () => {
  await withHandler(LOCAL_ENV(), async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);

    const login = await fetch(`${base}/`);
    assert.equal(login.status, 200);
    assert.match(login.headers.get('content-type') || '', /text\/html/);
    const html = await login.text();
    assert.match(html, /Sign in/, 'the login view was bundled and served');

    // Security headers still apply through the serverless path.
    assert.equal(login.headers.get('x-frame-options'), 'DENY');
    assert.match(login.headers.get('content-security-policy') || '', /script-src 'self'/);
  });
});

test('the serverless handler enforces auth and role separation', async () => {
  await withHandler(LOCAL_ENV(), async (base) => {
    const anon = await fetch(`${base}/api/admin/dashboard`, { headers: { 'X-Requested-With': 'fetch' } });
    assert.equal(anon.status, 401, 'anonymous users cannot read the dashboard');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ username: 'admin', password: 'a-strong-admin-password' }),
    });
    assert.equal(login.status, 200, 'the bootstrapped admin can sign in');
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.startsWith('hj.sid='), 'a session cookie is issued');

    const dash = await fetch(`${base}/api/admin/dashboard`, { headers: { 'X-Requested-With': 'fetch', cookie } });
    assert.equal(dash.status, 200);
    const data = await dash.json();
    assert.equal(data.criteria.length, 9, 'the 9-criterion rubric is seeded on a fresh database');

    const noCsrf = await fetch(`${base}/api/admin/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: '{}',
    });
    assert.equal(noCsrf.status, 403, 'the CSRF guard still applies');
  });
});

test('static assets and unknown paths are handled', async () => {
  await withHandler(LOCAL_ENV(), async (base) => {
    // Vercel serves public/ from its CDN, but the function must cope locally.
    const css = await fetch(`${base}/css/app.css`);
    assert.equal(css.status, 200);
    const missing = await fetch(`${base}/no-such-page`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /not found/i);
  });
});

test('deploying with SQLite is refused, because serverless disks are ephemeral', async () => {
  await withHandler({ ...LOCAL_ENV(), VERCEL: '1' }, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 503);
    const body = await res.json();
    const detail = body.detail.join(' ');
    assert.match(detail, /sqlite cannot run on a serverless host/i);
    assert.match(detail, /DB_DRIVER=postgres/);
  });
});

test('deploying without SESSION_SECRET is refused before any database call', async () => {
  await withHandler({ ...LOCAL_ENV(), VERCEL: '1', DB_DRIVER: 'postgres', SESSION_SECRET: '', SUPABASE_DB_URL: 'postgresql://u:p@example.invalid:5432/db' }, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 503);
    const detail = (await res.json()).detail.join(' ');
    assert.match(detail, /SESSION_SECRET must be set/i);
    assert.doesNotMatch(detail, /example\.invalid/, 'it fails on config, without attempting to connect');
  });
});

test('a short SESSION_SECRET is treated as unset', async () => {
  const saved = { ...process.env };
  try {
    // Deployment context is read when the module loads, so set it first.
    process.env.NODE_ENV = 'production';
    resetModules();
    const { assertSessionSecret } = require('../src/server');
    process.env.SESSION_SECRET = 'too-short';
    assert.throws(() => assertSessionSecret(), /SESSION_SECRET must be set/);
    process.env.SESSION_SECRET = 'y'.repeat(32);
    assert.doesNotThrow(() => assertSessionSecret());
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    resetModules();
  }
});

test('a weak ADMIN_PASSWORD is refused only while no admin exists', async () => {
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = 'production';
    resetModules();
    const { assertAdminPassword } = require('../src/server');
    process.env.ADMIN_PASSWORD = 'admin12345';   // 10 chars, allowed
    assert.doesNotThrow(() => assertAdminPassword(0));
    process.env.ADMIN_PASSWORD = 'short';
    assert.throws(() => assertAdminPassword(0), /ADMIN_PASSWORD is unset or shorter/);
    assert.doesNotThrow(() => assertAdminPassword(1), 'an existing admin means the variable is not needed');
    delete process.env.ADMIN_PASSWORD;
    assert.throws(() => assertAdminPassword(0), /ADMIN_PASSWORD is unset or shorter/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    resetModules();
  }
});

test('vercel.json routes everything to the function and bundles the views', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.match(cfg.rewrites[0].destination, /^\/api\/index/);
  assert.match(cfg.rewrites[0].source, /^\/:path\*$|^\/\(\.\*\)$/);
  const fn = cfg.functions['api/index.js'];
  assert.ok(fn, 'the function is configured');
  assert.match(fn.includeFiles, /views/, 'views/ must be bundled or the HTML shells 404 in production');
  assert.ok(fn.maxDuration >= 15, 'exports need more than the default 10s');
});

test('every view referenced by the server exists on disk', () => {
  const { loadViews } = require('../src/server');
  const views = loadViews();
  for (const f of ['login.html', 'admin.html', 'judge.html', '404.html']) {
    assert.ok(views[f] && views[f].length > 100, `${f} loaded`);
  }
});

test('a hosted platform running SQLite is refused, so scores cannot vanish on redeploy', async () => {
  // Render, Railway, Fly and Heroku keep a long-lived process, but their
  // container disk is wiped on every deploy and idle spin-down.
  for (const platform of [{ RENDER: 'true' }, { RAILWAY_ENVIRONMENT: 'production' }, { FLY_APP_NAME: 'x' }, { DYNO: 'web.1' }]) {
    await withHandler({ ...LOCAL_ENV(), ...platform }, async (base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 503, `${Object.keys(platform)[0]} must refuse SQLite`);
      const detail = (await res.json()).detail.join(' ');
      assert.match(detail, /Refusing to start/i);
      assert.match(detail, /DB_DRIVER=postgres/);
    });
  }
});

test('a hosted platform with an explicit persistent disk may keep SQLite', async () => {
  await withHandler({ ...LOCAL_ENV(), RENDER: 'true', ALLOW_EPHEMERAL_SQLITE: '1' }, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200, 'the opt-out lets a persistent-disk deployment through');
    assert.equal((await res.json()).ok, true);
  });
});

test('a hosted platform still requires a real SESSION_SECRET', async () => {
  await withHandler({ ...LOCAL_ENV(), RENDER: 'true', SESSION_SECRET: '' }, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).detail.join(' '), /SESSION_SECRET must be set/i);
  });
});

test('requests still route correctly if Vercel passes the rewrite destination', async () => {
  // Vercel changed whether a rewritten request arrives with its original path
  // or with the destination ("/api/index"). Under the new behaviour every route
  // would otherwise fall through to the 404 page.
  await withHandler(LOCAL_ENV(), async (base) => {
    const login = await fetch(`${base}/api/index?__p=/`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /Sign in/, 'root resolved from the __p parameter');

    const health = await fetch(`${base}/api/index?__p=/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    // Query strings on the original request must survive the round trip.
    const csv = await fetch(`${base}/api/index?__p=/api/admin/export/csv&dataset=rankings`, {
      headers: { 'X-Requested-With': 'fetch' },
    });
    assert.equal(csv.status, 401, 'reached the admin route, which then demanded auth');

    // And the original behaviour, where the path arrives untouched, still works.
    const direct = await fetch(`${base}/healthz`);
    assert.equal(direct.status, 200);
  });
});

test('vercel.json carries the original path through the rewrite', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const rw = cfg.rewrites[0];
  assert.match(rw.destination, /__p=/, 'the destination must carry the original path');
  assert.match(rw.destination, /^\/api\/index/);
});
