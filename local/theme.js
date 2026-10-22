// Тема применяется до отрисовки, чтобы не было вспышки
(function () { try { var t = localStorage.getItem('local-msgr-theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; } catch (e) { /* нет localStorage */ } })();
