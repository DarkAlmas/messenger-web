const C = window.MSG_CONFIG;
const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: true, storageKey: 'local-msgr-auth', autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (...a) => navigator.onLine ? window.fetch(...a) : Promise.reject(new TypeError('Failed to fetch')) } }); // без сети — сразу ошибка, без долгих повторов // fetch через window — media.js видит сбои сети
window.sb = sb; // для config.js: signOut при смене сервера
const $ = id => document.getElementById(id);
// Свои записи истории этой страницы: «назад» уходит в history.back() только по ним (иначе уводил на чужую/битую запись → 404)
let ownNav = 0; function navPush(st, t, u) { ownNav++; history.pushState(st, t, u); }
addEventListener('popstate', () => { if (ownNav > 0) ownNav--; });
// Одна сессия (= одно устройство E2E) на браузер: сессия в localStorage, токен обновляет только одна вкладка-лидер.
try { sessionStorage.removeItem('local-msgr-auth'); } catch (e) { /* старая версия хранила сессию во вкладке */ }
if (navigator.locks) navigator.locks.request('local-msgr-auth-leader', () => { sb.auth.startAutoRefresh(); return new Promise(() => {}); });
else sb.auth.startAutoRefresh();
let me = null, regMode = false, currentChat = null, chan = null, qrTimer = null;
const names = {};
const olderBtn = document.getElementById('olderBtn'); // ссылка сохраняется: кнопка переносится при очистке списка сообщений

function txt(el, s) { el.textContent = s; }
// ---------- видимые ошибки: ничего не падает молча ----------
/** 20.10 (Hack Bot): rebind_device переносит ключи, только если прежний сеанс ЗАКРЫТ на сервере. signOut({scope:'local'}) закрывает
 *  текущий сеанс на сервере только с живым access-токеном — с истёкшим запрос /logout отклоняется и сеанс остаётся активным.
 *  Поэтому перед выходом обновляем токен (если он истёк или истекает), затем signOut local. */
async function endSession() {
  try { const { data } = await sb.auth.getSession(); const s = data && data.session;
    if (s && s.expires_at && s.expires_at * 1000 < Date.now() + 60000 && navigator.onLine) await sb.auth.refreshSession().catch(() => {}); } catch (e) { /* */ }
  try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* локальную сессию всё равно чистим */ }
}
window.endSession = endSession;
/** Перед новым входом: сохранённый сеанс ещё действителен — обновляем его (refreshSession) вместо нового входа (true = вход не нужен);
 *  иначе сначала закрываем его (signOut local), потом входим — тогда rebind_device перенесёт ключи. */
async function beforeSignIn() {
  let s = null; try { s = (await sb.auth.getSession()).data.session; } catch (e) { /* */ }
  if (!s) return false;
  try { const { data, error } = await sb.auth.refreshSession(); if (!error && data && data.session) { onSession(data.session); return true; } } catch (e) { /* */ }
  await endSession(); return false;
}
window.beforeSignIn = beforeSignIn;
function showErr(msg) {
  const n = $('notice'); if (!n) { console.warn(msg); return; }
  txt($('noticeText'), msg); n.hidden = false;
}
// снимаем баннер «Нет соединения…», как только запрос прошёл успешно
function clearNetNotice() { const n = $('notice'); if (n && !n.hidden && $('noticeText').textContent.includes('Нет соединения')) n.hidden = true; }
$('noticeClose').onclick = () => { $('notice').hidden = true; };
window.addEventListener('error', e => showErr('Ошибка на странице: ' + ruErr(e.error || e.message) + '. Обновите страницу (Ctrl+F5).'));
window.addEventListener('unhandledrejection', e => showErr('Ошибка: ' + ruErr(e.reason)));

// ---------- русские тексты ошибок ----------
function ruErr(e) {
  const m = String((e && (e.message || e.error_description || e.error)) || e || '');
  const l = m.toLowerCase();
  if (l.includes('e2e required')) return 'Сервер принимает в этом чате только зашифрованные сообщения. Обновите страницу (Ctrl+F5) и попробуйте снова';
  if (l.includes('stale key epoch')) return 'Ключ группы сменился. Попробуйте отправить ещё раз';
  if (l.includes('not a member')) return 'Вы не участник этого чата';
  if (l.includes('rate limit') && l.includes('prekey')) return 'Слишком много запросов ключей шифрования. Подождите минуту';
  if (l.includes('invalid login credentials')) return 'Неверная почта или пароль';
  if (l.includes('failed to fetch') || l.includes('networkerror') || l.includes('network request failed') || l.includes('load failed')) return 'Нет соединения с сервером';
  if (l.includes('email not confirmed')) return 'Почта не подтверждена. Откройте письмо и подтвердите адрес';
  if (l.includes('already registered') || l.includes('already been registered')) return 'Пользователь с такой почтой уже зарегистрирован';
  if (l.includes('password should be at least') || l.includes('weak password')) return 'Пароль слишком короткий или простой (минимум 10 символов)';
  if (l.includes('unable to validate email') || l.includes('invalid format') || l.includes('email address') && l.includes('invalid')) return 'Неверный формат почты';
  if (l.includes('rate limit') || l.includes('too many') || l.includes('429')) return 'Слишком много попыток. Подождите немного и попробуйте снова';
  if (l.includes('too big') || l.includes('too large') || l.includes('payload')) return 'Слишком большой размер (сообщение или файл)';
  if (l.includes('permission denied for function')) return 'Сервер сейчас не даёт сохранить профиль (ошибка прав на сервере). Мы уже знаем о ней — попробуйте позже';
  if (l.includes('pin limit 10')) return 'Можно закрепить не больше 10 чатов';
  if (l.includes('pin limit 50')) return 'В чате уже 50 закреплённых сообщений';
  if (l.includes('only group admins can pin')) return 'Закреплять сообщения в группе могут только владелец и администраторы';
  if (l.includes('reserved')) return 'Этот никнейм зарезервирован';
  if (l.includes('display_name') && l.includes('check')) return 'Недопустимое имя (1–64 символа, без управляющих символов)';
  if (l.includes('bucket not found')) return 'Хранилище аватаров ещё не создано на сервере';
  if (l.includes('duplicate key') && l.includes('username')) return 'Этот никнейм уже занят';
  if (l.includes('duplicate key')) return 'Такая запись уже существует';
  if (l.includes('jwt expired') || l.includes('refresh token')) return 'Сессия истекла, войдите снова';
  if (l.includes('row-level security') || l.includes('permission denied')) return 'Нет прав на это действие';
  if (l.includes('check constraint') || l.includes('violates')) return 'Недопустимое значение';
  if (l.includes('signup') && l.includes('disabled')) return 'Регистрация временно отключена';
  if (l.includes('user not found')) return 'Пользователь не найден';
  return m ? 'Ошибка: ' + m : 'Неизвестная ошибка';
}
function normNick(s) { return String(s || '').trim().replace(/^@+/, '').toLowerCase(); }

// ---------- вход по почте ----------
$('toggleReg').onclick = () => {
  regMode = !regMode;
  $('username').hidden = !regMode;
  $('username').required = regMode;
  $('usernameLabel').hidden = !regMode; $('userHint').hidden = !regMode; $('pwHint').hidden = !regMode;
  $('password').autocomplete = regMode ? 'new-password' : 'current-password';
  $('password').value = ''; $('username').value = ''; txt($('authMsg'), '');
  txt($('loginBtn'), regMode ? 'Зарегистрироваться' : 'Войти');
  txt($('toggleReg'), regMode ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Регистрация');
};
$('loginForm').onsubmit = async e => {
  e.preventDefault();
  const email = $('email').value.trim(), password = $('password').value;
  txt($('authMsg'), '');
  if (!email) return txt($('authMsg'), 'Введите почту');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return txt($('authMsg'), 'Неверный формат почты');
  if (!password) return txt($('authMsg'), 'Введите пароль');
  const btn = $('loginBtn'); btn.disabled = true;
  try {
    if (regMode) {
      const username = normNick($('username').value);
      if (!/^[a-z0-9_]{5,32}$/.test(username)) return txt($('authMsg'), 'От 5 до 32 символов: латиница, цифры и _');
      if (password.length < 10) return txt($('authMsg'), 'Пароль должен быть не короче 10 символов');
      const { error } = await sb.auth.signUp({ email, password, options: { data: { username, display_name: username } } });
      txt($('authMsg'), error ? ruErr(error) : 'Письмо с подтверждением отправлено на почту. Подтвердите и войдите.');
    } else {
      if (await beforeSignIn()) return;
      loginPass = password; // только в памяти этой вкладки (для копии v2), не в localStorage
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) { loginPass = null; txt($('authMsg'), ruErr(error)); }
    }
  } catch (err) { txt($('authMsg'), ruErr(err)); }
  finally { btn.disabled = false; }
};
['email','password','username'].forEach(id => $(id).addEventListener('input', () => txt($('authMsg'), '')));
const NET_ERR = 'Нет соединения с сервером';
// ---------- восстановление пароля ----------
// Ссылка из письма: #access_token=…&type=recovery (account.js ставит сессию) или событие PASSWORD_RECOVERY.
// E2E от пароля не зависит (ключи — в IndexedDB, секрет устройства случайный, резервная копия — по отдельной фразе),
// поэтому после смены пароля обычный вход: e2eStart / rebind_device как всегда, devices_keys не трогаем.
let pwRecovery = /(^|[#&?])type=recovery(&|$)/.test(location.hash.slice(1)) || /(^|[?&])type=recovery(&|$)/.test(location.search.slice(1));
const RESET_REDIRECT = 'https://darkalmas.github.io/messenger-web/local/';
$('forgotBtn').onclick = async () => {
  const email = $('email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { txt($('authMsg'), 'Введите почту, на которую зарегистрирован аккаунт, и нажмите «Забыли пароль?» ещё раз'); $('email').focus(); return; }
  const btn = $('forgotBtn'); btn.disabled = true;
  try {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: RESET_REDIRECT });
    // не сообщаем, есть ли такой аккаунт: одинаковый ответ для любой почты
    if (error && (isNetErr(error) || !navigator.onLine)) txt($('authMsg'), NET_ERR + '. Попробуйте ещё раз.');
    else if (error && (error.status === 429 || /rate|too many/i.test(error.message || ''))) txt($('authMsg'), 'Слишком много запросов. Подождите минуту и попробуйте снова.');
    else txt($('authMsg'), 'Если аккаунт с этой почтой существует, на неё придёт письмо со ссылкой для смены пароля.');
  } catch (e) { txt($('authMsg'), isNetErr(e) ? NET_ERR + '. Попробуйте ещё раз.' : 'Если аккаунт с этой почтой существует, на неё придёт письмо со ссылкой для смены пароля.'); }
  finally { btn.disabled = false; }
};
function showPwRecovery() {
  const d = $('pwDlg'); if (d.open) return;
  $('pwNew1').value = ''; $('pwNew2').value = ''; txt($('pwMsg'), ''); d.showModal(); $('pwNew1').focus();
}
$('pwCancel').onclick = () => { pwRecovery = false; $('pwDlg').close(); };
$('pwForm').onsubmit = async ev => {
  ev.preventDefault();
  const a = $('pwNew1').value, b = $('pwNew2').value;
  if (a.length < 10) return txt($('pwMsg'), 'Пароль должен быть не короче 10 символов');
  if (a !== b) return txt($('pwMsg'), 'Пароли не совпадают');
  $('pwSave').disabled = true;
  try {
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) return txt($('pwMsg'), ruErr(error));
    pwRecovery = false; $('pwDlg').close(); toast('Пароль изменён');
    loginPass = a; saveV2().catch(e => console.warn('backup v2', e)); // перешифровка новым паролем, новая соль
  } catch (e) { txt($('pwMsg'), ruErr(e)); }
  finally { $('pwSave').disabled = false; $('pwNew1').value = ''; $('pwNew2').value = ''; }
};
function netBack() {
  if ($('authMsg').textContent.startsWith(NET_ERR)) txt($('authMsg'), '');
  clearNetNotice();
  if (!me && qrFails && $('qrStatus').textContent.startsWith('Нет соединения')) { qrFails = 0; startQr(); }
}
window.addEventListener('online', netBack);
// Событие online срабатывает не везде: пока висит ошибка сети, раз в 5 с проверяем сервер
setInterval(async () => {
  if (!$('authMsg').textContent.startsWith(NET_ERR) && !$('qrStatus').textContent.startsWith('Нет соединения')) return;
  try { const r = await fetch(`${C.SUPABASE_URL}/auth/v1/health`, { headers: { apikey: C.SUPABASE_KEY }, cache: 'no-store' }); if (r.status < 500) netBack(); } catch (e) { /* всё ещё нет сети */ }
}, 5000);
// Текст подтверждения выхода
const LOGOUT_CONFIRM_30D = 'Выйти из аккаунта? Ключи на этом устройстве сохранятся 30 дней, за это время можно войти снова без потери переписки.';
const LOGOUT_CONFIRM = LOGOUT_CONFIRM_30D; // подтверждено Hack Bot: ключи с секретом устройства хранятся 30 дней
$('logout').onclick = async () => {
  if (!(await askConfirm(LOGOUT_CONFIRM, 'Выйти'))) return;
  // Ключи остаются (локально и на сервере, 30 дней) — при следующем входе rebind_device вернёт это устройство
  await window.pushUnregister?.(); userSignOut = true; await endSession(); };
/** Сеанс этого устройства отозван (revoke_device удаляет ключи сразу): стираем локальные ключи и выходим */
async function doLogout() {
  try { if (E2E && E2E.deviceId()) { await sb.from('devices_keys').delete().eq('device_id', E2E.deviceId()); await E2E.wipe(); } } catch (e) { /* не мешаем выходу */ }
  await window.pushUnregister?.(); userSignOut = true; await endSession(); }

// ---------- вход по QR ----------
const QR_TEXT = 'Откройте приложение на телефоне: меню ⋮ → «Войти на сайте (QR)» и отсканируйте код. Входите только если сами только что открыли этот QR.';
let qrGen = 0, qrFails = 0, qrRetryTimer = null, qrCountdown = null;
async function fn(name, body) {
  const r = await fetch(`${C.SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: C.SUPABASE_KEY, Authorization: `Bearer ${C.SUPABASE_KEY}` },
    body: JSON.stringify(body || {})
  });
  let j = null; try { j = await r.json(); } catch (e) { /* пустой ответ */ }
  if (!r.ok) { const e = new Error((j && (j.error || j.message)) || ('HTTP ' + r.status)); e.status = r.status; e.retryAfter = +r.headers.get('Retry-After') || 0; throw e; }
  if ($('authMsg').textContent.startsWith(NET_ERR)) txt($('authMsg'), '');
  return j;
}
function stopQr() { qrGen++; clearInterval(qrTimer); clearInterval(qrCountdown); clearTimeout(qrRetryTimer); qrTimer = qrCountdown = qrRetryTimer = null; }
function qrState(kind, status, timer) {
  const box = $('qr');
  box.classList.toggle('empty', kind !== 'ok');
  if (kind !== 'ok') { box.innerHTML = ''; const s = document.createElement('span'); txt(s, kind === 'loading' ? 'Загрузка…' : '⚠'); s.setAttribute('aria-hidden', 'true'); box.appendChild(s); }
  txt($('qrStatus'), status); txt($('qrTimerText'), timer || '');
  $('qrRetry').hidden = kind !== 'error';
}
function qrFail(e) {
  if (window.LOCAL_SERVER_UP === false || (e && !e.status)) return qrOffline();
  stopQr();
  qrFails++;
  const MAX = 5;
  const reason = e && e.status === 429 ? 'Слишком много попыток, попробуйте позже.' : (e && e.status ? 'Сервер QR временно недоступен.' : 'Нет соединения с сервером.');
  if (qrFails > MAX) { qrState('error', reason + ' Автоповтор остановлен — нажмите «Обновить QR».'); return; }
  let wait = Math.min(5000 * 2 ** (qrFails - 1), 120000);
  if (e && e.retryAfter) wait = Math.max(wait, e.retryAfter * 1000);
  const until = Date.now() + wait;
  const tick = () => {
    const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    qrState('error', reason + ' Повтор через ' + s + ' с (попытка ' + qrFails + ' из ' + MAX + ').');
  };
  tick(); qrCountdown = setInterval(tick, 1000);
  qrRetryTimer = setTimeout(startQr, wait);
}
$('qrRetry').onclick = () => { qrFails = 0; startQr(); };
function qrOffline() { stopQr(); const box = $('qr'); box.classList.add('empty', 'qr-off'); box.innerHTML = ''; const s = document.createElement('span'); s.className = 'qr-off-txt'; txt(s, 'QR появится, когда сервер будет доступен'); box.appendChild(s); txt($('qrStatus'), ''); txt($('qrTimerText'), ''); $('qrRetry').hidden = true; }
window.addEventListener('local-server', e => { if (me) return; if (e.detail.up) { qrFails = 0; if ($('qr').classList.contains('qr-off') || !qrTimer) startQr(); } else qrOffline(); });
async function startQr() {
  stopQr();
  if (me) return;
  if (window.LOCAL_SERVER_UP === false) return qrOffline();
  $('qr').classList.remove('qr-off');
  const gen = ++qrGen;
  qrState('loading', 'Получаем QR…');
  let q;
  try { q = await fn('qr-create'); } catch (e) { if (gen === qrGen && !me) qrFail(e); return; }
  if (gen !== qrGen || me) return;
  if (!q || !/^[0-9a-f]{64}$/.test(q.token || '')) return qrFail(null);
  qrFails = 0;
  const qr = qrcode(0, 'M'); qr.addData(JSON.stringify({ t: 'local-msgr-login', v: 1, token: q.token })); qr.make();
  const expires = q.expires_at ? new Date(q.expires_at).getTime() : Date.now() + 110000;
  qrState('ok', QR_TEXT);
  $('qr').innerHTML = qr.createSvgTag(5, 0);
  const tick = () => {
    const s = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
    txt($('qrTimerText'), 'Код действует ещё ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
    if (s <= 0 && gen === qrGen) { stopQr(); qrState('error', 'Срок действия QR истёк.'); }
  };
  tick(); qrCountdown = setInterval(tick, 1000);
  let pollFails = 0;
  qrTimer = setInterval(async () => {
    if (Date.now() >= expires || gen !== qrGen) return;
    let p; try { p = await fn('qr-poll', { token: q.token, poll_secret: q.poll_secret }); pollFails = 0; }
    catch (e) { if (gen === qrGen && !me && (e.status === 429 || ++pollFails >= 5)) qrFail(e); return; }
    if (!p || gen !== qrGen) return; // ответ устаревшего опроса не перебивает текущее сообщение (напр. 429)
    if (p.status === 'approved') {
      stopQr(); qrState('loading', 'Вход подтверждён, входим…');
      const s = p.session;
      if (s && s.access_token && s.refresh_token && !(await beforeSignIn())) await sb.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
    } else if (p.status === 'denied') { stopQr(); qrState('error', 'Вход отклонён на телефоне.'); }
    else if (p.status === 'expired') { stopQr(); qrState('error', 'Срок действия QR истёк.'); }
  }, 3000);
}

// ---------- чаты ----------
let lastChats = [], showArchive = false;
const fmtListTime = t => { const d = new Date(t), n = new Date(); if (d.toDateString() === n.toDateString()) return fmtTime(t); if (n - d < 6 * 864e5) return d.toLocaleDateString('ru-RU', { weekday: 'short' }); return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }); };
const isMuted = c => c.muted_until && new Date(c.muted_until) > new Date();
async function loadChats() {
  if (!me) return; const who = me; // вход/выход во время загрузки: не трогаем me после await
  const ul = $('chatList');
  const [{ data, error }, { data: prefs, error: pe }] = await Promise.all([
    sb.rpc('list_chats'),
    sb.from('chat_members').select('chat_id, pinned, muted_until, archived, role').eq('user_id', me.id)
  ]);
  if (!me || me.id !== who.id) return;
  if (error || pe) { if (await window.chatsFromCache?.()) return; if (!navigator.onLine) return; showErr('Не удалось загрузить чаты: ' + ruErr(error || pe)); return; }
  const pm = {}; for (const p of prefs || []) pm[p.chat_id] = p;
  lastChats = (data || []).map(c => ({ id: c.chat_id, kind: c.kind, title: c.kind === 'direct' ? null : c.title, name: c.title, peer: c.peer_id, last_at: c.last_at, last_sender: c.last_sender, last_has_file: c.last_has_file, unread: c.unread, ...(pm[c.chat_id] || {}) }));
  lastChats.sort((x, y) => (y.pinned ? 1 : 0) - (x.pinned ? 1 : 0) || new Date(y.last_at) - new Date(x.last_at));
  window.cacheChats?.(lastChats);
  renderChats();
}
/** Отрисовка списка чатов из lastChats (с сервера или из офлайн-кэша). */
function renderChats() {
  if (!me) return; const ul = $('chatList');
  const archived = lastChats.filter(c => c.archived), visible = lastChats.filter(c => !!c.archived === showArchive);
  ul.innerHTML = '';
  if (showArchive) {
    const li = document.createElement('li'); li.className = 'archive-row'; li.tabIndex = 0;
    const ava = avatarEl({ display_name: '←', id: 'x' }); txt(ava, 'arrow_back'); ava.classList.add('ms');
    const meta = document.createElement('div'); meta.className = 'meta'; const nm = document.createElement('div'); nm.className = 'name'; txt(nm, 'Архив'); const sub = document.createElement('div'); sub.className = 'sub'; txt(sub, 'Назад ко всем чатам'); meta.append(nm, sub);
    li.append(ava, meta); li.onclick = () => { showArchive = false; renderChats(); loadChats(); }; ul.append(li);
  } else if (archived.length) {
    const li = document.createElement('li'); li.className = 'archive-row'; li.tabIndex = 0; li.dataset.archive = '1';
    const ava = avatarEl({ display_name: '🗄', id: 'x' }); txt(ava, 'archive'); ava.classList.add('ms');
    const meta = document.createElement('div'); meta.className = 'meta'; const nm = document.createElement('div'); nm.className = 'name'; txt(nm, 'Архив'); const sub = document.createElement('div'); sub.className = 'sub'; txt(sub, archived.length + ' ' + plural(archived.length, 'чат', 'чата', 'чатов')); meta.append(nm, sub);
    li.append(ava, meta);
    const un = archived.reduce((s, c) => s + (c.unread || 0), 0);
    if (un) { const b = document.createElement('span'); b.className = 'badge muted'; txt(b, String(un)); li.append(b); }
    li.onclick = () => { showArchive = true; renderChats(); loadChats(); }; ul.append(li);
  }
  for (const c of visible) {
    const li = document.createElement('li');
    li.dataset.id = c.id; li.tabIndex = 0;
    const ava = avatarEl(c.peer ? null : { display_name: c.name || '?', id: c.id });
    const meta = document.createElement('div'); meta.className = 'meta';
    const nm = document.createElement('div'); nm.className = 'name'; txt(nm, c.kind === 'direct' ? (c.name || 'Личный чат') : (c.name || 'Группа'));
    const sub = document.createElement('div'); sub.className = 'sub';
    const pkey = c.id + '|' + c.last_at;
    if (c.last_sender && !lastPrev[pkey]) { sub.classList.add('sub-skel'); txt(sub, ' '); } // скелетон, пока расшифровываем / берём из кэша
    else txt(sub, c.last_sender ? '' : 'Нет сообщений');
    sub.dataset.key = c.id + '|' + c.last_at; if (c.last_sender) filePreviewSoon(c, sub);
    meta.append(nm, sub); li.append(ava, meta);
    const side = document.createElement('div'); side.className = 'side-col';
    const tm = document.createElement('span'); tm.className = 'time'; txt(tm, c.last_sender ? fmtListTime(c.last_at) : ''); side.append(tm);
    const fl = document.createElement('span'); fl.className = 'flags';
    if (isMuted(c)) { const s = document.createElement('span'); s.title = 'Без звука'; s.className = 'ms s'; txt(s, 'notifications_off'); fl.append(s); }
    if (c.unread > 0 && !(currentChat && currentChat.id === c.id)) { li.classList.add('unread'); const b = document.createElement('span'); b.className = 'badge' + (isMuted(c) ? ' muted' : ''); txt(b, c.unread > 99 ? '99+' : String(c.unread)); fl.append(b); }
    else if (c.pinned) { const s = document.createElement('span'); s.className = 'pin-flag ms s'; s.title = 'Закреплён'; txt(s, 'push_pin'); fl.append(s); }
    side.append(fl); li.append(side);
    if (currentChat && currentChat.id === c.id) li.classList.add('active');
    li.onclick = () => openChat(c, li);
    li.onkeydown = e => { if (e.key === 'Enter') openChat(c, li); };
    li.oncontextmenu = e => { e.preventDefault(); openMenu(e, chatMenuItems(c)); };
    longPress(li, e => openMenu(e, chatMenuItems(c)));
    ul.appendChild(li);
    if (c.peer) getProfile(c.peer).then(p => { if (p) { txt(nm, displayName(p)); c.name = displayName(p); ava.replaceWith(avatarEl(p)); } else if (!c.name) txt(nm, UNKNOWN_NAME); });
  }
  if (!visible.length) { const li = document.createElement('li'); li.className = 'hint'; txt(li, showArchive ? 'В архиве пусто.' : 'Чатов пока нет. Найдите собеседника по никнейму.'); ul.append(li); }
  if (currentChat) { const cur = lastChats.find(x => x.id === currentChat.id); if (cur) Object.assign(currentChat, { pinned: cur.pinned, muted_until: cur.muted_until, archived: cur.archived, role: cur.role }); }
}
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
function chatMenuItems(c) {
  const muted = isMuted(c), H = 3600e3;
  const mute = until => () => chatPrefs(c, { p_muted_until: until }, 'Уведомления отключены');
  return [
    { t: c.pinned ? 'Открепить' : 'Закрепить', i: 'push_pin', f: () => chatPrefs(c, { p_pinned: !c.pinned }, c.pinned ? 'Чат откреплён' : 'Чат закреплён') },
    ...(muted ? [{ t: 'Включить звук', i: 'notifications', f: () => chatPrefs(c, { p_unmute: true }, 'Звук включён') }] : [
      { t: 'Без звука на 1 час', i: 'notifications_off', f: mute(new Date(Date.now() + H).toISOString()) },
      { t: 'Без звука на 8 часов', i: 'notifications_off', f: mute(new Date(Date.now() + 8 * H).toISOString()) },
      { t: 'Без звука на 1 день', i: 'notifications_off', f: mute(new Date(Date.now() + 24 * H).toISOString()) },
      { t: 'Без звука навсегда', i: 'notifications_off', f: mute('9999-12-31T00:00:00Z') }]),
    { t: c.archived ? 'Вернуть из архива' : 'В архив', i: c.archived ? 'unarchive' : 'archive', f: () => chatPrefs(c, { p_archived: !c.archived }, c.archived ? 'Чат возвращён из архива' : 'Чат перенесён в архив') }
  ];
}
async function chatPrefs(c, args, done) {
  const { error } = await sb.rpc('set_chat_prefs', { p_chat: c.id, ...args });
  if (error) return toastLong(ruErr(error));
  toast(done); await loadChats();
}
let toastT = null;
// ---------- уведомления во вкладке ----------
let inboxChan = null, unseen = 0; const baseTitle = document.title;
const notifOn = () => { try { return localStorage.getItem('local-msgr-notify') !== '0'; } catch { return true; } };
function clearBadge() { if (document.visibilityState === 'visible') { unseen = 0; document.title = baseTitle; } }
function beep() { try { const x = new AudioContext(), o = x.createOscillator(), g = x.createGain(); o.frequency.value = 880; g.gain.value = 0.05; o.connect(g); g.connect(x.destination); o.start(); o.stop(x.currentTime + 0.12); o.onended = () => x.close(); } catch { /* без звука */ } }
/** Новые сообщения во всех моих чатах (RLS отдаёт только их): обновить список и уведомить. */
function watchInbox() {
  if (inboxChan) sb.removeChannel(inboxChan);
  inboxChan = sb.channel('inbox').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => { const m = p.new; if (!m || !me || m.sender_id === me.id) return; if (!currentChat || m.chat_id !== currentChat.id) { loadChatsSoon(); deliverBg(m); } notifyMsg(m).catch(() => {}); }).subscribe();
}
/** Входящее в неоткрытый чат: расшифровали — mark_delivered */
async function deliverBg(m) { try { if (!m.ciphertext) return; const pl = await decryptPayload(m); if (pl && !pl.fail && !pl.other && !pl.pending) { window.cacheMsg?.(m, pl); sendDlv(m); } } catch { /* */ } }
async function notifyMsg(m) {
  if (!notifOn()) return;
  if (currentChat && currentChat.id === m.chat_id && document.visibilityState === 'visible' && !$('app').classList.contains('in-settings')) return;
  const c = lastChats.find(x => x.id === m.chat_id); if (c && isMuted(c)) return;
  if (document.visibilityState !== 'visible') { unseen++; document.title = `(${unseen}) ${baseTitle}`; }
  beep();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  let text = 'Новое сообщение';
  if (m.ciphertext) { const pl = await decryptPayload(m); if (pl && !pl.fail && !pl.other && !pl.pending) text = notifText(pl); }
  let title = c ? (c.title || c.name || 'Мессенджер') : 'Мессенджер';
  if (c && c.peer) { const p = await getProfile(c.peer); if (p) title = displayName(p); }
  const who = m.sender_id ? await nameOf(m.sender_id) : '';
  const body = (who ? who + ': ' : '') + text; // «Имя: текст» (схема Design Bot)
  await window.showNotif(title, body.slice(0, 200), { chat_id: m.chat_id, msg_at: m.created_at });
}
/** Текст уведомления: голосовое/кружок — по схеме Design Bot */
function notifText(pl) {
  const f = pl.f;
  if (f && f.vk === 'voice') return '🎤 Голосовое сообщение ' + fmtDur(f.d);
  if (f && f.vk === 'round') return '⭕ Видеосообщение';
  return pl.t || (f ? (imgMime(f) ? 'Фото' : 'Файл') : 'Новое сообщение');
}
const fmtDur = d => { d = Math.max(0, Math.round(+d || 0)); return Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0'); };
document.addEventListener('visibilitychange', clearBadge);
function toastLong(s) { toast(String(s), 4000); }
function toast(s, ms = 2500) { const t = $('toast'); txt(t, s);
  // в открытом чате — внизу над полем ввода, не поверх пузырей (дизайн 20.10)
  const f = $('sendForm'), r = f && !f.hidden && f.offsetParent !== null ? f.getBoundingClientRect() : null; t.style.bottom = r && r.height ? Math.max(8, Math.round(innerHeight - r.top + 8)) + 'px' : '';
  t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); }

// ---------- контекстное меню (правый клик / долгое нажатие) ----------
/** Контекстное меню. opts.react — строка реакций (пилюля над меню, спецификация Design Bot 20.10), opts.anchor — пузырь:
 *  меню привязано к нему (ниже, а если места нет — выше), фон чата затемнён на 40 %, пузырь остаётся ярким. */
let ctxLift = null;
function openMenu(e, items, opts = {}) {
  const m = $('ctxMenu'); m.textContent = ''; m.classList.toggle('rx', !!opts.react);
  let box = m;
  if (opts.react) {
    const pill = document.createElement('div'); pill.className = 'react-pill'; pill.setAttribute('role', 'group'); pill.setAttribute('aria-label', 'Реакции');
    for (const r of opts.react) {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.className = 'rx-btn' + (r.had ? ' had' : '');
      b.setAttribute('aria-label', (r.had ? 'Убрать реакцию ' : 'Реакция ') + r.e); b.setAttribute('aria-pressed', String(!!r.had)); b.dataset.emoji = r.e; txt(b, r.e);
      b.onclick = () => { b.classList.add('pop'); setTimeout(() => { closeMenu(); Promise.resolve().then(r.f).catch(err => toastLong(err.userMsg || ruErr(err))); }, 120); };
      pill.append(b);
    }
    pill.addEventListener('keydown', ev => { if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return; const bs = [...pill.children], i = bs.indexOf(document.activeElement); if (i < 0) return; ev.preventDefault(); bs[(i + (ev.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length].focus(); });
    box = document.createElement('div'); box.className = 'ctx-actions'; m.append(pill, box);
  }
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; s.setAttribute('role', 'separator'); box.append(s); continue; }
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); if (it.danger) b.className = 'danger-item';
    const ic = document.createElement('span'); ic.setAttribute('aria-hidden', 'true'); ic.className = 'ms'; txt(ic, it.i || ''); const tx = document.createElement('span'); txt(tx, it.t);
    b.append(ic, tx); b.dataset.act = it.t;
    b.onclick = () => { closeMenu(); Promise.resolve().then(it.f).catch(err => toastLong(err.userMsg || ruErr(err))); };
    box.append(b);
  }
  m.style.left = '0px'; m.style.top = '0px'; m.hidden = false; // меряем без сжатия у края экрана
  const r = { width: m.offsetWidth, height: m.offsetHeight }, W = innerWidth, H = innerHeight, P = 6;
  let x, y;
  if (opts.anchor && opts.anchor.isConnected) {
    const a = opts.anchor.getBoundingClientRect();
    x = opts.anchor.classList.contains('mine') ? a.right - r.width : a.left;
    y = a.bottom + 8 + r.height <= H - P ? a.bottom + 8 : a.top - 8 - r.height >= P ? a.top - 8 - r.height : H - P - r.height;
    if (ctxLift) ctxLift.classList.remove('ctx-lift'); ctxLift = opts.anchor; ctxLift.classList.add('ctx-lift'); $('messages').classList.add('ctx-dim');
  } else { const pt = e.touches ? e.touches[0] : e; x = pt.clientX || 20; y = pt.clientY || 20; }
  m.style.left = Math.max(P, Math.min(x, W - r.width - P)) + 'px';
  m.style.top = Math.max(P, Math.min(y, H - r.height - P)) + 'px';
  const first = m.querySelector('button'); if (first) first.focus({ preventScroll: true });
}
function closeMenu() { $('ctxMenu').hidden = true; if (ctxLift) { ctxLift.classList.remove('ctx-lift'); ctxLift = null; } $('messages').classList.remove('ctx-dim'); }
document.addEventListener('pointerdown', e => { if (!$('ctxMenu').hidden && !$('ctxMenu').contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); if (!$('composeBar').hidden) cancelCompose(); } });
window.addEventListener('resize', closeMenu);
$('messages').addEventListener('scroll', closeMenu, { passive: true });
// Долгое нажатие на тач-экране (iOS не шлёт contextmenu)
function longPress(el, fn) {
  let t = null, sx = 0, sy = 0;
  el.addEventListener('touchstart', e => { const p = e.touches[0]; sx = p.clientX; sy = p.clientY; t = setTimeout(() => { t = null; el.dataset.lp = '1'; fn({ clientX: sx, clientY: sy }); }, 500); }, { passive: true });
  const stop = () => { clearTimeout(t); t = null; };
  el.addEventListener('touchmove', e => { const p = e.touches[0]; if (Math.abs(p.clientX - sx) > 10 || Math.abs(p.clientY - sy) > 10) stop(); }, { passive: true });
  el.addEventListener('touchend', e => { stop(); if (el.dataset.lp) { delete el.dataset.lp; e.preventDefault(); } });
  el.addEventListener('contextmenu', e => { if (e.pointerType === 'touch' || el.dataset.lp) e.preventDefault(); });
}
let loadChatsT = null;
function loadChatsSoon() { clearTimeout(loadChatsT); loadChatsT = setTimeout(() => loadChats().catch(() => {}), 400); }

// ---------- профили и аватары ----------
const profiles = {}; let profileExt = null; // null — неизвестно, true/false — есть ли колонки bio/avatar_* на сервере
async function getProfile(id, fresh) {
  if (!fresh && profiles[id]) return profiles[id];
  const { data, error } = await sb.from('profiles').select('*').eq('id', id).maybeSingle();
  if (error) { console.warn('profile', error); return profiles[id] || null; }
  if (data) { profileExt = 'bio' in data && 'avatar_url' in data && 'avatar_color' in data && 'avatar_letter' in data; profiles[id] = data; }
  return data || profiles[id] || null; // RLS может скрыть чужой профиль без общего чата — берём кэш (например, из find_user)
}
/** Профиль из find_user — в кэш, чтобы шапка/имя работали до появления общего чата */
function seedProfile(p) { if (p && p.id) profiles[p.id] = { ...(profiles[p.id] || {}), ...p }; }
// Профиль не загрузился (удалён/скрыт RLS): «Пользователь», серый аватар с иконкой person, без статуса
const UNKNOWN_NAME = 'Пользователь';
function displayName(p) { return p ? (p.display_name || '@' + p.username) : UNKNOWN_NAME; }
async function nameOf(id) { const p = await getProfile(id); return p ? displayName(p) : UNKNOWN_NAME; }
const COLORS = ['#5c6bc0', '#26a69a', '#ef6c00', '#ab47bc', '#42a5f5', '#ec407a', '#7cb342', '#8d6e63']; // как Ui.AVATAR в Android (docs/design)
function colorFor(p) {
  if (p && /^#[0-9a-fA-F]{6}$/.test(p.avatar_color || '')) return p.avatar_color;
  const id = String(p && p.id || ''); let h = 0; for (let i = 0; i < id.length; i++) h += id.charCodeAt(i);
  return COLORS[h % COLORS.length]; // docs/design/avatar_color.md: палитра = цвета выбора в профиле, сумма UTF-16 кодов id mod 8
}
const avaUrls = {}; // путь в storage → { url, exp } (подписанная ссылка)
function avatarEl(p, cls) {
  const s = document.createElement('span'); s.className = 'ava' + (cls ? ' ' + cls : '');
  fillAvatar(s, p); return s;
}
function avatarLetter(p) {
  const a = p && String(p.avatar_letter || '').trim(); if (a) return a;
  const n = p && String(p.display_name || '').trim() || p && String(p.username || '').replace(/^@+/, '').trim() || '';
  return (Array.from(n)[0] || '?').toUpperCase();
}
function fillAvatar(s, p) {
  s.textContent = ''; s.hidden = false; s.classList.toggle('unknown', !p);
  if (!p) { s.style.background = ''; s.dataset.path = ''; txt(s, 'person'); return; }
  s.style.background = colorFor(p);
  txt(s, avatarLetter(p));
  const path = p && p.avatar_url;
  s.dataset.path = path || '';
  if (path) avatarSigned(path).then(u => {
    if (!u || s.dataset.path !== path) return;
    const img = new Image(); img.alt = ''; img.referrerPolicy = 'no-referrer';
    img.onload = () => { if (s.dataset.path === path && !s.querySelector('img')) s.append(img); };
    img.src = u;
  });
}
async function avatarSigned(path) {
  const c = avaUrls[path]; if (c && c.exp > Date.now()) return c.url;
  const { data, error } = await sb.storage.from('avatars').createSignedUrl(path, 3600);
  if (error || !data) return null;
  avaUrls[path] = { url: data.signedUrl, exp: Date.now() + 3300 * 1000 };
  return data.signedUrl;
}
// Профили в Realtime: смена имени или аватара у собеседника видна сразу
function profileChanged(p) {
  if (!p || !p.id) return; profiles[p.id] = { ...(profiles[p.id] || {}), ...p };
  if (p.id === me.id) refreshMe().catch(() => {});
  if (currentChat && peerId === p.id) { txt($('chatTitle'), displayName(profiles[p.id])); fillAvatar($('chatAva'), profiles[p.id]); }
  loadChatsSoon();
}
let profChan = null;
function watchProfiles() {
  if (profChan) sb.removeChannel(profChan);
  watchInbox();
  profChan = sb.channel('profiles').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, x => profileChanged(x.new)).subscribe();
}

let chatHasE2e = false, peerId = null;
// ---------- сквозное шифрование (e2e.js + libsignal WASM) ----------
let E2E = null, e2eErr = null;
const e2eMod = import('./e2e.js?v=20261023local11').then(m => { m.init(sb); return (E2E = m); });
// Проверка устройства: при входе, восстановлении сессии, раз в 10 минут и при возврате на вкладку
let devCheckAt = 0;
async function deviceCheck(force) {
  if (!me || (!force && Date.now() - devCheckAt < 60000)) return;
  devCheckAt = Date.now();
  const { error } = await sb.auth.getUser();
  if (error && (error.status === 401 || error.status === 403 || /session|jwt|not found/i.test(error.message))) {
    // Ключи не стираем: если сеанс просто истёк, сервер хранит их 30 дней и при входе rebind_device вернёт устройство
    await sessionEnded(error); return;
  }
  if (error) return; // нет сети — проверим позже
  if (!(await e2eStart())) return;
  try { await E2E.checkDevice(); }
  catch (e) { if (e && e.name === 'IdentityMismatch') { e2eErr = e; showIdMismatch(e); } else showErr('Не удалось проверить ключи шифрования этого устройства: ' + ruErr(e)); }
}
setInterval(() => deviceCheck(true), 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') deviceCheck(false); });
window.addEventListener('focus', () => deviceCheck(false));
let e2eBusyAt = 0;
/** Экран «Ключи этого устройства не совпадают с сервером» (Design Bot). Без секретов: только код ошибки и id устройства. */
function showIdMismatch(e) {
  if (document.getElementById('idmm')) return;
  const el = document.createElement('div'); el.id = 'idmm'; el.className = 'idmm'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-labelledby', 'idmmTitle');
  el.innerHTML = '<div class="idmm-card"><span class="ms idmm-ic" aria-hidden="true">gpp_bad</span><h2 id="idmmTitle">Ключи этого устройства не совпадают с сервером</h2>'
    + '<p class="idmm-text">Чтобы защитить переписку, отправка остановлена. Войдите заново.</p>'
    + '<button type="button" id="idmmGo">Выйти и войти заново</button><button type="button" id="idmmMore" class="link" aria-expanded="false">Подробнее</button>'
    + '<div id="idmmBox" class="idmm-box" hidden><pre id="idmmInfo" class="idmm-info"></pre><button type="button" id="idmmCopy" class="link"><span class="ms s" aria-hidden="true">content_copy</span> Копировать</button>'
    + '<button type="button" id="idmmAll" class="link danger-link">Выйти на всех устройствах</button><p id="idmmAllHint" class="idmm-hint"></p></div></div>';
  document.body.append(el);
  txt($('idmmInfo'), 'Код ошибки: ' + ((e && e.code) || 'E2E_IDENTITY_MISMATCH') + '\nУстройство: ' + ((e && e.deviceId) || (E2E && E2E.deviceId()) || '—') + '\nОтпечаток ключа в браузере: ' + ((e && e.localFp) || '—') + '\nОтпечаток ключа на сервере: ' + ((e && e.serverFp) || '—') + '\nСборка: ' + ((window.BUILD && window.BUILD.commit) || '—'));
  $('idmmCopy').onclick = () => navigator.clipboard.writeText($('idmmInfo').textContent).then(() => toast('Скопировано'), () => toast('Не удалось скопировать'));
  $('idmmMore').onclick = () => { const i = $('idmmBox'); i.hidden = !i.hidden; $('idmmMore').setAttribute('aria-expanded', String(!i.hidden)); };
  const out = async scope => {
    $('idmmGo').disabled = $('idmmAll').disabled = true;
    try { if (E2E && E2E.resetForRelogin) await E2E.resetForRelogin(); } catch (err) { console.warn('resetForRelogin', err); }
    await window.pushUnregister?.(); userSignOut = true; try { await sb.auth.signOut({ scope }); } catch (err) { /* локальную сессию всё равно чистим */ }
    el.remove();
  };
  $('idmmGo').onclick = () => out('local');
  $('idmmAll').onclick = async () => { if (await askConfirm('Все устройства выйдут из аккаунта', 'Выйти везде')) await out('global'); };
  // Вход через Google (пароля нет) — другая подсказка
  sb.auth.getSession().then(({ data }) => {
    const u = data && data.session && data.session.user, am = (u && u.app_metadata) || {};
    const prov = Array.isArray(am.providers) ? am.providers : [am.provider].filter(Boolean);
    const google = prov.includes('google') && !prov.includes('email');
    txt($('idmmAllHint'), google ? 'Если вы не входили с других устройств, нажмите и проверьте безопасность аккаунта Google' : 'Если вы не входили с других устройств, нажмите и смените пароль');
  }).catch(() => txt($('idmmAllHint'), 'Если вы не входили с других устройств, нажмите и смените пароль'));
  $('idmmGo').focus();
}
// rebind_device отказал: прежний сеанс браузера ещё активен на сервере. Новое устройство — только по явному выбору.
let rbAsked = false;
async function rebindBlockedAsk(e) {
  showErr(e.userMsg + ' Обновите страницу через минуту или завершите прежний сеанс в «Устройствах» на другом устройстве.');
  if (rbAsked) return; rbAsked = true;
  const nw = await askConfirm('Прежний сеанс этого браузера ещё не закрыт на сервере, поэтому ключи шифрования нельзя перенести на новый вход.\n\nМожно подождать и обновить страницу или зарегистрировать это устройство как новое. Новое устройство не сможет прочитать сообщения, отправленные до входа, и появится в списке «Устройства».', 'Новое устройство', 'Подождать');
  if (!nw) return;
  try { const m = await e2eMod; await m.resetForRelogin(); e2eErr = null; if (await e2eStart()) { $('notice').hidden = true; toast('Устройство зарегистрировано'); } } catch (x) { console.warn(x); }
}
async function e2eStart() {
  if (e2eErr && e2eErr.name === 'LockBusy' && Date.now() - e2eBusyAt < 15000) return false;
  try { const m = await e2eMod; await m.ensureReady(); e2eErr = null; }
  catch (e) { e2eErr = e; if (e && e.name === 'IdentityMismatch') { showIdMismatch(e); return false; }
    if (e && e.name === 'RebindBlocked') { rebindBlockedAsk(e); return false; }
    // нет сети (страница открыта офлайн, ключи ещё не прочитаны с сервера) — не ошибка: без баннера, повторим при связи
    if (e && e.name !== 'KeysLost' && (!navigator.onLine || isNetErr(e) || /нет соединения|failed to fetch|load failed/i.test(e.message || ''))) { console.warn('E2E: ждём сеть', e && e.message); return false; } if (e && e.name === 'LockBusy') { e2eBusyAt = Date.now(); retryBusySoon(); } console.warn('E2E недоступно:', e); showErr(e && e.userMsg ? e.userMsg : 'Шифрование на этом устройстве не запустилось: ' + ruErr(e) + '. Отправка сообщений невозможна, обновите страницу (Ctrl+F5).'); }
  return E2E && !e2eErr;
}
const sentOwn = {}; // подпись шифротекста → открытый текст (своё сообщение приходит по Realtime раньше, чем сохранится копия)
const ctSig = c => c && (c.sk || Object.values(c).map(x => x && x.b).sort()[0]);
function parsePayload(pt) {
  let o; try { o = JSON.parse(pt); } catch { return { t: pt }; }
  if (!o || typeof o !== 'object') return { t: String(pt) };
  // caption — подпись к вложению (отдельное поле того же payload; старые клиенты его игнорируют). t — показываемый текст
  let f = o.f && typeof o.f === 'object' ? o.f : null;
  { const k = f && window.mediaKind && window.mediaKind(f); if (k && f.vk !== k) f = { ...f, vk: k }; } // вид: f.vk из payload, без него — по имени voice_/round_
  const cap = f && typeof o.caption === 'string' ? o.caption.slice(0, 4000) : '';
  return { t: (o.t || '') || cap, t0: o.t || '', caption: cap, f, fw: typeof o.fw === 'string' ? o.fw.slice(0, 64) : null };
}
const DECRYPT_WAIT = 8000;
// Шифрование занято другой вкладкой: через 16 с перерисовываем пузыри, оставшиеся «Расшифровка…»
let busyT = null;
function retryBusySoon() {
  if (busyT) return;
  busyT = setTimeout(() => { busyT = null; for (const [id, d] of Object.entries(msgEls)) { const x = msgData[id]; if (x && !x.pl && d.dataset.pending === '1') renderSafe(x.m, d); } }, 16000);
}
/** Расшифровка с ограничением ожидания: не успели — {pending}, сообщение показывается «Расшифровка…» и перерисуется по готовности. */
function decryptPayloadT(m, d) {
  const p = decryptPayload(m);
  return Promise.race([p, new Promise(r => setTimeout(() => r({ pending: true }), DECRYPT_WAIT))]).then(pl => {
    if (pl && pl.pending) p.then(() => { if (d.isConnected && msgEls[m.id] === d) renderMsg(m, d); });
    return pl;
  });
}
async function decryptPayload(m) {
  const sig = ctSig(m.ciphertext);
  if (sig && sentOwn[sig]) return parsePayload(sentOwn[sig]);
  try { const q = await (await e2eMod).peek(m); if (q && q.other) return { other: true }; if (q && q.pt) return parsePayload(q.pt); } catch { /* обычный путь */ }
  if (!(await e2eStart())) return e2eErr && e2eErr.name === 'LockBusy' ? { pending: true, busy: true } : null;
  try {
    if (m.ciphertext.sk !== undefined) {
      try { return parsePayload(await E2E.decryptGroup(m.chat_id, m)); }
      catch (e) { if (!(e instanceof E2E.NoKey)) throw e; await E2E.receive(m.chat_id); return parsePayload(await E2E.decryptGroup(m.chat_id, m)); }
    }
    const pt = await E2E.decryptDM(m);
    if (pt == null) { console.info('decrypt', m.id, 'нет конверта для устройства', E2E.deviceId(), 'есть:', Object.keys(m.ciphertext || {}).map(k => k.slice(0, 8)).join(',')); return { other: true }; }
    return parsePayload(pt);
  } catch (e) { console.error('Не удалось расшифровать', m.id, (e && e.message) || e); return { fail: true, why: (e && e.message) || String(e) }; }
}
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : n >= 1024 ? Math.round(n / 1024) + ' КБ' : n + ' Б';
const msgEls = {};
const fmtTime = t => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
async function renderMsg(m, d) {
  const mine = m.sender_id === me.id;
  d.className = 'msg' + (mine ? ' mine' : '');
  d.dataset.at = m.created_at; d.dataset.sender = m.sender_id || '';
  d.textContent = '';
  const small = document.createElement('small');
  if (!mine && currentChat && currentChat.kind !== 'direct') txt(small, m.sender_id ? await nameOf(m.sender_id) : 'удалённый аккаунт');
  const b = document.createElement('span'); b.className = 'body';
  const foot = document.createElement('div'); foot.className = 'foot';
  if (small.textContent) d.append(small);
  d.append(b);
  let pl = null;
  const lock = document.createElement('span');
  if (m.ciphertext) {
    chatHasE2e = true;
    b.className = 'body e2e'; txt(b, 'Расшифровка…'); // пока ждём расшифровку — не пустой пузырь
    pl = await decryptPayloadT(m, d);
    if (pl && !pl.other && !pl.fail && !pl.pending) {
      notePreview(m, pl);
      b.className = 'body'; txt(b, pl.t); if (!pl.t) b.hidden = true;
      window.cacheMsg?.(m, pl);
      if (!mine) { sendDlv(m); seenIO.observe(d); }
      if (pl.f && (pl.f.vk === 'voice' || pl.f.vk === 'round') && window.mediaEl) { d.querySelectorAll(':scope > .round-wrap, :scope > .round-v, :scope > .voice').forEach(x => x.remove()); /* повторная отрисовка (эхо своего, расшифровка) — без второго круга */ d.insertBefore(mediaEl(pl.f, m, !mine), b); d.classList.add(pl.f.vk === 'round' ? 'round-msg' : 'voice-msg'); }
      else if (pl.f) {
        const fm = window.fileMediaEl && window.fileMediaEl(pl.f, () => downloadFile(pl.f, !mine).catch(e => toastLong(e.userMsg || ruErr(e))));
        if (fm) { d.querySelectorAll(':scope > .afile, :scope > .vfile').forEach(x => x.remove()); d.insertBefore(fm, b); d.classList.add(fm.classList.contains('vfile') ? 'vfile-msg' : 'voice-msg'); }
        const fb = fileRow(pl.f, !mine);
        const pv = fm ? null : imagePreview(pl.f, pl.t, !mine, bad => { pv.replaceWith(bad ? brokenRow(pl.f) : fb); d.classList.remove('has-img', 'img-only'); });
        if (pv) { d.insertBefore(pv, b); d.classList.add('has-img'); if (!pl.t) d.classList.add('img-only'); } // подпись под картинкой; скачать — в просмотре
        else if (!fm) d.append(fb);
      }
      lock.className = 'lock'; lock.title = 'Сквозное шифрование'; txt(lock, '🔒');
    } else if (pl && pl.other) {
      // зашифровано для устройств, бывших до входа здесь: нейтральная серая строка, без «одной галочки навсегда»
      b.className = 'body e2e other-dev'; txt(b, 'Отправлено до входа на этом устройстве'); d.classList.add('other-dev'); lock.className = 'lock'; txt(lock, '\u{1F512}');
      if (!mine) { sendDlv(m); seenIO.observe(d); } // сообщение дошло до этого устройства (прочитать нельзя, но не «висит»)
    } else { b.className = 'body e2e'; if (pl && pl.fail && earlySkipped()) { b.className = 'body e2e early'; txt(b, 'Ранние сообщения недоступны'); lock.className = 'lock'; txt(lock, ''); } else txt(b, pl && pl.pending ? 'Расшифровка…' : pl && pl.other ? 'Зашифровано для другого устройства' : pl && pl.fail ? 'Не удалось расшифровать' : 'Зашифровано, откройте в приложении'); lock.className = 'lock'; txt(lock, '🔒'); }
  } else {
    txt(b, m.body);
    lock.className = 'noe2e'; lock.title = 'Старое сообщение без шифрования'; txt(lock, '⚠ не зашифровано');
  }
  msgData[m.id] = { m, pl: pl && !pl.other && !pl.fail && !pl.pending ? pl : null };
  if (pl && pl.pending) d.dataset.pending = '1'; else delete d.dataset.pending;
  if (m.forwarded) { const f = document.createElement('span'); f.className = 'fwd'; txt(f, '↪ Переслано' + (pl && pl.fw ? ' от ' + pl.fw : '')); d.insertBefore(f, small.textContent ? small.nextSibling : d.firstChild); }
  if (m.reply_to) {
    const q = document.createElement('span'); q.className = 'reply'; q.dataset.to = m.reply_to;
    fillQuote(q, m.reply_to);
    q.onclick = ev => { ev.stopPropagation(); jumpTo(m.reply_to); };
    d.insertBefore(q, b);
  }
  if (pins.includes(m.id)) { const p = document.createElement('span'); p.className = 'pinned-ico ms s'; p.title = 'Закреплено'; txt(p, 'push_pin'); foot.append(p); }
  if (m.edited_at) { const e = document.createElement('span'); txt(e, 'изм.'); foot.append(e); }
  const tm = document.createElement('time'); tm.dateTime = m.created_at; txt(tm, fmtTime(m.created_at));
  foot.append(lock, tm);
  if (mine) { const t = document.createElement('span'); t.className = 'ticks'; foot.append(t); delete d.dataset.state; }
  d.append(foot);
  paintReacts(m.id, d);
  if (mine) paintTicks(d);
  if (!d.dataset.wired) { d.dataset.wired = '1'; wireMsg(d); }
  // цитаты, ссылающиеся на это сообщение, обновляем
  document.querySelectorAll(`#messages .reply[data-to="${m.id}"]`).forEach(q => fillQuote(q, m.id));
  sepsSoon();
}
const msgData = {}; // id → { m, pl }
// ---------- реакции (таблица reactions: message_id, user_id, emoji — как в приложении) ----------
const REACT_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const reacts = {}; // id → [{user_id, emoji}]
function paintReacts(id, d) {
  d = d || msgEls[id]; if (!d) return;
  const foot = d.querySelector(':scope > .foot'); if (!foot) return;
  let box = foot.querySelector(':scope > .reacts'); const list = reacts[id] || [];
  if (!list.length) { if (box) box.remove(); return; }
  if (!box) { box = document.createElement('span'); box.className = 'reacts'; foot.prepend(box); } // в строке времени, слева
  box.textContent = '';
  const by = new Map();
  for (const r of list) { const x = by.get(r.emoji) || { n: 0, mine: false }; x.n++; if (r.user_id === me.id) x.mine = true; by.set(r.emoji, x); }
  for (const [e, x] of by) {
    const c = document.createElement('button'); c.type = 'button'; c.className = 'react' + (x.mine ? ' mine' : '');
    c.title = x.mine ? 'Убрать реакцию' : 'Поставить реакцию'; txt(c, e + (x.n > 1 ? ' ' + x.n : ''));
    c.onclick = ev => { ev.stopPropagation(); toggleReact(id, e); };
    box.append(c);
  }
}
async function loadReacts(ids) {
  ids = ids.filter(Boolean);
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    const { data, error } = await sb.from('reactions').select('message_id,user_id,emoji').in('message_id', part).order('created_at', { ascending: true });
    if (error) { console.warn('reactions', error.message); return; }
    for (const id of part) reacts[id] = [];
    for (const r of data || []) addReact(r, false);
    for (const id of part) paintReacts(id);
  }
}
let reactTimer = 0;
function reloadReactsSoon() { clearTimeout(reactTimer); reactTimer = setTimeout(() => loadReacts(Object.keys(msgEls)), 300); }
async function toggleReact(id, e) {
  const had = (reacts[id] || []).some(r => r.user_id === me.id && r.emoji === e);
  const q = had ? sb.from('reactions').delete().eq('message_id', id).eq('user_id', me.id).eq('emoji', e)
                : sb.from('reactions').insert({ message_id: id, user_id: me.id, emoji: e });
  const { error } = await q;
  if (error) return toast('Не удалось изменить реакцию: ' + ruErr(error));
  if (had) { reacts[id] = (reacts[id] || []).filter(r => !(r.user_id === me.id && r.emoji === e)); paintReacts(id); }
  else addReact({ message_id: id, user_id: me.id, emoji: e });
}
// Ключ реакции — (message_id, user_id, emoji) (PK таблицы, id нет); дубликат из Realtime и из ответа REST отбрасываем
function addReact(r, paint = true) {
  if (!r || !r.message_id) return;
  const list = reacts[r.message_id] = reacts[r.message_id] || [];
  if (list.some(x => x.user_id === r.user_id && x.emoji === r.emoji)) return;
  list.push({ user_id: r.user_id, emoji: r.emoji });
  if (paint) paintReacts(r.message_id);
}
function previewOf(id) {
  const x = msgData[id]; if (!x) return 'Сообщение';
  if (!x.pl) return x.m.ciphertext ? '🔒 Зашифрованное сообщение' : (x.m.body || 'Сообщение');
  if (x.pl.f && (x.pl.f.vk === 'voice' || x.pl.f.vk === 'round')) return prevOf(x.pl).text;
  return x.pl.t || (x.pl.f ? '📎 ' + (x.pl.f.n || 'файл') : 'Сообщение');
}
function fillQuote(q, id) {
  q.textContent = ''; const x = msgData[id];
  const b = document.createElement('b'); txt(b, x ? (x.m.sender_id === me.id ? 'Вы' : (profiles[x.m.sender_id] ? displayName(profiles[x.m.sender_id]) : '…')) : 'Ответ');
  const s = document.createElement('span'); txt(s, x ? previewOf(id) : 'сообщение');
  q.append(b, s);
}
function jumpTo(id) {
  const d = msgEls[id];
  if (!d) return toast('Сообщение не загружено — нажмите «Загрузить более ранние сообщения»');
  d.scrollIntoView({ block: 'center', behavior: 'smooth' });
  d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 1200);
}
function msgMenuItems(id) {
  const x = msgData[id]; if (!x) return [];
  const m = x.m, mine = m.sender_id === me.id, items = [];
  // порядок Design Bot 20.10: Ответить, Копировать текст, Изменить, Закрепить, — , Удалить у всех (Переслать — перед разделителем)
  items.push({ t: 'Ответить', i: 'reply', f: () => startReply(id) });
  if (x.pl && x.pl.t) items.push({ t: 'Копировать текст', i: 'content_copy', f: () => navigator.clipboard.writeText(x.pl.t).then(() => toast('Текст скопирован')) });
  if (mine && x.pl && !x.pl.f && m.ciphertext) items.push({ t: 'Изменить', i: 'edit', f: () => startEdit(id) });
  if (canPin()) items.push(pins.includes(id) ? { t: 'Открепить', i: 'push_pin', f: () => pinMsg(id, false) } : { t: 'Закрепить', i: 'push_pin', f: () => pinMsg(id, true) });
  if (x.pl) items.push({ t: 'Переслать', i: 'forward', f: () => openForward(id) });
  if (mine) items.push('-', { t: 'Удалить у всех', i: 'delete', danger: true, f: () => deleteMsg(id) });
  return items;
}
function msgReacts(id) { return REACT_EMOJI.map(e => ({ e, had: (reacts[id] || []).some(r => r.user_id === me.id && r.emoji === e), f: () => toggleReact(id, e) })); }
function wireMsg(d) {
  const id = () => d.dataset.id;
  d.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(e, msgMenuItems(id()), { react: msgReacts(id()), anchor: d }); });
  d.addEventListener('dblclick', e => { if (e.target.closest('button')) return; window.getSelection && window.getSelection().removeAllRanges(); startReply(id()); });
  longPress(d, e => openMenu(e, msgMenuItems(id()), { react: msgReacts(id()), anchor: d }));
  // свайп влево — ответить
  let sx = 0, sy = 0, dx = 0, on = false;
  d.addEventListener('touchstart', e => { const p = e.touches[0]; sx = p.clientX; sy = p.clientY; dx = 0; on = true; }, { passive: true });
  d.addEventListener('touchmove', e => { if (!on) return; const p = e.touches[0]; dx = p.clientX - sx; if (Math.abs(p.clientY - sy) > 30) { on = false; d.style.transform = ''; return; } if (dx < 0) d.style.transform = `translateX(${Math.max(dx, -80)}px)`; }, { passive: true });
  d.addEventListener('touchend', () => { d.style.transform = ''; if (on && dx < -60) startReply(id()); on = false; });
}

// ---------- ответ и правка в строке ввода ----------
let replyTo = null, editing = null;
function startReply(id) {
  if (!msgData[id]) return;
  editing = null; replyTo = id;
  const x = msgData[id];
  txt($('composeIcon'), 'reply'); txt($('composeTitle'), 'В ответ ' + (x.m.sender_id === me.id ? 'себе' : (profiles[x.m.sender_id] ? displayName(profiles[x.m.sender_id]) : ''))); txt($('composePreview'), previewOf(id));
  $('composeBar').hidden = false; $('msgInput').focus();
}
function startEdit(id) {
  const x = msgData[id]; if (!x || !x.pl) return;
  replyTo = null; editing = id;
  txt($('composeIcon'), 'edit'); txt($('composeTitle'), 'Редактирование'); txt($('composePreview'), x.pl.t);
  $('composeBar').hidden = false; $('msgInput').value = x.pl.t; $('msgInput').focus();
}
function cancelCompose() { if (editing) $('msgInput').value = ''; replyTo = null; editing = null; $('composeBar').hidden = true; }
$('composeCancel').onclick = cancelCompose;

// ---------- удаление у всех (автор, через RLS messages delete own) ----------
async function deleteMsg(id) {
  const x = msgData[id]; if (!x) return;
  if (!confirm('Удалить сообщение у всех участников чата? Отменить будет нельзя.')) return;
  const { error } = await sb.from('messages').delete().eq('id', id);
  if (error) throw error;
  // вложение удаляем и у нерасшифрованного сообщения — по attachment_path строки
  const f = x.pl && x.pl.f, ap = (f && f.p) || x.m.attachment_path;
  if (ap) await sb.storage.from(f && /^[a-z0-9-]{3,63}$/.test(f.b || '') ? f.b : 'chat-files').remove([ap]).catch(() => {});
  removeMsgEl(id); toast('Сообщение удалено'); loadChatsSoon();
}
function removeMsgEl(id) {
  const d = msgEls[id]; if (!d) return;
  d.remove(); delete msgEls[id]; delete msgData[id];
  if (replyTo === id || editing === id) cancelCompose();
  if (pins.includes(id)) loadPins();
  sepsSoon();
}

// ---------- разделители дат ----------
let sepT = null;
function sepsSoon() { clearTimeout(sepT); sepT = setTimeout(redoSeps, 30); }
function dayLabel(t) {
  const d = new Date(t), n = new Date(), y = new Date(n - 864e5);
  if (d.toDateString() === n.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', d.getFullYear() === n.getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
}
function redoSeps() {
  const box = $('messages'); box.querySelectorAll('.date-sep').forEach(x => x.remove());
  let prev = null;
  for (const d of box.querySelectorAll('.msg')) {
    const k = new Date(d.dataset.at).toDateString();
    if (k !== prev) { const s = document.createElement('div'); s.className = 'date-sep'; txt(s, dayLabel(d.dataset.at)); d.before(s); prev = k; }
  }
  // хвостик — у последнего сообщения в серии одного отправителя
  const all = [...box.querySelectorAll('.msg')];
  all.forEach((d, i) => { const n = all[i + 1]; d.classList.toggle('tail', !n || n.dataset.sender !== d.dataset.sender || n.previousElementSibling !== d); });
}

// ---------- кнопка «вниз» со счётчиком новых ----------
let jumpUnread = 0;
const farFromBottom = () => { const b = $('messages'); return b.scrollHeight - b.scrollTop - b.clientHeight > 300; };
function paintJump() { $('jumpBtn').hidden = !currentChat || !farFromBottom(); const c = $('jumpCount'); c.hidden = !jumpUnread; txt(c, jumpUnread > 99 ? '99+' : String(jumpUnread)); }
$('messages').addEventListener('scroll', () => { if (!farFromBottom()) jumpUnread = 0; paintJump(); }, { passive: true });
$('jumpBtn').onclick = () => { const b = $('messages'); b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' }); jumpUnread = 0; paintJump(); };

// ---------- закреплённые сообщения (chat_pins + pin_message) ----------
let pins = [], pinIdx = 0;
function canPin() { return currentChat && (currentChat.kind === 'direct' || ['owner', 'admin'].includes(currentChat.role)); }
async function loadPins() {
  const c = currentChat; if (!c) return;
  const { data, error } = await sb.from('chat_pins').select('message_id, pinned_at').eq('chat_id', c.id).order('pinned_at', { ascending: false });
  if (error || currentChat !== c) return;
  const old = pins; pins = (data || []).map(r => r.message_id);
  if (pinIdx >= pins.length) pinIdx = 0;
  paintPinBar();
  for (const id of new Set([...old, ...pins])) if (msgData[id]) renderMsg(msgData[id].m, msgEls[id]);
}
function paintPinBar() {
  const bar = $('pinBar'); bar.hidden = !pins.length; if (!pins.length) return;
  const id = pins[pinIdx];
  txt($('pinLabel'), 'Закреплённое сообщение' + (pins.length > 1 ? ' #' + (pins.length - pinIdx) : ''));
  txt($('pinPreview'), msgData[id] ? previewOf(id) : 'сообщение не загружено');
  $('unpinBtn').hidden = !canPin();
}
$('pinOpen').onclick = () => { if (!pins.length) return; jumpTo(pins[pinIdx]); pinIdx = (pinIdx + 1) % pins.length; paintPinBar(); };
$('unpinBtn').onclick = () => { if (pins.length && confirm('Открепить это сообщение?')) pinMsg(pins[pinIdx], false).catch(e => toastLong(ruErr(e))); };
async function pinMsg(id, on) {
  const { error } = await sb.rpc('pin_message', { p_msg: id, p_pin: on });
  if (error) throw error;
  toast(on ? 'Сообщение закреплено' : 'Сообщение откреплено'); await loadPins();
}

// ---------- пересылка: текст/файл заново шифруются для выбранного чата ----------
let fwdId = null;
function openForward(id) {
  fwdId = id; $('fwdSearch').value = ''; paintFwd(); $('fwdDlg').showModal(); $('fwdSearch').focus();
}
function paintFwd() {
  const ul = $('fwdList'), q = $('fwdSearch').value.trim().toLowerCase(); ul.textContent = '';
  for (const c of lastChats) {
    const name = c.name || (c.kind === 'direct' ? 'Личный чат' : 'Группа');
    if (q && !name.toLowerCase().includes(q)) continue;
    const li = document.createElement('li'); li.dataset.id = c.id; li.tabIndex = 0;
    const p = c.peer ? profiles[c.peer] : { display_name: name, id: c.id };
    const s = document.createElement('span'); txt(s, p && c.peer ? displayName(p) : name);
    li.append(avatarEl(p || { display_name: name, id: c.id }, 'sm'), s);
    li.onclick = () => doForward(c); li.onkeydown = e => { if (e.key === 'Enter') doForward(c); };
    ul.append(li);
  }
}
$('fwdSearch').oninput = paintFwd;
$('fwdClose').onclick = () => $('fwdDlg').close();
async function doForward(target) {
  const x = msgData[fwdId]; $('fwdDlg').close(); if (!x || !x.pl) return;
  try {
    toast('Пересылаем…');
    // Имя автора оригинала — только внутри зашифрованного payload; шифротекст и файловые ключи не переиспользуются
    const fw = x.pl.fw || (x.m.sender_id === me.id ? displayName(profiles[me.id]) : displayName(profiles[x.m.sender_id]));
    if (x.pl.f) {
      const plain = await fetchFilePlain(x.pl.f); // расшифровали — и ниже заново шифруем новым ключом AES и для нового чата
      const vk = window.mediaKind ? window.mediaKind(x.pl.f) : null; // пересылка сохраняет вид (голосовое/кружок), длительность и волну — внутри шифротекста
      await sendFile(target, new File([plain], x.pl.f.n || 'file', { type: x.pl.f.m || 'application/octet-stream' }), { forwarded: true }, x.pl.caption || x.pl.t || '', fw, vk ? { media: { vk, d: x.pl.f.d, ...(Array.isArray(x.pl.f.w) ? { w: x.pl.f.w.slice(0, 64) } : {}) } } : undefined);
    } else await sendPayload(target, JSON.stringify({ v: 1, t: x.pl.t, fw }), { forwarded: true });
    toast('Переслано');
    if (!currentChat || currentChat.id !== target.id) loadChatsSoon();
  } catch (e) { toastLong(e.userMsg || ruErr(e)); }
}

// ---------- «в сети» / «был(а) в сети» и «печатает…» ----------
// «в сети» берётся ТОЛЬКО из get_last_seen (сервер применяет last_seen_visibility и блокировки; null → «был(а) недавно»). Не выводить онлайн из presence/broadcast/typing.
let lastSeen = null, typingUntil = 0, typingWho = null, lastTypingSent = 0;
async function touchPresence() { if (me && document.visibilityState === 'visible') await sb.rpc('touch_presence').then(() => {}, () => {}); }
setInterval(touchPresence, 60000);
document.addEventListener('visibilitychange', touchPresence);
const MON_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
// Спецификация Design Bot; время локальное. now — для проверок.
function seenText(t, now = new Date()) {
  if (!t) return 'был(а) недавно';
  const d = new Date(t); if (isNaN(d)) return 'был(а) недавно';
  const ms = now - d, p2 = x => String(x).padStart(2, '0'), hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
  if (ms < 120000) return 'в сети'; // в т.ч. небольшой сдвиг часов «в будущее»
  if (ms < 3600000) return 'был(а) ' + Math.floor(ms / 60000) + ' мин. назад';
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = day(now), dd = day(d);
  if (dd === today) return 'был(а) в ' + hm;
  if (dd === day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'был(а) вчера в ' + hm;
  if (d.getFullYear() === now.getFullYear()) return 'был(а) ' + d.getDate() + ' ' + MON_SHORT[d.getMonth()] + ' в ' + hm;
  return 'был(а) ' + p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear();
}
let peerUnknown = false; // профиль собеседника не загрузился — без «был(а)»
async function loadLastSeen() {
  const c = currentChat; if (!c || c.kind !== 'direct' || !peerId) return paintSub();
  const { data, error } = await sb.rpc('get_last_seen', { p_user: peerId });
  if (currentChat !== c) return;
  lastSeen = error ? undefined : data; paintSub(); paintAllTicks();
}
function paintSub() {
  const s = $('chatSub'); s.className = '';
  if (!currentChat) return txt(s, '');
  if (Date.now() < typingUntil) { s.className = 'typing'; txt(s, (currentChat.kind === 'direct' ? '' : (typingWho ? typingWho + ' ' : '')) + 'печатает'); const d = document.createElement('span'); d.className = 'typing-dots'; d.setAttribute('aria-hidden', 'true'); d.append(document.createElement('i'), document.createElement('i'), document.createElement('i')); s.append(d); s.setAttribute('aria-label', s.textContent + '…'); return; }
  s.removeAttribute('aria-label');
  if (window.connState && window.connState()) { s.className = 'conn'; return txt(s, window.connState() === 'offline' ? 'ожидание сети…' : 'соединение…'); } // без связи «в сети» не показываем
  if (currentChat.kind !== 'direct') return txt(s, 'группа');
  if (lastSeen === undefined || peerUnknown) return txt(s, '');
  const t = seenText(lastSeen); if (t === 'в сети') s.className = 'online'; txt(s, t);
}
setInterval(() => { if (currentChat && document.visibilityState === 'visible') loadLastSeen(); }, 60000);
setInterval(() => { if (currentChat && typingUntil && Date.now() >= typingUntil) { typingUntil = 0; paintSub(); loadLastSeen(); } }, 250);
$('msgInput').addEventListener('input', () => {
  if (!chan || !currentChat || editing || !$('msgInput').value) return;
  if (Date.now() - lastTypingSent < 3000) return; // не чаще раза в 3 с
  lastTypingSent = Date.now();
  chan.send({ type: 'broadcast', event: 'typing', payload: { u: me.id } }).catch(() => {});
});
function onTyping(p) {
  if (!p || !p.u || p.u === me.id) return;
  if (p.stop) { typingUntil = 0; paintSub(); return loadLastSeen(); }
  if (!typingUntil) loadLastSeen(); // свежий статус заранее: после «печатает» сразу верный текст
  typingUntil = Date.now() + 5000; typingWho = profiles[p.u] ? displayName(profiles[p.u]) : null; paintSub();
}

// ---------- кто видит «был(а) в сети» ----------
function paintSeenSeg(v) { try { localStorage.setItem('local-msgr-seen', v); } catch { /* */ } txt($('seenVal'), { everyone: 'Все', contacts: 'Мои контакты', nobody: 'Никто' }[v] || ''); document.querySelectorAll('#seenSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v))); }
document.querySelectorAll('#seenSeg button').forEach(b => {
  b.onclick = async () => {
    const { error } = await sb.from('profiles').update({ last_seen_visibility: b.dataset.v }).eq('id', me.id);
    if (error) return txt($('seenMsg'), ruErr(error));
    txt($('seenMsg'), ''); clearNetNotice();
    profiles[me.id] = { ...(profiles[me.id] || {}), last_seen_visibility: b.dataset.v }; paintSeenSeg(b.dataset.v); toast('Сохранено');
  };
});

/** Пузырь-заглушка сразу в ленте (до расшифровки). */
function placeMsg(m, put) {
  const d = document.createElement('div'); d.dataset.id = m.id; msgEls[m.id] = d;
  d.className = 'msg' + (me && m.sender_id === me.id ? ' mine' : ''); d.dataset.at = m.created_at; d.dataset.sender = m.sender_id || '';
  const b = document.createElement('span'); b.className = 'body e2e'; txt(b, m.ciphertext ? 'Расшифровка…' : (m.body || '')); d.append(b);
  if (m.ciphertext) d.classList.add('skel'); // скелетон до расшифровки
  put(d); return d;
}
async function renderSafe(m, d) {
  try { await renderMsg(m, d); }
  catch (e) { console.error('renderMsg', m.id, e); d.className = 'msg' + (me && m.sender_id === me.id ? ' mine' : ''); d.textContent = ''; const b = document.createElement('span'); b.className = 'body e2e'; txt(b, 'Не удалось показать сообщение'); d.append(b); }
}
async function addMsg(m) {
  if (msgEls[m.id]) return updMsg(m);
  const d = document.createElement('div'); d.dataset.id = m.id; msgEls[m.id] = d;
  const box = $('messages'); box.appendChild(d);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  await renderSafe(m, d);
  if (nearBottom || m.sender_id === me.id) box.scrollTop = box.scrollHeight;
  else if (m.sender_id !== me.id && m.created_at > (msgData.__openedAt || '')) { jumpUnread++; }
  paintJump();
}
async function updMsg(m) { const d = msgEls[m.id]; if (d) await renderSafe(m, d); }
async function openChat(c, li) {
  currentChat = c; readState = {}; for (const k in dlvState) delete dlvState[k]; lastMarked = 0; pins = []; pinIdx = 0; jumpUnread = 0; lastSeen = undefined; typingUntil = 0; cancelCompose(); closeMenu();
  for (const k of Object.keys(msgData)) delete msgData[k];
  for (const k of Object.keys(reacts)) delete reacts[k];
  msgData.__openedAt = new Date().toISOString();
  $('pinBar').hidden = true; $('jumpBtn').hidden = true; $('chatMenuBtn').hidden = false; txt($('chatSub'), '');
  document.querySelectorAll('#chatList li').forEach(x => x.classList.remove('active')); li.classList.add('active');
  const badge = li.querySelector('.badge'); if (badge) badge.remove();
  $('app').classList.add('in-chat'); $('app').classList.remove('in-settings');
  if (location.hash !== '#chat') navPush({ v: 'chat' }, '', '#chat');
  chatHasE2e = false; peerId = c.peer || null; peerUnknown = false;
  for (const k of Object.keys(msgEls)) delete msgEls[k]; onScreen.clear(); seenIO.disconnect();
  txt($('chatTitle'), li.querySelector('.name') ? li.querySelector('.name').textContent : li.textContent);
  $('chatAva').hidden = true;
  for (const k of Object.keys(imgUrls)) { Promise.resolve(imgUrls[k]).then(u => URL.revokeObjectURL(u)).catch(() => {}); delete imgUrls[k]; } // освобождаем blob: прошлого чата
  $('sendForm').hidden = false; $('messages').innerHTML = ''; $('messages').append(olderBtn); $('safetyBtn').hidden = true;
  if (c.kind === 'direct') {
    if (!peerId) { const { data: pm } = await sb.from('chat_members').select('user_id').eq('chat_id', c.id).neq('user_id', me.id).limit(1).maybeSingle(); peerId = pm ? pm.user_id : null; }
    if (peerId) getProfile(peerId).then(p => {
      if (currentChat !== c) return;
      peerUnknown = !p; if (!p && !c.name) txt($('chatTitle'), UNKNOWN_NAME);
      if (p) txt($('chatTitle'), displayName(p)); fillAvatar($('chatAva'), p); paintSub();
    });
    // Не ждём шифрование перед загрузкой сообщений: зависшая инициализация не должна прятать чат
    if (peerId) e2eStart().then(ok => ok && E2E.peerHasKeys(peerId)).then(h => { if (currentChat === c) { peerKeys = !!h; paintKeyEvents(); } })
      .catch(e => { if (currentChat === c) { console.warn('claim_prekeys', e); toast('Не удалось получить ключи собеседника: ' + ruErr(e)); } });
  } else {
    fillAvatar($('chatAva'), { display_name: c.title || '?', id: c.id });
    e2eStart().then(ok => ok && E2E.receive(c.id)).catch(e => showErr('Не удалось получить ключи группы: ' + ruErr(e)));
  }
  if (currentChat !== c) return;
  if (chan) sb.removeChannel(chan);
  // Приватный канал: broadcast «печатает» доступен только участникам чата (политики realtime.messages на сервере)
  await rtAuth();
  if (currentChat !== c) return;
  subChat(c);
  if (!c.role && navigator.onLine) { const { data: r } = await sb.from('chat_members').select('role').eq('chat_id', c.id).eq('user_id', me.id).maybeSingle(); if (r) c.role = r.role; }
  loadPins(); loadLastSeen(); paintSub();
  $('messages').prepend(olderBtn); olderBtn.hidden = true; oldestAt = null;
  const cached = window.cachedMsgs ? await window.cachedMsgs(c.id) : [];
  if (currentChat !== c) return;
  for (const m of cached) if (!msgEls[m.id]) renderSafe(m, placeMsg(m, d => $('messages').appendChild(d)));
  if (cached.length) $('messages').scrollTop = $('messages').scrollHeight; else window.showSkeletons?.();
  let { data, error } = navigator.onLine ? await sb.from('messages').select('*').eq('chat_id', c.id).order('created_at', { ascending: false }).limit(PAGE) : { data: null, error: new Error('Нет соединения с сервером') };
  window.hideSkeletons?.();
  if (error) { if (cached.length) { data = null; if (navigator.onLine && !(window.connState && window.connState() === 'offline') && !Object.values(outbox).some(j => j.chat && j.chat.id === c.id)) toast('Нет соединения — показаны сохранённые сообщения'); } else if (navigator.onLine) showErr('Не удалось загрузить сообщения: ' + ruErr(error)); }
  if (currentChat !== c) return;
  if (error && (cached.length || !navigator.onLine)) { reAddQueued(c); return; }
  // Сначала все пузыри сразу (заглушка «Расшифровка…»), потом расшифровка по порядку: зависшее шифрование не прячет сообщения
  const list = (data || []).reverse(), els = list.map(m => { const o = msgEls[m.id]; if (o) { $('messages').appendChild(o); return o; } return placeMsg(m, d => $('messages').appendChild(d)); });
  $('messages').scrollTop = $('messages').scrollHeight;
  (async () => {
    for (let i = 0; i < list.length; i++) { if (currentChat !== c) return; if (msgEls[list[i].id] === els[i]) await renderSafe(list[i], els[i]); }
    if (currentChat === c) { paintKeyEvents(); $('messages').scrollTop = $('messages').scrollHeight; redoSeps(); paintPinBar(); }
  })();
  if (data && data.length) oldestAt = data[0].created_at;
  olderBtn.hidden = !(data && data.length === PAGE);
  if (!(data || []).length) { const p = document.createElement('p'); p.className = 'empty-state'; txt(p, 'Сообщений пока нет. Всё, что вы напишете, будет зашифровано сквозным шифрованием.'); $('messages').append(p); }
  reAddQueued(c); // очередь (в т.ч. после перезагрузки) и только что отправленные из неё
  await loadReadState();
  loadReacts((data || []).map(m => m.id));
  paintPinBar(); redoSeps();
  maybeMarkRead();
}
const PAGE = 200; let oldestAt = null;
olderBtn.onclick = async () => {
  const c = currentChat, btn = olderBtn, box = $('messages'); if (!c || !oldestAt) return;
  btn.disabled = true; txt(btn, 'Загрузка…');
  try {
    const { data, error } = await sb.from('messages').select('*').eq('chat_id', c.id).lt('created_at', oldestAt).order('created_at', { ascending: false }).limit(PAGE);
    if (error) throw error;
    if (currentChat !== c) return;
    const h0 = box.scrollHeight, top0 = box.scrollTop;
    const todo = [];
    for (const m of data || []) { // от новых к старым, каждое вставляем сразу после кнопки
      if (msgEls[m.id]) continue;
      todo.push([m, placeMsg(m, d => btn.after(d))]);
    }
    for (const [m, d] of todo) await renderSafe(m, d);
    loadReacts((data || []).map(m => m.id));
    redoSeps(); box.scrollTop = top0 + (box.scrollHeight - h0); // остаёмся на том же месте
    paintPinBar();
    if (data && data.length) oldestAt = data[data.length - 1].created_at;
    btn.hidden = !(data && data.length === PAGE);
  } catch (e) { toastLong('Не удалось загрузить более ранние сообщения: ' + ruErr(e)); }
  finally { btn.disabled = false; txt(btn, 'Загрузить более ранние сообщения'); }
};
/** Подписка на приватный канал чата. При ошибке (часто — протухший токен) один раз обновляем сессию, setAuth и подписываемся заново, без бесконечных повторов со старым токеном. */
function subChat(c, retried = false) {
  if (chan) sb.removeChannel(chan);
  chan = sb.channel('chat-' + c.id, { config: { private: true } })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${c.id}` }, p => onIncoming(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `chat_id=eq.${c.id}` }, p => updMsg(p.new))
    // Живые отметки прочтения (работает, когда chat_members добавлен в публикацию Realtime; до этого — опрос раз в 8 с)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_members', filter: `chat_id=eq.${c.id}` }, p => { if (p.new && p.new.user_id !== me.id) { E2E && E2E.devicesStale && E2E.devicesStale(p.new.user_id); onReadBc({ u: p.new.user_id, at: p.new.last_read_at }); if (p.new.last_delivered_at) onDlvBc({ u: p.new.user_id, at: p.new.last_delivered_at }); } })
    // DELETE в Realtime не фильтруется по колонкам — приходит только id, сверяем с загруженными
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, p => { if (p.old && p.old.id && msgEls[p.old.id]) { removeMsgEl(p.old.id); loadChatsSoon(); } })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_pins', filter: `chat_id=eq.${c.id}` }, () => loadPins())
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chat_pins' }, p => { if (!p.old || !p.old.chat_id || p.old.chat_id === c.id) loadPins(); })
    // reactions без chat_id: INSERT сверяем с загруженными сообщениями, DELETE приходит только с id — перечитываем
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reactions' }, p => { const r = p.new; if (r && msgEls[r.message_id]) addReact(r); })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'reactions' }, () => reloadReactsSoon())
    .on('broadcast', { event: 'typing' }, p => onTyping(p.payload))
    .on('broadcast', { event: 'read' }, p => onReadBc(p.payload))
    .on('broadcast', { event: 'dlv' }, p => onDlvBc(p.payload))
    .subscribe((st, err) => {
      if (st !== 'CHANNEL_ERROR' && st !== 'TIMED_OUT') return;
      console.warn('realtime', st, err);
      if (currentChat !== c) return;
      if (retried || sessionGone) { if (chan) { sb.removeChannel(chan); chan = null; } if (!sessionGone) toast('Нет связи с сервером обновлений. Откройте чат заново.'); return; }
      rtRecover().then(ok => { if (ok && currentChat === c && me) subChat(c, true); });
    });
}
async function onIncoming(m) {
  const e = $('messages').querySelector('.empty-state'); if (e) e.remove();
  await addMsg(m);
  if (m.sender_id !== me.id && typingUntil) { typingUntil = 0; paintSub(); loadLastSeen(); }
  if (m.sender_id !== me.id) { readState[m.sender_id] = m.created_at > (readState[m.sender_id] || '') ? m.created_at : readState[m.sender_id]; paintAllTicks(); maybeMarkRead(); }
  loadChatsSoon();
}

// ---------- прочтение: ✓ отправлено, ✓✓ — собеседник (в группе — все участники) действительно прочитал ----------
let readState = {}; // user_id → last_read_at остальных участников
async function loadReadState() {
  const c = currentChat; if (!c) return;
  const { data, error } = await sb.rpc('chat_read_state', { p_chat: c.id });
  if (error || currentChat !== c) return;
  const st = {}; for (const r of data || []) if (r.user_id !== me.id) { st[r.user_id] = r.last_read_at; if (r.last_delivered_at) onDlvBc({ u: r.user_id, at: r.last_delivered_at }); }
  readState = st; paintAllTicks();
}
function isRead(at) {
  const others = Object.values(readState);
  return others.length > 0 && others.every(r => r && new Date(r) >= new Date(at));
}
// «доставлено» = chat_members.last_delivered_at собеседника (rpc mark_delivered, Hack Bot 20.10)
const dlvState = {}; // user_id → время последнего сообщения, которое его клиент получил и расшифровал (broadcast «dlv»)
function isDelivered(at) {
  return Object.values(dlvState).some(x => x && new Date(x) >= new Date(at));
  if (!currentChat || currentChat.kind !== 'direct' || !lastSeen) return false;
  if (lastSeen === 'online') return true; if (isNaN(Date.parse(lastSeen))) return false;
  const ls = new Date(lastSeen).getTime(); // собеседник был в сети после сообщения или в сети сейчас (≤2 мин) — доставлено
  return ls >= new Date(at).getTime() || (Date.now() - ls < 120000 && new Date(at).getTime() <= Date.now() + 5000);
}
function paintTicks(d) {
  const t = d.querySelector('.ticks'); if (!t) return;
  const st = d.dataset.state;
  const [ic, title, cls] = st === 'sending' ? ['schedule', 'Отправляется', 'sending'] : st === 'failed' ? ['error', 'Не отправлено — нажмите', 'failed']
    : isRead(d.dataset.at) ? ['done_all', 'Прочитано', 'read'] : isDelivered(d.dataset.at) ? ['done_all', 'Доставлено', 'delivered'] : ['done', 'Отправлено', 'sent'];
  if (t.dataset.k === cls && !st) return; t.dataset.k = cls; // без лишних перерисовок — только смена класса (transition 150 мс)
  t.className = 'ticks ms ' + cls; txt(t, ic); t.title = title; t.setAttribute('aria-label', title);
  if (st === 'failed') { t.setAttribute('role', 'button'); t.tabIndex = 0; t.onclick = ev => { ev.stopPropagation(); outMenu(ev, d.dataset.id); }; d.onclick = ev => { if (d.dataset.state === 'failed') { ev.stopPropagation(); outMenu(ev, d.dataset.id); } }; }
  else { t.removeAttribute('role'); t.removeAttribute('tabindex'); t.onclick = null; d.onclick = null; }
}
/** Собеседник прочитал (broadcast из приватного канала чата): только участник, время только вперёд */
function onDlvBc(p) {
  if (!p || !me || p.u === me.id || typeof p.u !== 'string' || isNaN(Date.parse(p.at))) return;
  if (new Date(p.at) > new Date(Date.now() + 60000)) return;
  if (!dlvState[p.u] || new Date(p.at) > new Date(dlvState[p.u])) { dlvState[p.u] = p.at; paintAllTicks(); }
}
/** «Получил и расшифровал»: rpc mark_delivered, троттлинг 400 мс на чат, время только растёт */
const dlvQ = {}, dlvDone = {};
function sendDlv(m) {
  if (!me || !m || m.sender_id === me.id || !m.chat_id || !m.created_at) return;
  const c = m.chat_id; if ((dlvDone[c] || '') >= m.created_at || (dlvQ[c] && dlvQ[c].at >= m.created_at)) return;
  if (dlvQ[c]) { dlvQ[c].at = m.created_at; return; }
  dlvQ[c] = { at: m.created_at };
  setTimeout(async () => { const at = dlvQ[c].at; delete dlvQ[c]; const { error } = await sb.rpc('mark_delivered', { p_chat: c, p_upto: at }); if (!error && at > (dlvDone[c] || '')) dlvDone[c] = at; }, 400);
}
function onReadBc(p) {
  if (!p || !me || p.u === me.id || typeof p.u !== 'string' || isNaN(Date.parse(p.at))) return;
  if (new Date(p.at) > new Date(Date.now() + 60000)) return; // не верим «прочитанному из будущего»
  if (!readState[p.u] || new Date(p.at) > new Date(readState[p.u])) { readState[p.u] = p.at; paintAllTicks(); }
}
function paintAllTicks() { document.querySelectorAll('#messages .msg.mine').forEach(paintTicks); }
setInterval(() => { if (currentChat && document.visibilityState === 'visible') loadReadState(); }, 8000);

// mark_read — только когда чат действительно на экране: вкладка видима, окно в фокусе, панель чата показана
let markT = null, lastMarked = 0;
const onScreen = new Set();
const seenIO = new IntersectionObserver(es => { for (const e of es) { if (e.isIntersecting) onScreen.add(e.target); else onScreen.delete(e.target); } maybeMarkRead(); }, { root: document.getElementById('messages'), threshold: 0.6 });
function chatVisible() {
  if (!currentChat || document.visibilityState !== 'visible' || !document.hasFocus()) return false;
  const p = $('chatPane'); return p.offsetParent !== null && p.getClientRects().length > 0 && !$('app').classList.contains('in-settings');
}
function maybeMarkRead() {
  clearTimeout(markT);
  markT = setTimeout(async () => {
    if (!chatVisible()) return;
    // прочитано = пузырь на экране (IntersectionObserver) и вкладка активна; в фоне не синеет
    const newest = [...onScreen].filter(x => x.isConnected && x.dataset.at).sort((x, y) => x.dataset.at < y.dataset.at ? -1 : 1).pop();
    if (!newest || new Date(newest.dataset.at).getTime() <= lastMarked) return;
    const c = currentChat;
    const upto = newest.dataset.at;
    const { error } = await sb.rpc('mark_read', { p_chat: c.id, p_upto: upto });
    if (error) console.warn('mark_read', error);
    if (!error && currentChat === c) { lastMarked = new Date(newest.dataset.at).getTime(); if (chan) chan.send({ type: 'broadcast', event: 'read', payload: { u: me.id, at: upto } }).catch(() => {}); } // галочки у собеседника — сразу (broadcast), не ждём publication chat_members
  }, 400); // троттлинг 300–500 мс
}
document.addEventListener('visibilitychange', maybeMarkRead);
window.addEventListener('focus', maybeMarkRead);
$('messages').addEventListener('scroll', maybeMarkRead, { passive: true });
$('sendForm').onsubmit = async e => {
  e.preventDefault();
  const body = $('msgInput').value.trim(); if (!body) return;
  // Раньше при currentChat = null (чат на экране, но состояние сброшено) отправка молча ничего не делала
  if (!currentChat) { toast('Чат не открыт — текст остался в поле ввода', 3000); return; }
  const chat = currentChat, rt = replyTo, ed = editing;
  if (ed) {
    const x = msgData[ed];
    if (!x || body === x.pl.t) return cancelCompose();
    $('msgInput').value = ''; cancelCompose();
    try { await editEncrypted(x.m, JSON.stringify({ v: 1, t: body })); }
    catch (err) { toastLong(err && err.userMsg ? err.userMsg : ruErr(err)); }
    return;
  }
  $('msgInput').value = ''; cancelCompose();
  outSend({ chat, kind: 'text', text: body, extra: rt ? { reply_to: rt } : {} });
  if (chan) chan.send({ type: 'broadcast', event: 'typing', payload: { u: me.id, stop: true } }).catch(() => {}); lastTypingSent = 0;
};
// ---------- исходящие: пузырь сразу, статус schedule → check → done_all → done_all (синий); ошибка → error, меню «Повторить»/«Удалить» ----------
const outbox = {}; // id → задание
// Отправленные из очереди за последние 2 мин: чат мог перерисоваться, пока шла отправка (запрос списка ушёл раньше вставки),
// и сообщение пропадало у отправителя, хотя у получателя есть. Сверка по id сообщения (id задаёт клиент) — без дублей.
const recentSent = {};
function reAddQueued(c) {
  for (const j of Object.values(outbox)) if (j.chat && j.chat.id === c.id && !msgEls[j.id]) { try { outBubble(j); } catch (e) { console.error('outBubble', e); } }
  for (const [id, x] of Object.entries(recentSent)) {
    if (Date.now() - x.t > 120000) { delete recentSent[id]; continue; }
    if (x.job.chat.id !== c.id || msgEls[id]) continue;
    try { outBubble(x.job); const el = msgEls[id]; if (el) { delete el.dataset.state; if (x.at) el.dataset.at = x.at; paintTicks(el); } } catch (e) { console.error('outBubble', e); }
  }
  window.paintNetLine?.();
}
function outBubble(job) {
  const d = document.createElement('div'); d.dataset.id = job.id; msgEls[job.id] = d;
  d.className = 'msg mine'; d.dataset.at = job.at || new Date().toISOString(); d.dataset.sender = me.id; d.dataset.state = job.hold ? 'failed' : 'sending';
  if (job.kind === 'file' && /^image\/(jpeg|png|gif|webp)$/.test(job.file.type || '')) {
    // локальное превью исходного файла (из выбранного File, на сервер не уходит)
    const pv = document.createElement('div'); pv.className = 'img-prev'; const im = document.createElement('img'); im.alt = safeName(job.file.name);
    im.src = job.localUrl = URL.createObjectURL(job.file); pv.append(im); d.append(pv); d.classList.add('has-img'); if (!job.caption) d.classList.add('img-only');
  }
  // голосовое/кружок в очереди или с ошибкой — сразу настоящий плеер (▶, волна, длительность) или круглое превью из записанного Blob;
  // текстовая подпись «🎤 …» — только для списка чатов и уведомлений
  const isMedia = job.media && (job.media.vk === 'voice' || job.media.vk === 'round') && window.mediaEl;
  if (isMedia) { job.localUrl = job.localUrl || URL.createObjectURL(job.file); d.append(mediaEl({ ...job.media, m: (job.file.type || '').split(';')[0], p: 'local:' + job.id, local: job.localUrl }, { id: job.id }, false)); d.classList.add(job.media.vk === 'round' ? 'round-msg' : 'voice-msg'); }
  const b = document.createElement('span'); b.className = 'body'; txt(b, job.kind === 'text' ? job.text : isMedia ? '' : (job.caption || (d.classList.contains('has-img') ? '' : job.file.name))); if (!b.textContent) b.hidden = true; d.append(b);
  const foot = document.createElement('div'); foot.className = 'foot';
  const tm = document.createElement('time'); txt(tm, fmtTime(d.dataset.at)); const t = document.createElement('span'); t.className = 'ticks';
  foot.append(tm, t); d.append(foot);
  const box = $('messages'); const e = box.querySelector('.empty-state'); if (e) e.remove();
  box.appendChild(d); box.scrollTop = box.scrollHeight; paintTicks(d); return d;
}
// один запуск на сообщение одновременно (онлайн-событие, переподключение и автоповтор не отправляют дважды)
async function outRun(job, fresh) {
  if (job.running) return false; job.running = true;
  try { return await outRun0(job, fresh); } finally { job.running = false; }
}
async function outRun0(job, fresh) {
  delete job.hold; // явный повтор пользователем
  const d = msgEls[job.id]; if (d) { d.dataset.state = 'sending'; paintTicks(d); }
  if (!navigator.onLine || (fresh && window.connState && window.connState() === 'offline')) { job.waitNet = true; window.paintNetLine?.(); window.saveOutbox?.(); return false; } // без сети (известно) — сразу в очередь, без попытки
  try {
    // повтор: если сообщение уже на сервере — просто отмечаем отправленным, ничего не загружаем заново
    const had = job.tries ? await onServer(job.id).catch(() => null) : null;
    job.tries = (job.tries || 0) + 1;
    const extra = { ...job.extra, id: job.id };
    const row = had || await sendDeadline(job.kind === 'text' ? sendPayload(job.chat, JSON.stringify({ v: 1, t: job.text }), extra) : sendFile(job.chat, job.file, extra, job.caption, undefined, job), job);
    delete outbox[job.id]; job.waitNet = false; job.flushing = false; recentSent[job.id] = { job, at: row && row.created_at, t: Date.now() }; window.saveOutbox?.(); window.paintNetLine?.();
    const el = msgEls[job.id];
    if (el) { delete el.dataset.state; if (row && row.created_at) el.dataset.at = row.created_at; paintTicks(el); } // время сервера, не часы клиента
    return true;
  } catch (err) {
    console.warn('send failed', job.id, err);
    const el = msgEls[job.id];
    // нет сети — не «ошибка», а ожидание: часы остаются, отправим при появлении связи (media.js flushOutbox)
    const netish = isNetErr(err) || /Нет связи с сервером|нет ответа сервера|failed to fetch/i.test((err && (err.userMsg || err.message)) || '');
    if (!navigator.onLine || (window.connState && window.connState() === 'offline')) { job.waitNet = true; if (el && el.dataset.state) { el.dataset.state = 'sending'; paintTicks(el); } window.paintNetLine?.(); if (navigator.onLine) setTimeout(() => window.flushOutbox?.(), 3000); return false; } // сеть формально есть — пробуем снова, не ждём переподключения
    if (job.auto > 0 && netish) { // автоповтор после возврата сети: связь ещё поднимается — ждём, не краснеем
      job.auto--; if (el && el.dataset.state) { el.dataset.state = 'sending'; paintTicks(el); }
      setTimeout(() => { if (outbox[job.id]) outRun(job); }, navigator.onLine ? 2000 : 3000); return false;
    }
    job.waitNet = false; job.flushing = false;
    if (el && el.dataset.state) { el.dataset.state = 'failed'; paintTicks(el); }
    window.saveOutbox?.(); // после перезагрузки — красное с «Повторить», без автоотправки
    if (!job.toasted && !(err && err.quiet)) { job.toasted = true; toast(err && err.userMsg ? err.userMsg : 'Не отправлено: ' + ruErr(err), 3000); } // тост один раз на сообщение
    return false;
  }
}
function outSend(job) {
  job.id = crypto.randomUUID(); job.at = new Date().toISOString(); outbox[job.id] = job; window.saveOutbox?.();
  try { if (currentChat && currentChat.id === job.chat.id) outBubble(job); } catch (e) { console.error('outBubble', e); }
  return outRun(job, true);
}
// Отправка никогда не висит молча: общий предел на всё задание (шифрование, ключи, загрузка, вставка)
let SEND_TEXT_MS = 45000, SEND_FILE_MS = 180000; // let: тесты уменьшают предел
function sendDeadline(p, job) {
  let t; const lim = job.kind === 'text' ? SEND_TEXT_MS : SEND_FILE_MS;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(userErr('Сообщение не отправлено: нет ответа сервера за ' + Math.round(lim / 1000) + ' с. Нажмите на значок, чтобы повторить.')), lim); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}
function outMenu(ev, id) {
  const job = outbox[id]; if (!job) return;
  openMenu(ev, [{ t: 'Повторить', i: 'refresh', f: () => outRun(job) },
    { t: 'Удалить', i: 'delete', danger: true, f: async () => { // только локальное неотправленное
      if (await onServer(id).catch(() => null)) { toast('Сообщение уже отправлено'); const el = msgEls[id]; if (el) { delete el.dataset.state; paintTicks(el); } delete outbox[id]; window.saveOutbox?.(); return; }
      delete outbox[id]; window.saveOutbox?.(); const el = msgEls[id]; if (el) { el.remove(); delete msgEls[id]; } } }]);
}
function userErr(msg) { const e = new Error(msg); e.userMsg = msg; return e; }
// Как в WhatsApp/Telegram: смена ключа собеседника не блокирует отправку — новый ключ принимается молча, в чате серая строка «Код безопасности изменился».
async function encryptForPeer(pt, peer = peerId) {
  try { return await E2E.encryptDM(peer, pt); }
  catch (e) {
    if (!(e instanceof E2E.KeyChange)) throw e;
    await E2E.acceptKeys(e.userId); return E2E.encryptDM(peer, pt);
  }
}
/** Есть ли сообщение с этим id на сервере (повтор после сбоя сети: вставка могла пройти). */
async function onServer(id) {
  const { data, error } = await sb.from('messages').select('id, created_at').eq('id', id).maybeSingle();
  if (error) throw error; return data;
}
async function insertEncrypted(row, pt) {
  if (!row.ciphertext || typeof row.ciphertext !== 'object') throw userErr('Сообщение не отправлено: нет шифротекста.' + NO_PLAIN); // открытым текстом — никогда
  row.id = row.id || crypto.randomUUID(); // id задаёт клиент: повтор не создаёт дубль
  const sig = ctSig(row.ciphertext);
  sentOwn[sig] = pt;
  let { data, error } = await sb.from('messages').insert(row).select('id, created_at').single();
  if (error) { // ответ мог потеряться, а строка — записаться; дубль ключа (23505/409) = уже на сервере. upsert не используем
    const dup = error.code === '23505' || error.status === 409 || /duplicate key/i.test(error.message || '');
    let checked = false; const had = await onServer(row.id).then(r => { checked = true; return r; }, () => null);
    if (had || dup) { data = had || { id: row.id, created_at: null }; error = null; }
    else if (checked) error.absent = true; // проверка прошла и подтвердила: строки нет
  }
  if (error) { delete sentOwn[sig]; throw error; }
  // 20.10 (Support Bot): строка уже на сервере — статус «отправлено» не ждёт локальной записи текста (rememberOwn идёт под общей
  // блокировкой шифрования и при занятой очереди ждал до LOCK_WAIT = 12 с). Текст пишется в фоне; до записи он есть в sentOwn.
  E2E.rememberOwn(data.id, pt, row.ciphertext.sk).catch(e => console.warn('rememberOwn', data.id, e && e.message));
  // своё отправленное — сразу в локальный кэш: иначе перерисовка чата из кэша (офлайн/сбой запроса) теряла уже отправленные из очереди
  try { window.cacheOwn?.({ ...row, sender_id: row.sender_id || me.id, created_at: data.created_at || row.created_at || new Date().toISOString() }, pt); } catch (e) { /* */ }
  return data;
}
const NO_PLAIN = ' Сайт никогда не отправляет сообщения без сквозного шифрования.';
/** Отправка только шифротекстом. Нет своих ключей — сначала регистрируем устройство; нет ключей у собеседника — понятная ошибка. */
async function chatPeer(chat) {
  if (currentChat && chat.id === currentChat.id && peerId) return peerId;
  if (chat.peer) return chat.peer;
  const { data } = await sb.from('chat_members').select('user_id').eq('chat_id', chat.id).neq('user_id', me.id).limit(1).maybeSingle();
  return data ? data.user_id : null;
}
async function sendPayload(chat, pt, extra) {
  if (!(await e2eStart())) throw userErr('Сообщение не отправлено: шифрование на этом устройстве не запустилось (' + ruErr(e2eErr) + '). Обновите страницу (Ctrl+F5).');
  try { await E2E.checkDevice(); } catch (e) { console.error('checkDevice', e); throw userErr('Нет связи с сервером. Сообщение не отправлено, нажмите «Повторить».'); }
  if (chat.kind === 'direct') {
    const peer = await chatPeer(chat);
    if (!peer) throw userErr('Сообщение не отправлено: не удалось определить собеседника.');
    if (await E2E.sendBlocked(peer)) await E2E.unblockSend(peer); // без диалогов: только системная строка в чате
    if (!(await E2E.peerHasKeys(peer))) throw userErr('Сообщение не отправлено: у собеседника нет ключей шифрования — он ещё не входил в обновлённое приложение или на сайт. Попросите его войти, затем повторите.' + NO_PLAIN);
    const r = await encryptForPeer(pt, peer);
    if (!r) throw userErr('Сообщение не отправлено: у собеседника больше нет ключей шифрования.' + NO_PLAIN);
    return insertEncrypted({ chat_id: chat.id, sender_id: me.id, body: '', ciphertext: r.ct, ...(extra || {}) }, r.pt);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const { epoch, others } = await E2E.distribute(chat.id);
    if (!others) throw userErr('Сообщение не отправлено: ни у кого из участников группы нет ключей шифрования.' + NO_PLAIN);
    const r = await E2E.encryptGroup(chat.id, epoch, pt);
    try { return await insertEncrypted({ chat_id: chat.id, sender_id: me.id, body: '', ciphertext: r.ct, key_epoch: epoch, sender_device: E2E.deviceId(), ...(extra || {}) }, r.pt); }
    catch (e) { if (!String(e && e.message).includes('stale key epoch')) throw e; }
  }
  throw userErr('Сообщение не отправлено: ключ группы меняется слишком часто, попробуйте ещё раз.');
}

// ---------- правка зашифрованных сообщений (RPC edit_message, как в Android) ----------
async function editEncrypted(m, pt) {
  if (!(await e2eStart())) throw userErr('Шифрование на этом устройстве не запустилось — правка невозможна.');
  if (m.ciphertext.sk !== undefined) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { epoch } = await E2E.distribute(m.chat_id);
      const r = await E2E.encryptGroup(m.chat_id, epoch, pt);
      sentOwn[r.ct.sk] = pt;
      const { error } = await sb.rpc('edit_message', { p_id: m.id, p_ciphertext: r.ct, p_key_epoch: epoch, p_sender_device: E2E.deviceId() });
      if (!error) { E2E.rememberOwn(m.id, pt, r.ct.sk).catch(() => {}); return; }
      delete sentOwn[r.ct.sk];
      if (!String(error.message).includes('stale key epoch')) throw error;
    }
    throw userErr('Не удалось изменить: ключ группы меняется слишком часто, попробуйте ещё раз.');
  }
  const r = await encryptForPeer(pt);
  if (!r) throw userErr('У собеседника больше нет ключей шифрования — правка не отправлена.');
  const sig = ctSig(r.ct); sentOwn[sig] = pt;
  const { error } = await sb.rpc('edit_message', { p_id: m.id, p_ciphertext: r.ct, p_key_epoch: null, p_sender_device: null });
  if (error) { delete sentOwn[sig]; throw error; }
  E2E.rememberOwn(m.id, pt).catch(() => {});
}

// ---------- файлы: AES-256-GCM как в Android (ключ и sha256 внутри зашифрованного сообщения) ----------
const SEND_MLC1 = false; // включить, когда приложение научится MLC1 (MEDIA_FORMAT.md)
const MAX_FILE = 25 * 1024 * 1024;
const RISKY = ['apk','apks','xapk','aab','exe','msi','bat','cmd','sh','jar','dex','js','vbs','ps1','scr','com','html','htm','xhtml','svg','mht','mhtml'];
const safeName = n => { n = String(n || 'file').replace(/[\\/\u0000-\u001f\u007f]/g, '_').replace(/\.\./g, '_').trim(); if (!n || n === '.') n = 'file'; return n.length > 200 ? n.slice(-200) : n; };
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = async () => {
  const file = $('fileInput').files[0]; $('fileInput').value = '';
  if (!file || !currentChat) return;
  if (file.size <= 0 || file.size > MAX_FILE) return toastLong('Файл пустой или больше 25 МБ');
  fileSheet(file);
};
async function sendFile(chat, file, extra, caption, fw, job) {
  if (job && job.uploaded) { // файл уже в Storage (прошлая попытка не знала, записалась ли строка) — не загружаем заново
    const u = job.uploaded;
    try { const r = await sendPayload(chat, u.pt, { ...(extra || {}), attachment_path: u.path }); delete job.uploaded; return r; }
    catch (e) { if (e && e.absent) { delete job.uploaded; await sb.storage.from(u.bucket || 'chat-files').remove([u.path]).catch(() => {}); } throw e; }
  }
  if (!(await e2eStart())) throw userErr('Файл не отправлен: шифрование на этом устройстве не запустилось.');
  const fpeer = chat.kind === 'direct' ? await chatPeer(chat) : null;
  if (chat.kind === 'direct' && !(fpeer && await E2E.peerHasKeys(fpeer))) throw userErr('Файл не отправлен: у собеседника нет ключей шифрования, а файлы без шифрования не отправляются.');
  const plain = new Uint8Array(await file.arrayBuffer());
  const enc = await E2E.encryptFile(plain, { mlc1: SEND_MLC1 && !!(job && job.media) }); // MLC1 при отправке временно выключен (Android v8 его не читает); чтение MLC1 включено
  const bucket = job && job.media ? MEDIA_BUCKET : 'chat-files';
  const path = `chat/${chat.id}/${crypto.randomUUID()}_file.bin`;
  await uploadEnc(path, enc.ct, bucket);
  const f = { p: path, n: safeName(file.name), s: plain.length, m: file.type || '', k: enc.k, iv: enc.iv, h: enc.h };
  if (bucket !== 'chat-files') f.b = bucket;
  if (job && job.media) Object.assign(f, job.media); // vk: voice|round, d: длительность, w: волна — внутри шифротекста
  // подпись — только внутри зашифрованного payload (поле caption), на сервер открытым текстом не уходит
  extra = { ...(extra || {}), attachment_path: path }; // только путь: имя, размер и тип — внутри шифротекста
  // подпись: Android (ChatActivity/textOf) читает её из t, прежний сайт — из caption; пишем в оба поля (20.10, «Ну вот, как-то так» терялась)
  const cap = caption ? String(caption).slice(0, 4000) : ''; const pl = { v: 1, t: cap, f }; if (cap) pl.caption = cap; if (fw) pl.fw = fw;
  if (job) {
    try { return await sendPayload(chat, JSON.stringify(pl), extra); }
    catch (e) { // объект удаляем, только если проверка подтвердила, что строки нет; иначе оставляем и повтор использует тот же путь
      if (e && e.absent) await sb.storage.from(bucket).remove([path]).catch(() => {});
      else job.uploaded = { path, bucket, pt: JSON.stringify(pl) };
      throw e;
    }
  }
  try { return await sendPayload(chat, JSON.stringify(pl), extra); }
  catch (e) { await sb.storage.from(bucket).remove([path]).catch(() => {}); throw e; }
}
/** Загрузка шифротекста в Storage: Bearer-токен, без cookies (credentials: 'omit' — иначе CORS с '*' падает), без автоповторов.
 *  Объект уже есть (повтор после потерянного ответа) — считаем загруженным. */
// Голосовые и кружки: пока общий путь вложений. Когда Hack Bot создаст отдельный бакет — поменять только здесь.
const MEDIA_BUCKET = 'chat-files';
async function uploadEnc(path, ct, bucket = 'chat-files') {
  const { data } = await sb.auth.getSession(); const tok = data.session && data.session.access_token;
  if (!tok) throw userErr('Нет сеанса — войдите снова.');
  const r = await fetch(C.SUPABASE_URL + '/storage/v1/object/' + bucket + '/' + path.split('/').map(encodeURIComponent).join('/'), {
    method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: 'Bearer ' + tok, apikey: C.SUPABASE_KEY, 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' },
    body: new Blob([ct], { type: 'application/octet-stream' })
  });
  if (r.ok) return;
  let j = null; try { j = await r.json(); } catch { /* */ }
  if (r.status === 409 || /duplicate|already exists/i.test((j && (j.error || j.message)) || '')) return;
  throw userErr('Файл не загружен: ' + ((j && (j.message || j.error)) || ('HTTP ' + r.status)));
}
/** подписанная ссылка на зашифрованный файл — для потокового MLC1 (media.js), ключ остаётся в браузере */
window.mediaSignedUrl = async f => { const { data, error } = await sb.storage.from(/^[a-z0-9-]{3,63}$/.test(f.b || '') ? f.b : 'chat-files').createSignedUrl(f.p, 600); if (error) throw error; return data.signedUrl; };
async function fetchFilePlain(f) {
  const { data, error } = await sb.storage.from(/^[a-z0-9-]{3,63}$/.test(f.b || '') ? f.b : 'chat-files').createSignedUrl(f.p, 60);
  if (error) throw error;
  const r = await fetch(data.signedUrl);
  if (!r.ok) throw userErr('Скачивание не удалось');
  const ct = new Uint8Array(await r.arrayBuffer());
  if (ct.length > MAX_FILE + 16) throw userErr('Файл слишком большой');
  if (!(await e2eStart())) throw userErr('Шифрование на этом устройстве не запустилось — файл не расшифровать.');
  return E2E.decryptFile(ct, f.k, f.iv, f.h);
}
// ---------- превью картинок: расшифровка в blob:, полноэкранный просмотр ----------
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const imgUrls = {}; // путь файла → Promise<blob URL>
function imgMime(f) {
  const m = String(f.m || '').toLowerCase(); if (Object.values(IMG_MIME).includes(m)) return m;
  const ext = String(f.n || '').toLowerCase().split('.').pop(); return IMG_MIME[ext] || null; // SVG не показываем
}
// Тип по сигнатуре расшифрованных байтов (m от отправителя не доверяем)
/** Строка файла: значок description, имя, размер, кнопка download справа. Только скачивание (octet-stream), без открытия на сайте. */
function fileRow(f, fromOther) {
  const row = document.createElement('div'); row.className = 'file-row';
  const t = document.createElement('div'); t.className = 'fr-text';
  const n = document.createElement('div'); n.className = 'fr-name'; txt(n, safeName(f.n));
  const z = document.createElement('div'); z.className = 'fr-size'; txt(z, f.s ? fmtSize(f.s) : '');
  t.append(n, z);
  const dl = iconBtn('download', 'Скачать и расшифровать', 'fr-dl');
  dl.onclick = ev => {
    ev.stopPropagation(); dl.disabled = true;
    downloadFile(f, fromOther).catch(e => { if (e && e.corrupt) row.replaceWith(brokenRow(f)); else toastLong(e.userMsg || ruErr(e)); }).finally(() => { dl.disabled = false; });
  };
  row.append(msIcon('description', 'fr-ic'), t, dl);
  return row;
}
/** Повреждённый файл (sha256 не совпал): только сообщение, без скачивания */
function brokenRow(f) {
  const row = document.createElement('div'); row.className = 'file-row broken';
  const t = document.createElement('div'); t.className = 'fr-text';
  const n = document.createElement('div'); n.className = 'fr-name'; txt(n, 'Файл повреждён');
  const z = document.createElement('div'); z.className = 'fr-size'; txt(z, safeName(f.n));
  t.append(n, z); row.append(msIcon('broken_image', 'fr-ic'), t);
  return row;
}
function sniffImage(p) {
  const b = i => p[i];
  if (p.length > 3 && b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg';
  if (p.length > 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return 'image/png';
  if (p.length > 6 && b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'image/gif';
  if (p.length > 12 && String.fromCharCode(b(0), b(1), b(2), b(3)) === 'RIFF' && String.fromCharCode(b(8), b(9), b(10), b(11)) === 'WEBP') return 'image/webp';
  return null;
}
/** Превью только если: тип из белого списка, есть sha256 (h) и он совпал, сигнатура совпадает с типом. Иначе — обычный файл (onFallback). */
function imagePreview(f, caption, fromOther, onFallback) {
  const mime = imgMime(f); if (!mime || !f.p || !f.h || (f.s && f.s > 15 * 1048576)) return null;
  const box = document.createElement('div'); box.className = 'img-prev loading'; box.setAttribute('aria-label', 'Загрузка ' + (f.s ? fmtSize(f.s) : ''));
  // размер заглушки — по метаданным из шифротекста (iw/ih), если есть; иначе стандартный блок
  if (+f.iw > 0 && +f.ih > 0) { const w = Math.min(260, +f.iw), h = Math.max(80, Math.min(340, Math.round(w * +f.ih / +f.iw))); box.style.width = w + 'px'; box.style.height = h + 'px'; }
  const sp = document.createElement('span'); sp.className = 'spinner'; box.append(sp);
  (imgUrls[f.p] = imgUrls[f.p] || fetchFilePlain(f).then(p => {
    const real = sniffImage(p);
    if (!real || real !== mime) { const e = new Error('not an image'); e.notImage = true; throw e; }
    return URL.createObjectURL(new Blob([p], { type: real }));
  }))
    .then(url => {
      const im = document.createElement('img'); im.alt = safeName(f.n); im.src = url;
      im.onload = () => { box.textContent = ''; box.classList.remove('loading'); box.removeAttribute('aria-label'); box.setAttribute('role', 'button'); box.setAttribute('aria-label', 'Открыть фото ' + im.alt); box.append(im); };
      im.onerror = () => { box.classList.remove('loading'); box.removeAttribute('aria-label'); txt(box, 'Не удалось показать картинку'); };
      box.onclick = ev => { ev.stopPropagation(); openImage(url, im.alt, f, caption, fromOther); };
    })
    .catch(e => {
      delete imgUrls[f.p]; box.classList.remove('loading'); box.removeAttribute('aria-label'); box.onclick = null;
      if (e && (e.notImage || e.corrupt) && onFallback) return onFallback(!!e.corrupt); // не картинка — как файл; повреждён — строка ошибки
      if (!navigator.onLine || (window.connState && window.connState() === 'offline') || isNetErr(e)) { // без сети — серый блок с иконкой, без ошибки; загрузим при появлении сети
        box.textContent = ''; box.classList.add('offline'); box.setAttribute('aria-label', 'Картинка загрузится, когда появится сеть'); box.append(msIcon('image', 'ip-ic'));
        const again = () => { removeEventListener('online', again); setTimeout(() => { if (!box.isConnected) return; const nb = imagePreview(f, caption, fromOther, onFallback); if (nb) box.replaceWith(nb); }, 1500); };
        addEventListener('online', again); return;
      }
      txt(box, 'Не удалось загрузить картинку');
    });
  return box;
}
// Диалог поверх экрана с записью в истории: «Назад» в браузере закрывает его
function overlayHistory(dlg) {
  const tag = dlg.id + ':' + Date.now();
  navPush({ ...(history.state || {}), ov: tag }, '', location.href);
  const onPop = () => { if (dlg.open) { dlg.dataset.popped = '1'; dlg.close(); } };
  window.addEventListener('popstate', onPop, { once: true });
  dlg.addEventListener('close', () => {
    window.removeEventListener('popstate', onPop);
    if (!dlg.dataset.popped && history.state && history.state.ov === tag && ownNav > 0) history.back();
    delete dlg.dataset.popped;
  }, { once: true });
}
function msIcon(name, cls) { const i = document.createElement('span'); i.className = 'ms' + (cls ? ' ' + cls : ''); i.setAttribute('aria-hidden', 'true'); txt(i, name); return i; }
// Превью вложения в списке чатов: расшифровываем последнее сообщение локально (сервер знает только last_has_file)
const lastPrev = {}; // chat_id + last_at → {icon, text}
/** Текст превью в списке чатов по расшифрованному payload: фото → значок image + подпись, файл → description + имя, текст. */
function prevOf(pl) {
  if (pl.f && pl.f.vk === 'voice') return { icon: null, text: '🎤 Голосовое ' + fmtDur(pl.f.d) };
  if (pl.f && pl.f.vk === 'round') return { icon: null, text: '⭕ Видеосообщение' };
  if (!pl.f) return { icon: null, text: pl.t || '' };
  const cap = pl.caption || pl.t || '';
  return imgMime(pl.f) ? { icon: 'image', text: cap || 'Фото' } : { icon: null, text: '📎 ' + (cap || safeName(pl.f.n)) };
}
/** Сообщение расшифровано в открытом чате (в т.ч. своё отправленное) — обновляем превью в списке, если оно последнее. */
function notePreview(m, pl) {
  const key = m.chat_id + '|' + m.created_at; lastPrev[key] = prevOf(pl); window.cachePrev?.();
  const sub = document.querySelector('#chatList li[data-id="' + CSS.escape(m.chat_id) + '"] .sub'); if (sub) sub.classList.remove('sub-skel');
  const curAt = sub && sub.dataset.key ? sub.dataset.key.split('|')[1] : '';
  if (sub && (sub.dataset.key === key || !curAt || new Date(m.created_at) >= new Date(curAt))) {
    sub.dataset.key = key; const li = sub.closest('li'); const tm = li && li.querySelector('.time'); if (tm) txt(tm, fmtListTime(m.created_at)); const v = lastPrev[key]; sub.textContent = ''; if (me && m.sender_id === me.id) sub.append('Вы: '); if (v.icon) sub.prepend(msIcon(v.icon, 'sub-ic')); sub.append(v.text); }
}
async function filePreviewSoon(c, sub) {
  if (!me) return; const key = c.id + '|' + c.last_at;
  const stub = () => { if (!sub.isConnected || !me || !sub.classList.contains('sub-skel')) return; sub.classList.remove('sub-skel'); txt(sub, (c.last_sender === me.id ? 'Вы: ' : '') + (c.last_has_file ? '📎 Файл' : '🔒 зашифрованное сообщение')); };
  const paint = v => { if (!v || !sub.isConnected || !me) return; sub.classList.remove('sub-skel'); sub.textContent = ''; if (c.last_sender === me.id) sub.append('Вы: '); if (v.icon) sub.prepend(msIcon(v.icon, 'sub-ic')); sub.append(v.text); };
  // Из кэша — после текущего прохода loadChats: li ещё не в DOM (sub.isConnected=false), синхронная отрисовка молча пропускалась
  if (lastPrev[key]) { const v = lastPrev[key]; queueMicrotask(() => paint(v)); return; }
  try {
    const { data } = await sb.from('messages').select('*').eq('chat_id', c.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!data || !data.ciphertext) return stub();
    const pl = await decryptPayload(data); if (!pl || pl.fail || pl.other) return stub();
    if (!pl.pending) sendDlv(data);
    if (pl.pending) { setTimeout(() => { if (sub.isConnected && me) filePreviewSoon(c, sub); }, 16000); return; } // шифрование занято — повторим
    paint(lastPrev[key] = prevOf(pl)); window.cachePrev?.();
  } catch (e) { stub(); }
}
function iconBtn(name, label, cls) { const b = document.createElement('button'); b.type = 'button'; b.className = 'icon ' + (cls || ''); b.setAttribute('aria-label', label); b.title = label; b.append(msIcon(name)); return b; }
function openImage(url, alt, f, caption, fromOther) {
  let v = $('imgView');
  if (!v) {
    v = document.createElement('dialog'); v.id = 'imgView'; v.className = 'img-view'; document.body.append(v);
    v.addEventListener('click', ev => { if (ev.target === v || ev.target.classList.contains('iv-stage')) v.close(); });
    let y0 = null; // свайп вниз закрывает
    v.addEventListener('pointerdown', ev => { y0 = ev.clientY; });
    v.addEventListener('pointerup', ev => { if (y0 != null && ev.clientY - y0 > 80) v.close(); y0 = null; });
  }
  v.textContent = '';
  const stage = document.createElement('div'); stage.className = 'iv-stage';
  const im = document.createElement('img'); im.src = url; im.alt = alt || ''; im.draggable = false; stage.append(im);
  const close = iconBtn('close', 'Закрыть', 'iv-close'); close.onclick = () => v.close();
  v.append(stage, close);
  if (f) { const dl = iconBtn('download', 'Скачать', 'iv-dl'); dl.onclick = () => { dl.disabled = true; downloadFile(f, fromOther).catch(e => toastLong(e.userMsg || ruErr(e))).finally(() => { dl.disabled = false; }); }; v.append(dl); }
  if (caption) { const c = document.createElement('div'); c.className = 'iv-cap'; txt(c, caption); v.append(c); }
  v.showModal(); overlayHistory(v);
}
// ---------- отправка файла с подписью (подпись = поле t того же зашифрованного payload {v:1,t,f}) ----------
function fileSheet(file) {
  let d = $('fileDlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'fileDlg'; d.className = 'file-sheet'; document.body.append(d); }
  d.textContent = '';
  const close = iconBtn('close', 'Отмена', 'fs-close'); close.onclick = () => d.close();
  const body = document.createElement('div'); body.className = 'fs-body';
  let url = null;
  if (imgMime({ m: file.type, n: file.name })) {
    url = URL.createObjectURL(file); const im = document.createElement('img'); im.className = 'fs-img'; im.alt = safeName(file.name); im.src = url; body.append(im);
  } else {
    const row = document.createElement('div'); row.className = 'fs-file';
    const ic = msIcon('description'); ic.classList.add('fs-ic');
    const t = document.createElement('div'); const n = document.createElement('div'); n.className = 'fs-name'; txt(n, safeName(file.name));
    const sz = document.createElement('div'); sz.className = 'fs-size'; txt(sz, fmtSize(file.size)); t.append(n, sz); row.append(ic, t); body.append(row);
  }
  const bar = document.createElement('div'); bar.className = 'fs-bar';
  const cap = document.createElement('textarea'); cap.rows = 1; cap.maxLength = 4000; cap.placeholder = 'Добавить подпись…'; cap.className = 'fs-cap';
  cap.oninput = () => { cap.style.height = 'auto'; cap.style.height = Math.min(cap.scrollHeight, 140) + 'px'; };
  const send = iconBtn('send', 'Отправить', 'fs-send');
  bar.append(cap, send);
  d.append(close, body, bar);
  const chat = currentChat;
  const go = async () => {
    send.disabled = cap.disabled = true;
    try { outSend({ chat, kind: 'file', file, caption: cap.value.trim(), extra: {} }); d.close(); }
    catch (e) { toastLong(e.userMsg || ruErr(e)); send.disabled = cap.disabled = false; }
  };
  send.onclick = go;
  cap.onkeydown = ev => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); if (!send.disabled) go(); } };
  d.addEventListener('close', () => { if (url) URL.revokeObjectURL(url); }, { once: true });
  d.showModal(); overlayHistory(d); cap.focus();
}
async function downloadFile(f, fromOther) {
  const name = safeName(f.n);
  if (fromOther && RISKY.some(x => name.toLowerCase().endsWith('.' + x)) && !confirm(`«${name}» может быть опасным файлом. Скачать?`)) return;
  const plain = await fetchFilePlain(f);
  const url = URL.createObjectURL(new Blob([plain], { type: 'application/octet-stream' })); // octet-stream: браузер сохраняет файл, а не открывает его
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------- код безопасности ----------
let peerKeys = false;
// Шапка чата не меняется: «Код безопасности» — в профиле собеседника
function safetyLabel() { const b = $('peerSafety'); if (b && peerId && E2E) txt(b, E2E.isVerified(peerId) ? 'Шифрование · проверено' : 'Шифрование'); }
/** Системные строки «Код безопасности @ника изменился» — только из локального хранилища этого браузера (E2E.keyEvents).
 *  С сервера и из сообщений такие события не принимаются; ник — только textContent. */
async function paintKeyEvents() {
  const c = currentChat; if (!c || c.kind !== 'direct' || !peerId || !E2E) return;
  const evs = await E2E.keyEvents(peerId).catch(() => []); if (currentChat !== c) return; const box = $('messages');
  box.querySelectorAll('.sys-kc').forEach(x => x.remove());
  if (!evs.length) return;
  const p = await getProfile(peerId).catch(() => null); if (currentChat !== c) return;
  const nick = p && p.username ? '@' + p.username : 'собеседника';
  for (const ev of evs) {
    const at = ev.at, nd = ev.k === 'nd';
    const row = document.createElement('div'); row.className = 'sys-row sys-kc' + (nd ? ' sys-nd' : ''); row.dataset.at = at; row.setAttribute('role', 'note');
    const t = document.createElement('span'); t.textContent = nd ? 'У ' + (p && p.username ? '@' + p.username : 'собеседника') + ' новое устройство' : 'Код безопасности ' + nick + ' изменился';
    const a = document.createElement('button'); a.type = 'button'; a.className = 'link'; a.textContent = 'Сверить';
    a.onclick = () => showSafety().catch(e => toastLong(ruErr(e)));
    row.append(msIcon(nd ? 'devices' : 'shield', 'sys-ic'), t, a);
    const next = [...box.querySelectorAll('.msg')].find(m => m.dataset.at && m.dataset.at > at);
    if (next) box.insertBefore(row, next); else box.append(row);
  }
}
addEventListener('e2e-changed', () => { if (currentChat) { paintKeyEvents(); safetyLabel(); } });
async function showSafety() {
  const peer = peerId; if (!peer) return;
  const nums = await E2E.safetyNumbers(peer);
  const list = $('safetyList'); list.textContent = '';
  nums.forEach((n, i) => {
    if (nums.length > 1) { const h = document.createElement('p'); h.className = 'hint'; txt(h, 'Устройство ' + (i + 1)); list.append(h); }
    const d = document.createElement('div'); d.className = 'fp';
    txt(d, n.digits.match(/.{1,5}/g).reduce((s, g, j) => s + g + (j % 4 === 3 ? '\n' : '  '), '').trim());
    const q = qrcode(0, 'M'); q.addData(n.qr); q.make();
    const qd = document.createElement('div'); qd.className = 'fpqr'; qd.innerHTML = q.createSvgTag(4, 0);
    list.append(d, qd);
  });
  if (!nums.length) { const p = document.createElement('p'); txt(p, 'Нет ключей собеседника.'); list.append(p); }
  const st = () => { const s = $('safetyState'); s.className = 'hint';
    if (E2E.hasPendingChange(peer)) { txt(s, 'Код безопасности изменился (новое устройство собеседника).'); }
    else if (E2E.isVerified(peer)) { s.className = 'hint ok'; txt(s, '✅ Код проверен'); }
    else txt(s, 'Код ещё не проверен.');
    $('acceptBtn').hidden = true; safetyLabel(); };
  st(); $('scanInput').value = '';
  const check = async v => {
    if (!v) return;
    if (await E2E.verifyScanned(peer, v)) { st(); $('safetyState').className = 'hint ok'; txt($('safetyState'), '✅ QR совпал — код проверен'); }
    else { $('safetyState').className = 'hint bad'; txt($('safetyState'), '❌ Код НЕ совпадает. Возможно, переписку подменяют или у собеседника другое устройство.'); }
  };
  $('checkBtn').onclick = () => check($('scanInput').value.trim());
  $('matchBtn').onclick = async () => { if (confirm('Вы сравнили все 60 цифр с экраном собеседника, и они совпадают?')) { await E2E.markVerified(peer); st(); } };
  $('acceptBtn').hidden = true; // новый ключ принимается сам, без кнопки
  if (E2E.hasPendingChange(peer)) { try { await E2E.acceptKeys(peer); } catch (e) { console.warn('acceptKeys', e); } st(); }
  $('scanBtn').hidden = !('BarcodeDetector' in window && navigator.mediaDevices);
  $('scanBtn').onclick = () => scanQr().then(check).catch(e => toastLong('Камера недоступна: ' + ruErr(e)));
  $('closeSafety').onclick = () => { stopScan(); $('safetyDlg').close(); };
  $('safetyDlg').showModal();
}
let scanStream = null;
function stopScan() { if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; } $('scanVideo').hidden = true; }
async function scanQr() {
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  const v = $('scanVideo'); v.srcObject = scanStream; v.hidden = false; await v.play();
  try {
    for (let i = 0; i < 600 && scanStream; i++) {
      const codes = await det.detect(v).catch(() => []);
      if (codes.length) return codes[0].rawValue;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('QR не найден');
  } finally { stopScan(); }
}
$('peerSafety').onclick = () => { $('peerDlg').close(); showSafety().catch(e => toastLong(ruErr(e))); };
$('findForm').onsubmit = e => { e.preventDefault(); window.findSubmit(); };

$('backBtn').onclick = () => ownNav > 0 && location.hash === '#chat' ? history.back() : (location.hash === '#chat' && history.replaceState(history.state, '', location.pathname + location.search), closeChatView());
function closeChatView() { $('app').classList.remove('in-chat'); }
$('peerBtn').onclick = async () => {
  if (!currentChat || currentChat.kind !== 'direct' || !peerId) return;
  const p = await getProfile(peerId, true);
  fillAvatar($('peerAva'), p); txt($('peerName'), displayName(p)); txt($('peerNick'), p ? '@' + p.username : ''); $('peerNick').hidden = !p;
  txt($('peerBio'), p ? p.bio || 'Не указано' : ''); $('peerBio').hidden = !p; $('peerBio').classList.toggle('unset', !!p && !p.bio);
  $('peerSafety').hidden = !peerKeys; safetyLabel();
  $('peerDlg').showModal();
};
$('closePeer').onclick = () => $('peerDlg').close();
$('chatMenuBtn').onclick = e => { if (!currentChat) return; const r = e.currentTarget.getBoundingClientRect(); openMenu({ clientX: r.right - 220, clientY: r.bottom + 4 }, chatMenuItems(currentChat)); };

// ---------- настройки и профиль ----------
const THEMES = { system: null, dark: 'dark', light: 'light' };
function applyTheme(t) {
  if (!(t in THEMES)) t = 'system';
  if (THEMES[t]) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { t === 'system' ? localStorage.removeItem('local-msgr-theme') : localStorage.setItem('local-msgr-theme', t); } catch { /* нет localStorage */ }
  document.querySelectorAll('#themeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === t)));
  const tv = $('themeVal'); if (tv) txt(tv, { system: 'Системная', light: 'Светлая', dark: 'Тёмная' }[t]);
  const dark = THEMES[t] ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.querySelector('meta[name=theme-color]').content = dark ? '#0f1720' : '#eef2f6';
}
document.querySelectorAll('#themeSeg button').forEach(b => { b.onclick = () => applyTheme(b.dataset.mode); });
applyTheme((() => { try { return localStorage.getItem('local-msgr-theme') || 'system'; } catch { return 'system'; } })());
let pickedColor = null;
let tab = 'chats';
function setNav(t) { tab = t; document.querySelectorAll('#bottomNav button').forEach(b => { if (b.dataset.nav === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }); }
function openSettings(push = true, which = 'settings') {
  if (!me) return; // сессия/профиль ещё не загружены
  $('app').classList.add('in-settings');
  document.querySelectorAll('#settings .group-wrap').forEach(g => { g.hidden = g.dataset.tab !== which; });
  $('editBtn').hidden = which !== 'profile'; txt($('profMsg'), ''); $('editCard').hidden = true;
  txt($('pageTitle'), which === 'profile' ? 'Профиль' : 'Настройки');
  setNav(which);
  if (push && location.hash !== '#' + which) navPush({ v: which }, '', '#' + which);
  if (which === 'profile') fillSettings().catch(e => showErr('Не удалось загрузить профиль: ' + ruErr(e)));
  else { let cv = null; try { cv = localStorage.getItem('local-msgr-seen'); } catch { /* */ }
    if (cv) paintSeenSeg(cv); else txt($('seenVal'), '…');
    getProfile(me.id, true).then(p => me && paintSeenSeg((p && p.last_seen_visibility) || 'everyone'));
    loadDevices(false).catch(() => {}); paintStorage(); $('notifSw').checked = notifOn(); paintNotifSub();
    txt($('buildInfo'), 'Сборка ' + (window.BUILD ? BUILD.commit + ' · ' + BUILD.date : 'неизвестна'));
    getProfile(me.id).then(p => me && paintMini(p));
    txt($('setEmail'), me.email || '—'); txt($('setDevice'), uaName(navigator.userAgent).name); }
}
function closeSettings() { $('app').classList.remove('in-settings'); setNav('chats'); maybeMarkRead(); }
document.querySelectorAll('#bottomNav button').forEach(b => {
  b.onclick = () => {
    const t = b.dataset.nav;
    if (t === 'chats') { if (/^#(profile|settings)$/.test(location.hash)) navPush({ v: 'chats' }, '', currentChat && $('app').classList.contains('in-chat') ? '#chat' : '#'); closeSettings(); }
    else openSettings(true, t);
  };
});
$('meBtn').onclick = () => openSettings(true, 'profile');
$('settingsBack').onclick = () => ownNav > 0 && /^#(profile|settings)$/.test(location.hash) ? history.back() : (/^#(profile|settings)$/.test(location.hash) && history.replaceState(history.state, '', location.pathname + location.search), closeSettings());
window.addEventListener('popstate', () => {
  const m = /^#(profile|settings)$/.exec(location.hash);
  if (m) openSettings(false, m[1]); else closeSettings();
  if (location.hash !== '#chat' && !m) closeChatView();
});
async function fillSettings() {
  const p = await getProfile(me.id, true);
  if (!p) throw new Error('профиль не найден');
  $('pName').value = p.display_name || ''; $('pNick').value = p.username || ''; $('pBio').value = cleanBio(p.bio || ''); $('pLetter').value = p.avatar_letter || ''; $('pLetter').disabled = !profileExt; paintBioCount(); paintProfHead(p);
  pickedColor = p.avatar_color || null;
  const ext = !!profileExt;
  $('extNote').hidden = ext; $('pBio').disabled = !ext; $('avaPhotoBtn').disabled = !ext; $('avaRemoveBtn').hidden = !p.avatar_url; $('avaPhotoBtn').hidden = !ext;
  const row = $('colorRow'); row.textContent = '';
  for (const col of COLORS) {
    const b = document.createElement('button'); b.type = 'button'; b.style.background = col; b.title = col; b.disabled = !ext;
    b.setAttribute('aria-label', 'Цвет ' + col); b.setAttribute('aria-pressed', String(colorFor(p) === col));
    b.onclick = () => { pickedColor = col; row.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); fillAvatar($('profAva'), { ...p, avatar_color: col, avatar_letter: $('pLetter').value.trim() || null }); };
    row.append(b);
  }
  fillAvatar($('profAva'), p); txt($('profMsg'), '');
}
$('pLetter').oninput = () => { const p = profiles[me.id]; if (p) fillAvatar($('profAva'), { ...p, avatar_url: null, avatar_color: pickedColor || p.avatar_color, avatar_letter: $('pLetter').value.trim() || null }); };
/** «О себе»: без управляющих символов (кроме перевода строки), не больше 300 — как проверяет сервер */
function cleanBio(s) { return Array.from(String(s).replace(/\r\n?/g, '\n').replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, c => c === '\n' ? c : '')).join('').slice(0, 300); }
function paintBioCount() { const n = $('pBio').value.length; txt($('bioCount'), String(n)); $('bioCount').parentNode.classList.toggle('bad', n >= 280); }
$('pBio').oninput = () => { const v = cleanBio($('pBio').value); if (v !== $('pBio').value) $('pBio').value = v; paintBioCount(); };
function paintProfHead(p) { txt($('profName'), displayName(p)); txt($('profNick'), '@' + (p.username || '')); txt($('profBio'), p.bio || 'Не указано'); $('profBio').classList.toggle('unset', !p.bio); paintMini(p); }
function paintMini(p) { if (!p) return; fillAvatar($('miniAva'), p); txt($('miniName'), displayName(p)); txt($('miniNick'), '@' + (p.username || '')); }
$('editBtn').onclick = () => { $('editCard').hidden = !$('editCard').hidden; if (!$('editCard').hidden) $('pName').focus(); };
$('miniHead').onclick = $('rowProfile').onclick = () => openSettings(true, 'profile');
$('rowSeen').onclick = () => { $('seenBox').hidden = !$('seenBox').hidden; if (!$('seenBox').hidden) loadBlocks(); };
// ---------- листы настроек ----------
function sheet(title, nodes) { txt($('sheetTitle'), title); const b = $('sheetBody'); b.textContent = ''; b.append(...nodes); $('sheetDlg').showModal(); }
$('sheetClose').onclick = () => $('sheetDlg').close();
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) txt(e, text); return e; }
function kvRow(k, v, mono) { const r = el('div', 'kv'); r.append(el('span', 'hint small', k), el(mono ? 'code' : 'span', '', v)); return r; }
async function fpOf(pub) { if (!pub) return '—'; const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pub))); return [...d.slice(0, 16)].map(x => x.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(' '); }
let myDevs = null;
/** Сеансы входа (RPC Hack Bot list_devices): id, user_agent, ip (маскирован), created_at, refreshed_at, is_current */
async function loadDevices(force) {
  if (myDevs && !force) { txt($('devCount'), String(myDevs.length)); return myDevs; }
  const { data, error } = await sb.rpc('list_devices');
  if (error) { txt($('devCount'), '—'); throw error; }
  myDevs = (data || []).sort((x, y) => (y.is_current ? 1 : 0) - (x.is_current ? 1 : 0) || new Date(y.refreshed_at || y.created_at) - new Date(x.refreshed_at || x.created_at));
  txt($('devCount'), String(myDevs.length)); return myDevs;
}
function uaName(ua) {
  ua = ua || ''; if (!ua) return { name: 'Браузер', icon: 'devices' };
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /okhttp|Dalvik/i.test(ua) ? 'Приложение' : /supabase|java|kotlin/i.test(ua) ? 'Приложение' : null;
  const o = /Android/.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  const mobile = /Android|iPhone|iPad|Mobile|okhttp|Dalvik/i.test(ua);
  return { name: [b || 'Браузер', o].filter(Boolean).join(' · '), icon: mobile ? 'smartphone' : 'computer' };
}
async function revokeSession(d) {
  const { error } = await sb.rpc('revoke_device', { p_session_id: d.id });
  if (error) throw error;
  myDevs = (myDevs || []).filter(x => x.id !== d.id); txt($('devCount'), String(myDevs.length));
}
const fmtDT = s => s ? new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
/** Диалог подтверждения по макету: «Отмена» и красная кнопка действия */
function askConfirm(text, okText, cancelText) {
  return new Promise(res => {
    const d = $('confirmDlg'); txt($('confirmText'), text); txt($('confirmOk'), okText); txt($('confirmCancel'), cancelText || 'Отмена');
    $('confirmOk').onclick = () => { d.close(); res(true); }; $('confirmCancel').onclick = () => { d.close(); res(false); };
    d.oncancel = () => res(false); d.showModal();
  });
}
const devSub = d => [d.ip || null, d.is_current ? 'в сети' : seenText(d.refreshed_at || d.created_at)].filter(Boolean).join(' · ');
function devRow(d, onGone) {
  const u = uaName(d.user_agent), row = el('button', 'settings-row dev-row'); row.type = 'button';
  const ic = el('span', 'settings-row__icon', u.icon); ic.setAttribute('aria-hidden', 'true');
  const meta = el('span', 'settings-row__label'); meta.append(el('span', '', u.name), el('small', '', devSub(d)));
  row.append(ic, meta);
  row.onclick = () => openSession(d, () => { row.classList.add('gone'); setTimeout(() => { row.remove(); onGone && onGone(); }, 250); });
  return row;
}
function openSession(d, removed) {
  const u = uaName(d.user_agent), dlg = $('devDlg'), b = $('devBody'); b.textContent = '';
  const ic = el('span', 'ms dev-big', u.icon); ic.setAttribute('aria-hidden', 'true');
  b.append(ic, el('h3', '', u.name), kvRow('IP', d.ip || '—'), kvRow('Последняя активность', d.is_current ? 'в сети' : seenText(d.refreshed_at || d.created_at)), kvRow('Вход выполнен', fmtDT(d.created_at)), kvRow('Браузер', d.user_agent || '—'));
  const btn = el('button', 'settings-row settings-row--color-danger', null); btn.type = 'button';
  const bi = el('span', 'settings-row__icon', 'logout'); bi.setAttribute('aria-hidden', 'true'); btn.append(bi, el('span', 'settings-row__label', 'Завершить сеанс'));
  btn.onclick = async () => {
    if (!(await askConfirm('Завершить сеанс на этом устройстве? Его ключи будут удалены. Восстановить их будет нельзя.', 'Завершить'))) return;
    btn.disabled = true;
    try {
      await revokeSession(d); dlg.close();
      if (d.is_current) { $('sheetDlg').close(); await doLogout(); return; }
      removed(); toast('Сеанс завершён', 3000);
    } catch (e) { btn.disabled = false; toast('Не удалось завершить сеанс: ' + ruErr(e), 3000); }
  };
  b.append(btn); dlg.showModal();
}
$('devClose').onclick = () => $('devDlg').close();
$('rowDevices').onclick = async () => {
  try {
    const devs = await loadDevices(true);
    const cur = devs.find(x => x.is_current), others = devs.filter(x => !x.is_current).sort((x, y) => new Date(y.refreshed_at || y.created_at) - new Date(x.refreshed_at || x.created_at));
    const nodes = [];
    const top = el('div', 'settings-group'); top.append(el('div', 'settings-group__title', 'Это устройство'));
    if (cur) { const u = uaName(cur.user_agent), r = el('div', 'settings-row dev-cur'); const ic = el('span', 'settings-row__icon', u.icon); ic.setAttribute('aria-hidden', 'true'); const m = el('span', 'settings-row__label'); const st = el('small', ''); st.append(document.createTextNode((cur.ip ? cur.ip + ' · ' : '')), el('span', 'online', 'в сети')); m.append(el('span', '', u.name), st); r.append(ic, m); top.append(r); }
    else top.append(el('div', 'settings-row', 'Текущий сеанс не найден'));
    const all = el('button', 'settings-row settings-row--color-danger'); all.type = 'button';
    const ai = el('span', 'settings-row__icon', 'logout'); ai.setAttribute('aria-hidden', 'true'); all.append(ai, el('span', 'settings-row__label', 'Завершить все другие сеансы'));
    const list = el('div', 'settings-group'); list.append(el('div', 'settings-group__title', 'Активные сеансы'));
    const paint = () => { const n = (myDevs || []).filter(x => !x.is_current).length; all.hidden = n < 1; list.hidden = n < 1; };
    for (const d of others) list.append(devRow(d, paint));
    all.onclick = async () => {
      const left = (myDevs || []).filter(x => !x.is_current);
      if (!(await askConfirm(`Завершить все другие сеансы (${left.length})? Их ключи будут удалены. Восстановить их будет нельзя.`, 'Завершить'))) return;
      all.disabled = true; let fail = 0;
      for (const d of left) { try { await revokeSession(d); } catch (e) { fail++; console.warn('revoke', e); } }
      all.disabled = false;
      list.querySelectorAll('.dev-row').forEach(r => r.classList.add('gone')); setTimeout(() => { list.querySelectorAll('.dev-row').forEach(r => r.remove()); for (const d of myDevs.filter(x => !x.is_current)) list.append(devRow(d, paint)); paint(); }, 250);
      toast(fail ? `Не удалось завершить ${fail} из ${left.length}` : 'Сеансы завершены', 3000);
    };
    top.append(all); paint();
    nodes.push(top, list);
    sheet('Устройства', nodes);
  } catch (e) { toast('Не удалось загрузить устройства: ' + ruErr(e), 3000); }
};
$('rowThisDev').onclick = async () => {
  const id = E2E && E2E.deviceId();
  let fp = '—';
  if (id) { try { const { data: d, error } = await sb.from('devices_keys').select('identity_pub').eq('device_id', id).maybeSingle(); if (error) throw error; fp = d ? await fpOf(d.identity_pub) : 'ключи не найдены на сервере'; } catch (e) { fp = 'не удалось загрузить'; } }
  sheet('Это устройство', [kvRow('ID устройства', id || 'ключи шифрования ещё не созданы', true), kvRow('Отпечаток ключа', fp, true), kvRow('Шифрование', 'Signal (сквозное): сообщения и файлы шифруются на устройстве'), el('p', 'hint small', 'Профиль (имя, ник, «о себе», аватар) виден всем и не шифруется.')]);
};
$('rowEmail').onclick = () => sheet('Почта', [kvRow('Почта аккаунта', me.email || '—'), el('p', 'hint small', 'Почта используется для входа. Её видите только вы.')]);
$('rowLang').onclick = () => { const r = el('label', 'radio-row'); const i = el('input'); i.type = 'radio'; i.checked = true; i.name = 'lang'; r.append(i, el('span', '', 'Русский')); sheet('Язык', [r, el('p', 'hint small', 'Другие языки пока недоступны.')]); };
function paintNotifSub() {
  let s = 'выключены';
  if ($('notifSw').checked) s = !('Notification' in window) ? 'звук и счётчик во вкладке' : Notification.permission === 'granted' ? 'всплывающие и звук' : Notification.permission === 'denied' ? 'звук и счётчик (всплывающие запрещены в браузере)' : 'звук и счётчик во вкладке';
  txt($('notifSub'), s);
}
$('notifSw').onchange = async () => {
  const on = $('notifSw').checked; try { localStorage.setItem('local-msgr-notify', on ? '1' : '0'); } catch { /* */ }
  if (on && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* */ } }
  paintNotifSub(); toast(on ? 'Уведомления включены' : 'Уведомления выключены');
};
async function loadBlocks() {
  const ul = $('blockList'); ul.textContent = ''; ul.append(el('li', 'hint small', '…'));
  const { data, error } = await sb.from('blocks').select('blocked, created_at').eq('blocker', me.id).order('created_at', { ascending: false });
  ul.textContent = '';
  if (error) { ul.append(el('li', 'hint small', 'Не удалось загрузить: ' + ruErr(error))); return; }
  if (!data || !data.length) { ul.append(el('li', 'hint small', 'Никого')); return; }
  for (const b of data) { const li = el('li', '', '…'); ul.append(li); getProfile(b.blocked).then(p => txt(li, p ? displayName(p) + ' · @' + p.username : 'удалённый пользователь')); }
}
async function cacheBytes() { let n = 0; if ('caches' in window) for (const k of (await caches.keys()).filter(k => k.startsWith('msgr-local-'))) { const c = await caches.open(k); for (const r of await c.keys()) { const x = await c.match(r); if (x) n += (await x.clone().blob()).size; } } return n; }
async function paintStorage() { try { const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; txt($('storeVal'), est ? fmtSize(est.usage || 0) : '—'); } catch { txt($('storeVal'), '—'); } }
$('rowStorage').onclick = async () => {
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const cb = await cacheBytes().catch(() => 0), nAva = Object.keys(avaUrls).length, nProf = Object.keys(profiles).length;
  const btn = el('button', 'ghost', 'Очистить кэш'); btn.type = 'button';
  const info = el('p', 'hint small', 'Ключи шифрования и расшифрованная история хранятся отдельно и при очистке не удаляются.');
  btn.onclick = async () => {
    if ('caches' in window) for (const k of (await caches.keys()).filter(k => k.startsWith('msgr-local-'))) await caches.delete(k);
    for (const k of Object.keys(avaUrls)) delete avaUrls[k];
    for (const k of Object.keys(profiles)) if (k !== me.id) delete profiles[k];
    try { Object.keys(sessionStorage).filter(k => k.startsWith('local-msgr-')).forEach(k => sessionStorage.removeItem(k)); } catch { /* */ }
    $('sheetDlg').close(); toast('Кэш очищен'); paintStorage();
  };
  sheet('Хранилище', [kvRow('Всего занято сайтом', est ? fmtSize(est.usage || 0) : '—'), kvRow('Кэш файлов', fmtSize(cb)), kvRow('Ссылки на аватарки / профили в памяти', nAva + ' / ' + nProf), info, btn]);
};
$('rowTheme').onclick = () => { $('themeBox').hidden = !$('themeBox').hidden; };
$('rowHelp').onclick = () => toast('Сообщения и файлы шифруются на устройстве (Signal). Сервер их не видит. Профиль виден всем и не шифруется.');
$('pNick').oninput = () => { $('pNick').value = $('pNick').value.toLowerCase(); };
$('profForm').onsubmit = async e => {
  e.preventDefault();
  const name = $('pName').value.trim().replace(/\s+/g, ' '), nick = normNick($('pNick').value), bio = cleanBio($('pBio').value).trim();
  if (!name || name.length > 64) return txt($('profMsg'), 'Имя: от 1 до 64 символов');
  const oldNick = (profiles[me.id] || {}).username, nickChanged = nick !== oldNick;
  if (nickChanged && !/^[a-z0-9_]{5,32}$/.test(nick)) return txt($('profMsg'), 'От 5 до 32 символов: латиница, цифры и _');
  const upd = { display_name: name }; // имя пользователя меняется через set_username (account.js)
  if (profileExt) {
    upd.bio = bio || null; if (pickedColor && /^#[0-9a-fA-F]{6}$/.test(pickedColor)) upd.avatar_color = pickedColor;
    const letter = $('pLetter').value.trim();
    if (letter && (Array.from(letter).length > 2 || /[\s\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(letter))) return txt($('profMsg'), 'Буква аватара: 1–2 символа без пробелов');
    upd.avatar_letter = letter || null;
  }
  $('profSave').disabled = true; txt($('profMsg'), 'Сохраняем…');
  try {
    if (nickChanged) {
      const r = await window.saveProfileNick(nick);
      if (r !== 'ok') { txt($('profMsg'), r === 'taken' ? 'Только что заняли, выберите другое' : (window.NICK_MSG[r] || window.NICK_MSG.invalid)); return; }
    }
    const { error } = await sb.from('profiles').update(upd).eq('id', me.id);
    if (error) throw error;
    await refreshMe(); $('editCard').hidden = true; txt($('profMsg'), ''); toast('Сохранено');
  } catch (err) { txt($('profMsg'), ruErr(err)); }
  finally { $('profSave').disabled = false; }
};
async function refreshMe() {
  const p = await getProfile(me.id, true);
  txt($('me'), displayName(p)); fillAvatar($('meAva'), p); fillAvatar($('profAva'), p); $('avaRemoveBtn').hidden = !(p && p.avatar_url); if (p) paintProfHead(p);
}
$('avaPhotoBtn').onclick = () => $('avaFile').click();
$('avaFile').onchange = async () => {
  const f = $('avaFile').files[0]; $('avaFile').value = ''; if (!f) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) return toast('Нужна картинка JPEG, PNG, WebP или GIF');
  if (f.size > 2 * 1024 * 1024) return toast('Файл больше 2 МБ');
  $('avaPhotoBtn').disabled = true; toast('Загружаем фото…', 10000);
  try {
    const blob = await squareImage(f, 256);
    const old = (await getProfile(me.id, true)).avatar_url;
    const path = `${me.id}/${crypto.randomUUID()}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
    const { error } = await sb.storage.from('avatars').upload(path, blob, { contentType: blob.type, upsert: false });
    if (error) throw error;
    const { error: e2 } = await sb.from('profiles').update({ avatar_url: path }).eq('id', me.id);
    if (e2) { await sb.storage.from('avatars').remove([path]).catch(() => {}); throw e2; }
    if (old && old !== path) await sb.storage.from('avatars').remove([old]).catch(() => {});
    await refreshMe(); txt($('profMsg'), ''); toast('Фото обновлено', 3000);
  } catch (err) { txt($('profMsg'), 'Фото не загружено: ' + ruErr(err)); }
  finally { $('avaPhotoBtn').disabled = !profileExt; }
};
$('avaRemoveBtn').onclick = async () => {
  if (!confirm('Убрать фото профиля? Останется буква на цветном фоне.')) return;
  try {
    const old = (await getProfile(me.id, true)).avatar_url;
    const { error } = await sb.from('profiles').update({ avatar_url: null }).eq('id', me.id); if (error) throw error;
    if (old) await sb.storage.from('avatars').remove([old]).catch(() => {});
    await refreshMe(); txt($('profMsg'), ''); toast('Фото убрано', 3000);
  } catch (err) { txt($('profMsg'), ruErr(err)); }
};
/** Квадрат по центру, size×size, WebP (или JPEG, если браузер не умеет WebP). Метаданные (EXIF, геометка) отбрасываются. */
async function squareImage(file, size) {
  const bmp = await createImageBitmap(file).catch(() => { throw userErr('Не удалось открыть картинку'); });
  const s = Math.min(bmp.width, bmp.height), cv = document.createElement('canvas'); cv.width = cv.height = size;
  cv.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  const toBlob = t => new Promise(r => cv.toBlob(r, t, 0.85));
  let b = await toBlob('image/webp'); if (!b || b.type !== 'image/webp') b = await toBlob('image/jpeg');
  if (!b) throw userErr('Не удалось обработать картинку');
  return b;
}

// ---------- состояние ----------
let lastUid;
const domReady = new Promise(r => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, { once: true }) : r()); // media.js (кэш) загружен
async function onSession(session) {
  await domReady;
  const uid = session ? session.user.id : null;
  if (lastUid !== undefined && uid === lastUid) { me = session ? session.user : null; return; }
  lastUid = uid;
  me = session ? session.user : null;
  $('auth').hidden = !!me; $('app').hidden = !me;
  { const pw = $('password'); if (pw) pw.value = ''; }
  if (!me) { loginPass = null; window.clearLocalCache?.(); $('app').classList.remove('in-settings', 'in-chat'); currentChat = null; if (location.hash) history.replaceState(null, '', location.pathname + location.search); } // пароль не остаётся в поле ни после входа, ни после выхода
  if (me) {
    if (pwRecovery) setTimeout(showPwRecovery, 0);
    stopQr();
    refreshMe().catch(() => txt($('me'), me.email || '')); watchProfiles(); touchPresence();
    { const m = /^#(profile|settings)$/.exec(location.hash); if (m) openSettings(false, m[1]); else setNav('chats'); }
    e2eStart().then(ok => { deviceCheck(true); if (!ok) return; if (loginPass) autoBackupV2().catch(e => console.warn('backup v2', e)); else if (E2E.isFreshDevice && E2E.isFreshDevice()) offerRestore(); });
    paintBackupRow();
    Promise.resolve(window.chatsFromCache?.()).finally(() => loadChats());
    window.pushSubscribe?.();
  } else { currentChat = null; $('app').classList.remove('in-chat', 'in-settings'); qrFails = 0; startQr(); }
}
// Один общий перезапуск Realtime на все каналы; сессия отозвана — выходим, без переподключений по кругу
let sessionGone = false, rtRecovering = null;
function rtRecover() {
  if (sessionGone) return Promise.resolve(false);
  if (!rtRecovering) rtRecovering = sb.auth.refreshSession()
    .then(({ data, error }) => { const t = data && data.session && data.session.access_token; if (error && isNetErr(error)) return false; if (error || !t) { sessionEnded(error); return false; } return rtAuth(t).then(() => true); })
    .catch(e => { if (!isNetErr(e)) sessionEnded(e); return false; })
    .finally(() => { setTimeout(() => { rtRecovering = null; }, 10000); });
  return rtRecovering;
}
const isNetErr = e => !!e && (e.name === 'AuthRetryableFetchError' || e.status === 0 || /fetch|network/i.test(e.message || ''));
// Баннер на экране входа: сеанс удалён на сервере (с другого устройства) или просто истёк. Выход пользователем — без баннера.
let userSignOut = false;
function endedBanner(err) {
  const code = err && (err.code || ''), m = (err && err.message) || '';
  const remote = /session_not_found|refresh_token_not_found/.test(code) || /session.*not found|refresh token not found/i.test(m);
  txt($('endedText'), remote ? 'Сеанс завершён с другого устройства. Войдите снова.' : 'Сеанс истёк. Войдите снова.');
  $('endedBanner').hidden = false;
}
async function sessionEnded(err) {
  if (sessionGone) return;
  // перепроверяем: временная ошибка обновления (особенно при загрузке) не повод выходить
  const remote = err && (/session_not_found|refresh_token_not_found/.test(err.code || '') || /session.*not found|refresh token not found/i.test(err.message || ''));
  if (!remote) {
    try { const { data, error } = await sb.auth.refreshSession(); if (data && data.session && !error) return; if (error && isNetErr(error)) return; } catch (e) { if (isNetErr(e)) return; }
  }
  if (sessionGone) return; sessionGone = true; endedBanner(err);
  try { sb.removeAllChannels(); } catch (e) { /* */ } chan = null; profChan = null; inboxChan = null;
  // ключи не трогаем (правило 30 дней: rebind_device вернёт устройство при следующем входе)
  await endSession();
  onSession(null);
}
async function rtAuth(token) {
  try { if (!token) { const { data } = await sb.auth.getSession(); token = data.session && data.session.access_token; } if (token) await sb.realtime.setAuth(token); }
  catch (e) { console.warn('realtime setAuth', e); }
}
sb.auth.onAuthStateChange((e, s) => {
  if (e === 'PASSWORD_RECOVERY') { pwRecovery = true; if (s) setTimeout(showPwRecovery, 0); }
  if (s && (e === 'TOKEN_REFRESHED' || e === 'SIGNED_IN')) rtAuth(s.access_token);
  // SIGNED_OUT не от пользователя: баннер, только если сессии действительно нет после перепроверки
  if (e === 'SIGNED_OUT' && !userSignOut && !sessionGone && me) setTimeout(async () => { try { const { data } = await sb.auth.getSession(); if (!data.session && !userSignOut && !me) endedBanner(null); } catch (x) { /* */ } }, 800);
  if (e === 'SIGNED_OUT') { userSignOut = false; sb.removeAllChannels(); chan = null; profChan = null; inboxChan = null; }
  if (e === 'SIGNED_IN') { sessionGone = false; $('endedBanner').hidden = true; }
  onSession(s);
});
// Вкладка вернулась из фона: если токен истёк (таймеры в фоне спят) — обновляем сессию и Realtime
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !me) return;
  try {
    const { data } = await sb.auth.getSession(); const s = data.session;
    if (s && s.expires_at && s.expires_at * 1000 < Date.now() + 60000) { await rtRecover(); }
  } catch (e) { console.warn('refresh on visible', e); }
});
sb.auth.getSession().then(({ data }) => onSession(data.session));

// ---------- резервная копия переписки (docs/backup_format.md, общий формат с Android) ----------
const BK_MIN = 12; // как в docs/backup_format.md (общий с приложением)
let bkRow; // строка key_backups или null
async function getBackupRow() { const { data, error } = await sb.from('key_backups').select('*').eq('user_id', me.id).maybeSingle(); if (error) throw error; bkRow = data; return data; }
async function paintBackupRow() {
  try { const r = await getBackupRow(); txt($('backupSub'), r ? fmtDT(r.updated_at) + ' · ' + fmtSize(r.size_bytes) : 'не создана'); }
  catch { txt($('backupSub'), 'не удалось загрузить'); }
}
function passInput(ph) { const i = el('input'); i.type = 'password'; i.placeholder = ph; i.autocomplete = 'new-password'; i.minLength = BK_MIN; return i; }
async function collectMessages(progress) {
  const out = [];
  const chats = lastChats.slice();
  for (let ci = 0; ci < chats.length; ci++) {
    let before = null;
    for (;;) {
      let q = sb.from('messages').select('*').eq('chat_id', chats[ci].id).order('created_at', { ascending: false }).limit(500);
      if (before) q = q.lt('created_at', before);
      const { data, error } = await q; if (error) throw error;
      if (!data || !data.length) break;
      for (const m of data) {
        if (!m.ciphertext) continue;
        let pl = await decryptPayload(m);
        if (!pl || pl.fail || pl.other) { const c = E2E && await E2E.cachedPlain(m.id); pl = c ? parsePayload(c) : null; }
        if (pl && !pl.fail && !pl.other) out.push(Backup.toEntry(m, pl));
      }
      before = data[data.length - 1].created_at;
      progress(`Чат ${ci + 1} из ${chats.length} · сообщений: ${out.length}`);
      if (data.length < 500) break;
    }
  }
  return out;
}
async function createBackup(pass, progress) {
  if (!(await e2eStart())) throw userErr('Шифрование не запущено');
  const row = await getBackupRow();
  const salt = row ? row.salt : Backup.newSalt(), kdf = row && row.kdf && row.kdf.alg === 'argon2id' ? row.kdf : Backup.DEFAULT_KDF;
  progress('Собираем сообщения…');
  const messages = await collectMessages(progress);
  if (!messages.length && !(await askConfirm('В копию не попадёт ни одного сообщения: на этом устройстве нет расшифрованной переписки. Всё равно создать?', 'Создать'))) throw userErr('Отменено');
  progress('Шифруем копию…');
  if (loginPass) return uploadV2(messages);
  const key = await Backup.deriveKey(pass, salt, kdf);
  const bin = await Backup.seal({ v: 1, uid: me.id, created_at: new Date().toISOString(), messages }, key, me.id);
  if (bin.length > 104857600) throw userErr('Копия больше 100 МБ');
  // одна копия на аккаунт: не затираем молча более полную (например, с другого устройства)
  if (row && row.size_bytes && bin.length < row.size_bytes * 0.8 && !(await askConfirm(`Новая копия (${fmtSize(bin.length)}) меньше прежней (${fmtSize(row.size_bytes)}). Возможно, на этом устройстве нет части переписки. Сначала лучше восстановить прежнюю копию. Всё равно заменить?`, 'Заменить'))) throw userErr('Отменено');
  progress('Загружаем…');
  const path = me.id + '/backup.bin';
  const { error } = await sb.storage.from('backups').upload(path, new Blob([bin], { type: 'application/octet-stream' }), { contentType: 'application/octet-stream', upsert: true });
  if (error) throw error;
  const { error: e2 } = await sb.from('key_backups').upsert({ user_id: me.id, version: 1, salt, kdf, object_path: path, size_bytes: bin.length, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (e2) throw e2;
  return messages.length;
}
async function restoreBackup(pass, progress) {
  const row = await getBackupRow(); if (!row) throw userErr('Резервной копии нет');
  if (!(await e2eStart())) throw userErr('Шифрование не запущено');
  progress('Скачиваем копию…');
  const { data, error } = await sb.storage.from('backups').download(row.object_path); if (error) throw error;
  progress('Проверяем фразу…');
  const key = await Backup.deriveKey(pass, row.salt, row.kdf);
  const o = await Backup.open(await data.arrayBuffer(), key, me.id);
  progress('Добавляем сообщения…');
  const n = await E2E.importPlain(o.messages.map(Backup.toCache).filter(Boolean));
  // перерисовываем: старые сообщения теперь берутся из кэша как открытый текст
  await loadChats().catch(() => {});
  if (currentChat) { const li = document.querySelector(`#chatList li[data-id="${currentChat.id}"]`); if (li) { currentChat = null; li.click(); } }
  return { total: o.messages.length, added: n };
}
function backupSheet(first) {
  const row = bkRow, nodes = [];
  // ключи были на этом устройстве и не перенеслись (rebind отказал) — прежний текст; совсем новое устройство — мягкий
  const lost = !!(E2E && E2E.rebindFailed && E2E.rebindFailed());
  if (first) nodes.push(el('p', '', lost ? 'Ключи этого устройства не удалось перенести. Старую переписку можно вернуть из резервной копии.' : 'Это новое устройство. Старую переписку можно вернуть из резервной копии.'));
  nodes.push(kvRow('Последняя копия', row ? fmtDT(row.updated_at) + ' · ' + fmtSize(row.size_bytes) : 'не создана'));
  nodes.push(el('p', 'hint small', `Копия шифруется на этом устройстве фразой (не паролем от аккаунта, минимум ${BK_MIN} символов). Фразу нельзя восстановить: если забудете её, копию не открыть. Ключи шифрования в копию не входят.`));
  const p1 = passInput('Фраза'), p2 = passInput('Фраза ещё раз (для новой копии)');
  const st = el('p', 'hint small'); st.setAttribute('aria-live', 'polite');
  const bc = el('button', '', 'Создать копию'); bc.type = 'button';
  const br = el('button', 'ghost', 'Восстановить'); br.type = 'button'; br.hidden = !row;
  const later = el('button', 'link', 'Позже'); later.type = 'button'; later.hidden = !first; later.onclick = () => $('sheetDlg').close();
  const busy = on => { bc.disabled = br.disabled = p1.disabled = p2.disabled = on; };
  bc.onclick = async () => {
    if (p1.value.length < BK_MIN) return txt(st, `Фраза должна быть не короче ${BK_MIN} символов`);
    if (p1.value !== p2.value) return txt(st, 'Фразы не совпадают');
    busy(true);
    try { const n = await createBackup(p1.value, s => txt(st, s)); txt(st, ''); p1.value = p2.value = ''; toast(`Копия создана: ${n} сообщ.`, 3000); $('sheetDlg').close(); paintBackupRow(); }
    catch (e) { if (e.userMsg === 'Отменено') { txt(st, ''); return; } st.classList.add('err'); txt(st, 'Копия не создана: ' + (e.userMsg || ruErr(e))); }
    finally { busy(false); }
  };
  br.onclick = async () => {
    if (!p1.value) return txt(st, 'Введите фразу');
    busy(true);
    p1.classList.remove('bad'); st.classList.remove('err');
    try {
      const r = await restoreBackup(p1.value, s => txt(st, s)); txt(st, ''); p1.value = p2.value = ''; $('sheetDlg').close();
      if (r.total) toast('Восстановлено ' + r.total + ' ' + plural(r.total, 'сообщение', 'сообщения', 'сообщений'), 3000); else toast('В копии нет сообщений', 3000);
    } catch (e) {
      // ошибка — внутри диалога (тост под модальным окном не виден); фраза остаётся
      st.classList.add('err');
      if (e instanceof Backup.BadPass) { txt(st, 'Неверная фраза'); p1.classList.add('bad'); }
      else txt(st, 'Не удалось восстановить: ' + (e.userMsg || ruErr(e)));
    } finally { busy(false); if (st.classList.contains('err')) p1.focus(); }
  };
  if (first) { bc.hidden = true; p2.hidden = true; br.textContent = 'Восстановить из копии'; br.className = ''; }
  const acts = el('div', 'bk-actions'); acts.append(bc, br, later);
  nodes.push(p1, p2, st, acts);
  sheet(first ? 'Восстановить переписку?' : 'Резервная копия', nodes);
}
$('rowBackup').onclick = async () => { try { await getBackupRow(); } catch (e) { return toast('Не удалось загрузить: ' + ruErr(e), 3000); } backupSheet(false); };
// «Восстановить переписку?» — один раз после регистрации новых ключей, если на сервере есть копия; отказ помним для uid+устройства
let restoreOffered = null; // uid, для которого уже предлагали в этой сессии страницы
async function offerRestore() {
  if (!me || restoreOffered === me.id) return; restoreOffered = me.id;
  const k = 'local-msgr-restore-offered:' + me.id; // «Позже» / показ — больше не предлагаем этому аккаунту в этом браузере
  try { if (localStorage.getItem(k) || sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch (e) { /* */ }
  try { if (await getBackupRow()) { try { localStorage.setItem(k, '1'); } catch (e) { /* */ } backupSheet(true); } } catch (e) { console.warn('key_backups', e); }
}

// ---------- копия v2 (BACKUP_FORMAT.md): шифруется паролем входа, восстанавливается молча ----------
// KDF-вход: UTF-8("ml-backup-v2:" + uid + ":" + пароль). Пароль хранится только в памяти этой вкладки.
var loginPass = null;
const BK_FAIL = 'Не удалось скачать копию, попробуйте позже';
const earlyKey = () => 'local-msgr-early-skip:' + (me && me.id);
function earlySkipped() { try { return localStorage.getItem(earlyKey()) === '1'; } catch { return false; } }
async function downloadBackup(path) { // null — копии нет; повтор при 500/544 до 3 раз
  for (let i = 0; ; i++) {
    const { data, error } = await sb.storage.from('backups').download(path);
    if (!error) return new Uint8Array(await data.arrayBuffer());
    const st = Number(error.statusCode || error.status || (error.originalError && error.originalError.status) || 0);
    if (st === 404 || st === 400 || /not.?found/i.test(error.message || '')) return null;
    if (i >= 2 || !(st === 500 || st === 544 || !st)) throw userErr(BK_FAIL);
    await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
}
async function uploadV2(messages) {
  const bin = await Backup.encodeV2({ v: 1, uid: me.id, created_at: new Date().toISOString(), messages }, loginPass, me.id);
  const path = me.id + '/backup.bin';
  const { error } = await sb.storage.from('backups').upload(path, new Blob([bin], { type: 'application/octet-stream' }), { contentType: 'application/octet-stream', upsert: true });
  if (error) throw error;
  const { error: e2 } = await sb.from('key_backups').upsert({ user_id: me.id, version: 2, salt: Backup.b64e(bin.slice(10, 26)), kdf: { alg: 'argon2id', m: Backup.DEFAULT_KDF.m, t: Backup.DEFAULT_KDF.t, p: 1 }, object_path: path, size_bytes: bin.length, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (e2) throw e2;
  return messages.length;
}
async function saveV2() { if (!loginPass || !me || !(await e2eStart())) return; return uploadV2(await collectMessages(() => {})); }
async function importBackup(o) {
  await E2E.importPlain(o.messages.map(Backup.toCache).filter(Boolean));
  await loadChats().catch(() => {});
  if (currentChat) { const li = document.querySelector(`#chatList li[data-id="${currentChat.id}"]`); if (li) { currentChat = null; li.click(); } }
}
let v2Ran = null;
async function autoBackupV2() {
  if (!me || !loginPass || v2Ran === me.id) return; v2Ran = me.id;
  const row = await getBackupRow().catch(() => null);
  let bin; try { bin = await downloadBackup((row && row.object_path) || me.id + '/backup.bin'); } catch (e) { toast(BK_FAIL, 3000); return; }
  if (!bin) return saveV2();
  if (Backup.isV2(bin)) {
    try { await importBackup(await Backup.decodeV2(bin, loginPass, me.id)); }
    catch (e) { console.warn('backup v2 decode', e && e.message); return; } // не наш пароль — копию не трогаем
    return saveV2();
  }
  if (earlySkipped()) return;
  migrateSheet(bin, row);
}
function migrateSheet(bin, row) {
  const p = el('input'); p.type = 'password'; p.placeholder = 'Пароль'; p.autocomplete = 'off';
  const st = el('p', 'hint small'); st.setAttribute('aria-live', 'polite');
  const go = el('button', '', 'Перенести'); go.type = 'button';
  const skip = el('button', 'link gray', 'Не помню — пропустить'); skip.type = 'button';
  go.onclick = async () => {
    if (!p.value || !row) return; go.disabled = true; st.classList.remove('err'); txt(st, '');
    try {
      const key = await Backup.deriveKey(p.value, row.salt, row.kdf);
      const o = await Backup.open(bin, key, me.id);
      await importBackup(o); p.value = '';
      try { localStorage.removeItem(earlyKey()); } catch { /* */ }
      $('sheetDlg').close(); toast('История восстановлена', 3000);
      saveV2().catch(e => console.warn('backup v2', e)); // больше этот экран не появится: копия уже v2
    } catch (e) { st.classList.add('err'); txt(st, e instanceof Backup.BadPass ? 'Неверный пароль' : BK_FAIL); }
    finally { go.disabled = false; }
  };
  skip.onclick = () => { try { localStorage.setItem(earlyKey(), '1'); } catch { /* */ } $('sheetDlg').close(); if (currentChat) { const li = document.querySelector(`#chatList li[data-id="${currentChat.id}"]`); if (li) { currentChat = null; li.click(); } } };
  const acts = el('div', 'bk-actions'); acts.append(go, skip);
  sheet('Перенести старую переписку', [el('p', '', 'Введите пароль, который вы задавали для резервной копии. Это нужно один раз'), p, st, acts]);
}
// ключи/сессии изменились — копия v2 обновляется сама (не чаще раза в минуту), если пароль входа есть в памяти
let v2Timer = null;
addEventListener('e2e-changed', () => { if (!loginPass || v2Ran !== (me && me.id)) return; clearTimeout(v2Timer); v2Timer = setTimeout(() => saveV2().catch(e => console.warn('backup v2', e)), 60000); });
