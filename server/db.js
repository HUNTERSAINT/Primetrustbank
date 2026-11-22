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
ensureSystem.run('SYS-ADMIN-ADJUST');


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


const verificationColumns = db.prepare('PRAGMA table_info(verification_requests)').all().map((c) => c.name);
for (const column of ['id_front_data','id_back_data','selfie_data']) {
  if (!verificationColumns.includes(column)) db.exec('ALTER TABLE verification_requests ADD COLUMN ' + column + ' TEXT');
}


const sessionColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!sessionColumns.includes('session_version')) {
  db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
}
db.exec(`
CREATE TABLE IF NOT EXISTS admin_sessions (
  jti TEXT PRIMARY KEY,
  admin_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
`);


/* Customer self-service expansion: durable notifications, disputes, saved recipients,
   scheduled transfers and account controls. */
db.exec(`
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS user_sessions (
  jti TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'account',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,id DESC);
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  reason TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','investigating','resolved','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id,transaction_id)
);
CREATE TABLE IF NOT EXISTS saved_beneficiaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_number TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id,account_number)
);
CREATE TABLE IF NOT EXISTS scheduled_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  recipient_account TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  note TEXT,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','completed','cancelled','failed')),
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_transfers(status,scheduled_at);
CREATE TABLE IF NOT EXISTS account_limits (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  daily_transfer_limit INTEGER NOT NULL DEFAULT 500000,
  daily_payment_limit INTEGER NOT NULL DEFAULT 100000,
  updated_at INTEGER NOT NULL
);
`);
module.exports = db;
