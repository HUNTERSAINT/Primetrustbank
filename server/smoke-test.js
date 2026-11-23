// End-to-end API check on a throwaway database. Run: npm test
process.env.PGLITE_DIR = 'memory'; // embedded Postgres, throwaway
delete process.env.DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.ALLOW_SANDBOX_FUNDING = 'true'; // isolated test database only
process.env.ADMIN_EMAIL = 'admin@primetrust.test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.RESEND_FROM_EMAIL = 'Prime Trust <mail@primetrustdigital.org>';
process.env.RESEND_REPLY_TO = 'reply@primetrustdigital.org';
const webhookKey = Buffer.from('support-webhook-test-secret-32-bytes').toString('base64');
process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + webhookKey;
process.env.RESEND_SUPPORT_INBOX_ID = 'support-inbox-test-id';
const sentEmails = [];
const emailCodes = Object.create(null);
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url).startsWith('https://api.resend.com/inboxes/')) {
    return new Response(JSON.stringify({data:{from:'Guest Customer <visitor@example.com>',to:['support@primetrustdigital.org'],subject:'Need support',text:'I cannot access my account.',headers:{'message-id':'<guest-inbox-1@example.com>'}}}),{status:200,headers:{'content-type':'application/json'}});
  }
  if (String(url).startsWith('https://api.resend.com/emails')) {
    const payload = JSON.parse(options.body || '{}');
    sentEmails.push(payload);
    const text = String(payload.text || '');
    const match = text.match(/(?:code is|code:)\s*(\d{6})/i);
    if (match && Array.isArray(payload.to) && payload.to[0]) emailCodes[String(payload.to[0]).toLowerCase()] = match[1];
    return new Response(JSON.stringify({ id: 'test-email-id' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, options);
};
const assert = require('assert');
const crypto = require('crypto');
const app = require('./index');

const server = app.listen(0);
const base = 'http://127.0.0.1:' + server.address().port;

function client() {
  const cookies = Object.create(null);
  return async (method, url, body, headers = {}) => {
    const cookie = Object.entries(cookies).map(([name, value]) => name + '=' + value).join('; ');
    const r = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : String(r.headers.get('set-cookie') || '').split(/,\\s*(?=ptb_)/);
    for (const line of set) {
      const pair = String(line).split(';')[0], eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq), value = pair.slice(eq + 1);
      if (!value || /Max-Age=0/i.test(line)) delete cookies[name];
      else cookies[name] = value;
    }
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}

(async () => {
  const a = client(), b = client(), admin = client();
  let r;

  const registrationKycA = { legal_name: 'Ada Okafor', date_of_birth: '1995-05-12', address: '12 Example Street, New York, NY 10001, United States', id_type: 'Passport', id_country: 'United States', id_number: 'A1234567', id_expiry: '2035-01-01', id_front: 'data:image/jpeg;base64,AA==', id_back: '', selfie: 'data:image/jpeg;base64,AA==' };
  const registrationKycB = { ...registrationKycA, legal_name: 'Tolu Bello' };
  r = await a('POST', '/api/auth/register', { email: 'ada@example.com', full_name: 'Ada Okafor', password: 'longpassword1', pin: '1234' });
  assert.equal(r.status, 201, 'register a and send email verification');
  r = await b('POST', '/api/auth/register', { email: 'tolu@example.com', full_name: 'Tolu Bello', password: 'longpassword2', pin: '4321' });
  assert.equal(r.status, 201, 'register b and send email verification');
  r = await a('POST', '/api/verification/submit', registrationKycA);
  assert.equal(r.status, 401, 'KYC cannot be submitted before email verification');
  r = await a('POST', '/api/auth/email-verification/confirm', { email:'ada@example.com', code:emailCodes['ada@example.com'] });
  assert.equal(r.status, 200, 'verify a email before KYC');
  r = await b('POST', '/api/auth/email-verification/confirm', { email:'tolu@example.com', code:emailCodes['tolu@example.com'] });
  assert.equal(r.status, 200, 'verify b email before KYC');

  async function inboundSupport(payload, eventId) {
    const raw=JSON.stringify(payload), timestamp=String(Math.floor(Date.now()/1000));
    const signature=crypto.createHmac('sha256',Buffer.from(webhookKey,'base64')).update(eventId+'.'+timestamp+'.'+raw).digest('base64');
    return fetch(base+'/api/webhooks/resend/inbound-support',{method:'POST',headers:{'content-type':'application/json','svix-id':eventId,'svix-timestamp':timestamp,'svix-signature':'v1,'+signature},body:raw});
  }
  let inbound=await inboundSupport({type:'email.received',data:{from:'Ada Okafor <ada@example.com>',to:['support@primetrustdigital.org'],subject:'My support request',text:'I need help with my account.',headers:{'message-id':'<ada-support-1@example.com>'}}},'evt-support-1');
  assert.equal(inbound.status,200,'incoming support email creates website chat');
  const supportSession=(await require('./db').get('SELECT * FROM support_sessions WHERE user_id=(SELECT id FROM users WHERE email=?)',['ada@example.com']));
  assert.ok(supportSession,'email support thread attaches to the customer account');
  assert.equal((await require('./db').get('SELECT COUNT(*) n FROM support_messages WHERE session_id=?',[supportSession.id])).n,1);
  inbound=await inboundSupport({type:'email.received',data:{from:'Ada Okafor <ada@example.com>',to:['support@primetrustdigital.org'],subject:'Re: [PT Support #'+supportSession.id+'] My support request',text:'Following up from email.',headers:{'message-id':'<ada-support-2@example.com>'}}},'evt-support-2');
  assert.equal(inbound.status,200,'customer email reply continues the same ticket');
  assert.equal((await require('./db').get('SELECT COUNT(*) n FROM support_messages WHERE session_id=?',[supportSession.id])).n,2,'email replies are appended to the existing chat');
  inbound=await inboundSupport({type:'inbox.email.received',data:{inbox_id:process.env.RESEND_SUPPORT_INBOX_ID,thread_id:'inbox-thread-guest',email_id:'inbox-email-guest',email:{from:'Guest Customer <visitor@example.com>',to:['support@primetrustdigital.org'],subject:'Need support',message_id:'<guest-inbox-1@example.com>'}}},'evt-support-inbox-guest');
  assert.equal(inbound.status,200,'Resend inbox received event creates a guest support chat');
  const guestSession=await require('./db').get('SELECT * FROM support_sessions WHERE contact_email=?',['visitor@example.com']);
  assert.ok(guestSession&&!guestSession.user_id,'email-only customer gets a guest chat session');
  assert.equal((await require('./db').get('SELECT COUNT(*) n FROM support_messages WHERE session_id=?',[guestSession.id])).n,1,'guest email body is retrieved and stored');
  // KYC input rules are checked only after email verification.
  const bad = async (patch, why) => { const x = await a('POST', '/api/verification/submit', { ...registrationKycA, ...patch }); assert.equal(x.status, 400, why + ' -> ' + JSON.stringify(x.body)); };
  await bad({ date_of_birth: new Date(Date.now() - 17 * 365.25 * 864e5).toISOString().slice(0, 10) }, 'under 18 rejected');
  await bad({ id_expiry: '2020-01-01' }, 'expired ID rejected');
  await bad({ id_number: '' }, 'ID number required');
  await bad({ selfie: '' }, 'selfie required');
  await bad({ id_type: 'Driver license' }, 'back of non-passport ID required');
  // Identity review is required before any banking action.
  r = await a('POST', '/api/deposit', { amount: 20 });
  assert.equal(r.status, 403, 'pending user cannot use banking actions');
  const verification = { ...registrationKycA };
  r = await a('POST', '/api/verification/submit', verification);
  assert.equal(r.status, 200, 'submit identity for review');
  r = await b('POST', '/api/verification/submit', { ...verification, legal_name: 'Tolu Bello' });
  assert.equal(r.status, 200, 'submit second identity');
  r = await admin('POST', '/api/admin/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(r.status, 200, 'administrator login');
  const supportList=(await admin('GET','/api/admin/chat/sessions')).body.sessions;
  assert.ok(supportList.some(x=>x.id===supportSession.id&&x.email==='ada@example.com'),'admin sees email-originated chat');
  assert.ok(supportList.some(x=>x.id===guestSession.id&&x.email==='visitor@example.com'),'admin sees guest email chat');
  r=await admin('POST','/api/admin/chat/sessions/'+guestSession.id+'/reply',{message:'Hello, we can help you.'});
  assert.equal(r.status,200,'admin can reply to guest email support');
  assert.equal(r.body.emailSent,true,'guest reply is sent by email');
  assert.ok(sentEmails.some(x=>x.to&&x.to[0]==='visitor@example.com'&&String(x.subject).includes('[PT Support #'+guestSession.id+']')),'guest support email contains ticket marker for reply threading');
  r=await admin('POST','/api/admin/chat/sessions/'+supportSession.id+'/reply',{message:'We received your request and are checking it.'});
  assert.equal(r.status,200,'admin reply is posted to chat');
  assert.equal(r.body.emailSent,true,'admin reply is also sent by email');
  assert.ok(sentEmails.some(x=>x.to&&x.to[0]==='ada@example.com'&&String(x.subject).includes('[PT Support #'+supportSession.id+']')&&x.reply_to&&x.reply_to[0]==='support@primetrustdigital.org'),'support reply email carries ticket reference and replies to support');
  assert.equal((await require('./db').get('SELECT COUNT(*) n FROM support_messages WHERE session_id=?',[supportSession.id])).n,3,'admin reply is recorded in chat');
  const pending = (await admin('GET', '/api/admin/requests')).body.requests;
  assert.equal(pending.length, 2, 'admin sees pending requests');
  const dbForKyc = require('./db');
  const storedKyc = await dbForKyc.get('SELECT vr.id_front_data FROM verification_requests vr JOIN users u ON u.id=vr.user_id WHERE u.email=?', ['ada@example.com']);
  assert.ok(storedKyc && storedKyc.id_front_data.startsWith('enc:v'), 'identity documents encrypted at rest');
  const storedNo = await dbForKyc.get('SELECT id_number_enc, id_last4 FROM verification_requests vr JOIN users u ON u.id=vr.user_id WHERE u.email=?', ['ada@example.com']);
  assert.ok(storedNo.id_number_enc.startsWith('enc:v') && !storedNo.id_number_enc.includes('A1234567'), 'ID number encrypted at rest');
  assert.equal(storedNo.id_last4, '4567');
  const adaRequest = pending.find(x => x.email === 'ada@example.com');
  const viewedDocs = await admin('GET', '/api/admin/requests/' + adaRequest.id);
  assert.equal(viewedDocs.status, 200, 'admin can retrieve KYC documents');
  assert.equal(viewedDocs.body.documents.front, verification.id_front, 'KYC document decrypts for authorized review');
  assert.equal(viewedDocs.body.id_number, 'A1234567', 'ID number decrypts for authorized review');
  const toluRequest = pending.find(x => x.email === 'tolu@example.com');
  r = await admin('POST', '/api/admin/requests/' + toluRequest.id + '/review', { decision: 'rejected', note: '' });
  assert.equal(r.status, 400, 'rejection needs a reason');
  r = await admin('POST', '/api/admin/requests/' + toluRequest.id + '/review', { decision: 'approved', tier: 2 });
  assert.equal(r.status, 400, 'level 2 needs proof of address');
  r = await admin('POST', '/api/admin/requests/' + toluRequest.id + '/review', { decision: 'rejected', note: 'Photo is blurry' });
  assert.equal(r.status, 200, 'rejected with reason');
  r = await b('POST', '/api/transfers', { to_account: '1234567890', amount: 1, pin: '4321' });
  assert.equal(r.status, 403, 'rejected customer cannot bank');
  r = await b('POST', '/api/verification/submit', { ...registrationKycB, proof_address: 'data:image/jpeg;base64,AA==' });
  assert.equal(r.status, 200, 'customer resubmits after rejection');
  const toluRequest2 = (await admin('GET', '/api/admin/requests')).body.requests.find(x => x.email === 'tolu@example.com');
  assert.equal(toluRequest2.has_proof, true);
  r = await admin('POST', '/api/admin/requests/' + adaRequest.id + '/review', { decision: 'approved', tier: 1, note: 'Test review passed' });
  assert.equal(r.status, 200, 'administrator approves identity at level 1');
  r = await admin('POST', '/api/admin/requests/' + toluRequest2.id + '/review', { decision: 'approved', tier: 2 });
  assert.equal(r.status, 200, 'administrator approves identity at level 2');
  r = await admin('POST', '/api/admin/impersonate/' + adaRequest.user_id, {});
  assert.equal(r.status, 200, 'admin can login as customer');
  const impersonatedMe = await admin('GET', '/api/me');
  assert.equal(impersonatedMe.status, 200, 'impersonated customer session works');
  assert.equal(impersonatedMe.body.email, 'ada@example.com', 'admin is viewing the selected customer');
  const impersonationStatus = await admin('GET', '/api/impersonation/status');
  assert.equal(impersonationStatus.body.active, true, 'impersonation banner status is active');
  r = await admin('POST', '/api/admin/impersonate-return', {});
  assert.equal(r.status, 200, 'admin can return from customer session');
  r = await admin('GET', '/api/me');
  assert.equal(r.status, 401, 'customer session is cleared after returning to admin');
  r = await a('POST', '/api/auth/register', { email: 'ada@example.com', full_name: 'Dup', password: 'longpassword1', pin: '1234' });
  assert.equal(r.status, 409, 'duplicate email rejected');
  r = await client()('GET', '/api/me');
  assert.equal(r.status, 401, 'me needs login');

  const meA = (await a('GET', '/api/me')).body, meB = (await b('GET', '/api/me')).body;
  assert.equal(meA.account.balance, 0);
  assert.match(meB.account.number, /^\d{10}$/);

  r = await a('POST', '/api/deposit', { amount: 500 });
  assert.equal(r.body.balance, 50000, 'deposit 500.00');
  r = await a('POST', '/api/deposit', { amount: 5000 });
  assert.equal(r.status, 400, 'sandbox deposit cap');

  r = await a('POST', '/api/transfers', { to_account: meB.account.number, amount: 200, pin: '0000' });
  assert.equal(r.status, 403, 'wrong PIN rejected');
  r = await a('POST', '/api/transfers', { to_account: meB.account.number, amount: 900, pin: '1234' });
  assert.equal(r.status, 422, 'overdraft rejected');
  r = await a('POST', '/api/transfers', { to_account: meA.account.number, amount: 10, pin: '1234' });
  assert.equal(r.status, 400, 'self transfer rejected');
  r = await a('POST', '/api/transfers', { to_account: meB.account.number, amount: 0.001, pin: '1234' });
  assert.equal(r.status, 400, 'sub-cent amount rejected');

  const key = 'idem-key-12345678';
  r = await a('POST', '/api/transfers', { to_account: meB.account.number, amount: 200.5, pin: '1234', note: 'lunch' }, { 'Idempotency-Key': key });
  assert.equal(r.status, 200); assert.equal(r.body.balance, 50000 - 20050, 'transfer debits sender');
  r = await a('POST', '/api/transfers', { to_account: meB.account.number, amount: 200.5, pin: '1234', note: 'lunch' }, { 'Idempotency-Key': key });
  assert.equal(r.body.balance, 50000 - 20050, 'retry with same key does not double-charge');

  assert.equal((await b('GET', '/api/me')).body.account.balance, 20050, 'receiver credited');
  const txB = (await b('GET', '/api/transactions')).body.transactions;
  assert.equal(txB[0].type, 'transfer_in'); assert.equal(txB[0].note, 'lunch');

  r = await a('GET', '/api/beneficiaries');
  assert.equal(r.body.beneficiaries[0].account_number, meB.account.number);

  r = await a('POST', '/api/airtime', { network: 'MTN', phone: '08012345678', amount: 20, pin: '1234' });
  assert.equal(r.status, 404, 'airtime feature removed');
  r = await a('POST', '/api/bills', { biller: 'Electricity', reference: 'MTR-12345', amount: 75, pin: '1234' });
  assert.equal(r.status, 200);
  assert.equal((await a('GET', '/api/me')).body.card, null, 'card is not auto-issued');

  r = await a('POST', '/api/deposit', { amount: 1000 });
  r = await a('POST', '/api/deposit', { amount: 1000 });
  r = await a('POST', '/api/transfers', { to_account: meB.account.number, amount: 1200, pin: '1234' });
  assert.equal(r.status, 422, 'level 1 per-transaction cap enforced');
  r = await a('POST', '/api/verification/upgrade', { proof_address: 'data:image/jpeg;base64,AA==' });
  assert.equal(r.status, 200, 'customer uploads proof of address');
  r = await a('POST', '/api/verification/upgrade', { proof_address: 'data:image/jpeg;base64,AA==' });
  assert.equal(r.status, 409, 'second upload while pending is refused');
  const up = (await admin('GET', '/api/admin/requests?status=upgrade')).body.requests;
  assert.equal(up.length, 1, 'upgrade shows in the review queue');
  r = await admin('POST', '/api/admin/requests/' + up[0].id + '/upgrade-review', { decision: 'approved' });
  assert.equal(r.status, 200, 'upgrade approved');
  assert.equal((await a('GET', '/api/me')).body.kyc_tier, 2, 'customer is level 2');
  r = await a('POST', '/api/transfers', { to_account: meB.account.number, amount: 1200, pin: '1234' });
  assert.equal(r.status, 200, 'level 2 allows the larger transfer ' + JSON.stringify(r.body));
  // Ledger must balance: all account balances sum to zero across user + system accounts.
  const db = require('./db');
  const sum = (await db.get('SELECT SUM(balance) s FROM accounts')).s;
  assert.equal(sum, 0, 'ledger sums to zero');

  // Lockout after repeated bad logins
  const c = client();
  for (let i = 0; i < 5; i++) await c('POST', '/api/auth/login', { email: 'tolu@example.com', password: 'wrong-password' });
  r = await c('POST', '/api/auth/login', { email: 'tolu@example.com', password: 'longpassword2' });
  assert.equal(r.status, 429, 'locked after 5 bad logins');

  r = await a('POST', '/api/transfers', { to_account: meB.account.number, amount: 1, pin: '1234' }, { Origin: 'https://attacker.example' });
  assert.equal(r.status, 403, 'cross-origin financial write blocked');
  r = await fetch(base + '/api/transfers', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415, 'non-JSON posts rejected');

  r = await admin('POST', '/api/admin/logout', {});
  assert.equal(r.status, 200, 'administrator logout');
  r = await admin('GET', '/api/admin/overview');
  assert.equal(r.status, 401, 'administrator session revoked on logout');
  r = await a('POST', '/api/auth/logout', {});
  assert.equal(r.status, 200, 'customer logout');
  r = await a('GET', '/api/me');
  assert.equal(r.status, 401, 'customer session revoked on logout');
  console.log('All checks passed.');
  server.close(); process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); server.close(); process.exit(1); });
