/* Офлайн-кэш (IndexedDB), состояние соединения, догрузка после reconnect, уведомления (service worker),
   клиентская push-подписка, запись голосовых и видеокружков. Подключается после app.js (общие глобальные имена). */
(() => {
// ---------- значки: пока шрифт не загружен, текст лигатур («done», «mic») не показываем ----------
if (document.fonts && document.fonts.load) Promise.race([document.fonts.load("24px 'Material Symbols Rounded'", 'mic'), new Promise(r => setTimeout(r, 4000))]).finally(() => document.documentElement.classList.add('ms-ready'));
else document.documentElement.classList.add('ms-ready');
// ---------- IndexedDB: msgr-cache / kv ----------
const DB = 'local-msgr-cache'; let dbp = null;
function db() { if (!dbp) dbp = new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); return dbp; }
async function kvGet(k) { try { const d = await db(); return await new Promise((res, rej) => { const r = d.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); } catch { return undefined; } }
async function kvSet(k, v) { try { const d = await db(); await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) { console.warn('cache', e); } }
const uidKey = k => me ? me.id + ':' + k : null;
window.cacheChats = list => { const k = uidKey('chats'); if (k) kvSet(k, list.map(c => ({ ...c }))); };
let prevT = null;
window.cachePrev = () => { clearTimeout(prevT); prevT = setTimeout(() => { const k = uidKey('prev'); if (!k) return; const ids = new Set(lastChats.map(c => c.id + '|' + c.last_at)); const o = {}; for (const [kk, v] of Object.entries(lastPrev)) if (ids.has(kk) || !lastChats.length) o[kk] = v; kvSet(k, o); }, 400); };
let prevLoaded = null;
async function loadPrev() { const k = uidKey('prev'); if (!k || prevLoaded === k) return; prevLoaded = k; const o = await kvGet(k); if (o && typeof o === 'object') for (const [kk, v] of Object.entries(o)) if (!lastPrev[kk] && v && typeof v.text === 'string') lastPrev[kk] = { icon: typeof v.icon === 'string' ? v.icon : null, text: v.text }; }
// ---------- очередь неотправленных в IndexedDB (переживает перезагрузку) ----------
let obT = null;
window.saveOutbox = () => { clearTimeout(obT); obT = setTimeout(() => { const k = uidKey('outbox'); if (!k) return; const o = {};
  for (const j of Object.values(outbox)) o[j.id] = { w: !(j.hold || (msgEls[j.id] && msgEls[j.id].dataset.state === 'failed')), id: j.id, at: j.at, kind: j.kind, text: j.text, file: j.file, caption: j.caption, media: j.media, extra: j.extra, uploaded: j.uploaded, chat: { id: j.chat.id, kind: j.chat.kind, peer: j.chat.peer || null, name: j.chat.name || null } };
  kvSet(k, o); }, 150); };
let obLoaded = null;
async function loadOutbox() {
  const k = uidKey('outbox'); if (!k || obLoaded === k) return; obLoaded = k;
  const o = await kvGet(k); if (!o || typeof o !== 'object') return;
  for (const j of Object.values(o)) if (j && j.id && !outbox[j.id] && j.chat && j.chat.id) { if (j.w === false) j.hold = true; else j.waitNet = true; j.tries = 1; outbox[j.id] = j; } // tries=1: перед повтором проверим, не дошло ли уже
  paintNetLine(); if (navigator.onLine && Object.values(outbox).some(j => j.waitNet)) setTimeout(flushOutbox, 2000);
}
window.chatsFromCache = async () => {
  await loadPrev(); await loadOutbox();
  if (lastChats.length) return true;
  const k = uidKey('chats'); if (!k) return false;
  const list = await kvGet(k); if (!Array.isArray(list) || !list.length || lastChats.length || !me) return false;
  lastChats = list; renderChats(); return true;
};
const pending = {}; let cacheT = null; const KEEP = 100;
const ptOf = pl => JSON.stringify({ v: 1, t: pl.t0 || '', ...(pl.caption ? { caption: pl.caption } : {}), ...(pl.f ? { f: pl.f } : {}), ...(pl.fw ? { fw: pl.fw } : {}) });
window.cacheMsg = (m, pl) => {
  if (!me || !m || !m.id || !m.ciphertext || String(m.id).length < 30) return;
  (pending[m.chat_id] = pending[m.chat_id] || {})[m.id] = { m, pt: ptOf(pl) };
  clearTimeout(cacheT); cacheT = setTimeout(flushCache, 500);
};
window.cacheOwn = (m, pt) => {
  if (!me || !m || !m.id || !m.chat_id || !m.ciphertext) return;
  (pending[m.chat_id] = pending[m.chat_id] || {})[m.id] = { m, pt };
  clearTimeout(cacheT); cacheT = setTimeout(flushCache, 300);
};
let flushing = Promise.resolve();
function flushCache() { flushing = flushing.then(flushCacheNow, flushCacheNow); return flushing; } // по очереди: параллельные записи затирали друг друга
async function flushCacheNow() {
  const who = me && me.id; if (!who) return;
  for (const [chat, add] of Object.entries(pending)) {
    delete pending[chat];
    const k = who + ':msgs:' + chat, cur = (await kvGet(k)) || {};
    Object.assign(cur, add);
    const ids = Object.keys(cur).sort((a, b) => String(cur[a].m.created_at).localeCompare(String(cur[b].m.created_at)));
    for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) delete cur[id]; // остаются 100 самых новых по created_at
    if (me && me.id === who) await kvSet(k, cur);
  }
}
window.__flushCache = () => flushCache();
window.cachedMsgs = async chatId => {
  const k = uidKey('msgs:' + chatId); if (!k) return [];
  const cur = (await kvGet(k)) || {};
  const out = Object.values(cur).sort((a, b) => String(a.m.created_at).localeCompare(String(b.m.created_at)));
  for (const x of out) { const sig = ctSig(x.m.ciphertext); if (sig) sentOwn[sig] = x.pt; } // расшифрованный текст из кэша — без сети и без E2E
  return out.map(x => x.m);
};
window.clearLocalCache = () => {
  obLoaded = null; prevLoaded = null; for (const k of Object.keys(lastPrev)) delete lastPrev[k];
  for (const k of Object.keys(pending)) delete pending[k];
  const go = () => { try { indexedDB.deleteDatabase(DB); } catch { /* */ } };
  if (dbp) dbp.then(d => { d.close(); dbp = null; go(); }, () => { dbp = null; go(); }); else go();
  try { navigator.serviceWorker && navigator.serviceWorker.getRegistration().then(r => r && r.getNotifications && r.getNotifications().then(ns => ns.forEach(n => n.close()))); } catch { /* */ }
};
window.showSkeletons = () => { const box = $('messages'); for (let i = 0; i < 4; i++) { const s = document.createElement('div'); s.className = 'msg skel skel-ph' + (i % 2 ? ' mine' : ''); s.style.width = (40 + (i * 17) % 35) + '%'; box.append(s); } };
window.hideSkeletons = () => document.querySelectorAll('#messages .skel-ph').forEach(x => x.remove());

// «Отправится, когда появится сеть» — серая строка над полем ввода
function paintNetLine() { const el = $('netLine'); if (!el) return; el.hidden = !(currentChat && Object.values(outbox).some(j => j.waitNet && j.chat && j.chat.id === currentChat.id)); }
window.paintNetLine = paintNetLine;
// ---------- состояние соединения: «Чаты (Соединение…)» / «Чаты (Ожидание сети…)» ----------
let conn = null, wasDown = true, netFailAt = 0, netOkAt = 0;
{ const f = window.fetch; window.fetch = function (u, o) { const s = String(u && u.url || u); const p = f.apply(this, arguments); if (s.startsWith(C.SUPABASE_URL)) p.then(() => { netOkAt = Date.now(); }, e => { if (!(e && e.name === 'AbortError')) netFailAt = Date.now(); }); return p; }; }
window.connState = () => conn === 'ok' || !conn ? '' : conn;
function computeConn() {
  if (!navigator.onLine) return 'offline';
  if (netFailAt > netOkAt && Date.now() - netFailAt < 20000) return 'offline'; // запросы к серверу не проходят (сеть «есть» только формально)
  try { if (!sb.realtime.isConnected()) return 'connecting'; } catch { return 'connecting'; }
  if (inboxChan && inboxChan.state && inboxChan.state !== 'joined') return 'connecting';
  return 'ok';
}
// очередь ждёт отправки после возврата сети — в шапке «Соединение…», пока не уйдёт (дизайн 20.10)
const queueBusy = () => Object.values(outbox).some(j => !j.hold && (j.waitNet || j.flushing));
const dispConn = b => b === 'ok' && queueBusy() ? 'connecting' : b;
function paintConn() {
  const el = $('connSt'); if (!el) return;
  el.hidden = conn === 'ok'; txt($('connTxt'), conn === 'offline' ? 'Ожидание сети…' : 'Соединение…');
  $('chatsTitle').setAttribute('aria-label', conn === 'ok' ? 'Чаты' : 'Чаты (' + $('connTxt').textContent + ')');
}
function tickConn() {
  if (!me) return;
  const base = computeConn(), n = dispConn(base);
  if (n !== conn) { conn = n; paintConn(); if (currentChat) paintSub(); }
  if (base === 'ok' && wasDown) { wasDown = false; caughtUp(); }
  if (base !== 'ok') { wasDown = true; revive(); }
  paintNetLine();
}
let reviveAt = 0;
async function tokenSoon(ms = 60000) { try { const s = (await sb.auth.getSession()).data.session; return !!(s && s.expires_at && s.expires_at * 1000 < Date.now() + ms); } catch { return false; } }
// заранее: за 5 минут до истечения обновляем сессию (и токен Realtime), чтобы соединение не рвалось раз в час
setInterval(() => { if (me && navigator.onLine && document.visibilityState === 'visible') tokenSoon(5 * 60000).then(soon => { if (soon && typeof rtRecover === 'function') rtRecover(); }); }, 60000);
function revive() { // канал упал окончательно (chan = null после ошибки) — пересоздаём, не чаще раза в 10 с
  if (!navigator.onLine || Date.now() - reviveAt < 10000) return; reviveAt = Date.now();
  // 20.10: autoRefreshToken выключен — через час токен Realtime истекает, сервер закрывает канал, а повторный вход идёт со старым
  // токеном и «Соединение…» висит. Истёк или истекает — обновляем сессию и передаём новый токен в Realtime (rtRecover в app.js).
  tokenSoon().then(soon => { if (soon && typeof rtRecover === 'function') rtRecover(); });
  // канал «inbox» застрял в joining дольше 20 с — пересоздаём
  if (inboxChan && inboxChan.state === 'joining') { inboxChan.__j = inboxChan.__j || Date.now(); if (Date.now() - inboxChan.__j > 20000) { watchInbox(); return; } } else if (inboxChan) inboxChan.__j = 0;
  try { if (!sb.realtime.isConnected()) sb.realtime.connect(); } catch { /* */ }
  if (!inboxChan || inboxChan.state === 'closed' || inboxChan.state === 'errored') watchInbox();
}
/** После переподключения: список чатов, пропущенные сообщения открытого чата, очередь неотправленных */
async function caughtUp() {
  try { if (E2E && E2E.syncPending && E2E.syncPending()) await E2E.syncDeferred(); } catch (e) { console.warn('e2e sync', e); if (e && e.name === 'IdentityMismatch') showIdMismatch(e); }
  if (e2eErr && e2eErr.name !== 'IdentityMismatch' && e2eErr.name !== 'KeysLost') { e2eErr = null; e2eStart(); } // шифрование ждало сеть
  loadChatsSoon();
  const c = currentChat;
  if (c) {
    if (!chan || chan.state === 'closed' || chan.state === 'errored') { await rtAuth(); if (currentChat === c) subChat(c); }
    const ats = [...document.querySelectorAll('#messages .msg:not(.skel-ph)')].map(d => d.dataset.id && !outbox[d.dataset.id] ? d.dataset.at : '').filter(Boolean).sort();
    const last = ats[ats.length - 1];
    if (last) {
      const { data } = await sb.from('messages').select('*').eq('chat_id', c.id).gt('created_at', last).order('created_at', { ascending: true }).limit(200);
      if (currentChat === c) for (const m of data || []) if (!msgEls[m.id]) await onIncoming(m);
    }
    loadReadState();
  }
  flushOutbox();
}
window.caughtUp = caughtUp;
let flushT = null;
function flushOutbox() {
  if (!navigator.onLine) return;
  for (const job of Object.values(outbox)) { const d = msgEls[job.id]; if (!job.hold && !job.running && (job.waitNet || !d || d.dataset.state === 'failed')) { job.waitNet = false; job.flushing = true; job.auto = 15; outRun(job).finally(() => { if (outbox[job.id] && !job.auto) job.flushing = false; tickConn(); }); } }
  tickConn();
}
window.flushOutbox = flushOutbox;
addEventListener('online', () => {
  // сеть вернулась: прошлые сбои запросов не считаем, сразу поднимаем realtime, шифрование и отправляем очередь (не ждём ~50 с)
  netFailAt = 0; reviveAt = 0; tickConn(); revive();
  try { if (e2eErr && e2eErr.name !== 'IdentityMismatch' && e2eErr.name !== 'KeysLost') { e2eErr = null; e2eStart(); } } catch { /* */ }
  flushOutbox(); clearTimeout(flushT); flushT = setTimeout(flushOutbox, 1500);
});
addEventListener('offline', tickConn);
setInterval(tickConn, 1000);

// ---------- уведомления: service worker, actions «Ответить» / «Прочитано» ----------
let swReg = null;
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadCtl = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then(r => { swReg = r; r.update().catch(() => {}); }).catch(e => console.warn('sw', e));
  // новая версия SW взяла управление — один раз перезагружаем, чтобы открылась новая сборка (не в момент записи)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadCtl) return; let k = 'local-msgr-sw-reloaded'; try { if (sessionStorage.getItem(k) === BUILD.commit) return; sessionStorage.setItem(k, BUILD.commit); } catch { return; }
    if (typeof rec !== 'undefined' && rec) return; location.reload();
  });
  navigator.serviceWorker.addEventListener('message', ev => onSwMsg(ev.data));
}
window.showNotif = async (title, body, data) => {
  const opt = { body, tag: 'chat-' + data.chat_id, renotify: true, data,
    actions: [{ action: 'reply', title: 'Ответить' }, { action: 'read', title: 'Прочитано' }] };
  const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration().catch(() => null));
  if (reg && reg.showNotification) { try { await reg.showNotification(title, opt); return; } catch (e) { console.warn('showNotification', e); } }
  delete opt.actions; const n = new Notification(title, opt);
  n.onclick = () => { window.focus(); onSwMsg({ t: 'open', chat_id: data.chat_id }); n.close(); };
};
async function onSwMsg(x) {
  if (!x || !me || !x.chat_id) return;
  if (x.t === 'read') { const { error } = await sb.rpc('mark_read', { p_chat: x.chat_id, p_upto: x.msg_at || new Date().toISOString() }); if (!error) loadChatsSoon(); return; }
  if (x.t !== 'open' && x.t !== 'reply') return;
  window.focus();
  const open = () => { const li = document.querySelector(`#chatList li[data-id="${CSS.escape(x.chat_id)}"]`); if (li) { if (!currentChat || currentChat.id !== x.chat_id) li.click(); closeSettings(); if (x.t === 'reply') setTimeout(() => $('msgInput').focus(), 300); return true; } };
  if (!open()) { if (showArchive) { showArchive = false; renderChats(); } else { showArchive = true; renderChats(); } if (!open()) setTimeout(open, 1500); }
}
window.onSwMsg = onSwMsg;
{ const m = /[?&]open=([0-9a-f-]{36})/.exec(location.search); if (m) { history.replaceState(history.state, '', location.pathname + location.hash); setTimeout(() => onSwMsg({ t: 'open', chat_id: m[1] }), 2500); } }

// ---------- Web Push через FCM (сервер Hack Bot: rpc register_push_token, таблица push_tokens) ----------
// Нужен web-конфиг Firebase и VAPID-ключ проекта: C.FCM_WEB = { apiKey, projectId, messagingSenderId, appId, vapidKey }. Нет — push выключен.
const FB_V = '10.14.1';
const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s); });
async function fcmToken() {
  const cfg = C.FCM_WEB; if (!cfg || !cfg.vapidKey) return null;
  if (!window.firebase) { await loadScript(`https://www.gstatic.com/firebasejs/${FB_V}/firebase-app-compat.js`); await loadScript(`https://www.gstatic.com/firebasejs/${FB_V}/firebase-messaging-compat.js`); }
  if (!firebase.apps.length) firebase.initializeApp(cfg);
  const reg = await navigator.serviceWorker.ready; // наш sw.js принимает push (FCM data: message_id)
  return firebase.messaging().getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: reg });
}
window.pushSubscribe = async () => {
  try {
    if (!me || !('PushManager' in window) || Notification.permission !== 'granted' || !notifOn()) return 'off';
    const tok = await fcmToken(); if (!tok) return 'noconfig';
    const { error } = await sb.rpc('register_push_token', { p_token: tok, p_platform: 'web' });
    if (error) { console.warn('register_push_token', error.message); return 'server'; }
    return 'ok';
  } catch (e) { console.warn('push', e); return 'err'; }
};
window.pushUnregister = async () => {
  try {
    const { data } = await sb.auth.getSession(); const t = data.session && data.session.access_token; if (!t) return;
    const sid = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).session_id; if (!sid) return;
    await Promise.race([sb.from('push_tokens').delete().eq('device_id', sid), new Promise(r => setTimeout(r, 3000))]);
  } catch (e) { console.warn('push_tokens delete', e); }
};
$('notifSw').addEventListener('change', () => setTimeout(() => window.pushSubscribe(), 500));

// ---------- голосовые и кружки ----------
const MAX_REC = 60;
let recMode = 'voice'; // короткое нажатие на кнопку переключает voice ↔ round
const micBtn = $('micBtn'), sendBtn = $('sendBtn');
function paintSendBtn() { const empty = !$('msgInput').value.trim(); micBtn.hidden = !empty; sendBtn.hidden = empty; txt(micBtn.querySelector('.ms'), recMode === 'voice' ? 'mic' : 'videocam'); micBtn.setAttribute('aria-label', recMode === 'voice' ? 'Удерживайте для записи голосового. Нажмите — видеосообщение' : 'Удерживайте для записи видеосообщения. Нажмите — голосовое'); micBtn.title = micBtn.getAttribute('aria-label'); }
$('msgInput').addEventListener('input', paintSendBtn); paintSendBtn();
new MutationObserver(paintSendBtn).observe($('msgInput'), { attributes: true });
$('sendForm').addEventListener('submit', () => setTimeout(paintSendBtn, 0));
let rec = null; // { mr, stream, chunks, t0, mode, locked, cancelled, timer, analyser, wave }
let holdT = null, sx = 0, sy = 0, held = false;
micBtn.addEventListener('pointerdown', e => {
  if (!currentChat || rec) return; e.preventDefault(); sx = e.clientX; sy = e.clientY; held = false;
  try { micBtn.setPointerCapture(e.pointerId); } catch { /* */ }
  holdT = setTimeout(() => { held = true; startRec(recMode); }, 250);
});
micBtn.addEventListener('pointermove', e => {
  if (!rec || rec.locked) return;
  const dx = e.clientX - sx, dy = e.clientY - sy;
  $('recCancel').style.transform = `translateX(${Math.min(0, dx)}px)`;
  if (dx < -100) stopRec(false); else if (dy < -70) lockRec();
});
micBtn.addEventListener('pointerup', () => {
  clearTimeout(holdT);
  if (!held) { recMode = recMode === 'voice' ? 'round' : 'voice'; paintSendBtn(); toast(recMode === 'voice' ? 'Голосовое: удерживайте кнопку' : 'Видеосообщение: удерживайте кнопку', 1500); return; }
  held = false; if (rec && !rec.locked) stopRec(true); else if (!rec) recAbort = true;
});
micBtn.addEventListener('pointercancel', () => { clearTimeout(holdT); if (rec && !rec.locked) stopRec(false); held = false; });
micBtn.addEventListener('contextmenu', e => e.preventDefault());
let recAbort = false;
function pickMime(kind) {
  // Android: сначала mp4 (H.264/AAC — гарантированно воспроизводится тем же Chrome), затем webm vp8/opus
  const android = /Android/i.test(navigator.userAgent || '');
  const list = kind === 'voice' ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    : android ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'] : ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return list.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
}
async function startRec(mode) {
  if (!window.MediaRecorder || !navigator.mediaDevices) return toastLong('Этот браузер не умеет записывать ' + (mode === 'voice' ? 'голосовые' : 'видеосообщения'));
  recAbort = false;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia(mode === 'voice' ? { audio: true } : { audio: true, video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } } }); }
  catch (e) { return toastLong((mode === 'voice' ? 'Нет доступа к микрофону' : 'Нет доступа к камере') + ': разрешите его в настройках сайта'); }
  if (recAbort) { stream.getTracks().forEach(t => t.stop()); return toast('Удерживайте кнопку, чтобы записать', 2000); }
  const mime = pickMime(mode), mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000, ...(mode === 'round' ? { videoBitsPerSecond: 600000 } : {}) } : undefined);
  rec = { mr, stream, chunks: [], t0: Date.now(), mode, locked: false, cancelled: false, wave: [], chat: currentChat };
  const r0 = rec; mr.ondataavailable = ev => { if (ev.data && ev.data.size) r0.chunks.push(ev.data); }; // в замыкание: последний кусок приходит ПОСЛЕ stop(), когда rec уже null
  try { const ac = new AudioContext(), an = ac.createAnalyser(); an.fftSize = 256; ac.createMediaStreamSource(stream).connect(an); rec.ac = ac; rec.an = an; } catch { /* без волны */ }
  mr.start(250);
  $('recBar').hidden = false; $('sendForm').classList.add('recording'); $('recLock').hidden = true; $('recCancel').style.transform = '';
  if (mode === 'round') { const v = $('roundPrev'); v.srcObject = stream; v.muted = true; v.play().catch(() => {}); $('roundBox').hidden = false; }
  const buf = rec.an ? new Uint8Array(rec.an.fftSize) : null; let lastW = 0;
  rec.timer = setInterval(() => {
    if (!rec) return; const s = (Date.now() - rec.t0) / 1000;
    txt($('recTime'), fmtDur(Math.floor(s)));
    if (mode === 'round') $('roundRing').style.strokeDashoffset = String(691 * (1 - Math.min(1, s / MAX_REC)));
    if (buf && Date.now() - lastW > 120) { lastW = Date.now(); rec.an.getByteTimeDomainData(buf); let m = 0; for (const x of buf) m = Math.max(m, Math.abs(x - 128)); rec.wave.push(m); }
    if (s >= MAX_REC) stopRec(true);
  }, 100);
}
function lockRec() { if (!rec) return; rec.locked = true; $('recLock').hidden = false; $('recBar').classList.add('locked'); txt($('recCancel'), 'Отмена'); $('recCancel').style.transform = ''; }
$('recCancel').onclick = () => { if (rec) stopRec(false); };
$('recSend').onclick = () => { if (rec) stopRec(true); };
function stopRec(send) {
  const r = rec; if (!r) return; rec = null; clearInterval(r.timer);
  const dur = Math.max(1, Math.round((Date.now() - r.t0) / 1000));
  $('recBar').hidden = true; $('recBar').classList.remove('locked'); $('sendForm').classList.remove('recording'); $('roundBox').hidden = true; $('roundPrev').srcObject = null; txt($('recCancel'), '‹ Влево — отмена');
  r.mr.onstop = () => {
    r.stream.getTracks().forEach(t => t.stop()); try { r.ac && r.ac.close(); } catch { /* */ }
    if (!send) return toast('Запись отменена', 1500);
    if (Date.now() - r.t0 < 700) return toast('Слишком короткая запись', 1500);
    const type = (r.mr.mimeType || (r.mode === 'voice' ? 'audio/webm' : 'video/webm')).split(';')[0];
    const blob = new Blob(r.chunks, { type }), ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';
    if (blob.size > MAX_FILE) return toastLong('Запись больше 25 МБ');
    if (!r.chunks.length || blob.size < (r.mode === 'voice' ? 500 : 2000)) return toastLong('Запись не получилась (пустые данные с ' + (r.mode === 'voice' ? 'микрофона' : 'камеры') + '), попробуйте ещё раз');
    const file = new File([blob], (r.mode === 'voice' ? 'voice_' : 'round_') + Date.now() + '.' + ext, { type });
    const media = { vk: r.mode, d: Math.min(MAX_REC, dur) };
    if (r.mode === 'voice') media.w = squash(r.wave, 40);
    outSend({ chat: r.chat, kind: 'file', file, caption: '', extra: {}, media });
  };
  try { r.mr.stop(); } catch { r.mr.onstop(); }
}
// мышь/клавиатура на компьютере: Esc — отмена, Enter — отправить (в т.ч. после 🔒)
document.addEventListener('keydown', e => { if (!rec) return; if (e.key === 'Escape') { e.preventDefault(); stopRec(false); } else if (e.key === 'Enter' && rec.locked) { e.preventDefault(); stopRec(true); } }, true);
window.__rec = { start: m => startRec(m), stop: s => stopRec(s) }; // для тестов
function squash(w, n) { if (!w.length) return Array(n).fill(2); const mx = Math.max(...w, 1), out = []; for (let i = 0; i < n; i++) { const a = Math.floor(i * w.length / n), b = Math.max(a + 1, Math.floor((i + 1) * w.length / n)); let m = 0; for (let j = a; j < b; j++) m = Math.max(m, w[j] || 0); out.push(Math.max(1, Math.round(m / mx * 15))); } return out; }
window.squashWave = squash;

// ---------- воспроизведение ----------
const mediaUrls = {}, mediaBytes = {}; // mediaBytes: расшифрованные байты для пиков волны (fetch(blob:) запрещён CSP connect-src)
// Тип для воспроизведения — по сигнатуре файла (Android Chrome пишет video/x-matroska;codecs=avc1 и т.п.; octet-stream <video> не играет),
// затем по сохранённому типу из шифротекста, затем по виду (голос/кружок)
function playMime(f, p) {
  const vid = f.vk === 'round' || /^video\//.test(f.m || '');
  const b = p && p.length > 12 ? p : null;
  if (b && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return vid ? 'video/webm' : 'audio/webm'; // EBML: webm / matroska
  if (b && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return vid ? 'video/mp4' : 'audio/mp4'; // ftyp
  if (b && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return vid ? 'video/ogg' : 'audio/ogg';
  const m = String(f.m || '').split(';')[0].trim().toLowerCase().replace('x-matroska', 'webm');
  if (/^(audio|video)\/(webm|mp4|ogg|mpeg|aac)$/.test(m)) return m;
  return vid ? 'video/webm' : 'audio/webm';
}
window.playMime = playMime;
const mediaSrcCache = {};
/** blob:-ссылки одного расшифрованного видео с разными типами: первый — по сигнатуре, дальше запасные */
function mediaSrcs(f) {
  if (f.local) return Promise.resolve([f.local]);
  return mediaSrcCache[f.p] = mediaSrcCache[f.p] || fetchFilePlain(f).then(p => {
    const first = playMime(f, p), alt = ['video/mp4', 'video/webm', 'video/x-matroska', ''];
    return [first, ...alt.filter(x => x !== first)].map(t => URL.createObjectURL(t ? new Blob([p], { type: t }) : new Blob([p])));
  }).catch(e => { delete mediaSrcCache[f.p]; throw e; });
}
window.mediaSrcs = mediaSrcs;
// ---------- аудио/видео-файлы вложением (дизайн 20.10): mp3/m4a — плеер как у голосового, вместо волны имя файла;
// mp4/webm — превью 16:9 с ▶ шириной как у картинки; остальные — карточка файла ----------
const AUD_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', weba: 'audio/webm' };
const VID_EXT = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm' };
function avKind(f) {
  const m = String(f.m || '').split(';')[0].trim().toLowerCase(), ext = String(f.n || '').toLowerCase().split('.').pop(), gen = !m || m === 'application/octet-stream';
  if (/^audio\/(mpeg|mp3|mp4|x-m4a|m4a|aac|ogg|wav|x-wav|webm)$/.test(m)) return { k: 'audio', m: m.replace('x-m4a', 'mp4').replace(/^audio\/m4a$/, 'audio/mp4').replace('mp3', 'mpeg').replace('x-wav', 'wav') };
  if (gen && AUD_EXT[ext]) return { k: 'audio', m: AUD_EXT[ext] };
  if (/^video\/(mp4|webm|x-m4v)$/.test(m)) return { k: 'video', m: m.replace('x-m4v', 'mp4') };
  if (gen && VID_EXT[ext]) return { k: 'video', m: VID_EXT[ext] };
  return null;
}
window.avKind = avKind;
/** Вид вложения: основной источник — f.vk внутри расшифрованного payload (Android: 'voice' | 'round', d — секунды, w — 40 уровней 1..15,
 *  m — audio/mp4 или video/mp4). Только если vk нет — запасной вариант по имени (как Notify.java): voice_* (аудио), round_* / video_note*. */
function mediaKind(f) {
  if (!f || typeof f !== 'object') return null;
  const vk = typeof f.vk === 'string' ? f.vk.toLowerCase() : '';
  if (vk === 'voice' || vk === 'round') return vk;
  if (vk) return null;
  // имя: n (или name у старых payload), без пути/пробелов; расширения: webm/ogg/oga/opus/m4a/mp4/mp3/aac/wav/weba/mkv (20.10: старые voice_*.webm/round_*.webm)
  const n = String(f.n || f.name || '').toLowerCase().trim().split(/[\\/]/).pop().replace(/^(fwd|forwarded)[_\- ]+/, ''), m = String(f.m || '').split(';')[0].trim().toLowerCase();
  const ext = /\.(webm|weba|ogg|oga|opus|m4a|mp4|m4v|mp3|aac|wav|mkv|3gp)$/.test(n), media = !m || m === 'application/octet-stream' || /^(audio|video)\//.test(m) || m === 'application/ogg';
  if (!(ext || media) || /^(image|text)\//.test(m)) return null;
  if (/^(voice|ptt|audio_note)[_\-]/.test(n)) return 'voice';
  if (/^(round|video_note|videonote)[_\-]?/.test(n) && /^(round|video_?note)[_\-0-9.]/.test(n)) return 'round';
  return null;
}
window.mediaKind = mediaKind;
window.fileMediaEl = (f0, download) => {
  const av = avKind(f0); if (!av || !f0.p) return null;
  const f = { ...f0, m: av.m };
  if (av.k === 'audio') {
    const row = document.createElement('div'); row.className = 'voice afile heard';
    const btn = iconBtn('play_arrow', 'Воспроизвести ' + safeName(f.n), 'v-play');
    const name = document.createElement('div'); name.className = 'af-name'; txt(name, safeName(f.n));
    const dur = document.createElement('span'); dur.className = 'v-dur'; txt(dur, f.d ? fmtDur(f.d) : '');
    const dl = iconBtn('download', 'Скачать и расшифровать', 'af-dl'); dl.onclick = ev => { ev.stopPropagation(); download && download(); };
    row.append(btn, name, dur, dl);
    let au = null;
    btn.onclick = async ev => {
      ev.stopPropagation(); if (au && !au.paused) { au.pause(); return; }
      btn.disabled = true;
      try {
        if (!au) { au = new Audio(await mediaUrl(f)); au.onloadedmetadata = () => { if (isFinite(au.duration)) txt(dur, fmtDur(au.duration)); }; au.ontimeupdate = () => txt(dur, fmtDur(au.currentTime)); au.onplay = () => txt(btn.querySelector('.ms'), 'pause'); au.onpause = () => txt(btn.querySelector('.ms'), 'play_arrow'); au.onended = () => { txt(btn.querySelector('.ms'), 'play_arrow'); if (isFinite(au.duration)) txt(dur, fmtDur(au.duration)); }; }
        if (playing && playing !== au) playing.pause(); playing = au; await au.play();
      } catch (e) { toast('Не удалось воспроизвести файл', 3000); } finally { btn.disabled = false; }
    };
    return row;
  }
  const box = document.createElement('div'); box.className = 'vfile'; box.setAttribute('role', 'button'); box.setAttribute('aria-label', 'Видео ' + safeName(f.n));
  const ph = document.createElement('span'); ph.className = 'round-ph ms'; ph.setAttribute('aria-hidden', 'true'); txt(ph, 'play_arrow');
  const cap = document.createElement('div'); cap.className = 'vf-cap'; txt(cap, safeName(f.n) + (f.s ? ' · ' + fmtSize(f.s) : ''));
  const dl = iconBtn('download', 'Скачать и расшифровать', 'vf-dl'); dl.onclick = ev => { ev.stopPropagation(); download && download(); };
  box.append(ph, cap, dl);
  let v = null;
  box.onclick = async ev => {
    ev.stopPropagation(); if (v) return;
    ph.classList.add('spin'); txt(ph, 'progress_activity');
    try {
      const list = await mediaSrcs(f); v = document.createElement('video'); v.controls = true; v.playsInline = true; v.setAttribute('playsinline', ''); let i = 0;
      v.onerror = () => { if (++i < list.length) { v.src = list[i]; v.play().catch(() => {}); } else { v.remove(); v = null; ph.classList.remove('spin'); txt(ph, 'videocam_off'); txt(cap, 'Видео повреждено'); } };
      v.onloadeddata = () => { ph.remove(); cap.remove(); box.classList.add('playing'); };
      v.src = list[0]; box.prepend(v); v.play().catch(() => {});
    } catch (e) { v = null; ph.classList.remove('spin'); txt(ph, 'play_arrow'); toast(e && e.corrupt ? 'Видео повреждено' : 'Не удалось загрузить видео', 3000); }
  };
  return box;
};
function mediaUrl(f) { if (f.local) return Promise.resolve(f.local); /* своё неотправленное — из записанного Blob */ return mediaUrls[f.p] = mediaUrls[f.p] || fetchFilePlain(f).then(p => { mediaBytes[f.p] = p; return p; }).then(p => URL.createObjectURL(new Blob([p], { type: playMime(f, p) }))).catch(e => { delete mediaUrls[f.p]; throw e; }); }
const heardKey = id => 'local-msgr-heard:' + id;
const isHeard = id => { try { return !!localStorage.getItem(heardKey(id)); } catch { return false; } };
let playing = null;
window.mediaEl = (f, m, fromOther) => {
  if (f.vk === 'round') {
    // круг ровно 200px; пока нет первого кадра — серый круг с ▶ (не чёрный); подпись состояния — ПОД кругом, серая, в одну строку
    const wrap = document.createElement('div'); wrap.className = 'round-wrap';
    const box = document.createElement('div'); box.className = 'round-v wait'; box.setAttribute('role', 'button'); box.setAttribute('aria-label', 'Видеосообщение ' + fmtDur(f.d) + ', нажмите для звука');
    const v = document.createElement('video'); v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'metadata'; v.setAttribute('playsinline', ''); v.disablePictureInPicture = true;
    const ph = document.createElement('span'); ph.className = 'round-ph ms'; ph.setAttribute('aria-hidden', 'true'); txt(ph, 'play_arrow');
    const t = document.createElement('span'); t.className = 'round-dur'; txt(t, fmtDur(f.d));
    const cap = document.createElement('div'); cap.className = 'round-cap'; cap.hidden = true;
    box.append(v, ph, t); wrap.append(box, cap);
    const bad = msg => { box.classList.add('wait', 'broken'); txt(ph, 'videocam_off'); cap.hidden = false; txt(cap, msg); };
    // 20.10: первый кадр. Чёрный круг был из-за того, что .wait снимался на loadeddata, а у webm из MediaRecorder кадр в t=0 ещё не
    // декодирован (и Edge не рисует его без play/seek) → видно чёрное <video>. Теперь: seek 0.1 с → кадр в canvas → poster (blob:), затем показ.
    let posterUrl = null;
    const shown = () => { box.classList.remove('wait'); cap.hidden = true; };
    const grab = () => { if (posterUrl || !v.videoWidth) return; try { const c = document.createElement('canvas'), z = Math.min(v.videoWidth, v.videoHeight, 400) || 200; c.width = c.height = z;
      const sw = Math.min(v.videoWidth, v.videoHeight); c.getContext('2d').drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sw) / 2, sw, sw, 0, 0, z, z);
      c.toBlob(b => { if (!b || posterUrl) return; posterUrl = URL.createObjectURL(b); v.poster = posterUrl; shown(); }, 'image/jpeg', 0.85); } catch { shown(); } };
    v.addEventListener('loadedmetadata', () => { if (v.paused) try { v.currentTime = Math.min(0.1, (isFinite(v.duration) && v.duration > 0) ? v.duration / 2 : 0.1); } catch { /* */ } });
    v.addEventListener('loadeddata', () => { if (v.currentTime >= 0.05) grab(); });
    v.addEventListener('seeked', grab);
    v.addEventListener('timeupdate', () => { if (v.currentTime >= 0.1) { grab(); shown(); } });
    let srcs = null, si = 0, started = false;
    // источники: тип по сигнатуре, затем запасные (mp4 / webm / matroska / без типа) — один и тот же расшифрованный Blob
    v.addEventListener('error', () => { if (srcs && ++si < srcs.length) { v.src = srcs[si]; v.load(); v.play().catch(() => {}); } else bad('Видео повреждено'); });
    const start = () => { if (started) return; started = true; mediaSrcs(f).then(list => { srcs = list; si = 0; v.src = list[0]; v.load(); })
      .catch(e => { started = false; bad(e && e.corrupt ? 'Видео повреждено' : 'Не загрузилось — нажмите, чтобы повторить'); }); };
    start();
    box.onclick = ev => { ev.stopPropagation(); if (box.classList.contains('broken') && !started) { box.classList.remove('broken'); cap.hidden = true; return start(); } if (box.classList.contains('broken') || !v.src) return;
      const on = !box.classList.contains('playing'); box.classList.toggle('playing', on); v.muted = !on; v.loop = !on; v.currentTime = 0;
      v.play().catch(() => bad('Видео повреждено')); if (on && fromOther) try { localStorage.setItem(heardKey(m.id), '1'); } catch { /* */ } };
    v.addEventListener('seeked', () => { if (!box.classList.contains('playing') && v.paused && posterUrl) v.play().catch(() => {}); }, { once: false });
    v.onended = () => { box.classList.remove('playing'); v.muted = true; v.loop = true; v.play().catch(() => {}); };
    return wrap;
  }
  return voiceEl(f, m, fromOther);
};
// ---------- голосовое (Design Bot 20.10, как native v13) ----------
// Волна: сохранённые при записи уровни f.w (общий формат с Android: до 64 целых 1..15, пишем 40) → иначе пики из
// decodeAudioData после расшифровки (кэш в localStorage этого браузера, на сервер не уходит).
const SPEEDS = [1, 1.5, 2], SPEED_KEY = 'local-msgr-vspeed', NBARS = 40;
const getSpeed = () => { const v = +(localStorage.getItem(SPEED_KEY) || 1); return SPEEDS.includes(v) ? v : 1; };
const peakKey = id => 'local-msgr-peaks:' + id;
function cachedPeaks(id) { try { const a = JSON.parse(localStorage.getItem(peakKey(id)) || 'null'); return Array.isArray(a) && a.length === NBARS ? a : null; } catch { return null; } }
function resample(w) { const src = w.map(x => Math.max(0, Math.min(15, +x || 0))); if (src.length === NBARS) return src; const out = []; for (let i = 0; i < NBARS; i++) { const a = Math.floor(i * src.length / NBARS), b = Math.max(a + 1, Math.floor((i + 1) * src.length / NBARS)); let mx = 0; for (let j = a; j < b && j < src.length; j++) mx = Math.max(mx, src[j]); out.push(mx); } return out; }
async function decodePeaks(bytes) {
  if (!bytes) return null; const buf = new Uint8Array(bytes).slice().buffer, AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
  const ac = new AC(); try { const ab = await ac.decodeAudioData(buf), ch = ab.getChannelData(0), out = [], step = Math.max(1, Math.floor(ch.length / NBARS));
    for (let i = 0; i < NBARS; i++) { let mx = 0; for (let j = i * step, e = Math.min(ch.length, j + step); j < e; j += 8) mx = Math.max(mx, Math.abs(ch[j])); out.push(mx); }
    const top = Math.max(...out, 1e-4); return out.map(x => Math.max(1, Math.round(x / top * 15))); } finally { try { ac.close(); } catch { /* */ } } }
const barH = h => Math.round(4 + Math.max(0, Math.min(15, h)) / 15 * 18); // 4..22 px
function voiceEl(f, m, fromOther) {
  const unheard = fromOther && !isHeard(m.id);
  const row = document.createElement('div'); row.className = 'voice v2' + (unheard ? '' : ' heard');
  row.style.width = Math.round(180 + Math.min(1, Math.max(0, (+f.d || 1) - 1) / 59) * 80) + 'px'; // 180..260 по длительности (1..60 с)
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'v-play'; btn.setAttribute('aria-label', 'Воспроизвести голосовое ' + fmtDur(f.d));
  btn.innerHTML = '<svg class="v-ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17"/></svg><span class="ms" aria-hidden="true">play_arrow</span>';
  const ico = btn.querySelector('.ms'), setIco = n => txt(ico, n);
  const col = document.createElement('div'); col.className = 'v-col';
  const wave = document.createElement('div'); wave.className = 'v-wave'; wave.tabIndex = 0; wave.setAttribute('role', 'slider'); wave.setAttribute('aria-label', 'Перемотка голосового');
  wave.setAttribute('aria-valuemin', '0'); wave.setAttribute('aria-valuemax', String(Math.round(+f.d || 0))); wave.setAttribute('aria-valuenow', '0');
  const bars = []; for (let i = 0; i < NBARS; i++) { const b = document.createElement('i'); wave.append(b); bars.push(b); }
  const paintBars = lv => lv.forEach((h, i) => { bars[i].style.height = barH(h) + 'px'; });
  const stored = Array.isArray(f.w) && f.w.length ? resample(f.w) : null;
  paintBars(stored || cachedPeaks(m.id) || Array(NBARS).fill(2));
  const meta = document.createElement('div'); meta.className = 'v-meta';
  const dur = document.createElement('span'); dur.className = 'v-dur'; txt(dur, fmtDur(f.d));
  const sp = document.createElement('button'); sp.type = 'button'; sp.className = 'v-speed'; const paintSp = () => { txt(sp, getSpeed() + 'x'); sp.setAttribute('aria-label', 'Скорость ' + getSpeed() + 'x'); }; paintSp();
  const dot = document.createElement('span'); dot.className = 'v-new'; dot.hidden = !unheard; dot.setAttribute('aria-label', 'Не прослушано');
  meta.append(dur, sp, dot); col.append(wave, meta); row.append(btn, col);
  let au = null, loading = null, raf = 0, total = +f.d || 0;
  const prog = () => { const d = au && isFinite(au.duration) && au.duration > 0 ? au.duration : total; const t = au ? au.currentTime : 0, k = d ? Math.min(1, t / d) : 0;
    const on = k * NBARS; for (let i = 0; i < NBARS; i++) { bars[i].classList.toggle('on', i < Math.floor(on)); bars[i].style.setProperty('--p', i === Math.floor(on) ? String(on - i) : ''); }
    wave.setAttribute('aria-valuenow', String(Math.round(t))); txt(dur, au && !au.paused ? fmtDur(Math.max(0, d - t)) : (t > 0 && t < d ? fmtDur(Math.max(0, d - t)) : fmtDur(total))); };
  const loop = () => { prog(); if (au && !au.paused) raf = requestAnimationFrame(loop); };
  const markHeard = () => { if (!fromOther) return; row.classList.add('heard'); dot.hidden = true; try { localStorage.setItem(heardKey(m.id), '1'); } catch { /* */ } };
  async function ensure() {
    if (au) return au;
    if (loading) return loading;
    const my = loading = (async () => {
      row.classList.add('loading'); setIco('close'); btn.setAttribute('aria-label', 'Отменить загрузку');
      const url = await mediaUrl(f);
      if (loading !== my) throw Object.assign(new Error('cancel'), { cancel: true });
      const a = new Audio(url); a.playbackRate = getSpeed();
      a.onplay = () => { setIco('pause'); btn.setAttribute('aria-label', 'Пауза'); cancelAnimationFrame(raf); loop(); };
      a.onpause = () => { setIco('play_arrow'); btn.setAttribute('aria-label', 'Воспроизвести голосовое'); prog(); };
      a.onended = () => { setIco('play_arrow'); a.currentTime = 0; prog(); };
      a.onloadedmetadata = () => { if (isFinite(a.duration) && a.duration > 0) total = a.duration; prog(); };
      const bytes = mediaBytes[f.p]; delete mediaBytes[f.p];
      if (!stored && !cachedPeaks(m.id)) decodePeaks(bytes).then(p => { if (p) { paintBars(p); try { localStorage.setItem(peakKey(m.id), JSON.stringify(p)); } catch { /* */ } } }).catch(() => {});
      au = a; return a;
    })().finally(() => { if (loading === my) loading = null; row.classList.remove('loading'); if (!au) { setIco('play_arrow'); btn.setAttribute('aria-label', 'Воспроизвести голосовое'); } });
    return my;
  }
  async function play() { const a = await ensure(); if (playing && playing !== a) playing.pause(); playing = a; a.playbackRate = getSpeed(); await a.play(); markHeard(); }
  btn.onclick = async ev => {
    ev.stopPropagation();
    if (loading) { loading = null; row.classList.remove('loading'); setIco('play_arrow'); return; } // крестик — отмена загрузки
    if (au && !au.paused) { au.pause(); return; }
    try { await play(); } catch (e) { if (!e.cancel) toastLong(e.userMsg || 'Не удалось воспроизвести: ' + ruErr(e)); }
  };
  sp.onclick = ev => { ev.stopPropagation(); const v = SPEEDS[(SPEEDS.indexOf(getSpeed()) + 1) % SPEEDS.length]; try { localStorage.setItem(SPEED_KEY, String(v)); } catch { /* */ } if (au) au.playbackRate = v; document.querySelectorAll('.voice.v2 .v-speed').forEach(b => { txt(b, v + 'x'); b.setAttribute('aria-label', 'Скорость ' + v + 'x'); }); };
  const seekTo = async fr => { fr = Math.max(0, Math.min(1, fr)); try { const a = await ensure(); const d = isFinite(a.duration) && a.duration > 0 ? a.duration : total; a.currentTime = fr * d; prog(); if (a.paused) await play(); } catch (e) { if (!e.cancel) toast('Не удалось перемотать', 2000); } };
  const frOf = e => { const r = wave.getBoundingClientRect(); return (e.clientX - r.left) / r.width; };
  let drag = false;
  wave.addEventListener('pointerdown', e => { e.stopPropagation(); drag = true; try { wave.setPointerCapture(e.pointerId); } catch { /* */ } seekTo(frOf(e)); });
  wave.addEventListener('pointermove', e => { if (drag && au) { const d = isFinite(au.duration) ? au.duration : total; au.currentTime = Math.max(0, Math.min(1, frOf(e))) * d; prog(); } });
  wave.addEventListener('pointerup', () => { drag = false; }); wave.addEventListener('pointercancel', () => { drag = false; });
  wave.addEventListener('click', e => e.stopPropagation());
  wave.addEventListener('keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); const d = (au && isFinite(au.duration) ? au.duration : total) || 1, t = au ? au.currentTime : 0; seekTo((t + (e.key === 'ArrowRight' ? 5 : -5)) / d); });
  return row;
}
window.voiceEl = voiceEl; window.__decodePeaks = decodePeaks;
})();
