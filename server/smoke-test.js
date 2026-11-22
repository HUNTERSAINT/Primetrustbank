// End-to-end API check on a throwaway database. Run: npm test
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'ptb-test-' + Date.now() + '.db');
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@primetrust.test';
process.env.ADMIN_PASSWORD = 'test-admin-password';
const assert = require('assert');
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

  const registrationKycA = { legal_name: 'Ada Okafor', date_of_birth: '1995-05-12', address: '12 Example Street, Lagos, Nigeria', id_type: 'Passport', id_front: 'data:image/jpeg;base64,AA==', id_back: '', selfie: '' };
  const registrationKycB = { ...registrationKycA, legal_name: 'Tolu Bello' };
  r = await a('POST', '/api/auth/register', { email: 'ada@example.com', full_name: 'Ada Okafor', password: 'longpassword1', pin: '1234', ...registrationKycA });
  assert.equal(r.status, 201, 'register a with KYC');
  r = await b('POST', '/api/auth/register', { email: 'tolu@example.com', full_name: 'Tolu Bello', password: 'longpassword2', pin: '4321', ...registrationKycB });
  assert.equal(r.status, 201, 'register b with KYC');
  // Identity review is required before any banking action.
  r = await a('POST', '/api/deposit', { amount: 20 });
  assert.equal(r.status, 403, 'pending user cannot use banking actions');
  const verification = { legal_name: 'Ada Okafor', date_of_birth: '1995-05-12', address: '12 Example Street, Lagos, Nigeria', id_type: 'Passport', id_front: 'data:image/jpeg;base64,AA==', id_back: '', selfie: '' };
  r = await a('POST', '/api/verification/submit', verification);
  assert.equal(r.status, 200, 'submit identity for review');
  r = await b('POST', '/api/verification/submit', { ...verification, legal_name: 'Tolu Bello' });
  assert.equal(r.status, 200, 'submit second identity');
  r = await admin('POST', '/api/admin/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(r.status, 200, 'administrator login');
  const pending = (await admin('GET', '/api/admin/requests')).body.requests;
  assert.equal(pending.length, 2, 'admin sees pending requests');
  const dbForKyc = require('./db');
  const storedKyc = dbForKyc.prepare('SELECT vr.id_front_data FROM verification_requests vr JOIN users u ON u.id=vr.user_id WHERE u.email=?').get('ada@example.com');
  assert.ok(storedKyc && storedKyc.id_front_data.startsWith('enc:v'), 'identity documents encrypted at rest');
  const adaRequest = pending.find(x => x.email === 'ada@example.com');
  const viewedDocs = await admin('GET', '/api/admin/requests/' + adaRequest.id);
  assert.equal(viewedDocs.status, 200, 'admin can retrieve KYC documents');
  assert.equal(viewedDocs.body.documents.front, verification.id_front, 'KYC document decrypts for authorized review');
  for (const request of pending) {
    r = await admin('POST', '/api/admin/requests/' + request.id + '/review', { decision: 'approved', note: 'Test review passed' });
    assert.equal(r.status, 200, 'administrator approves identity');
  }
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
  assert.equal(r.body.balance, 50000 - 20050 - 2000, 'airtime debited');
  r = await a('POST', '/api/bills', { biller: 'Electricity', reference: 'MTR-12345', amount: 75, pin: '1234' });
  assert.equal(r.status, 200);
  r = await a('POST', '/api/card/freeze', { frozen: true });
  assert.equal(r.body.frozen, true);
  assert.equal((await a('GET', '/api/me')).body.card.frozen, true);

  // Ledger must balance: all account balances sum to zero across user + system accounts.
  const db = require('./db');
  const sum = db.prepare('SELECT SUM(balance) s FROM accounts').get().s;
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
