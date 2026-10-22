/* Messenger Local: адрес сервера и anon-ключ берутся во время работы, а не из сборки.
   Порядок: 1) ручной адрес («Настройки сервера» на экране входа) → 2) последний проверенный подписанный server.json
   → 3) нет сервера (показываем просьбу указать сервер). Зеркалит Android «Messenger Local». */
(function () {
  'use strict';
  // ==== Константы (менять здесь) ====
  const CONFIG_URL = 'https://darkalmas.github.io/messenger-web/local/server.json'; // TODO: адрес server.json на GitHub Pages, напр. 'https://<user>.github.io/<repo>/server.json'
  const ALLOWED_HOST_SUFFIXES = ['trycloudflare.com', 'ngrok-free.app', 'ngrok.app', 'pinggy.link', 'lhr.life']; // хост == суффикс или оканчивается на '.'+суффикс; домен Димы — дописать сюда
  const SERVER_PUBKEY_B64 = 'eRAw43bRwUGqt7DmZQUkZkajEKuXtzXT3zj8SDf2W8s='; // Ed25519 raw 32 байта
  const MAX_FUTURE_SEC = 600;
  const LS = { manual: 'msgr-local-manual', good: 'msgr-local-good', lastIssued: 'msgr-local-issued', changed: 'msgr-local-changed', active: 'msgr-local-active' };
  const SESSION_KEYS = ['local-msgr-auth'];
  const PLACEHOLDER = 'https://unconfigured.invalid';

  function allowedUrl(s) {
    let u; try { u = new URL(String(s)); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return null;
    if (u.pathname !== '/' && u.pathname !== '') return null;
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!ALLOWED_HOST_SUFFIXES.some(sfx => h === sfx || h.endsWith('.' + sfx))) return null;
    return 'https://' + h;
  }
  function b64urlDecode(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return atob(s); }
  function anonKeyOk(k) {
    if (typeof k !== 'string' || !k) return false;
    if (/^sb_secret_/.test(k)) return false;
    if (/^sb_publishable_/.test(k)) return true;
    const p = k.split('.'); if (p.length !== 3) return false;
    try { const j = JSON.parse(b64urlDecode(p[1])); return j && j.role === 'anon'; } catch (e) { return false; }
  }
  function b64ToBytes(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

  // Проверка подписанного файла {"payload":"<JSON string>","sig":"<base64>"}; подпись — по UTF-8 байтам payload как есть.
  async function verifySigned(file, opts) {
    opts = opts || {};
    const pub = opts.pubkeyB64 || SERVER_PUBKEY_B64;
    const now = opts.nowSec != null ? opts.nowSec : Math.floor(Date.now() / 1000);
    const last = opts.lastIssued != null ? opts.lastIssued : Number(localStorage.getItem(LS.lastIssued) || 0);
    if (!file || typeof file.payload !== 'string' || typeof file.sig !== 'string') throw new Error('bad format');
    const subtle = (globalThis.crypto || {}).subtle;
    if (!subtle) throw new Error('no WebCrypto'); // запасной библиотеки Ed25519 в vendor/ нет
    const key = await subtle.importKey('raw', b64ToBytes(pub), { name: 'Ed25519' }, false, ['verify']);
    const ok = await subtle.verify({ name: 'Ed25519' }, key, b64ToBytes(file.sig), new TextEncoder().encode(file.payload));
    if (!ok) throw new Error('bad signature');
    const p = JSON.parse(file.payload);
    const url = allowedUrl(p.server_url);
    if (!url) throw new Error('server_url not allowed');
    if (!anonKeyOk(p.anon_key)) throw new Error('key is not anon');
    if (!Number.isInteger(p.issued_at)) throw new Error('bad issued_at');
    if (p.issued_at < last) throw new Error('replay (older issued_at)');
    if (p.issued_at > now + MAX_FUTURE_SEC) throw new Error('future issued_at');
    return { server_url: url, anon_key: p.anon_key, issued_at: p.issued_at };
  }

  const read = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  function valid(c) { return c && allowedUrl(c.server_url) && anonKeyOk(c.anon_key) ? { server_url: allowedUrl(c.server_url), anon_key: c.anon_key } : null; }
  function current() { return valid(read(LS.manual)) || valid(read(LS.good)); }

  // Смена сервера: сначала стираем сессию, потом переключаемся.
  function clearSession() {
    for (const k of SESSION_KEYS) { try { localStorage.removeItem(k); localStorage.removeItem(k + '-code-verifier'); } catch (e) { /* */ } }
    try { Object.keys(localStorage).filter(k => /^sb-.*-auth-token/.test(k)).forEach(k => localStorage.removeItem(k)); } catch (e) { /* */ }
  }
  function switchTo(next) {
    const prev = localStorage.getItem(LS.active);
    const id = next ? next.server_url + '|' + next.anon_key : '';
    if (prev !== null && prev !== id) {
      try { if (window.sb && window.sb.auth) window.sb.auth.signOut({ scope: 'local' }); } catch (e) { /* */ }
      clearSession(); localStorage.setItem(LS.changed, '1');
    }
    localStorage.setItem(LS.active, id);
  }

  const cfg = current();
  switchTo(cfg);
  window.MSG_CONFIG = { SUPABASE_URL: cfg ? cfg.server_url : PLACEHOLDER, SUPABASE_KEY: cfg ? cfg.anon_key : 'none', NO_SERVER: !cfg };

  async function refresh() {
    if (!CONFIG_URL) return;
    try {
      const r = await fetch(CONFIG_URL, { cache: 'no-store' }); if (!r.ok) return;
      const v = await verifySigned(await r.json());
      localStorage.setItem(LS.good, JSON.stringify(v)); localStorage.setItem(LS.lastIssued, String(v.issued_at));
      if (!valid(read(LS.manual))) { const n = current(); if (!cfg || n.server_url !== cfg.server_url || n.anon_key !== cfg.anon_key) { switchTo(n); location.reload(); } }
    } catch (e) { console.warn('server.json rejected:', e && e.message); }
  }
  function setManual(url, key) {
    const u = allowedUrl(url); if (!u) throw new Error('Разрешены только https-адреса туннеля (trycloudflare, ngrok, pinggy, lhr.life) без логина и порта');
    if (!anonKeyOk(key)) throw new Error('Нужен anon-ключ (service_role не принимается)');
    localStorage.setItem(LS.manual, JSON.stringify({ server_url: u, anon_key: key }));
    switchTo({ server_url: u, anon_key: key }); location.reload();
  }
  function clearManual() { localStorage.removeItem(LS.manual); switchTo(current()); location.reload(); }

  function ui() {
    const auth = document.getElementById('auth'); if (!auth) return;
    const box = document.createElement('div'); box.className = 'hint'; box.id = 'serverCfg';
    const msg = document.createElement('p');
    if (localStorage.getItem(LS.changed) === '1') { msg.textContent = '⚠ Сервер изменился. Войдите заново по паролю'; localStorage.removeItem(LS.changed); }
    else if (!cfg) msg.textContent = 'Сервер не задан. Укажите адрес сервера в «Настройках сервера».';
    const a = document.createElement('a'); a.href = '#'; a.textContent = 'Настройки сервера';
    const form = document.createElement('div'); form.hidden = true;
    const iu = document.createElement('input'); iu.type = 'url'; iu.placeholder = 'https://….trycloudflare.com'; iu.value = cfg ? cfg.server_url : '';
    const ik = document.createElement('input'); ik.type = 'password'; ik.placeholder = 'anon-ключ'; ik.autocomplete = 'off';
    const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Сохранить';
    const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Сбросить ручной адрес';
    const err = document.createElement('p');
    save.onclick = () => { try { setManual(iu.value.trim(), ik.value.trim()); } catch (e) { err.textContent = e.message; } };
    reset.onclick = clearManual;
    a.onclick = e => { e.preventDefault(); form.hidden = !form.hidden; };
    form.append(iu, ik, save, reset, err); box.append(msg, a, form);
    (auth.querySelector('#authMsg') || auth).after ? (auth.querySelector('#authMsg') || auth.lastChild).after(box) : auth.append(box);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ui); else ui();

  window.MSG_SERVER = { allowedUrl, anonKeyOk, verifySigned, setManual, clearManual, refresh, CONFIG_URL, ALLOWED_HOST_SUFFIXES };
  refresh();
})();
