const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const kyc = require('./kyc');

const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const ADMIN_PORTAL_PATH = String(process.env.ADMIN_PORTAL_PATH || '').trim();
const ADMIN_PORTAL_PATH_VALID = /^\/[a-z0-9-]{24,80}$/i.test(ADMIN_PORTAL_PATH) && !ADMIN_PORTAL_PATH.includes('..');
const SANDBOX_FUNDING = process.env.NODE_ENV === 'test' || process.env.ALLOW_SANDBOX_FUNDING !== 'false';
const SESSION_HOURS = 8;
const ADMIN_SESSION_HOURS = 4;

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (PROD) { console.error('JWT_SECRET must be set in production'); process.exit(1); }
  JWT_SECRET = crypto.randomBytes(32).toString('hex'); // development only
}
if (PROD && Buffer.byteLength(JWT_SECRET) < 32) {
  console.error('JWT_SECRET must contain at least 32 bytes in production');
  process.exit(1);
}

const LEGACY_KYC_KEY = crypto.createHash('sha256').update('prime-trust-kyc-v1:' + JWT_SECRET).digest();
const HAS_KYC_ENCRYPTION_KEY = !!process.env.KYC_ENCRYPTION_KEY;
const KYC_ENCRYPTION_KEY = HAS_KYC_ENCRYPTION_KEY
  ? (/^[a-f0-9]{64}$/i.test(process.env.KYC_ENCRYPTION_KEY) ? Buffer.from(process.env.KYC_ENCRYPTION_KEY, 'hex') : null)
  : LEGACY_KYC_KEY;
if (!KYC_ENCRYPTION_KEY) {
  console.error('KYC_ENCRYPTION_KEY must be 64 hexadecimal characters');
  process.exit(1);
}
async function sendTransactionalEmail(to,subject,textBody,htmlBody){
  const apiKey=process.env.RESEND_API_KEY,from=process.env.RESEND_FROM_EMAIL||process.env.EMAIL_FROM,replyTo=process.env.RESEND_REPLY_TO||'reply@primetrustdigital.org';
  if(!apiKey||!from)throw httpErr(503,'Secure email delivery is not configured.');
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({from,reply_to:[replyTo],to:[to],subject,text:textBody,html:htmlBody})});
  if(!response.ok)throw httpErr(502,'Could not send the security email. Try again later.');
}
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const app = express();
app.set('trust proxy', 1); // Railway's single trusted edge proxy
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
app.use((req, res, next) => { db.ready.then(() => next(), next); });
app.use(express.json({ limit: '5mb', strict: true, verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(cookieParser());
app.use('/api', (req,res,next)=>{ res.set('Cache-Control','no-store, private'); res.set('Pragma','no-cache'); next(); });

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
  const handle = (e) => {
    if (res.headersSent) return;
    if (e && e.status) return fail(res, e.status, e.message);
    console.error(e); fail(res, 500, 'Something went wrong. Please try again.');
  };
  try { Promise.resolve(fn(req, res)).catch(handle); } catch (e) { handle(e); }
};
const httpErr = (status, message) => Object.assign(new Error(message), { status });
function verifyResendWebhook(req) {
  const secret=String(process.env.RESEND_WEBHOOK_SECRET||'');
  if(!secret||!req.rawBody) return false;
  const id=String(req.get('svix-id')||''), timestamp=String(req.get('svix-timestamp')||''), signature=String(req.get('svix-signature')||'');
  if(!id||!timestamp||!signature||!/^\d+$/.test(timestamp)) return false;
  const ts=Number(timestamp); if(!Number.isFinite(ts)||Math.abs(Date.now()/1000-ts)>300) return false;
  let key; try { key=Buffer.from(secret.replace(/^whsec_/,''),'base64'); } catch { return false; }
  const expected=crypto.createHmac('sha256',key).update(id+'.'+timestamp+'.').update(req.rawBody).digest('base64');
  return signature.split(' ').some(part=>{const m=part.match(/^v1,([A-Za-z0-9+/=]+)$/);if(!m)return false;const a=Buffer.from(m[1]),b=Buffer.from(expected);return a.length===b.length&&crypto.timingSafeEqual(a,b);});
}
function plainEmailBody(value) {
  return String(value||'').replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,' ')
    .replace(/<\/p\s*>|<\/div\s*>|<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&#39;/gi,"'").replace(/&quot;/gi,'"').replace(/[\t ]+/g,' ').replace(/\n[ \t]+/g,'\n').trim().slice(0,10000);
}
function emailAddress(value) {
  const s=String(value||''); const m=s.match(/<([^<>\s]+@[^<>\s]+)>/)||s.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  return m?m[1].toLowerCase():'';
}
async function sendSupportEmail(to,sessionId,subject,message) {
  const apiKey=process.env.RESEND_API_KEY,from=process.env.RESEND_FROM_EMAIL||process.env.EMAIL_FROM;
  if(!apiKey||!from)throw httpErr(503,'Support email delivery is not configured.');
  const safe=String(message).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])).replace(/\r?\n/g,'<br>');
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({
    from,reply_to:['support@primetrustdigital.org'],to:[to],subject:'Re: [PT Support #'+sessionId+'] '+String(subject||'Support request').replace(/^\s*\[PT Support #\d+\]\s*/i,'').slice(0,150),
    text:String(message)+'\n\nPrime Trust Digital Support\nReference: PT Support #'+sessionId,
    html:'<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.65;color:#18323a"><h2>Prime Trust Digital Support</h2><p>'+safe+'</p><p style="color:#647a80">Reply to this email to continue your support conversation.<br>Reference: PT Support #'+sessionId+'</p></body></html>'
  })});
  if(!response.ok)throw httpErr(502,'The reply was saved in chat, but email delivery failed.');
  return (await response.json()).id||null;
}
app.post('/api/webhooks/resend/inbound-support',wrap(async(req,res)=>{
  if(!verifyResendWebhook(req))return fail(res,401,'Invalid webhook signature.');
  const event=req.body||{},type=String(event.type||''),data=event.data||{};
  if(!['email.received','inbox.email.received'].includes(type))return res.status(200).json({ok:true,ignored:true});
  const emailId=String(data.email_id||data.emailId||'');
  let email=type==='inbox.email.received'?(data.email||data):data;
  if(emailId&&(!email.text&&!email.html&&!email.body)){
    const apiKey=process.env.RESEND_API_KEY;if(!apiKey)return fail(res,503,'Email receiving is not configured.');
    const endpoint=type==='email.received'?'https://api.resend.com/emails/receiving/'+encodeURIComponent(emailId):'https://api.resend.com/inboxes/'+encodeURIComponent(data.inbox_id||data.inboxId||'')+'/threads/'+encodeURIComponent(data.thread_id||data.threadId||'')+'/emails/'+encodeURIComponent(emailId);
    const response=await fetch(endpoint,{headers:{Authorization:'Bearer '+apiKey}});
    if(!response.ok)throw httpErr(502,'Could not retrieve the received support email.');
    const received=await response.json();email=received.data||received;
  }
  const from=email.from||data.from||'', sender=emailAddress(from);
  const to=Array.isArray(email.to)?email.to.join(','):String(email.to||data.to||((data.inbox_id||data.inboxId)===process.env.RESEND_SUPPORT_INBOX_ID?'support@primetrustdigital.org':''));
  if(!sender||!to.toLowerCase().includes('support@primetrustdigital.org'))return res.status(200).json({ok:true,ignored:true});
  const headers=email.headers||data.headers||{}, header=(name)=>{if(Array.isArray(headers)){const h=headers.find(x=>String(x.name||x.key||'').toLowerCase()===name.toLowerCase());return h?String(h.value||''):'';}return String(headers[name]||headers[name.toLowerCase()]||'');};
  const messageId=header('message-id')||header('Message-ID')||String(email.message_id||data.message_id||'');
  const subject=String(email.subject||data.subject||'Support request').slice(0,180);
  const text=plainEmailBody(email.text||email.body||email.html||data.text||data.html||'');
  if(!text)return res.status(200).json({ok:true,ignored:true});
  if(messageId&&await db.get('SELECT id FROM support_messages WHERE provider_message_id=?',[messageId]))return res.status(200).json({ok:true,duplicate:true});
  const ticket=(subject.match(/\[PT Support #(\d+)\]/i)||[])[1], ticketId=ticket?Number(ticket):0;
  let session=ticketId?await db.get('SELECT * FROM support_sessions WHERE id=?',[ticketId]):null;
  if(session&&session.contact_email&&session.contact_email.toLowerCase()!==sender)session=null;
  const user=await db.get('SELECT id,full_name,email FROM users WHERE lower(email)=?',[sender]);
  if(!session&&user)session=await db.get('SELECT * FROM support_sessions WHERE user_id=?',[user.id]);
  if(!session)session=await db.get("SELECT * FROM support_sessions WHERE lower(contact_email)=? AND status='open' ORDER BY updated_at DESC LIMIT 1",[sender]);
  const t=now();
  if(!session){
    const result=await db.run("INSERT INTO support_sessions (user_id,contact_email,contact_name,status,created_at,updated_at) VALUES (?,?,?,'open',?,?)",[user?user.id:null,sender,String(from).replace(/<[^>]+>/g,'').trim().slice(0,100)||sender,t,t]);
    session=await db.get('SELECT * FROM support_sessions WHERE id=?',[result.lastInsertRowid]);
  }else{
    await db.run("UPDATE support_sessions SET status='open',updated_at=?,contact_email=COALESCE(contact_email,?),contact_name=COALESCE(contact_name,?) WHERE id=?",[t,sender,user?user.full_name:String(from).replace(/<[^>]+>/g,'').trim().slice(0,100),session.id]);
  }
  await db.run("INSERT INTO support_messages (session_id,sender_role,sender_name,message,is_read,provider_message_id,created_at) VALUES (?,'user',?,?,0,?,?) ON CONFLICT DO NOTHING",[session.id,user?user.full_name:String(from).replace(/<[^>]+>/g,'').trim().slice(0,100)||sender,text,messageId||null,t]);
  await db.run('UPDATE support_sessions SET updated_at=?,status=\'open\' WHERE id=?',[t,session.id]);
  res.status(200).json({ok:true,sessionId:session.id});
}));


async function newAccountNumber() {
  for (;;) {
    const n = String(crypto.randomInt(1000000000, 9999999999));
    if (!(await db.get('SELECT 1 FROM accounts WHERE account_number = ?', [n]))) return n;
  }
}
function cardNumber() { return String(crypto.randomInt(1000, 9999)); }
function demoCardNumber(){const base='400000'+String(crypto.randomInt(100000000,999999999));let sum=0,alt=true;for(let i=base.length-1;i>=0;i--){let n=Number(base[i]);if(alt){n*=2;if(n>9)n-=9;}sum+=n;alt=!alt;}return base+String((10-(sum%10))%10);}


async function issueSession(res, userId, req) {
  const row = (await db.get('SELECT session_version FROM users WHERE id = ?', [userId]));
  if (!row) throw httpErr(404, 'Customer account not found.');
  const jti=crypto.randomUUID(),created=now(),expires=created+SESSION_HOURS*3600*1000;
  (await db.run('INSERT INTO user_sessions (jti,user_id,user_agent,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?)', [jti,userId,String(req&&req.get('user-agent')||'').slice(0,300),created,created,expires]));
  const token = jwt.sign({ uid: userId, sv: row.session_version || 0, jti }, JWT_SECRET, { expiresIn: SESSION_HOURS + 'h' });
  res.cookie('ptb_session', token, {
    httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: SESSION_HOURS * 3600 * 1000, path: '/'
  });
}

async function adminAuth(req, res, next) {
  try {
    const payload = jwt.verify(req.cookies.ptb_admin || '', JWT_SECRET);
    if (payload.admin !== true || !payload.jti) throw new Error('not admin');
    const session = (await db.get('SELECT admin_email, expires_at, revoked_at FROM admin_sessions WHERE jti = ?', [payload.jti]));
    if (!session || session.revoked_at || session.expires_at <= now() || session.admin_email !== payload.email) throw new Error('admin session revoked');
    req.admin = payload;
    next();
  } catch { fail(res, 401, 'Administrator sign-in required.'); }
}
function sealKyc(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', KYC_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return (HAS_KYC_ENCRYPTION_KEY ? 'enc:v2:' : 'enc:v1:') + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
function unsealKyc(value) {
  if (!value) return null;
  if (!value.startsWith('enc:v1:') && !value.startsWith('enc:v2:')) return value; // legacy plaintext is encrypted when an admin first reviews it
  const version = value.slice(0, 7);
  const packed = Buffer.from(value.slice(7), 'base64');
  if (packed.length < 29) throw httpErr(500, 'Stored identity document is corrupted.');
  const iv = packed.subarray(0, 12), tag = packed.subarray(12, 28), data = packed.subarray(28);
  const key = version === 'enc:v2:' ? KYC_ENCRYPTION_KEY : LEGACY_KYC_KEY;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
async function auditAdmin(req, action, targetUserId, amount, details) {
  (await db.run('INSERT INTO admin_audit (admin_email, action, target_user_id, amount, details, created_at) VALUES (?,?,?,?,?,?)', [String(req.admin?.email || 'admin'), action, targetUserId || null, amount == null ? null : amount, details ? String(details).slice(0, 500) : null, now()]));
}
function requireVerified(req, res, next) {
  if (!req.user || req.user.verification_status !== 'approved') {
    return fail(res, 403, 'Your identity verification must be approved by an administrator before banking actions are enabled.');
  }
  next();
}

async function auth(req, res, next) {
  try {
    const payload = jwt.verify(req.cookies.ptb_session || '', JWT_SECRET);
    const { uid, sv, jti } = payload;
    const user = (await db.get('SELECT * FROM users WHERE id = ?', [uid]));
    if (!user || Number(sv || 0) !== Number(user.session_version || 0)) throw new Error('session revoked');
    if(jti){
      const session=(await db.get('SELECT user_id,expires_at,revoked_at,last_seen_at FROM user_sessions WHERE jti=?', [jti]));
      if(!session||session.user_id!==uid||session.revoked_at||session.expires_at<=now())throw new Error('session revoked');
      if(session.last_seen_at<now()-300000)(await db.run('UPDATE user_sessions SET last_seen_at=? WHERE jti=?', [now(),jti]));
      req.sessionJti=jti;
    }
    if (user.status === 'suspended') return fail(res, 403, 'This account is suspended. Please contact Prime Trust support.');
    req.user = user;
    req.account = (await db.get("SELECT * FROM accounts WHERE user_id = ? AND kind = 'user'", [uid]));
    next();
  } catch { fail(res, 401, 'Please log in.'); }
}

// Defense-in-depth CSRF protection: same-origin browser requests only, plus JSON-only writes.
app.use('/api', (req, res, next) => {
  if (req.path === '/webhooks/resend/inbound-support') return next();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('Origin');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host') || (PROD && new URL(origin).protocol !== 'https:')) return fail(res, 403, 'Cross-origin request blocked.'); }
      catch { return fail(res, 403, 'Invalid request origin.'); }
    } else if (req.get('Sec-Fetch-Site') === 'cross-site') return fail(res, 403, 'Cross-site request blocked.');
    if (!req.is('application/json')) return fail(res, 415, 'Content-Type must be application/json');
  }
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' } });
const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true,
  message: { error: 'Too many administrator sign-in attempts. Try again later.' } });
const adminApiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Administrator request limit reached. Slow down.' } });
app.use('/api/admin', adminApiLimiter);
const sensitiveWriteLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please wait before trying again.' } });
const moneyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Slow down. Too many requests.' } });

// ---------- ledger core ----------




// Moves `amount` from one account to another and writes both ledger rows. Call inside db.transaction.
async function move({ from, to, amount, typeOut, typeIn, counterOut, counterIn, note }) {
  for (const lockId of [from.id, to.id].sort((x, y) => x - y)) await db.get('SELECT id FROM accounts WHERE id = ? FOR UPDATE', [lockId]);
  const src = (await db.get('SELECT * FROM accounts WHERE id = ?', [from.id]));
  if (src.kind === 'user' && src.balance < amount) throw httpErr(422, 'Insufficient balance.');
  const gid = crypto.randomUUID();
  const t = now();
  (await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [-amount, from.id]));
  (await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [amount, to.id]));
  const s = (await db.get('SELECT * FROM accounts WHERE id = ?', [from.id])), d = (await db.get('SELECT * FROM accounts WHERE id = ?', [to.id]));
  (await db.run(`INSERT INTO transactions
  (group_id, account_id, type, amount, balance_after, counterparty, note, created_at)
  VALUES (?,?,?,?,?,?,?,?)`, [gid, s.id, typeOut, -amount, s.balance, counterOut, note || null, t]));
  (await db.run(`INSERT INTO transactions
  (group_id, account_id, type, amount, balance_after, counterparty, note, created_at)
  VALUES (?,?,?,?,?,?,?,?)`, [gid, d.id, typeIn, amount, d.balance, counterIn, note || null, t]));
  const fromOwner=(await db.get('SELECT user_id FROM accounts WHERE id=?', [s.id])).user_id;
  const toOwner=(await db.get('SELECT user_id FROM accounts WHERE id=?', [d.id])).user_id;
  if(fromOwner){
    const title=typeOut==='airtime'?'Airtime purchased':typeOut==='bill'?'Bill payment sent':typeOut==='external_transfer_pending'?'External transfer requested':'Transfer sent';
    const message=typeOut==='airtime'?'Your airtime purchase of USD '+(amount/100).toFixed(2)+' was completed.':typeOut==='bill'?'Your bill payment of USD '+(amount/100).toFixed(2)+' was submitted.':typeOut==='external_transfer_pending'?'Your external transfer request for USD '+(amount/100).toFixed(2)+' was submitted. Funds are reserved while an administrator processes it.':'A transfer of USD '+(amount/100).toFixed(2)+' was sent.';
    await notifyUser(fromOwner,title,message,typeOut==='transfer_out'?'transfer':typeOut==='external_transfer_pending'?'transfer':'payment');
  }
  if(toOwner)await notifyUser(toOwner,'Money received','You received USD '+(amount/100).toFixed(2)+'.','transfer');
  return { group_id: gid, balance: s.balance };
}

async function verifyPin(user, pin) {
  if (user.pin_locked_until > now()) throw httpErr(429, 'PIN locked for a few minutes after too many wrong attempts.');
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin) || !bcrypt.compareSync(pin, user.pin_hash)) {
    const fails = user.failed_pins + 1;
    const lock = fails >= 5 ? now() + 5 * 60 * 1000 : 0;
    const record = () => db.run('UPDATE users SET failed_pins = ?, pin_locked_until = ? WHERE id = ?', [lock ? 0 : fails, lock, user.id]);
    const wrong = httpErr(403, 'Wrong PIN.');
    if (db.inTx()) { wrong.afterRollback = record; throw wrong; }
    await record();
    throw wrong;
  }
  if (user.failed_pins) (await db.run('UPDATE users SET failed_pins = 0 WHERE id = ?', [user.id]));
}

async function idempotent(req, res, handler) {
  const key = req.get('Idempotency-Key');
  if (key && !/^[\w-]{8,64}$/.test(key)) throw httpErr(400, 'Bad Idempotency-Key.');
  const body = await db.tx(async () => {
    if (key) {
      await db.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [req.user.id + ':' + key]);
      const hit = await db.get('SELECT response FROM idempotency WHERE user_id = ? AND key = ?', [req.user.id, key]);
      if (hit) return JSON.parse(hit.response);
    }
    const out = await handler();
    if (key) await db.run('INSERT OR IGNORE INTO idempotency (user_id, key, response, created_at) VALUES (?,?,?,?)', [req.user.id, key, JSON.stringify(out), now()]);
    return out;
  });
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
app.post('/api/admin/login', adminLoginLimiter, wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || '');
  const adminPasswordHash = String(process.env.ADMIN_PASSWORD_HASH || '');
  if (!adminEmail || (!adminPassword && !adminPasswordHash)) throw httpErr(503, 'Admin access is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD_HASH.');
  if (!adminPasswordHash && adminPassword.length < 14) throw httpErr(503, 'Administrator password must be at least 14 characters; configure ADMIN_PASSWORD_HASH for a bcrypt hash.');
  const a = Buffer.from(email), b = Buffer.from(adminEmail);
  const p = Buffer.from(password), q = Buffer.from(adminPassword);
  const emailOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  let passOk = false;
  if (adminPasswordHash && /^\$2[aby]\$\d\d\$/.test(adminPasswordHash)) {
    try { passOk = bcrypt.compareSync(password, adminPasswordHash); } catch { passOk = false; }
  } else {
    passOk = p.length === q.length && q.length > 0 && crypto.timingSafeEqual(p, q);
  }
  if (!emailOk || !passOk) throw httpErr(401, 'Email or password is incorrect.');
  const jti = crypto.randomUUID(), created = now(), expires = created + ADMIN_SESSION_HOURS * 3600 * 1000;
  (await db.run('INSERT INTO admin_sessions (jti,admin_email,created_at,expires_at) VALUES (?,?,?,?)', [jti,adminEmail,created,expires]));
  const token = jwt.sign({ admin: true, email: adminEmail, jti }, JWT_SECRET, { expiresIn: ADMIN_SESSION_HOURS + 'h' });
  res.cookie('ptb_admin', token, { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: ADMIN_SESSION_HOURS * 3600 * 1000, path: '/api' });
  (await db.run('INSERT INTO admin_audit (admin_email, action, details, created_at) VALUES (?,?,?,?)', [adminEmail, 'ADMIN_LOGIN', 'Administrator signed in', now()]));
  res.json({ ok: true });
}));
app.post('/api/admin/logout', adminAuth, wrap(async (req, res) => { (await db.run('UPDATE admin_sessions SET revoked_at=? WHERE jti=? AND revoked_at IS NULL', [now(),req.admin.jti])); await auditAdmin(req,'ADMIN_LOGOUT',null,null,'Administrator signed out'); res.clearCookie('ptb_admin', { path: '/api' }); res.json({ ok: true }); }));

app.post('/api/admin/impersonate/:id', adminAuth, wrap(async (req,res)=>{
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw httpErr(400, 'Invalid customer ID.');
  const user = (await db.get('SELECT id,email,full_name,status FROM users WHERE id=?', [id]));
  if (!user) throw httpErr(404, 'Customer not found.');
  const configuredAdminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (user.email.toLowerCase() === configuredAdminEmail) throw httpErr(400, 'You cannot sign in as an administrator.');
  if (user.status === 'suspended') throw httpErr(403, 'Reactivate this customer before viewing their account.');

  await issueSession(res, id, req);
  const marker = jwt.sign({
    impersonating: true,
    adminEmail: req.admin.email,
    adminJti: req.admin.jti,
    targetId: id
  }, JWT_SECRET, { expiresIn: '4h' });
  res.cookie('ptb_impersonation', marker, {
    httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 4 * 3600 * 1000, path: '/'
  });
  await auditAdmin(req, 'LOGIN_AS_USER', id, null, 'Admin opened customer session: ' + user.email);
  res.json({ ok: true, user: { id: user.id, email: user.email, full_name: user.full_name } });
}));

app.post('/api/admin/impersonate-return', adminAuth, wrap(async (req,res)=>{
  let marker = null;
  try { marker = jwt.verify(req.cookies.ptb_impersonation || '', JWT_SECRET); } catch {}
  if (!marker || !marker.impersonating || marker.adminJti !== req.admin.jti || marker.adminEmail !== req.admin.email) {
    throw httpErr(403, 'This administrator session cannot return from the current customer view.');
  }
  await auditAdmin(req, 'RETURN_FROM_USER_SESSION', Number(marker.targetId), null, 'Admin returned from customer session');
  try{const customer=jwt.verify(req.cookies.ptb_session||'',JWT_SECRET);if(customer.jti)(await db.run('UPDATE user_sessions SET revoked_at=? WHERE jti=? AND revoked_at IS NULL', [now(),customer.jti]));}catch{}
  res.clearCookie('ptb_session', { path: '/' });
  res.clearCookie('ptb_impersonation', { path: '/' });
  res.json({ ok: true });
}));

app.get('/api/admin/overview', adminAuth, wrap(async (req, res) => {
  const users = (await db.get('SELECT COUNT(*) total, SUM(CASE WHEN status = \'active\' THEN 1 ELSE 0 END) active, SUM(CASE WHEN status = \'suspended\' THEN 1 ELSE 0 END) suspended FROM users', []));
  const kyc = (await db.get("SELECT COUNT(*) n FROM verification_requests WHERE review_status = 'submitted'", [])).n;
  const tx = (await db.get("SELECT COUNT(*) n FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.kind='user'", [])).n;
  const balances = (await db.get("SELECT COALESCE(SUM(balance),0) n FROM accounts WHERE kind='user'", [])).n;
  const today = new Date(); today.setHours(0,0,0,0);
  const todayTx = (await db.get("SELECT COUNT(*) n FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.kind='user' AND t.created_at>=?", [today.getTime()])).n;
  const recentUsers = (await db.all("SELECT u.id,u.full_name,u.email,u.status,u.verification_status,u.created_at,a.account_number,a.balance FROM users u JOIN accounts a ON a.user_id=u.id AND a.kind='user' ORDER BY u.created_at DESC LIMIT 6", []));
  const recentTx = (await db.all("SELECT t.id,t.type,t.amount,t.balance_after,t.counterparty,t.note,t.created_at,u.full_name,u.email,a.account_number FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN users u ON u.id=a.user_id WHERE a.kind='user' ORDER BY t.id DESC LIMIT 8", []));
  const openChats = (await db.get("SELECT COUNT(*) n FROM support_sessions WHERE status='open'", [])).n;
  res.json({stats:{totalUsers:users.total||0,activeUsers:users.active||0,suspendedUsers:users.suspended||0,pendingKyc:kyc,totalTransactions:tx,totalUserBalances:balances,todayTransactions:todayTx,openChats},recentUsers,recentTransactions:recentTx});
}));
app.get('/api/admin/card-settings',adminAuth,wrap(async(req,res)=>{
 const s=await db.get('SELECT physical_card_fee_cents FROM card_product_settings WHERE id=1');
 res.json({physical_card_fee_cents:s?s.physical_card_fee_cents:2500});
}));
app.patch('/api/admin/card-settings',adminAuth,wrap(async(req,res)=>{
 const fee=Number((req.body||{}).physical_card_fee_cents);
 if(!Number.isSafeInteger(fee)||fee<0||fee>50000)throw httpErr(400,'Physical card fee must be between USD 0 and USD 500.00.');
 await db.run('INSERT INTO card_product_settings (id,physical_card_fee_cents,updated_at,updated_by) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET physical_card_fee_cents=excluded.physical_card_fee_cents,updated_at=excluded.updated_at,updated_by=excluded.updated_by',[fee,now(),String(req.admin.email||'admin')]);
 await auditAdmin(req,'PHYSICAL_CARD_FEE_UPDATED',null,fee,'Physical card fee changed');
 res.json({ok:true,physical_card_fee_cents:fee});
}));
app.get('/api/admin/card-requests', adminAuth, wrap(async (req,res)=>{
  const status=String(req.query.status||'pending');
  if(status!=='pending')throw httpErr(400,'Only pending card requests can be reviewed here.');
  const requests=await db.all("SELECT cr.user_id,cr.status,cr.card_tier,cr.physical_requested,cr.physical_fee_cents,cr.requested_at,u.full_name,u.email,a.account_number FROM card_requests cr JOIN users u ON u.id=cr.user_id LEFT JOIN accounts a ON a.user_id=u.id AND a.kind='user' WHERE cr.status='pending' ORDER BY cr.requested_at ASC LIMIT 200", []);
  const pending=(await db.get("SELECT COUNT(*) n FROM card_requests WHERE status='pending'", [])).n;
  const setting=await db.get('SELECT physical_card_fee_cents FROM card_product_settings WHERE id=1');
  res.json({requests,pending,physical_fee_cents:setting?setting.physical_card_fee_cents:2500});
}));
app.get('/api/admin/users', adminAuth, wrap(async (req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,100), status=String(req.query.status||'all');
  const limit=Math.min(Math.max(Number(req.query.limit)||50,1),100), offset=Math.max(Number(req.query.offset)||0,0);
  let sql="SELECT u.id,u.full_name,u.email,u.status,u.verification_status,u.created_at,a.account_number,a.balance FROM users u JOIN accounts a ON a.user_id=u.id AND a.kind='user' WHERE 1=1", args=[];
  if(status==='active'||status==='suspended'){sql+=" AND u.status=?";args.push(status);}
  if(q){sql+=" AND (LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ? OR a.account_number LIKE ?)";const like='%'+q.toLowerCase()+'%';args.push(like,like,'%'+q+'%');}
  const total=(await db.get("SELECT COUNT(*) n FROM ("+sql+") q", [...args])).n;
  const users=(await db.all(sql+" ORDER BY u.created_at DESC LIMIT ? OFFSET ?", [...args,limit,offset]));
  res.json({users,total,limit,offset});
}));
app.get('/api/admin/users/:id', adminAuth, wrap(async (req,res)=>{
  const id=Number(req.params.id); if(!Number.isSafeInteger(id)||id<1) throw httpErr(400,'Invalid customer ID.');
  const user=(await db.get("SELECT u.id,u.full_name,u.email,u.status,u.verification_status,u.verification_submitted_at,u.created_at,a.id account_id,a.account_number,a.currency,a.balance,c.last4,c.expiry,c.frozen,c.demo_number,c.demo_cvv,c.card_tier,c.physical_requested,c.physical_status,c.revoked FROM users u JOIN accounts a ON a.user_id=u.id AND a.kind='user' LEFT JOIN cards c ON c.account_id=a.id WHERE u.id=?", [id]));
  const cardRequest=(await db.get('SELECT status,requested_at,reviewed_at,reviewed_by FROM card_requests WHERE user_id=?', [id]))||null;
  if(!user) throw httpErr(404,'Customer not found.');
  const transactions=(await db.all("SELECT id,type,amount,balance_after,counterparty,note,created_at FROM transactions WHERE account_id=? ORDER BY id DESC LIMIT 30", [user.account_id]));
  const verification=(await db.get("SELECT id,legal_name,date_of_birth,address,id_type,review_status,admin_note,submitted_at,reviewed_at FROM verification_requests WHERE user_id=?", [id]))||null;
  const audit=(await db.all("SELECT action,amount,details,created_at FROM admin_audit WHERE target_user_id=? ORDER BY id DESC LIMIT 12", [id]));
  res.json({user,cardRequest,transactions,verification,audit});
}));
app.patch('/api/admin/users/:id', adminAuth, wrap(async (req,res)=>{
  const id=Number(req.params.id), status=String((req.body||{}).status||'');
  if(!Number.isSafeInteger(id)||id<1||!['active','suspended'].includes(status)) throw httpErr(400,'Choose active or suspended status.');
  const user=(await db.get('SELECT id,status FROM users WHERE id=?', [id])); if(!user) throw httpErr(404,'Customer not found.');
  (await db.run('UPDATE users SET status=? WHERE id=?', [status,id]));
  await auditAdmin(req,status==='suspended'?'USER_SUSPENDED':'USER_REACTIVATED',id,null,String((req.body||{}).reason||'Admin status update'));
  res.json({ok:true,status});
}));
app.post('/api/admin/users/:id/adjust-balance', adminAuth, wrap(async (req,res)=>{
  const id=Number(req.params.id), direction=String((req.body||{}).direction||''), amount=cents((req.body||{}).amount), reason=String((req.body||{}).reason||'').trim();
  if(!Number.isSafeInteger(id)||id<1||!['credit','debit'].includes(direction)||!amount||amount>100000000||reason.length<3||reason.length>240) throw httpErr(400,'Provide a valid adjustment amount and reason.');
  const account=(await db.get("SELECT a.* FROM accounts a WHERE a.user_id=? AND a.kind='user'", [id]));
  if(!account) throw httpErr(404,'Customer account not found.');
  const sys=(await db.get("SELECT * FROM accounts WHERE account_number='SYS-ADMIN-ADJUST'", []));
  const result=(await db.tx(async ()=>{
    const movement=direction==='credit'
      ? (await move({from:sys,to:account,amount,typeOut:'admin_adjustment_out',typeIn:'admin_credit',counterOut:'Prime Trust Admin',counterIn:'Admin credit',note:'Admin: '+reason}))
      : (await move({from:account,to:sys,amount,typeOut:'admin_debit',typeIn:'admin_adjustment_in',counterOut:'Admin debit',counterIn:'Prime Trust Admin',note:'Admin: '+reason}));
    await auditAdmin(req,direction==='credit'?'BALANCE_CREDIT':'BALANCE_DEBIT',id,amount,reason);
    return movement;
  }));
  res.json({ok:true,balance:result.balance});
}));

app.get('/api/admin/external-transfers',adminAuth,wrap(async(req,res)=>{
  const status=String(req.query.status||'active');
  if(!['active','all','pending','processing','completed','rejected'].includes(status))throw httpErr(400,'Invalid external transfer status.');
  const where=status==='active'?"WHERE et.status IN ('pending','processing')":status==='all'?'':"WHERE et.status=?";
  const args=status==='active'||status==='all'?[]:[status];
  const rawTransfers=await db.all("SELECT et.id,et.user_id,et.bank_name,et.account_name,et.account_number,et.amount,et.status,et.note,et.created_at,et.updated_at,et.reviewed_by,et.review_note,et.transfer_reference,u.full_name,u.email,a.account_number customer_account FROM external_transfer_requests et JOIN users u ON u.id=et.user_id JOIN accounts a ON a.user_id=et.user_id AND a.kind='user' "+where+" ORDER BY CASE et.status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,et.created_at ASC LIMIT 250",args);
  const transfers=rawTransfers.map(t=>{let details={};const prefix=String(t.note||'').startsWith('ptb-transfer-v3:')?'ptb-transfer-v3:':'ptb-transfer-v2:';if(String(t.note||'').startsWith(prefix)){try{details=JSON.parse(unsealKyc(t.note.slice(prefix.length))||'{}');}catch{}}return {...t,...details,note:details.memo||(String(t.note||'').startsWith(prefix)?'':t.note||'')};});
  const pending=(await db.get("SELECT COUNT(*) n FROM external_transfer_requests WHERE status='pending'",[])).n;
  res.json({transfers,pending});
}));
app.post('/api/admin/external-transfers/:id/review',adminAuth,wrap(async(req,res)=>{
  const id=Number(req.params.id),body=req.body||{},decision=String(body.status||''),reference=String(body.transfer_reference||'').trim().slice(0,100),note=String(body.review_note||'').trim().slice(0,240);
  if(!Number.isSafeInteger(id)||id<1||!['processing','completed','rejected'].includes(decision))throw httpErr(400,'Choose a valid transfer decision.');
  if(decision==='completed'&&reference.length<4)throw httpErr(400,'Enter the real bank transfer reference before marking this transfer completed.');
  if(decision==='rejected'&&note.length<3)throw httpErr(400,'Enter a reason for rejecting this transfer.');
  const result=await db.tx(async()=>{
    const item=await db.get('SELECT * FROM external_transfer_requests WHERE id=? FOR UPDATE',[id]);
    if(!item)throw httpErr(404,'External transfer request not found.');
    if(!['pending','processing'].includes(item.status))throw httpErr(409,'This request has already been finalized.');
    if(decision==='rejected'){
      const from=await db.get('SELECT * FROM accounts WHERE id=?',[item.from_account_id]),hold=await db.get("SELECT * FROM accounts WHERE account_number='SYS-EXTERNAL-TRANSFERS' AND kind='system'");
      if(!from||!hold)throw httpErr(500,'Unable to return the reserved funds.');
      await move({from:hold,to:from,amount:item.amount,typeOut:'external_transfer_refund',typeIn:'external_transfer_refund_in',counterOut:'External transfer refund',counterIn:'Transfer request refund',note:'Refund for external transfer request #'+id});
    }
    await db.run('UPDATE external_transfer_requests SET status=?,updated_at=?,reviewed_by=?,review_note=?,transfer_reference=? WHERE id=?',[decision,now(),String(req.admin.email||'admin'),note||null,decision==='completed'?reference:item.transfer_reference,id]);
    await auditAdmin(req,'EXTERNAL_TRANSFER_'+decision.toUpperCase(),item.user_id,item.amount,'Request #'+id+(note?' · '+note:'')+(reference?' · Reference '+reference:''));
    return item;
  });
  const title=decision==='completed'?'External transfer completed':decision==='rejected'?'External transfer declined':'External transfer processing';
  const message=decision==='completed'?'Your external transfer has been marked completed by the administrator. Bank reference: '+reference:decision==='rejected'?'Your external transfer request was declined. The reserved amount has been returned to your account. Reason: '+note:'Your external transfer request is now being processed by an administrator.';
  await notifyUser(result.user_id,title,message,'transfer');
  res.json({ok:true,status:decision});
}));

app.post('/api/admin/users/:id/card/issue',adminAuth,wrap(async (req,res)=>{
 const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw httpErr(400,'Invalid customer ID.');
 const account=(await db.get("SELECT a.id FROM accounts a WHERE a.user_id=? AND a.kind='user'", [id]));if(!account)throw httpErr(404,'Customer account not found.');
 const rq=(await db.get("SELECT status,card_tier,physical_requested,physical_fee_cents FROM card_requests WHERE user_id=?", [id]));if(!rq||rq.status!=='pending')throw httpErr(409,'Customer must request a card before it can be granted.');
 if((await db.get('SELECT 1 FROM cards WHERE account_id=?', [account.id])))throw httpErr(409,'Card already issued.');
 const tier=['normal','black','platinum'].includes(rq.card_tier)?rq.card_tier:'normal',physical=!!rq.physical_requested;
 const number=demoCardNumber(),cvv=String(crypto.randomInt(100,1000)),exp=new Date();exp.setFullYear(exp.getFullYear()+4);const expiry=String(exp.getMonth()+1).padStart(2,'0')+'/'+String(exp.getFullYear()).slice(2);
 (await db.tx(async ()=>{(await db.run('INSERT INTO cards (account_id,last4,expiry,demo_number,demo_cvv,activated,card_tier,physical_requested,physical_status) VALUES (?,?,?,?,?,0,?,?,?)', [account.id,number.slice(-4),expiry,number,cvv,tier,physical?1:0,physical?'ordered':'not_requested']));(await db.run("UPDATE card_requests SET status='granted',reviewed_at=?,reviewed_by=? WHERE user_id=?", [now(),String(req.admin.email||'admin'),id]));await auditAdmin(req,'CARD_GRANTED',id,null,'Issued '+tier+' card'+(physical?' with physical delivery':' digital only'));}));
 await notifyUser(id,'Card issued',physical?'Your '+tier+' card request was approved. Your physical card is being prepared; activation will be available after delivery is confirmed.':'Your '+tier+' digital card request was approved. You can activate it from your dashboard.','card');res.json({ok:true,last4:number.slice(-4),expiry,tier,physical});
}));
app.post('/api/admin/users/:id/card/reject',adminAuth,wrap(async (req,res)=>{const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw httpErr(400,'Invalid customer ID.');const rq=(await db.get("SELECT status,physical_fee_cents,physical_requested,card_tier FROM card_requests WHERE user_id=?", [id]));if(!rq||rq.status!=='pending')throw httpErr(409,'No pending card request.');await db.tx(async()=>{if(rq.physical_requested&&rq.physical_fee_cents>0){const to=await getUserAccount(id),from=await db.get("SELECT * FROM accounts WHERE account_number='SYS-CARD-FEES' AND kind='system'");if(!from||!to)throw httpErr(500,'Unable to refund the physical card fee.');await move({from,to,amount:rq.physical_fee_cents,typeOut:'physical_card_fee_refund',typeIn:'physical_card_fee_refund_in',counterOut:'Physical card fee refund',counterIn:'Card request refund',note:'Refund for rejected physical card request'});}await db.run("UPDATE card_requests SET status='rejected',reviewed_at=?,reviewed_by=? WHERE user_id=?", [now(),String(req.admin.email||'admin'),id]);await auditAdmin(req,'CARD_REQUEST_REJECTED',id,rq.physical_fee_cents||null,'Admin rejected '+rq.card_tier+' card request; physical fee refunded if charged');});await notifyUser(id,'Card request update','Your card request was not approved. Any physical card fee charged for this request has been returned.','card');res.json({ok:true});}));
app.patch('/api/admin/users/:id/card/physical-status',adminAuth,wrap(async(req,res)=>{
 const id=Number(req.params.id),status=String((req.body||{}).status||'');
 if(!Number.isSafeInteger(id)||id<1||!['ordered','shipped','delivered'].includes(status))throw httpErr(400,'Choose a valid physical card delivery status.');
 const account=await db.get("SELECT id FROM accounts WHERE user_id=? AND kind='user'",[id]);if(!account)throw httpErr(404,'Customer account not found.');
 const card=await db.get('SELECT physical_requested,physical_status,card_tier FROM cards WHERE account_id=?',[account.id]);if(!card||!card.physical_requested)throw httpErr(404,'No physical card was requested for this customer.');
 await db.run('UPDATE cards SET physical_status=? WHERE account_id=?',[status,account.id]);
 await auditAdmin(req,'PHYSICAL_CARD_'+status.toUpperCase(),id,null,'Physical '+card.card_tier+' card delivery status updated');
 await notifyUser(id,'Physical card delivery update','Your physical card status is now '+status+'.'+(status==='delivered'?' You can activate it from your dashboard.':''),'card');
 res.json({ok:true,status});
}));
app.post('/api/admin/users/:id/card/revoke',adminAuth,wrap(async(req,res)=>{
 const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw httpErr(400,'Invalid customer ID.');
 const account=await db.get("SELECT id FROM accounts WHERE user_id=? AND kind='user'",[id]);if(!account)throw httpErr(404,'Customer account not found.');
 const card=await db.get('SELECT id,last4,revoked FROM cards WHERE account_id=?',[account.id]);if(!card)throw httpErr(404,'Customer card not found.');
 if(card.revoked)throw httpErr(409,'Card is already revoked.');
 await db.run('UPDATE cards SET revoked=1,frozen=1,activated=0,online_enabled=0,international_enabled=0 WHERE id=?',[card.id]);
 await auditAdmin(req,'CARD_REVOKED',id,null,'Admin revoked card ending '+card.last4+'; all card controls disabled');
 await notifyUser(id,'Card revoked','Your card has been revoked and disabled. Contact support if you believe this was an error.','card');
 res.json({ok:true,revoked:true});
}));
app.patch('/api/admin/users/:id/card', adminAuth, wrap(async (req,res)=>{
  const id=Number(req.params.id), frozen=(req.body||{}).frozen;
  if(!Number.isSafeInteger(id)||id<1||typeof frozen!=='boolean')throw httpErr(400,'Choose a valid card control.');
  const account=(await db.get("SELECT id FROM accounts WHERE user_id=? AND kind='user'", [id]));
  if(!account)throw httpErr(404,'Customer account not found.');
  const result=(await db.run('UPDATE cards SET frozen=? WHERE account_id=?', [frozen?1:0,account.id]));
  if(!result.changes)throw httpErr(404,'Customer card not found.');
  await auditAdmin(req,frozen?'CARD_FROZEN':'CARD_UNFROZEN',id,null,'Admin card control');
  res.json({ok:true,frozen});
}));

app.get('/api/admin/transactions', adminAuth, wrap(async (req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,100), type=String(req.query.type||'all'), from=Number(req.query.from)||0, to=Number(req.query.to)||0;
  const limit=Math.min(Math.max(Number(req.query.limit)||100,1),250);
  let sql="SELECT t.id,t.group_id,t.type,t.amount,t.balance_after,t.counterparty,t.note,t.created_at,u.id user_id,u.full_name,u.email,a.account_number FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN users u ON u.id=a.user_id WHERE a.kind='user'",args=[];
  if(type!=='all'){sql+=" AND t.type=?";args.push(type);}
  if(from){sql+=" AND t.created_at>=?";args.push(from);}
  if(to){sql+=" AND t.created_at<=?";args.push(to);}
  if(q){sql+=" AND (LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ? OR a.account_number LIKE ? OR CAST(t.id AS TEXT) LIKE ?)";const like='%'+q.toLowerCase()+'%';args.push(like,like,'%'+q+'%','%'+q+'%');}
  const total=(await db.get("SELECT COUNT(*) n FROM ("+sql+") q", [...args])).n;
  const transactions=(await db.all(sql+" ORDER BY t.id DESC LIMIT ?", [...args,limit]));
  res.json({transactions,total});
}));
app.get('/api/admin/kyc', adminAuth, wrap(async (req,res)=>{
  const status=String(req.query.status||'pending');
  const wanted=status==='pending'?'submitted':status;
  if(!['all','submitted','approved','rejected','upgrade'].includes(wanted)) throw httpErr(400,'Invalid verification status.');
  const rows=(await db.all("SELECT vr.id,vr.user_id,vr.legal_name,vr.date_of_birth,vr.address,vr.id_type,vr.id_country,vr.id_last4,vr.id_expiry,vr.review_status,vr.admin_note,vr.submitted_at,vr.reviewed_at,vr.upgrade_status,(vr.proof_address_data IS NOT NULL) AS has_proof,u.email,u.full_name,u.kyc_tier,a.account_number FROM verification_requests vr JOIN users u ON u.id=vr.user_id LEFT JOIN accounts a ON a.user_id=u.id AND a.kind='user' "+(wanted==='upgrade'?"WHERE vr.upgrade_status='submitted'":wanted==='all'?'':"WHERE vr.review_status=?")+" ORDER BY vr.submitted_at DESC LIMIT 200", [...(wanted==='all'||wanted==='upgrade'?[]:[wanted])]));
  res.json({requests:rows.map(r=>({...r,has_proof:!!r.has_proof}))});
}));
app.get('/api/admin/disputes',adminAuth,wrap(async (req,res)=>{
  const status=String(req.query.status||'all');
  if(!['all','open','investigating','resolved','rejected'].includes(status))throw httpErr(400,'Invalid dispute status.');
  const rows=(await db.all("SELECT d.id,d.user_id,d.transaction_id,d.reason,d.details,d.status,d.created_at,d.updated_at,u.full_name,u.email,a.account_number,t.type transaction_type,t.amount transaction_amount,t.counterparty,t.created_at transaction_created FROM disputes d JOIN users u ON u.id=d.user_id JOIN accounts a ON a.user_id=u.id AND a.kind='user' JOIN transactions t ON t.id=d.transaction_id WHERE (?='all' OR d.status=?) ORDER BY d.created_at DESC LIMIT 250", [status,status]));
  res.json({disputes:rows});
}));
app.patch('/api/admin/disputes/:id',adminAuth,wrap(async (req,res)=>{
  const id=Number(req.params.id),status=String((req.body||{}).status||'');
  if(!Number.isSafeInteger(id)||id<1||!['investigating','resolved','rejected'].includes(status))throw httpErr(400,'Choose a valid dispute status.');
  const dispute=(await db.get('SELECT user_id,status FROM disputes WHERE id=?', [id]));
  if(!dispute)throw httpErr(404,'Dispute not found.');
  (await db.run('UPDATE disputes SET status=?,updated_at=? WHERE id=?', [status,now(),id]));
  await auditAdmin(req,'DISPUTE_STATUS_UPDATED',dispute.user_id,null,'Dispute #'+id+' status changed to '+status);
  await notifyUser(dispute.user_id,'Dispute status updated','Your transaction dispute is now '+status+'.','support');
  res.json({ok:true,status});
}));
app.get('/api/admin/audit', adminAuth, wrap(async (req,res)=>{
  const limit=Math.min(Math.max(Number(req.query.limit)||100,1),250);
  res.json({events:(await db.all("SELECT id,admin_email,action,target_user_id,amount,details,created_at FROM admin_audit ORDER BY id DESC LIMIT ?", [limit]))});
}));
app.get('/api/admin/chat/sessions', adminAuth, wrap(async (req,res)=>{
  const sessions=(await db.all("SELECT s.id,s.user_id,s.status,s.created_at,s.updated_at,COALESCE(NULLIF(s.contact_name,''),u.full_name) full_name,COALESCE(NULLIF(s.contact_email,''),u.email) email,a.account_number,(SELECT message FROM support_messages m WHERE m.session_id=s.id ORDER BY m.id DESC LIMIT 1) last_message,(SELECT created_at FROM support_messages m WHERE m.session_id=s.id ORDER BY m.id DESC LIMIT 1) last_message_at,(SELECT COUNT(*) FROM support_messages m WHERE m.session_id=s.id AND m.sender_role='user' AND m.is_read=0) unread_count FROM support_sessions s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN accounts a ON a.user_id=u.id AND a.kind='user' ORDER BY s.updated_at DESC LIMIT 100", []));
  res.json({sessions});
}));
app.get('/api/admin/chat/sessions/:id/messages', adminAuth, wrap(async (req,res)=>{
  const id=Number(req.params.id); if(!Number.isSafeInteger(id)||id<1) throw httpErr(400,'Invalid support session.');
  const session=(await db.get('SELECT id FROM support_sessions WHERE id=?', [id])); if(!session) throw httpErr(404,'Support conversation not found.');
  (await db.run("UPDATE support_messages SET is_read=1 WHERE session_id=? AND sender_role='user'", [id]));
  res.json({messages:(await db.all('SELECT id,session_id,sender_role,sender_name,message,is_read,created_at FROM support_messages WHERE session_id=? ORDER BY id', [id]))});
}));
app.post('/api/admin/chat/sessions/:id/reply', adminAuth, wrap(async (req,res)=>{
  const id=Number(req.params.id), message=String((req.body||{}).message||'').trim();
  if(!Number.isSafeInteger(id)||id<1||message.length<1||message.length>2000) throw httpErr(400,'Enter a reply of up to 2,000 characters.');
  const session=(await db.get('SELECT * FROM support_sessions WHERE id=?', [id])); if(!session) throw httpErr(404,'Support conversation not found.');
  const t=now(),userContact=session.user_id?await db.get('SELECT email FROM users WHERE id=?',[session.user_id]):null,to=session.contact_email||(userContact||{}).email||null;
  const subject='[PT Support #'+id+'] '+String(session.subject||'Support request');
  const msg=(await db.run("INSERT INTO support_messages (session_id,sender_role,sender_name,message,created_at,email_status) VALUES (?,'admin','Prime Trust Support',?,?,?)", [id,message,t,to?'pending':'not_available'])).lastInsertRowid;
  (await db.run("UPDATE support_sessions SET status='open',updated_at=? WHERE id=?", [t,id]));
  let emailSent=false,resendId=null;
  if(to){try{resendId=await sendSupportEmail(to,id,subject,message);emailSent=true;await db.run("UPDATE support_messages SET email_status='sent',resend_email_id=? WHERE id=?",[resendId,msg]);}catch(e){await db.run("UPDATE support_messages SET email_status='failed' WHERE id=?",[msg]);}}
  res.json({ok:true,emailSent,emailError:emailSent?null:(to?'Email delivery failed':'No customer email address is attached')});
}));
app.patch('/api/admin/chat/sessions/:id/close', adminAuth, wrap(async (req,res)=>{
  const id=Number(req.params.id); if(!Number.isSafeInteger(id)||id<1) throw httpErr(400,'Invalid support session.');
  const status=(req.body||{}).status==='open'?'open':'closed';
  (await db.run('UPDATE support_sessions SET status=?,updated_at=? WHERE id=?', [status,now(),id]));
  res.json({ok:true,status});
}));
app.get('/api/admin/email/recipients', adminAuth, wrap(async (req,res)=>{
  res.json({users:(await db.all("SELECT id,full_name,email,status FROM users ORDER BY created_at DESC LIMIT 2000", [])).map(u=>({id:u.id,fullName:u.full_name,email:u.email,status:u.status}))});
}));
app.post('/api/admin/email/send', adminAuth, wrap(async (req,res)=>{
  const b=req.body||{}, audience=String(b.audience||'all'), ids=Array.isArray(b.userIds)?b.userIds.map(Number):[], subject=String(b.subject||'').trim(), message=String(b.message||'').trim();
  if(!['all','active','selected'].includes(audience)||subject.length<2||subject.length>180||message.length<1||message.length>10000) throw httpErr(400,'Choose an audience and provide a subject and message.');
  if(audience==='selected'&&!ids.length) throw httpErr(400,'Select at least one customer.');
  const apiKey=process.env.RESEND_API_KEY, from=process.env.RESEND_FROM_EMAIL||process.env.EMAIL_FROM, replyTo=process.env.RESEND_REPLY_TO||'reply@primetrustdigital.org';
  if(!apiKey||!from) throw httpErr(503,'Email sending is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.');
  let users=(await db.all('SELECT id,full_name,email,status FROM users ORDER BY id', []));
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
      const response=fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({from,reply_to:[replyTo],to:[user.email],subject,text:'Hello '+user.full_name+',\n\n'+message+'\n\nPrime Trust Bank',html:'<!doctype html><html><body style=\"font-family:Arial,sans-serif;color:#20162f\"><h2>Prime Trust Bank</h2><p>Hello '+escapeHtml(user.full_name)+',</p><div style=\"line-height:1.7\">'+safeMessage+'</div><p>Regards,<br>Prime Trust Bank Support</p></body></html>'})});
      results.push({user,response});
    }catch(_){failed++;results.push({user,error:'Network error'});}
  }
  Promise.all(results.map(async item=>{if(item.error)return item;try{const r=await item.response;if(r.ok){sent++;return item;}failed++;return {user:item.user,error:'Email provider rejected the message (HTTP '+r.status+')'};}catch(_){failed++;return {user:item.user,error:'Network error'};}})).then(async done=>{
    const failures=done.filter(x=>x.error).map(x=>({email:x.user.email,error:x.error}));
    await auditAdmin(req,'EMAIL_CAMPAIGN',null,null,'audience='+audience+'; sent='+sent+'; failed='+failed);
    res.json({total:users.length,sent,failed,failures});
  }).catch(()=>fail(res,500,'Could not complete email campaign.'));
}));
app.get('/api/support/session', auth, wrap(async (req,res)=>{
  let session=(await db.get('SELECT * FROM support_sessions WHERE user_id=?', [req.user.id]));
  if(!session){const t=now();const id=(await db.run("INSERT INTO support_sessions (user_id,status,created_at,updated_at) VALUES (?,'open',?,?)", [req.user.id,t,t])).lastInsertRowid;session=(await db.get('SELECT * FROM support_sessions WHERE id=?', [id]));}
  res.json({session});
}));
app.get('/api/support/messages', auth, wrap(async (req,res)=>{
  let session=(await db.get('SELECT * FROM support_sessions WHERE user_id=?', [req.user.id]));
  if(!session){const t=now();const id=(await db.run("INSERT INTO support_sessions (user_id,status,created_at,updated_at) VALUES (?,'open',?,?)", [req.user.id,t,t])).lastInsertRowid;session=(await db.get('SELECT * FROM support_sessions WHERE id=?', [id]));}
  (await db.run("UPDATE support_messages SET is_read=1 WHERE session_id=? AND sender_role='admin'", [session.id]));
  res.json({session,messages:(await db.all('SELECT id,session_id,sender_role,sender_name,message,is_read,created_at FROM support_messages WHERE session_id=? ORDER BY id', [session.id]))});
}));
app.post('/api/support/messages', auth, sensitiveWriteLimiter, wrap(async (req,res)=>{
  const message=String((req.body||{}).message||'').trim(); if(message.length<1||message.length>2000) throw httpErr(400,'Enter a message up to 2,000 characters.');
  let session=(await db.get('SELECT * FROM support_sessions WHERE user_id=?', [req.user.id])), t=now();
  if(!session){const id=(await db.run("INSERT INTO support_sessions (user_id,status,created_at,updated_at) VALUES (?,'open',?,?)", [req.user.id,t,t])).lastInsertRowid;session=(await db.get('SELECT * FROM support_sessions WHERE id=?', [id]));}
  (await db.run("INSERT INTO support_messages (session_id,sender_role,sender_name,message,created_at) VALUES (?,'user',?,?,?)", [session.id,req.user.full_name,message,t]));
  (await db.run("UPDATE support_sessions SET status='open',updated_at=? WHERE id=?", [t,session.id]));
  res.status(201).json({ok:true});
}));

app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const em = String(b.email || '').trim().toLowerCase();
  const name = String(b.full_name || '').trim();
  const password = b.password;
  const pin = b.pin;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) || em.length > 120) throw httpErr(400, 'Enter a valid email address.');
  if ((await db.get('SELECT 1 FROM users WHERE email = ?', [em]))) throw httpErr(409, 'An account with this email already exists.');
  if (name.length < 2 || name.length > 80) throw httpErr(400, 'Enter your full name.');
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) throw httpErr(400, 'Password must be at least 12 characters and no more than 72 UTF-8 bytes.');
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw httpErr(400, 'Transaction PIN must be 4 digits.');

  const ph = bcrypt.hashSync(password, 12), pinh = bcrypt.hashSync(pin, 12), created = now();
  let userId;
  try {
    userId = await db.tx(async () => {
      const u = (await db.run("INSERT INTO users (email,email_verified_at,full_name,password_hash,pin_hash,verification_status,created_at) VALUES (?,NULL,?,?,?,'pending',?)", [em,name,ph,pinh,created])).lastInsertRowid;
      await db.run("INSERT INTO accounts (user_id, account_number, kind) VALUES (?,?, 'user')", [u, (await newAccountNumber())]);
      return u;
    });
  } catch (e) {
    if (e && e.code === '23505') throw httpErr(409, 'An account with this email already exists.');
    throw e;
  }
  const code=String(crypto.randomInt(0,1000000)).padStart(6,'0'),t=now(),hash=crypto.createHash('sha256').update('email-verify:'+em+':'+code+':'+JWT_SECRET).digest('hex');
  await db.run('INSERT INTO email_verification_codes (user_id,code_hash,expires_at,created_at) VALUES (?,?,?,?)',[Number(userId),hash,t+10*60*1000,t]);
  await sendTransactionalEmail(em,'Verify your Prime Trust email','Your Prime Trust email verification code is '+code+'. It expires in 10 minutes. Enter this code in the sign-up screen to continue to identity verification.','<p>Welcome to Prime Trust.</p><p>Your email verification code is:</p><h2 style="letter-spacing:6px">'+code+'</h2><p>This code expires in 10 minutes. After verifying your email, you can continue to identity verification.</p><p>If you did not create this account, you can ignore this email.</p>');
  res.status(201).json({ok:true,email_verification_required:true,email:em});
}));

app.post('/api/auth/email-verification/resend',authLimiter,wrap(async(req,res)=>{
  const email=String((req.body||{}).email||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>120)throw httpErr(400,'Enter a valid email address.');
  const user=await db.get('SELECT id,email,email_verified_at FROM users WHERE email=?',[email]);
  if(user&&!user.email_verified_at){
    const code=String(crypto.randomInt(0,1000000)).padStart(6,'0'),t=now(),hash=crypto.createHash('sha256').update('email-verify:'+email+':'+code+':'+JWT_SECRET).digest('hex');
    await db.run('UPDATE email_verification_codes SET used_at=? WHERE user_id=? AND used_at IS NULL',[t,user.id]);
    await db.run('INSERT INTO email_verification_codes (user_id,code_hash,expires_at,created_at) VALUES (?,?,?,?)',[user.id,hash,t+10*60*1000,t]);
    await sendTransactionalEmail(email,'Your Prime Trust email verification code','Your verification code is '+code+'. It expires in 10 minutes.','<p>Your Prime Trust email verification code is:</p><h2 style="letter-spacing:6px">'+code+'</h2><p>It expires in 10 minutes.</p>');
  }
  res.json({ok:true,message:'If the account needs verification, a new code has been sent.'});
}));

app.post('/api/auth/email-verification/confirm',authLimiter,wrap(async(req,res)=>{
  const email=String((req.body||{}).email||'').trim().toLowerCase(),code=String((req.body||{}).code||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^\d{6}$/.test(code))throw httpErr(400,'Enter the email address and 6-digit verification code.');
  const user=await db.get('SELECT id,email_verified_at,status FROM users WHERE email=?',[email]);
  if(!user)throw httpErr(400,'The verification code is invalid or expired.');
  if(user.email_verified_at){await issueSession(res,user.id,req);return res.json({ok:true,email_verified:true});}
  const record=await db.get('SELECT * FROM email_verification_codes WHERE user_id=? AND used_at IS NULL ORDER BY id DESC LIMIT 1',[user.id]);
  if(!record||record.expires_at<=now()||record.attempts>=5)throw httpErr(400,'The verification code is invalid or expired. Request a new code.');
  const expected=crypto.createHash('sha256').update('email-verify:'+email+':'+code+':'+JWT_SECRET).digest('hex'),a=Buffer.from(expected),z=Buffer.from(record.code_hash);
  if(a.length!==z.length||!crypto.timingSafeEqual(a,z)){await db.run('UPDATE email_verification_codes SET attempts=attempts+1 WHERE id=?',[record.id]);throw httpErr(400,'The verification code is incorrect. Check it and try again.');}
  const t=now();
  await db.tx(async()=>{await db.run('UPDATE email_verification_codes SET used_at=? WHERE id=?',[t,record.id]);await db.run('UPDATE users SET email_verified_at=? WHERE id=?',[t,user.id]);});
  await issueSession(res,user.id,req);
  res.json({ok:true,email_verified:true});
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const em = String((req.body || {}).email || '').trim().toLowerCase();
  const password = (req.body || {}).password;
  const user = (await db.get('SELECT * FROM users WHERE email = ?', [em]));
  const bad = () => httpErr(401, 'Email or password is incorrect.');
  if (!user) { bcrypt.compareSync(String(password || ''), DUMMY_HASH); throw bad(); } // keep timing similar
  if (user.locked_until > now()) throw httpErr(429, 'Account locked for a few minutes after too many failed logins.');
  if (typeof password !== 'string' || !bcrypt.compareSync(password, user.password_hash)) {
    const fails = user.failed_logins + 1;
    const lock = fails >= 5 ? now() + 10 * 60 * 1000 : 0;
    (await db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [lock ? 0 : fails, lock, user.id]));
    throw bad();
  }
  if (user.status === 'suspended') throw httpErr(403, 'This account is suspended. Please contact Prime Trust support.');
  if (!user.email_verified_at) throw httpErr(403, 'Please verify your email before logging in.');
  (await db.run('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?', [user.id]));
  if(user.mfa_enabled){
    const challengeId=crypto.randomUUID(),code=String(crypto.randomInt(0,1000000)).padStart(6,'0'),created=now();
    const codeHash=crypto.createHash('sha256').update(challengeId+':'+code+':'+JWT_SECRET).digest('hex');
    (await db.run("INSERT INTO mfa_challenges (id,user_id,purpose,code_hash,expires_at,created_at) VALUES (?,?,'login',?,?,?)", [challengeId,user.id,codeHash,created+5*60*1000,created]));
    await sendTransactionalEmail(user.email,'Prime Trust sign-in code','Your sign-in verification code is '+code+'. It expires in 5 minutes.','<p>Your Prime Trust sign-in code is:</p><h2 style="letter-spacing:6px">'+code+'</h2><p>It expires in 5 minutes. If you did not try to sign in, change your password.</p>');
    return res.json({mfa_required:true,challenge_id:challengeId});
  }
  if (bcrypt.getRounds(user.password_hash) < 12) (await db.run('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(password,12),user.id]));
  await issueSession(res, user.id, req);
  res.json({ ok: true });
}));

app.post('/api/auth/password-reset/request',authLimiter,wrap(async (req,res)=>{
  const email=String((req.body||{}).email||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>120)throw httpErr(400,'Enter a valid email address.');
  const apiKey=process.env.RESEND_API_KEY,from=process.env.RESEND_FROM_EMAIL||process.env.EMAIL_FROM,replyTo=process.env.RESEND_REPLY_TO||'reply@primetrustdigital.org';
  if(!apiKey||!from)throw httpErr(503,'Password recovery email is not configured.');
  const user=(await db.get('SELECT id,full_name,email FROM users WHERE email=?', [email]));
  if(user){
    const raw=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHash('sha256').update(raw).digest('hex'),created=now(),expires=created+30*60*1000;
    (await db.run('UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL', [created,user.id]));
    (await db.run('INSERT INTO password_reset_tokens (user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?)', [user.id,hash,expires,created]));
    const base=String(process.env.PUBLIC_APP_URL||req.protocol+'://'+req.get('host')).replace(/\/$/,'');
    const link=base+'/?reset='+encodeURIComponent(raw);
    const safeName=String(user.full_name).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({from,reply_to:[replyTo],to:[user.email],subject:'Reset your Prime Trust password',text:'Hello '+user.full_name+',\n\nUse this link to reset your password within 30 minutes: '+link+'\n\nIf you did not request this, ignore this email.',html:'<p>Hello '+safeName+',</p><p>Use this link to reset your Prime Trust password. It expires in 30 minutes.</p><p><a href="'+link+'">Reset password</a></p><p>If you did not request this, ignore this email.</p>'})});
    if(!response.ok){(await db.run('UPDATE password_reset_tokens SET used_at=? WHERE token_hash=?', [now(),hash]));throw httpErr(502,'Could not send password recovery email. Try again later.');}
  }
  res.json({ok:true,message:'If the account exists, password recovery instructions have been sent.'});
}));
app.post('/api/auth/password-reset/confirm',authLimiter,wrap(async (req,res)=>{
  const b=req.body||{},raw=String(b.token||''),password=b.password;
  if(!/^[A-Za-z0-9_-]{40,60}$/.test(raw))throw httpErr(400,'Reset link is invalid or expired.');
  if(typeof password!=='string'||password.length<12||Buffer.byteLength(password,'utf8')>72)throw httpErr(400,'Password must be at least 12 characters and no more than 72 UTF-8 bytes.');
  const hash=crypto.createHash('sha256').update(raw).digest('hex'),record=(await db.get('SELECT * FROM password_reset_tokens WHERE token_hash=?', [hash]));
  if(!record||record.used_at||record.expires_at<=now())throw httpErr(400,'Reset link is invalid or expired.');
  const ph=bcrypt.hashSync(password,12),t=now();
  (await db.tx(async ()=>{
    (await db.run('UPDATE users SET password_hash=?,session_version=session_version+1,failed_logins=0,locked_until=0 WHERE id=?', [ph,record.user_id]));
    (await db.run('UPDATE password_reset_tokens SET used_at=? WHERE id=?', [t,record.id]));
    (await db.run('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [t,record.user_id]));
  }));
  res.json({ok:true});
}));
app.post('/api/auth/mfa/verify',authLimiter,wrap(async (req,res)=>{
  const b=req.body||{},id=String(b.challenge_id||''),code=String(b.code||'');
  if(!/^[0-9a-f-]{36}$/i.test(id)||!/^\d{6}$/.test(code))throw httpErr(400,'Enter the 6-digit verification code.');
  const ch=(await db.get("SELECT * FROM mfa_challenges WHERE id=? AND purpose='login'", [id]));
  if(!ch||ch.used_at||ch.expires_at<=now()||ch.attempts>=5)throw httpErr(400,'Verification code expired. Sign in again.');
  const expected=crypto.createHash('sha256').update(id+':'+code+':'+JWT_SECRET).digest('hex'),a=Buffer.from(expected),z=Buffer.from(ch.code_hash);
  if(a.length!==z.length||!crypto.timingSafeEqual(a,z)){(await db.run('UPDATE mfa_challenges SET attempts=attempts+1 WHERE id=?', [id]));throw httpErr(401,'Verification code is incorrect.');}
  const user=(await db.get('SELECT status FROM users WHERE id=?', [ch.user_id]));
  if(!user||user.status==='suspended')throw httpErr(403,'This account cannot sign in.');
  (await db.run('UPDATE mfa_challenges SET used_at=? WHERE id=?', [now(),id]));
  await issueSession(res,ch.user_id,req);res.json({ok:true});
}));
app.post('/api/security/mfa/start',auth,requireVerified,sensitiveWriteLimiter,wrap(async (req,res)=>{
  if(req.user.mfa_enabled)throw httpErr(409,'Multi-factor authentication is already enabled.');
  const id=crypto.randomUUID(),code=String(crypto.randomInt(0,1000000)).padStart(6,'0'),created=now(),hash=crypto.createHash('sha256').update(id+':'+code+':'+JWT_SECRET).digest('hex');
  (await db.run("INSERT INTO mfa_challenges (id,user_id,purpose,code_hash,expires_at,created_at) VALUES (?,?,'enable',?,?,?)", [id,req.user.id,hash,created+5*60*1000,created]));
  await sendTransactionalEmail(req.user.email,'Enable Prime Trust sign-in verification','Your verification code is '+code+'. It expires in 5 minutes.','<p>Use this code to enable sign-in verification:</p><h2 style="letter-spacing:6px">'+code+'</h2><p>It expires in 5 minutes.</p>');
  res.json({ok:true,challenge_id:id});
}));
app.post('/api/security/mfa/confirm',auth,sensitiveWriteLimiter,wrap(async (req,res)=>{
  const b=req.body||{},id=String(b.challenge_id||''),code=String(b.code||'');
  if(!/^[0-9a-f-]{36}$/i.test(id)||!/^\d{6}$/.test(code))throw httpErr(400,'Enter the 6-digit verification code.');
  const ch=(await db.get("SELECT * FROM mfa_challenges WHERE id=? AND user_id=? AND purpose='enable'", [id,req.user.id]));
  if(!ch||ch.used_at||ch.expires_at<=now()||ch.attempts>=5)throw httpErr(400,'Verification code expired. Start setup again.');
  const expected=crypto.createHash('sha256').update(id+':'+code+':'+JWT_SECRET).digest('hex'),a=Buffer.from(expected),z=Buffer.from(ch.code_hash);
  if(a.length!==z.length||!crypto.timingSafeEqual(a,z)){(await db.run('UPDATE mfa_challenges SET attempts=attempts+1 WHERE id=?', [id]));throw httpErr(401,'Verification code is incorrect.');}
  (await db.tx(async ()=>{(await db.run('UPDATE mfa_challenges SET used_at=? WHERE id=?', [now(),id]));(await db.run('UPDATE users SET mfa_enabled=1 WHERE id=?', [req.user.id]));}));
  res.json({ok:true,mfa_enabled:true});
}));
app.post('/api/security/mfa/disable',auth,sensitiveWriteLimiter,wrap(async (req,res)=>{
  const b=req.body||{},password=String(b.password||''),pin=String(b.pin||'');
  if(!bcrypt.compareSync(password,req.user.password_hash))throw httpErr(401,'Password is incorrect.');
  await verifyPin(req.user,pin);
  (await db.run('UPDATE users SET mfa_enabled=0 WHERE id=?', [req.user.id]));
  (await db.run("UPDATE mfa_challenges SET used_at=? WHERE user_id=? AND used_at IS NULL", [now(),req.user.id]));
  res.json({ok:true,mfa_enabled:false});
}));
app.post('/api/auth/logout', wrap(async (req, res) => {
  try { const payload=jwt.verify(req.cookies.ptb_session||'',JWT_SECRET); if(payload.jti)(await db.run('UPDATE user_sessions SET revoked_at=? WHERE jti=? AND revoked_at IS NULL', [now(),payload.jti])); } catch {}
  res.clearCookie('ptb_session', { path: '/' }); res.clearCookie('ptb_impersonation',{path:'/'}); res.json({ ok: true });
}));

// ---------- banking routes ----------

app.get('/api/impersonation/status', auth, wrap(async (req,res)=>{
  try {
    const marker = jwt.verify(req.cookies.ptb_impersonation || '', JWT_SECRET);
    if (marker.impersonating && Number(marker.targetId) === req.user.id) {
      const adminSession = (await db.get('SELECT admin_email, expires_at, revoked_at FROM admin_sessions WHERE jti=?', [marker.adminJti]));
      if (adminSession && !adminSession.revoked_at && adminSession.expires_at > now() && adminSession.admin_email === marker.adminEmail) {
        return res.json({ active: true, admin_email: marker.adminEmail });
      }
    }
  } catch {}
  res.json({ active: false });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  if(req.user.verification_status==='approved')await processDueTransfers(req.user.id);
  const card=(await db.get('SELECT last4,expiry,frozen,activated,online_enabled,international_enabled,daily_limit,card_pin_hash,card_tier,physical_requested,physical_status,revoked FROM cards WHERE account_id=?', [req.account.id]));
  const cardProduct=await db.get('SELECT physical_card_fee_cents FROM card_product_settings WHERE id=1');
  const cardRequest=(await db.get('SELECT status,requested_at,card_tier,physical_requested,physical_fee_cents FROM card_requests WHERE user_id=?', [req.user.id]))||null;
  const kycInfo=(await db.get('SELECT admin_note,upgrade_status,upgrade_note,id_expiry FROM verification_requests WHERE user_id=?', [req.user.id]))||null;
  res.json({name:req.user.full_name,email:req.user.email,verification_status:req.user.verification_status,kyc_tier:req.user.kyc_tier,tier:kyc.tierOf(req.user),kyc:kycInfo,mfa_enabled:!!req.user.mfa_enabled,
    account:{number:req.account.account_number,currency:req.account.currency,balance:req.account.balance},
    card:card?{last4:card.last4,expiry:card.expiry,frozen:!!card.frozen,activated:!!card.activated,online_enabled:!!card.online_enabled,international_enabled:!!card.international_enabled,daily_limit:card.daily_limit,card_pin_set:!!card.card_pin_hash,tier:card.card_tier||'normal',physical_requested:!!card.physical_requested,physical_status:card.physical_status||'not_requested',revoked:!!card.revoked}:null,
    card_options:{physical_fee_cents:cardProduct?cardProduct.physical_card_fee_cents:2500},
    card_request:cardRequest,sandbox_funding:SANDBOX_FUNDING});
}));

app.get('/api/transactions', auth, wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const rows = (await db.all('SELECT * FROM transactions WHERE account_id = ? ORDER BY id DESC LIMIT ?', [req.account.id, limit]));
  res.json({ transactions: rows.map(shapeTx) });
}));

// People you have sent money to (most recent first, unique).
app.get('/api/beneficiaries', auth, wrap(async (req, res) => {
  const rows = (await db.all(`SELECT counterparty, note FROM transactions
    WHERE account_id = ? AND type = 'transfer_out' ORDER BY id DESC LIMIT 60`, [req.account.id]));
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
app.get('/api/accounts/lookup/:number', auth, moneyLimiter, wrap(async (req, res) => {
  const n = String(req.params.number);
  if (!/^\d{10}$/.test(n)) throw httpErr(400, 'Account numbers have 10 digits.');
  const row = (await db.get(`SELECT u.full_name, a.id FROM accounts a JOIN users u ON u.id = a.user_id
    WHERE a.account_number = ? AND a.kind = 'user'`, [n]));
  if (!row) throw httpErr(404, 'No account with that number.');
  if (row.id === req.account.id) throw httpErr(400, 'That is your own account.');
  res.json({ name: row.full_name, account_number: n });
}));

app.post('/api/transfers', auth, requireVerified, moneyLimiter, wrap(async (req, res) => {
  await idempotent(req, res, async () => {
    const { to_account, amount, pin, note } = req.body || {};
    const amt = cents(amount);
    if (!amt) throw httpErr(400, 'Enter a valid amount (up to 2 decimals).');
    if (amt > 1000000 * 100) throw httpErr(400, 'Amount is above the single transfer limit.');
    const userLimit=(await db.get('SELECT daily_transfer_limit FROM account_limits WHERE user_id=?', [req.user.id]));
    const tier=kyc.tierOf(req.user);
    if(amt>tier.per_transaction)throw httpErr(422,'This amount is above the limit for your verification level ('+tier.name+'). Upload proof of address to raise your limits.');
    const dailyLimit=Math.min(userLimit?userLimit.daily_transfer_limit:500000,tier.daily_transfer);
    if(amt>dailyLimit||(await transferDailyTotal(req.user.id))+amt>dailyLimit)throw httpErr(422,'Your daily transfer limit would be exceeded. Change your account limits or try another day.');
    if (!/^\d{10}$/.test(String(to_account))) throw httpErr(400, 'Enter a 10-digit account number.');
    await verifyPin(req.user, pin);
    const dest = (await db.get(`SELECT a.*, u.full_name FROM accounts a JOIN users u ON u.id = a.user_id
      WHERE a.account_number = ? AND a.kind = 'user'`, [String(to_account)]));
    if (!dest) throw httpErr(404, 'No account with that number.');
    if (dest.id === req.account.id) throw httpErr(400, 'You cannot send money to yourself.');
    const userNote = String(note || '').replace(/[|\r\n]/g, ' ').slice(0, 60);
    const out = (await db.tx(async () => (await move({
      from: req.account, to: dest, amount: amt,
      typeOut: 'transfer_out', typeIn: 'transfer_in',
      counterOut: dest.full_name, counterIn: req.user.full_name,
      note: 'acct:' + dest.account_number + (userNote ? '|' + userNote : '')
    }))));
    return { ok: true, to: dest.full_name, balance: out.balance };
  });
}));

app.get('/api/external-transfers', auth, wrap(async (req,res)=>{
  const rows=await db.all("SELECT id,bank_name,account_name,account_number,amount,status,note,created_at,updated_at,transfer_reference,review_note FROM external_transfer_requests WHERE user_id=? ORDER BY id DESC LIMIT 100", [req.user.id]);
  const transfers=rows.map(t=>{let details={};const prefix=String(t.note||'').startsWith('ptb-transfer-v3:')?'ptb-transfer-v3:':'ptb-transfer-v2:';if(String(t.note||'').startsWith(prefix)){try{details=JSON.parse(unsealKyc(t.note.slice(prefix.length))||'{}');}catch{}}return {...t,account_number:'••••'+String(details.account_number||details.iban||t.account_number||'').slice(-4),note:details.memo||(String(t.note||'').startsWith(prefix)?'':t.note||'')};});
  res.json({transfers});
}));
app.post('/api/external-transfers', auth, requireVerified, moneyLimiter, wrap(async (req,res)=>{
  await idempotent(req,res,async()=>{
    const b=req.body||{},method=String(b.transfer_type||'').toLowerCase(),bank=String(b.bank_name||'').trim().slice(0,100),name=String(b.account_name||'').trim().slice(0,100),acct=String(b.account_number||'').trim(),routing=String(b.routing_number||'').trim(),acctType=String(b.account_type||'').toLowerCase(),memo=String(b.note||'').replace(/[|\r\n]/g,' ').slice(0,100);
    const street=String(method==='international'?(b.intl_recipient_street||''):(b.recipient_street||'')).trim().slice(0,120),city=String(method==='international'?(b.intl_recipient_city||''):(b.recipient_city||'')).trim().slice(0,60),state=String(method==='international'?(b.intl_recipient_state||''):(b.recipient_state||'')).trim().toUpperCase().slice(0,40),zip=String(method==='international'?(b.intl_recipient_postal_code||''):(b.recipient_postal_code||'')).trim().slice(0,20),country=String(method==='international'?(b.intl_recipient_country||''):(b.recipient_country||'')).trim().slice(0,60),phone=String(b.recipient_phone||'').trim().slice(0,25),bankAddress=String(b.bank_address||'').trim().slice(0,200);
    const swift=String(b.swift_bic||'').trim().toUpperCase(),iban=String(b.iban||'').replace(/\s/g,'').toUpperCase(),acctIntl=acct.replace(/\s/g,'').toUpperCase(),currency=String(b.destination_currency||'').trim().toUpperCase(),purpose=String(b.transfer_purpose||'').trim().slice(0,140),relationship=String(b.recipient_relationship||'').trim().slice(0,80),sourceOfFunds=String(b.source_of_funds||'').trim().slice(0,100),bankCountry=String(b.bank_country||'').trim().slice(0,60),bankCity=String(b.bank_city||'').trim().slice(0,80),bankBranch=String(b.bank_branch||'').trim().slice(0,100),chargeBearer=String(b.charge_bearer||'SHA').trim().toUpperCase(),beneficiaryEmail=String(b.beneficiary_email||'').trim().slice(0,120),intermediaryBank=String(b.intermediary_bank||'').trim().slice(0,100),intermediarySwift=String(b.intermediary_swift||'').trim().toUpperCase(),intermediaryAccount=String(b.intermediary_account||'').trim().slice(0,34),localBankCode=String(b.local_bank_code||'').trim().slice(0,40);
    const amount=cents(b.amount);
    let aba=1;
    if(/^[0-9]{9}$/.test(routing)){aba=3*(Number(routing[0])+Number(routing[3])+Number(routing[6]))+7*(Number(routing[1])+Number(routing[4])+Number(routing[7]))+(Number(routing[2])+Number(routing[5])+Number(routing[8]));}
    if(!['ach','wire','international'].includes(method)||bank.length<2||name.length<2)throw httpErr(400,'Enter a valid transfer method, bank and beneficiary full legal name.');
    if(method==='international'){
      if(!/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(swift)||!(/^[A-Z0-9]{4,34}$/.test(iban)||/^[A-Z0-9]{4,34}$/.test(acctIntl)))throw httpErr(400,'Enter a valid SWIFT/BIC and either an IBAN or international account number.');
      if(bankAddress.length<5||bankCountry.length<2||bankCity.length<2||street.length<3||city.length<2||country.length<2||currency.length!==3||!/^[A-Z]{3}$/.test(currency)||purpose.length<3||relationship.length<2||sourceOfFunds.length<2||!['OUR','SHA','BEN'].includes(chargeBearer))throw httpErr(400,'Complete beneficiary and bank addresses, bank city/country, destination country/currency, purpose, relationship, source of funds and fee preference.');
      if(beneficiaryEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(beneficiaryEmail))throw httpErr(400,'Enter a valid beneficiary email address or leave it blank.');
      if(intermediarySwift&&!/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(intermediarySwift))throw httpErr(400,'Enter a valid intermediary SWIFT/BIC or leave it blank.');
      if(intermediaryBank.length>0&&intermediarySwift.length===0)throw httpErr(400,'Enter the intermediary bank SWIFT/BIC when providing an intermediary bank.');
    }else{
      if(!/^[0-9]{4,17}$/.test(acct)||!['checking','savings'].includes(acctType)||aba%10!==0)throw httpErr(400,'Enter a valid U.S. account type, account number and 9-digit ABA routing number.');
      if(street.length<3||city.length<2||!/^[A-Z]{2}$/.test(state)||!/^\d{5}(-\d{4})?$/.test(zip)||country!=='United States')throw httpErr(400,'Enter the recipient’s complete U.S. street address, city, 2-letter state, ZIP code and country.');
    }
    if(phone&&!/^\+?[0-9(). -]{7,25}$/.test(phone))throw httpErr(400,'Enter a valid recipient phone number or leave it blank.');
    if(!amount||amount>1000000*100)throw httpErr(400,'Enter a valid transfer amount.');
    const limits=await db.get('SELECT daily_transfer_limit FROM account_limits WHERE user_id=?',[req.user.id]),tier=kyc.tierOf(req.user);
    if(amount>tier.per_transaction)throw httpErr(422,'This amount is above the limit for your verification level ('+tier.name+').');
    const daily=Math.min(limits?limits.daily_transfer_limit:500000,tier.daily_transfer);
    if(amount>daily||(await transferDailyTotal(req.user.id))+amount>daily)throw httpErr(422,'Your daily transfer limit would be exceeded.');
    await verifyPin(req.user,b.pin);
    const encrypted='ptb-transfer-v3:'+sealKyc(JSON.stringify({transfer_type:method,routing_number:routing,account_number:acct,account_type:acctType,recipient_address:{street,city,state,postal_code:zip,country},recipient_phone:phone,bank_address:bankAddress,memo,swift_bic:swift,iban,destination_currency:currency,transfer_purpose:purpose,recipient_relationship:relationship,source_of_funds:sourceOfFunds,bank_country:bankCountry,bank_city:bankCity,bank_branch:bankBranch,charge_bearer:chargeBearer,beneficiary_email:beneficiaryEmail,intermediary_bank:intermediaryBank,intermediary_swift:intermediarySwift,intermediary_account:intermediaryAccount,local_bank_code:localBankCode}));
    const result=await db.tx(async()=>{
      const from=await getUserAccount(req.user.id),hold=await db.get("SELECT * FROM accounts WHERE account_number='SYS-EXTERNAL-TRANSFERS' AND kind='system'");
      if(!from||!hold)throw httpErr(500,'External transfer processing account is unavailable.');
      const movement=await move({from,to:hold,amount,typeOut:'external_transfer_pending',typeIn:'external_transfer_hold',counterOut:bank+' · '+name,counterIn:'External transfer funds held',note:'External transfer '+method.toUpperCase()+' to '+bank+' · account ending '+acct.slice(-4)+(memo?' | '+memo:'')});
      const t=now(),insert=await db.run("INSERT INTO external_transfer_requests (user_id,from_account_id,bank_name,account_name,account_number,amount,status,note,created_at,updated_at,hold_group_id) VALUES (?,?,?,?,?,?,'pending',?,?,?,?)",[req.user.id,from.id,bank,name,'••••'+acct.slice(-4),amount,encrypted,t,t,movement.group_id]);
      return {id:insert.lastInsertRowid,balance:movement.balance};
    });
    return {ok:true,request_id:result.id,status:'pending',balance:result.balance};
  });
}));
const BILLERS = ['Electricity', 'Cable TV', 'Internet', 'Water', 'School fees'];
const NETWORKS = ['MTN', 'Airtel', 'Glo', '9mobile'];

// Airtime purchase removed from this demo app.

app.post('/api/bills', auth, requireVerified, moneyLimiter, wrap(async (req, res) => {
  await idempotent(req, res, async () => {
    const { biller, reference, amount, pin } = req.body || {};
    const amt = cents(amount);
    if (!amt || amt > 50000 * 100) throw httpErr(400, 'Enter a valid amount.');
    const payLimitRow=(await db.get('SELECT daily_payment_limit FROM account_limits WHERE user_id=?', [req.user.id]));
    const payLimit=Math.min(payLimitRow?payLimitRow.daily_payment_limit:100000,kyc.tierOf(req.user).daily_payment);
    const dayStart=new Date();dayStart.setHours(0,0,0,0);
    const payUsed=(await db.get("SELECT COALESCE(SUM(-amount),0) total FROM transactions WHERE account_id=? AND type IN ('airtime','bill') AND created_at>=?", [req.account.id,dayStart.getTime()])).total;
    if(amt>payLimit||payUsed+amt>payLimit)throw httpErr(422,'Your daily payment limit would be exceeded.');
    if (!BILLERS.includes(biller)) throw httpErr(400, 'Choose a bill type.');
    if (!/^[\w-]{4,30}$/.test(String(reference || ''))) throw httpErr(400, 'Enter the meter, smartcard or account reference.');
    await verifyPin(req.user, pin);
    const sys = (await db.get("SELECT * FROM accounts WHERE account_number = 'SYS-BILLERS'", []));
    const out = (await db.tx(async () => (await move({
      from: req.account, to: sys, amount: amt, typeOut: 'bill', typeIn: 'bill_in',
      counterOut: biller, counterIn: req.user.full_name, note: 'ref:' + reference
    }))));
    return { ok: true, balance: out.balance };
  });
}));

app.post('/api/deposit',auth,requireVerified,moneyLimiter,wrap(async(req,res)=>{throw httpErr(410,'Test-fund deposits are disabled. Submit a bank or crypto deposit request instead.');}));
app.get('/api/deposit/options',auth,wrap(async(req,res)=>{const bank=await db.get('SELECT bank_name,account_name,account_number,account_type,currency,instructions FROM deposit_settings WHERE id=1');const wallets=await db.all("SELECT id,name,asset,network,address,qr_url,instructions FROM crypto_wallets WHERE active=1 ORDER BY id",[]);res.json({bank:bank||null,wallets});}));
app.get('/api/deposit/requests',auth,wrap(async(req,res)=>{const requests=await db.all("SELECT id,method,amount,currency,depositor_name,reference,wallet_name,wallet_network,status,review_note,created_at,reviewed_at FROM deposit_requests WHERE user_id=? ORDER BY id DESC LIMIT 50",[req.user.id]);res.json({requests});}));
app.post('/api/deposit/requests',auth,requireVerified,moneyLimiter,wrap(async(req,res)=>{const b=req.body||{},method=String(b.method||''),amount=cents(b.amount),reference=String(b.reference||'').trim();if(!['bank','crypto'].includes(method)||!amount||amount>100000000)throw httpErr(400,'Choose a deposit method and enter a valid amount.');if(reference.length<4||reference.length>200)throw httpErr(400,'Enter a valid transfer reference or transaction hash.');let wallet=null,bank=null;if(method==='bank'){bank=await db.get('SELECT bank_name,account_name,account_number,account_type,currency,instructions FROM deposit_settings WHERE id=1');if(!bank||!bank.bank_name||!bank.account_name||!bank.account_number)throw httpErr(503,'Bank deposit details have not been configured by the administrator.');}else{const walletId=Number(b.wallet_id);if(!Number.isSafeInteger(walletId)||walletId<1)throw httpErr(400,'Choose a configured crypto wallet.');wallet=await db.get('SELECT id,name,asset,network,address,qr_url,instructions FROM crypto_wallets WHERE id=? AND active=1',[walletId]);if(!wallet)throw httpErr(400,'That crypto wallet is unavailable.');if(reference.length<20)throw httpErr(400,'The crypto transaction hash looks too short.');}const duplicate=await db.get('SELECT id FROM deposit_requests WHERE lower(reference)=lower(?)',[reference]);if(duplicate)throw httpErr(409,'This transfer reference or transaction hash has already been submitted.');const t=now();const result=await db.run("INSERT INTO deposit_requests (user_id,account_id,method,amount,currency,depositor_name,reference,wallet_id,wallet_name,wallet_network,wallet_address,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?) RETURNING id",[req.user.id,req.account.id,method,amount,method==='bank'?(bank.currency||req.account.currency):(wallet.asset||'USD'),req.user.full_name,reference,wallet?wallet.id:null,wallet?wallet.name:null,wallet?wallet.network:null,wallet?wallet.address:null,t,t]);res.status(201).json({ok:true,id:result.lastInsertRowid||result.id||null,status:'pending'});}));

app.post('/api/card/request',auth,requireVerified,sensitiveWriteLimiter,wrap(async (req,res)=>{
 if((await db.get('SELECT 1 FROM cards WHERE account_id=?', [req.account.id])))throw httpErr(409,'A card has already been issued.');
 const body=req.body||{},tier=String(body.tier||'normal').toLowerCase(),physical=body.physical===true;
 if(!['normal','black','platinum'].includes(tier))throw httpErr(400,'Choose Normal, Black or Platinum card.');
 const old=(await db.get('SELECT status FROM card_requests WHERE user_id=?', [req.user.id]));
 if(old&&old.status==='pending')throw httpErr(409,'Your card request is already awaiting administrator review.');
 await verifyPin(req.user,String(body.pin||''));
 const setting=await db.get('SELECT physical_card_fee_cents FROM card_product_settings WHERE id=1'),fee=physical?(setting?setting.physical_card_fee_cents:2500):0;
 await db.tx(async()=>{
  if(physical&&fee>0){const from=await getUserAccount(req.user.id),to=await db.get("SELECT * FROM accounts WHERE account_number='SYS-CARD-FEES' AND kind='system'");if(!from||!to)throw httpErr(500,'Physical card fee processing is unavailable.');await move({from,to,amount:fee,typeOut:'physical_card_fee',typeIn:'physical_card_fee_received',counterOut:'Physical card request fee',counterIn:'Card fee account',note:'Physical '+tier+' card request fee'});}
  await db.run("INSERT INTO card_requests (user_id,status,card_tier,physical_requested,physical_fee_cents,requested_at) VALUES (?,'pending',?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status='pending',card_tier=excluded.card_tier,physical_requested=excluded.physical_requested,physical_fee_cents=excluded.physical_fee_cents,requested_at=excluded.requested_at,reviewed_at=NULL,reviewed_by=NULL",[req.user.id,tier,physical?1:0,fee,now()]);
 });
 await notifyUser(req.user.id,'Card request received','Your '+tier+' card request is awaiting administrator review'+(physical?'. Physical card fee: USD '+(fee/100).toFixed(2):' (digital card).'),'card');
 res.status(201).json({ok:true,status:'pending',tier,physical,physical_fee_cents:fee});
}));
app.post('/api/card/details',auth,requireVerified,sensitiveWriteLimiter,wrap(async (req,res)=>{
 const c=(await db.get('SELECT demo_number,demo_cvv,expiry,revoked FROM cards WHERE account_id=?', [req.account.id]));
 if(!c)throw httpErr(404,'No card has been issued to this account yet.');
 if(c.revoked)throw httpErr(410,'This card has been closed.');
 await verifyPin(req.user,String((req.body||{}).pin||''));
 if(!c.demo_number||!c.demo_cvv)throw httpErr(503,'Card details are unavailable. Please contact support.');
 res.json({card:{number:c.demo_number,cvv:c.demo_cvv,expiry:c.expiry}});
}));
app.delete('/api/card',auth,requireVerified,sensitiveWriteLimiter,wrap(async(req,res)=>{
 const card=await db.get('SELECT id,revoked,last4 FROM cards WHERE account_id=?',[req.account.id]);
 if(!card)throw httpErr(404,'No card has been issued to this account.');
 await verifyPin(req.user,String((req.body||{}).transaction_pin||''));
 await db.run('DELETE FROM cards WHERE id=? AND account_id=?',[card.id,req.account.id]);
 await auditAdmin(req,'USER_CARD_DELETED',req.user.id,null,'Customer removed card ending '+card.last4+' from dashboard'+(card.revoked?' after revocation':''));
 await notifyUser(req.user.id,'Card removed','Your card has been removed from your dashboard. You may request another card if eligible.','card');
 res.json({ok:true,deleted:true});
}));
app.get('/api/card/settings',auth,requireVerified,wrap(async (req,res)=>{
 const c=(await db.get('SELECT activated,online_enabled,international_enabled,daily_limit,card_pin_hash,frozen,physical_requested,physical_status,revoked FROM cards WHERE account_id=?', [req.account.id]));
 if(!c)throw httpErr(404,'No card has been issued to this account yet.');
 if(c.revoked)throw httpErr(410,'This card has been closed.');
 res.json({settings:{activated:!!c.activated,online_enabled:!!c.online_enabled,international_enabled:!!c.international_enabled,daily_limit:c.daily_limit,card_pin_set:!!c.card_pin_hash,frozen:!!c.frozen,physical_requested:!!c.physical_requested,physical_status:c.physical_status}});
}));
app.patch('/api/card/settings',auth,requireVerified,sensitiveWriteLimiter,wrap(async (req,res)=>{
  const activeCard=await db.get('SELECT revoked FROM cards WHERE account_id=?',[req.account.id]);if(!activeCard)throw httpErr(404,'No card has been issued to this account yet.');if(activeCard.revoked)throw httpErr(410,'This card has been closed.');

  const b=req.body||{},limit=Number(b.daily_limit);
  if(typeof b.activated!=='boolean'||typeof b.online_enabled!=='boolean'||typeof b.international_enabled!=='boolean'||!Number.isSafeInteger(limit)||limit<10000||limit>10000000)throw httpErr(400,'Choose valid card settings and a daily limit between USD 100 and USD 100,000.');
  const cardState=await db.get('SELECT physical_requested,physical_status FROM cards WHERE account_id=?',[req.account.id]);
  if(b.activated&&cardState&&cardState.physical_requested&&cardState.physical_status!=='delivered')throw httpErr(403,'Your physical card must be marked delivered before activation.');
  await verifyPin(req.user,String(b.transaction_pin||''));
  (await db.run('UPDATE cards SET activated=?,online_enabled=?,international_enabled=?,daily_limit=? WHERE account_id=?', [b.activated?1:0,b.online_enabled?1:0,b.international_enabled?1:0,limit,req.account.id]));
  res.json({ok:true});
}));
app.post('/api/card/pin',auth,requireVerified,sensitiveWriteLimiter,wrap(async (req,res)=>{
  const cardState=await db.get('SELECT revoked FROM cards WHERE account_id=?',[req.account.id]);if(!cardState)throw httpErr(404,'No card has been issued to this account yet.');if(cardState.revoked)throw httpErr(410,'This card has been closed.');

  const b=req.body||{},pin=String(b.card_pin||'');
  await verifyPin(req.user,String(b.transaction_pin||''));
  if(!/^\d{4}$/.test(pin))throw httpErr(400,'Card PIN must be exactly 4 digits.');
  (await db.run('UPDATE cards SET card_pin_hash=? WHERE account_id=?', [bcrypt.hashSync(pin,12),req.account.id]));
  res.json({ok:true});
}));
app.post('/api/card/replace',auth,requireVerified,sensitiveWriteLimiter,wrap(async (req,res)=>{
  const cardState=await db.get('SELECT revoked FROM cards WHERE account_id=?',[req.account.id]);if(!cardState)throw httpErr(404,'No card has been issued to this account yet.');if(cardState.revoked)throw httpErr(410,'This card has been closed. Contact support to request a new card.');

  await verifyPin(req.user,String((req.body||{}).transaction_pin||''));
  const number=demoCardNumber(),cvv=String(crypto.randomInt(100,1000)),exp=new Date();exp.setFullYear(exp.getFullYear()+4);
  const expiry=String(exp.getMonth()+1).padStart(2,'0')+'/'+String(exp.getFullYear()).slice(2),last4=number.slice(-4);
  (await db.run('UPDATE cards SET last4=?,expiry=?,demo_number=?,demo_cvv=?,frozen=0,activated=0,card_pin_hash=NULL WHERE account_id=?', [last4,expiry,number,cvv,req.account.id]));
  await notifyUser(req.user.id,'Card replacement requested','Your demo card was replaced. Activate it and set a new card PIN.','security');
  res.json({ok:true,last4,expiry});
}));
app.post('/api/card/freeze', auth, requireVerified, wrap(async (req, res) => {
  const cardState=await db.get('SELECT revoked FROM cards WHERE account_id=?',[req.account.id]);if(!cardState)throw httpErr(404,'No card has been issued to this account yet.');if(cardState.revoked)throw httpErr(410,'This card has been closed.');

  const frozen = (req.body || {}).frozen ? 1 : 0;
  (await db.run('UPDATE cards SET frozen = ? WHERE account_id = ?', [frozen, req.account.id]));
  res.json({ ok: true, frozen: !!frozen });
}));

app.get('/api/meta', (req, res) => res.json({ billers: BILLERS, networks: NETWORKS }));
app.get('/api/admin/portal', adminAuth, (req, res) => {
  if (!ADMIN_PORTAL_PATH_VALID) return fail(res, 404, 'Not found.');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  const scriptPath = ADMIN_PORTAL_PATH + '.js';
  const securedHtml = html.replace(/src="\/admin\.js[^"]*"/, 'src="' + scriptPath + '?v=secure-admin-04"');
  res.set('Cache-Control', 'no-store, private');
  res.type('html').send(securedHtml);
});


/* ---------- device/session management ---------- */
app.get('/api/security/sessions',auth,wrap(async (req,res)=>{
  const sessions=(await db.all('SELECT jti,user_agent,created_at,last_seen_at,expires_at,revoked_at FROM user_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 50', [req.user.id]))
    .map(s=>({id:s.jti,device:s.user_agent||'Unknown device',created_at:s.created_at,last_seen_at:s.last_seen_at,expires_at:s.expires_at,revoked:!!s.revoked_at,current:s.jti===req.sessionJti}));
  res.json({sessions});
}));
app.post('/api/security/sessions/:id/revoke',auth,sensitiveWriteLimiter,wrap(async (req,res)=>{
  const id=String(req.params.id||'');if(!/^[0-9a-f-]{36}$/i.test(id))throw httpErr(400,'Invalid session.');
  const result=(await db.run('UPDATE user_sessions SET revoked_at=? WHERE jti=? AND user_id=? AND revoked_at IS NULL', [now(),id,req.user.id]));
  if(!result.changes)throw httpErr(404,'Session not found or already revoked.');
  res.json({ok:true,current:id===req.sessionJti});
}));
app.post('/api/security/sessions/revoke-others',auth,sensitiveWriteLimiter,wrap(async (req,res)=>{
  (await db.run('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND jti<>?', [now(),req.user.id,req.sessionJti||'']));
  res.json({ok:true});
}));
/* ---------- customer controls and service features ---------- */
async function notifyUser(userId,title,message,category='account'){
  if(!userId)return;
  (await db.run('INSERT INTO notifications (user_id,title,message,category,created_at) VALUES (?,?,?,?,?)', [userId,String(title).slice(0,100),String(message).slice(0,500),category,now()]));
}
async function getUserAccount(userId){return (await db.get("SELECT * FROM accounts WHERE user_id=? AND kind='user'", [userId]));}
async function transferDailyTotal(userId){
  const start=new Date();start.setHours(0,0,0,0);
  return (await db.get("SELECT COALESCE(SUM(-amount),0) total FROM transactions WHERE account_id=(SELECT id FROM accounts WHERE user_id=? AND kind='user') AND type IN ('transfer_out','external_transfer_pending') AND created_at>=?", [userId,start.getTime()])).total;
}
async function processDueTransfers(userId){
  const due=(await db.all("SELECT * FROM scheduled_transfers WHERE user_id=? AND status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 10", [userId,now()]));
  for(const item of due){
    try{
      const cap=(await db.get('SELECT daily_transfer_limit FROM account_limits WHERE user_id=?', [userId]));
      const owner=(await db.get('SELECT kyc_tier FROM users WHERE id=?', [userId]));
      const dailyCap=Math.min(cap?cap.daily_transfer_limit:500000,kyc.tierOf(owner).daily_transfer);
      if(item.amount>dailyCap||(await transferDailyTotal(userId))+item.amount>dailyCap)throw new Error('Daily transfer limit exceeded.');
      const dest=(await db.get("SELECT a.*,u.full_name FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.account_number=? AND a.kind='user'", [item.recipient_account]));
      const src=await getUserAccount(userId);
      if(!dest||!src)throw new Error('Recipient account unavailable.');
      const amount=item.amount;
      const out=(await db.tx(async ()=>(await move({from:src,to:dest,amount,typeOut:'transfer_out',typeIn:'transfer_in',counterOut:dest.full_name,counterIn:(await db.get('SELECT full_name FROM users WHERE id=?', [userId])).full_name,note:'acct:'+dest.account_number+(item.note?'|'+item.note:'')}))));
      (await db.run("UPDATE scheduled_transfers SET status='completed',processed_at=? WHERE id=? AND status='scheduled'", [now(),item.id]));
      await notifyUser(userId,'Scheduled transfer completed','Your scheduled transfer to '+dest.full_name+' was completed.','transfer');
    }catch(e){
      (await db.run("UPDATE scheduled_transfers SET status='failed',processed_at=?,failure_reason=? WHERE id=? AND status='scheduled'", [now(),String(e.message||'Transfer failed').slice(0,200),item.id]));
      await notifyUser(userId,'Scheduled transfer failed','A scheduled transfer could not be completed. Review your scheduled transfers.','transfer');
    }
  }
}
app.get('/api/notifications',auth,wrap(async (req,res)=>{
  const rows=(await db.all('SELECT id,title,message,category,is_read,created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100', [req.user.id]));
  res.json({notifications:rows,unread:rows.filter(x=>!x.is_read).length});
}));
app.post('/api/notifications/:id/read',auth,wrap(async (req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw httpErr(400,'Invalid notification.');
  (await db.run('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', [id,req.user.id]));res.json({ok:true});
}));
app.post('/api/notifications/read-all',auth,wrap(async (req,res)=>{
  (await db.run('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.user.id]));res.json({ok:true});
}));
app.get('/api/beneficiaries/saved',auth,wrap(async (req,res)=>{
  res.json({beneficiaries:(await db.all('SELECT id,account_number,display_name,created_at FROM saved_beneficiaries WHERE user_id=? ORDER BY id DESC', [req.user.id]))});
}));
app.post('/api/beneficiaries/saved',auth,requireVerified,sensitiveWriteLimiter,wrap(async (req,res)=>{
  const number=String((req.body||{}).account_number||'').trim(),name=String((req.body||{}).display_name||'').trim().slice(0,80);
  if(!/^\d{10}$/.test(number)||name.length<2)throw httpErr(400,'Enter a valid account number and recipient name.');
  const recipient=(await db.get("SELECT a.id,u.full_name FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.account_number=? AND a.kind='user'", [number]));
  if(!recipient||recipient.id===req.account.id)throw httpErr(404,'Recipient account not found.');
  (await db.run('INSERT OR IGNORE INTO saved_beneficiaries (user_id,account_number,display_name,created_at) VALUES (?,?,?,?)', [req.user.id,number,name||recipient.full_name,now()]));
  res.status(201).json({ok:true});
}));
app.delete('/api/beneficiaries/saved/:id',auth,wrap(async (req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw httpErr(400,'Invalid recipient.');
  (await db.run('DELETE FROM saved_beneficiaries WHERE id=? AND user_id=?', [id,req.user.id]));res.json({ok:true});
}));
app.get('/api/account/limits',auth,wrap(async (req,res)=>{
  let row=(await db.get('SELECT daily_transfer_limit,daily_payment_limit,updated_at FROM account_limits WHERE user_id=?', [req.user.id]));
  if(!row){(await db.run('INSERT OR IGNORE INTO account_limits (user_id,updated_at) VALUES (?,?)', [req.user.id,now()]));row=(await db.get('SELECT daily_transfer_limit,daily_payment_limit,updated_at FROM account_limits WHERE user_id=?', [req.user.id]));}
  res.json({limits:row,transfer_used:(await transferDailyTotal(req.user.id))});
}));
app.put('/api/account/limits',auth,requireVerified,sensitiveWriteLimiter,wrap(async (req,res)=>{
  const b=req.body||{},transfer=Number(b.daily_transfer_limit),payment=Number(b.daily_payment_limit);
  if(!Number.isSafeInteger(transfer)||transfer<10000||transfer>50000000||!Number.isSafeInteger(payment)||payment<10000||payment>10000000)throw httpErr(400,'Set valid daily limits within the allowed range.');
  (await db.run('INSERT INTO account_limits (user_id,daily_transfer_limit,daily_payment_limit,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET daily_transfer_limit=excluded.daily_transfer_limit,daily_payment_limit=excluded.daily_payment_limit,updated_at=excluded.updated_at', [req.user.id,transfer,payment,now()]));
  res.json({ok:true});
}));
app.get('/api/transfers/scheduled',auth,wrap(async (req,res)=>{
  res.json({transfers:(await db.all('SELECT id,recipient_account,recipient_name,amount,note,scheduled_at,status,created_at,processed_at,failure_reason FROM scheduled_transfers WHERE user_id=? ORDER BY scheduled_at DESC LIMIT 100', [req.user.id]))});
}));
app.post('/api/transfers/scheduled',auth,requireVerified,moneyLimiter,wrap(async (req,res)=>{
  const b=req.body||{},number=String(b.to_account||''),amount=cents(b.amount),when=Date.parse(String(b.scheduled_at||'')),note=String(b.note||'').replace(/[|\r\n]/g,' ').slice(0,60);
  if(!/^\d{10}$/.test(number)||!amount||amount>100000000||!Number.isFinite(when)||when<now()+5*60*1000||when>now()+365*24*60*60*1000)throw httpErr(400,'Enter a recipient, valid amount, and schedule time at least 5 minutes from now and within one year.');
  await verifyPin(req.user,String(b.pin||''));
  const dest=(await db.get("SELECT a.id,u.full_name FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.account_number=? AND a.kind='user'", [number]));
  if(!dest||dest.id===req.account.id)throw httpErr(404,'Recipient account not found.');
  const lim=(await db.get('SELECT daily_transfer_limit FROM account_limits WHERE user_id=?', [req.user.id]));
  if(lim&&amount>lim.daily_transfer_limit)throw httpErr(422,'Amount exceeds your configured transfer limit.');
  if(amount>kyc.tierOf(req.user).per_transaction)throw httpErr(422,'This amount is above the limit for your verification level.');
  const id=(await db.run("INSERT INTO scheduled_transfers (user_id,recipient_account,recipient_name,amount,note,scheduled_at,created_at) VALUES (?,?,?,?,?,?,?)", [req.user.id,number,dest.full_name,amount,note,when,now()])).lastInsertRowid;
  await notifyUser(req.user.id,'Transfer scheduled','Your transfer to '+dest.full_name+' is scheduled.','transfer');
  res.status(201).json({ok:true,id});
}));
app.post('/api/transfers/scheduled/:id/cancel',auth,wrap(async (req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw httpErr(400,'Invalid scheduled transfer.');
  const result=(await db.run("UPDATE scheduled_transfers SET status='cancelled' WHERE id=? AND user_id=? AND status='scheduled'", [id,req.user.id]));
  if(!result.changes)throw httpErr(404,'Scheduled transfer not found or already processed.');
  res.json({ok:true});
}));
app.get('/api/disputes',auth,wrap(async (req,res)=>{
  res.json({disputes:(await db.all('SELECT id,transaction_id,reason,details,status,created_at,updated_at FROM disputes WHERE user_id=? ORDER BY id DESC LIMIT 100', [req.user.id]))});
}));
app.post('/api/disputes',auth,requireVerified,sensitiveWriteLimiter,wrap(async (req,res)=>{
  const b=req.body||{},txId=Number(b.transaction_id),reason=String(b.reason||''),details=String(b.details||'').trim().slice(0,1500);
  if(!Number.isSafeInteger(txId)||txId<1||!['unauthorized','incorrect_amount','duplicate','not_received','other'].includes(reason)||details.length<10)throw httpErr(400,'Choose a dispute reason and provide at least 10 characters of detail.');
  const tx=(await db.get('SELECT id FROM transactions WHERE id=? AND account_id=?', [txId,req.account.id]));
  if(!tx)throw httpErr(404,'Transaction not found on your account.');
  try{(await db.run("INSERT INTO disputes (user_id,transaction_id,reason,details,created_at,updated_at) VALUES (?,?,?,?,?,?)", [req.user.id,txId,reason,details,now(),now()]));}
  catch(e){if(e.code==='23505')throw httpErr(409,'A dispute already exists for this transaction.');throw e;}
  await notifyUser(req.user.id,'Transaction dispute submitted','Your dispute was submitted for review.','support');
  res.status(201).json({ok:true});
}));

kyc.mount(app, { db, auth, adminAuth, wrap, httpErr, sealKyc, unsealKyc, auditAdmin, notifyUser, limiter: sensitiveWriteLimiter, now });

app.use('/api', (req, res) => fail(res, 404, 'Not found.'));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') return fail(res, 413, 'Request body is too large.');
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) return fail(res, 400, 'Malformed JSON request.');
  console.error('Unhandled request error:', err && err.message ? err.message : 'unknown');
  return fail(res, 500, 'Something went wrong. Please try again.');
});

// ---------- static frontend ----------
app.get('/admin.html', (req, res) => res.status(404).send('Not found.'));
app.get('/admin.js', (req, res) => res.status(404).send('Not found.'));

if (ADMIN_PORTAL_PATH_VALID) {
  app.get(ADMIN_PORTAL_PATH, (req, res) => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    const scriptPath = ADMIN_PORTAL_PATH + '.js';
    const securedHtml = html.replace(/src="\/admin\.js[^"]*"/, 'src="' + scriptPath + '?v=secure-admin-04"');
    res.set('Cache-Control', 'no-store, private');
    res.type('html').send(securedHtml);
  });
  app.get(ADMIN_PORTAL_PATH + '.js', (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.js'));
  });
}

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: PROD ? '1h' : 0 }));

if (require.main === module) {
  db.ready.then(() => app.listen(PORT, () => console.log(`Prime Trust Bank running on http://localhost:${PORT}`)))
    .catch((e) => { console.error('Database startup failed:', e.message); process.exit(1); });
}
module.exports = app;
