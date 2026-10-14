// Тема применяется до отрисовки, чтобы не было вспышки
(function () { try { var t = localStorage.getItem('msgr-theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; } catch (e) { /* нет localStorage */ } })();
