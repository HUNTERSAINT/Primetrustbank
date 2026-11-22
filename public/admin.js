(function(){
'use strict';
const $=s=>document.querySelector(s), root=$('#content');
const S={page:'overview',userId:null,kycStatus:'pending',txType:'all',txQuery:'',txFrom:'',txTo:'',chatId:null,users:[],recipients:[],selected:[],emailAudience:'active'};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function money(v){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format((Number(v)||0)/100);}
function date(v){if(!v)return '—';return new Date(Number(v)).toLocaleString();}
function badge(v){return '<span class="badge '+esc(String(v||'').toLowerCase())+'">'+esc(v||'unknown')+'</span>';}
function api(method,url,body){return fetch(url,{method,credentials:'same-origin',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Request failed');return d;});}
function notify(text,bad){let old=$('.notice');if(old)old.remove();const n=document.createElement('div');n.className=bad?'alert':'notice';n.textContent=text;root.prepend(n);setTimeout(()=>n.remove(),7000);}
function showWorkspace(on){$('#login').classList.toggle('hidden',on);$('#workspace').classList.toggle('hidden',!on);$('#logout').classList.toggle('hidden',!on);}
function head(title,desc,button){return '<div class="pagehead"><div><h1>'+esc(title)+'</h1><p>'+esc(desc||'')+'</p></div>'+(button||'')+'</div>';}
function stat(label,value,sub){return '<div class="panel stat"><label>'+esc(label)+'</label><strong>'+esc(value)+'</strong><small>'+esc(sub||'')+'</small></div>';}
function customer(u){return '<div class="customer"><span class="avatar">'+esc((u.full_name||'?').slice(0,1).toUpperCase())+'</span><span><b>'+esc(u.full_name)+'</b><small>'+esc(u.email)+'</small></span></div>';}
function table(headers,rows){return '<div class="tablewrap"><table class="table"><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>';}
function noRows(text){return '<div class="empty">'+esc(text)+'</div>';}
function renderNav(){document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===S.page));}
async function go(page){S.page=page;renderNav();root.innerHTML='<div class="panel empty">Loading '+esc(page)+'…</div>';try{await renderPage();}catch(e){root.innerHTML='<div class="panel"><h2 class="title2">Could not load this section</h2><p class="muted">'+esc(e.message)+'</p><button class="btn" data-act="refresh">Try again</button></div>';}}
async function renderPage(){
 if(S.page==='overview')return overview();
 if(S.page==='users')return users();
 if(S.page==='user-detail')return userDetail();
 if(S.page==='kyc')return kyc();
 if(S.page==='transactions')return transactions();
 if(S.page==='chat')return chat();
 if(S.page==='email')return email();
 if(S.page==='audit')return audit();
}
async function overview(){
 const d=await api('GET','/api/admin/overview'),s=d.stats;
 $('#kycCount').textContent=s.pendingKyc||0;$('#chatCount').textContent=s.openChats||0;
 const recent=(d.recentUsers||[]).map(u=>'<tr data-open="user" data-id="'+u.id+'"><td>'+customer(u)+'</td><td>'+badge(u.status)+'</td><td>'+badge(u.verification_status)+'</td><td>'+money(u.balance)+'</td><td>'+date(u.created_at)+'</td></tr>').join('');
 const tx=(d.recentTransactions||[]).map(t=>'<tr><td>#'+t.id+'<small class="muted" style="display:block;margin-top:3px">'+date(t.created_at)+'</small></td><td>'+esc(t.full_name)+'<small class="muted" style="display:block">'+esc(t.email)+'</small></td><td>'+esc(t.type)+'</td><td>'+money(Math.abs(t.amount))+'</td><td>'+esc(t.counterparty)+'</td></tr>').join('');
 root.innerHTML=head('Admin overview','Customer service, account operations and banking activity.')+
 '<div class="grid stats">'+stat('Total customers',s.totalUsers,'Registered accounts')+stat('Active customers',s.activeUsers,'Able to sign in')+stat('Identity reviews',s.pendingKyc,'Awaiting admin review')+stat('Open support chats',s.openChats,'Need a response')+'</div>'+
 '<div class="grid stats">'+stat('Customer balances',money(s.totalUserBalances),'Sum of customer accounts')+stat('Transactions',s.totalTransactions,'Ledger entries')+stat('Today’s transactions',s.todayTransactions,'Since local server midnight')+stat('Suspended accounts',s.suspendedUsers,'Access restricted')+'</div>'+
 '<div class="panel section"><div class="row space"><h2 class="title2">Recent customers</h2><button class="btn" data-act="page" data-page="users">Manage customers</button></div>'+table(['Customer','Account status','Identity','Balance','Joined'],recent||'')+(recent?'':noRows('No customers yet.'))+'</div>'+
 '<div class="panel section"><div class="row space"><h2 class="title2">Recent banking activity</h2><button class="btn" data-act="page" data-page="transactions">All transactions</button></div>'+table(['Reference','Customer','Type','Amount','Counterparty'],tx||'')+(tx?'':noRows('No banking transactions yet.'))+'</div>';
}
async function users(q,status){
 q=q===undefined?'':q;status=status||'all';const d=await api('GET','/api/admin/users?q='+encodeURIComponent(q)+'&status='+encodeURIComponent(status)+'&limit=100');
 S.users=d.users||[];
 const rows=S.users.map(u=>'<tr data-open="user" data-id="'+u.id+'"><td>'+customer(u)+'</td><td><span class="small">'+esc(u.account_number)+'</span></td><td>'+badge(u.status)+'</td><td>'+badge(u.verification_status)+'</td><td>'+money(u.balance)+'</td><td>'+date(u.created_at)+'</td><td><button class="btn" data-act="user" data-id="'+u.id+'">View</button></td></tr>').join('');
 root.innerHTML=head('Customer management','Search customer name, email or account number.')+
 '<div class="panel"><div class="toolbar"><div class="searchwrap"><input class="search" id="userSearch" value="'+esc(q)+'" placeholder="Search name, email or account number"></div><select class="filter" id="userStatus" style="max-width:150px"><option value="all">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option></select><span class="muted small">'+d.total+' customers</span></div>'+
 table(['Customer','Account number','Status','Identity','Balance','Joined',''],rows)+(rows?'':noRows('No matching customers.'))+'</div>';
 $('#userStatus').value=status;
}
async function userDetail(){
 const d=await api('GET','/api/admin/users/'+S.userId),u=d.user;
 const tx=(d.transactions||[]).map(t=>'<tr><td>#'+t.id+'<small class="muted" style="display:block">'+date(t.created_at)+'</small></td><td>'+esc(t.type)+'</td><td>'+money(Math.abs(t.amount))+'</td><td>'+money(t.balance_after)+'</td><td>'+esc(t.counterparty)+'</td><td>'+esc(t.note||'—')+'</td></tr>').join('');
 const v=d.verification;
 root.innerHTML=head(u.full_name,'Customer profile and account controls.', '<button class="btn" data-act="page" data-page="users">← Customers</button>')+
 '<div class="grid two"><div class="panel"><div class="row">'+customer(u)+badge(u.status)+'</div><div class="kv"><span>Email</span><b>'+esc(u.email)+'</b></div><div class="kv"><span>Account number</span><b>'+esc(u.account_number)+'</b></div><div class="kv"><span>Account type</span><b>Personal · '+esc(u.currency)+'</b></div><div class="kv"><span>Created</span><b>'+date(u.created_at)+'</b></div><div class="kv"><span>Identity</span><b>'+badge(u.verification_status)+'</b></div><div class="kv"><span>Card</span><b>•••• '+esc(u.last4||'—')+' · '+(u.frozen?'Frozen':'Active')+'</b></div><div class="kv"><span>Available balance</span><b>'+money(u.balance)+'</b></div></div>'+
 '<div class="panel"><h2 class="title2">Account status</h2><p class="muted small">Suspended customers cannot sign in or use banking actions.</p><button class="btn '+(u.status==='active'?'danger':'good')+'" data-act="status" data-id="'+u.id+'" data-status="'+(u.status==='active'?'suspended':'active')+'">'+(u.status==='active'?'Suspend customer':'Reactivate customer')+'</button><h2 class="title2 section">Admin balance adjustment</h2><p class="muted small">Each adjustment is written to the ledger. Provide a clear internal reason.</p><form class="form" data-form="adjust" data-id="'+u.id+'"><label class="field">Direction<select name="direction"><option value="credit">Credit account</option><option value="debit">Debit account</option></select></label><label class="field">Amount (USD)<input name="amount" type="number" min="0.01" step="0.01" required></label><label class="field">Reason<textarea name="reason" required minlength="3" maxlength="240" placeholder="Reason for adjustment"></textarea></label><button class="btn primary">Post ledger adjustment</button></form></div></div>'+
 '<div class="panel section"><h2 class="title2">Identity information</h2>'+(v?'<div class="kv"><span>Legal name</span><b>'+esc(v.legal_name)+'</b></div><div class="kv"><span>Date of birth</span><b>'+esc(v.date_of_birth)+'</b></div><div class="kv"><span>Address</span><b>'+esc(v.address)+'</b></div><div class="kv"><span>ID type</span><b>'+esc(v.id_type)+'</b></div><div class="kv"><span>Review status</span><b>'+badge(v.review_status)+'</b></div><div class="kv"><span>Admin note</span><b>'+esc(v.admin_note||'—')+'</b></div>':'<p class="muted">No identity submission on file.</p>')+'</div>'+
 '<div class="panel section"><h2 class="title2">Account transactions</h2>'+table(['Reference','Type','Amount','Balance after','Counterparty','Note'],tx)+(tx?'':noRows('No transactions.'))+'</div>'+
 '<div class="panel section"><h2 class="title2">Admin actions on this customer</h2>'+table(['Action','Amount','Details','When'],(d.audit||[]).map(a=>'<tr><td>'+esc(a.action)+'</td><td>'+ (a.amount==null?'—':money(a.amount))+'</td><td>'+esc(a.details||'—')+'</td><td>'+date(a.created_at)+'</td></tr>').join(''))+'</div>';
}
async function kyc(){
 const d=await api('GET','/api/admin/kyc?status='+encodeURIComponent(S.kycStatus)),rows=d.requests||[];
 $('#kycCount').textContent=rows.filter(x=>x.review_status==='submitted').length;
 root.innerHTML=head('Identity review','Review customer identity information. Verification is handled by an administrator; no SSN or ITIN collection.')+
 '<div class="tabs">'+[['pending','Pending'],['approved','Approved'],['rejected','Rejected'],['all','All']].map(x=>'<button class="tab '+(S.kycStatus===x[0]?'active':'')+'" data-act="kyc-filter" data-status="'+x[0]+'">'+x[1]+'</button>').join('')+'</div>'+
 (rows.map(v=>'<div class="panel kyccard"><div><div class="row space"><div><h3>'+esc(v.legal_name)+'</h3><div class="muted small">'+esc(v.full_name)+' · '+esc(v.email)+' · Account '+esc(v.account_number)+'</div></div>'+badge(v.review_status)+'</div><dl><dt>Date of birth</dt><dd>'+esc(v.date_of_birth)+'</dd><dt>Address</dt><dd>'+esc(v.address)+'</dd><dt>Government ID type</dt><dd>'+esc(v.id_type)+'</dd><dt>Submitted</dt><dd>'+date(v.submitted_at)+'</dd><dt>Admin note</dt><dd>'+esc(v.admin_note||'—')+'</dd></dl></div>'+(v.review_status==='submitted'?'<div class="actions"><button class="btn" data-act="kyc-docs" data-id="'+v.id+'">View ID documents</button><textarea data-note="'+v.id+'" placeholder="Internal review note (optional)"></textarea><button class="btn good" data-act="kyc-review" data-id="'+v.id+'" data-decision="approved">Approve</button><button class="btn danger" data-act="kyc-review" data-id="'+v.id+'" data-decision="rejected">Reject</button></div>':'<div class="actions"><span class="muted small">Reviewed '+date(v.reviewed_at)+'</span></div>')+'</div>').join('')||'<div class="panel">'+noRows('No '+S.kycStatus+' identity submissions.')+'</div>');
}
async function transactions(){
 const d=await api('GET','/api/admin/transactions?q='+encodeURIComponent(S.txQuery)+'&type='+encodeURIComponent(S.txType)+(S.txFrom?'&from='+new Date(S.txFrom+'T00:00:00').getTime():'')+(S.txTo?'&to='+(new Date(S.txTo+'T23:59:59').getTime()):'')+'&limit=250');
 S.txRows=d.transactions||[];
 const rows=S.txRows.map(t=>'<tr><td>#'+t.id+'<small class="muted" style="display:block">'+date(t.created_at)+'</small></td><td>'+customer({full_name:t.full_name,email:t.email})+'</td><td><span class="small">'+esc(t.account_number)+'</span></td><td>'+esc(t.type)+'</td><td class="'+(t.amount<0?'':'')+'">'+money(Math.abs(t.amount))+'</td><td>'+money(t.balance_after)+'</td><td>'+esc(t.counterparty)+'</td><td>'+esc(t.note||'—')+'</td></tr>').join('');
 root.innerHTML=head('Transactions','Read-only banking ledger review. Export filtered transactions for reconciliation.')+
 '<div class="panel"><form class="toolbar" data-form="tx-filter"><div class="searchwrap"><input class="search" name="q" value="'+esc(S.txQuery)+'" placeholder="Search customer, account or reference"></div><select class="filter" name="type"><option value="all">All types</option>'+['transfer_in','transfer_out','deposit','airtime','bill','admin_credit','admin_debit'].map(x=>'<option value="'+x+'">'+x.replace(/_/g,' ')+'</option>').join('')+'</select><input class="filter" type="date" name="from" value="'+esc(S.txFrom)+'"><input class="filter" type="date" name="to" value="'+esc(S.txTo)+'"><button class="btn primary">Filter</button><button type="button" class="btn" data-act="csv">Export CSV</button></form><div class="muted small" style="margin-bottom:10px">'+d.total+' ledger entries shown up to 250 rows</div>'+table(['Reference','Customer','Account','Type','Amount','Balance','Counterparty','Note'],rows)+(rows?'':noRows('No transactions match these filters.'))+'</div>';
 const sel=$('select[name=type]');if(sel)sel.value=S.txType;
}
async function chat(){
 const d=await api('GET','/api/admin/chat/sessions'),sessions=d.sessions||[];
 $('#chatCount').textContent=sessions.filter(s=>s.status==='open').length;
 if(!S.chatId&&sessions.length)S.chatId=sessions[0].id;
 const active=sessions.find(s=>s.id===S.chatId);
 const messages=active?await api('GET','/api/admin/chat/sessions/'+active.id+'/messages'):{messages:[]};
 const list=sessions.map(s=>'<button class="chatitem '+(s.id===S.chatId?'active':'')+'" data-act="chat-select" data-id="'+s.id+'"><div class="row space"><b>'+esc(s.full_name||('Customer #'+s.user_id))+'</b>'+((s.unread_count||0)>0?'<span class="badge submitted">'+s.unread_count+'</span>':'')+'</div><small>'+esc(s.email||'')+' · '+esc(s.status)+'</small><small>'+esc(s.last_message||'No messages yet')+'</small></button>').join('');
 const msgs=(messages.messages||[]).map(m=>'<div class="bubble '+(m.sender_role==='admin'?'admin':'')+'">'+esc(m.message)+'<small>'+esc(m.sender_name)+' · '+date(m.created_at)+'</small></div>').join('');
 root.innerHTML=head('Support chat','Respond to customer questions and close resolved conversations.','<button class="btn" data-act="refresh">Refresh</button>')+
 '<div class="panel chatlayout"><div class="chatlist">'+(list||noRows('No support conversations yet.'))+'</div><div class="chatpane">'+(active?'<div class="chathead"><div><b>'+esc(active.full_name||'Customer')+'</b><div class="muted small">'+esc(active.email||'')+' · '+badge(active.status)+'</div></div><button class="btn" data-act="chat-close" data-id="'+active.id+'" data-status="'+(active.status==='open'?'closed':'open')+'">'+(active.status==='open'?'Close chat':'Reopen')+'</button></div><div class="messages" id="chatMessages">'+(msgs||noRows('No messages in this conversation.'))+'</div><form class="chatcompose" data-form="chat-reply" data-id="'+active.id+'"><textarea name="message" maxlength="2000" placeholder="Write a reply…" required '+(active.status==='closed'?'disabled':'')+'></textarea><button class="btn primary" '+(active.status==='closed'?'disabled':'')+'>Send</button></form>':'<div class="empty">Select a conversation to read and reply.</div>')+'</div></div>';
 const m=$('#chatMessages');if(m)m.scrollTop=m.scrollHeight;
}
async function email(){
 if(!S.recipients.length){const d=await api('GET','/api/admin/email/recipients');S.recipients=d.users||[];}
 const visible=S.recipients.filter(u=>(u.fullName+' '+u.email).toLowerCase().includes((S.emailSearch||'').toLowerCase()));
 const count=S.emailAudience==='all'?S.recipients.length:S.emailAudience==='active'?S.recipients.filter(u=>u.status==='active').length:S.selected.length;
 root.innerHTML=head('Mail centre','Send account announcements and service updates to customers.')+
 '<div class="grid two"><div class="panel"><h2 class="title2">Audience</h2><div class="tabs">'+[['all','All customers'],['active','Active customers'],['selected','Selected']].map(x=>'<button class="tab '+(S.emailAudience===x[0]?'active':'')+'" data-act="email-audience" data-audience="'+x[0]+'">'+x[1]+'</button>').join('')+'</div><div class="toolbar"><input class="search" id="recipientSearch" placeholder="Find customer" value="'+esc(S.emailSearch||'')+'"><button class="btn" data-act="select-visible">Select visible</button></div><div style="max-height:420px;overflow:auto">'+visible.map(u=>'<label class="row" style="padding:9px 2px;border-bottom:1px solid #ffffff0d;cursor:pointer"><input type="checkbox" data-recipient="'+u.id+'" '+(S.selected.includes(u.id)?'checked':'')+'><span style="min-width:0;flex:1"><b style="display:block;font-size:12px">'+esc(u.fullName)+'</b><small class="muted">'+esc(u.email)+' · '+esc(u.status)+'</small></span></label>').join('')+'</div><p class="muted small">'+count+' recipients selected</p></div>'+
 '<div class="panel"><h2 class="title2">Compose email</h2><form class="form" data-form="email"><label class="field">Subject<input name="subject" maxlength="180" required placeholder="Service update"></label><label class="field">Message<textarea name="message" maxlength="10000" rows="12" required placeholder="Write your message to customers…"></textarea></label><p class="muted small">Messages are sent privately to each recipient. Requires configured Resend sender credentials.</p><button class="btn primary" '+(!count?'disabled':'')+'>Send to '+count+' customers</button></form></div></div>';
}
async function audit(){
 const d=await api('GET','/api/admin/audit?limit=250'),rows=(d.events||[]).map(a=>'<tr><td>#'+a.id+'</td><td>'+date(a.created_at)+'</td><td>'+esc(a.admin_email)+'</td><td>'+esc(a.action)+'</td><td>'+(a.target_user_id?'<button class="btn" data-act="user" data-id="'+a.target_user_id+'">Customer #'+a.target_user_id+'</button>':'—')+'</td><td>'+(a.amount==null?'—':money(a.amount))+'</td><td>'+esc(a.details||'—')+'</td></tr>').join('');
 root.innerHTML=head('Admin activity','Audit trail of administrator actions and account changes.')+'<div class="panel">'+table(['ID','Time','Admin','Action','Customer','Amount','Details'],rows)+(rows?'':noRows('No admin activity recorded.'))+'</div>';
}
function showDocs(id,docs){
 const files=[['front','Front of ID'],['back','Back of ID'],['selfie','Selfie']].filter(x=>docs[x[0]]);
 const overlay=document.createElement('div');overlay.className='docmodal';overlay.innerHTML='<div class="docpanel"><div class="row space"><h2 class="title2">Identity documents · Request #'+id+'</h2><button class="btn" data-act="close-docs">Close</button></div>'+files.map(x=>'<section class="docimage"><h3>'+x[1]+'</h3><img src="'+esc(docs[x[0]])+'" alt="'+x[1]+'"><a class="btn" href="'+esc(docs[x[0]])+'" download="prime-trust-kyc-'+id+'-'+x[0]+'.jpg">Download image</a></section>').join('')+(files.length?'':'<p class="muted">No document images were attached.</p>')+'</div>';
 root.appendChild(overlay);
}
function setPage(page){if(page==='user-detail')S.page='user-detail';else S.page=page;renderNav();renderPage().catch(e=>{root.innerHTML='<div class="panel">'+esc(e.message)+'</div>';});}
function downloadCsv(){
 const rows=S.txRows||[];const cols=['id','full_name','email','account_number','type','amount','balance_after','counterparty','note','created_at'];
 const quote=v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"';
 const csv=[cols.join(','),...rows.map(r=>cols.map(k=>quote(k==='amount'?Number(r[k])/100:k==='balance_after'?Number(r[k])/100:r[k])).join(','))].join('\r
');
 const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='prime-trust-transactions.csv';a.click();URL.revokeObjectURL(url);
}
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#loginErr').textContent='';const d=Object.fromEntries(new FormData(e.target));try{await api('POST','/api/admin/login',d);showWorkspace(true);await go('overview');}catch(err){$('#loginErr').textContent=err.message;}});
$('#logout').addEventListener('click',async()=>{try{await api('POST','/api/admin/logout',{});}catch(_){}showWorkspace(false);S.page='overview';});
$('#nav').addEventListener('click',e=>{const b=e.target.closest('[data-page]');if(b)go(b.dataset.page);});
root.addEventListener('click',async e=>{
 const row=e.target.closest('tr[data-open=\"user\"]');if(row){S.userId=Number(row.dataset.id);setPage('user-detail');return;}
 const b=e.target.closest('[data-act]');if(!b)return;const a=b.dataset.act;
 try{
  if(a==='page'){setPage(b.dataset.page);return;}
  if(a==='refresh'){await go(S.page);return;}
  if(a==='user'){S.userId=Number(b.dataset.id);setPage('user-detail');return;}
  if(a==='status'){const status=b.dataset.status;if(!confirm('Set this customer account to '+status+'?'))return;await api('PATCH','/api/admin/users/'+b.dataset.id,{status,reason:'Admin account status update'});notify('Customer status updated.');await userDetail();return;}
  if(a==='kyc-filter'){S.kycStatus=b.dataset.status;await kyc();return;}
  if(a==='kyc-docs'){const d=await api('GET','/api/admin/requests/'+b.dataset.id);showDocs(b.dataset.id,d.documents||{});return;}
  if(a==='close-docs'){const modal=b.closest('.docmodal');if(modal)modal.remove();return;}
  if(a==='card'){const frozen=b.dataset.frozen==='true';if(!confirm((frozen?'Freeze':'Unfreeze')+' this customer card?'))return;await api('PATCH','/api/admin/users/'+b.dataset.id+'/card',{frozen});notify(frozen?'Customer card frozen.':'Customer card unfrozen.');await userDetail();return;}
  if(a==='kyc-review'){const decision=b.dataset.decision,id=b.dataset.id;if(!confirm((decision==='approved'?'Approve':'Reject')+' this identity verification?'))return;b.disabled=true;const note=$('[data-note="'+id+'"]').value;await api('POST','/api/admin/requests/'+id+'/review',{decision,note});notify('Identity review updated.');await kyc();return;}
  if(a==='csv'){downloadCsv();return;}
  if(a==='chat-select'){S.chatId=Number(b.dataset.id);await chat();return;}
  if(a==='chat-close'){const status=b.dataset.status;await api('PATCH','/api/admin/chat/sessions/'+b.dataset.id+'/close',{status});notify(status==='closed'?'Conversation closed.':'Conversation reopened.');await chat();return;}
  if(a==='email-audience'){S.emailAudience=b.dataset.audience;await email();return;}
  if(a==='select-visible'){const q=(S.emailSearch||'').toLowerCase(),vis=S.recipients.filter(u=>(u.fullName+' '+u.email).toLowerCase().includes(q)).map(u=>u.id);S.selected=Array.from(new Set(S.selected.concat(vis)));await email();return;}
 }catch(err){notify(err.message,true);b.disabled=false;}
});
root.addEventListener('change',async e=>{
 if(e.target.matches('#userStatus')){await users($('#userSearch').value,e.target.value);return;}
 if(e.target.matches('[data-recipient]')){const id=Number(e.target.dataset.recipient);S.selected=e.target.checked?Array.from(new Set(S.selected.concat(id))):S.selected.filter(x=>x!==id);await email();}
});
root.addEventListener('input',e=>{
 if(e.target.matches('#userSearch')){const value=e.target.value,sel=$('#userStatus')?.value||'all';clearTimeout(S.userTimer);S.userTimer=setTimeout(()=>users(value,sel).then(()=>{const input=$('#userSearch');if(input){input.focus();input.setSelectionRange(value.length,value.length);}}).catch(err=>notify(err.message,true)),250);}
 if(e.target.matches('#recipientSearch')){S.emailSearch=e.target.value;const value=S.emailSearch;clearTimeout(S.emailTimer);S.emailTimer=setTimeout(()=>email().then(()=>{const input=$('#recipientSearch');if(input){input.focus();input.setSelectionRange(value.length,value.length);}}).catch(err=>notify(err.message,true)),250);}
});
root.addEventListener('submit',async e=>{
 const form=e.target.closest('form[data-form]');if(!form)return;e.preventDefault();const data=Object.fromEntries(new FormData(form));const type=form.dataset.form;
 try{
  if(type==='adjust'){const id=form.dataset.id;if(!confirm('Post this ledger adjustment?'))return;await api('POST','/api/admin/users/'+id+'/adjust-balance',data);notify('Adjustment posted to the ledger.');S.userId=Number(id);await userDetail();return;}
  if(type==='tx-filter'){S.txQuery=data.q||'';S.txType=data.type||'all';S.txFrom=data.from||'';S.txTo=data.to||'';await transactions();return;}
  if(type==='chat-reply'){const id=form.dataset.id;await api('POST','/api/admin/chat/sessions/'+id+'/reply',data);await chat();notify('Reply sent to the support conversation.');return;}
  if(type==='email'){const count=S.emailAudience==='all'?S.recipients.length:S.emailAudience==='active'?S.recipients.filter(u=>u.status==='active').length:S.selected.length;if(!confirm('Send this email to '+count+' customers?'))return;const result=await api('POST','/api/admin/email/send',{audience:S.emailAudience,userIds:S.emailAudience==='selected'?S.selected:[],subject:data.subject,message:data.message});notify('Email campaign finished: '+result.sent+' sent, '+result.failed+' failed.');root.insertAdjacentHTML('afterbegin','<div class="panel section"><b>Campaign results</b><p class="muted small">Total '+result.total+' · Sent '+result.sent+' · Failed '+result.failed+'</p>'+(result.failures||[]).map(x=>'<p class="small">'+esc(x.email)+': '+esc(x.error)+'</p>').join('')+'</div>');return;}
 }catch(err){notify(err.message,true);}
});

api('GET','/api/admin/overview').then(()=>{showWorkspace(true);go('overview');}).catch(()=>showWorkspace(false));
})();