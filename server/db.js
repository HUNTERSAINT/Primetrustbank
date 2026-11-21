const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bank.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// All money is stored as integer minor units (cents). Never floats.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  pin_hash      TEXT NOT NULL,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  failed_pins   INTEGER NOT NULL DEFAULT 0,
  pin_locked_until INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER REFERENCES users(id),
  account_number TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system')),
  currency       TEXT NOT NULL DEFAULT 'USD',
  balance        INTEGER NOT NULL DEFAULT 0,
  CHECK (kind = 'system' OR balance >= 0)
);

CREATE TABLE IF NOT EXISTS cards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  last4      TEXT NOT NULL,
  expiry     TEXT NOT NULL,
  frozen     INTEGER NOT NULL DEFAULT 0
);

-- One row per account per movement. A transfer writes two rows sharing a group_id.
CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      TEXT NOT NULL,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  type          TEXT NOT NULL,
  amount        INTEGER NOT NULL,          -- signed: negative = money out
  balance_after INTEGER NOT NULL,
  counterparty  TEXT NOT NULL,
  note          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id, id DESC);

CREATE TABLE IF NOT EXISTS idempotency (
  user_id    INTEGER NOT NULL,
  key        TEXT NOT NULL,
  response   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
`);

// System accounts that receive airtime/bill payments and fund sandbox deposits.
const ensureSystem = db.prepare(
  `INSERT OR IGNORE INTO accounts (user_id, account_number, kind, balance) VALUES (NULL, ?, 'system', 0)`
);
ensureSystem.run('SYS-BILLERS');
ensureSystem.run('SYS-SANDBOX');

module.exports = db;
