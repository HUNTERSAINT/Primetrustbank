(function () {
  'use strict';
  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var ic = function (n, style) { return '<svg class="i"' + (style ? ' style="' + style + '"' : '') + '><use href="#' + n + '"/></svg>'; };
  var money = function (minor) {
    return (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var COLORS = ['#f2c14e', '#7bd3c1', '#e8a0c0', '#f09d6b', '#9fb4f2', '#c9b6ff', '#8fb8ff'];
  var color = function (name) {
    var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  };
  var avatar = function (name) { return '<div class="av" style="background:' + color(name) + '">' + esc((name || '?').trim()[0].toUpperCase()) + '</div>'; };
  var uuid = function () {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(16).slice(2);
  };

  var S = { me: null, txs: [], benes: [], meta: { billers: [], networks: [] }, view: 'welcome', sheet: null, hidden: false, idem: null, busy: false };

  // ---------- api ----------
  function api(method, url, body, idem) {
    var headers = { 'Content-Type': 'application/json' };
    if (idem) headers['Idempotency-Key'] = idem;
    return fetch(url, { method: method, headers: headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) { var e = new Error(d.error || 'Request failed'); e.status = r.status; throw e; }
          return d;
        });
      });
  }
  function load() {
    return Promise.all([api('GET', '/api/me'), api('GET', '/api/transactions?limit=50'), api('GET', '/api/beneficiaries')])
      .then(function (r) { S.me = r[0]; S.txs = r[1].transactions; S.benes = r[2].beneficiaries; });
  }
  var tt;
  function toast(m) {
    toastEl.textContent = m; toastEl.classList.add('on');
    clearTimeout(tt); tt = setTimeout(function () { toastEl.classList.remove('on'); }, 2400);
  }

  // ---------- transaction display ----------
  var LABEL = { transfer_out: 'Sent', transfer_in: 'Received', deposit: 'Deposit', airtime: 'Airtime', bill: 'Bill' };
  var ICON = { transfer_out: 'up', transfer_in: 'down', deposit: 'down', airtime: 'phone', bill: 'bill' };
  function fdate(t) { return new Date(t).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
  function txRow(t) {
    var neg = t.amount < 0;
    var title = t.type === 'transfer_out' ? 'To ' + t.counterparty : t.type === 'transfer_in' ? 'From ' + t.counterparty : t.counterparty;
    return '<div class="tr"><div class="ti">' + ic(ICON[t.type] || 'swap') + '</div>' +
      '<div class="m"><b>' + esc(title) + '</b><small>' + esc(LABEL[t.type] || 'Payment') + ' · ' + esc(fdate(t.created_at)) + (t.note ? ' · ' + esc(t.note) : '') + '</small></div>' +
      '<div class="r"><b style="color:' + (neg ? 'var(--fg)' : 'var(--good)') + '">' + (neg ? '-' : '+') + money(Math.abs(t.amount)) + ' USD</b><small>Successful</small></div></div>';
  }
  var status = '';
  var artCard = '<svg class="art" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice"><use href="#art"/></svg>';

  // ---------- views ----------
  function vWelcome() {
    return '<section class="screen">' + status +
      '<div class="brand">Prime Trust</div><div class="stand"></div>' +
      '<div class="tilt"><div class="cardface">' + artCard + '<span class="tt">Prime Card</span><span class="chip"></span><span class="num">1234 5678 9101</span><span class="nm">Your name here</span><span class="nw">' + ic('tap') + '</span></div></div>' +
      '<div class="cta"><button class="pillbtn w" data-act="go" data-v="register">Create account</button>' +
      '<button class="pillbtn d" data-act="go" data-v="login">Login</button></div></section>';
  }
  function vAuth(mode) {
    var reg = mode === 'register';
    return '<section class="screen">' + status +
      '<div class="hd"><button class="circ" data-act="go" data-v="welcome" aria-label="Back">' + ic('back') + '</button><h4>' + (reg ? 'Create account' : 'Login') + '</h4><span></span></div>' +
      '<form class="form" data-form="' + mode + '" autocomplete="on">' +
      '<h2>' + (reg ? 'Open your account' : 'Welcome back') + '</h2>' +
      '<p class="lead">' + (reg ? 'It takes about a minute.' : 'Log in to see your balance.') + '</p>' +
      (reg ? '<label class="field">Full name<input name="full_name" autocomplete="name" required minlength="2" maxlength="80" placeholder="Ada Okafor"></label>' : '') +
      '<label class="field">Email<input name="email" type="email" autocomplete="email" required placeholder="you@example.com"></label>' +
      '<label class="field">Password<input name="password" type="password" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" required minlength="8" placeholder="At least 8 characters"></label>' +
      (reg ? '<label class="field">Transaction PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" required placeholder="4 digits"><span class="hint">You will enter this to approve every payment.</span></label>' : '') +
      '<p class="err" role="alert"></p>' +
      '<button class="pillbtn w" type="submit">' + (reg ? 'Create account' : 'Login') + '</button>' +
      '<button type="button" class="muted" style="padding:8px" data-act="go" data-v="' + (reg ? 'login' : 'register') + '">' + (reg ? 'I already have an account' : 'Create a new account') + '</button>' +
      '</form></section>';
  }
  function vVerification() {
    var me = S.me, state = me.verification_status || 'pending';
    var heading = state === 'approved' ? 'Identity verified' : state === 'rejected' ? 'Review needed' : state === 'submitted' ? 'Verification in review' : 'Verify your identity';
    var copy = state === 'approved' ? 'Your identity has been approved. Your banking features are ready.' :
      state === 'rejected' ? 'Your verification was not approved. Please review your details and submit them again.' :
      state === 'submitted' ? 'Your details have been sent to our verification team. We will enable banking once an administrator approves your identity.' :
      'Complete this short form. A Prime Trust administrator will review your identity before you can use banking features.';
    return '<section class="screen">' + status +
      '<div class="brand">Prime Trust</div><div class="panel" style="margin-top:18px">' +
      '<div class="ti" style="width:52px;height:52px;border-radius:16px;margin-bottom:16px">' + ic(state === 'approved' ? 'detail' : 'user') + '</div>' +
      '<h2>' + esc(heading) + '</h2><p class="lead">' + esc(copy) + '</p>' +
      (state === 'approved' ? '<button class="pillbtn w" data-act="go" data-v="home">Continue to banking</button>' :
      state === 'submitted' ? '<div class="subrow" style="margin-top:16px">Status: <b>Pending administrator approval</b></div><button class="pillbtn d" style="margin-top:12px" data-act="logout">Log out</button>' :
      '<form class="form" data-form="verification" style="margin-top:16px">' +
      '<label class="field">Legal name<input name="legal_name" required minlength="2" maxlength="100" value="' + esc(me.name) + '" autocomplete="name"></label>' +
      '<label class="field">Date of birth<input name="date_of_birth" type="date" required></label>' +
      '<label class="field">Residential address<textarea name="address" required minlength="8" maxlength="250" rows="3" placeholder="Street, city, state, country"></textarea></label>' +
      '<label class="field">Government ID type<select name="id_type" required><option value="">Select ID type</option><option>Passport</option><option>Driver license</option><option>National identity card</option><option>Other government ID</option></select></label>' +
      '<p class="hint">Do not enter your SSN, ITIN, or full ID number here. An administrator will review your submission and may contact you securely for document checks.</p>' +
      '<p class="err" role="alert"></p><button class="pillbtn w" type="submit">Submit for review</button>' +
      '<button type="button" class="muted" style="padding:8px" data-act="logout">Log out</button></form>') +
      '</div></section>';
  }

  function dock(cur) {
    var b = function (v, icon, label) {
      return '<button data-act="go" data-v="' + v + '" aria-label="' + label + '"' + (cur === v ? ' aria-current="page"' : '') + '>' + ic(icon) + (cur === v ? label : '') + '</button>';
    };
    return '<nav class="dock" aria-label="Main">' + b('home', 'home', 'Home') + b('history', 'swap', 'Activity') + b('card', 'detail', 'Card') +
      '<button data-act="sheet" data-s="profile" aria-label="Profile">' + ic('user') + '</button></nav>';
  }
  function vHome() {
    var me = S.me, first = me.name.split(' ')[0];
    var benes = S.benes.length ? S.benes.map(function (b) {
      return '<button class="bn" data-act="pick" data-acct="' + esc(b.account_number) + '">' + avatar(b.name) + '<span class="nm">' + esc(b.name.split(' ')[0]) + '</span></button>';
    }).join('') : '<p class="empty">People you send money to will show up here.</p>';
    var trs = S.txs.slice(0, 4).map(txRow).join('') || '<p class="empty">No transactions yet. Add funds to get started.</p>';
    return '<section class="screen">' + status +
      '<div class="panel" style="margin-top:12px"><div class="hrow">' + avatar(me.name) +
      '<div><b>Hey, ' + esc(first) + '</b><small>Welcome back!</small></div><div class="sp"></div>' +
      '<button class="circ" data-act="toast" data-m="Support is available 24/7 in the full app" aria-label="Support">' + ic('headset') + '</button>' +
      '<button class="circ" data-act="toast" data-m="No new notifications" aria-label="Notifications">' + ic('bell') + '</button></div>' +
      '<div class="stdcard"><span class="mc"></span><span><b>Acct ' + esc(me.account.number) + '</b></span>' +
      '<button class="copy" data-act="copy" aria-label="Copy account number">' + ic('copy') + 'Copy</button></div>' +
      '<div class="balrow"><div><div class="lab">Your balance <button data-act="eye" aria-label="' + (S.hidden ? 'Show' : 'Hide') + ' balance">' + ic(S.hidden ? 'eyeoff' : 'eye', 'font-size:14px') + '</button></div>' +
      '<div class="big">' + (S.hidden ? 'USD ••••••' : 'USD ' + money(me.account.balance)) + '</div></div>' +
      '<button class="addf" data-act="addfunds">' + ic('plus', 'font-size:12px') + 'Add Funds</button></div></div>' +
      '<div class="panel" style="margin-top:12px;padding:12px 6px"><div class="acts">' +
      '<button class="act" data-act="sheet" data-s="send"><i>' + ic('up') + '</i>Send</button>' +
      '<button class="act" data-act="toast" data-m="Cash withdrawal is not available yet"><i>' + ic('down') + '</i>Withdraw</button>' +
      '<button class="act" data-act="sheet" data-s="airtime"><i>' + ic('phone') + '</i>Buy Airtime</button>' +
      '<button class="act" data-act="sheet" data-s="bills"><i>' + ic('bill') + '</i>Pay Bills</button></div></div>' +
      '<div class="sub">Recent beneficiaries</div><div class="benes">' + benes + '</div>' +
      '<div class="trh"><b>Transactions</b><button data-act="go" data-v="history">View all</button></div>' + trs +
      '</section>' + dock('home');
  }
  function vHistory() {
    var trs = S.txs.map(txRow).join('') || '<p class="empty">No transactions yet.</p>';
    return '<section class="screen">' + status +
      '<div class="hd"><button class="circ" data-act="go" data-v="home" aria-label="Back">' + ic('back') + '</button><h4>Activity</h4><span></span></div>' + trs + '</section>' + dock('history');
  }
  function vCard() {
    var me = S.me, c = me.card;
    var outs = S.txs.filter(function (t) { return t.amount < 0; }).slice(0, 3).map(txRow).join('') || '<p class="empty">No card activity yet.</p>';
    return '<section class="screen">' + status +
      '<div class="hd"><button class="circ" data-act="go" data-v="home" aria-label="Back">' + ic('back') + '</button><h4>Manage card</h4><span></span></div>' +
      '<div class="panel cardbal"><div><small>US Dollar</small><b>' + money(me.account.balance) + '</b></div>' +
      '<button class="addf" data-act="addfunds">' + ic('plus', 'font-size:12px') + 'Add money</button></div>' +
      '<div class="cardwrap"><div class="cardface bigcard' + (c.frozen ? ' frozen' : '') + '">' + artCard +
      '<span class="tt">Prime Trust</span><span class="badge">PRIME</span>' +
      '<span class="num">4556 •••• •••• ' + esc(c.last4) + '</span><span class="nm">' + esc(me.name) + '</span><span class="exp">' + esc(c.expiry) + '</span></div>' +
      (c.frozen ? '<div class="frozenlbl">FROZEN</div>' : '') + '</div>' +
      '<div class="acts s3acts">' +
      '<button class="act" data-act="sheet" data-s="details"><i>' + ic('detail') + '</i>Details</button>' +
      '<button class="act" data-act="addfunds"><i>' + ic('plus') + '</i>Add Money</button>' +
      '<button class="act" data-act="freeze" aria-pressed="' + c.frozen + '"><i>' + ic('snow') + '</i>' + (c.frozen ? 'Unfreeze' : 'Freeze') + '</button>' +
      '<button class="act" data-act="sheet" data-s="profile"><i>' + ic('dots') + '</i>More</button></div>' +
      '<div class="sub">Upcoming subscription</div><div class="subrow">No subscriptions set up yet.</div>' +
      '<div class="trh"><b>Recent Transactions</b><button data-act="go" data-v="history">View all</button></div>' + outs +
      '</section>' + dock('card');
  }

  // ---------- sheets ----------
  function pinField() {
    return '<label class="field">Transaction PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" required placeholder="4 digits"></label>';
  }
  function sheetWrap(title, inner) {
    return '<div class="sheet-bg" data-act="closebg"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<div class="sheet-h"><h3>' + esc(title) + '</h3><button class="circ" data-act="close" aria-label="Close">' + ic('x') + '</button></div>' + inner + '</div></div>';
  }
  function sSend(pre) {
    var chips = S.benes.length ? '<div class="benes">' + S.benes.map(function (b) {
      return '<button type="button" class="bn" data-act="pick" data-acct="' + esc(b.account_number) + '">' + avatar(b.name) + '<span class="nm">' + esc(b.name.split(' ')[0]) + '</span></button>';
    }).join('') + '</div>' : '';
    return sheetWrap('Send money', chips +
      '<form class="form" data-form="send" style="margin-top:0">' +
      '<label class="field">Recipient account number<input name="to_account" inputmode="numeric" pattern="\\d{10}" maxlength="10" required placeholder="10 digits" value="' + esc(pre || '') + '"><span class="hint" id="lookup"></span></label>' +
      '<label class="field">Amount (USD)<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required placeholder="0.00"></label>' +
      '<label class="field">Note (optional)<input name="note" maxlength="60" placeholder="What is it for?"></label>' + pinField() +
      '<p class="err" role="alert"></p><button class="pillbtn w" type="submit">Send</button></form>');
  }
  function sAirtime() {
    return sheetWrap('Buy airtime', '<form class="form" data-form="airtime" style="margin-top:0">' +
      '<label class="field">Network<select name="network">' + S.meta.networks.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field">Phone number<input name="phone" inputmode="tel" required placeholder="08012345678"></label>' +
      '<label class="field">Amount (USD)<input name="amount" type="number" inputmode="decimal" min="0.01" max="500" step="0.01" required placeholder="0.00"></label>' + pinField() +
      '<p class="err" role="alert"></p><button class="pillbtn w" type="submit">Buy airtime</button></form>');
  }
  function sBills() {
    return sheetWrap('Pay a bill', '<form class="form" data-form="bills" style="margin-top:0">' +
      '<label class="field">Bill type<select name="biller">' + S.meta.billers.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field">Meter, smartcard or account number<input name="reference" required minlength="4" maxlength="30" placeholder="e.g. MTR-12345"></label>' +
      '<label class="field">Amount (USD)<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required placeholder="0.00"></label>' + pinField() +
      '<p class="err" role="alert"></p><button class="pillbtn w" type="submit">Pay bill</button></form>');
  }
  function sFund() {
    var me = S.me;
    return sheetWrap('Add funds',
      '<p class="muted" style="margin-bottom:8px">Send money to this account to fund it.</p>' +
      '<div class="kv"><span>Bank</span><b>Prime Trust Bank</b></div>' +
      '<div class="kv"><span>Account name</span><b>' + esc(me.name) + '</b></div>' +
      '<div class="kv"><span>Account number</span><b>' + esc(me.account.number) + '</b></div>' +
      '<button class="pillbtn w" style="margin-top:16px" data-act="copy">Copy account number</button>' +
      (me.sandbox_funding ? '<button class="pillbtn d" style="margin-top:10px" data-act="testfunds">Add 500.00 test funds</button>' : ''));
  }
  function sDetails() {
    var me = S.me;
    return sheetWrap('Card details',
      '<div class="kv"><span>Card holder</span><b>' + esc(me.name) + '</b></div>' +
      '<div class="kv"><span>Card number</span><b>4556 •••• •••• ' + esc(me.card.last4) + '</b></div>' +
      '<div class="kv"><span>Expires</span><b>' + esc(me.card.expiry) + '</b></div>' +
      '<div class="kv"><span>Status</span><b>' + (me.card.frozen ? 'Frozen' : 'Active') + '</b></div>' +
      '<div class="kv"><span>Linked account</span><b>' + esc(me.account.number) + '</b></div>');
  }
  function sProfile() {
    var me = S.me;
    return sheetWrap('Profile',
      '<div class="kv"><span>Name</span><b>' + esc(me.name) + '</b></div>' +
      '<div class="kv"><span>Email</span><b>' + esc(me.email) + '</b></div>' +
      '<div class="kv"><span>Account number</span><b>' + esc(me.account.number) + '</b></div>' +
      '<button class="pillbtn d" style="margin-top:16px" data-act="logout">Log out</button>');
  }

  // ---------- render ----------
  function render(prefill) {
    var html;
    if (!S.me && S.view !== 'login' && S.view !== 'register') S.view = 'welcome';
    switch (S.view) {
      case 'login': html = vAuth('login'); break;
      case 'register': html = vAuth('register'); break;
      case 'verification': html = vVerification(); break;\n      case 'home': html = vHome(); break;
      case 'history': html = vHistory(); break;
      case 'card': html = vCard(); break;
      default: html = vWelcome();
    }
    if (S.sheet && S.me) {
      html += ({ send: function () { return sSend(prefill); }, airtime: sAirtime, bills: sBills, fund: sFund, details: sDetails, profile: sProfile }[S.sheet] || function () { return ''; })();
    }
    app.innerHTML = html;
    var f = app.querySelector('input:not([type=hidden])');
    if (S.sheet || S.view === 'login' || S.view === 'register') { if (f) f.focus({ preventScroll: true }); }
  }
  function go(v) { S.view = v; S.sheet = null; render(); }
  function openSheet(s, prefill) { S.sheet = s; S.idem = uuid(); render(prefill); if (s === 'send' && prefill) lookup(prefill); }

  // ---------- behaviour ----------
  function lookup(n) {
    var hint = app.querySelector('#lookup'); if (!hint) return;
    if (!/^\d{10}$/.test(n)) { hint.textContent = ''; hint.className = 'hint'; return; }
    api('GET', '/api/accounts/lookup/' + n).then(function (d) {
      hint.textContent = 'Sending to ' + d.name; hint.className = 'hint ok';
    }).catch(function (e) { hint.textContent = e.message; hint.className = 'hint'; });
  }
  function setErr(form, m) { var e = form.querySelector('.err'); if (e) e.textContent = m || ''; }
  function busy(form, on) {
    var b = form.querySelector('button[type=submit]'); if (b) { b.disabled = on; }
  }
  function done(msg) { return load().then(function () { S.sheet = null; render(); toast(msg); }); }

  app.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-act]'); if (!t) return;
    var a = t.dataset.act;
    if (a === 'closebg') { if (ev.target === t) { S.sheet = null; render(); } return; }
    if (a === 'go') return go(t.dataset.v);
    if (a === 'sheet') return openSheet(t.dataset.s);
    if (a === 'close') { S.sheet = null; return render(); }
    if (a === 'toast') return toast(t.dataset.m);
    if (a === 'eye') { S.hidden = !S.hidden; return render(); }
    if (a === 'pick') {
      if (S.sheet === 'send') { var inp = app.querySelector('[name=to_account]'); inp.value = t.dataset.acct; lookup(t.dataset.acct); return; }
      return openSheet('send', t.dataset.acct);
    }
    if (a === 'copy') {
      var n = S.me.account.number;
      (navigator.clipboard ? navigator.clipboard.writeText(n) : Promise.reject()).then(function () { toast('Account number copied'); }, function () { toast('Account number: ' + n); });
      return;
    }
    if (a === 'addfunds') return openSheet('fund');
    if (a === 'testfunds') {
      api('POST', '/api/deposit', { amount: 500 }, uuid()).then(function () { return done('USD 500.00 test funds added'); }).catch(function (e) { toast(e.message); });
      return;
    }
    if (a === 'freeze') {
      var want = !S.me.card.frozen;
      api('POST', '/api/card/freeze', { frozen: want }).then(function () { return load(); }).then(function () { render(); toast(want ? 'Card frozen' : 'Card active again'); }).catch(function (e) { toast(e.message); });
      return;
    }
    if (a === 'logout') {
      api('POST', '/api/auth/logout', {}).finally(function () { S.me = null; S.txs = []; S.benes = []; S.sheet = null; S.view = 'welcome'; render(); });
    }
  });

  app.addEventListener('input', function (ev) {
    if (ev.target.name === 'to_account') lookup(ev.target.value.trim());
  });

  app.addEventListener('submit', function (ev) {
    var form = ev.target.closest('form[data-form]'); if (!form) return;
    ev.preventDefault();
    var kind = form.dataset.form;
    var d = {}; new FormData(form).forEach(function (v, k) { d[k] = typeof v === 'string' ? v.trim() : v; });
    setErr(form, ''); busy(form, true);
    var p;
    if (kind === 'login') p = api('POST', '/api/auth/login', { email: d.email, password: d.password });
    else if (kind === 'register') p = api('POST', '/api/auth/register', d);\n    else if (kind === 'verification') p = api('POST', '/api/verification/submit', d);
    else if (kind === 'send') p = api('POST', '/api/transfers', { to_account: d.to_account, amount: d.amount, pin: d.pin, note: d.note }, S.idem);
    else if (kind === 'airtime') p = api('POST', '/api/airtime', { network: d.network, phone: d.phone, amount: d.amount, pin: d.pin }, S.idem);
    else if (kind === 'bills') p = api('POST', '/api/bills', { biller: d.biller, reference: d.reference, amount: d.amount, pin: d.pin }, S.idem);
    else return;
    p.then(function (res) {
      if (kind === 'login' || kind === 'register' || kind === 'verification') return load().then(function () { S.view = S.me.verification_status === 'approved' ? 'home' : 'verification'; render(); toast(kind === 'verification' ? 'Submitted for administrator review' : kind === 'register' ? 'Account created' : 'Logged in'); });
      var msg = kind === 'send' ? 'Sent to ' + res.to : kind === 'airtime' ? 'Airtime bought' : 'Bill paid';
      return done(msg);
    }).catch(function (e) {
      busy(form, false);
      setErr(form, e.message);
      if (e.status === 401 && S.me) { S.me = null; go('login'); }
    });
  });

  // ---------- boot ----------
  api('GET', '/api/meta').then(function (m) { S.meta = m; }).catch(function () {})
    .then(function () { return load(); })
    .then(function () { S.view = S.me.verification_status === 'approved' ? 'home' : 'verification'; })
    .catch(function () { S.me = null; S.view = 'welcome'; })
    .then(function () { render(); });
})();
