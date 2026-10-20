// Баннер «Установить приложение» — только Android. Данные из version.json рядом с сайтом; файла нет (релиз не опубликован) — баннера нет.
// Ссылка только на релизы GitHub-репозитория; сертификат подписи (certSha256) показываем текстом для сверки.
(function () {
  const APK_PREFIXES = ['https://github.com/DarkAlmas/messenger-web/releases/download/', 'https://github.com/DarkAlmas/messenger-android/releases/download/'];
  const ua = navigator.userAgent || '';
  if (!/Android/i.test(ua) || /; wv\)/.test(ua)) return;
  const KEY = 'msgr-appbanner-dismissed';
  fetch('version.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(v => {
    if (!v || typeof v !== 'object') return;
    const url = typeof v.apkUrl === 'string' && APK_PREFIXES.some(p => v.apkUrl.startsWith(p)) && !/[\s"'<>]/.test(v.apkUrl) ? v.apkUrl : null;
    const ver = typeof v.version === 'string' ? v.version.slice(0, 32) : (typeof v.versionName === 'string' ? v.versionName.slice(0, 32) : '');
    const tag = ver || url || 'x';
    try { if (localStorage.getItem(KEY) === tag) return; } catch (e) { /* */ }
    const b = document.createElement('div'); b.id = 'appBanner'; b.className = 'app-banner'; b.setAttribute('role', 'region'); b.setAttribute('aria-label', 'Установить приложение');
    const ic = document.createElement('span'); ic.className = 'ms'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = 'download';
    const tx = document.createElement('div'); tx.className = 'ab-text';
    const t1 = document.createElement('div'); t1.className = 'ab-title'; t1.textContent = 'Установить приложение' + (ver ? ' ' + ver : '');
    tx.append(t1);
    const cert = typeof v.certSha256 === 'string' && /^[0-9A-Fa-f:]{64,95}$/.test(v.certSha256.trim()) ? v.certSha256.trim() : null;
    const rel = url ? url.replace(/\/releases\/download\/([^/]+)\/.*$/, '/releases/tag/$1') : null;
    if (cert) {
      const l = document.createElement('a'); l.href = '#'; l.className = 'ab-check'; l.textContent = 'Проверка подписи';
      l.onclick = ev => { ev.preventDefault(); certDialog(cert, rel); }; tx.append(l);
    }
    b.append(ic, tx);
    if (url) { const a = document.createElement('a'); a.className = 'ab-go'; a.href = url; a.rel = 'noopener noreferrer'; a.textContent = 'Скачать'; b.append(a); }
    const x = document.createElement('button'); x.type = 'button'; x.className = 'ab-x'; x.setAttribute('aria-label', 'Закрыть');
    const xi = document.createElement('span'); xi.className = 'ms'; xi.setAttribute('aria-hidden', 'true'); xi.textContent = 'close'; x.append(xi);
    x.onclick = () => { b.remove(); try { localStorage.setItem(KEY, tag); } catch (e) { /* */ } };
    b.append(x);
    document.body.prepend(b);
  }).catch(() => { /* нет файла / сети — баннера нет */ });
  function certDialog(cert, rel) {
    let d = document.getElementById('certDlg');
    if (!d) { d = document.createElement('dialog'); d.id = 'certDlg'; d.className = 'cert-dlg'; document.body.append(d); }
    d.textContent = '';
    const h = document.createElement('div'); h.className = 'cd-title'; h.textContent = 'SHA-256 сертификата подписи';
    const row = document.createElement('div'); row.className = 'cd-row';
    const code = document.createElement('code'); code.className = 'cd-val'; code.textContent = cert;
    const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'cd-copy'; cp.setAttribute('aria-label', 'Копировать');
    const ci = document.createElement('span'); ci.className = 'ms'; ci.setAttribute('aria-hidden', 'true'); ci.textContent = 'content_copy'; cp.append(ci);
    cp.onclick = async () => {
      try { await navigator.clipboard.writeText(cert); }
      catch (e) { const r = document.createRange(); r.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand('copy'); sel.removeAllRanges(); }
      // тост внутри диалога: обычный #toast оказался бы под модальным окном (top layer)
      let t = d.querySelector('.cd-toast'); if (!t) { t = document.createElement('div'); t.className = 'cd-toast'; t.setAttribute('role', 'status'); d.append(t); }
      t.textContent = 'Скопировано'; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 2000);
    };
    row.append(code, cp); d.append(h, row);
    if (rel) { const a = document.createElement('a'); a.className = 'cd-rel'; a.href = rel; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Страница релиза'; d.append(a); }
    const c = document.createElement('button'); c.type = 'button'; c.className = 'cd-close'; c.textContent = 'Закрыть'; c.onclick = () => d.close(); d.append(c);
    d.onclick = ev => { if (ev.target === d) d.close(); };
    d.showModal();
  }
})();
