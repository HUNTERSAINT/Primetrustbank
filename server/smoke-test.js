// End-to-end API check on a throwaway database. Run: npm test
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'ptb-test-' + Date.now() + '.db');
process.env.NODE_ENV = 'test';\nprocess.env.ADMIN_EMAIL = 'admin@primetrust.test';\nprocess.env.ADMIN_PASSWORD = 'test-admin-password';
const assert = require('assert');
const app = require('./index');

const server = app.listen(0);
const base = 'http://127.0.0.1:' + server.address().port;

function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}

(async () => {
  const a = client(), b = client(), admin = client();
  let r;

  r = await a('POST', '/api/auth/register', { email: 'ada@example.com', full_name: 'Ada Okafor', password: 'longpassword1', pin: '1234' });
  assert.equal(r.status, 201, 'register a');
  r = await b('POST', '/api/auth/register', { email: 'tolu@example.com', full_name: 'Tolu Bello', password: 'longpassword2', pin: '4321' });
  assert.equal(r.status, 201, 'register b');
  // Identity review is required before any banking action.
  r = await a('POST', '/api/deposit', { amount: 20 });
  assert.equal(r.status, 403, 'pending user cannot use banking actions');
  const verification = { legal_name: 'Ada Okafor', date_of_birth: '1995-05-12', address: '12 Example Street, Lagos, Nigeria', id_type: 'Passport' };
  r = await a('POST', '/api/verification/submit', verification);
  assert.equal(r.status, 200, 'submit identity for review');
  r = await b('POST', '/api/verification/submit', { ...verification, legal_name: 'Tolu Bello' });
  assert.equal(r.status, 200, 'submit second identity');
  r = await admin('POST', '/api/admin/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(r.status, 200, 'administrator login');
  const pending = (await admin('GET', '/api/admin/requests')).body.requests;
  assert.equal(pending.length, 2, 'admin sees pending requests');
  for (const request of pending) {
    r = await admin('POST', '/api/admin/requests/' + request.id + '/review', { decision: 'approved', note: 'Test review passed' });
    assert.equal(r.status, 200, 'administrator approves identity');
  }
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

  r = await fetch(base + '/api/transfers', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415, 'non-JSON posts rejected');

  console.log('All checks passed.');
  server.close(); process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); server.close(); process.exit(1); });
