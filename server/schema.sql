-- Prime Trust Bank schema (Postgres). Safe to run on every boot.
-- Money is BIGINT minor units (cents). Timestamps are BIGINT epoch milliseconds.
-- Yes/no flags stay INTEGER 0/1 so the application code is unchanged.

CREATE TABLE IF NOT EXISTS users (
  id                        BIGSERIAL PRIMARY KEY,
  email                     TEXT NOT NULL UNIQUE,
  full_name                 TEXT NOT NULL,
  password_hash             TEXT NOT NULL,
  pin_hash                  TEXT NOT NULL,
  failed_logins             INTEGER NOT NULL DEFAULT 0,
  locked_until              BIGINT NOT NULL DEFAULT 0,
  failed_pins               INTEGER NOT NULL DEFAULT 0,
  pin_locked_until          BIGINT NOT NULL DEFAULT 0,
  created_at                BIGINT NOT NULL,
  verification_status       TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','submitted','approved','rejected')),
  verification_submitted_at BIGINT,
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  mfa_enabled               INTEGER NOT NULL DEFAULT 0,
  session_version           INTEGER NOT NULL DEFAULT 0,
  kyc_tier                  INTEGER NOT NULL DEFAULT 0 CHECK (kyc_tier BETWEEN 0 AND 2)
);

CREATE TABLE IF NOT EXISTS accounts (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT REFERENCES users(id),
  account_number TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system')),
  currency       TEXT NOT NULL DEFAULT 'USD',
  balance        BIGINT NOT NULL DEFAULT 0,
  CHECK (kind = 'system' OR balance >= 0)
);

CREATE TABLE IF NOT EXISTS cards (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            BIGINT NOT NULL REFERENCES accounts(id),
  last4                 TEXT NOT NULL,
  expiry                TEXT NOT NULL,
  frozen                INTEGER NOT NULL DEFAULT 0,
  demo_number           TEXT,
  demo_cvv              TEXT,
  activated             INTEGER NOT NULL DEFAULT 1,
  online_enabled        INTEGER NOT NULL DEFAULT 1,
  international_enabled INTEGER NOT NULL DEFAULT 0,
  daily_limit           BIGINT NOT NULL DEFAULT 250000,
  card_pin_hash         TEXT,
  card_tier             TEXT NOT NULL DEFAULT 'normal' CHECK (card_tier IN ('normal','black','platinum')),
  physical_requested    INTEGER NOT NULL DEFAULT 0,
  physical_status       TEXT NOT NULL DEFAULT 'not_requested' CHECK (physical_status IN ('not_requested','ordered','shipped','delivered'))
);

CREATE TABLE IF NOT EXISTS card_requests (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL UNIQUE REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','rejected')),
  card_tier    TEXT NOT NULL DEFAULT 'normal' CHECK (card_tier IN ('normal','black','platinum')),
  physical_requested INTEGER NOT NULL DEFAULT 0,
  physical_fee_cents BIGINT NOT NULL DEFAULT 0,
  requested_at BIGINT NOT NULL,
  reviewed_at  BIGINT,
  reviewed_by  TEXT
);

-- One row per account per movement. A transfer writes two rows sharing a group_id.
CREATE TABLE IF NOT EXISTS transactions (
  id            BIGSERIAL PRIMARY KEY,
  group_id      TEXT NOT NULL,
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  type          TEXT NOT NULL,
  amount        BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  counterparty  TEXT NOT NULL,
  note          TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id, id DESC);

CREATE TABLE IF NOT EXISTS external_transfer_requests (
  id                 BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id),
  from_account_id     BIGINT NOT NULL REFERENCES accounts(id),
  bank_name           TEXT NOT NULL,
  account_name         TEXT NOT NULL,
  account_number       TEXT NOT NULL,
  amount               BIGINT NOT NULL CHECK (amount > 0),
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','rejected')),
  note                 TEXT,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL,
  reviewed_by           TEXT,
  review_note           TEXT,
  transfer_reference    TEXT,
  hold_group_id         TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_external_transfer_status ON external_transfer_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_transfer_user ON external_transfer_requests(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency (
  user_id    BIGINT NOT NULL,
  key        TEXT NOT NULL,
  response   TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Identity verification. Documents and the ID number are encrypted by the application (AES-256-GCM).
CREATE TABLE IF NOT EXISTS verification_requests (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL UNIQUE REFERENCES users(id),
  legal_name          TEXT NOT NULL,
  date_of_birth       TEXT NOT NULL,
  address             TEXT NOT NULL,
  id_type             TEXT NOT NULL,
  review_status       TEXT NOT NULL DEFAULT 'submitted' CHECK (review_status IN ('submitted','approved','rejected')),
  admin_note          TEXT,
  submitted_at        BIGINT NOT NULL,
  reviewed_at         BIGINT,
  id_front_data       TEXT,
  id_back_data        TEXT,
  selfie_data         TEXT,
  id_number_enc       TEXT,
  id_last4            TEXT,
  id_country          TEXT,
  id_expiry           TEXT,
  proof_address_data  TEXT,
  upgrade_status      TEXT CHECK (upgrade_status IN ('submitted','approved','rejected')),
  upgrade_submitted_at BIGINT,
  upgrade_reviewed_at BIGINT,
  upgrade_note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_verification_status ON verification_requests(review_status, submitted_at);

CREATE TABLE IF NOT EXISTS admin_audit (
  id             BIGSERIAL PRIMARY KEY,
  admin_email    TEXT NOT NULL,
  action         TEXT NOT NULL,
  target_user_id BIGINT,
  amount         BIGINT,
  details        TEXT,
  created_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at DESC);

CREATE TABLE IF NOT EXISTS admin_sessions (
  jti         TEXT PRIMARY KEY,
  admin_email TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  revoked_at  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS support_sessions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL UNIQUE REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS support_messages (
  id          BIGSERIAL PRIMARY KEY,
  session_id  BIGINT NOT NULL REFERENCES support_sessions(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('user','admin')),
  sender_name TEXT NOT NULL,
  message     TEXT NOT NULL,
  is_read     INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_messages_session ON support_messages(session_id, id);

CREATE TABLE IF NOT EXISTS mfa_challenges (
  id         TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  purpose    TEXT NOT NULL CHECK (purpose IN ('login','enable')),
  code_hash  TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user ON mfa_challenges(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  used_at    BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
  jti          TEXT PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  user_agent   TEXT,
  created_at   BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  revoked_at   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'account',
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);

CREATE TABLE IF NOT EXISTS disputes (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  transaction_id BIGINT NOT NULL REFERENCES transactions(id),
  reason         TEXT NOT NULL,
  details        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','rejected')),
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  UNIQUE (user_id, transaction_id)
);

CREATE TABLE IF NOT EXISTS saved_beneficiaries (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  account_number TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  created_at     BIGINT NOT NULL,
  UNIQUE (user_id, account_number)
);

CREATE TABLE IF NOT EXISTS scheduled_transfers (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id),
  recipient_account TEXT NOT NULL,
  recipient_name    TEXT NOT NULL,
  amount            BIGINT NOT NULL CHECK (amount > 0),
  note              TEXT,
  scheduled_at      BIGINT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled','failed')),
  created_at        BIGINT NOT NULL,
  processed_at      BIGINT,
  failure_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_transfers(status, scheduled_at);

CREATE TABLE IF NOT EXISTS account_limits (
  user_id              BIGINT PRIMARY KEY REFERENCES users(id),
  daily_transfer_limit BIGINT NOT NULL DEFAULT 500000,
  daily_payment_limit  BIGINT NOT NULL DEFAULT 100000,
  updated_at           BIGINT NOT NULL
);

-- Supabase exposes the public schema through its REST API. Row-level security with no policies
-- blocks that API completely. The application connects as the database owner, which is not affected.
ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_requests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_transfer_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency           ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit           ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_challenges        ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications         ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_beneficiaries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_transfers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_limits        ENABLE ROW LEVEL SECURITY;

INSERT INTO accounts (user_id, account_number, kind, balance) VALUES (NULL, 'SYS-BILLERS', 'system', 0)       ON CONFLICT (account_number) DO NOTHING;
INSERT INTO accounts (user_id, account_number, kind, balance) VALUES (NULL, 'SYS-SANDBOX', 'system', 0)       ON CONFLICT (account_number) DO NOTHING;
INSERT INTO accounts (user_id, account_number, kind, balance) VALUES (NULL, 'SYS-ADMIN-ADJUST', 'system', 0)  ON CONFLICT (account_number) DO NOTHING;
INSERT INTO accounts (user_id, account_number, kind, balance) VALUES (NULL, 'SYS-EXTERNAL-TRANSFERS', 'system', 0) ON CONFLICT (account_number) DO NOTHING;

-- Card product configuration and safe in-place migrations for existing deployments.
CREATE TABLE IF NOT EXISTS card_product_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  physical_card_fee_cents BIGINT NOT NULL DEFAULT 2500 CHECK (physical_card_fee_cents>=0 AND physical_card_fee_cents<=50000),
  updated_at BIGINT NOT NULL DEFAULT 0,
  updated_by TEXT
);
INSERT INTO card_product_settings (id,physical_card_fee_cents,updated_at) VALUES (1,2500,0) ON CONFLICT (id) DO NOTHING;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS card_tier TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE cards ADD COLUMN IF NOT EXISTS physical_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS physical_status TEXT NOT NULL DEFAULT 'not_requested';
ALTER TABLE card_requests ADD COLUMN IF NOT EXISTS card_tier TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE card_requests ADD COLUMN IF NOT EXISTS physical_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE card_requests ADD COLUMN IF NOT EXISTS physical_fee_cents BIGINT NOT NULL DEFAULT 0;
INSERT INTO accounts (user_id, account_number, kind, balance) VALUES (NULL, 'SYS-CARD-FEES', 'system', 0) ON CONFLICT (account_number) DO NOTHING;
