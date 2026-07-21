// cardinal-auth.js — Módulo de CUENTAS CARDINAL (compartido entre apps).
// Usa un Redis común (la misma instancia free de Render). Las cuentas viven en
// la key 'cardinal:users' (separada de los datos de cada app), así una misma
// cuenta sirve para GYMQUEST, Gestor de Gastos y futuras apps de Cardinal.
// API: require('./cardinal-auth')(REDIS_URL) -> { ensureAuth, hashPw, verifyPw,
//        normEmail, makeToken, tokenToUid, uidToProfileId, register, login, google, logout }
const crypto = require('crypto');

function createAuth(REDIS_URL){
  let redis=null;
  async function ensureAuth(){
    if(redis) return redis;
    const {createClient}=require('redis');
    redis=createClient({url:REDIS_URL});
    redis.on('error',e=>console.log('[cardinal-auth] redis err',e.message));
    await redis.connect();
    return redis;
  }
  const KEY='cardinal:users';           // hash uid -> {email,name,pw,profileId,provider}
  const TKEY='cardinal:tokens';         // hash token -> uid

  function hashPw(pw,salt){ salt=salt||crypto.randomBytes(16).toString('hex'); const h=crypto.pbkdf2Sync(String(pw),salt,120000,32,'sha256').toString('hex'); return salt+':'+h; }
  function verifyPw(pw,stored){ if(!stored||!stored.includes(':'))return false; const salt=stored.split(':')[0]; return crypto.timingSafeEqual(Buffer.from(hashPw(pw,salt)),Buffer.from(stored)); }
  function normEmail(e){ return String(e||'').trim().toLowerCase(); }
  function newId(){ return Date.now().toString(36)+crypto.randomBytes(4).toString('hex'); }

  async function getUsers(){ const r=await ensureAuth(); const raw=await r.hGetAll(KEY); const out={}; for(const k in raw){ try{out[k]=JSON.parse(raw[k]);}catch(e){} } return out; }
  async function setUser(uid,obj){ const r=await ensureAuth(); await r.hSet(KEY,uid,JSON.stringify(obj)); }
  async function makeToken(uid){ const r=await ensureAuth(); const t=crypto.randomBytes(24).toString('hex'); await r.hSet(TKEY,t,uid); return t; }
  async function tokenToUid(token){ if(!token)return null; const r=await ensureAuth(); const uid=await r.hGet(TKEY,token); return uid||null; }

  // Registrar: devuelve {token, profileId, error}
  async function register({email,name,password,profileCreator}){
    const em=normEmail(email);
    if(!em||!em.includes('@')) return {error:'Email inválido'};
    if(String(password||'').length<4) return {error:'Contraseña muy corta (mín 4)'};
    const users=await getUsers();
    if(Object.values(users).some(u=>u.email===em)) return {error:'Ese email ya está registrado'};
    const uid=newId();
    const profileId=profileCreator?profileCreator(uid):newId();
    const obj={id:uid,email:em,name:(name||em.split('@')[0]).slice(0,30),pw:hashPw(password),profileId,provider:'email',created:Date.now()};
    await setUser(uid,obj);
    const token=await makeToken(uid);
    return {token,profileId};
  }

  async function login({email,password}){
    const em=normEmail(email);
    const users=await getUsers();
    const u=Object.values(users).find(x=>x.email===em);
    if(!u||!u.pw||!verifyPw(password,u.pw)) return {error:'Email o contraseña incorrectos'};
    const token=await makeToken(u.id);
    return {token,profileId:u.profileId};
  }

  // Login/registro con Google (credential es el JWT de Google Identity)
  async function google({credential,profileCreator}){
    let payload=null;
    try{ payload=JSON.parse(Buffer.from(String(credential).split('.')[1],'base64').toString('utf8')); }catch(e){ return {error:'Token de Google inválido'}; }
    const em=normEmail(payload.email);
    if(!em) return {error:'Google no devolvió email'};
    const users=await getUsers();
    let u=Object.values(users).find(x=>x.email===em);
    if(!u){ const uid=newId(); const profileId=profileCreator?profileCreator(uid):newId(); u={id:uid,email:em,name:(payload.name||em.split('@')[0]).slice(0,30),profileId,provider:'google',created:Date.now()}; await setUser(uid,u); }
    const token=await makeToken(u.id);
    return {token,profileId};
  }

  async function logout(token){ if(!token)return; const r=await ensureAuth(); await r.hDel(TKEY,token); }
  async function me(token){ const uid=await tokenToUid(token); if(!uid)return null; const users=await getUsers(); return users[uid]||null; }

  // Para apps: dado un token, devuelve el profileId del usuario (o null si anónimo)
  async function profileIdForReq(req){
    const auth=req.headers['authorization']||'';
    const t=auth.replace(/^Bearer /,'').trim()||null;
    const uid=await tokenToUid(t);
    if(!uid) return null;
    const users=await getUsers();
    return (users[uid]&&users[uid].profileId)||null;
  }

  return { ensureAuth, hashPw, verifyPw, normEmail, newId, getUsers, setUser, makeToken, tokenToUid, register, login, google, logout, me, profileIdForReq, KEY };
}

module.exports = createAuth;
