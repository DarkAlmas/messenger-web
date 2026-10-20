/* Service worker: офлайн-оболочка сайта (network-first), уведомления, Web Push. */
const VER = '20261020n'; // меняется с каждой правкой sw.js → браузер ставит новый SW
const CACHE = 'msgr-shell-' + VER;
// Установка: кладём в кэш ВСЮ оболочку (index + все скрипты/стили из него + модули E2E + CDN), иначе первая офлайн-перезагрузка не грузит app.js и др.
const EXTRA = ['./', 'index.html', 'e2e.js?v=20261020h', 'vendor/sigwasm/sigwasm.js?v=20261014k', 'vendor/sigwasm/sigwasm_bg.wasm?v=20261014k', 'fonts/material-symbols-rounded.woff2?v=8'];
async function precache() {
  const c = await caches.open(CACHE);
  let urls = [...EXTRA];
  try { const html = await (await fetch('./', { cache: 'no-cache' })).text(); for (const m of html.matchAll(/<(?:script|link|img)[^>]+(?:src|href)="([^"]+)"/g)) if (!/^(data:|#|mailto:)/.test(m[1])) urls.push(m[1]); } catch (e) { /* */ }
  // модули, подгружаемые из скриптов (import('./e2e.js?v=…'), import … from './vendor/…') — тоже в кэш
  for (const js of ['app.js', 'e2e.js']) { try { const src = urls.find(u => u.split('?')[0] === js) || js; const t = await (await fetch(new URL(src, self.registration.scope).href, { cache: 'no-cache' })).text(); for (const m of t.matchAll(/(?:import\(|from\s*)'\.\/([^']+)'/g)) urls.push(m[1]); } catch (e) { /* */ } }
  urls = [...new Set(urls)];
  await Promise.all(urls.map(async u => { try { const abs = new URL(u, self.registration.scope); const cdn = abs.host === 'cdn.jsdelivr.net'; const res = await fetch(abs.href, cdn ? { mode: 'no-cors' } : { cache: 'no-cache' }); if (res.ok || (cdn && res.type === 'opaque')) await c.put(abs.href, res); } catch (e) { /* один файл не помешает остальным */ } }));
}
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(precache()); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('msgr-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const own = u.origin === self.location.origin, cdn = u.host === 'cdn.jsdelivr.net';
  if (!own && !cdn) return; // API Supabase не кэшируем
  // свои файлы — всегда с сервера с проверкой (no-cache: HTTP-кэш GitHub Pages 10 мин не отдаёт старую сборку), без сети — из кэша
  e.respondWith((own ? (r.mode === 'navigate' ? fetch(r.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(r, { cache: 'no-cache' })) : fetch(r)).then(res => { if ((res.ok && (res.type === 'basic' || res.type === 'cors')) || (cdn && res.type === 'opaque')) { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); } return res; })
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
