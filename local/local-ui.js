// Messenger Local: баннер «сервер на ПК недоступен» (периодическая проверка /auth/v1/health).
(function () {
  const C = window.MSG_CONFIG || {}; if (C.NO_SERVER || !C.SUPABASE_URL) return;
  const b = document.createElement('div'); b.id = 'localDown'; b.className = 'local-down'; b.hidden = true; b.setAttribute('role', 'status');
  b.textContent = 'Сервер на ПК недоступен — сообщения уйдут, когда он включится';
  document.body.prepend(b);
  let busy = false;
  async function check() {
    if (busy) return; busy = true;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    let ok = false;
    try { const r = await fetch(C.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/health', { headers: { apikey: C.SUPABASE_KEY }, cache: 'no-store', signal: ctl.signal }); ok = r.status < 500; } catch (e) { ok = false; }
    clearTimeout(t); b.hidden = ok; busy = false;
  }
  check(); setInterval(check, 15000);
  window.addEventListener('online', check); window.addEventListener('offline', () => { b.hidden = false; });
})();
