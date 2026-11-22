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
  var S = { me: null, txs: [], benes: [], meta: { billers: [], networks: [] }, view: 'welcome', sheet: null, hidden: false, idem: null, busy: false, selectedTx: null, statementFrom: '', statementTo: '', transferDraft: null, goal: goalData, support: { session: null, messages: [] }, notifications: [], scheduled: [], disputes: [], externalTransfers: [], limits: { daily_transfer_limit: 500000, daily_payment_limit: 100000 }, savedBenes: [], sessions: [], impersonation: { active: false }, cardReveal: null };

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
    return Promise.all([api('GET', '/api/me'), api('GET', '/api/transactions?limit=50'), api('GET', '/api/beneficiaries'), api('GET', '/api/impersonation/status'), api('GET','/api/notifications'), api('GET','/api/transfers/scheduled'), api('GET','/api/disputes'), api('GET','/api/account/limits'), api('GET','/api/beneficiaries/saved'), api('GET','/api/external-transfers')])
      .then(function (r) { S.me = r[0]; S.txs = r[1].transactions; S.benes = r[2].beneficiaries; S.impersonation = r[3] || {active:false}; S.notifications=r[4].notifications||[]; S.scheduled=r[5].transfers||[]; S.disputes=r[6].disputes||[]; S.limits=r[7].limits||S.limits; S.limits.transfer_used=r[7].transfer_used||0; S.savedBenes=r[8].beneficiaries||[]; S.externalTransfers=r[9].transfers||[]; });
  }
  var tt;
  function toast(m) {
    toastEl.textContent = m; toastEl.classList.add('on');
    clearTimeout(tt); tt = setTimeout(function () { toastEl.classList.remove('on'); }, 2400);
  }

  // ---------- transaction display ----------
  var LABEL = { transfer_out: 'Sent', transfer_in: 'Received', external_transfer_pending: 'External transfer request', external_transfer_refund: 'External transfer refund', deposit: 'Deposit', airtime: 'Airtime', bill: 'Bill' };
  var ICON = { transfer_out: 'up', transfer_in: 'down', deposit: 'down', airtime: 'phone', bill: 'bill' };
  function fdate(t) { return new Date(t).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
  function txRow(t) {
    var neg = t.amount < 0;
    var title = t.type === 'transfer_out' ? 'To ' + t.counterparty : t.type === 'transfer_in' ? 'From ' + t.counterparty : t.counterparty;
    return '<button type="button" class="tr tx-click" data-act="transaction" data-id="' + esc(t.id || t.transaction_id || t.reference || '') + '" aria-label="View transaction details: ' + esc(title) + '"><span class="ti">' + ic(ICON[t.type] || 'swap') + '</span>' +
      '<span class="m"><b>' + esc(title) + '</b><small>' + esc(LABEL[t.type] || 'Payment') + ' · ' + esc(fdate(t.created_at)) + (t.note ? ' · ' + esc(t.note) : '') + '</small></span>' +
      '<span class="r"><b style="color:' + (neg ? 'var(--fg)' : 'var(--good)') + '">' + (neg ? '-' : '+') + money(Math.abs(t.amount)) + ' USD</b><small>'+(t.type==='external_transfer_pending'?'Pending admin processing':t.type==='external_transfer_refund'?'Refunded':'Successful')+'</small></span>' + ic('chev') + '</button>';
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
  function kycFields(nameValue) {
    return '<label class="field">Legal name<input name="legal_name" required minlength="2" maxlength="100" autocomplete="name" value="' + esc(nameValue || '') + '" placeholder="As shown on your ID"></label>' +
      '<label class="field">Date of birth<input name="date_of_birth" type="date" required autocomplete="bday"></label>' +
      '<label class="field">Residential address<textarea name="address" required minlength="8" maxlength="250" rows="3" autocomplete="street-address" placeholder="Street, city, state, country"></textarea></label>' +
      '<label class="field">Government ID type<select name="id_type" required><option value="">Select ID type</option><option>Passport</option><option>Driver license</option><option>National identity card</option><option>Other government ID</option></select></label>' +
      '<label class="field">Country that issued the ID<input name="id_country" required maxlength="56" autocomplete="country-name" placeholder="e.g. Kenya"></label>' +
      '<label class="field">ID number<input name="id_number" required minlength="4" maxlength="30" autocomplete="off" placeholder="As printed on the document"></label>' +
      '<label class="field">ID expiry date<input name="id_expiry" type="date" required></label>' +
      '<label class="field">Front of ID<input name="id_front" type="file" accept="image/jpeg,image/png,image/webp" required></label>' +
      '<label class="field">Back of ID (not needed for passports)<input name="id_back" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
      '<label class="field">Selfie holding your face clearly in view<input name="selfie" type="file" accept="image/jpeg,image/png,image/webp" capture="user" required></label>' +
      '<label class="field">Proof of address (optional, unlocks higher limits)<input name="proof_address" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
      '<p class="hint">Your ID number and documents are encrypted. Only authorised Prime Trust reviewers can open them.</p>';
  }
  function readKycImages(form) {
    var f = form.elements;
    return Promise.all([compressIdFile(f.id_front.files[0]), compressIdFile(f.id_back.files[0]), compressIdFile(f.selfie.files[0]), compressIdFile(f.proof_address.files[0])]);
  }
  function vAuth(mode) {
    var reg = mode === 'register';
    var kyc = reg ?
      '<div class="section-label">Identity verification</div>' +
      '<p class="lead">Complete KYC now. An administrator will review your documents before banking is enabled.</p>' +
      kycFields('') : '';
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
  function levelPanel(me) {
    var t = me.tier || {}, k = me.kyc || {}, tier = me.kyc_tier || 1;
    var h = '<div class="panel" style="margin-top:12px"><div class="kv"><span>Verification level</span><b>Level ' + tier + ' (' + esc(t.name || '') + ')</b></div>' +
      '<div class="kv"><span>Largest single payment</span><b>USD ' + money(t.per_transaction || 0) + '</b></div>' +
      '<div class="kv"><span>Daily transfers</span><b>USD ' + money(t.daily_transfer || 0) + '</b></div></div>';
    if (tier < 2) {
      if (k.upgrade_status === 'submitted') h += '<p class="hint" style="margin-top:12px">Your proof of address is being reviewed.</p>';
      else h += (k.upgrade_status === 'rejected' && k.upgrade_note ? '<p class="err" style="margin-top:12px">Not accepted: ' + esc(k.upgrade_note) + '</p>' : '') +
        '<form class="form" data-form="upgrade" style="margin-top:12px"><div class="section-label">Raise your limits</div>' +
        '<label class="field">Proof of address (recent utility bill or bank statement)<input name="proof_address" type="file" accept="image/jpeg,image/png,image/webp" required></label>' +
        '<p class="err" role="alert"></p><button class="pillbtn w" type="submit">Upload for review</button></form>';
    }
    return h;
  }
  function vVerification() {
    var me = S.me, state = me.verification_status || 'pending';
    var heading = state === 'approved' ? 'Identity verified' : state === 'rejected' ? 'Review needed' : state === 'submitted' ? 'Verification in review' : 'Verify your identity';
    var copy = state === 'approved' ? 'Your identity has been approved. Your banking features are ready.' :
      state === 'rejected' ? 'Your verification was not approved' + ((me.kyc && me.kyc.admin_note) ? ': ' + me.kyc.admin_note + '.' : '.') + ' Please correct your details and submit them again.' :
      state === 'submitted' ? 'Your details have been sent to our verification team. We will enable banking once an administrator approves your identity.' :
      'Complete this short form. A Prime Trust administrator will review your identity before you can use banking features.';
    return '<section class="screen">' + 
      '<div class="brand">Prime Trust</div><div class="panel" style="margin-top:18px">' +
      '<div class="ti" style="width:52px;height:52px;border-radius:16px;margin-bottom:16px">' + ic(state === 'approved' ? 'detail' : 'user') + '</div>' +
      '<h2>' + esc(heading) + '</h2><p class="lead">' + esc(copy) + '</p>' +
      (state === 'approved' ? levelPanel(me) + '<button class="pillbtn w" data-act="go" data-v="home" style="margin-top:12px">Continue to banking</button>' :
      state === 'submitted' ? '<div class="subrow" style="margin-top:16px">Status: <b>Pending administrator approval</b></div><button class="pillbtn d" style="margin-top:12px" data-act="logout">Log out</button>' :
      '<form class="form" data-form="verification" style="margin-top:16px">' +
      kycFields(me.name) +
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
      '<div class="sub">Banking services</div><div class="panel page-links">'+pageLink('transfers','up','Transfers','Send money and manage recipients')+pageLink('payments','bill','Payments','Pay everyday bills')+pageLink('accounts','detail','Accounts','Account details and balance')+pageLink('history','swap','Statements & activity','Search and export transactions')+pageLink('savings','plus','Savings goals','Track a personal target')+pageLink('security','user','Profile & security','Manage your account')+pageLink('services','dots','More banking','Notifications, scheduled payments and account controls')+'</div>'+
      '<div class="sub">Recent recipients</div><div class="benes">'+benes+'</div><div class="trh"><b>Recent activity</b><button data-act="go" data-v="history">View all</button></div>'+trs+'</section>'+dock('home');
  }
  function vHistory() {
    var from=S.statementFrom,to=S.statementTo;
    var filtered=S.txs.filter(function(t){var day=String(t.created_at||'').slice(0,10);return (!from||day>=from)&&(!to||day<=to);});
    var trs = filtered.map(txRow).join('') || '<p class="empty">No transactions match this date range.</p>';
    return '<section class="screen">' + 
      '<div class="hd"><button class="circ" data-act="go" data-v="home" aria-label="Back">' + ic('back') + '</button><h4>Activity</h4><button class="copy" data-act="statement">Export</button></div>'+
      '<div class="panel statement-filter"><label class="field">From<input type="date" data-statement-from value="'+esc(from)+'"></label><label class="field">To<input type="date" data-statement-to value="'+esc(to)+'"></label><button class="pillbtn d" data-act="clear-statement">Clear dates</button></div>'+
      '<label class="field" style="margin:8px 0 14px">Search transactions<input data-search type="search" placeholder="Search activity"></label><p class="hint">'+filtered.length+' transaction'+(filtered.length===1?'':'s')+' in range</p>' + trs + '</section>' + dock('history');
  }
  function vTransaction() {
    var t=S.selectedTx;if(!t)return '<section class="screen"><p class="empty">Transaction not found.</p><button class="pillbtn d" data-act="go" data-v="history">Back to activity</button></section>';
    var incoming=t.amount>=0, title=t.type==='transfer_out'?'Transfer sent':t.type==='transfer_in'?'Transfer received':t.type==='external_transfer_pending'?'External transfer request':t.type==='external_transfer_refund'?'External transfer refund':t.type==='deposit'?'Deposit':t.type==='airtime'?'Airtime purchase':'Bill payment';
    var receipt=[ 'PRIME TRUST BANK — TRANSACTION RECEIPT','',title,'Amount: '+(incoming?'+':'-')+' USD '+money(Math.abs(t.amount)),'Status: '+esc(t.type==='external_transfer_pending'?'Pending admin processing':t.type==='external_transfer_refund'?'Refunded':(t.status||'Successful')),'Date: '+new Date(t.created_at).toLocaleString(),'Description: '+(t.counterparty||'—'),'Reference: '+(t.reference||t.id||'—'),t.note?'Note: '+t.note:'','Receipt for your recorded account activity.'];
    return '<section class="screen"><div class="hd"><button class="circ" data-act="go" data-v="history" aria-label="Back">'+ic('back')+'</button><h4>Transaction details</h4><span></span></div>'+
      '<div class="panel receipt-hero"><div class="receipt-mark">'+ic(incoming?'down':'up')+'</div><small>'+esc(title)+'</small><strong class="receipt-amount">'+(incoming?'+':'−')+' USD '+money(Math.abs(t.amount))+'</strong><span class="status-chip">'+esc(t.status||'Successful')+'</span></div>'+
      '<div class="panel receipt-details"><div class="kv"><span>Recipient / sender</span><b>'+esc(t.counterparty||'—')+'</b></div><div class="kv"><span>Transaction type</span><b>'+esc(LABEL[t.type]||t.type||'Payment')+'</b></div><div class="kv"><span>Date & time</span><b>'+esc(new Date(t.created_at).toLocaleString())+'</b></div><div class="kv"><span>Reference</span><b>'+esc(t.reference||t.id||'—')+'</b></div>'+(t.note?'<div class="kv"><span>Note</span><b>'+esc(t.note)+'</b></div>':'')+'</div>'+
      '<button class="pillbtn w" style="margin-top:14px" data-act="receipt-download">Download receipt</button><button class="pillbtn d" style="margin-top:10px" data-act="go" data-v="disputes">Report an issue</button></section>'+dock('history');
  }
  function vProfile() {
    var me=S.me;
    return '<section class="screen">'+pageHead('Personal profile','Your account identity and contact details')+
      '<div class="panel profile-hero">'+avatar(me.name)+'<h2>'+esc(me.name)+'</h2><p>'+esc(me.email)+'</p><span class="status-chip">'+esc(me.verification_status||'KYC pending')+'</span></div>'+
      '<div class="panel receipt-details"><div class="kv"><span>Full name</span><b>'+esc(me.name)+'</b></div><div class="kv"><span>Email address</span><b>'+esc(me.email)+'</b></div><div class="kv"><span>Account number</span><b>'+esc(me.account.number)+'</b></div><div class="kv"><span>Account currency</span><b>'+esc(me.account.currency||'USD')+'</b></div><div class="kv"><span>Identity status</span><b>'+esc(me.verification_status||'pending')+'</b></div></div>'+
      '<div class="sub">Account preferences</div><div class="panel">'+pageLink('security','user','Security & sign-in','Password, MFA and account protection')+pageLink('verification','detail','Identity verification','Review your KYC status')+pageLink('notifications','bell','Notifications','View account alerts')+pageLink('sessions','user','Devices & sessions','Manage signed-in devices')+'</div><p class="hint" style="margin-top:12px">Personal detail editing is not currently available. Contact support to request a correction.</p></section>'+dock('profile');
  }
  function vCard() {
    var me=S.me,c=me.card;
    if(!c){
      var status=me.card_request&&me.card_request.status;
      var copy=status==='pending'?'Your request is waiting for an administrator to review it.':status==='rejected'?'Your previous request was not approved. You can submit a new request.':'Request a card for your account. An administrator will review your card request.';
      return '<section class="screen">'+pageHead('Choose your card','Select a card tier and delivery option')+'<div class="panel card-request-panel"><div class="card-request-icon">'+ic('detail')+'</div><h2>No card issued</h2><p class="lead">'+esc(copy)+'</p>'+(status==='pending'?'<span class="status-chip">Awaiting admin approval</span>':'<form class="form" data-form="card-request"><label class="field">Card tier<select name="tier" required><option value="normal">Normal card</option><option value="black">Black card</option><option value="platinum">Platinum card</option></select></label><label class="field"><span><input style="width:auto" type="checkbox" name="physical"> Request a physical card</span></label><p class="hint">Physical card fee: USD '+money((me.card_options&&me.card_options.physical_fee_cents)||0)+'. The fee is charged when you submit a physical card request. Physical card activation is available only after delivery is confirmed.</p><label class="field">Transaction PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off"></label><p class="err" role="alert"></p><button class="pillbtn w" type="submit">'+(status==='rejected'?'Request again':'Request card')+'</button></form>')+'</div></section>'+dock('card');
    }
    if(c.revoked)return '<section class="screen">'+pageHead('Card closed','This card has been permanently closed')+'<div class="panel card-request-panel"><div class="card-request-icon">'+ic('detail')+'</div><h2>Card revoked</h2><p class="lead">This card is disabled and cannot be used. Contact support to request a replacement card.</p><div class="kv"><span>Last four digits</span><b>•••• '+esc(c.last4)+'</b></div></div>'+dock('card');
    var outs=S.txs.filter(function(t){return t.amount<0;}).slice(0,3).map(txRow).join('')||'<p class="empty">No card activity yet.</p>';
    return '<section class="screen"><div class="hd"><button class="circ" data-act="go" data-v="home" aria-label="Back">'+ic('back')+'</button><h4>Manage card</h4><span></span></div>'+
      '<div class="panel cardbal"><div><small>US Dollar</small><b>'+money(me.account.balance)+'</b></div><button class="addf" data-act="addfunds">'+ic('plus','font-size:12px')+'Add money</button></div>'+
      '<div class="panel"><div class="kv"><span>Card tier</span><b>'+esc((c.tier||'normal').toUpperCase())+'</b></div>'+(c.physical_requested?'<div class="kv"><span>Physical card</span><b>'+esc((c.physical_status||'ordered').replace(/_/g,' '))+'</b></div><p class="hint">'+(c.physical_status==='delivered'?'Delivery confirmed. You can activate your card below.':'Activation unlocks after your physical card is received and delivery is confirmed.')+'</p>':'<div class="kv"><span>Card type</span><b>Digital card</b></div>')+'</div>'+'<div class="cardwrap"><div class="cardface bigcard tier-'+esc(c.tier||'normal')+(c.frozen?' frozen':'')+'">'+artCard+'<span class="tt">Prime Trust</span><span class="badge">PRIME</span><span class="num">•••• •••• •••• '+esc(c.last4)+'</span><span class="nm">'+esc(me.name)+'</span><span class="exp">'+esc(c.expiry)+'</span></div>'+(c.frozen?'<div class="frozenlbl">FROZEN</div>':'')+'</div>'+
      '<div class="acts s3acts"><button class="act" data-act="sheet" data-s="details"><i>'+ic('detail')+'</i>Details</button><button class="act" data-act="freeze" aria-pressed="'+c.frozen+'"><i>'+ic('snow')+'</i>'+(c.frozen?'Unfreeze':'Freeze')+'</button><button class="act" data-act="sheet" data-s="card-replace"><i>'+ic('detail')+'</i>Replace</button></div>'+
      '<div class="sub">Card controls</div><div class="panel"><form class="form" data-form="card-settings">'+
      '<label class="field"><span><input style="width:auto" type="checkbox" name="activated" '+(c.activated?'checked':'')+((c.physical_requested&&c.physical_status!=='delivered')?' disabled':'')+'> Card activated</span></label>'+((c.physical_requested&&c.physical_status!=='delivered')?'<p class="hint">Your physical card is not marked delivered yet, so activation is locked.</p>':'')+
      '<label class="field"><span><input style="width:auto" type="checkbox" name="online_enabled" '+(c.online_enabled?'checked':'')+'> Online purchases</span></label>'+
      '<label class="field"><span><input style="width:auto" type="checkbox" name="international_enabled" '+(c.international_enabled?'checked':'')+'> International purchases</span></label>'+
      '<label class="field">Daily card limit (USD)<input name="daily_limit" type="number" min="100" max="100000" step=".01" value="'+(c.daily_limit/100)+'" required></label>'+
      '<label class="field">Transaction PIN<input name="transaction_pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label>'+
      '<p class="hint">Manage your card security and usage controls.</p><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Save card controls</button></form></div>'+'<div class="panel"><h3>Close card</h3><p class="hint">Closing your card disables it permanently. You can contact support if you need a replacement.</p><form class="form" data-form="card-close"><label class="field">Transaction PIN<input name="transaction_pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off"></label><p class="err" role="alert"></p><button class="pillbtn w" type="submit" style="background:#a32b3b">Close and delete card</button></form></div>'+
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
    var extRows=S.externalTransfers.map(function(x){return '<div class="tr"><span class="ti">'+ic('up')+'</span><div class="m"><b>'+esc(x.bank_name)+' · '+esc(x.account_name)+'</b><small>'+esc(x.account_number)+' · '+esc(x.status.replace(/_/g,' '))+' · '+esc(fdate(x.created_at))+'</small><small>'+(x.transfer_reference?'Reference: '+esc(x.transfer_reference):'Funds reserved pending administrator processing')+'</small></div><span class="r"><b>USD '+money(x.amount)+'</b><small>'+esc(x.status.replace(/_/g,' '))+'</small></span></div>';}).join('')||'<p class="empty">No external bank transfer requests yet.</p>';
    return '<section class="screen">'+pageHead('Transfers','Send money within Prime Trust or request a domestic or international bank transfer')+
      '<div class="panel"><div class="hrow"><div><b>Prime Trust transfer</b><small>Account-to-account</small></div><div class="sp"></div><button class="addf" data-act="sheet" data-s="send">New transfer</button></div><p class="lead" style="margin-top:10px">Internal transfers are sent to another Prime Trust account.</p></div>'+
      '<div class="panel" style="margin-top:12px"><h3>Transfer to a U.S. or international bank</h3><p class="lead" style="margin:8px 0 14px">Enter the recipient and bank details exactly as provided by their bank. International wire requests are reviewed and processed manually by an authorised administrator; destination currency, exchange rate and provider fees are confirmed during processing.</p><form class="form" data-form="external-transfer"><label class="field">Transfer method<select name="transfer_type" required><option value="ach">ACH transfer</option><option value="wire">Domestic wire</option><option value="international">International wire (SWIFT)</option></select></label><label class="field">Receiving bank name<input name="bank_name" required minlength="2" maxlength="100" autocomplete="organization" placeholder="Bank or credit union"></label><label class="field" data-domestic-only>ABA routing number (9 digits)<input name="routing_number" inputmode="numeric" pattern="[0-9]{9}" minlength="9" maxlength="9" autocomplete="off" placeholder="9-digit routing number" required></label><label class="field">Account number / IBAN<input name="account_number" required autocomplete="off" placeholder="Recipient bank account number"></label><label class="field" data-domestic-only>Account type<select name="account_type" required><option value="checking">Checking</option><option value="savings">Savings</option></select></label><label class="field">Beneficiary / account holder full legal name<input name="account_name" required minlength="2" maxlength="100" autocomplete="name" placeholder="Name exactly as on bank account"></label><label class="field" data-domestic-only>Recipient street address<input name="recipient_street" minlength="3" maxlength="120" autocomplete="street-address" placeholder="Street address" required></label><label class="field" data-domestic-only>City<input name="recipient_city" minlength="2" maxlength="60" autocomplete="address-level2" required></label><label class="field" data-domestic-only>State (2-letter code)<input name="recipient_state" pattern="[A-Za-z]{2}" minlength="2" maxlength="2" autocomplete="address-level1" placeholder="e.g. NY" required></label><label class="field" data-domestic-only>ZIP code<input name="recipient_postal_code" pattern="[0-9]{5}(-[0-9]{4})?" minlength="5" maxlength="10" inputmode="numeric" autocomplete="postal-code" placeholder="5-digit ZIP or ZIP+4" required></label><label class="field" data-domestic-only>Country<input name="recipient_country" value="United States" readonly required></label><label class="field">Recipient phone (optional)<input name="recipient_phone" type="tel" maxlength="25" autocomplete="tel" placeholder="U.S. phone number"></label><label class="field">Receiving bank address (required for international wire)<textarea name="bank_address" maxlength="200" rows="2" placeholder="Bank street, city, state and ZIP"></textarea></label><div class="panel" data-intl-only hidden><h3>International beneficiary details</h3><p class="hint">Enter details exactly as shown on the beneficiary bank’s instructions. Provide an IBAN where used; otherwise provide the account number above.</p><label class="field">SWIFT / BIC (8 or 11 characters)<input name="swift_bic" maxlength="11" minlength="8" pattern="[A-Za-z0-9]{8}([A-Za-z0-9]{3})?" autocomplete="off"></label><label class="field">IBAN (if applicable)<input name="iban" maxlength="34" autocomplete="off"></label><label class="field">Beneficiary street address<input name="intl_recipient_street" maxlength="120"></label><label class="field">Beneficiary city<input name="intl_recipient_city" maxlength="60"></label><label class="field">State / province / region<input name="intl_recipient_state" maxlength="40"></label><label class="field">Postal code<input name="intl_recipient_postal_code" maxlength="20"></label><label class="field">Transfer destination country (beneficiary's country)<input name="intl_recipient_country" maxlength="60" required placeholder="Country the funds are being sent to"></label><label class="field">Bank country<input name="bank_country" maxlength="60" required></label><label class="field">Bank city<input name="bank_city" maxlength="80" required placeholder="City where bank branch is located"></label><label class="field">Bank branch name (if known)<input name="bank_branch" maxlength="100"></label><label class="field">Local clearing / branch code (if required)<input name="local_bank_code" maxlength="40" placeholder="e.g. sort code, IFSC, BSB"></label><label class="field">Beneficiary email (optional)<input name="beneficiary_email" type="email" maxlength="120" autocomplete="email"></label><label class="field">International wire fee preference<select name="charge_bearer" required><option value="SHA">SHA — sender and recipient share bank fees</option><option value="OUR">OUR — sender pays bank fees</option><option value="BEN">BEN — recipient pays bank fees</option></select></label><label class="field">Destination currency<select name="destination_currency"><option value="">Select currency</option><option value="USD">USD — US Dollar</option><option value="EUR">EUR — Euro</option><option value="GBP">GBP — Pound Sterling</option><option value="CAD">CAD — Canadian Dollar</option><option value="AUD">AUD — Australian Dollar</option><option value="CHF">CHF — Swiss Franc</option><option value="NGN">NGN — Nigerian Naira</option><option value="INR">INR — Indian Rupee</option><option value="JPY">JPY — Japanese Yen</option><option value="AED">AED — UAE Dirham</option></select></label><label class="field">Transfer purpose<select name="transfer_purpose"><option value="">Select purpose</option><option>Family support</option><option>Personal expenses</option><option>Education</option><option>Medical expenses</option><option>Goods or services</option><option>Salary or business payment</option><option>Other</option></select></label><label class="field">Relationship to beneficiary<input name="recipient_relationship" maxlength="80"></label><label class="field">Source of funds<select name="source_of_funds"><option value="">Select source</option><option>Salary / employment</option><option>Business income</option><option>Savings</option><option>Sale of assets</option><option>Family funds</option><option>Other</option></select></label><label class="field">Intermediary bank (if required)<input name="intermediary_bank" maxlength="100"></label><label class="field">Intermediary bank SWIFT/BIC (if required)<input name="intermediary_swift" maxlength="11" minlength="8" pattern="[A-Za-z0-9]{8}([A-Za-z0-9]{3})?"></label><label class="field">Intermediary account (if required)<input name="intermediary_account" maxlength="34"></label></div><label class="field">Amount (USD)<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required placeholder="0.00"></label><label class="field">Memo / transfer purpose (optional)<input name="note" maxlength="100" placeholder="Short payment description"></label><label class="field">Transaction PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off" placeholder="4-digit PIN"></label><p class="hint">Verify routing and account numbers with the recipient. Bank and recipient instructions are encrypted in storage and shown only to authorised transfer reviewers. Never enter your online banking password, card PIN or CVV.</p><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Submit transfer request</button></form></div>'+
      '<div class="trh"><b>My external transfer requests</b><span class="muted">'+S.externalTransfers.length+' requests</span></div><div class="panel">'+extRows+'</div>'+
      '<div class="trh"><b>Recipients</b><span class="muted">'+S.benes.length+' saved</span></div><div class="panel">'+rec+'</div>'+
      '<div class="trh"><b>Recent Prime Trust transfers</b><button data-act="go" data-v="history">All activity</button></div>'+recent+'</section>'+dock('transfers');
  }
  function vPayments() {
    return '<section class="screen">'+pageHead('Payments','Everyday bill payments')+
      '<div class="panel"><h3>Pay a bill</h3><p class="lead" style="margin:8px 0 14px">Choose a service and enter the required customer details.</p><button class="pillbtn w" data-act="sheet" data-s="bills">Pay bills</button></div>'+
      '<div class="trh"><b>Recent bill payments</b><button data-act="go" data-v="history">View activity</button></div>'+ (S.txs.filter(function(t){return t.type==='bill';}).slice(0,5).map(txRow).join('')||'<p class="empty">No bill payments yet.</p>')+
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
      '<div class="sub">Account controls</div><div class="panel">'+pageLink('profile','user','Personal profile','View your personal and account details')+pageLink('accounts','detail','Account details','View account number and balance')+pageLink('card','detail','Card controls','Freeze or unfreeze your card')+pageLink('verification','user','Identity verification','View or submit identity details')+pageLink('support','headset','Support chat','Message Prime Trust support')+pageLink('services','dots','More banking','Account tools and service requests')+pageLink('sessions','user','Devices & sessions','Review and revoke signed-in devices')+'</div>'+
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
      '<form class="form" data-form="send-review" style="margin-top:0">' +
      '<label class="field">Recipient account number<input name="to_account" inputmode="numeric" pattern="\\d{10}" maxlength="10" required placeholder="10 digits" value="' + esc(pre || '') + '"><span class="hint" id="lookup"></span></label>' +
      '<label class="field">Amount (USD)<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required placeholder="0.00"></label>' +
      '<label class="field">Note (optional)<input name="note" maxlength="60" placeholder="What is it for?"></label>' +
      '<p class="hint">Review the recipient and amount before approving with your transaction PIN.</p><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Review transfer</button></form>');
  }
  function sSendConfirm() {
    var d=S.transferDraft||{};
    var cents=Math.round(Number(d.amount||0)*100);
    return sheetWrap('Confirm transfer','<div class="transfer-review"><div class="review-amount">USD '+money(cents)+'</div><p class="muted">You are sending money to</p><h3>'+esc(d.recipient||'Verified recipient')+'</h3></div>'+
      '<div class="panel receipt-details"><div class="kv"><span>Recipient account</span><b>'+esc(d.to_account||'')+'</b></div><div class="kv"><span>Transfer amount</span><b>USD '+money(cents)+'</b></div><div class="kv"><span>Fee</span><b>USD 0.00</b></div><div class="kv"><span>Total</span><b>USD '+money(cents)+'</b></div>'+(d.note?'<div class="kv"><span>Note</span><b>'+esc(d.note)+'</b></div>':'')+'</div>'+
      '<form class="form" data-form="send-confirm"><label class="field">Transaction PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off"></label><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Confirm & send</button><button type="button" class="pillbtn d" data-act="edit-transfer">Edit transfer</button></form>');
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
    return sheetWrap('Replace card','<p class="lead">Replacing your card will issue a new card number and require activation and a new card PIN.</p><form class="form" data-form="card-replace"><label class="field">Transaction PIN<input name="transaction_pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label><p class="err" role="alert"></p><button class="pillbtn d" type="submit">Replace card</button></form>');
  }
  function sMfaDisable(){
    return sheetWrap('Disable sign-in verification','<form class="form" data-form="mfa-disable"><p class="lead">Confirm your password and transaction PIN to turn off this protection.</p><label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label><label class="field">Transaction PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label><p class="err" role="alert"></p><button class="pillbtn d" type="submit">Disable MFA</button></form>');
  }
  function sDetails() {
    var me=S.me, c=S.cardReveal;
    if(!c) return sheetWrap('Reveal card details','<p class="lead">Enter your transaction PIN to view your complete card information, including the CVV.</p><form class="form" data-form="card-reveal"><label class="field">Transaction PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" required></label><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Verify PIN & reveal</button></form><p class="hint">Card details stay hidden until your PIN is verified.</p>');
    return sheetWrap('Card details','<div class="kv"><span>Card holder</span><b>'+esc(me.name)+'</b></div><div class="kv"><span>Card number</span><b class="card-secret">'+esc(c.number)+'</b></div><div class="kv"><span>Expires</span><b>'+esc(c.expiry)+'</b></div><div class="kv"><span>CVV</span><b class="card-secret">'+esc(c.cvv)+'</b></div><div class="kv"><span>Status</span><b>'+(me.card.frozen?'Frozen':'Active')+'</b></div><div class="kv"><span>Linked account</span><b>'+esc(me.account.number)+'</b></div><p class="hint">Keep your card details private. Hide them when finished.</p><button class="pillbtn d" data-act="hide-card-details">Hide card details</button>');
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
    return '<section class="screen">'+pageHead('Scheduled transfers','Schedule a one-time future transfer')+'<div class="panel"><form class="form" data-form="schedule"><label class="field">Recipient account<input name="to_account" inputmode="numeric" pattern="\\d{10}" maxlength="10" required></label><label class="field">Amount USD<input name="amount" type="number" min=".01" step=".01" required></label><label class="field">Date and time<input name="scheduled_at" type="datetime-local" required></label><label class="field">Note<input name="note" maxlength="60"></label><label class="field">Transaction PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label><p class="hint">Scheduled transfers are processed when you next open the app.</p><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Schedule transfer</button></form></div><div class="trh"><b>Your scheduled payments</b></div>'+rows+'</section>'+dock('profile');
  }
  function vDisputes(){
    var rows=S.disputes.map(function(d){var tx=S.txs.find(function(t){return t.id===d.transaction_id;});return '<div class="tr"><div class="m"><b>Transaction #'+d.transaction_id+' · '+esc(d.reason.replace(/_/g,' '))+'</b><small>'+esc(d.details)+' · '+esc(d.status)+' · '+esc(fdate(d.created_at))+'</small></div></div>';}).join('')||'<p class="empty">No disputes submitted.</p>';
    var opts=S.txs.map(function(t){return '<option value="'+t.id+'">#'+t.id+' · '+esc(t.counterparty)+' · USD '+money(Math.abs(t.amount))+'</option>';}).join('');
    return '<section class="screen">'+pageHead('Transaction disputes','Report a transaction for review')+'<div class="panel"><form class="form" data-form="dispute"><label class="field">Transaction<select name="transaction_id" required>'+opts+'</select></label><label class="field">Reason<select name="reason" required><option value="unauthorized">I did not authorize this</option><option value="incorrect_amount">Incorrect amount</option><option value="duplicate">Duplicate transaction</option><option value="not_received">Goods or service not received</option><option value="other">Other</option></select></label><label class="field">Details<textarea name="details" minlength="10" maxlength="1500" required></textarea></label><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Submit dispute</button></form></div><div class="trh"><b>Your dispute history</b></div>'+rows+'</section>'+dock('profile');
  }
  function vLimits(){
    return '<section class="screen">'+pageHead('Account limits','Set personal daily transfer and payment caps')+'<div class="panel"><form class="form" data-form="limits"><label class="field">Daily transfer limit (USD)<input name="daily_transfer_limit" type="number" min="100" max="500000" step=".01" value="'+(S.limits.daily_transfer_limit/100)+'" required></label><label class="field">Daily payment limit (USD)<input name="daily_payment_limit" type="number" min="100" max="100000" step=".01" value="'+(S.limits.daily_payment_limit/100)+'" required></label><p class="hint">Your selected caps apply to eligible account activity. Lower limits apply immediately; increases remain subject to account limits.</p><p class="err" role="alert"></p><button class="pillbtn w" type="submit">Save limits</button></form></div><div class="panel" style="margin-top:12px"><div class="kv"><span>Transfer usage today</span><b>USD '+money(S.limits.transfer_used||0)+'</b></div></div></section>'+dock('profile');
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
      case 'transaction-detail': html = vTransaction(); break;
      case 'profile': html = vProfile(); break;
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
      html += ({ send: function () { return sSend(prefill); }, 'send-confirm': sSendConfirm, bills: sBills, fund: sFund, details: sDetails, profile: sProfile, goal: sGoal, 'mfa-disable': sMfaDisable, 'card-replace': sCardReplace }[S.sheet] || function () { return ''; })();
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
    if (a === 'closebg') { if (ev.target === t) { S.sheet = null; S.cardReveal=null; render(); } return; }
    if (a === 'go') return go(t.dataset.v);
    if (a === 'transaction') { S.selectedTx=S.txs.find(function(x){return String(x.id||x.transaction_id||x.reference||'')===String(t.dataset.id);})||null; return go('transaction-detail'); }
    if (a === 'clear-statement') { S.statementFrom='';S.statementTo='';return render(); }
    if (a === 'edit-transfer') { S.sheet='send';return render(S.transferDraft&&S.transferDraft.to_account); }
    if (a === 'receipt-download') { if(!S.selectedTx)return; var q=S.selectedTx, amount=(q.amount>=0?'+':'-')+' USD '+money(Math.abs(q.amount)); var body='PRIME TRUST BANK\nTRANSACTION RECEIPT\n\nAmount: '+amount+'\nStatus: '+(q.status||'Successful')+'\nDate: '+new Date(q.created_at).toLocaleString()+'\nDescription: '+(q.counterparty||'—')+'\nReference: '+(q.reference||q.id||'—')+'\n'+(q.note?'Note: '+q.note+'\n':'')+'\nReceipt generated from your account activity.'; var blob=new Blob([body],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='prime-trust-receipt-'+String(q.id||'transaction')+'.txt';link.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);toast('Receipt downloaded');return; }
    if (a === 'refresh-support') return go('support');
    if (a === 'return-admin') { if(!confirm('End this customer session and return to the admin console?'))return; api('POST','/api/admin/impersonate-return',{}).then(function(){window.location.href='/api/admin/portal';}).catch(function(e){toast(e.message);}); return; }
    if (a === 'sheet') { if(t.dataset.s==='details')S.cardReveal=null; return openSheet(t.dataset.s); }
    if (a === 'hide-card-details') { S.cardReveal=null; S.sheet='details'; render(); return; }
    if (a === 'request-card') { if(!confirm('Request a card? An administrator must approve it first.'))return; t.disabled=true; api('POST','/api/card/request',{}).then(function(){return load();}).then(function(){S.view='card';render();toast('Card request submitted');}).catch(function(e){t.disabled=false;toast(e.message);}); return; }
    if (a === 'goal') return openSheet('goal');
    if (a === 'clear-goal') { S.goal=null; try{localStorage.removeItem('ptb_goal');}catch(_){} S.sheet=null; S.view='savings'; return render(); }
    if (a === 'close') { S.sheet = null; S.cardReveal=null; return render(); }
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
    if (a === 'statement') { var rows = [['Date','Type','Description','Amount USD','Balance USD']].concat(S.txs.filter(function(t){var day=String(t.created_at||'').slice(0,10);return (!S.statementFrom||day>=S.statementFrom)&&(!S.statementTo||day<=S.statementTo);}).map(function (t) { return [new Date(t.created_at).toISOString(),t.type,t.counterparty,(t.amount/100).toFixed(2),(t.balance_after/100).toFixed(2)]; })); var csv = rows.map(function (row) { return row.map(function (v) { return '"' + String(v).replace(/"/g,'""') + '"'; }).join(','); }).join(String.fromCharCode(13,10)); var blob = new Blob([csv],{type:'text/csv;charset=utf-8'}), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href=url; link.download='prime-trust-statement.csv'; link.click(); URL.revokeObjectURL(url); toast('Statement exported'); return; }
    if (a === 'testfunds') {
      api('POST', '/api/deposit', { amount: 500 }, uuid()).then(function () { return done('USD 500.00 test funds added'); }).catch(function (e) { toast(e.message); });
      return;
    }
    if (a === 'delete-card') {var pin=prompt('Enter your 4-digit transaction PIN to close this card');if(pin===null)return;api('DELETE','/api/card',{transaction_pin:pin}).then(function(){return load();}).then(function(){render();toast('Card closed');}).catch(function(e){toast(e.message);});return;}
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
  app.addEventListener('change', function (ev) {
    if (ev.target.matches('[data-statement-from]')) { S.statementFrom=ev.target.value;render(); }
    if (ev.target.matches('[data-statement-to]')) { S.statementTo=ev.target.value;render(); }
    if (ev.target.name==='transfer_type') {
      var tf=ev.target.closest('form[data-form="external-transfer"]'),isIntl=ev.target.value==='international';
      if(tf){tf.querySelectorAll('[data-domestic-only]').forEach(function(el){el.hidden=isIntl;el.querySelectorAll('input,select,textarea').forEach(function(x){x.required=!isIntl;});});tf.querySelectorAll('[data-intl-only]').forEach(function(el){el.hidden=!isIntl;el.querySelectorAll('input,select,textarea').forEach(function(x){x.required=isIntl&&['swift_bic','intl_recipient_street','intl_recipient_city','intl_recipient_country','bank_country','bank_city','destination_currency','transfer_purpose','recipient_relationship','source_of_funds','charge_bearer'].includes(x.name);});});var acct=tf.querySelector('[name="account_number"]');if(acct)acct.required=!isIntl;}
    }
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
    else if (kind === 'card-close') {if(!confirm('Permanently close this card? This cannot be undone.')){busy(form,false);return;}p=api('DELETE','/api/card',{transaction_pin:d.transaction_pin});}
    else if (kind === 'card-reveal') p=api('POST','/api/card/details',{pin:d.pin});
    if (kind === 'card-request') p=api('POST','/api/card/request',{tier:d.tier,physical:d.physical==='on',pin:d.pin});
    else if (kind === 'mfa-login') p=api('POST','/api/auth/mfa/verify',{challenge_id:mfaChallengeId,code:d.code});
    else if (kind === 'mfa-setup') p=api('POST','/api/security/mfa/confirm',{challenge_id:mfaChallengeId,code:d.code});
    else if (kind === 'mfa-disable') p=api('POST','/api/security/mfa/disable',{password:d.password,pin:d.pin});
    if (kind === 'forgot') p=api('POST','/api/auth/password-reset/request',{email:d.email});
    else if (kind === 'reset') {
      if(d.password!==d.confirm){busy(form,false);setErr(form,'Passwords do not match.');return;}
      p=api('POST','/api/auth/password-reset/confirm',{token:resetToken,password:d.password});
    }
    else if (kind === 'login') p = api('POST', '/api/auth/login', { email: d.email, password: d.password });
    else if (kind === 'register') {
      p=readKycImages(form).then(function(images){
        d.id_front=images[0];d.id_back=images[1];d.selfie=images[2];d.proof_address=images[3];
        return api('POST','/api/auth/register',d);
      });
    }
    else if (kind === 'verification') {
      p=readKycImages(form).then(function(images){
        d.id_front=images[0];d.id_back=images[1];d.selfie=images[2];d.proof_address=images[3];
        return api('POST','/api/verification/submit',d);
      });
    }
    else if (kind === 'upgrade') {
      p=compressIdFile(form.elements.proof_address.files[0]).then(function(img){return api('POST','/api/verification/upgrade',{proof_address:img});});
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
    else if (kind === 'send-review') { api('GET','/api/accounts/lookup/'+encodeURIComponent(d.to_account)).then(function(rec){S.transferDraft={to_account:d.to_account,amount:d.amount,note:d.note,recipient:rec.name};S.sheet='send-confirm';render();}).catch(function(e){busy(form,false);setErr(form,e.message);});return; }
    else if (kind === 'send-confirm') p = api('POST', '/api/transfers', { to_account: S.transferDraft.to_account, amount: S.transferDraft.amount, pin: d.pin, note: S.transferDraft.note }, S.idem);
    else if (kind === 'external-transfer') { S.idem=uuid(); p = api('POST','/api/external-transfers',{transfer_type:d.transfer_type,bank_name:d.bank_name,routing_number:d.routing_number,account_name:d.account_name,account_number:d.account_number,account_type:d.account_type,recipient_street:d.recipient_street,recipient_city:d.recipient_city,recipient_state:d.recipient_state,recipient_postal_code:d.recipient_postal_code,recipient_country:d.recipient_country,recipient_phone:d.recipient_phone,bank_address:d.bank_address,amount:d.amount,pin:d.pin,note:d.note,swift_bic:d.swift_bic,iban:d.iban,intl_recipient_street:d.intl_recipient_street,intl_recipient_city:d.intl_recipient_city,intl_recipient_state:d.intl_recipient_state,intl_recipient_postal_code:d.intl_recipient_postal_code,intl_recipient_country:d.intl_recipient_country,bank_country:d.bank_country,destination_currency:d.destination_currency,transfer_purpose:d.transfer_purpose,recipient_relationship:d.recipient_relationship,source_of_funds:d.source_of_funds,intermediary_bank:d.intermediary_bank,intermediary_swift:d.intermediary_swift,intermediary_account:d.intermediary_account,local_bank_code:d.local_bank_code,bank_city:d.bank_city,bank_branch:d.bank_branch,charge_bearer:d.charge_bearer,beneficiary_email:d.beneficiary_email},S.idem); }
    else if (kind === 'bills') p = api('POST', '/api/bills', { biller: d.biller, reference: d.reference, amount: d.amount, pin: d.pin }, S.idem);
    else return;
    p.then(function (res) {
      if (kind === 'login' && res.mfa_required) { mfaChallengeId=res.challenge_id;S.view='mfa-login';render();toast('Check your email for the sign-in code');return; }
      if (kind === 'card-reveal') { S.cardReveal=res.card; S.sheet='details'; render(); return; }
      if (kind === 'card-close') return load().then(function(){S.view='card';render();toast('Card closed and disabled');});
      if (kind === 'card-request') return load().then(function(){S.view='card';render();toast('Card request submitted for administrator review');});
      if (kind === 'card-settings') return load().then(function(){S.view='card';render();toast('Card controls updated');});
      if (kind === 'card-pin') return load().then(function(){S.view='card';render();toast('Card PIN saved');});
      if (kind === 'card-replace') return load().then(function(){S.sheet=null;S.view='card';render();toast('Card replaced. Activate it and set a new PIN.');});
      if (kind === 'mfa-login') { mfaChallengeId='';return load().then(function(){S.view=S.me.verification_status==='approved'?'home':'verification';render();toast('Signed in securely');}); }
      if (kind === 'mfa-setup') { mfaChallengeId='';return load().then(function(){S.view='security';render();toast('Multi-factor authentication enabled');}); }
      if (kind === 'mfa-disable') return load().then(function(){S.sheet=null;S.view='security';render();toast('Multi-factor authentication disabled');});
      if (kind === 'forgot') { S.view='login';render();toast('If your account exists, recovery instructions were sent.');return; }
      if (kind === 'reset') { resetToken='';try{history.replaceState(null,'',location.pathname);}catch(_){} S.view='login';render();toast('Password updated. Sign in with your new password.');return; }
      if (kind === 'external-transfer') return done('External transfer request submitted for administrator processing');
      if (kind === 'support') return api('GET','/api/support/messages').then(function(d){S.support=d;render();toast('Message sent to support');});
      if (kind === 'schedule') return load().then(function(){S.view='scheduled';render();toast('Transfer scheduled');});
      if (kind === 'dispute') return load().then(function(){S.view='disputes';render();toast('Dispute submitted');});
      if (kind === 'limits') return load().then(function(){S.view='limits';render();toast('Limits saved');});
      if (kind === 'beneficiary') return load().then(function(){S.view='beneficiary-manage';render();toast('Recipient saved');});

      if (kind === 'upgrade') return load().then(function(){S.view='verification';render();toast('Proof of address sent for review');});
      if (kind === 'login' || kind === 'register' || kind === 'verification') return load().then(function () { S.view = S.me.verification_status === 'approved' ? 'home' : 'verification'; render(); toast(kind === 'verification' ? 'Submitted for administrator review' : kind === 'register' ? 'Account created; KYC submitted for review' : 'Logged in'); });
      var msg = (kind === 'send' || kind === 'send-confirm') ? 'Sent to ' + res.to : 'Bill paid';
      if(kind==='send-confirm')S.transferDraft=null;
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
