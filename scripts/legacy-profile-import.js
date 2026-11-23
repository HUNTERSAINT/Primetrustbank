#!/usr/bin/env node
'use strict';

// Profile-only import for the reviewed legacy customer list.
// Safe by default: dry-run unless --commit is supplied.
// Never imports legacy password/PIN hashes, balances, OTPs, tokens, cards, or KYC documents.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

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

function normalizeCsv(rows) {
  const headers = rows.shift().map(x => x.trim().toLowerCase());
  if (headers.some(h => /password|pin|balance|otp|token|secret|hash|card|account_number|kyc|document/i.test(h))) {
    throw new Error('Sensitive columns are not allowed. CSV must contain only full_name,email.');
  }
  if (headers.length !== 2 || headers[0] !== 'full_name' || headers[1] !== 'email') {
    throw new Error('Expected exactly these CSV headers in this order: full_name,email');
  }
  const seen = new Set();
  return rows.map((r, i) => {
    if (r.length !== 2) throw new Error('CSV row ' + (i + 2) + ' has the wrong number of fields.');
    const full_name = r[0].trim().replace(/\s+/g, ' ');
    const email = r[1].trim().toLowerCase();
    if (full_name.length < 2 || full_name.length > 80) throw new Error('Invalid full_name on row ' + (i + 2));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new Error('Invalid email on row ' + (i + 2));
    if (seen.has(email)) throw new Error('Duplicate email in CSV: ' + email);
    seen.add(email);
    return { full_name, email };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const targetStaging = args.includes('--target=staging');
  const csvPath = args.find(a => !a.startsWith('--'));
  if (!csvPath) throw new Error('Usage: node scripts/legacy-profile-import.js <profiles.csv> --target=staging [--commit]');
  if (!targetStaging) throw new Error('Required safety flag missing: --target=staging');
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the Railway STAGING PostgreSQL connection string.');
  const rows = normalizeCsv(parseCsv(fs.readFileSync(csvPath, 'utf8')));
  if (!rows.length) throw new Error('CSV contains no customer rows.');
  if (!commit) {
    console.log('DRY RUN only. Valid profile rows:', rows.length);
    console.log('No database changes made. Re-run with --commit only after confirming DATABASE_URL is Railway staging.');
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    max: 1,
  });
  const client = await pool.connect();
  let inserted = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const existing = await client.query('SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1', [row.email]);
      if (existing.rowCount) { skipped++; continue; }

      // Unusable random credentials: each customer must verify email and reset password.
      // A fresh random transaction PIN hash prevents reuse of the legacy PIN.
      const fakePassword = crypto.randomBytes(48).toString('base64url');
      const fakePin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      const passwordHash = await bcrypt.hash(fakePassword, 12);
      const pinHash = await bcrypt.hash(fakePin, 12);
      const createdAt = Date.now();

      const user = await client.query(
        "INSERT INTO users (email,email_verified_at,full_name,password_hash,pin_hash,verification_status,status,created_at) VALUES ($1,NULL,$2,$3,$4,'pending','active',$5) RETURNING id",
        [row.email, row.full_name, passwordHash, pinHash, createdAt]
      );
      let accountNumber;
      for (let attempt = 0; attempt < 20; attempt++) {
        accountNumber = String(crypto.randomInt(1000000000, 9999999999));
        const exists = await client.query('SELECT 1 FROM accounts WHERE account_number=$1', [accountNumber]);
        if (!exists.rowCount) break;
        accountNumber = null;
      }
      if (!accountNumber) throw new Error('Could not allocate a unique account number.');
      await client.query("INSERT INTO accounts (user_id,account_number,kind,currency,balance) VALUES ($1,$2,'user','USD',0)", [user.rows[0].id, accountNumber]);
      inserted++;
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ inserted, skipped, total: rows.length, balance_imported: false, legacy_credentials_imported: false }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('Migration stopped:', err.message); process.exitCode = 1; });
