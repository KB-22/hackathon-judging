'use strict';
/**
 * Turns an opaque "timeout expired" into an explanation. Postgres speaks on
 * port 5432, which many campus and corporate networks block outright while
 * leaving 80/443 open - so the failure looks like a bad password when it is
 * really a firewall.
 */
const net = require('node:net');

function probe(host, port, ms = 6000) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = v => { if (!settled) { settled = true; socket.destroy(); resolve(v); } };
    socket.setTimeout(ms, () => done('blocked'));
    socket.on('connect', () => done('open'));
    socket.on('error', e => done(e.code === 'ENOTFOUND' ? 'dns' : 'blocked'));
  });
}

/** Builds a human explanation for a failed Postgres connection. */
async function explain(connectionString, err) {
  let host = '', port = 5432;
  try { const u = new URL(connectionString); host = u.hostname; port = Number(u.port) || 5432; } catch (_) { /* ignore */ }
  const lines = [];
  const msg = String((err && err.message) || '');

  if (/password authentication|SASL|SCRAM/i.test(msg)) {
    lines.push('The database password was rejected.');
    lines.push('If the password contains @ : / ? # or %, percent-encode it in the URL (@ becomes %40).');
    return lines.join('\n');
  }

  if (/timeout|ETIMEDOUT|ENETUNREACH|ECONNREFUSED/i.test(msg) && host) {
    const [pg, https] = await Promise.all([probe(host, port), probe(host, 443, 4000)]);
    if (pg === 'dns') {
      lines.push(`The host ${host} does not resolve. Re-copy the connection string from Supabase.`);
      return lines.join('\n');
    }
    if (pg === 'blocked' && https === 'open') {
      lines.push(`This network blocks outbound port ${port}, so the database is unreachable from here.`);
      lines.push(`(${host}:443 connects fine, ${host}:${port} times out - that is a firewall, not Supabase.)`);
      lines.push('');
      lines.push('Two ways around it:');
      lines.push('  1. Load the data through the browser, which uses HTTPS:');
      lines.push('       npm run db:dump');
      lines.push('     then paste sql/001_schema.sql and sql/002_data.sql into the');
      lines.push('     Supabase Dashboard -> SQL Editor and run them.');
      lines.push('  2. Retry from a network that allows 5432, such as a mobile hotspot,');
      lines.push('     or deploy the app to a host, which will reach Supabase normally.');
      lines.push('');
      lines.push('Meanwhile the app runs fully on SQLite: set DB_DRIVER=sqlite in .env.');
      return lines.join('\n');
    }
    lines.push(`Could not reach ${host}:${port}. Check the connection string and your network.`);
    return lines.join('\n');
  }
  return msg;
}

module.exports = { explain, probe };
