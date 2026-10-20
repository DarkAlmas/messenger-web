/* Иконки (Design Bot 20.10): play/pause/mic/send/download/done/done_all/radio — inline SVG, без лигатур.
 * Остальные .ms — шрифт fonts/ (self-host); слово-лигатура не видно никогда: .ms 1em×1em + прозрачный текст до загрузки шрифта. */
(() => {
  const P = {
    play_arrow: 'M8 5.14v13.72a1 1 0 0 0 1.52.85l10.9-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z',
    pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
    mic: 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5.3-3a5.3 5.3 0 0 1-10.6 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z',
    send: 'M3.4 20.4 21 12 3.4 3.6 3.4 10.1 15 12 3.4 13.9z',
    download: 'M12 16l-5-5 1.4-1.45L11 12.15V4h2v8.15l2.6-2.6L17 11zm-6 4a2 2 0 0 1-2-2v-3h2v3h12v-3h2v3a2 2 0 0 1-2 2z',
    done: 'M9.55 18 3.85 12.3l1.43-1.43 4.27 4.28 9.17-9.18 1.43 1.43z',
    done_all: 'M1.65 12.3 3.08 10.9l5.66 5.66-1.42 1.42zm5.66 0 1.42-1.4 4.25 4.24 9.9-9.9 1.4 1.42L13 17.97zM18.36 6.66 13 12l-1.4-1.4 5.34-5.35z',
    radio_button_unchecked: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z',
    radio_button_checked: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z',
  };
  P.file_download = P.download; P.keyboard_voice = P.mic; P.check = P.done;
  const NS = 'http://www.w3.org/2000/svg';
  window.svgIcon = name => { const d = P[name]; if (!d) return null; const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false'); const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'currentColor'); s.append(p); return s; };
  const up = el => { if (!el.classList || !el.classList.contains('ms')) return; const n = (el.textContent || '').trim(); if (!n && el.dataset.ico && el.firstElementChild) return; /* уже SVG */ if (el.dataset.ico === n && el.firstElementChild) return; const s = P[n] && svgIcon(n); if (!s) { if (el.classList.contains('svgi')) el.classList.remove('svgi'); if ('ico' in el.dataset) delete el.dataset.ico; return; } el.dataset.ico = n; el.classList.add('svgi'); el.replaceChildren(s); el.setAttribute('data-name', n); };
  const scan = root => { if (root.nodeType !== 1) return; up(root); root.querySelectorAll && root.querySelectorAll('.ms').forEach(up); };
  // textContent у .svgi читаем как имя: заменённый span при повторном txt(el,'pause') снова получает текст → наблюдатель перерисует
  new MutationObserver(ms => { for (const m of ms) { if (m.type === 'childList') { m.addedNodes.forEach(n => n.nodeType === 1 ? scan(n) : n.parentElement && up(n.parentElement)); if (m.target.nodeType === 1) up(m.target); } else if (m.type === 'characterData' && m.target.parentElement) up(m.target.parentElement); else if (m.type === 'attributes') up(m.target); } })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  const ok = () => document.documentElement.classList.add('icons-ok');
  document.addEventListener('DOMContentLoaded', () => scan(document.body));
  try { document.fonts.load('24px "Material Symbols Rounded"', 'home').then(f => { if (f.length) ok(); }); document.fonts.ready.then(() => { if (document.fonts.check('24px "Material Symbols Rounded"', 'home')) ok(); }); } catch { /* */ }
})();
