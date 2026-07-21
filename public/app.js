// Gestor de Gastos v3 — Frontend (Cardinal)
const $=id=>document.getElementById(id);
let TOKEN=localStorage.getItem('gc_token')||null;
const api=async(m,u,b)=>{const o={method:m,headers:{'Content-Type':'application/json'}};if(TOKEN)o.headers['Authorization']='Bearer '+TOKEN;if(b)o.body=JSON.stringify(b);const r=await fetch(u,o);return r.json();};
const esc=s=>String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let CUR='USD';
const fmt=n=>{ const v=Number(n||0); return (v<0?'-':'')+'$'+Math.abs(v).toLocaleString('es',{minimumFractionDigits:2,maximumFractionDigits:2}); };

async function boot(){
  setupAuth();
  if(!TOKEN){ $('auth').classList.remove('hidden'); return; }
  const acc=await api('GET','/api/auth/me');
  if(!acc.loggedIn){ TOKEN=null; localStorage.removeItem('gc_token'); $('auth').classList.remove('hidden'); return; }
  await loadApp();
}
async function loadApp(){
  $('auth').classList.add('hidden');
  renderAll();
  bind();
  // Tutorial la primera vez
  const d=await api('GET','/api/pay');
  if(!localStorage.getItem('gc_tut') && d.pay && !d.pay.frequency){ /* mostrar tras primer guardado */ }
  $('acctName').textContent=(await api('GET','/api/auth/me')).user?.name||'';
}

// ---- AUTH ----
let AUTH_MODE='register';
function authErr(msg){ const e=$('authErr'); if(!msg){e.classList.add('hidden');return;} e.textContent=msg; e.classList.remove('hidden'); }
async function doAuth(){ authErr(''); const email=$('authEmail').value.trim(),pw=$('authPw').value,name=$('authName').value.trim(); if(!email||!pw){authErr('Escribe tu email y contraseña');return;} const path=AUTH_MODE==='register'?'/api/auth/register':'/api/auth/login'; const body=AUTH_MODE==='register'?{email,password:pw,name}:{email,password:pw}; const r=await api('POST',path,body); if(r.token){TOKEN=r.token;localStorage.setItem('gc_token',TOKEN);await loadApp();} else authErr(r.error||'No se pudo'); }
async function googleLogin(credential){ const r=await api('POST','/api/auth/google',{credential}); if(r.token){TOKEN=r.token;localStorage.setItem('gc_token',TOKEN);await loadApp();} else authErr(r.error||'Error con Google'); }
function setupAuth(){
  $('authSubmit').addEventListener('click',doAuth);
  $('authToggle').addEventListener('click',e=>{e.preventDefault();AUTH_MODE=AUTH_MODE==='register'?'login':'register';$('authSubmit').textContent=AUTH_MODE==='register'?'Crear cuenta Cardinal':'Iniciar sesión';$('authToggleTxt').textContent=AUTH_MODE==='register'?'¿Ya tienes cuenta?':'¿No tienes cuenta?';$('authToggle').textContent=AUTH_MODE==='register'?'Inicia sesión':'Regístrate';$('authNameL').style.display=AUTH_MODE==='register'?'':'none';authErr('');});
  $('authSkip').addEventListener('click',async e=>{e.preventDefault();TOKEN=null;localStorage.removeItem('gc_token');await loadApp();});
  const cid=window.__GOOGLE_CID__;
  if(cid){ const init=()=>{ if(!window.google||!google.accounts){setTimeout(init,300);return;} google.accounts.id.initialize({client_id:cid,callback:r=>googleLogin(r.credential)}); google.accounts.id.renderButton($('gbtn'),{theme:'filled_blue',size:'large',width:320,text:'continue_with'}); }; init(); }
  else { $('gbtn').style.display='none'; const fb=$('authGoogleFallback'); fb.classList.remove('hidden'); fb.addEventListener('click',()=>authErr('El login con Google se activa cuando Cardinal lo configure. Usa email y contraseña 👇')); }
  // Tutorial
  $('tutDone').addEventListener('click',async()=>{$('tutorial').classList.add('hidden');localStorage.setItem('gc_tut','1');await api('POST','/api/tutorial',{done:true});});
}

// ---- PAY + GOAL ----
async function savePay(){ const freq=$('payFreq').value, amount=Number($('payAmount').value)||0, title=$('goalTitle').value.trim(), target=Number($('goalTarget').value)||0; const r=await api('POST','/api/pay',{frequency:freq,amount,title,target}); renderPlan(r.plan); if(!localStorage.getItem('gc_tut')){ $('tutorial').classList.remove('hidden'); } }
function renderPlan(p){ const el=$('planView'); if(!p||!p.hasGoal){ el.innerHTML='<p class="muted small">Fija tu meta y te diré cuánto tardas en alcanzarla.</p>'; return; } if(p.reached){ el.innerHTML='<p class="ok">🎉 ¡Meta alcanzada!</p>'; return; } if(p.needAmount){ el.innerHTML='<p class="muted small">Meta: '+fmt(p.remaining)+'. Falta tu monto de cobro para calcular el tiempo.</p>'; return; } el.innerHTML=`<div class="plan-card"><p>Para ahorrar <b>${fmt(p.remaining)}</b> cobrando <b>${fmt(p.amount)}</b> ${p.freq} necesitas <b>${p.periods} ${p.unit}</b>.</p><div class="goal-bar"><div class="goal-fill" style="width:${Math.min(100,100-(p.remaining/(p.target||1)*100))}%"></div></div></div>`; }
function loadPay(){ api('GET','/api/pay').then(d=>{ if(d.pay){ $('payFreq').value=d.pay.frequency||'mensual'; $('payAmount').value=d.pay.amount||''; $('goalTitle').value=d.goals?.title||''; $('goalTarget').value=d.goals?.target||''; } renderPlan(d.plan); }); }

// ---- RENDER ----
async function renderAll(){ loadCategories(); loadPay(); loadTransactions(); loadBudgets(); loadRules(); loadSettings(); loadAccount(); }
function loadCategories(){ api('GET','/api/categories').then(cs=>{ const sel=$('category'); const fsel=$('fCategory'); sel.innerHTML=cs.map(c=>`<option value="${c}">${c}</option>`).join(''); fsel.innerHTML='<option value="">Todas las categorías</option>'+cs.map(c=>`<option value="${c}">${c}</option>`).join(''); }); }
async function loadTransactions(){ const q=new URLSearchParams(); if($('fSearch').value)q.set('search',$('fSearch').value); if($('fFrom').value)q.set('from',$('fFrom').value); if($('fTo').value)q.set('to',$('fTo').value); if($('fCategory').value)q.set('category',$('fCategory').value); if($('fType').value)q.set('type',$('fType').value); const d=await api('GET','/api/transactions?'+q.toString()); CUR=d.currency||'USD'; $('currencyBadge').textContent=CUR; renderSummary(d); renderCatBars(d); renderHistory(d.transactions); renderMonthly(d.monthly); }
function renderSummary(d){ const s=d.summary; $('sumIncome').textContent=fmt(s.income); $('sumExpense').textContent=fmt(s.expense); $('sumBalance').textContent=fmt(s.balance); }
function renderCatBars(d){ const bc=d.summary.byCategory; const el=$('catBars'); const cats=Object.entries(bc).sort((a,b)=>b[1]-a[1]); if(!cats.length){el.innerHTML='<p class="empty">Sin gastos.</p>';return;} const max=Math.max(...cats.map(c=>c[1])); el.innerHTML=cats.map(([c,v])=>`<div class="catbar"><span class="catname">${esc(c)}</span><div class="bar"><div class="fill" style="width:${(v/max*100).toFixed(0)}%"></div></div><span class="catval">${fmt(v)}</span></div>`).join(''); }
function renderHistory(txns){ const el=$('txList'); if(!txns.length){el.innerHTML='<li class="empty">No hay movimientos.</li>';return;} el.innerHTML=txns.slice().reverse().map(t=>`<li class="tx ${t.type}"><span class="txdesc">${esc(t.description)} <small class="muted">${esc(t.category)}</small></span><span class="txamt">${t.type==='income'?'+':'-'}${fmt(t.amount)}</span><button class="txdel" data-id="${t.id}">✕</button></li>`).join(''); el.querySelectorAll('.txdel').forEach(b=>b.onclick=async()=>{await api('DELETE','/api/transactions/'+b.dataset.id);loadTransactions();}); }
function renderMonthly(m){ const el=$('monthlyChart'); if(!m||!m.length){el.innerHTML='<p class="empty">Sin datos para graficar.</p>';return;} const max=Math.max(...m.map(x=>Math.max(x.income,x.expense)),1); el.innerHTML=m.map(x=>`<div class="mrow"><span class="mlabel">${x.month}</span><div class="mbars"><div class="mbar inc" style="width:${(x.income/max*100).toFixed(0)}%" title="Ingresos ${fmt(x.income)}"></div><div class="mbar exp" style="width:${(x.expense/max*100).toFixed(0)}%" title="Gastos ${fmt(x.expense)}"></div></div><span class="mnet">${fmt(x.net)}</span></div>`).join(''); }
async function loadBudgets(){ const d=await api('GET','/api/budgets'); const el=$('budgetList'); const cats=Object.keys(d.budgets||{}); if(!cats.length){el.innerHTML='<p class="muted small">Sin presupuestos.</p>';return;} el.innerHTML=cats.map(c=>{const lim=d.budgets[c];const sp=(d.spent&&d.spent[c])||0;const pct=Math.min(100,sp/lim*100);return `<div class="budget"><span>${esc(c)}</span><div class="bar"><div class="fill ${pct>90?'over':''}" style="width:${pct.toFixed(0)}%"></div></div><span>${fmt(sp)}/${fmt(lim)}</span><button class="txdel" data-cat="${esc(c)}">✕</button></div>`;}).join(''); el.querySelectorAll('.txdel').forEach(b=>b.onclick=async()=>{await api('DELETE','/api/budgets/'+encodeURIComponent(b.dataset.cat));loadBudgets();}); }
async function loadRules(){ const rs=await api('GET','/api/rules'); const el=$('ruleList'); if(!rs.length){el.innerHTML='<li class="muted small">Sin reglas.</li>';return;} el.innerHTML=rs.map(r=>`<li>${esc(r.keyword)} → <b>${esc(r.category)}</b> <button class="txdel" data-id="${r.id}">✕</button></li>`).join(''); el.querySelectorAll('.txdel').forEach(b=>b.onclick=async()=>{await api('DELETE','/api/rules/'+b.dataset.id);loadRules();}); }
async function loadSettings(){ const s=await api('GET','/api/settings'); if(s.currency)$('setCurrency').value=s.currency; }
async function loadAccount(){ const acc=await api('GET','/api/auth/me'); const box=$('acctBox'); if(acc.loggedIn){ box.innerHTML=`<h3>👤 Tu Cuenta Cardinal</h3><p class="small">${esc(acc.user.name)} · <span class="muted">${esc(acc.user.email)}</span> ${acc.user.provider==='google'?'<span class="muted">(Google)</span>':''}</p><button id="logoutBtn" class="btn wide sec">🚪 Cerrar sesión</button>`; $('logoutBtn').onclick=async()=>{await api('POST','/api/auth/logout');TOKEN=null;localStorage.removeItem('gc_token');location.reload();}; } else { box.innerHTML=`<h3>👤 Cuenta</h3><p class="small muted">Sin cuenta: tus datos solo en este equipo.</p><button id="loginNowBtn" class="btn wide">Crear cuenta / Iniciar sesión</button>`; $('loginNowBtn').onclick=()=>$('auth').classList.remove('hidden'); } }

// ---- BIND ----
function bind(){
  $('txForm').onsubmit=async e=>{ e.preventDefault(); const b={type:$('type').value,amount:$('amount').value,description:$('description').value,category:$('category').value,date:$('date').value||undefined,tags:$('tags').value.split(',').map(s=>s.trim()).filter(Boolean)}; await api('POST','/api/transactions',b); e.target.reset(); loadTransactions(); };
  $('fileInput').onchange=async e=>{const f=e.target.files[0];if(!f)return;const txt=await f.text();const fmt=f.name.endsWith('.ofx')||f.name.endsWith('.qfx')?'ofx':'csv';const r=await api('POST','/api/import',{content:txt,format:fmt});alert('Importados: '+r.added);loadTransactions();};
  $('fSearch').oninput=()=>debounce(loadTransactions,300)(); $('fFrom').onchange=loadTransactions; $('fTo').onchange=loadTransactions; $('fCategory').onchange=loadTransactions; $('fType').onchange=loadTransactions; $('fClear').onclick=()=>{['fSearch','fFrom','fTo'].forEach(i=>$(i).value='');$('fCategory').value='';$('fType').value='';loadTransactions();};
  $('paySave').onclick=savePay;
  $('editGoal').onclick=()=>{ $('goalTarget').focus(); };
  $('addBudget').onclick=async()=>{const c=prompt('Categoría:');const l=prompt('Límite mensual:');if(c&&l){await api('POST','/api/budgets',{category:c,limit:Number(l)});loadBudgets();}};
  $('addRule').onclick=async()=>{const k=prompt('Palabra clave:');const c=prompt('Categoría (Comida, Transporte, Hogar, Salud, Ocio, Estudios, Otros):');if(k&&c){await api('POST','/api/rules',{keyword:k,category:c});loadRules();}};
  $('saveSettings').onclick=async()=>{const cur=$('setCurrency').value.trim();await api('POST','/api/settings',{currency:cur});CUR=cur;$('currencyBadge').textContent=cur;loadTransactions();};
}
function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}

boot();
