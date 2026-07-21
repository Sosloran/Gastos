// cardinal-auth.js — Módulo de CUENTAS CARDINAL (compartido entre apps).
// Usa Redis si REDIS_URL está disponible; si no, cae a archivo local (cardinal-users.json)
// para que la app funcione igual. Una misma cuenta sirve para GYMQUEST, Gastos y futuras apps.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const REDIS_FALLBACK = process.env.REDIS_URL && process.env.REDIS_URL.includes('rediss') ? process.env.REDIS_URL : (process.env.REDIS_URL || '');

function createAuth(inputUrl){
  const REDIS_URL = inputUrl || process.env.REDIS_URL || '';
  const USE_REDIS = !!REDIS_URL && !REDIS_URL.includes('[REDACTED]');
  const DATA_FILE = path.join(__dirname, '..', 'cardinal-users.json');
  let redis=null;

  async function ensureRedis(){
    if(redis) return redis;
    const {createClient}=require('redis');
    redis=createClient({url:REDIS_URL});
    redis.on('error',e=>console.log('[cardinal-auth] redis err',e.message));
    await redis.connect();
    return redis;
  }
  // ---- Almacenamiento local (fallback) ----
  function loadLocal(){ try{ return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }catch(e){ return {users:{},tokens:{}}; } }
  function saveLocal(d){ try{ fs.writeFileSync(DATA_FILE,JSON.stringify(d)); }catch(e){} }

  async function getUsers(){ if(USE_REDIS){ const r=await ensureRedis(); const raw=await r.hGetAll('cardinal:users'); const out={}; for(const k in raw){ try{out[k]=JSON.parse(raw[k]);}catch(e){} } return out; } const d=loadLocal(); return d.users||{}; }
  async function setUser(uid,obj){ if(USE_REDIS){ const r=await ensureRedis(); await r.hSet('cardinal:users',uid,JSON.stringify(obj)); return; } const d=loadLocal(); d.users=d.users||{}; d.users[uid]=obj; saveLocal(d); }
  async function makeToken(uid){ const t=crypto.randomBytes(24).toString('hex'); if(USE_REDIS){ const r=await ensureRedis(); await r.hSet('cardinal:tokens',t,uid); } else { const d=loadLocal(); d.tokens=d.tokens||{}; d.tokens[t]=uid; saveLocal(d); } return t; }
  async function tokenToUid(token){ if(!token)return null; if(USE_REDIS){ const r=await ensureRedis(); return (await r.hGet('cardinal:tokens',token))||null; } const d=loadLocal(); return (d.tokens&&d.tokens[token])||null; }

  function hashPw(pw,salt){ salt=salt||crypto.randomBytes(16).toString('hex'); const h=crypto.pbkdf2Sync(String(pw),salt,120000,32,'sha256').toString('hex'); return salt+':'+h; }
  function verifyPw(pw,stored){ if(!stored||!stored.includes(':'))return false; const salt=stored.split(':')[0]; return crypto.timingSafeEqual(Buffer.from(hashPw(pw,salt)),Buffer.from(stored)); }
  function normEmail(e){ return String(e||'').trim().toLowerCase(); }
  function newId(){ return Date.now().toString(36)+crypto.randomBytes(4).toString('hex'); }

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
  async function logout(token){ if(!token)return; if(USE_REDIS){ const r=await ensureRedis(); await r.hDel('cardinal:tokens',token); } else { const d=loadLocal(); if(d.tokens)delete d.tokens[token]; saveLocal(d); } }
  async function me(token){ const uid=await tokenToUid(token); if(!uid)return null; const users=await getUsers(); return users[uid]||null; }
  async function profileIdForReq(req){
    const auth=req.headers['authorization']||''; const t=auth.replace(/^Bearer /,'').trim()||null;
    const uid=await tokenToUid(t); if(!uid) return null; const users=await getUsers(); return (users[uid]&&users[uid].profileId)||null;
  }
  return { ensureAuth:ensureRedis, hashPw, verifyPw, normEmail, newId, getUsers, setUser, makeToken, tokenToUid, register, login, google, logout, me, profileIdForReq, KEY:'cardinal:users' };
}
module.exports = createAuth;
