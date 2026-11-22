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
app.use(express.json({ limit: '8mb' }));
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
function auditAdmin(req, action, targetUserId, amount, details) {
  db.prepare('INSERT INTO admin_audit (admin_email, action, target_user_id, amount, details, created_at) VALUES (?,?,?,?,?,?)')
    .run(String(req.admin?.email || 'admin'), action, targetUserId || null, amount == null ? null : amount, details ? String(details).slice(0, 500) : null, now());
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
    if (user.status === 'suspended') return fail(res, 403, 'This account is suspended. Please contact Prime Trust support.');
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
  db.prepare('INSERT INTO admin_audit (admin_email, action, details, created_at) VALUES (?,?,?,?)').run(adminEmail, 'ADMIN_LOGIN', 'Administrator signed in', now());
  res.json({ ok: true });
}));
app.post('/api/admin/logout', adminAuth, (req, res) => { res.clearCookie('ptb_admin', { path: '/api' }); res.json({ ok: true }); });

app.post('/api/admin/impersonate/:id', adminAuth, wrap((req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)throw httpErr(400,'Invalid customer ID.');
  const user=db.prepare('SELECT id,email,full_name,role,status FROM users WHERE id=?').get(id);
  if(!user)throw httpErr(404,'Customer not found.');
  if(user.role==='admin')throw httpErr(400,'You cannot sign in as another administrator.');
  if(user.status==='suspended')throw httpErr(403,'Reactivate this customer before viewing their account.');
  issueSession(res,id);
  const marker=jwt.sign({impersonating:true,adminEmail:req.admin.email,targetId:id},JWT_SECRET,{expiresIn:'4h'});
  res.cookie('ptb_impersonation',marker,{httpOnly:true,sameSite:'strict',secure:PROD,maxAge:4*3600*1000,path:'/'});
  auditAdmin(req,'LOGIN_AS_USER',id,null,'Admin opened customer session: '+user.email);
  res.json({ok:true,user:{id:user.id,email:user.email,full_name:user.full_name}});
}));
app.post('/api/admin/impersonate/return', adminAuth, wrap((req,res)=>{
  const marker=(()=>{try{return jwt.verify(req.cookies.ptb_impersonation||'',JWT_SECRET);}catch{return null;}})();
  if(marker&&marker.impersonating) auditAdmin(req,'RETURN_FROM_USER_SESSION',Number(marker.targetId),null,'Admin returned from customer session');
  res.clearCookie('ptb_session',{path:'/'});
  res.clearCookie('ptb_impersonation',{path:'/'});
  res.json({ok:true});
}));

app.get('/api/admin/requests', adminAuth, wrap((req, res) => {
  const status=String(req.query.status||'submitted');
  const rows = db.prepare(`SELECT vr.id, vr.user_id, vr.legal_name, vr.date_of_birth, vr.address, vr.id_type,
    vr.review_status, vr.admin_note, vr.submitted_at, vr.reviewed_at, u.email, u.full_name
    FROM verification_requests vr JOIN users u ON u.id = vr.user_id
    WHERE (? = 'all' OR vr.review_status = ?) ORDER BY vr.submitted_at DESC LIMIT 200`).all(status,status);
  res.json({ requests: rows });
}));

app.get('/api/admin/requests/:id', adminAuth, wrap((req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw httpErr(400,'Invalid identity request.');
  const request=db.prepare("SELECT id,user_id,id_front_data,id_back_data,selfie_data FROM verification_requests WHERE id=?").get(id);
  if(!request)throw httpErr(404,'Identity request not found.');
  auditAdmin(req,'KYC_DOCUMENTS_VIEWED',request.user_id,null,'Identity document images opened for review');
  res.json({documents:{front:request.id_front_data||null,back:request.id_back_data||null,selfie:request.selfie_data||null}});
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
    auditAdmin(req, decision==='approved'?'KYC_APPROVED':'KYC_REJECTED', request.user_id, null, note || 'Identity review');
  })();
  res.json({ ok: true, status: decision });
}));


/* ---------- non-investment admin console ---------- */
app.get('/api/admin/overview', adminAuth, wrap((req, res) => {
  const users = db.prepare('SELECT COUNT(*) total, SUM(CASE WHEN status = \'active\' THEN 1 ELSE 0 END) active, SUM(CASE WHEN status = \'suspended\' THEN 1 ELSE 0 END) suspended FROM users').get();
  const kyc = db.prepare("SELECT COUNT(*) n FROM verification_requests WHERE review_status = 'submitted'").get().n;
  const tx = db.prepare("SELECT COUNT(*) n FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.kind='user'").get().n;
  const balances = db.prepare("SELECT COALESCE(SUM(balance),0) n FROM accounts WHERE kind='user'").get().n;
  const today = new Date(); today.setHours(0,0,0,0);
  const todayTx = db.prepare("SELECT COUNT(*) n FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.kind='user' AND t.created_at>=?").get(today.getTime()).n;
  const recentUsers = db.prepare("SELECT u.id,u.full_name,u.email,u.status,u.verification_status,u.created_at,a.account_number,a.balance FROM users u JOIN accounts a ON a.user_id=u.id AND a.kind='user' ORDER BY u.created_at DESC LIMIT 6").all();
  const recentTx = db.prepare("SELECT t.id,t.type,t.amount,t.balance_after,t.counterparty,t.note,t.created_at,u.full_name,u.email,a.account_number FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN users u ON u.id=a.user_id WHERE a.kind='user' ORDER BY t.id DESC LIMIT 8").all();
  const openChats = db.prepare("SELECT COUNT(*) n FROM support_sessions WHERE status='open'").get().n;
  res.json({stats:{totalUsers:users.total||0,activeUsers:users.active||0,suspendedUsers:users.suspended||0,pendingKyc:kyc,totalTransactions:tx,totalUserBalances:balances,todayTransactions:todayTx,openChats},recentUsers,recentTransactions:recentTx});
}));
app.get('/api/admin/users', adminAuth, wrap((req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,100), status=String(req.query.status||'all');
  const limit=Math.min(Math.max(Number(req.query.limit)||50,1),100), offset=Math.max(Number(req.query.offset)||0,0);
  let sql="SELECT u.id,u.full_name,u.email,u.status,u.verification_status,u.created_at,a.account_number,a.balance FROM users u JOIN accounts a ON a.user_id=u.id AND a.kind='user' WHERE 1=1", args=[];
  if(status==='active'||status==='suspended'){sql+=" AND u.status=?";args.push(status);}
  if(q){sql+=" AND (LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ? OR a.account_number LIKE ?)";const like='%'+q.toLowerCase()+'%';args.push(like,like,'%'+q+'%');}
  const total=db.prepare("SELECT COUNT(*) n FROM ("+sql+")").get(...args).n;
  const users=db.prepare(sql+" ORDER BY u.created_at DESC LIMIT ? OFFSET ?").all(...args,limit,offset);
  res.json({users,total,limit,offset});
}));
app.get('/api/admin/users/:id', adminAuth, wrap((req,res)=>{
  const id=Number(req.params.id); if(!Number.isSafeInteger(id)||id<1) throw httpErr(400,'Invalid customer ID.');
  const user=db.prepare("SELECT u.id,u.full_name,u.email,u.status,u.verification_status,u.verification_submitted_at,u.created_at,a.id account_id,a.account_number,a.currency,a.balance,c.last4,c.expiry,c.frozen FROM users u JOIN accounts a ON a.user_id=u.id AND a.kind='user' LEFT JOIN cards c ON c.account_id=a.id WHERE u.id=?").get(id);
  if(!user) throw httpErr(404,'Customer not found.');
  const transactions=db.prepare("SELECT id,type,amount,balance_after,counterparty,note,created_at FROM transactions WHERE account_id=? ORDER BY id DESC LIMIT 30").all(user.account_id);
  const verification=db.prepare("SELECT id,legal_name,date_of_birth,address,id_type,review_status,admin_note,submitted_at,reviewed_at FROM verification_requests WHERE user_id=?").get(id)||null;
  const audit=db.prepare("SELECT action,amount,details,created_at FROM admin_audit WHERE target_user_id=? ORDER BY id DESC LIMIT 12").all(id);
  res.json({user,transactions,verification,audit});
}));
app.patch('/api/admin/users/:id', adminAuth, wrap((req,res)=>{
  const id=Number(req.params.id), status=String((req.body||{}).status||'');
  if(!Number.isSafeInteger(id)||id<1||!['active','suspended'].includes(status)) throw httpErr(400,'Choose active or suspended status.');
  const user=db.prepare('SELECT id,status FROM users WHERE id=?').get(id); if(!user) throw httpErr(404,'Customer not found.');
  db.prepare('UPDATE users SET status=? WHERE id=?').run(status,id);
  auditAdmin(req,status==='suspended'?'USER_SUSPENDED':'USER_REACTIVATED',id,null,String((req.body||{}).reason||'Admin status update'));
  res.json({ok:true,status});
}));
app.post('/api/admin/users/:id/adjust-balance', adminAuth, wrap((req,res)=>{
  const id=Number(req.params.id), direction=String((req.body||{}).direction||''), amount=cents((req.body||{}).amount), reason=String((req.body||{}).reason||'').trim();
  if(!Number.isSafeInteger(id)||id<1||!['credit','debit'].includes(direction)||!amount||amount>100000000||reason.length<3||reason.length>240) throw httpErr(400,'Provide a valid adjustment amount and reason.');
  const account=db.prepare("SELECT a.* FROM accounts a WHERE a.user_id=? AND a.kind='user'").get(id);
  if(!account) throw httpErr(404,'Customer account not found.');
  const sys=db.prepare("SELECT * FROM accounts WHERE account_number='SYS-ADMIN-ADJUST'").get();
  const result=db.transaction(()=>{
    const movement=direction==='credit'
      ? move({from:sys,to:account,amount,typeOut:'admin_adjustment_out',typeIn:'admin_credit',counterOut:'Prime Trust Admin',counterIn:'Admin credit',note:'Admin: '+reason})
      : move({from:account,to:sys,amount,typeOut:'admin_debit',typeIn:'admin_adjustment_in',counterOut:'Admin debit',counterIn:'Prime Trust Admin',note:'Admin: '+reason});
    auditAdmin(req,direction==='credit'?'BALANCE_CREDIT':'BALANCE_DEBIT',id,amount,reason);
    return movement;
  })();
  res.json({ok:true,balance:result.balance});
}));

app.patch('/api/admin/users/:id/card', adminAuth, wrap((req,res)=>{
  const id=Number(req.params.id), frozen=(req.body||{}).frozen;
  if(!Number.isSafeInteger(id)||id<1||typeof frozen!=='boolean')throw httpErr(400,'Choose a valid card control.');
  const account=db.prepare("SELECT id FROM accounts WHERE user_id=? AND kind='user'").get(id);
  if(!account)throw httpErr(404,'Customer account not found.');
  const result=db.prepare('UPDATE cards SET frozen=? WHERE account_id=?').run(frozen?1:0,account.id);
  if(!result.changes)throw httpErr(404,'Customer card not found.');
  auditAdmin(req,frozen?'CARD_FROZEN':'CARD_UNFROZEN',id,null,'Admin card control');
  res.json({ok:true,frozen});
}));

app.get('/api/admin/transactions', adminAuth, wrap((req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,100), type=String(req.query.type||'all'), from=Number(req.query.from)||0, to=Number(req.query.to)||0;
  const limit=Math.min(Math.max(Number(req.query.limit)||100,1),250);
  let sql="SELECT t.id,t.group_id,t.type,t.amount,t.balance_after,t.counterparty,t.note,t.created_at,u.id user_id,u.full_name,u.email,a.account_number FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN users u ON u.id=a.user_id WHERE a.kind='user'",args=[];
  if(type!=='all'){sql+=" AND t.type=?";args.push(type);}
  if(from){sql+=" AND t.created_at>=?";args.push(from);}
  if(to){sql+=" AND t.created_at<=?";args.push(to);}
  if(q){sql+=" AND (LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ? OR a.account_number LIKE ? OR CAST(t.id AS TEXT) LIKE ?)";const like='%'+q.toLowerCase()+'%';args.push(like,like,'%'+q+'%','%'+q+'%');}
  const total=db.prepare("SELECT COUNT(*) n FROM ("+sql+")").get(...args).n;
  const transactions=db.prepare(sql+" ORDER BY t.id DESC LIMIT ?").all(...args,limit);
  res.json({transactions,total});
}));
app.get('/api/admin/kyc', adminAuth, wrap((req,res)=>{
  const status=String(req.query.status||'pending');
  const wanted=status==='pending'?'submitted':status;
  if(!['all','submitted','approved','rejected'].includes(wanted)) throw httpErr(400,'Invalid verification status.');
  const rows=db.prepare("SELECT vr.id,vr.user_id,vr.legal_name,vr.date_of_birth,vr.address,vr.id_type,vr.review_status,vr.admin_note,vr.submitted_at,vr.reviewed_at,u.email,u.full_name,a.account_number FROM verification_requests vr JOIN users u ON u.id=vr.user_id LEFT JOIN accounts a ON a.user_id=u.id AND a.kind='user' "+(wanted==='all'?'':"WHERE vr.review_status=?")+" ORDER BY vr.submitted_at DESC LIMIT 200").all(...(wanted==='all'?[]:[wanted]));
  res.json({requests:rows});
}));
app.get('/api/admin/audit', adminAuth, wrap((req,res)=>{
  const limit=Math.min(Math.max(Number(req.query.limit)||100,1),250);
  res.json({events:db.prepare("SELECT id,admin_email,action,target_user_id,amount,details,created_at FROM admin_audit ORDER BY id DESC LIMIT ?").all(limit)});
}));
app.get('/api/admin/chat/sessions', adminAuth, wrap((req,res)=>{
  const sessions=db.prepare("SELECT s.id,s.user_id,s.status,s.created_at,s.updated_at,u.full_name,u.email,a.account_number,(SELECT message FROM support_messages m WHERE m.session_id=s.id ORDER BY m.id DESC LIMIT 1) last_message,(SELECT created_at FROM support_messages m WHERE m.session_id=s.id ORDER BY m.id DESC LIMIT 1) last_message_at,(SELECT COUNT(*) FROM support_messages m WHERE m.session_id=s.id AND m.sender_role='user' AND m.is_read=0) unread_count FROM support_sessions s JOIN users u ON u.id=s.user_id LEFT JOIN accounts a ON a.user_id=u.id AND a.kind='user' ORDER BY s.updated_at DESC LIMIT 100").all();
  res.json({sessions});
}));
app.get('/api/admin/chat/sessions/:id/messages', adminAuth, wrap((req,res)=>{
  const id=Number(req.params.id); if(!Number.isSafeInteger(id)||id<1) throw httpErr(400,'Invalid support session.');
  const session=db.prepare('SELECT id FROM support_sessions WHERE id=?').get(id); if(!session) throw httpErr(404,'Support conversation not found.');
  db.prepare("UPDATE support_messages SET is_read=1 WHERE session_id=? AND sender_role='user'").run(id);
  res.json({messages:db.prepare('SELECT id,session_id,sender_role,sender_name,message,is_read,created_at FROM support_messages WHERE session_id=? ORDER BY id').all(id)});
}));
app.post('/api/admin/chat/sessions/:id/reply', adminAuth, wrap((req,res)=>{
  const id=Number(req.params.id), message=String((req.body||{}).message||'').trim();
  if(!Number.isSafeInteger(id)||id<1||message.length<1||message.length>2000) throw httpErr(400,'Enter a reply of up to 2,000 characters.');
  const session=db.prepare('SELECT * FROM support_sessions WHERE id=?').get(id); if(!session) throw httpErr(404,'Support conversation not found.');
  db.prepare("INSERT INTO support_messages (session_id,sender_role,sender_name,message,created_at) VALUES (?,'admin','Prime Trust Support',?,?)").run(id,message,now());
  db.prepare("UPDATE support_sessions SET status='open',updated_at=? WHERE id=?").run(now(),id);
  res.json({ok:true});
}));
app.patch('/api/admin/chat/sessions/:id/close', adminAuth, wrap((req,res)=>{
  const id=Number(req.params.id); if(!Number.isSafeInteger(id)||id<1) throw httpErr(400,'Invalid support session.');
  const status=(req.body||{}).status==='open'?'open':'closed';
  db.prepare('UPDATE support_sessions SET status=?,updated_at=? WHERE id=?').run(status,now(),id);
  res.json({ok:true,status});
}));
app.get('/api/admin/email/recipients', adminAuth, wrap((req,res)=>{
  res.json({users:db.prepare("SELECT id,full_name,email,status FROM users ORDER BY created_at DESC LIMIT 2000").all().map(u=>({id:u.id,fullName:u.full_name,email:u.email,status:u.status}))});
}));
app.post('/api/admin/email/send', adminAuth, wrap((req,res)=>{
  const b=req.body||{}, audience=String(b.audience||'all'), ids=Array.isArray(b.userIds)?b.userIds.map(Number):[], subject=String(b.subject||'').trim(), message=String(b.message||'').trim();
  if(!['all','active','selected'].includes(audience)||subject.length<2||subject.length>180||message.length<1||message.length>10000) throw httpErr(400,'Choose an audience and provide a subject and message.');
  if(audience==='selected'&&!ids.length) throw httpErr(400,'Select at least one customer.');
  const apiKey=process.env.RESEND_API_KEY, from=process.env.RESEND_FROM_EMAIL||process.env.EMAIL_FROM;
  if(!apiKey||!from) throw httpErr(503,'Email sending is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.');
  let users=db.prepare('SELECT id,full_name,email,status FROM users ORDER BY id').all();
  if(audience==='active') users=users.filter(u=>u.status==='active');
  if(audience==='selected'){const set=new Set(ids);users=users.filter(u=>set.has(u.id));}
  users=users.filter(u=>!!u.email);
  if(!users.length) throw httpErr(400,'No eligible customer email addresses.');
  if(users.length>500) throw httpErr(400,'Audience exceeds 500 recipients; select a smaller batch.');
  const escapeHtml=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const safeMessage=escapeHtml(message).replace(/\r?\n/g,'<br>');
  const results=[]; let sent=0,failed=0;
  for(const user of users){
    try{
      const response=fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({from,to:[user.email],subject,text:'Hello '+user.full_name+',\n\n'+message+'\n\nPrime Trust Bank',html:'<!doctype html><html><body style="font-family:Arial,sans-serif;color:#20162f"><h2>Prime Trust Bank</h2><p>Hello '+escapeHtml(user.full_name)+',</p><div style="line-height:1.7">'+safeMessage+'</div><p>Regards,<br>Prime Trust Bank Support</p></body></html>'})});
      // synchronous endpoint keeps audit and response consistent; fetch is awaited below via async wrapper
      results.push({user,response});
    }catch(_){failed++;results.push({user,error:'Network error'});}
  }
  Promise.all(results.map(async item=>{if(item.error)return item;try{const r=await item.response;if(r.ok){sent++;return item;}failed++;return {user:item.user,error:'Email provider rejected the message (HTTP '+r.status+')'};}catch(_){failed++;return {user:item.user,error:'Network error'};}})).then(done=>{
    const failures=done.filter(x=>x.error).map(x=>({email:x.user.email,error:x.error}));
    auditAdmin(req,'EMAIL_CAMPAIGN',null,null,'audience='+audience+'; sent='+sent+'; failed='+failed);
    res.json({total:users.length,sent,failed,failures});
  }).catch(()=>fail(res,500,'Could not complete email campaign.'));
}));
app.get('/api/support/session', auth, wrap((req,res)=>{
  let session=db.prepare('SELECT * FROM support_sessions WHERE user_id=?').get(req.user.id);
  if(!session){const t=now();const id=db.prepare("INSERT INTO support_sessions (user_id,status,created_at,updated_at) VALUES (?,'open',?,?)").run(req.user.id,t,t).lastInsertRowid;session=db.prepare('SELECT * FROM support_sessions WHERE id=?').get(id);}
  res.json({session});
}));
app.get('/api/support/messages', auth, wrap((req,res)=>{
  let session=db.prepare('SELECT * FROM support_sessions WHERE user_id=?').get(req.user.id);
  if(!session){const t=now();const id=db.prepare("INSERT INTO support_sessions (user_id,status,created_at,updated_at) VALUES (?,'open',?,?)").run(req.user.id,t,t).lastInsertRowid;session=db.prepare('SELECT * FROM support_sessions WHERE id=?').get(id);}
  db.prepare("UPDATE support_messages SET is_read=1 WHERE session_id=? AND sender_role='admin'").run(session.id);
  res.json({session,messages:db.prepare('SELECT id,session_id,sender_role,sender_name,message,is_read,created_at FROM support_messages WHERE session_id=? ORDER BY id').all(session.id)});
}));
app.post('/api/support/messages', auth, wrap((req,res)=>{
  const message=String((req.body||{}).message||'').trim(); if(message.length<1||message.length>2000) throw httpErr(400,'Enter a message up to 2,000 characters.');
  let session=db.prepare('SELECT * FROM support_sessions WHERE user_id=?').get(req.user.id), t=now();
  if(!session){const id=db.prepare("INSERT INTO support_sessions (user_id,status,created_at,updated_at) VALUES (?,'open',?,?)").run(req.user.id,t,t).lastInsertRowid;session=db.prepare('SELECT * FROM support_sessions WHERE id=?').get(id);}
  db.prepare("INSERT INTO support_messages (session_id,sender_role,sender_name,message,created_at) VALUES (?,'user',?,?,?)").run(session.id,req.user.full_name,message,t);
  db.prepare("UPDATE support_sessions SET status='open',updated_at=? WHERE id=?").run(t,session.id);
  res.status(201).json({ok:true});
}));

app.post('/api/verification/submit', auth, wrap((req, res) => {
  const b = req.body || {};
  const legalName = String(b.legal_name || '').trim();
  const dob = String(b.date_of_birth || '').trim();
  const address = String(b.address || '').trim();
  const idType = String(b.id_type || '').trim();
  const front = String(b.id_front || '');
  const back = String(b.id_back || '');
  const selfie = String(b.selfie || '');
  const validImage = value => !value || (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= 1500000);
  if (!front || !validImage(front) || !validImage(back) || !validImage(selfie)) throw httpErr(400, 'Upload a clear front image of your ID. Each image must be a supported photo under 1.5 MB after compression.');
  if (legalName.length < 2 || legalName.length > 100) throw httpErr(400, 'Enter your legal name.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob))) throw httpErr(400, 'Enter a valid date of birth.');
  if (address.length < 8 || address.length > 250) throw httpErr(400, 'Enter your residential address.');
  if (!['Passport','Driver license','National identity card','Other government ID'].includes(idType)) throw httpErr(400, 'Choose a valid ID type.');
  const t = now();
  db.transaction(() => {
    db.prepare(`INSERT INTO verification_requests (user_id, legal_name, date_of_birth, address, id_type, review_status, submitted_at, id_front_data, id_back_data, selfie_data)
      VALUES (?,?,?,?,?,'submitted',?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET legal_name=excluded.legal_name, date_of_birth=excluded.date_of_birth,
      address=excluded.address, id_type=excluded.id_type, id_front_data=excluded.id_front_data, id_back_data=excluded.id_back_data,
      selfie_data=excluded.selfie_data, review_status='submitted', admin_note=NULL, submitted_at=excluded.submitted_at, reviewed_at=NULL`)
      .run(req.user.id, legalName, dob, address, idType, t, front, back || null, selfie || null);
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
  if (user.status === 'suspended') throw httpErr(403, 'This account is suspended. Please contact Prime Trust support.');
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?').run(user.id);
  issueSession(res, user.id);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => { res.clearCookie('ptb_session', { path: '/' }); res.json({ ok: true }); });

// ---------- banking routes ----------

app.get('/api/impersonation/status', auth, wrap((req,res)=>{
  try{
    const marker=jwt.verify(req.cookies.ptb_impersonation||'',JWT_SECRET);
    if(marker.impersonating&&Number(marker.targetId)===req.user.id) return res.json({active:true,admin_email:marker.adminEmail});
  }catch{}
  res.json({active:false});
}));

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
