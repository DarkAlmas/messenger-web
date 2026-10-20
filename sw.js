/* Service worker: офлайн-оболочка сайта (network-first), уведомления, Web Push. */
const CACHE = 'msgr-shell-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const own = u.origin === self.location.origin, cdn = u.host === 'cdn.jsdelivr.net';
  if (!own && !cdn) return; // API Supabase не кэшируем
  e.respondWith(fetch(r).then(res => { if (res.ok && (res.type === 'basic' || res.type === 'cors')) { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); } return res; })
    .catch(() => caches.match(r).then(m => m || caches.match(r, { ignoreSearch: true })).then(m => m || (r.mode === 'navigate' ? caches.match('./', { ignoreSearch: true }) : Response.error()))));
});
async function toClient(msg, url) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const c = list.find(x => x.url.startsWith(self.registration.scope)) || list[0];
  if (c) { try { await c.focus(); } catch (e) { /* */ } c.postMessage(msg); return true; }
  if (url) await self.clients.openWindow(url);
  return false;
}
self.addEventListener('notificationclick', e => {
  const n = e.notification, d = n.data || {}; n.close();
  const act = e.action === 'read' ? 'read' : e.action === 'reply' ? 'reply' : 'open';
  if (act === 'read') { e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => { if (l[0]) l[0].postMessage({ t: 'read', chat_id: d.chat_id, msg_at: d.msg_at }); })); return; }
  e.waitUntil(toClient({ t: act, chat_id: d.chat_id }, self.registration.scope + (d.chat_id ? '?open=' + d.chat_id : '')));
});
// Push (FCM, сервер Hack Bot): только message_id. Текст — из локального кэша расшифрованных сообщений (IndexedDB msgr-cache);
// расшифровать в SW нельзя (ключи Signal у вкладки) — иначе «Новое сообщение».
function cacheLookup(id) {
  return new Promise(res => {
    const r = indexedDB.open('msgr-cache', 1);
    r.onupgradeneeded = () => { r.transaction.abort(); res(null); };
    r.onerror = () => res(null);
    r.onsuccess = () => {
      const db = r.result; let found = null;
      try {
        const cur = db.transaction('kv').objectStore('kv').openCursor();
        cur.onsuccess = () => { const c = cur.result; if (!c || found) { db.close(); return res(found); } const v = c.value; if (/:msgs:/.test(String(c.key)) && v && v[id]) found = { chat: String(c.key).split(':msgs:')[1], ...v[id] }; c.continue(); };
        cur.onerror = () => { db.close(); res(null); };
      } catch (e) { db.close(); res(null); }
    };
  });
}
const fmtDur = d => { d = Math.max(0, Math.round(+d || 0)); return Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0'); };
function textOf(pt) {
  try { const o = JSON.parse(pt); const f = o.f || null;
    if (f && f.vk === 'voice') return '🎤 Голосовое сообщение ' + fmtDur(f.d);
    if (f && f.vk === 'round') return '⭕ Видеосообщение';
    return o.t || o.caption || (f ? 'Файл' : 'Новое сообщение'); } catch (e) { return 'Новое сообщение'; }
}
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { /* */ }
  d = d.data || d; // формат FCM: { data: { message_id, chat_id? } }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window' });
    if (wins.some(c => c.visibilityState === 'visible')) return; // открытая вкладка сама покажет «Имя: текст»
    let body = 'Новое сообщение', chat = d.chat_id || null;
    const hit = d.message_id ? await cacheLookup(d.message_id) : null;
    if (hit) { body = textOf(hit.pt); chat = chat || hit.chat; }
    if (d.sender_name && body !== 'Новое сообщение') body = d.sender_name + ': ' + body;
    await self.registration.showNotification(d.title || 'Мессенджер', { body, tag: 'chat-' + (chat || 'x'), renotify: true, data: { chat_id: chat, message_id: d.message_id }, actions: [{ action: 'reply', title: 'Ответить' }, { action: 'read', title: 'Прочитано' }] });
  })());
});
