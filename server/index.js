const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const SANDBOX_FUNDING = process.env.ALLOW_SANDBOX_FUNDING !== 'false';
const SESSION_HOURS = 8;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (PROD) { console.error('JWT_SECRET must be set in production'); process.exit(1); }
  JWT_SECRET = crypto.randomBytes(32).toString('hex'); // dev only: sessions reset on restart
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'script-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'upgrade-insecure-requests': PROD ? [] : null
    }
  }
}));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

// ---------- helpers ----------
const now = () => Date.now();
const cents = (v) => {
  // accepts a number or numeric string in major units, returns integer minor units or null
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) return null;
  const c = Math.round(n * 100);
  if (Math.abs(n * 100 - c) > 1e-6) return null; // more than 2 decimals
  return c;
};
const fail = (res, status, message) => res.status(status).json({ error: message });
const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    console.error(e); fail(res, 500, 'Something went wrong. Please try again.');
  }
};
const httpErr = (status, message) => Object.assign(new Error(message), { status });

function newAccountNumber() {
  for (;;) {
    const n = String(crypto.randomInt(1000000000, 9999999999));
    if (!db.prepare('SELECT 1 FROM accounts WHERE account_number = ?').get(n)) return n;
  }
}
function cardNumber() { return String(crypto.randomInt(1000, 9999)); }

function issueSession(res, userId) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: SESSION_HOURS + 'h' });
  res.cookie('ptb_session', token, {
    httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: SESSION_HOURS * 3600 * 1000, path: '/'
  });
}

function adminAuth(req, res, next) {
  try {
    const payload = jwt.verify(req.cookies.ptb_admin || '', JWT_SECRET);
    if (payload.admin !== true) throw new Error('not admin');
    req.admin = payload;
    next();
  } catch { fail(res, 401, 'Administrator sign-in required.'); }
}
function requireVerified(req, res, next) {
  if (!req.user || req.user.verification_status !== 'approved') {
    return fail(res, 403, 'Your identity verification must be approved by an administrator before banking actions are enabled.');
  }
  next();
}

function auth(req, res, next) {
  try {
    const { uid } = jwt.verify(req.cookies.ptb_session || '', JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!user) throw new Error('no user');
    req.user = user;
    req.account = db.prepare("SELECT * FROM accounts WHERE user_id = ? AND kind = 'user'").get(uid);
    next();
  } catch { fail(res, 401, 'Please log in.'); }
}

// Block cross-site form posts: state-changing calls must be JSON.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return fail(res, 415, 'Content-Type must be application/json');
  }
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' } });
const moneyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Slow down. Too many requests.' } });

// ---------- ledger core ----------
const insTx = db.prepare(`INSERT INTO transactions
  (group_id, account_id, type, amount, balance_after, counterparty, note, created_at)
  VALUES (?,?,?,?,?,?,?,?)`);
const adjust = db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?');
const getAcc = db.prepare('SELECT * FROM accounts WHERE id = ?');

// Moves `amount` from one account to another and writes both ledger rows. Call inside db.transaction.
function move({ from, to, amount, typeOut, typeIn, counterOut, counterIn, note }) {
  const src = getAcc.get(from.id);
  if (src.kind === 'user' && src.balance < amount) throw httpErr(422, 'Insufficient balance.');
  const gid = crypto.randomUUID();
  const t = now();
  adjust.run(-amount, from.id);
  adjust.run(amount, to.id);
  const s = getAcc.get(from.id), d = getAcc.get(to.id);
  insTx.run(gid, s.id, typeOut, -amount, s.balance, counterOut, note || null, t);
  insTx.run(gid, d.id, typeIn, amount, d.balance, counterIn, note || null, t);
  return { group_id: gid, balance: s.balance };
}

function verifyPin(user, pin) {
  if (user.pin_locked_until > now()) throw httpErr(429, 'PIN locked for a few minutes after too many wrong attempts.');
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin) || !bcrypt.compareSync(pin, user.pin_hash)) {
    const fails = user.failed_pins + 1;
    const lock = fails >= 5 ? now() + 5 * 60 * 1000 : 0;
    db.prepare('UPDATE users SET failed_pins = ?, pin_locked_until = ? WHERE id = ?').run(lock ? 0 : fails, lock, user.id);
    throw httpErr(403, 'Wrong PIN.');
  }
  if (user.failed_pins) db.prepare('UPDATE users SET failed_pins = 0 WHERE id = ?').run(user.id);
}

function idempotent(req, res, handler) {
  const key = req.get('Idempotency-Key');
  if (key) {
    if (!/^[\w-]{8,64}$/.test(key)) throw httpErr(400, 'Bad Idempotency-Key.');
    const hit = db.prepare('SELECT response FROM idempotency WHERE user_id = ? AND key = ?').get(req.user.id, key);
    if (hit) return res.json(JSON.parse(hit.response));
  }
  const body = handler();
  if (key) db.prepare('INSERT OR IGNORE INTO idempotency (user_id, key, response, created_at) VALUES (?,?,?,?)')
    .run(req.user.id, key, JSON.stringify(body), now());
  res.json(body);
}

const cleanNote = (n) => {
  if (!n) return null;
  if (n.startsWith('acct:')) return n.includes('|') ? n.split('|').slice(1).join('|') : null;
  if (n === 'sandbox') return null;
  return n;
};
const shapeTx = (t) => ({ id: t.id, type: t.type, amount: t.amount, balance_after: t.balance_after,
  counterparty: t.counterparty, note: cleanNote(t.note), created_at: t.created_at });

// ---------- auth routes ----------
app.post('/api/admin/login', authLimiter, wrap((req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || '');
  if (!adminEmail || !adminPassword) throw httpErr(503, 'Admin access is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD.');
  const a = Buffer.from(email), b = Buffer.from(adminEmail);
  const p = Buffer.from(password), q = Buffer.from(adminPassword);
  const emailOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  const passOk = p.length === q.length && crypto.timingSafeEqual(p, q);
  if (!emailOk || !passOk) throw httpErr(401, 'Email or password is incorrect.');
  const token = jwt.sign({ admin: true, email: adminEmail }, JWT_SECRET, { expiresIn: '4h' });
  res.cookie('ptb_admin', token, { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 4 * 3600 * 1000, path: '/api' });
  res.json({ ok: true });
}));
app.post('/api/admin/logout', adminAuth, (req, res) => { res.clearCookie('ptb_admin', { path: '/api' }); res.json({ ok: true }); });
app.get('/api/admin/requests', adminAuth, wrap((req, res) => {
  const rows = db.prepare(`SELECT vr.id, vr.user_id, vr.legal_name, vr.date_of_birth, vr.address, vr.id_type,
    vr.review_status, vr.admin_note, vr.submitted_at, u.email, u.full_name
    FROM verification_requests vr JOIN users u ON u.id = vr.user_id
    WHERE vr.review_status = 'submitted' ORDER BY vr.submitted_at ASC LIMIT 100`).all();
  res.json({ requests: rows });
}));
app.post('/api/admin/requests/:id/review', adminAuth, wrap((req, res) => {
  const id = Number(req.params.id);
  const decision = String((req.body || {}).decision || '');
  const note = String((req.body || {}).note || '').trim().slice(0, 300);
  if (!Number.isSafeInteger(id) || id < 1 || !['approved','rejected'].includes(decision)) throw httpErr(400, 'Invalid review decision.');
  const request = db.prepare('SELECT * FROM verification_requests WHERE id = ?').get(id);
  if (!request || request.review_status !== 'submitted') throw httpErr(404, 'Pending verification request not found.');
  db.transaction(() => {
    db.prepare('UPDATE verification_requests SET review_status = ?, admin_note = ?, reviewed_at = ? WHERE id = ?')
      .run(decision, note || null, now(), id);
    db.prepare('UPDATE users SET verification_status = ? WHERE id = ?').run(decision, request.user_id);
  })();
  res.json({ ok: true, status: decision });
}));

app.post('/api/verification/submit', auth, wrap((req, res) => {
  const b = req.body || {};
  const legalName = String(b.legal_name || '').trim();
  const dob = String(b.date_of_birth || '').trim();
  const address = String(b.address || '').trim();
  const idType = String(b.id_type || '').trim();
  if (legalName.length < 2 || legalName.length > 100) throw httpErr(400, 'Enter your legal name.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob))) throw httpErr(400, 'Enter a valid date of birth.');
  if (address.length < 8 || address.length > 250) throw httpErr(400, 'Enter your residential address.');
  if (!['Passport','Driver license','National identity card','Other government ID'].includes(idType)) throw httpErr(400, 'Choose a valid ID type.');
  const t = now();
  db.transaction(() => {
    db.prepare(`INSERT INTO verification_requests (user_id, legal_name, date_of_birth, address, id_type, review_status, submitted_at)
      VALUES (?,?,?,?,?,'submitted',?)
      ON CONFLICT(user_id) DO UPDATE SET legal_name=excluded.legal_name, date_of_birth=excluded.date_of_birth,
      address=excluded.address, id_type=excluded.id_type, review_status='submitted', admin_note=NULL, submitted_at=excluded.submitted_at, reviewed_at=NULL`)
      .run(req.user.id, legalName, dob, address, idType, t);
    db.prepare("UPDATE users SET verification_status='submitted', verification_submitted_at=? WHERE id=?").run(t, req.user.id);
  })();
  res.json({ ok: true, verification_status: 'submitted' });
}));

app.post('/api/auth/register', authLimiter, wrap((req, res) => {
  const { email, password, full_name, pin } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  const name = String(full_name || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) || em.length > 120) throw httpErr(400, 'Enter a valid email address.');
  if (name.length < 2 || name.length > 80) throw httpErr(400, 'Enter your full name.');
  if (typeof password !== 'string' || password.length < 8 || password.length > 100) throw httpErr(400, 'Password must be at least 8 characters.');
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw httpErr(400, 'Transaction PIN must be 4 digits.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(em)) throw httpErr(409, 'An account with this email already exists.');

  const ph = bcrypt.hashSync(password, 10), pinh = bcrypt.hashSync(pin, 10);
  const userId = db.transaction(() => {
    const u = db.prepare('INSERT INTO users (email, full_name, password_hash, pin_hash, created_at) VALUES (?,?,?,?,?)')
      .run(em, name, ph, pinh, now()).lastInsertRowid;
    const a = db.prepare("INSERT INTO accounts (user_id, account_number, kind) VALUES (?,?, 'user')")
      .run(u, newAccountNumber()).lastInsertRowid;
    const exp = new Date(); exp.setFullYear(exp.getFullYear() + 4);
    db.prepare('INSERT INTO cards (account_id, last4, expiry) VALUES (?,?,?)')
      .run(a, cardNumber(), String(exp.getMonth() + 1).padStart(2, '0') + '/' + String(exp.getFullYear()).slice(2));
    return u;
  })();
  issueSession(res, Number(userId));
  res.status(201).json({ ok: true });
}));

app.post('/api/auth/login', authLimiter, wrap((req, res) => {
  const em = String((req.body || {}).email || '').trim().toLowerCase();
  const password = (req.body || {}).password;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(em);
  const bad = () => httpErr(401, 'Email or password is incorrect.');
  if (!user) { bcrypt.compareSync(String(password || ''), DUMMY_HASH); throw bad(); } // keep timing similar
  if (user.locked_until > now()) throw httpErr(429, 'Account locked for a few minutes after too many failed logins.');
  if (typeof password !== 'string' || !bcrypt.compareSync(password, user.password_hash)) {
    const fails = user.failed_logins + 1;
    const lock = fails >= 5 ? now() + 10 * 60 * 1000 : 0;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : fails, lock, user.id);
    throw bad();
  }
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?').run(user.id);
  issueSession(res, user.id);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => { res.clearCookie('ptb_session', { path: '/' }); res.json({ ok: true }); });

// ---------- banking routes ----------
app.get('/api/me', auth, wrap((req, res) => {
  const card = db.prepare('SELECT last4, expiry, frozen FROM cards WHERE account_id = ?').get(req.account.id);
  res.json({
    name: req.user.full_name, email: req.user.email, verification_status: req.user.verification_status,
    account: { number: req.account.account_number, currency: req.account.currency, balance: req.account.balance },
    card: { last4: card.last4, expiry: card.expiry, frozen: !!card.frozen },
    sandbox_funding: SANDBOX_FUNDING
  });
}));

app.get('/api/transactions', auth, wrap((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const rows = db.prepare('SELECT * FROM transactions WHERE account_id = ? ORDER BY id DESC LIMIT ?').all(req.account.id, limit);
  res.json({ transactions: rows.map(shapeTx) });
}));

// People you have sent money to (most recent first, unique).
app.get('/api/beneficiaries', auth, wrap((req, res) => {
  const rows = db.prepare(`SELECT counterparty, note FROM transactions
    WHERE account_id = ? AND type = 'transfer_out' ORDER BY id DESC LIMIT 60`).all(req.account.id);
  const seen = new Set(), out = [];
  for (const r of rows) {
    const num = String(r.note || '').split('|')[0].replace('acct:', '');
    if (!/^\d{10}$/.test(num) || seen.has(num)) continue;
    seen.add(num); out.push({ name: r.counterparty, account_number: num });
    if (out.length === 5) break;
  }
  res.json({ beneficiaries: out });
}));

// Look up the name behind an account number before sending.
app.get('/api/accounts/lookup/:number', auth, moneyLimiter, wrap((req, res) => {
  const n = String(req.params.number);
  if (!/^\d{10}$/.test(n)) throw httpErr(400, 'Account numbers have 10 digits.');
  const row = db.prepare(`SELECT u.full_name, a.id FROM accounts a JOIN users u ON u.id = a.user_id
    WHERE a.account_number = ? AND a.kind = 'user'`).get(n);
  if (!row) throw httpErr(404, 'No account with that number.');
  if (row.id === req.account.id) throw httpErr(400, 'That is your own account.');
  res.json({ name: row.full_name, account_number: n });
}));

app.post('/api/transfers', auth, requireVerified, moneyLimiter, wrap((req, res) => {
  idempotent(req, res, () => {
    const { to_account, amount, pin, note } = req.body || {};
    const amt = cents(amount);
    if (!amt) throw httpErr(400, 'Enter a valid amount (up to 2 decimals).');
    if (amt > 1000000 * 100) throw httpErr(400, 'Amount is above the single transfer limit.');
    if (!/^\d{10}$/.test(String(to_account))) throw httpErr(400, 'Enter a 10-digit account number.');
    verifyPin(req.user, pin);
    const dest = db.prepare(`SELECT a.*, u.full_name FROM accounts a JOIN users u ON u.id = a.user_id
      WHERE a.account_number = ? AND a.kind = 'user'`).get(String(to_account));
    if (!dest) throw httpErr(404, 'No account with that number.');
    if (dest.id === req.account.id) throw httpErr(400, 'You cannot send money to yourself.');
    const userNote = String(note || '').replace(/[|\r\n]/g, ' ').slice(0, 60);
    const out = db.transaction(() => move({
      from: req.account, to: dest, amount: amt,
      typeOut: 'transfer_out', typeIn: 'transfer_in',
      counterOut: dest.full_name, counterIn: req.user.full_name,
      note: 'acct:' + dest.account_number + (userNote ? '|' + userNote : '')
    }))();
    return { ok: true, to: dest.full_name, balance: out.balance };
  });
}));

const BILLERS = ['Electricity', 'Cable TV', 'Internet', 'Water', 'School fees'];
const NETWORKS = ['MTN', 'Airtel', 'Glo', '9mobile'];

app.post('/api/airtime', auth, requireVerified, moneyLimiter, wrap((req, res) => {
  idempotent(req, res, () => {
    const { network, phone, amount, pin } = req.body || {};
    const amt = cents(amount);
    if (!amt || amt > 500 * 100) throw httpErr(400, 'Airtime must be between 0.01 and 500.');
    if (!NETWORKS.includes(network)) throw httpErr(400, 'Choose a network.');
    if (!/^\+?\d{8,15}$/.test(String(phone || ''))) throw httpErr(400, 'Enter a valid phone number.');
    verifyPin(req.user, pin);
    const sys = db.prepare("SELECT * FROM accounts WHERE account_number = 'SYS-BILLERS'").get();
    const out = db.transaction(() => move({
      from: req.account, to: sys, amount: amt, typeOut: 'airtime', typeIn: 'airtime_in',
      counterOut: network + ' airtime', counterIn: req.user.full_name, note: 'phone:' + phone
    }))();
    return { ok: true, balance: out.balance };
  });
}));

app.post('/api/bills', auth, requireVerified, moneyLimiter, wrap((req, res) => {
  idempotent(req, res, () => {
    const { biller, reference, amount, pin } = req.body || {};
    const amt = cents(amount);
    if (!amt || amt > 50000 * 100) throw httpErr(400, 'Enter a valid amount.');
    if (!BILLERS.includes(biller)) throw httpErr(400, 'Choose a bill type.');
    if (!/^[\w-]{4,30}$/.test(String(reference || ''))) throw httpErr(400, 'Enter the meter, smartcard or account reference.');
    verifyPin(req.user, pin);
    const sys = db.prepare("SELECT * FROM accounts WHERE account_number = 'SYS-BILLERS'").get();
    const out = db.transaction(() => move({
      from: req.account, to: sys, amount: amt, typeOut: 'bill', typeIn: 'bill_in',
      counterOut: biller, counterIn: req.user.full_name, note: 'ref:' + reference
    }))();
    return { ok: true, balance: out.balance };
  });
}));

// Sandbox only: credits play money from a system account. Turn off with ALLOW_SANDBOX_FUNDING=false.
app.post('/api/deposit', auth, requireVerified, moneyLimiter, wrap((req, res) => {
  if (!SANDBOX_FUNDING) throw httpErr(403, 'Funding is disabled.');
  idempotent(req, res, () => {
    const amt = cents((req.body || {}).amount);
    if (!amt || amt > 1000 * 100) throw httpErr(400, 'Sandbox deposits are limited to 1,000 at a time.');
    const sys = db.prepare("SELECT * FROM accounts WHERE account_number = 'SYS-SANDBOX'").get();
    const out = db.transaction(() => {
      const gid = crypto.randomUUID(), t = now();
      adjust.run(-amt, sys.id); adjust.run(amt, req.account.id);
      const a = getAcc.get(req.account.id);
      insTx.run(gid, a.id, 'deposit', amt, a.balance, 'Deposit', 'sandbox', t);
      insTx.run(gid, sys.id, 'deposit_out', -amt, getAcc.get(sys.id).balance, req.user.full_name, 'sandbox', t);
      return a.balance;
    })();
    return { ok: true, balance: out };
  });
}));

app.post('/api/card/freeze', auth, requireVerified, wrap((req, res) => {
  const frozen = (req.body || {}).frozen ? 1 : 0;
  db.prepare('UPDATE cards SET frozen = ? WHERE account_id = ?').run(frozen, req.account.id);
  res.json({ ok: true, frozen: !!frozen });
}));

app.get('/api/meta', (req, res) => res.json({ billers: BILLERS, networks: NETWORKS }));
app.use('/api', (req, res) => fail(res, 404, 'Not found.'));

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: PROD ? '1h' : 0 }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Prime Trust Bank running on http://localhost:${PORT}`));
}
module.exports = app;
