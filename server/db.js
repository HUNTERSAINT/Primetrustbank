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

// Identity review is performed by a configured bank administrator.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('verification_status')) {
  db.exec("ALTER TABLE users ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','submitted','approved','rejected'))");
}
if (!userColumns.includes('verification_submitted_at')) {
  db.exec('ALTER TABLE users ADD COLUMN verification_submitted_at INTEGER');
}
db.exec(`
CREATE TABLE IF NOT EXISTS verification_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  legal_name TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  address TEXT NOT NULL,
  id_type TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'submitted' CHECK (review_status IN ('submitted','approved','rejected')),
  admin_note TEXT,
  submitted_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_verification_status ON verification_requests(review_status, submitted_at);
`);

// System accounts that receive airtime/bill payments and fund sandbox deposits.
const ensureSystem = db.prepare(
  `INSERT OR IGNORE INTO accounts (user_id, account_number, kind, balance) VALUES (NULL, ?, 'system', 0)`
);
ensureSystem.run('SYS-BILLERS');
ensureSystem.run('SYS-SANDBOX');


const adminColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!adminColumns.includes('status')) {
  db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'))");
}
db.exec(`
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id INTEGER,
  amount INTEGER,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at DESC);
CREATE TABLE IF NOT EXISTS support_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES support_sessions(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('user','admin')),
  sender_name TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_messages_session ON support_messages(session_id,id);
`);

module.exports = db;
