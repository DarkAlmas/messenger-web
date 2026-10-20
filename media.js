/* Офлайн-кэш (IndexedDB), состояние соединения, догрузка после reconnect, уведомления (service worker),
   клиентская push-подписка, запись голосовых и видеокружков. Подключается после app.js (общие глобальные имена). */
(() => {
// ---------- значки: пока шрифт не загружен, текст лигатур («done», «mic») не показываем ----------
if (document.fonts && document.fonts.load) Promise.race([document.fonts.load("24px 'Material Symbols Rounded'", 'mic'), new Promise(r => setTimeout(r, 4000))]).finally(() => document.documentElement.classList.add('ms-ready'));
else document.documentElement.classList.add('ms-ready');
// ---------- IndexedDB: msgr-cache / kv ----------
const DB = 'msgr-cache'; let dbp = null;
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
function revive() { // канал упал окончательно (chan = null после ошибки) — пересоздаём, не чаще раза в 10 с
  if (!navigator.onLine || Date.now() - reviveAt < 10000) return; reviveAt = Date.now();
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
    if (!hadCtl) return; let k = 'msgr-sw-reloaded'; try { if (sessionStorage.getItem(k) === BUILD.commit) return; sessionStorage.setItem(k, BUILD.commit); } catch { return; }
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
  const list = kind === 'voice' ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'] : ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
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
  mr.ondataavailable = ev => { if (ev.data && ev.data.size) rec && rec.chunks.push(ev.data); };
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
function lockRec() { if (!rec) return; rec.locked = true; $('recLock').hidden = false; txt($('recCancel'), 'Отмена'); $('recCancel').style.transform = ''; }
$('recCancel').onclick = () => { if (rec) stopRec(false); };
$('recSend').onclick = () => { if (rec) stopRec(true); };
function stopRec(send) {
  const r = rec; if (!r) return; rec = null; clearInterval(r.timer);
  const dur = Math.max(1, Math.round((Date.now() - r.t0) / 1000));
  $('recBar').hidden = true; $('sendForm').classList.remove('recording'); $('roundBox').hidden = true; $('roundPrev').srcObject = null; txt($('recCancel'), '‹ Отмена');
  r.mr.onstop = () => {
    r.stream.getTracks().forEach(t => t.stop()); try { r.ac && r.ac.close(); } catch { /* */ }
    if (!send) return toast('Запись отменена', 1500);
    if (Date.now() - r.t0 < 700) return toast('Слишком короткая запись', 1500);
    const type = (r.mr.mimeType || (r.mode === 'voice' ? 'audio/webm' : 'video/webm')).split(';')[0];
    const blob = new Blob(r.chunks, { type }), ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';
    if (blob.size > MAX_FILE) return toastLong('Запись больше 25 МБ');
    const file = new File([blob], (r.mode === 'voice' ? 'voice_' : 'round_') + Date.now() + '.' + ext, { type });
    const media = { vk: r.mode, d: Math.min(MAX_REC, dur) };
    if (r.mode === 'voice') media.w = squash(r.wave, 40);
    outSend({ chat: r.chat, kind: 'file', file, caption: '', extra: {}, media });
  };
  try { r.mr.stop(); } catch { r.mr.onstop(); }
}
function squash(w, n) { if (!w.length) return Array(n).fill(2); const mx = Math.max(...w, 1), out = []; for (let i = 0; i < n; i++) { const a = Math.floor(i * w.length / n), b = Math.max(a + 1, Math.floor((i + 1) * w.length / n)); let m = 0; for (let j = a; j < b; j++) m = Math.max(m, w[j] || 0); out.push(Math.max(1, Math.round(m / mx * 15))); } return out; }
window.squashWave = squash;

// ---------- воспроизведение ----------
const mediaUrls = {};
function mediaUrl(f) { return mediaUrls[f.p] = mediaUrls[f.p] || fetchFilePlain(f).then(p => URL.createObjectURL(new Blob([p], { type: /^(audio|video)\/(webm|mp4|ogg|mpeg)$/.test(f.m) ? f.m : 'application/octet-stream' }))).catch(e => { delete mediaUrls[f.p]; throw e; }); }
const heardKey = id => 'msgr-heard:' + id;
const isHeard = id => { try { return !!localStorage.getItem(heardKey(id)); } catch { return false; } };
let playing = null;
window.mediaEl = (f, m, fromOther) => {
  if (f.vk === 'round') {
    const box = document.createElement('div'); box.className = 'round-v'; box.setAttribute('role', 'button'); box.setAttribute('aria-label', 'Видеосообщение ' + fmtDur(f.d) + ', нажмите для звука');
    const v = document.createElement('video'); v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
    const t = document.createElement('span'); t.className = 'round-dur'; txt(t, fmtDur(f.d));
    box.append(v, t);
    mediaUrl(f).then(u => { v.src = u; v.play().catch(() => {}); }).catch(() => txt(t, 'не загрузилось'));
    box.onclick = ev => { ev.stopPropagation(); const big = !box.classList.contains('big'); box.classList.toggle('big', big); v.muted = !big; v.loop = !big; v.currentTime = 0; v.play().catch(() => {}); if (big && fromOther) try { localStorage.setItem(heardKey(m.id), '1'); } catch { /* */ } };
    v.onended = () => { box.classList.remove('big'); v.muted = true; v.loop = true; v.play().catch(() => {}); };
    return box;
  }
  const row = document.createElement('div'); row.className = 'voice' + (!fromOther || isHeard(m.id) ? ' heard' : '');
  const btn = iconBtn('play_arrow', 'Воспроизвести голосовое', 'v-play');
  const wave = document.createElement('div'); wave.className = 'v-wave';
  for (const h of (Array.isArray(f.w) ? f.w.slice(0, 64) : Array(40).fill(3))) { const i = document.createElement('i'); i.style.height = (3 + Math.max(0, Math.min(15, +h || 0)) * 1.4) + 'px'; wave.append(i); }
  const dur = document.createElement('span'); dur.className = 'v-dur'; txt(dur, fmtDur(f.d));
  row.append(btn, wave, dur);
  let au = null;
  const paintProg = () => { if (!au || !au.duration || !isFinite(au.duration)) return; const k = au.currentTime / au.duration, bars = wave.children; for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('on', i / bars.length < k); txt(dur, fmtDur(au.currentTime)); };
  btn.onclick = async ev => {
    ev.stopPropagation();
    if (au && !au.paused) { au.pause(); return; }
    btn.disabled = true;
    try {
      if (!au) { au = new Audio(await mediaUrl(f)); au.ontimeupdate = paintProg; au.onplay = () => { txt(btn.querySelector('.ms'), 'pause'); }; au.onpause = () => txt(btn.querySelector('.ms'), 'play_arrow'); au.onended = () => { txt(btn.querySelector('.ms'), 'play_arrow'); txt(dur, fmtDur(f.d)); wave.querySelectorAll('i').forEach(i => i.classList.remove('on')); }; }
      if (playing && playing !== au) playing.pause(); playing = au;
      await au.play();
      if (fromOther) { row.classList.add('heard'); try { localStorage.setItem(heardKey(m.id), '1'); } catch { /* */ } }
    } catch (e) { toastLong(e.userMsg || 'Не удалось воспроизвести: ' + ruErr(e)); }
    finally { btn.disabled = false; }
  };
  return row;
};
})();
