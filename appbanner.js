// Баннер «Установить приложение» — только Android. Данные из version.json рядом с сайтом; файла нет (релиз не опубликован) — баннера нет.
// Ссылка только на релизы GitHub-репозитория; сертификат подписи (certSha256) показываем текстом для сверки.
(function () {
  const APK_PREFIX = 'https://github.com/DarkAlmas/messenger-web/releases/download/';
  const ua = navigator.userAgent || '';
  if (!/Android/i.test(ua) || /; wv\)/.test(ua)) return;
  const KEY = 'msgr-appbanner-dismissed';
  fetch('version.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(v => {
    if (!v || typeof v !== 'object') return;
    const url = typeof v.apkUrl === 'string' && v.apkUrl.startsWith(APK_PREFIX) && !/[\s"'<>]/.test(v.apkUrl) ? v.apkUrl : null;
    const ver = typeof v.version === 'string' ? v.version.slice(0, 32) : (typeof v.versionName === 'string' ? v.versionName.slice(0, 32) : '');
    const tag = ver || url || 'x';
    try { if (localStorage.getItem(KEY) === tag) return; } catch (e) { /* */ }
    const b = document.createElement('div'); b.id = 'appBanner'; b.className = 'app-banner'; b.setAttribute('role', 'region'); b.setAttribute('aria-label', 'Установить приложение');
    const ic = document.createElement('span'); ic.className = 'ms'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = 'download';
    const tx = document.createElement('div'); tx.className = 'ab-text';
    const t1 = document.createElement('div'); t1.className = 'ab-title'; t1.textContent = 'Установить приложение' + (ver ? ' ' + ver : '');
    tx.append(t1);
    if (typeof v.certSha256 === 'string' && /^[0-9A-Fa-f:]{64,95}$/.test(v.certSha256.trim())) {
      const c = document.createElement('div'); c.className = 'ab-cert'; c.textContent = 'SHA-256 сертификата подписи: ' + v.certSha256.trim(); tx.append(c);
    }
    b.append(ic, tx);
    if (url) { const a = document.createElement('a'); a.className = 'ab-go'; a.href = url; a.rel = 'noopener noreferrer'; a.textContent = 'Скачать'; b.append(a); }
    const x = document.createElement('button'); x.type = 'button'; x.className = 'ab-x'; x.setAttribute('aria-label', 'Закрыть');
    const xi = document.createElement('span'); xi.className = 'ms'; xi.setAttribute('aria-hidden', 'true'); xi.textContent = 'close'; x.append(xi);
    x.onclick = () => { b.remove(); try { localStorage.setItem(KEY, tag); } catch (e) { /* */ } };
    b.append(x);
    document.body.prepend(b);
  }).catch(() => { /* нет файла / сети — баннера нет */ });
})();
