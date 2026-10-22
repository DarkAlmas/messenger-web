// Проверка версии: устаревший index.html/app.js из кэша (GitHub Pages: max-age=600) → одна перезагрузка на свежую сборку
(async () => {
  { const u = new URL(location.href); if (u.searchParams.has('_v')) { u.searchParams.delete('_v'); history.replaceState(history.state, '', u.pathname + u.search + u.hash); } }
  const cur = window.BUILD && BUILD.commit; if (!cur) return;
  try {
    const t = await (await fetch('build.js?t=' + Date.now(), { cache: 'no-store' })).text();
    const m = /commit:\s*'([0-9a-f]+)'/.exec(t); if (!m || m[1] === cur) return;
    const k = 'local-msgr-reloaded:' + m[1];
    if (sessionStorage.getItem(k)) return; // уже перезагружали на эту сборку — без цикла
    sessionStorage.setItem(k, '1');
    const u = new URL(location.href); u.searchParams.set('_v', m[1]); location.replace(u.toString());
  } catch (e) { /* нет сети — проверим при следующей загрузке */ }
})();
