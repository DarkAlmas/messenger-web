// Messenger Local: баннер «сервер на ПК недоступен» (периодическая проверка /auth/v1/health).
(function () {
  const C = window.MSG_CONFIG || {}; if (C.NO_SERVER || !C.SUPABASE_URL) return;
  const b = document.createElement('div'); b.id = 'localDown'; b.className = 'local-down'; b.hidden = true; b.setAttribute('role', 'status');
  b.textContent = 'Сервер на ПК недоступен — сообщения уйдут, когда он включится';
  document.body.prepend(b);
  let busy = false, up = null;
  const lb = document.getElementById('loginBtn'), lf = document.getElementById('loginForm');
  function set(ok) {
    b.hidden = ok; document.body.classList.toggle('srv-down', !ok);
    if (lb) { lb.disabled = !ok; lb.title = ok ? '' : 'Сервер на ПК недоступен'; }
    if (ok === up) return; up = ok; window.LOCAL_SERVER_UP = ok;
    window.dispatchEvent(new CustomEvent('local-server', { detail: { up: ok } }));
  }
  if (lf) lf.addEventListener('submit', e => { if (up === false) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  if (lb) new MutationObserver(() => { if (up === false && !lb.disabled) lb.disabled = true; }).observe(lb, { attributes: true, attributeFilter: ['disabled'] });
  async function check() {
    if (busy) return; busy = true;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    let ok = false;
    try { const r = await fetch(C.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/health', { headers: { apikey: C.SUPABASE_KEY }, cache: 'no-store', signal: ctl.signal }); ok = r.status < 500; } catch (e) { ok = false; }
    clearTimeout(t); busy = false; set(ok);
  }
  check(); setInterval(check, 15000);
  window.addEventListener('online', check); window.addEventListener('offline', () => set(false));
})();
