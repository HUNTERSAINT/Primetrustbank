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

  var goalData = null; try { goalData = JSON.parse(localStorage.getItem('ptb_goal') || 'null'); } catch (_) {}
  var resetToken = new URLSearchParams(window.location.search).get('reset') || '';
  var mfaChallengeId = '';
  var S = { me: null, txs: [], benes: [], meta: { billers: [], networks: [] }, view: 'welcome', sheet: null, hidden: false, idem: null, busy: false, goal: goalData, support: { session: null, messages: [] }, notifications: [], scheduled: [], disputes: [], limits: { daily_transfer_limit: 500000, daily_payment_limit: 100000 }, savedBenes: [], sessions: [], impersonation: { active: false } };

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
    return Promise.all([api('GET', '/api/me'), api('GET', '/api/transactions?limit=50'), api('GET', '/api/beneficiaries'), api('GET', '/api/impersonation/status'), api('GET','/api/notifications'), api('GET','/api/transfers/scheduled'), api('GET','/api/disputes'), api('GET','/api/account/limits'), api('GET','/api/beneficiaries/saved')])
      .then(function (r) { S.me = r[0]; S.txs = r[1].transactions; S.benes = r[2].beneficiaries; S.impersonation = r[3] || {active:false}; S.notifications=r[4].notifications||[]; S.scheduled=r[5].transfers||[]; S.disputes=r[6].disputes||[]; S.limits=r[7].limits||S.limits; S.limits.transfer_used=r[7].transfer_used||0; S.savedBenes=r[8].beneficiaries||[]; });
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
  var artCard = '<svg class="art" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice"><use href="#art"/></svg>';

  // ---------- views ----------
  function vWelcome() {
    return '<section class="screen">'+
      '<div class="brand">Prime Trust</div><div class="stand"></div>' +
      '<div class="tilt"><div class="cardface">' + artCard + '<span class="tt">Prime Card</span><span class="chip"></span><span class="num">1234 5678 9101</span><span class="nm">Your name here</span><span class="nw">' + ic('tap') + '</span></div></div>' +
      '<div class="cta"><button class="pillbtn w" data-act="go" data-v="register">Create account</button>' +
      '<button class="pillbtn d" data-act="go" data-v="login">Login</button></div></section>';
  }
  function vAuth(mode) {
    var reg = mode === 'register';
    var kyc = reg ?
      '<div class="section-label">Identity verification</div>' +
      '<p class="lead">Complete KYC now. An administrator will review your documents before banking is enabled.</p>' +
      '<label class="field">Legal name<input name="legal_name" required minlength="2" maxlength="100" autocomplete="name" placeholder="As shown on your ID"></label>' +
      '<label class="field">Date of birth<input name="date_of_birth" type="date" required autocomplete="bday"></label>' +
      '<label class="field">Residential address<textarea name="address" required minlength="8" maxlength="250" rows="3" autocomplete="street-address" placeholder="Street, city, state, country"></textarea></label>' +
      '<label class="field">Government ID type<select name="id_type" required><option value="">Select ID type</option><option>Passport</option><option>Driver license</option><option>National identity card</option><option>Other government ID</option></select></label>' +
      '<label class="field">Front of government ID<input name="id_front" type="file" accept="image/jpeg,image/png,image/webp" required></label>' +
      '<label class="field">Back of ID (optional)<input name="id_back" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
      '<label class="field">Selfie (optional)<input name="selfie" type="file" accept="image/jpeg,image/png,image/webp" capture="user"></label>' +
      '<p class="hint">No SSN or ITIN is collected. Identity verification is reviewed by an administrator.</p>' : '';
    return '<section class="screen">' +
      '<div class="hd"><button class="circ" data-act="go" data-v="welcome" aria-label="Back">' + ic('back') + '</button><h4>' + (reg ? 'Create account' : 'Login') + '</h4><span></span></div>' +
      '<form class="form" data-form="' + mode + '" autocomplete="on">' +
      '<h2>' + (reg ? 'Open your account' : 'Welcome back') + '</h2>' +
      '<p class="lead">' + (reg ? 'Create your profile and submit identity verification in one step.' : 'Log in to see your balance.') + '</p>' +
      (reg ? '<label class="field">Full name<input name="full_name" autocomplete="name" required minlength="2" maxlength="80" placeholder="Ada Okafor"></label>' : '') +
      '<label class="field">Email<input name="email" type="email" autocomplete="email" required placeholder="you@example.com"></label>' +
      '<label class="field">Password<input name="password" type="password" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" required minlength="12" maxlength="72" placeholder="At least 12 characters"></label>' +
      (reg ? '<label class="field">Transaction PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" required placeholder="4 digits"><span class="hint">You will enter this to approve payments.</span></label>' + kyc : '') +
      '<p class="err" role="alert"></p>' +
      '<button class="pillbtn w" type="submit">' + (reg ? 'Create account & submit KYC' : 'Login') + '</button>' +
      (reg ? '' : '<button type="button" class="muted" style="padding:8px" data-act="go" data-v="forgot">Forgot password?</button>') +
      '<button type="button" class="muted" style="padding:8px" data-act="go" data-v="' + (reg ? 'login' : 'register') + '">' + (reg ? 'I already have an account' : 'Create a new account') + '</button>' +
      '</form></section>';
  }
  function compressIdFile(file) {
    if (!file) return Promise.resolve('');
    var type = String(file.type || '').toLowerCase();
    var name = String(file.name || '').toLowerCase();
    var supported = /^image\/(jpeg|png|webp)$/.test(type) || /\.(jpe?g|png|webp)$/.test(name);
    if (!supported || file.size > 12000000) return Promise.reject(new Error('Choose a JPG, PNG or WebP image under 12 MB.'));
    return new Promise(function(resolve,reject){
      var url;
      var settled = false;
      function fail(){
        if(settled)return;settled=true;
        if(url)URL.revokeObjectURL(url);
        reject(new Error('This photo could not be decoded on your phone. Open it in Gallery, save/export it as a JPG, then select the saved copy.'));
      }
      function compress(source,width,height){
        if(settled)return;
        try{
          if(!width||!height)throw new Error('Invalid image dimensions');
          var scale=Math.min(1,1100/Math.max(width,height)),canvas=document.createElement('canvas');
          canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
          var ctx=canvas.getContext('2d');
          if(!ctx)throw new Error('Canvas unavailable');
          ctx.drawImage(source,0,0,canvas.width,canvas.height);
          var data=canvas.toDataURL('image/jpeg',0.72);
          if(url)URL.revokeObjectURL(url);
          if(data.length>1450000)throw new Error('Image is too large after compression. Choose a smaller photo.');
          settled=true;resolve(data);
        }catch(e){
          if(url)URL.revokeObjectURL(url);
          if(settled)return;settled=true;reject(e&&e.message?e:new Error('Image compression failed.'));
        }
      }
      function bitmapFallback(){
        if(typeof createImageBitmap==='function'){
          createImageBitmap(file).then(function(bitmap){
            compress(bitmap,bitmap.width,bitmap.height);
            if(bitmap.close)bitmap.close();
          }).catch(fail);
        }else fail();
      }
      try{
        url=URL.createObjectURL(file);
        var img=new Image();
        img.onload=function(){compress(img,img.naturalWidth||img.width,img.naturalHeight||img.height);};
        img.onerror=bitmapFallback;
        img.src=url;
      }catch(e){bitmapFallback();}
    });
  }
  function vVerification() {
    var me = S.me, state = me.verification_status || 'pending';
    var heading = state === 'approved' ? 'Identity verified' : state === 'rejected' ? 'Review needed' : state === 'submitted' ? 'Verification in review' : 'Verify your identity';
    var copy = state === 'approved' ? 'Your identity has been approved. Your banking features are ready.' :
      state === 'rejected' ? 'Your verification was not approved. Please review your details and submit them again.' :
      state === 'submitted' ? 'Your details have been sent to our verification team. We will enable banking once an administrator approves your identity.' :
      'Complete this short form. A Prime Trust administrator will review your identity before you can use banking features.';
    return '<section class="screen">' + 
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
      '<label class="field">Front of government ID<input name="id_front" type="file" accept="image/jpeg,image/png,image/webp" required></label>' +
      '<label class="field">Back of ID (if applicable)<input name="id_back" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
      '<label class="field">Selfie (optional)<input name="selfie" type="file" accept="image/jpeg,image/png,image/webp" capture="user"></label>' +
      '<p class="hint">Do not enter your SSN, ITIN, or full ID number here. An administrator will review your submission and may contact you securely for document checks.</p>' +
      '<p class="err" role="alert"></p><button class="pillbtn w" type="submit">Submit for review</button>' +
      '<button type="button" class="muted" style="padding:8px" data-act="logout">Log out</button></form>') +
      '</div></section>';
  }

  function dock(cur) {
    var b = function (v, icon, label) {
      return '<button data-act="go" data-v="' + v + '" aria-label="' + label + '"' + (cur === v ? ' aria-current="page"' : '') + '>' + ic(icon) + (cur === v ? label : '') + '</button>';
    };
    return '<nav class="dock" aria-label="Main">' + b('home','home','Home') + b('accounts','detail','Accounts') + b('history','swap','Activity') + b('card','detail','Cards') + b('security','user','Profile') + '</nav>';
  }
  function vHome() {
    var me=S.me, first=me.name.split(' ')[0];
    var benes=S.benes.length?S.benes.map(function(b){return '<button class="bn" data-act="pick" data-acct="'+esc(b.account_number)+'">'+avatar(b.name)+'<span class="nm">'+esc(b.name.split(' ')[0])+'</span></button>';}).join(''):'<p class="empty">Your saved recipients appear here after your first transfer.</p>';
    var trs=S.txs.slice(0,4).map(txRow).join('')||'<p class="empty">No transactions yet. Add funds to get started.</p>';
    return '<section class="screen"><div class="panel home-balance-card" style="margin-top:12px"><div class="hrow">'+avatar(me.name)+'<div><b>Hey, '+esc(first)+'</b><small>Welcome back to Prime Trust</small></div><div class="sp"></div><button class="circ" data-act="go" data-v="support" aria-label="Support">'+ic('headset')+'</button><button class="circ" data-act="go" data-v="notifications" aria-label="Notifications">'+ic('bell')+'</button></div>'+
      '<div class="stdcard"><span class="mc"></span><span><b>Acct '+esc(me.account.number)+'</b></span><button class="copy" data-act="copy" aria-label="Copy account number">'+ic('copy')+'Copy</button></div>'+
      '<div class="balrow"><div><div class="lab">Available balance <button data-act="eye" aria-label="'+(S.hidden?'Show':'Hide')+' balance">'+ic(S.hidden?'eyeoff':'eye','font-size:14px')+'</button></div><div class="big">'+(S.hidden?'USD ••••••':'USD '+money(me.account.balance))+'</div></div><button class="addf" data-act="addfunds">'+ic('plus','font-size:12px')+'Add funds</button></div></div>'+
      '<div class="panel" style="margin-top:12px;padding:12px 6px"><div class="acts"><button class="act" data-act="go" data-v="transfers"><i>'+ic('up')+'</i>Transfer</button><button class="act" data-act="go" data-v="payments"><i>'+ic('bill')+'</i>Payments</button><button class="act" data-act="go" data-v="card"><i>'+ic('detail')+'</i>Cards</button><button class="act" data-act="go" data-v="accounts"><i>'+ic('detail')+'</i>Accounts</button></div></div>'+
      '<div class="sub">Banking services</div><div class="panel page-links">'+pageLink('transfers','up','Transfers','Send money and manage recipients')+pageLink('payments','bill','Payments','Airtime and bills')+pageLink('accounts','detail','Accounts','Account details and balance')+pageLink('history','swap','Statements & activity','Search and export transactions')+pageLink('savings','plus','Savings goals','Track a personal target')+pageLink('security','user','Profile & security','Manage your account')+pageLink('services','dots','More banking','Notifications, scheduled payments and account controls')+'</div>'+
      '<div class="sub">Recent recipients</div><div class="benes">'+benes+'</div><div class="trh"><b>Recent activity</b><button data-act="go" data-v="history">View all</button></div>'+trs+'</section>'+dock('home');
  }
  function vHistory() {
    var trs = S.txs.map(txRow).join('') || '<p class="empty">No transactions yet.</p>';
    return '<section class="screen">' + 
      '<div class="hd"><button class="circ" data-act="go" data-v="home" aria-label="Back">' + ic('back') + '</button><h4>Activity</h4><button class="copy" data-act="statement">Export</button></div><label class="field" style="margin:8px 0 14px">Search transactions<input data-search type="search" placeholder="Search activity"></label>' + trs + '</section>' + dock('history');
  }
  function vCard() {
    var me=S.me,c=me.card;
    var outs=S.txs.filter(function(t){return t.amount<0;}).slice(0,3).map(txRow).join('')||'<p class="empty">No card activity yet.</p>';
    return '<section class="screen"><div class="hd"><button class="circ" data-act="go" data-v="home" aria-label="Back">'+ic('back')+'</button><h4>Manage card</h4><span></span></div>'+
      '<div class="panel cardbal"><div><small>US Dollar</small><b>'+money(me.account.balance)+'</b></div><button class="addf" data-act="addfunds">'+ic('plus','font-size:12px')+'Add money</button></div>'+
      '<div class="cardwrap"><div class="cardface bigcard'+(c.frozen?' frozen':'')+'">'+artCard+'<span class="tt">Prime Trust</span><span class="badge">PRIME</span><span class="num">4556 •••• •••• '+esc(c.last4)+'</span><span class="nm">'+esc(me.name)+'</span><span class="exp">'+esc(c.expiry)+'</span></div>'+(c.frozen?'<div class="frozenlbl">FROZEN</div>':'')+'</div>'+
      '<div class="acts s3acts"><button class="act" data-act="sheet" data-s="details"><i>'+ic('detail')+'</i>Details</button><button class="act" data-act="freeze" aria-pressed="'+c.frozen+'"><i>'+ic('snow')+'</i>'+(c.frozen?'Unfreeze':'Freeze')+'</button><button class="act" data-act="sheet" data-s="card-replace"><i>'+ic('detail')+'</i>Replace</button></div>'+
      '<div class="sub">Card controls</div><div class="panel"><form class="form" data-form="card-settings">'+
      '<label class="field"><span><input style="width:auto" type="checkbox" name="activated" '+(c.activated?'checked':'')+'> Card activated</span></label>'+
      '<label class="field"><span><input style="width:auto" type="checkbox" name="online_enabled" '+(c.online_enabled?'checked':'')+'> Online purchases</span></label>'+
      '<label class="field"><span><input style="width:auto" type="checkbox" name="international_enabled" '+(c.international_enabled?'checked':'')+'> International purchases</span></label>'+
      '<label class="field">Daily card limit (USD)<input name="daily_limit" type="number" min="100" max="100000" step=".01" value="'+(c.daily_limit/100)+'" required></label>'+
      '<label class="field">Transaction PIN<input name="transaction_pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label>'+
      '<p class="hint">Demo card controls only. These preferences are not connected to a real card network or authorization processor.</p><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Save card controls</button></form></div>'+
      '<div class="sub">Card PIN</div><div class="panel"><form class="form" data-form="card-pin"><label class="field">New card PIN<input name="card_pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label><label class="field">Confirm with transaction PIN<input name="transaction_pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label><p class="err" role="alert"></p><button class="pillbtn d" type="submit">'+(c.card_pin_set?'Change card PIN':'Set card PIN')+'</button></form></div>'+
      '<div class="trh"><b>Recent Transactions</b><button data-act="go" data-v="history">View all</button></div>'+outs+'</section>'+dock('card');
  }
  function pageHead(title, subtitle) {
    return '<div class="hd"><button class="circ" data-act="go" data-v="home" aria-label="Back to dashboard">' + ic('back') + '</button><div class="pagehead"><h4>' + esc(title) + '</h4><small>' + esc(subtitle || '') + '</small></div><span></span></div>';
  }
  function pageLink(view, icon, title, desc, action) {
    return '<button class="page-link" data-act="' + (action || 'go') + '" data-v="' + view + '"><span class="page-icon">' + ic(icon) + '</span><span class="page-copy"><b>' + esc(title) + '</b><small>' + esc(desc) + '</small></span>' + ic('chev') + '</button>';
  }
  function vAccounts() {
    var me = S.me;
    return '<section class="screen">' + pageHead('Accounts', 'Your account information') +
      '<div class="panel page-balance"><small>Available balance</small><strong>USD ' + money(me.account.balance) + '</strong><span>' + esc(me.account.currency || 'USD') + ' account</span></div>' +
      '<div class="panel" style="margin-top:12px"><div class="kv"><span>Account holder</span><b>' + esc(me.name) + '</b></div><div class="kv"><span>Account number</span><b>' + esc(me.account.number) + '</b></div><div class="kv"><span>Account type</span><b>Personal</b></div><div class="kv"><span>Identity status</span><b>' + esc(me.verification_status || 'Pending') + '</b></div><button class="copy" style="margin-top:12px" data-act="copy">Copy account number</button></div>' +
      '<div class="sub">Account services</div><div class="panel">' + pageLink('history','swap','Statements & activity','Review or export your transactions') + pageLink('card','detail','Debit card','View and control your card') + pageLink('security','user','Security','Profile and account security') + '</div>' +
      '<div class="panel" style="margin-top:12px">' + pageLink('transfers','up','Transfers','Send money and manage recipients') + '</div></section>' + dock('accounts');
  }
  function vTransfers() {
    var rec = S.benes.length ? S.benes.map(function(b){return '<div class="tr">'+avatar(b.name)+'<div class="m"><b>'+esc(b.name)+'</b><small>Account · '+esc(b.account_number)+'</small></div><button class="copy" data-act="pick" data-acct="'+esc(b.account_number)+'">Send</button></div>';}).join('') : '<p class="empty">Your saved recipients will appear here after your first transfer.</p>';
    var recent = S.txs.filter(function(t){return t.type==='transfer_out'||t.type==='transfer_in';}).slice(0,4).map(txRow).join('') || '<p class="empty">No transfers yet.</p>';
    return '<section class="screen">'+pageHead('Transfers','Send money to another Prime Trust account')+
      '<div class="panel"><div class="hrow"><div><b>Domestic transfer</b><small>Account-to-account</small></div><div class="sp"></div><button class="addf" data-act="sheet" data-s="send">New transfer</button></div><p class="lead" style="margin-top:10px">Confirm the recipient name and amount before approving with your transaction PIN.</p></div>'+
      '<div class="trh"><b>Recipients</b><span class="muted">'+S.benes.length+' saved</span></div><div class="panel">'+rec+'</div>'+
      '<div class="trh"><b>Recent transfers</b><button data-act="go" data-v="history">All activity</button></div>'+recent+'</section>'+dock('transfers');
  }
  function vPayments() {
    return '<section class="screen">'+pageHead('Payments','Airtime and everyday bills')+
      '<div class="panel"><h3>Pay a bill</h3><p class="lead" style="margin:8px 0 14px">Choose a service and enter the required customer details.</p><button class="pillbtn w" data-act="sheet" data-s="bills">Pay bills</button></div>'+
      '<div class="panel" style="margin-top:12px"><h3>Mobile airtime</h3><p class="lead" style="margin:8px 0 14px">Top up a mobile number using your available balance.</p><button class="pillbtn d" data-act="sheet" data-s="airtime">Buy airtime</button></div>'+
      '<div class="trh"><b>Recent payments</b><button data-act="go" data-v="history">View activity</button></div>'+ (S.txs.filter(function(t){return t.type==='bill'||t.type==='airtime';}).slice(0,5).map(txRow).join('')||'<p class="empty">No bill or airtime payments yet.</p>')+
      '</section>'+dock('payments');
  }
  function vSavings() {
    var g=S.goal;
    return '<section class="screen">'+pageHead('Savings goals','Plan and track your personal goals')+
      '<div class="panel"><div class="hrow"><div><b>'+(g?esc(g.name):'Start a savings goal')+'</b><small>'+(g?'Personal progress tracker':'Create a target to stay focused')+'</small></div><div class="sp"></div><button class="copy" data-act="goal">Edit</button></div>'+
      (g?'<div class="page-balance"><small>Saved toward goal</small><strong>USD '+Number(g.saved).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</strong><span>Target USD '+Number(g.target).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</span></div><div class="goalbar"><span style="width:'+Math.min(100,Math.max(0,g.saved/g.target*100))+'%"></span></div><p class="lead">'+Math.round(Math.min(100,g.saved/g.target*100))+'% complete</p>':'<p class="lead" style="margin:12px 0">This tracker helps you monitor a goal. It does not move money or create a separate deposit account.</p><button class="pillbtn w" data-act="goal">Create savings goal</button>')+
      '</div><div class="panel" style="margin-top:12px"><h3>Keep your plan visible</h3><p class="lead" style="margin-top:8px">Update the amount you have saved as your real account balance changes. Your goal is stored on this device.</p></div></section>'+dock('savings');
  }
  function vSecurity() {
    var me=S.me;
    return '<section class="screen">'+pageHead('Profile & security','Manage your account details')+
      '<div class="panel"><div class="hrow">'+avatar(me.name)+'<div><b>'+esc(me.name)+'</b><small>'+esc(me.email)+'</small></div></div><div class="kv"><span>Account number</span><b>'+esc(me.account.number)+'</b></div><div class="kv"><span>Identity verification</span><b>'+esc(me.verification_status||'pending')+'</b></div></div>'+
      '<div class="sub">Sign-in security</div><div class="panel"><div class="hrow"><div><b>Multi-factor authentication</b><small>'+(me.mfa_enabled?'Enabled · email code required at sign-in':'Add an email code at sign-in')+'</small></div><div class="sp"></div><button class="copy" data-act="'+(me.mfa_enabled?'mfa-disable':'mfa-start')+'">'+(me.mfa_enabled?'Disable':'Enable')+'</button></div></div>' +
      '<div class="sub">Account controls</div><div class="panel">'+pageLink('accounts','detail','Account details','View account number and balance')+pageLink('card','detail','Card controls','Freeze or unfreeze your card')+pageLink('verification','user','Identity verification','View or submit identity details')+pageLink('support','headset','Support chat','Message Prime Trust support')+pageLink('services','dots','More banking','Account tools and service requests')+pageLink('sessions','user','Devices & sessions','Review and revoke signed-in devices')+'</div>'+
      '<button class="pillbtn d" style="margin-top:14px" data-act="logout">Log out</button></section>'+dock('profile');
  }
  function vSupport() {
    var msgs=(S.support&&S.support.messages||[]).map(function(m){return '<div class="bubble '+(m.sender_role==='admin'?'admin':'')+'">'+esc(m.message)+'<small>'+esc(m.sender_name)+' · '+new Date(m.created_at).toLocaleString()+'</small></div>';}).join('');
    return '<section class="screen">'+pageHead('Support chat','Contact Prime Trust customer support')+
      '<div class="panel chatlayout" style="height:65vh;min-height:360px;display:flex;flex-direction:column"><div class="chathead"><div><b>Prime Trust Support</b><small>We will reply here in your account</small></div><span class="muted">'+esc(S.support&&S.support.session?S.support.session.status:'open')+'</span></div><div class="messages" id="supportMessages">'+(msgs||'<p class="empty">Send a message to start a support conversation.</p>')+'</div><form class="chatcompose" data-form="support"><textarea name="message" maxlength="2000" required placeholder="Write your message to support…"></textarea><button class="pillbtn w" type="submit">Send</button></form></div></section>'+dock('profile');
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
  function sGoal() {
    var g=S.goal||{name:'',target:'',saved:''};
    return sheetWrap('Savings goal','<form class="form" data-form="goal" style="margin-top:0"><label class="field">Goal name<input name="name" required maxlength="50" value="'+esc(g.name)+'" placeholder="Emergency fund"></label><label class="field">Target amount (USD)<input name="target" type="number" min="1" step="0.01" required value="'+esc(g.target)+'"></label><label class="field">Saved amount (USD)<input name="saved" type="number" min="0" step="0.01" required value="'+esc(g.saved)+'"></label><p class="hint">Tracker only; this does not move money or create a savings account.</p><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Save goal</button>'+(S.goal?'<button type="button" class="pillbtn d" data-act="clear-goal">Remove goal</button>':'')+'</form>');
  }

    function sCardReplace(){
    return sheetWrap('Replace demo card','<p class="lead">Replacing will create a new demo card number ending and require activation and a new card PIN.</p><form class="form" data-form="card-replace"><label class="field">Transaction PIN<input name="transaction_pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label><p class="err" role="alert"></p><button class="pillbtn d" type="submit">Replace card</button></form>');
  }
  function sMfaDisable(){
    return sheetWrap('Disable sign-in verification','<form class="form" data-form="mfa-disable"><p class="lead">Confirm your password and transaction PIN to turn off this protection.</p><label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label><label class="field">Transaction PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label><p class="err" role="alert"></p><button class="pillbtn d" type="submit">Disable MFA</button></form>');
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


  function vServices(){
    return '<section class="screen">'+pageHead('More banking','Manage your everyday banking tools')+
      '<div class="panel">'+pageLink('notifications','bell','Notifications','Security and account alerts')+pageLink('scheduled','swap','Scheduled transfers','Manage future payments')+pageLink('disputes','headset','Transaction disputes','Report a transaction issue')+pageLink('limits','detail','Account limits','Set your own daily spending limits')+pageLink('beneficiary-manage','user','Saved recipients','Manage trusted transfer recipients')+'</div></section>'+dock('home');
  }
  function vNotifications(){
    var rows=S.notifications.map(function(n){return '<div class="tr"><div class="m"><b>'+esc(n.title)+'</b><small>'+esc(n.message)+' · '+esc(fdate(n.created_at))+'</small></div><div class="r">'+(n.is_read?'Read':'<button class="copy" data-act="mark-notification" data-id="'+n.id+'">Mark read</button>')+'</div></div>';}).join('')||'<p class="empty">You have no notifications yet.</p>';
    return '<section class="screen">'+pageHead('Notifications',S.notifications.filter(function(n){return !n.is_read;}).length+' unread')+'<div class="trh"><b>Account updates</b><button data-act="read-all">Mark all read</button></div>'+rows+'</section>'+dock('profile');
  }
  function vScheduled(){
    var rows=S.scheduled.map(function(x){return '<div class="tr"><div class="m"><b>'+esc(x.recipient_name)+' · USD '+money(x.amount)+'</b><small>'+esc(x.recipient_account)+' · '+esc(new Date(x.scheduled_at).toLocaleString())+' · '+esc(x.status)+(x.failure_reason?' · '+esc(x.failure_reason):'')+'</small></div><div class="r">'+(x.status==='scheduled'?'<button class="copy" data-act="cancel-schedule" data-id="'+x.id+'">Cancel</button>':'')+'</div></div>';}).join('')||'<p class="empty">No scheduled transfers.</p>';
    return '<section class="screen">'+pageHead('Scheduled transfers','Schedule a one-time future transfer')+'<div class="panel"><form class="form" data-form="schedule"><label class="field">Recipient account<input name="to_account" inputmode="numeric" pattern="\\d{10}" maxlength="10" required></label><label class="field">Amount USD<input name="amount" type="number" min=".01" step=".01" required></label><label class="field">Date and time<input name="scheduled_at" type="datetime-local" required></label><label class="field">Note<input name="note" maxlength="60"></label><label class="field">Transaction PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label><p class="hint">This demo executes due transfers when you next open the app. Do not use for real money.</p><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Schedule transfer</button></form></div><div class="trh"><b>Your scheduled payments</b></div>'+rows+'</section>'+dock('profile');
  }
  function vDisputes(){
    var rows=S.disputes.map(function(d){var tx=S.txs.find(function(t){return t.id===d.transaction_id;});return '<div class="tr"><div class="m"><b>Transaction #'+d.transaction_id+' · '+esc(d.reason.replace(/_/g,' '))+'</b><small>'+esc(d.details)+' · '+esc(d.status)+' · '+esc(fdate(d.created_at))+'</small></div></div>';}).join('')||'<p class="empty">No disputes submitted.</p>';
    var opts=S.txs.map(function(t){return '<option value="'+t.id+'">#'+t.id+' · '+esc(t.counterparty)+' · USD '+money(Math.abs(t.amount))+'</option>';}).join('');
    return '<section class="screen">'+pageHead('Transaction disputes','Report a transaction for review')+'<div class="panel"><form class="form" data-form="dispute"><label class="field">Transaction<select name="transaction_id" required>'+opts+'</select></label><label class="field">Reason<select name="reason" required><option value="unauthorized">I did not authorize this</option><option value="incorrect_amount">Incorrect amount</option><option value="duplicate">Duplicate transaction</option><option value="not_received">Goods or service not received</option><option value="other">Other</option></select></label><label class="field">Details<textarea name="details" minlength="10" maxlength="1500" required></textarea></label><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Submit dispute</button></form></div><div class="trh"><b>Your dispute history</b></div>'+rows+'</section>'+dock('profile');
  }
  function vLimits(){
    return '<section class="screen">'+pageHead('Account limits','Set personal daily transfer and payment caps')+'<div class="panel"><form class="form" data-form="limits"><label class="field">Daily transfer limit (USD)<input name="daily_transfer_limit" type="number" min="100" max="500000" step=".01" value="'+(S.limits.daily_transfer_limit/100)+'" required></label><label class="field">Daily payment limit (USD)<input name="daily_payment_limit" type="number" min="100" max="100000" step=".01" value="'+(S.limits.daily_payment_limit/100)+'" required></label><p class="hint">These are demo self-service caps, not bank-approved limits. Lower limits apply immediately; increasing them is capped by the app.</p><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Save limits</button></form></div><div class="panel" style="margin-top:12px"><div class="kv"><span>Transfer usage today</span><b>USD '+money(S.limits.transfer_used||0)+'</b></div></div></section>'+dock('profile');
  }
  function vBeneficiaryManage(){
    var rows=S.savedBenes.map(function(b){return '<div class="tr"><div class="m"><b>'+esc(b.display_name)+'</b><small>'+esc(b.account_number)+'</small></div><button class="copy" data-act="remove-beneficiary" data-id="'+b.id+'">Remove</button></div>';}).join('')||'<p class="empty">No saved recipients yet.</p>';
    return '<section class="screen">'+pageHead('Saved recipients','Save trusted account details')+'<div class="panel"><form class="form" data-form="beneficiary"><label class="field">Account number<input name="account_number" inputmode="numeric" pattern="\\d{10}" maxlength="10" required></label><label class="field">Recipient name<input name="display_name" minlength="2" maxlength="80" required></label><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Save recipient</button></form></div><div class="trh"><b>Saved recipients</b></div>'+rows+'</section>'+dock('profile');
  }


  function vSessions(){
    var rows=S.sessions.map(function(s){return '<div class="tr"><div class="m"><b>'+(s.current?'This device · current session':'Signed-in device')+'</b><small>'+esc(s.device)+' · Last active '+esc(new Date(s.last_seen_at).toLocaleString())+' · '+(s.revoked?'Revoked':'Active')+'</small></div><div class="r">'+(!s.revoked?'<button class="copy" data-act="revoke-session" data-id="'+esc(s.id)+'">'+(s.current?'Sign out':'Revoke')+'</button>':'')+'</div></div>';}).join('')||'<p class="empty">No registered device sessions yet. Sign in again to register this device.</p>';
    return '<section class="screen">'+pageHead('Devices & sessions','Review active sign-ins')+'<div class="panel"><p class="lead">Revoke a device you no longer use. Signing out other devices keeps this session active.</p><button class="pillbtn d" data-act="revoke-others">Sign out other devices</button></div><div class="trh"><b>Recent sessions</b></div>'+rows+'</section>'+dock('profile');
  }

  function vForgot(){
    return '<section class="screen"><div class="hd"><button class="circ" data-act="go" data-v="login" aria-label="Back">'+ic('back')+'</button><h4>Password recovery</h4><span></span></div><form class="form" data-form="forgot"><h2>Reset your password</h2><p class="lead">Enter the email on your account. If it exists, we will send a one-time reset link.</p><label class="field">Email<input name="email" type="email" autocomplete="email" required></label><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Send reset link</button></form></section>';
  }
  function vReset(){
    return '<section class="screen"><div class="brand">Prime Trust</div><form class="form" data-form="reset" style="margin-top:24px"><h2>Choose a new password</h2><p class="lead">Use at least 12 characters. The reset link is single-use and expires after 30 minutes.</p><label class="field">New password<input name="password" type="password" minlength="12" maxlength="72" autocomplete="new-password" required></label><label class="field">Confirm password<input name="confirm" type="password" minlength="12" maxlength="72" autocomplete="new-password" required></label><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Update password</button></form></section>';
  }

  function vMfaLogin(){
    return '<section class="screen"><div class="brand">Prime Trust</div><form class="form" data-form="mfa-login" style="margin-top:24px"><h2>Verify it is you</h2><p class="lead">We sent a 6-digit sign-in code to your email. It expires in 5 minutes.</p><label class="field">Verification code<input name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="one-time-code" required></label><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Verify & sign in</button><button type="button" class="muted" data-act="go" data-v="login">Back to login</button></form></section>';
  }
  function vMfaSetup(){
    return '<section class="screen">'+pageHead('Enable sign-in verification','Add an email verification step')+'<div class="panel"><p class="lead">Enter the 6-digit code sent to your registered email to enable multi-factor authentication.</p><form class="form" data-form="mfa-setup"><label class="field">Verification code<input name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="one-time-code" required></label><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Enable MFA</button></form></div></section>'+dock('profile');
  }
  // ---------- render ----------
  function render(prefill) {
    var html;
    if (!S.me && !['login','register','forgot','reset','mfa-login'].includes(S.view)) S.view = 'welcome';
    switch (S.view) {
      case 'login': html = vAuth('login'); break;
      case 'register': html = vAuth('register'); break;
      case 'forgot': html = vForgot(); break;
      case 'reset': html = vReset(); break;
      case 'mfa-login': html = vMfaLogin(); break;
      case 'mfa-setup': html = vMfaSetup(); break;
      case 'verification': html = vVerification(); break;
      case 'home': html = vHome(); break;
      case 'accounts': html = vAccounts(); break;
      case 'transfers': html = vTransfers(); break;
      case 'payments': html = vPayments(); break;
      case 'savings': html = vSavings(); break;
      case 'security': html = vSecurity(); break;
      case 'support': html = vSupport(); break;
      case 'history': html = vHistory(); break;
      case 'card': html = vCard(); break;
      case 'services': html = vServices(); break;
      case 'notifications': html = vNotifications(); break;
      case 'scheduled': html = vScheduled(); break;
      case 'disputes': html = vDisputes(); break;
      case 'limits': html = vLimits(); break;
      case 'beneficiary-manage': html = vBeneficiaryManage(); break;
      case 'sessions': html = vSessions(); break;
      default: html = vWelcome();
    }
    if (S.sheet && S.me) {
      html += ({ send: function () { return sSend(prefill); }, airtime: sAirtime, bills: sBills, fund: sFund, details: sDetails, profile: sProfile, goal: sGoal, 'mfa-disable': sMfaDisable, 'card-replace': sCardReplace }[S.sheet] || function () { return ''; })();
    }
    if (S.me && S.impersonation && S.impersonation.active) html = '<div class="impersonation-banner"><div><b>Admin session · Viewing as customer</b><small>Administrator: '+esc(S.impersonation.admin_email||'')+'</small></div><button type="button" data-act="return-admin">Return to Admin</button></div>'+html;
    app.innerHTML = html;
    var f = app.querySelector('input:not([type=hidden])');
    if (S.sheet || S.view === 'login' || S.view === 'register') { if (f) f.focus({ preventScroll: true }); }
  }
  function go(v) { S.view = v; S.sheet = null; if(v==='sessions'){api('GET','/api/security/sessions').then(function(d){S.sessions=d.sessions||[];render();}).catch(function(e){toast(e.message);render();});} else if(v==='support'){ api('GET','/api/support/messages').then(function(d){S.support=d;render();}).catch(function(e){toast(e.message);render();}); } else render(); }
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
    if (a === 'refresh-support') return go('support');
    if (a === 'return-admin') { if(!confirm('End this customer session and return to the admin console?'))return; api('POST','/api/admin/impersonate-return',{}).then(function(){window.location.href='/api/admin/portal';}).catch(function(e){toast(e.message);}); return; }
    if (a === 'sheet') return openSheet(t.dataset.s);
    if (a === 'goal') return openSheet('goal');
    if (a === 'clear-goal') { S.goal=null; try{localStorage.removeItem('ptb_goal');}catch(_){} S.sheet=null; S.view='savings'; return render(); }
    if (a === 'close') { S.sheet = null; return render(); }
    if (a === 'toast') return toast(t.dataset.m);

    if (a === 'mark-notification') { api('POST','/api/notifications/'+t.dataset.id+'/read',{}).then(function(){return load();}).then(render).catch(function(e){toast(e.message);}); return; }
    if (a === 'read-all') { api('POST','/api/notifications/read-all',{}).then(function(){return load();}).then(render).catch(function(e){toast(e.message);}); return; }
    if (a === 'cancel-schedule') { if(!confirm('Cancel this scheduled transfer?'))return; api('POST','/api/transfers/scheduled/'+t.dataset.id+'/cancel',{}).then(function(){return load();}).then(render).catch(function(e){toast(e.message);}); return; }


    if (a === 'mfa-start') { api('POST','/api/security/mfa/start',{}).then(function(d){mfaChallengeId=d.challenge_id;S.view='mfa-setup';render();toast('Verification code sent to your email');}).catch(function(e){toast(e.message);});return; }
    if (a === 'mfa-disable') { return openSheet('mfa-disable'); }
    if (a === 'revoke-session') { var sid=t.dataset.id, current=S.sessions.some(function(x){return x.id===sid&&x.current;}); if(!confirm(current?'Sign out this device now?':'Revoke this device session?'))return; api('POST','/api/security/sessions/'+sid+'/revoke',{}).then(function(){if(current){S.me=null;S.txs=[];S.benes=[];S.view='welcome';render();toast('This session was signed out');}else return api('GET','/api/security/sessions').then(function(d){S.sessions=d.sessions||[];render();toast('Session revoked');});}).catch(function(e){toast(e.message);});return; }
    if (a === 'revoke-others') { if(!confirm('Sign out all other devices?'))return; api('POST','/api/security/sessions/revoke-others',{}).then(function(){return api('GET','/api/security/sessions');}).then(function(d){S.sessions=d.sessions||[];render();toast('Other devices signed out');}).catch(function(e){toast(e.message);});return; }
    if (a === 'remove-beneficiary') { api('DELETE','/api/beneficiaries/saved/'+t.dataset.id).then(function(){return load();}).then(render).catch(function(e){toast(e.message);}); return; }

    if (a === 'eye') { S.hidden = !S.hidden; return render(); }
    if (a === 'pick') {
      if (S.sheet === 'send') { var inp = app.querySelector('[name=to_account]'); if (inp) { inp.value = t.dataset.acct; lookup(t.dataset.acct); return; } }
      return openSheet('send', t.dataset.acct);
    }
    if (a === 'copy') {
      var n = S.me.account.number;
      (navigator.clipboard ? navigator.clipboard.writeText(n) : Promise.reject()).then(function () { toast('Account number copied'); }, function () { toast('Account number: ' + n); });
      return;
    }
    if (a === 'addfunds') return openSheet('fund');
    if (a === 'statement') { var rows = [['Date','Type','Description','Amount USD','Balance USD']].concat(S.txs.map(function (t) { return [new Date(t.created_at).toISOString(),t.type,t.counterparty,(t.amount/100).toFixed(2),(t.balance_after/100).toFixed(2)]; })); var csv = rows.map(function (row) { return row.map(function (v) { return '"' + String(v).replace(/"/g,'""') + '"'; }).join(','); }).join(String.fromCharCode(13,10)); var blob = new Blob([csv],{type:'text/csv;charset=utf-8'}), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href=url; link.download='prime-trust-statement.csv'; link.click(); URL.revokeObjectURL(url); toast('Statement exported'); return; }
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
    if (kind === 'card-settings') p=api('PATCH','/api/card/settings',{activated:d.activated==='on',online_enabled:d.online_enabled==='on',international_enabled:d.international_enabled==='on',daily_limit:Math.round(Number(d.daily_limit)*100),transaction_pin:d.transaction_pin});
    else if (kind === 'card-pin') p=api('POST','/api/card/pin',{card_pin:d.card_pin,transaction_pin:d.transaction_pin});
    else if (kind === 'card-replace') p=api('POST','/api/card/replace',{transaction_pin:d.transaction_pin});
    if (kind === 'mfa-login') p=api('POST','/api/auth/mfa/verify',{challenge_id:mfaChallengeId,code:d.code});
    else if (kind === 'mfa-setup') p=api('POST','/api/security/mfa/confirm',{challenge_id:mfaChallengeId,code:d.code});
    else if (kind === 'mfa-disable') p=api('POST','/api/security/mfa/disable',{password:d.password,pin:d.pin});
    if (kind === 'forgot') p=api('POST','/api/auth/password-reset/request',{email:d.email});
    else if (kind === 'reset') {
      if(d.password!==d.confirm){busy(form,false);setErr(form,'Passwords do not match.');return;}
      p=api('POST','/api/auth/password-reset/confirm',{token:resetToken,password:d.password});
    }
    else if (kind === 'login') p = api('POST', '/api/auth/login', { email: d.email, password: d.password });
    else if (kind === 'register') {
      var regFront=form.elements.id_front.files[0],regBack=form.elements.id_back.files[0],regSelfie=form.elements.selfie.files[0];
      p=Promise.all([compressIdFile(regFront),compressIdFile(regBack),compressIdFile(regSelfie)]).then(function(images){
        d.id_front=images[0];d.id_back=images[1];d.selfie=images[2];
        return api('POST','/api/auth/register',d);
      });
    }
    else if (kind === 'verification') {
      var frontFile=form.elements.id_front.files[0],backFile=form.elements.id_back.files[0],selfieFile=form.elements.selfie.files[0];
      p=Promise.all([compressIdFile(frontFile),compressIdFile(backFile),compressIdFile(selfieFile)]).then(function(images){
        d.id_front=images[0];d.id_back=images[1];d.selfie=images[2];
        delete d.id_front_file;delete d.id_back_file;delete d.selfie_file;
        return api('POST','/api/verification/submit',d);
      });
    }
    else if (kind === 'support') p = api('POST', '/api/support/messages', {message:d.message});

    else if (kind === 'schedule') {
      var localDate=new Date(d.scheduled_at);
      if(!d.scheduled_at||Number.isNaN(localDate.getTime())){busy(form,false);setErr(form,'Choose a valid date and time.');return;}
      p=api('POST','/api/transfers/scheduled',{to_account:d.to_account,amount:d.amount,pin:d.pin,note:d.note,scheduled_at:localDate.toISOString()});
    }
    else if (kind === 'dispute') p=api('POST','/api/disputes',{transaction_id:d.transaction_id,reason:d.reason,details:d.details});
    else if (kind === 'limits') p=api('PUT','/api/account/limits',{daily_transfer_limit:Math.round(Number(d.daily_transfer_limit)*100),daily_payment_limit:Math.round(Number(d.daily_payment_limit)*100)});
    else if (kind === 'beneficiary') p=api('POST','/api/beneficiaries/saved',{account_number:d.account_number,display_name:d.display_name});

    else if (kind === 'goal') {
      var target=Number(d.target), saved=Number(d.saved);
      if (!d.name || !Number.isFinite(target) || target<=0 || !Number.isFinite(saved) || saved<0 || saved>target) { busy(form,false); setErr(form,'Enter a valid goal, target and saved amount.'); return; }
      S.goal={name:d.name,target:target,saved:saved}; try{localStorage.setItem('ptb_goal',JSON.stringify(S.goal));}catch(_){}
      S.sheet=null; S.view='savings'; render(); toast('Savings goal saved'); return;
    }
    else if (kind === 'send') p = api('POST', '/api/transfers', { to_account: d.to_account, amount: d.amount, pin: d.pin, note: d.note }, S.idem);
    else if (kind === 'airtime') p = api('POST', '/api/airtime', { network: d.network, phone: d.phone, amount: d.amount, pin: d.pin }, S.idem);
    else if (kind === 'bills') p = api('POST', '/api/bills', { biller: d.biller, reference: d.reference, amount: d.amount, pin: d.pin }, S.idem);
    else return;
    p.then(function (res) {
      if (kind === 'login' && res.mfa_required) { mfaChallengeId=res.challenge_id;S.view='mfa-login';render();toast('Check your email for the sign-in code');return; }
      if (kind === 'card-settings') return load().then(function(){S.view='card';render();toast('Card controls updated');});
      if (kind === 'card-pin') return load().then(function(){S.view='card';render();toast('Card PIN saved');});
      if (kind === 'card-replace') return load().then(function(){S.sheet=null;S.view='card';render();toast('Demo card replaced. Activate it and set a new PIN.');});
      if (kind === 'mfa-login') { mfaChallengeId='';return load().then(function(){S.view=S.me.verification_status==='approved'?'home':'verification';render();toast('Signed in securely');}); }
      if (kind === 'mfa-setup') { mfaChallengeId='';return load().then(function(){S.view='security';render();toast('Multi-factor authentication enabled');}); }
      if (kind === 'mfa-disable') return load().then(function(){S.sheet=null;S.view='security';render();toast('Multi-factor authentication disabled');});
      if (kind === 'forgot') { S.view='login';render();toast('If your account exists, recovery instructions were sent.');return; }
      if (kind === 'reset') { resetToken='';try{history.replaceState(null,'',location.pathname);}catch(_){} S.view='login';render();toast('Password updated. Sign in with your new password.');return; }
      if (kind === 'support') return api('GET','/api/support/messages').then(function(d){S.support=d;render();toast('Message sent to support');});
      if (kind === 'schedule') return load().then(function(){S.view='scheduled';render();toast('Transfer scheduled');});
      if (kind === 'dispute') return load().then(function(){S.view='disputes';render();toast('Dispute submitted');});
      if (kind === 'limits') return load().then(function(){S.view='limits';render();toast('Limits saved');});
      if (kind === 'beneficiary') return load().then(function(){S.view='beneficiary-manage';render();toast('Recipient saved');});

      if (kind === 'login' || kind === 'register' || kind === 'verification') return load().then(function () { S.view = S.me.verification_status === 'approved' ? 'home' : 'verification'; render(); toast(kind === 'verification' ? 'Submitted for administrator review' : kind === 'register' ? 'Account created; KYC submitted for review' : 'Logged in'); });
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
    .then(function () { if(resetToken){S.view='reset';return null;} return load(); })
    .then(function () { if(resetToken)return; S.view = S.me.verification_status === 'approved' ? 'home' : 'verification'; })
    .catch(function () { S.me = null; S.view = resetToken ? 'reset' : 'welcome'; })
    .then(function () { render(); });
})();
