// Gestor de Gastos Personales - Backend v3 (Cardinal, multi-usuario, Cuentas Cardinal)
// Puerto desde $PORT (Render) o 3000. Usa Redis compartido (misma instancia que GYMQUEST).
// Almacenamiento por usuario: 'gastos:data:<userId>'. Cuentas en 'cardinal:users' (módulo).
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const createAuth = require('./lib/cardinal-auth');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data.json');
const BACKUP_DIR = path.join(ROOT, 'backups');
const AUTH = createAuth(process.env.REDIS_URL);
const REDIS_URL = process.env.REDIS_URL || null;

const DEFAULT_CATEGORIES = ['Comida','Transporte','Hogar','Salud','Ocio','Estudios','Otros'];

function round2(n){ return Math.round(Number(n)*100)/100; }
function sendJSON(res, status, obj){ res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(obj)); }
function readBody(req){ return new Promise((res,rej)=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{try{res(b?JSON.parse(b):{})}catch(e){res({})}}); req.on('error',rej); }); }
function newId(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

// ---- Almacenamiento por usuario (Redis) ----
let redis=null;
async function ensureRedis(){ if(redis) return redis; const {createClient}=require('redis'); redis=createClient({url:REDIS_URL}); redis.on('error',e=>console.log('[gastos] redis err',e.message)); await redis.connect(); return redis; }
function defaultUser(){ return { transactions:[], budgets:{}, goals:{ target:0, title:'' }, rules:[], pay:{ frequency:'mensual', amount:0, currency:'USD' }, settings:{ currency:'USD' }, tutorialDone:false }; }
async function loadUser(userId){
  if(!REDIS_URL){ try{ return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }catch(e){ return defaultUser(); } }
  const r=await ensureRedis(); const raw=await r.get('gastos:data:'+userId); return raw?JSON.parse(raw):defaultUser();
}
async function saveUser(userId,data){ if(!REDIS_URL){ try{fs.writeFileSync(DATA_FILE,JSON.stringify(data));}catch(e){} return; } const r=await ensureRedis(); await r.set('gastos:data:'+userId,JSON.stringify(data)); }

// Devuelve el userId del token (Cuentas Cardinal) o 'anon' si no hay sesión
async function userIdForReq(req){
  const auth=req.headers['authorization']||''; const t=auth.replace(/^Bearer /,'').trim()||null;
  const u=await AUTH.me(t); return u?u.id:'anon';
}

function applyRules(description,data){ const desc=(description||'').toLowerCase(); for(const r of (data.rules||[])){ const kw=(r.keyword||'').toLowerCase(); if(kw&&desc.includes(kw))return r.category; } return null; }
function computeSummary(txns){ let income=0,expense=0; const byCategory={}; for(const t of txns){ if(t.type==='income')income+=t.amount; else {expense+=t.amount; byCategory[t.category]=(byCategory[t.category]||0)+t.amount;} } return {income:round2(income),expense:round2(expense),balance:round2(income-expense),byCategory}; }
function monthlySeries(txns){ const map={}; for(const t of txns){ const m=t.date.slice(0,7); if(!map[m])map[m]={month:m,income:0,expense:0}; if(t.type==='income')map[m].income+=t.amount; else map[m].expense+=t.amount; } return Object.values(map).sort((a,b)=>a.month<b.month?-1:1).map(x=>({...x,income:round2(x.income),expense:round2(x.expense),net:round2(x.income-x.expense)})); }

function parseCSV(text){ const lines=text.split(/\r?\n/).filter(l=>l.trim()!==''); if(!lines.length)return []; const delim=lines[0].includes(';')?';':','; const headers=lines[0].split(delim).map(h=>h.trim().toLowerCase()); const rows=[]; for(let i=1;i<lines.length;i++){ const cols=lines[i].split(delim); const obj={}; headers.forEach((h,j)=>obj[h]=cols[j]!==undefined?cols[j].trim():''); rows.push(obj); } return rows; }
function importCSV(text,data){ const rows=parseCSV(text); let added=0; for(const r of rows){ const desc=r.description||r.concepto||r.movimiento||r.detalle||r['memo']||''; const rawAmount=r.amount||r.monto||r.importe||r['transaction amount']||''; const typeRaw=(r.type||r.tipo||'').toLowerCase(); let amount=parseFloat(String(rawAmount).replace(/[^0-9.\-]/g,'')); if(isNaN(amount)||amount===0)continue; let type=amount<0?'expense':'income'; if(typeRaw.includes('ingres')||typeRaw.includes('credit')||typeRaw.includes('income'))type='income'; if(typeRaw.includes('gast')||typeRaw.includes('debit')||typeRaw.includes('expense'))type='expense'; amount=Math.abs(amount); const cat=applyRules(desc,data)||r.category||r.categoria||'Otros'; const date=(r.date||r.fecha||'').slice(0,10)||new Date().toISOString().slice(0,10); data.transactions.push({id:newId(),description:String(desc).slice(0,80),type,amount:round2(amount),category:cat,date,tags:[]}); added++; } return added; }
function importOFX(text,data){ const stmtrs=text.split(/<STMTRN>/i)[1]||text; const blocks=stmtrs.split(/<STMTTRN>/i).slice(1); let added=0; const reTrn=/<TRNTYPE>([^<]*)<[^>]*>.*?<DTPOSTED>([^<]*)<[^>]*>.*?<TRNAMT>([^<]*)<[^>]*>.*?<MEMO>([^<]*)</is; for(const b of blocks){ const m=b.match(reTrn); if(!m)continue; const typeRaw=m[1].toUpperCase(); const dateRaw=m[2].slice(0,8); const amount=parseFloat(m[3]); const memo=m[4]; if(isNaN(amount))continue; const type=amount<0?'expense':'income'; const date=`${dateRaw.slice(0,4)}-${dateRaw.slice(4,6)}-${dateRaw.slice(6,8)}`; const cat=applyRules(memo,data)||'Otros'; data.transactions.push({id:newId(),description:String(memo).slice(0,80),type,amount:round2(Math.abs(amount)),category:cat,date,tags:[]}); added++; } return added; }

function makeBackup(data){ try{ if(!fs.existsSync(BACKUP_DIR))fs.mkdirSync(BACKUP_DIR,{recursive:true}); const stamp=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-'); fs.writeFileSync(path.join(BACKUP_DIR,`backup-${stamp}.json.gz`),zlib.gzipSync(JSON.stringify(data))); }catch(e){} }

const CATEGORIES=DEFAULT_CATEGORIES;

// Cálculo de tiempo para llegar a la meta según frecuencia de cobro
function planForGoal(data){
  const bal=computeSummary(data.transactions).balance;
  const target=Number(data.goals&&data.goals.target)||0;
  const freq=data.pay&&data.pay.frequency||'mensual';
  const amount=Number(data.pay&&data.pay.amount)||0;
  if(target<=0) return {hasGoal:false};
  const remaining=round2(target-bal);
  if(remaining<=0) return {hasGoal:true,remaining:0,reached:true};
  if(amount<=0) return {hasGoal:true,remaining,reached:false,needAmount:true};
  const perMonth = freq==='semanal'?amount*4.33 : freq==='quincenal'?amount*2 : amount;
  const months = remaining/perMonth;
  let periods, unit;
  if(freq==='semanal'){ periods=Math.ceil(remaining/amount); unit='semanas'; }
  else if(freq==='quincenal'){ periods=Math.ceil(remaining/amount); unit='quincenas'; }
  else { periods=Math.ceil(months); unit='meses'; }
  return {hasGoal:true,remaining,reached:false,periods,unit,freq,amount,perMonth:round2(perMonth),months:round2(months)};
}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.apk':'application/vnd.android.package-archive'};
function serveStatic(req,res){ let u=req.url.split('?')[0]; if(u==='/')u='/index.html'; const fp=path.join(PUBLIC_DIR,path.normalize(u)); if(!fp.startsWith(PUBLIC_DIR)){res.writeHead(403);res.end('Forbidden');return;} fs.readFile(fp,(err,content)=>{ if(err){res.writeHead(404);res.end('Not found');return;} res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream'}); res.end(content); }); }

const server = http.createServer(async (req,res)=>{
  const url=req.url.split('?')[0];
  const q=Object.fromEntries(new URL(req.url,'http://x').searchParams);

  // ---- AUTH (Cuentas Cardinal) ----
  if(url==='/api/auth/register'&&req.method==='POST'){ (async()=>{ const b=await readBody(req); const r=await AUTH.register({email:b.email,name:b.name,password:b.password}); if(r.error)return sendJSON(res,400,{error:r.error}); const u=await AUTH.me(r.token); sendJSON(res,201,{token:r.token,user:{email:u.email,name:u.name}}); })(); return; }
  if(url==='/api/auth/login'&&req.method==='POST'){ (async()=>{ const b=await readBody(req); const r=await AUTH.login({email:b.email,password:b.password}); if(r.error)return sendJSON(res,401,{error:r.error}); const u=await AUTH.me(r.token); sendJSON(res,200,{token:r.token,user:{email:u.email,name:u.name}}); })(); return; }
  if(url==='/api/auth/google'&&req.method==='POST'){ (async()=>{ const b=await readBody(req); const r=await AUTH.google({credential:b.credential}); if(r.error)return sendJSON(res,400,{error:r.error}); const u=await AUTH.me(r.token); sendJSON(res,200,{token:r.token,user:{email:u.email,name:u.name}}); })(); return; }
  if(url==='/api/auth/me'&&req.method==='GET'){ (async()=>{ const auth=req.headers['authorization']||''; const t=auth.replace(/^Bearer /,'').trim()||null; const u=await AUTH.me(t); if(!u)return sendJSON(res,200,{loggedIn:false}); sendJSON(res,200,{loggedIn:true,user:{email:u.email,name:u.name,provider:u.provider}}); })(); return; }
  if(url==='/api/auth/logout'&&req.method==='POST'){ (async()=>{ const auth=req.headers['authorization']||''; const t=auth.replace(/^Bearer /,'').trim(); await AUTH.logout(t); sendJSON(res,200,{ok:true}); })(); return; }

  // ---- Panel de frecuencia de cobro ----
  if(url==='/api/pay'&&req.method==='GET'){ (async()=>{ const uid=await userIdForReq(req); const d=await loadUser(uid); sendJSON(res,200,{pay:d.pay||defaultUser().pay, plan:planForGoal(d)}); })(); return; }
  if(url==='/api/pay'&&req.method==='POST'){ (async()=>{ const uid=await userIdForReq(req); const b=await readBody(req); const d=await loadUser(uid); d.pay=d.pay||defaultUser().pay; if(b.frequency)d.pay.frequency=String(b.frequency).slice(0,10); if(b.amount!==undefined)d.pay.amount=round2(Number(b.amount)); if(b.currency)d.pay.currency=String(b.currency).slice(0,5); if(b.target!==undefined)d.goals.target=round2(Number(b.target)); if(b.title!==undefined)d.goals.title=String(b.title).slice(0,60); await saveUser(uid,d); sendJSON(res,200,{pay:d.pay,goals:d.goals,plan:planForGoal(d)}); })(); return; }

  // ---- Tutorial ----
  if(url==='/api/tutorial'&&req.method==='POST'){ (async()=>{ const uid=await userIdForReq(req); const b=await readBody(req); const d=await loadUser(uid); d.tutorialDone=!!b.done; await saveUser(uid,d); sendJSON(res,200,{ok:true,tutorialDone:d.tutorialDone}); })(); return; }

  // ---- Transacciones ----
  if(req.method==='GET'&&url==='/api/transactions'){ (async()=>{ const uid=await userIdForReq(req); const data=await loadUser(uid); let txns=data.transactions; if(q.from)txns=txns.filter(t=>t.date>=q.from); if(q.to)txns=txns.filter(t=>t.date<=q.to); if(q.category)txns=txns.filter(t=>t.category===q.category); if(q.type)txns=txns.filter(t=>t.type===q.type); if(q.search)txns=txns.filter(t=>(t.description||'').toLowerCase().includes(q.search.toLowerCase())||(t.tags||[]).join(' ').toLowerCase().includes(q.search.toLowerCase())); sendJSON(res,200,{transactions:txns,summary:computeSummary(txns),monthly:monthlySeries(txns),currency:data.settings.currency,pay:data.pay,plan:planForGoal(data)}); })(); return; }
  if(req.method==='POST'&&url==='/api/transactions'){ (async()=>{ try{ const uid=await userIdForReq(req); const data=await loadUser(uid); const b=await readBody(req); const amount=Number(b.amount); if(!b.description||!b.type||isNaN(amount)||amount<=0)return sendJSON(res,400,{error:'Datos inválidos'}); if(!['income','expense'].includes(b.type))return sendJSON(res,400,{error:'Tipo inválido'}); const cat=applyRules(b.description,data)||(CATEGORIES.includes(b.category)?b.category:'Otros'); const tx={id:newId(),description:String(b.description).slice(0,80),type:b.type,amount:round2(amount),category:cat,date:b.date||new Date().toISOString().slice(0,10),tags:Array.isArray(b.tags)?b.tags.slice(0,10):[]}; data.transactions.push(tx); await saveUser(uid,data); makeBackup(data); sendJSON(res,201,tx); }catch(e){ sendJSON(res,400,{error:'JSON inválido'}); } })(); return; }
  if(req.method==='PUT'&&url.startsWith('/api/transactions/')){ (async()=>{ const uid=await userIdForReq(req); const id=url.split('/').pop(); const data=await loadUser(uid); const t=data.transactions.find(x=>x.id===id); if(!t)return sendJSON(res,404,{error:'No encontrado'}); const b=await readBody(req); if(b.description!==undefined)t.description=String(b.description).slice(0,80); if(b.amount!==undefined){const a=Number(b.amount); if(!isNaN(a)&&a>0)t.amount=round2(a);} if(b.type!==undefined&&['income','expense'].includes(b.type))t.type=b.type; if(b.category!==undefined)t.category=CATEGORIES.includes(b.category)?b.category:'Otros'; if(b.date!==undefined)t.date=String(b.date).slice(0,10); if(b.tags!==undefined)t.tags=Array.isArray(b.tags)?b.tags.slice(0,10):[]; await saveUser(uid,data); makeBackup(data); sendJSON(res,200,t); })(); return; }
  if(req.method==='DELETE'&&url.startsWith('/api/transactions/')){ (async()=>{ const uid=await userIdForReq(req); const id=url.split('/').pop(); const data=await loadUser(uid); const before=data.transactions.length; data.transactions=data.transactions.filter(t=>t.id!==id); if(data.transactions.length===before)return sendJSON(res,404,{error:'No encontrado'}); await saveUser(uid,data); makeBackup(data); sendJSON(res,200,{ok:true}); })(); return; }

  if(req.method==='POST'&&url==='/api/import'){ (async()=>{ const uid=await userIdForReq(req); const data=await loadUser(uid); const b=await readBody(req); let added=0; const fmt=(b.format||'csv').toLowerCase(); if(fmt==='ofx'||fmt==='qfx')added=importOFX(b.content||'',data); else added=importCSV(b.content||'',data); await saveUser(uid,data); makeBackup(data); sendJSON(res,200,{added}); })(); return; }
  if(req.method==='GET'&&url==='/api/export'){ (async()=>{ const uid=await userIdForReq(req); const data=await loadUser(uid); const header='date,type,category,description,amount,tags'; const rows=data.transactions.map(t=>`${t.date},${t.type},${t.category},\"${String(t.description).replace(/\"/g,'\"\"')}\",${t.amount},${(t.tags||[]).join('|')}`); const csv=header+'\n'+rows.join('\n'); res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="gastos.csv"'}); res.end(csv); })(); return; }

  if(req.method==='GET'&&url==='/api/budgets'){ (async()=>{ const uid=await userIdForReq(req); const d=await loadUser(uid); sendJSON(res,200,{budgets:d.budgets||{},spent:computeSummary(d.transactions.filter(t=>t.type==='expense')).byCategory,currency:d.settings.currency}); })(); return; }
  if(req.method==='POST'&&url==='/api/budgets'){ (async()=>{ const uid=await userIdForReq(req); const b=await readBody(req); const d=await loadUser(uid); if(!CATEGORIES.includes(b.category))return sendJSON(res,400,{error:'Categoría inválida'}); d.budgets[b.category]=round2(Number(b.limit)); if(b.limit<=0)delete d.budgets[b.category]; await saveUser(uid,d); sendJSON(res,200,d.budgets); })(); return; }
  if(req.method==='DELETE'&&url.startsWith('/api/budgets/')){ (async()=>{ const uid=await userIdForReq(req); const cat=decodeURIComponent(url.split('/').pop()); const d=await loadUser(uid); delete d.budgets[cat]; await saveUser(uid,d); sendJSON(res,200,d.budgets); })(); return; }

  if(req.method==='GET'&&url==='/api/goals'){ (async()=>{ const uid=await userIdForReq(req); const d=await loadUser(uid); const bal=computeSummary(d.transactions).balance; sendJSON(res,200,{goal:d.goals||{},currentBalance:bal,plan:planForGoal(d)}); })(); return; }
  if(req.method==='POST'&&url==='/api/goals'){ (async()=>{ const uid=await userIdForReq(req); const b=await readBody(req); const d=await loadUser(uid); if(b.target!==undefined)d.goals.target=round2(Number(b.target)); if(b.title!==undefined)d.goals.title=String(b.title).slice(0,60); await saveUser(uid,d); sendJSON(res,200,d.goals); })(); return; }

  if(req.method==='GET'&&url==='/api/rules'){ (async()=>{ const uid=await userIdForReq(req); const d=await loadUser(uid); sendJSON(res,200,d.rules||[]); })(); return; }
  if(req.method==='POST'&&url==='/api/rules'){ (async()=>{ const uid=await userIdForReq(req); const b=await readBody(req); const d=await loadUser(uid); if(!b.keyword||!CATEGORIES.includes(b.category))return sendJSON(res,400,{error:'keyword y categoría requeridos'}); d.rules.push({id:newId(),keyword:String(b.keyword).slice(0,40),category:b.category}); await saveUser(uid,d); sendJSON(res,201,d.rules); })(); return; }
  if(req.method==='DELETE'&&url.startsWith('/api/rules/')){ (async()=>{ const uid=await userIdForReq(req); const id=url.split('/').pop(); const d=await loadUser(uid); d.rules=d.rules.filter(r=>r.id!==id); await saveUser(uid,d); sendJSON(res,200,d.rules); })(); return; }

  if(req.method==='GET'&&url==='/api/settings'){ (async()=>{ const uid=await userIdForReq(req); const d=await loadUser(uid); sendJSON(res,200,d.settings||{currency:'USD'}); })(); return; }
  if(req.method==='POST'&&url==='/api/settings'){ (async()=>{ const uid=await userIdForReq(req); const b=await readBody(req); const d=await loadUser(uid); if(b.currency)d.settings.currency=String(b.currency).slice(0,5); await saveUser(uid,d); sendJSON(res,200,d.settings); })(); return; }
  if(req.method==='GET'&&url==='/api/categories'){ sendJSON(res,200,CATEGORIES); return; }

  if(req.method==='GET') return serveStatic(req,res);
  sendJSON(res,404,{error:'Ruta no encontrada'});
});

server.listen(PORT,'0.0.0.0',()=>console.log(`Gestor de Gastos v3 (Cardinal) en puerto ${PORT} ${REDIS_URL?'[Redis]':'[local]'}`));
