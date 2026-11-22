// Data layer. Production uses Postgres (DATABASE_URL, for example Supabase).
// Without DATABASE_URL (local development and tests) it falls back to an embedded Postgres (PGlite),
// so the same SQL runs everywhere.
//
// API (all async):
//   db.get(sql, params)  -> first row or undefined
//   db.all(sql, params)  -> array of rows
//   db.run(sql, params)  -> { changes, lastInsertRowid }
//   db.tx(fn)            -> runs fn in one database transaction (commit on success, rollback on throw).
//                           Every db.* call made while fn runs, including from helper functions, joins it.
// SQL may use "?" placeholders and "INSERT OR IGNORE"; both are translated for Postgres.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
let driver;

// Tables whose INSERT should return the generated id as lastInsertRowid.
const ID_TABLES = new Set(['users', 'accounts', 'cards', 'card_requests', 'transactions', 'verification_requests',
  'admin_audit', 'support_sessions', 'support_messages', 'password_reset_tokens', 'notifications', 'disputes',
  'saved_beneficiaries', 'scheduled_transfers']);

const toNum = (rows) => rows.map((r) => {
  for (const k in r) if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
  return r;
});

function adapt(sql) {
  let s = String(sql);
  let ignore = false;
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(s)) {
    s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    ignore = true;
  }
  let out = '', n = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      out += c;
      if (c === q) { if (s[i + 1] === q) out += s[++i]; else q = null; }
      continue;
    }
    if (c === "'" || c === '"') { q = c; out += c; continue; }
    if (c === '?') { out += '$' + (++n); continue; }
    out += c;
  }
  if (ignore) out = out.replace(/[\s;]*$/, '') + ' ON CONFLICT DO NOTHING';
  return out;
}

async function query(sql, params) {
  const conn = als.getStore() || driver;
  const p = (params || []).map((v) => (v === undefined ? null : v));
  return conn.query(adapt(sql), p);
}
async function get(sql, params) { return (await query(sql, params)).rows[0]; }
async function all(sql, params) { return (await query(sql, params)).rows; }
async function run(sql, params) {
  let text = String(sql);
  const m = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-z_]+)/i.exec(text);
  const wantsId = !!(m && ID_TABLES.has(m[1].toLowerCase()) && !/\bRETURNING\b/i.test(text));
  if (wantsId) text = adapt(text).replace(/[\s;]*$/, '') + ' RETURNING id';
  const r = await (async () => {
    const conn = als.getStore() || driver;
    const p = (params || []).map((v) => (v === undefined ? null : v));
    return conn.query(wantsId ? text : adapt(text), p);
  })();
  return { changes: r.rowCount, lastInsertRowid: wantsId && r.rows[0] ? r.rows[0].id : undefined };
}
async function tx(fn) {
  if (als.getStore()) return fn(); // already inside a transaction: join it
  try {
    return await driver.tx((conn) => als.run(conn, () => fn()));
  } catch (e) {
    // Work that must survive the rollback (for example counting a wrong PIN) is attached to the error.
    if (e && typeof e.afterRollback === 'function') { try { await e.afterRollback(); } catch (_) { /* ignore */ } }
    throw e;
  }
}

async function init() {
  if (process.env.DATABASE_URL) {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => parseInt(v, 10));    // BIGINT / COUNT -> number
    pg.types.setTypeParser(1700, (v) => parseFloat(v));     // NUMERIC (SUM of BIGINT) -> number
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 10),
      connectionTimeoutMillis: 15000
    });
    pool.on('error', (e) => console.error('Postgres pool error:', e.message));
    const wrap = (c) => async (text, params) => {
      const r = await c.query(text, params);
      return { rows: toNum(r.rows || []), rowCount: r.rowCount };
    };
    driver = {
      query: wrap(pool),
      exec: (sql) => pool.query(sql),
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn({ query: wrap(c) });
          await c.query('COMMIT');
          return out;
        } catch (e) {
          try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
          throw e;
        } finally { c.release(); }
      }
    };
  } else {
    if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production');
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR === 'memory' ? undefined : (process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pgdata'));
    if (dir) fs.mkdirSync(path.dirname(dir), { recursive: true });
    const lite = dir ? new PGlite(dir) : new PGlite();
    await lite.waitReady;
    const wrap = (c) => async (text, params) => {
      const r = await c.query(text, params || [], { parsers: { 1700: (v) => parseFloat(v), 20: (v) => parseInt(v, 10) } });
      return { rows: toNum(r.rows || []), rowCount: r.affectedRows != null ? r.affectedRows : (r.rows || []).length };
    };
    driver = {
      query: wrap(lite),
      exec: (sql) => lite.exec(sql),
      tx: (fn) => lite.transaction((t) => fn({ query: wrap(t) }))
    };
  }
  await driver.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

module.exports = {
  ready: init(),
  get, all, run, tx,
  inTx: () => !!als.getStore(),
  exec: (sql) => driver.exec(sql)
};
