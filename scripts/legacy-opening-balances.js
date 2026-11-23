#!/usr/bin/env node
'use strict';

// Explicit, audited opening-balance import. Dry-run unless --commit.
// Only run against Railway staging until reconciled and reviewed.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field.');
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

function loadRows(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('CSV is empty.');
  const headers = rows.shift().map(x => x.trim().toLowerCase());
  const required = ['email', 'verified_balance_minor', 'reconciliation_reference'];
  if (headers.length !== 3 || headers.some((h, i) => h !== required[i])) {
    throw new Error('Expected exactly these headers: email,verified_balance_minor,reconciliation_reference');
  }
  const seen = new Set();
  return rows.map((r, i) => {
    if (r.length !== 3) throw new Error('Invalid CSV row ' + (i + 2));
    const email = r[0].trim().toLowerCase();
    const raw = r[1].trim();
    const reference = r[2].trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email on row ' + (i + 2));
    if (!/^\d+$/.test(raw)) throw new Error('Balance must be a non-negative integer in minor units on row ' + (i + 2));
    const amount = BigInt(raw);
    if (amount > 9000000000000000n) throw new Error('Balance exceeds safe supported range on row ' + (i + 2));
    if (reference.length < 6 || reference.length > 160 || /[\r\n]/.test(reference)) throw new Error('A valid reconciliation reference is required on row ' + (i + 2));
    if (seen.has(email)) throw new Error('Duplicate customer email in balance CSV.');
    seen.add(email);
    return { email, amount: Number(amount), reference };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const staging = args.includes('--target=staging');
  const path = args.find(x => !x.startsWith('--'));
  if (!path) throw new Error('Usage: node scripts/legacy-opening-balances.js <verified-balances.csv> --target=staging [--commit]');
  if (!staging) throw new Error('Required safety flag missing: --target=staging');
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to Railway STAGING PostgreSQL.');
  const rows = loadRows(fs.readFileSync(path, 'utf8'));

  if (!commit) {
    console.log('DRY RUN only. Balance rows validated:', rows.length);
    console.log('No database changes made. Confirm source reconciliation and staging target before --commit.');
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }, max: 1 });
  const client = await pool.connect();
  let imported = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS migration_opening_balance_imports (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL UNIQUE REFERENCES accounts(id),
        source_reference TEXT NOT NULL UNIQUE,
        imported_amount BIGINT NOT NULL CHECK (imported_amount >= 0),
        imported_at BIGINT NOT NULL
      )
    `);
    for (const row of rows) {
      const user = await client.query(
        "SELECT u.id,a.id account_id,a.balance,a.currency FROM users u JOIN accounts a ON a.user_id=u.id AND a.kind='user' WHERE lower(u.email)=lower($1) FOR UPDATE OF a",
        [row.email]
      );
      if (!user.rowCount) throw new Error('No matching imported customer profile for one row. Import profiles first.');
      const account = user.rows[0];
      const previous = await client.query('SELECT id FROM migration_opening_balance_imports WHERE account_id=$1 OR source_reference=$2', [account.account_id, row.reference]);
      if (previous.rowCount) { skipped++; continue; }
      if (BigInt(account.balance) !== 0n) throw new Error('Account is not zero-balance; reconcile manually instead of overwriting.');
      const now = Date.now();
      const digest = crypto.createHash('sha256').update(String(account.account_id) + ':' + row.reference).digest('hex');
      const groupId = 'legacy-opening-' + digest;
      await client.query('INSERT INTO migration_opening_balance_imports (account_id,source_reference,imported_amount,imported_at) VALUES ($1,$2,$3,$4)', [account.account_id, row.reference, row.amount, now]);
      await client.query('UPDATE accounts SET balance=$1 WHERE id=$2', [row.amount, account.account_id]);
      await client.query(
        "INSERT INTO transactions (group_id,account_id,type,amount,balance_after,counterparty,note,created_at) VALUES ($1,$2,'opening_balance',$3,$3,'Legacy balance migration',$4,$5)",
        [groupId, account.account_id, row.amount, 'Reconciled opening balance. Source ref: ' + row.reference, now]
      );
      await client.query(
        "INSERT INTO admin_audit (admin_email,action,target_user_id,amount,details,created_at) VALUES ($1,'LEGACY_OPENING_BALANCE_IMPORT',$2,$3,$4,$5)",
        [process.env.MIGRATION_AUDIT_ACTOR || 'authorized-migration', account.id, row.amount, 'Opening balance import; source ref: ' + row.reference, now]
      );
      imported++;
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ imported, skipped, total: rows.length, ledger_entries_created: imported }, null, 2));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('Balance migration stopped:', err.message); process.exitCode = 1; });
