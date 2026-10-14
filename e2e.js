// Сквозное шифрование на сайте: официальный libsignal (Rust), собранный в WASM (vendor/sigwasm).
// Протокол и формат — как в Android-клиенте (E2eCore/E2eGroup): X3DH/PQXDH + Double Ratchet, Kyber-1024, Sender Keys.
// Своей криптографии здесь нет.
import initWasm, { Store, distId, compareScannable } from './vendor/sigwasm/sigwasm.js';

const OTK_BATCH = 100, OTK_LOW = 20, CLAIM_TTL = 10 * 60 * 1000;
let sb, store = null, kv = {}, db, uid = null, ready = null;
const claimedAt = {};
export class KeyChange extends Error { constructor(u) { super('Ключ безопасности собеседника изменился'); this.userId = u; } }
export class NoKey extends Error {}

// ---- IndexedDB ----
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('msgr-e2e', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function tx(mode, fn) { return new Promise((res, rej) => { const t = db.transaction('kv', mode); const s = t.objectStore('kv'); const out = fn(s); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); }
async function loadAll() { const out = {}; await new Promise((res, rej) => { const c = db.transaction('kv').objectStore('kv').openCursor(); c.onsuccess = () => { const x = c.result; if (!x) return res(); out[x.key] = x.value; x.continue(); }; c.onerror = () => rej(c.error); }); return out; }
let dirty = false, ver = null;
async function put(k, v) { kv[k] = v; dirty = true; await tx('readwrite', s => s.put(v, k)); }
async function del(k) { delete kv[k]; dirty = true; await tx('readwrite', s => s.delete(k)); }
async function saveStore() { await put('state', store.export()); }
const jget = k => { try { return kv[k] ? JSON.parse(kv[k]) : {}; } catch { return {}; } };

// Все операции с хранилищем строго по очереди (ratchet нельзя продвигать параллельно)
// Между вкладками — Web Locks: одно хранилище IndexedDB, ratchet продвигает только одна вкладка за раз.
// Перед операцией, если другая вкладка что-то записала (ключ 'ver'), перечитываем состояние.
let chain = Promise.resolve();
async function syncFromDb() {
  if (!db) return;
  const v = await tx('readonly', s => s.get('ver'));
  if (v === ver) return;
  kv = await loadAll(); ver = v;
  if (!kv.dev) ready = null; // другая вкладка вышла из аккаунта
  if (store) { store.free(); store = null; }
  if (kv.state) store = Store.load(kv.state);
}
async function runLocked(fn) {
  await syncFromDb(); dirty = false;
  try { return await fn(); }
  finally { if (dirty && db) { ver = Math.random().toString(36).slice(2); kv.ver = ver; await tx('readwrite', s => s.put(ver, 'ver')); dirty = false; } }
}
const locked = fn => {
  const run = () => navigator.locks ? navigator.locks.request('msgr-e2e', () => runLocked(fn)) : runLocked(fn);
  const p = chain.then(run, run); chain = p.catch(() => {}); return p;
};

function sessionId(jwt) { const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(p)))).session_id; }
async function token() { const { data } = await sb.auth.getSession(); if (!data.session) throw new Error('нет сессии'); return data.session; }
const chk = ({ data, error }) => { if (error) throw error; return data; };
export const deviceId = () => kv.dev || null;

export function init(client) { sb = client; }

/** Ключи для текущей сессии (session_id = device_id), публикация, пополнение одноразовых prekey. */
export function ensureReady() {
  if (!ready) ready = locked(async () => {
    await initWasm({ module_or_path: new URL('./vendor/sigwasm/sigwasm_bg.wasm', import.meta.url) });
    if (!db) { db = await idb(); await syncFromDb(); }
    const s = await token(); uid = s.user.id;
    const dev = sessionId(s.access_token);
    if (kv.dev !== dev || kv.uid !== uid || !kv.state) {
      // Новая сессия = новое устройство; доверие (trust/verified) к собеседникам того же пользователя сохраняем
      const keepTrust = kv.uid === uid;
      for (const k of Object.keys(kv)) if (!(keepTrust && (k.startsWith('trust:') || k.startsWith('pending:') || k.startsWith('verified:')))) await del(k);
      store = Store.newDevice();
      await saveStore(); await put('otk_next', '1'); await put('uid', uid); await put('dev', dev);
    } else store = Store.load(kv.state);
    await publish(dev);
    await topUp();
    return dev;
  }).catch(e => { ready = null; throw e; });
  return ready;
}

async function publish(dev) {
  if (kv.uploaded !== '1') {
      const row = { ...JSON.parse(store.publicRow()), device_id: dev, user_id: uid };
      const { error } = await sb.from('devices_keys').insert(row);
      if (error) {
        if (!/duplicate|23505/.test(error.message + error.code)) throw error;
        delete row.device_id; delete row.user_id; // UPDATE разрешён только по колонкам ключей
        chk(await sb.from('devices_keys').update(row).eq('device_id', dev));
      }
      await put('uploaded', '1');
    }
}

/** Строка devices_keys этого устройства ещё на сервере? Нет (её удалила серверная чистка) — публикуем ключи заново. */
export function checkDevice() {
  return locked(async () => {
    if (!store || !kv.dev) return 'not-ready';
    const { data, error } = await sb.from('devices_keys').select('device_id').eq('device_id', kv.dev).maybeSingle();
    if (error) throw error;
    if (data) { await topUp(); return 'ok'; }
    for (const k of Object.keys(kv)) if (k.startsWith('skd:')) await del(k); // ключи групп этому устройству нужно раздать заново
    await put('uploaded', '0');
    await publish(kv.dev); await topUp();
    return 'restored';
  });
}

async function topUp() {
  const have = chk(await sb.rpc('my_prekey_count')) || 0;
  if (have >= OTK_LOW) return;
  const next = +kv.otk_next;
  const rows = JSON.parse(store.genPrekeys(next, OTK_BATCH)).map(r => ({ device_id: kv.dev, key_id: r.key_id, pub: r.pub }));
  await saveStore(); await put('otk_next', String(next + OTK_BATCH)); // сначала локально
  chk(await sb.from('one_time_prekeys').insert(rows));
}

/** Доверенные устройства пользователя с готовой сессией; TOFU как в Android. */
async function devicesFor(user) {
  const trust = jget('trust:' + user);
  if (!claimedAt[user] || Date.now() - claimedAt[user] > CLAIM_TTL) {
    const rows = chk(await sb.rpc('claim_prekeys', { p_user: user })) || [];
    claimedAt[user] = Date.now();
    const valid = {};
    for (const o of rows) {
      if (o.device_id === kv.dev || !o.kyber_prekey) continue;
      try { if (Store.verifyRow(JSON.stringify(o))) valid[o.device_id] = o; } catch { /* битая строка — пропускаем */ }
    }
    for (const d of Object.keys(trust)) if (!valid[d]) delete trust[d];
    const pending = jget('pending:' + user), first = kv['trust:' + user] == null;
    for (const [d, o] of Object.entries(valid)) {
      if (first) trust[d] = o.identity_pub; else if (trust[d] !== o.identity_pub) pending[d] = o.identity_pub;
    }
    await put('trust:' + user, JSON.stringify(trust));
    if (Object.keys(pending).length) await put('pending:' + user, JSON.stringify(pending));
    for (const [d, o] of Object.entries(valid)) {
      if (trust[d] !== o.identity_pub) continue;
      await put('devuser:' + d, user);
      if (store.hasSession(d)) continue;
      store.processBundle(JSON.stringify(o));
    }
    await saveStore();
  }
  if (kv['pending:' + user]) throw new KeyChange(user);
  return Object.keys(trust).filter(d => store.hasSession(d));
}

export const hasPendingChange = user => !!kv['pending:' + user];
/** Принять новые ключи собеседника (как acceptKeys в Android). */
export function acceptKeys(user) {
  return locked(async () => {
    await acceptPendingInner(user); if (kv['verified:' + user]) await del('verified:' + user);
  });
}

/** Есть ли у собеседника устройства с ключами (тогда отправляем только шифротекст). */
export function peerHasKeys(peer) {
  return locked(async () => { try { return (await devicesFor(peer)).length > 0; } catch (e) { if (e instanceof KeyChange) return true; throw e; } });
}

/** Шифротекст {device: {f,t,b}} для устройств собеседника и своих других устройств; null — у собеседника нет ключей. */
export function encryptDM(peer, pt) {
  return locked(async () => {
    const peerDevs = await devicesFor(peer);
    if (!peerDevs.length) return null;
    const all = [...peerDevs];
    try { for (const d of await devicesFor(uid)) if (!all.includes(d)) all.push(d); } catch (e) { if (e.userId === uid) throw e; }
    const ct = {};
    for (const d of all) { const m = JSON.parse(store.encrypt(d, pt)); ct[d] = { f: kv.dev, t: m.t, b: m.b }; }
    await saveStore();
    return { ct, pt };
  });
}
export const rememberOwn = (id, pt, sk) => locked(async () => { await put('pts:' + id, pt); if (sk) await put('ptg:' + id + ':' + await h16(sk), pt); });

async function h16(s) { const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); return [...b].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 16); }

/** Расшифровка личного сообщения. null — не для этого устройства. */
export function decryptDM(m) {
  return locked(async () => {
    if (kv['pts:' + m.id]) return kv['pts:' + m.id];
    const e = m.ciphertext && m.ciphertext[kv.dev];
    if (!e) return null;
    const ck = 'pt:' + m.id + ':' + await h16(e.b);
    if (kv[ck]) return kv[ck];
    const s = store.decrypt(e.f, e.t, e.b);
    await saveStore(); await put(ck, s);
    if (m.sender_id) {
      await put('devuser:' + e.f, m.sender_id);
      const trust = jget('trust:' + m.sender_id), ik = store.identityOf(e.f);
      if (ik && trust[e.f] !== ik && kv['trust:' + m.sender_id] != null) { const p = jget('pending:' + m.sender_id); p[e.f] = ik; await put('pending:' + m.sender_id, JSON.stringify(p)); }
    }
    return s;
  });
}

// ---------- группы: Sender Keys (как E2eGroup в Android) ----------
const gwarn = {};
function warn(chat, w) { (gwarn[chat] = gwarn[chat] || new Set()).add(w); }
export const warnings = chat => [...(gwarn[chat] || [])];

async function epochOf(chat, devs) {
  if (devs.length) return devs[0].key_epoch;
  return chk(await sb.from('chats').select('key_epoch').eq('id', chat).single()).key_epoch;
}

/** Раздаёт SKDM текущей эпохи устройствам участников; возвращает {epoch, others}. */
export function distribute(chat) {
  return locked(async () => {
    const me = kv.dev;
    const devs = chk(await sb.rpc('group_devices', { p_chat: chat })) || [];
    const epoch = await epochOf(chat, devs);
    const skdm = store.groupSkdm(me, chat, epoch); await saveStore();
    const doneKey = 'skd:' + chat + ':' + epoch, done = jget(doneKey);
    const byUser = {};
    for (const o of devs) { if (o.device_id === me || done[o.device_id]) continue; (byUser[o.user_id] = byUser[o.user_id] || {})[o.device_id] = o.identity_pub; }
    const out = [], sent = [];
    for (const [user, ds] of Object.entries(byUser)) {
      let ok;
      try {
        ok = await devicesFor(user);
        if (Object.keys(ds).some(d => !ok.includes(d))) { delete claimedAt[user]; ok = await devicesFor(user); }
      } catch (e) { if (e instanceof KeyChange) { warn(chat, 'Ключ безопасности участника изменился — ключ группы ему не отправлен.'); continue; } throw e; }
      const trust = jget('trust:' + user);
      for (const [d, ik] of Object.entries(ds)) {
        if (!ok.includes(d)) continue;
        if (trust[d] !== ik) { warn(chat, 'Сервер прислал для участника другой ключ устройства — ключ группы не отправлен.'); continue; }
        const m = JSON.parse(store.encryptBytes(d, skdm));
        out.push({ chat_id: chat, epoch, sender_user: uid, sender_device: me, recipient_device: d, ciphertext: JSON.stringify({ t: m.t, b: m.b }) });
        sent.push(d);
      }
    }
    await saveStore();
    if (out.length) {
      const { error } = await sb.from('sender_key_distributions').insert(out);
      if (error) {
        if (!/duplicate|23505|409/.test(error.message + error.code)) throw error;
        for (const r of out) { const { error: e1 } = await sb.from('sender_key_distributions').insert(r); if (e1 && !/duplicate|23505|409/.test(e1.message + e1.code)) throw e1; }
      }
      for (const d of sent) done[d] = 1;
      await put(doneKey, JSON.stringify(done));
    }
    return { epoch, others: devs.length };
  });
}

/** Забирает адресованные этому устройству SKDM группы. */
export function receive(chat) {
  return locked(async () => {
    const rows = chk(await sb.from('sender_key_distributions').select('id,epoch,sender_user,sender_device,ciphertext').eq('chat_id', chat).order('created_at')) || [];
    let n = 0;
    for (const r of rows) {
      try {
        if (kv['trust:' + r.sender_user] == null) { try { await devicesFor(r.sender_user); } catch { /* pending */ } }
        const e = JSON.parse(r.ciphertext);
        const skdm = store.decryptBytes(r.sender_device, e.t, e.b); await saveStore();
        const ik = store.identityOf(r.sender_device);
        let trusted = jget('trust:' + r.sender_user)[r.sender_device];
        if (!trusted) { delete claimedAt[r.sender_user]; try { await devicesFor(r.sender_user); } catch { /* pending */ } trusted = jget('trust:' + r.sender_user)[r.sender_device]; }
        if (!ik || ik !== trusted) warn(chat, 'Получен ключ группы с незнакомым или изменившимся ключом устройства участника — он не принят.');
        else { store.groupProcess(r.sender_device, chat, r.epoch, skdm); await saveStore(); await put('gdev:' + r.sender_device, r.sender_user); n++; }
      } catch (ex) { warn(chat, 'Не удалось расшифровать ключ группы от участника.'); }
      await sb.from('sender_key_distributions').delete().eq('id', r.id); // второй раз не расшифровать
    }
    return n;
  });
}

/** Групповое сообщение ({sk}) с key_epoch и sender_device. */
export function decryptGroup(chat, m) {
  return locked(async () => {
    const sk = m.ciphertext.sk, ck = 'ptg:' + m.id + ':' + await h16(sk);
    if (kv[ck]) return kv[ck];
    if (!m.sender_device) throw new Error('нет sender_device');
    if (m.sender_device === kv.dev) { if (kv['pts:' + m.id]) return kv['pts:' + m.id]; throw new NoKey('своё сообщение без копии'); }
    const du = kv['gdev:' + m.sender_device];
    if (!du || !store.groupHasKey(m.sender_device, chat, m.key_epoch)) throw new NoKey('ключ отправителя ещё не получен');
    if (du !== m.sender_id) throw new Error('устройство не принадлежит отправителю');
    const s = store.groupDecrypt(m.sender_device, chat, m.key_epoch, sk);
    await saveStore(); await put(ck, s);
    return s;
  });
}

export function encryptGroup(chat, epoch, pt) {
  return locked(async () => { const sk = store.groupEncrypt(kv.dev, chat, epoch, pt); await saveStore(); return { ct: { sk }, pt }; });
}

// ---------- код безопасности (libsignal Fingerprint v2, 5200 итераций — как Android) ----------
/** [{dev, digits, qr}] по доверенным (и ожидающим) устройствам собеседника. */
export function safetyNumbers(peer) {
  return locked(async () => {
    const t = { ...jget('trust:' + peer), ...jget('pending:' + peer) };
    return Object.entries(t).map(([dev, ik]) => ({ dev, ...JSON.parse(store.fingerprint(uid, peer, ik)) }));
  });
}
/** Сравнивает отсканированный QR (base64-строка из QR приложения) с нашими кодами; при совпадении — проверено. */
export function verifyScanned(peer, scanned) {
  return locked(async () => {
    const t = { ...jget('trust:' + peer), ...jget('pending:' + peer) };
    for (const ik of Object.values(t)) {
      const mine = JSON.parse(store.fingerprint(uid, peer, ik)).qr;
      let ok = false; try { ok = compareScannable(mine, scanned.trim()); } catch { /* не тот формат */ }
      if (ok) { await acceptPendingInner(peer); await put('verified:' + peer, kv['trust:' + peer]); return true; }
    }
    return false;
  });
}
/** Пользователь сам сравнил цифры и подтвердил совпадение. */
export function markVerified(peer) { return locked(async () => { await acceptPendingInner(peer); await put('verified:' + peer, kv['trust:' + peer] || '{}'); }); }
export const isVerified = peer => kv['verified:' + peer] != null && kv['verified:' + peer] === kv['trust:' + peer];
async function acceptPendingInner(user) {
  if (!kv['pending:' + user]) return;
  const trust = jget('trust:' + user), pending = jget('pending:' + user);
  for (const [d, ik] of Object.entries(pending)) { trust[d] = ik; store.deleteSession(d); }
  await put('trust:' + user, JSON.stringify(trust)); await del('pending:' + user);
  delete claimedAt[user]; await saveStore();
}

// ---------- файлы: AES-256-GCM, как E2eCore.encryptFile (ct||tag, ключ 32 байта, IV 12 байт, sha256 hex) ----------
const b64e = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
export async function encryptFile(plain) {
  const key = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, k, plain));
  return { ct, k: b64e(key), iv: b64e(iv), h: hex(await crypto.subtle.digest('SHA-256', plain)) };
}
export async function decryptFile(ct, kB64, ivB64, h) {
  const k = await crypto.subtle.importKey('raw', b64d(kB64), 'AES-GCM', false, ['decrypt']);
  const p = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(ivB64), tagLength: 128 }, k, ct));
  if (h && hex(await crypto.subtle.digest('SHA-256', p)) !== h) throw new Error('Файл повреждён: контрольная сумма не совпала');
  return p;
}

/** Выход: стереть ключи этого устройства. */
export function wipe() {
  return locked(async () => { ready = null; if (store) { store.free(); store = null; } if (!db) return; for (const k of Object.keys(kv)) if (k !== 'ver') await del(k); });
}
export { distId };
