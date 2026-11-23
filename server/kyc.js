// Customer identity verification (KYC): input checks, tiers, and the customer + administrator routes.
// Sensitive values (document images, ID number) are encrypted by the caller-supplied sealKyc before storage.

// Amounts are in cents.
const TIERS = {
  0: { name: 'Unverified', per_transaction: 0, daily_transfer: 0, daily_payment: 0 },
  1: { name: 'Basic',      per_transaction: 100000,  daily_transfer: 200000,  daily_payment: 50000 },
  2: { name: 'Enhanced',   per_transaction: 2500000, daily_transfer: 5000000, daily_payment: 500000 }
};
const tierOf = (user) => TIERS[Math.min(2, Math.max(0, Number(user && user.kyc_tier) || 0))];

const ID_TYPES = ['Passport', 'Driver license', 'National identity card', 'Other government ID'];

function isRealDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
}
function ageOn(dob, today) {
  const d = new Date(dob + 'T00:00:00Z'), t = new Date(today + 'T00:00:00Z');
  let age = t.getUTCFullYear() - d.getUTCFullYear();
  const m = t.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && t.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
function validImage(value, required) {
  if (!value) return !required;
  if (value.length > 1500000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const data = value.slice(value.indexOf(',') + 1);
  return data.length > 0 && Buffer.from(data, 'base64').length <= 1100000;
}

// Validates and normalises the KYC part of a request body. Throws a 400 through `httpErr` when something is wrong.
function parseKyc(b, httpErr) {
  b = b || {};
  const s = (k) => String(b[k] == null ? '' : b[k]).trim();
  const today = new Date().toISOString().slice(0, 10);
  const out = {
    legal_name: s('legal_name'), date_of_birth: s('date_of_birth'), address: s('address'), id_type: s('id_type'),
    id_country: s('id_country'), id_number: s('id_number').replace(/\s+/g, ' '), id_expiry: s('id_expiry'),
    id_front: String(b.id_front || ''), id_back: String(b.id_back || ''), selfie: String(b.selfie || ''),
    proof_address: String(b.proof_address || '')
  };
  if (out.legal_name.length < 2 || out.legal_name.length > 100) throw httpErr(400, 'Enter your legal name.');
  if (!isRealDate(out.date_of_birth)) throw httpErr(400, 'Enter a valid date of birth.');
  if (out.date_of_birth > today) throw httpErr(400, 'Date of birth cannot be in the future.');
  const age = ageOn(out.date_of_birth, today);
  if (age < 18) throw httpErr(400, 'You must be at least 18 years old to open an account.');
  if (age > 120) throw httpErr(400, 'Enter a valid date of birth.');
  if (out.address.length < 8 || out.address.length > 250) throw httpErr(400, 'Enter your residential address.');
  if (!ID_TYPES.includes(out.id_type)) throw httpErr(400, 'Choose a valid ID type.');
  if (!/^[A-Za-z][A-Za-z .'-]{1,55}$/.test(out.id_country)) throw httpErr(400, 'Enter the country that issued your ID.');
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{3,29}$/.test(out.id_number)) throw httpErr(400, 'Enter your ID number exactly as printed on the document (4 to 30 letters or digits).');
  if (!isRealDate(out.id_expiry)) throw httpErr(400, 'Enter the expiry date of your ID.');
  if (out.id_expiry <= today) throw httpErr(400, 'This ID has expired. Use a valid, unexpired ID.');
  if (out.id_expiry > '2100-01-01') throw httpErr(400, 'Enter a valid ID expiry date.');
  if (!validImage(out.id_front, true)) throw httpErr(400, 'Upload a clear photo of the front of your ID (JPG, PNG or WebP, under 1.1 MB).');
  if (!validImage(out.id_back, out.id_type !== 'Passport')) throw httpErr(400, out.id_type === 'Passport' ? 'The back-of-ID photo is not valid.' : 'Upload a clear photo of the back of your ID.');
  if (!validImage(out.selfie, true)) throw httpErr(400, 'Upload a clear selfie of your face (JPG, PNG or WebP, under 1.1 MB).');
  if (!validImage(out.proof_address, false)) throw httpErr(400, 'The proof of address must be a JPG, PNG or WebP photo under 1.1 MB.');
  return out;
}

// Inserts or replaces the customer's verification request (a rejected customer can resubmit).
async function saveRequest(db, sealKyc, userId, d, t) {
  const idLast4 = d.id_number.replace(/[^A-Za-z0-9]/g, '').slice(-4);
  await db.run(`INSERT INTO verification_requests
      (user_id, legal_name, date_of_birth, address, id_type, review_status, submitted_at,
       id_front_data, id_back_data, selfie_data, id_number_enc, id_last4, id_country, id_expiry, proof_address_data)
    VALUES (?,?,?,?,?,'submitted',?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET legal_name=excluded.legal_name, date_of_birth=excluded.date_of_birth,
      address=excluded.address, id_type=excluded.id_type, id_front_data=excluded.id_front_data,
      id_back_data=excluded.id_back_data, selfie_data=excluded.selfie_data, id_number_enc=excluded.id_number_enc,
      id_last4=excluded.id_last4, id_country=excluded.id_country, id_expiry=excluded.id_expiry,
      proof_address_data=excluded.proof_address_data, review_status='submitted', admin_note=NULL,
      submitted_at=excluded.submitted_at, reviewed_at=NULL, upgrade_status=NULL, upgrade_note=NULL`,
  [userId, d.legal_name, d.date_of_birth, d.address, d.id_type, t,
    sealKyc(d.id_front), sealKyc(d.id_back || null), sealKyc(d.selfie), sealKyc(d.id_number), idLast4,
    d.id_country, d.id_expiry, sealKyc(d.proof_address || null)]);
}

function mount(app, x) {
  const { db, auth, adminAuth, wrap, httpErr, sealKyc, unsealKyc, auditAdmin, notifyUser, notifyAdminAction, limiter, now } = x;
  const idParam = (req) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw httpErr(400, 'Invalid identity request.');
    return id;
  };

  // ----- customer -----
  app.post('/api/verification/submit', auth, limiter, wrap(async (req, res) => {
    if (req.user.verification_status === 'approved') throw httpErr(409, 'Your identity is already verified.');
    const d = parseKyc(req.body, httpErr);
    const t = now();
    await db.tx(async () => {
      await saveRequest(db, sealKyc, req.user.id, d, t);
      await db.run("UPDATE users SET verification_status='submitted', verification_submitted_at=?, kyc_tier=0 WHERE id=?", [t, req.user.id]);
    });
    void notifyAdminAction('Identity verification pending review','Customer: '+req.user.full_name+' ('+req.user.email+')\nVerification request submitted. Please review the identity documents in the administrator portal.');
    res.json({ ok: true, verification_status: 'submitted' });
  }));

  app.post('/api/verification/upgrade', auth, limiter, wrap(async (req, res) => {
    if (req.user.verification_status !== 'approved') throw httpErr(403, 'Complete basic verification first.');
    if (req.user.kyc_tier >= 2) throw httpErr(409, 'Your account already has the highest verification level.');
    const proof = String((req.body || {}).proof_address || '');
    if (!proof || !validImage(proof, true)) throw httpErr(400, 'Upload a clear photo of a recent utility bill or bank statement (JPG, PNG or WebP, under 1.1 MB).');
    const row = await db.get('SELECT upgrade_status FROM verification_requests WHERE user_id=?', [req.user.id]);
    if (row && row.upgrade_status === 'submitted') throw httpErr(409, 'Your proof of address is already waiting for review.');
    const t = now();
    await db.run("UPDATE verification_requests SET proof_address_data=?, upgrade_status='submitted', upgrade_submitted_at=?, upgrade_reviewed_at=NULL, upgrade_note=NULL WHERE user_id=?", [sealKyc(proof), t, req.user.id]);
    void notifyAdminAction('Proof of address pending review','Customer: '+req.user.full_name+' ('+req.user.email+')\nThe customer submitted proof of address for verification level upgrade. Please review it in the administrator portal.');
    res.json({ ok: true, upgrade_status: 'submitted' });
  }));

  app.get('/api/verification/status', auth, wrap(async (req, res) => {
    const v = await db.get(`SELECT review_status, admin_note, id_type, id_country, id_last4, id_expiry, submitted_at, reviewed_at,
      upgrade_status, upgrade_note FROM verification_requests WHERE user_id=?`, [req.user.id]);
    res.json({
      status: req.user.verification_status, tier: req.user.kyc_tier, tier_name: tierOf(req.user).name,
      tiers: TIERS, request: v || null
    });
  }));

  // ----- administrator -----
  app.get('/api/admin/requests', adminAuth, wrap(async (req, res) => {
    const status = String(req.query.status || 'submitted');
    if (!['all', 'submitted', 'approved', 'rejected', 'upgrade'].includes(status)) throw httpErr(400, 'Invalid verification status.');
    const where = status === 'all' ? '1=1' : status === 'upgrade' ? "vr.upgrade_status = 'submitted'" : 'vr.review_status = ?';
    const args = ['all', 'upgrade'].includes(status) ? [] : [status];
    const rows = await db.all(`SELECT vr.id, vr.user_id, vr.legal_name, vr.date_of_birth, vr.address, vr.id_type, vr.id_country,
      vr.id_last4, vr.id_expiry, vr.review_status, vr.admin_note, vr.submitted_at, vr.reviewed_at, vr.upgrade_status,
      vr.upgrade_submitted_at, (vr.proof_address_data IS NOT NULL) AS has_proof, u.email, u.full_name, u.kyc_tier
      FROM verification_requests vr JOIN users u ON u.id = vr.user_id
      WHERE ${where} ORDER BY vr.submitted_at DESC LIMIT 200`, args);
    res.json({ requests: rows.map((r) => ({ ...r, has_proof: !!r.has_proof })) });
  }));

  app.get('/api/admin/requests/:id', adminAuth, wrap(async (req, res) => {
    const id = idParam(req);
    const r = await db.get(`SELECT id, user_id, id_front_data, id_back_data, selfie_data, proof_address_data, id_number_enc
      FROM verification_requests WHERE id=?`, [id]);
    if (!r) throw httpErr(404, 'Identity request not found.');
    const documents = {
      front: unsealKyc(r.id_front_data), back: unsealKyc(r.id_back_data), selfie: unsealKyc(r.selfie_data),
      proof: unsealKyc(r.proof_address_data)
    };
    await auditAdmin(req, 'KYC_DOCUMENTS_VIEWED', r.user_id, null, 'Identity documents and ID number opened for review');
    res.json({ documents, id_number: unsealKyc(r.id_number_enc) });
  }));

  app.post('/api/admin/requests/:id/review', adminAuth, wrap(async (req, res) => {
    const id = idParam(req);
    const b = req.body || {};
    const decision = String(b.decision || '');
    const note = String(b.note || '').trim().slice(0, 300);
    const tier = Number(b.tier || 1);
    if (!['approved', 'rejected'].includes(decision)) throw httpErr(400, 'Invalid review decision.');
    if (decision === 'approved' && ![1, 2].includes(tier)) throw httpErr(400, 'Choose verification level 1 or 2.');
    if (decision === 'rejected' && note.length < 3) throw httpErr(400, 'Give the customer a reason so they can resubmit.');
    const r = await db.get('SELECT * FROM verification_requests WHERE id = ?', [id]);
    if (!r || r.review_status !== 'submitted') throw httpErr(404, 'Pending verification request not found.');
    if (decision === 'approved' && tier === 2 && !r.proof_address_data) throw httpErr(400, 'Level 2 needs a proof of address on file.');
    if (decision === 'approved' && r.id_expiry && r.id_expiry <= new Date().toISOString().slice(0, 10)) throw httpErr(400, 'This ID has expired; ask the customer to resubmit.');
    const t = now();
    await db.tx(async () => {
      await db.run('UPDATE verification_requests SET review_status=?, admin_note=?, reviewed_at=?, upgrade_status=? , upgrade_reviewed_at=? WHERE id=?',
        [decision, note || null, t, decision === 'approved' && tier === 2 ? 'approved' : null, decision === 'approved' && tier === 2 ? t : null, id]);
      await db.run('UPDATE users SET verification_status=?, kyc_tier=? WHERE id=?', [decision, decision === 'approved' ? tier : 0, r.user_id]);
      await auditAdmin(req, decision === 'approved' ? 'KYC_APPROVED' : 'KYC_REJECTED', r.user_id, null,
        (decision === 'approved' ? 'Level ' + tier + '. ' : '') + (note || 'Identity review'));
      await notifyUser(r.user_id, decision === 'approved' ? 'Identity verified' : 'Verification needs attention',
        decision === 'approved' ? 'Your identity is verified (level ' + tier + '). Banking is now enabled.' : 'We could not verify your identity: ' + note + ' You can resubmit from your profile.', 'account');
    });
    res.json({ ok: true, status: decision, tier: decision === 'approved' ? tier : 0 });
  }));

  app.post('/api/admin/requests/:id/upgrade-review', adminAuth, wrap(async (req, res) => {
    const id = idParam(req);
    const b = req.body || {};
    const decision = String(b.decision || '');
    const note = String(b.note || '').trim().slice(0, 300);
    if (!['approved', 'rejected'].includes(decision)) throw httpErr(400, 'Invalid review decision.');
    if (decision === 'rejected' && note.length < 3) throw httpErr(400, 'Give the customer a reason so they can resubmit.');
    const r = await db.get('SELECT * FROM verification_requests WHERE id = ?', [id]);
    if (!r || r.upgrade_status !== 'submitted') throw httpErr(404, 'No pending proof of address for this customer.');
    const t = now();
    await db.tx(async () => {
      await db.run('UPDATE verification_requests SET upgrade_status=?, upgrade_note=?, upgrade_reviewed_at=? WHERE id=?', [decision, note || null, t, id]);
      if (decision === 'approved') await db.run('UPDATE users SET kyc_tier=2 WHERE id=? AND verification_status=?', [r.user_id, 'approved']);
      await auditAdmin(req, decision === 'approved' ? 'KYC_UPGRADE_APPROVED' : 'KYC_UPGRADE_REJECTED', r.user_id, null, note || 'Proof of address review');
      await notifyUser(r.user_id, decision === 'approved' ? 'Higher limits unlocked' : 'Proof of address not accepted',
        decision === 'approved' ? 'Your address is verified. Your account is now level 2 with higher limits.' : 'We could not accept your proof of address: ' + note + ' You can upload another document.', 'account');
    });
    res.json({ ok: true, status: decision });
  }));
}

module.exports = { TIERS, tierOf, parseKyc, saveRequest, mount, validImage };
