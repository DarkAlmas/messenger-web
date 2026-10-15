const C = window.MSG_CONFIG;
const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: true, storageKey: 'msgr-auth', autoRefreshToken: false, detectSessionInUrl: false } });
const $ = id => document.getElementById(id);
// Одна сессия (= одно устройство E2E) на браузер: сессия в localStorage, токен обновляет только одна вкладка-лидер.
try { sessionStorage.removeItem('msgr-auth'); } catch (e) { /* старая версия хранила сессию во вкладке */ }
if (navigator.locks) navigator.locks.request('msgr-auth-leader', () => { sb.auth.startAutoRefresh(); return new Promise(() => {}); });
else sb.auth.startAutoRefresh();
let me = null, regMode = false, currentChat = null, chan = null, qrTimer = null;
const names = {};
const olderBtn = document.getElementById('olderBtn'); // ссылка сохраняется: кнопка переносится при очистке списка сообщений

function txt(el, s) { el.textContent = s; }
// ---------- видимые ошибки: ничего не падает молча ----------
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
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) txt($('authMsg'), ruErr(error));
    }
  } catch (err) { txt($('authMsg'), ruErr(err)); }
  finally { btn.disabled = false; }
};
['email','password','username'].forEach(id => $(id).addEventListener('input', () => txt($('authMsg'), '')));
const NET_ERR = 'Нет соединения с сервером';
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
  userSignOut = true; try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* локальную сессию всё равно чистим */ } };
/** Сеанс этого устройства отозван (revoke_device удаляет ключи сразу): стираем локальные ключи и выходим */
async function doLogout() {
  try { if (E2E && E2E.deviceId()) { await sb.from('devices_keys').delete().eq('device_id', E2E.deviceId()); await E2E.wipe(); } } catch (e) { /* не мешаем выходу */ }
  userSignOut = true; try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* сеть недоступна — локальную сессию всё равно чистим */ } }

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
async function startQr() {
  stopQr();
  if (me) return;
  const gen = ++qrGen;
  qrState('loading', 'Получаем QR…');
  let q;
  try { q = await fn('qr-create'); } catch (e) { if (gen === qrGen && !me) qrFail(e); return; }
  if (gen !== qrGen || me) return;
  if (!q || !/^[0-9a-f]{64}$/.test(q.token || '')) return qrFail(null);
  qrFails = 0;
  const qr = qrcode(0, 'M'); qr.addData(JSON.stringify({ t: 'msgr-login', v: 1, token: q.token })); qr.make();
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
      if (s && s.access_token && s.refresh_token) await sb.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
    } else if (p.status === 'denied') { stopQr(); qrState('error', 'Вход отклонён на телефоне.'); }
    else if (p.status === 'expired') { stopQr(); qrState('error', 'Срок действия QR истёк.'); }
  }, 3000);
}

// ---------- чаты ----------
let lastChats = [], showArchive = false;
const fmtListTime = t => { const d = new Date(t), n = new Date(); if (d.toDateString() === n.toDateString()) return fmtTime(t); if (n - d < 6 * 864e5) return d.toLocaleDateString('ru-RU', { weekday: 'short' }); return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }); };
const isMuted = c => c.muted_until && new Date(c.muted_until) > new Date();
async function loadChats() {
  const ul = $('chatList');
  const [{ data, error }, { data: prefs, error: pe }] = await Promise.all([
    sb.rpc('list_chats'),
    sb.from('chat_members').select('chat_id, pinned, muted_until, archived, role').eq('user_id', me.id)
  ]);
  if (error || pe) { showErr('Не удалось загрузить чаты: ' + ruErr(error || pe)); return; }
  const pm = {}; for (const p of prefs || []) pm[p.chat_id] = p;
  lastChats = (data || []).map(c => ({ id: c.chat_id, kind: c.kind, title: c.kind === 'direct' ? null : c.title, name: c.title, peer: c.peer_id, last_at: c.last_at, last_sender: c.last_sender, last_has_file: c.last_has_file, unread: c.unread, ...(pm[c.chat_id] || {}) }));
  lastChats.sort((x, y) => (y.pinned ? 1 : 0) - (x.pinned ? 1 : 0) || new Date(y.last_at) - new Date(x.last_at));
  const archived = lastChats.filter(c => c.archived), visible = lastChats.filter(c => !!c.archived === showArchive);
  ul.innerHTML = '';
  if (showArchive) {
    const li = document.createElement('li'); li.className = 'archive-row'; li.tabIndex = 0;
    const ava = avatarEl({ display_name: '←', id: 'x' }); txt(ava, 'arrow_back'); ava.classList.add('ms');
    const meta = document.createElement('div'); meta.className = 'meta'; const nm = document.createElement('div'); nm.className = 'name'; txt(nm, 'Архив'); const sub = document.createElement('div'); sub.className = 'sub'; txt(sub, 'Назад ко всем чатам'); meta.append(nm, sub);
    li.append(ava, meta); li.onclick = () => { showArchive = false; loadChats(); }; ul.append(li);
  } else if (archived.length) {
    const li = document.createElement('li'); li.className = 'archive-row'; li.tabIndex = 0; li.dataset.archive = '1';
    const ava = avatarEl({ display_name: '🗄', id: 'x' }); txt(ava, 'archive'); ava.classList.add('ms');
    const meta = document.createElement('div'); meta.className = 'meta'; const nm = document.createElement('div'); nm.className = 'name'; txt(nm, 'Архив'); const sub = document.createElement('div'); sub.className = 'sub'; txt(sub, archived.length + ' ' + plural(archived.length, 'чат', 'чата', 'чатов')); meta.append(nm, sub);
    li.append(ava, meta);
    const un = archived.reduce((s, c) => s + (c.unread || 0), 0);
    if (un) { const b = document.createElement('span'); b.className = 'badge muted'; txt(b, String(un)); li.append(b); }
    li.onclick = () => { showArchive = true; loadChats(); }; ul.append(li);
  }
  for (const c of visible) {
    const li = document.createElement('li');
    li.dataset.id = c.id; li.tabIndex = 0;
    const ava = avatarEl(c.peer ? null : { display_name: c.name || '?', id: c.id });
    const meta = document.createElement('div'); meta.className = 'meta';
    const nm = document.createElement('div'); nm.className = 'name'; txt(nm, c.kind === 'direct' ? (c.name || 'Личный чат') : (c.name || 'Группа'));
    const sub = document.createElement('div'); sub.className = 'sub';
    txt(sub, c.last_sender ? (c.last_sender === me.id ? 'Вы: ' : '') + (c.last_has_file ? 'Файл' : '🔒 зашифрованное сообщение') : 'Нет сообщений');
    if (c.last_sender && c.last_has_file) { sub.prepend(msIcon('description', 'sub-ic')); filePreviewSoon(c, sub); }
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
const notifOn = () => { try { return localStorage.getItem('msgr-notify') !== '0'; } catch { return true; } };
function clearBadge() { if (document.visibilityState === 'visible') { unseen = 0; document.title = baseTitle; } }
function beep() { try { const x = new AudioContext(), o = x.createOscillator(), g = x.createGain(); o.frequency.value = 880; g.gain.value = 0.05; o.connect(g); g.connect(x.destination); o.start(); o.stop(x.currentTime + 0.12); o.onended = () => x.close(); } catch { /* без звука */ } }
/** Новые сообщения во всех моих чатах (RLS отдаёт только их): обновить список и уведомить. */
function watchInbox() {
  if (inboxChan) sb.removeChannel(inboxChan);
  inboxChan = sb.channel('inbox').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => { const m = p.new; if (!m || !me || m.sender_id === me.id) return; if (!currentChat || m.chat_id !== currentChat.id) loadChatsSoon(); notifyMsg(m).catch(() => {}); }).subscribe();
}
async function notifyMsg(m) {
  if (!notifOn()) return;
  if (currentChat && currentChat.id === m.chat_id && document.visibilityState === 'visible' && !$('app').classList.contains('in-settings')) return;
  const c = lastChats.find(x => x.id === m.chat_id); if (c && isMuted(c)) return;
  if (document.visibilityState !== 'visible') { unseen++; document.title = `(${unseen}) ${baseTitle}`; }
  beep();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  let text = 'Новое сообщение';
  if (m.ciphertext) { const pl = await decryptPayload(m); if (pl && !pl.fail && !pl.other) text = pl.t || (pl.f ? 'Файл' : text); }
  let title = c ? (c.title || c.name || 'Мессенджер') : 'Мессенджер';
  if (c && c.peer) { const p = await getProfile(c.peer); if (p) title = displayName(p); }
  const n = new Notification(title, { body: text.slice(0, 200), tag: 'chat-' + m.chat_id, renotify: true });
  n.onclick = () => { window.focus(); const li = document.querySelector(`#chatList li[data-id="${m.chat_id}"]`); if (li) li.click(); n.close(); };
}
document.addEventListener('visibilitychange', clearBadge);
function toastLong(s) { toast(String(s), 4000); }
function toast(s, ms = 2500) { const t = $('toast'); txt(t, s); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); }

// ---------- контекстное меню (правый клик / долгое нажатие) ----------
function openMenu(e, items) {
  const m = $('ctxMenu'); m.textContent = '';
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; m.append(s); continue; }
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); if (it.danger) b.className = 'danger-item';
    const ic = document.createElement('span'); ic.setAttribute('aria-hidden', 'true'); ic.className = 'ms'; txt(ic, it.i || ''); const tx = document.createElement('span'); txt(tx, it.t);
    b.append(ic, tx); b.dataset.act = it.t;
    b.onclick = () => { closeMenu(); Promise.resolve().then(it.f).catch(err => toastLong(err.userMsg || ruErr(err))); };
    m.append(b);
  }
  m.hidden = false;
  const pt = e.touches ? e.touches[0] : e;
  const x = pt.clientX || 20, y = pt.clientY || 20, r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
  const first = m.querySelector('button'); if (first) first.focus({ preventScroll: true });
}
function closeMenu() { $('ctxMenu').hidden = true; }
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
const e2eMod = import('./e2e.js?v=20261015zh2').then(m => { m.init(sb); return (E2E = m); });
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
  catch (e) { showErr('Не удалось проверить ключи шифрования этого устройства: ' + ruErr(e)); }
}
setInterval(() => deviceCheck(true), 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') deviceCheck(false); });
window.addEventListener('focus', () => deviceCheck(false));
async function e2eStart() {
  try { const m = await e2eMod; await m.ensureReady(); e2eErr = null; }
  catch (e) { e2eErr = e; console.warn('E2E недоступно:', e); showErr(e && e.userMsg ? e.userMsg : 'Шифрование на этом устройстве не запустилось: ' + ruErr(e) + '. Отправка сообщений невозможна, обновите страницу (Ctrl+F5).'); }
  return E2E && !e2eErr;
}
const sentOwn = {}; // подпись шифротекста → открытый текст (своё сообщение приходит по Realtime раньше, чем сохранится копия)
const ctSig = c => c && (c.sk || Object.values(c).map(x => x && x.b).sort()[0]);
function parsePayload(pt) {
  let o; try { o = JSON.parse(pt); } catch { return { t: pt }; }
  if (!o || typeof o !== 'object') return { t: String(pt) };
  // caption — подпись к вложению (отдельное поле того же payload; старые клиенты его игнорируют). t — показываемый текст
  const f = o.f && typeof o.f === 'object' ? o.f : null, cap = f && typeof o.caption === 'string' ? o.caption.slice(0, 4000) : '';
  return { t: (o.t || '') || cap, t0: o.t || '', caption: cap, f, fw: typeof o.fw === 'string' ? o.fw.slice(0, 64) : null };
}
async function decryptPayload(m) {
  const sig = ctSig(m.ciphertext);
  if (sig && sentOwn[sig]) return parsePayload(sentOwn[sig]);
  if (!(await e2eStart())) return null;
  try {
    if (m.ciphertext.sk !== undefined) {
      try { return parsePayload(await E2E.decryptGroup(m.chat_id, m)); }
      catch (e) { if (!(e instanceof E2E.NoKey)) throw e; await E2E.receive(m.chat_id); return parsePayload(await E2E.decryptGroup(m.chat_id, m)); }
    }
    const pt = await E2E.decryptDM(m);
    return pt == null ? { other: true } : parsePayload(pt);
  } catch (e) { console.warn('decrypt', m.id, e); return { fail: true }; }
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
    pl = await decryptPayload(m);
    if (pl && !pl.other && !pl.fail) {
      txt(b, pl.t); if (!pl.t) b.hidden = true;
      if (pl.f) {
        const fb = fileRow(pl.f, !mine);
        const pv = imagePreview(pl.f, pl.t, !mine, bad => { pv.replaceWith(bad ? brokenRow(pl.f) : fb); d.classList.remove('has-img', 'img-only'); });
        if (pv) { d.insertBefore(pv, b); d.classList.add('has-img'); if (!pl.t) d.classList.add('img-only'); } // подпись под картинкой; скачать — в просмотре
        else d.append(fb);
      }
      lock.className = 'lock'; lock.title = 'Сквозное шифрование'; txt(lock, '🔒');
    } else { b.className = 'body e2e'; txt(b, pl && pl.other ? 'зашифровано для другого устройства' : pl && pl.fail ? 'не удалось расшифровать' : 'зашифровано, откройте в приложении'); lock.className = 'lock'; txt(lock, '🔒'); }
  } else {
    txt(b, m.body);
    lock.className = 'noe2e'; lock.title = 'Старое сообщение без шифрования'; txt(lock, '⚠ не зашифровано');
  }
  msgData[m.id] = { m, pl: pl && !pl.other && !pl.fail ? pl : null };
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
  if (mine) { const t = document.createElement('span'); t.className = 'ticks'; foot.append(t); }
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
  items.push({ t: 'Ответить', i: 'reply', f: () => startReply(id) });
  for (const e of REACT_EMOJI) { const had = (reacts[id] || []).some(r => r.user_id === me.id && r.emoji === e); items.push({ t: (had ? 'Убрать ' : 'Реакция ') + e, i: e, f: () => toggleReact(id, e) }); }
  items.push('-');
  if (x.pl) items.push({ t: 'Переслать', i: 'forward', f: () => openForward(id) });
  if (canPin()) items.push(pins.includes(id) ? { t: 'Открепить', i: 'push_pin', f: () => pinMsg(id, false) } : { t: 'Закрепить', i: 'push_pin', f: () => pinMsg(id, true) });
  if (mine && x.pl && !x.pl.f && m.ciphertext) items.push({ t: 'Изменить', i: 'edit', f: () => startEdit(id) });
  if (x.pl && x.pl.t) items.push({ t: 'Копировать текст', i: 'content_copy', f: () => navigator.clipboard.writeText(x.pl.t).then(() => toast('Текст скопирован')) });
  if (mine) items.push('-', { t: 'Удалить у всех', i: 'delete', danger: true, f: () => deleteMsg(id) });
  return items;
}
function wireMsg(d) {
  const id = () => d.dataset.id;
  d.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(e, msgMenuItems(id())); });
  d.addEventListener('dblclick', e => { if (e.target.closest('button')) return; window.getSelection && window.getSelection().removeAllRanges(); startReply(id()); });
  longPress(d, e => openMenu(e, msgMenuItems(id())));
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
  if (x.pl && x.pl.f && x.pl.f.p) await sb.storage.from('chat-files').remove([x.pl.f.p]).catch(() => {});
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
      await sendFile(target, new File([plain], x.pl.f.n || 'file', { type: x.pl.f.m || 'application/octet-stream' }), { forwarded: true }, x.pl.caption || x.pl.t || '', fw);
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
  lastSeen = error ? undefined : data; paintSub();
}
function paintSub() {
  const s = $('chatSub'); s.className = '';
  if (!currentChat) return txt(s, '');
  if (Date.now() < typingUntil) { s.className = 'typing'; txt(s, (currentChat.kind === 'direct' ? '' : (typingWho ? typingWho + ' ' : '')) + 'печатает'); const d = document.createElement('span'); d.className = 'typing-dots'; d.setAttribute('aria-hidden', 'true'); d.append(document.createElement('i'), document.createElement('i'), document.createElement('i')); s.append(d); s.setAttribute('aria-label', s.textContent + '…'); return; }
  s.removeAttribute('aria-label');
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
function paintSeenSeg(v) { try { localStorage.setItem('msgr-seen', v); } catch { /* */ } txt($('seenVal'), { everyone: 'Все', contacts: 'Мои контакты', nobody: 'Никто' }[v] || ''); document.querySelectorAll('#seenSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v))); }
document.querySelectorAll('#seenSeg button').forEach(b => {
  b.onclick = async () => {
    const { error } = await sb.from('profiles').update({ last_seen_visibility: b.dataset.v }).eq('id', me.id);
    if (error) return txt($('seenMsg'), ruErr(error));
    txt($('seenMsg'), ''); clearNetNotice();
    profiles[me.id] = { ...(profiles[me.id] || {}), last_seen_visibility: b.dataset.v }; paintSeenSeg(b.dataset.v); toast('Сохранено');
  };
});

async function addMsg(m) {
  if (msgEls[m.id]) return updMsg(m);
  const d = document.createElement('div'); d.dataset.id = m.id; msgEls[m.id] = d;
  const box = $('messages'); box.appendChild(d);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  await renderMsg(m, d);
  if (nearBottom || m.sender_id === me.id) box.scrollTop = box.scrollHeight;
  else if (m.sender_id !== me.id && m.created_at > (msgData.__openedAt || '')) { jumpUnread++; }
  paintJump();
}
async function updMsg(m) { const d = msgEls[m.id]; if (d) await renderMsg(m, d); }
async function openChat(c, li) {
  currentChat = c; readState = {}; lastMarked = 0; pins = []; pinIdx = 0; jumpUnread = 0; lastSeen = undefined; typingUntil = 0; cancelCompose(); closeMenu();
  for (const k of Object.keys(msgData)) delete msgData[k];
  for (const k of Object.keys(reacts)) delete reacts[k];
  msgData.__openedAt = new Date().toISOString();
  $('pinBar').hidden = true; $('jumpBtn').hidden = true; $('chatMenuBtn').hidden = false; txt($('chatSub'), '');
  document.querySelectorAll('#chatList li').forEach(x => x.classList.remove('active')); li.classList.add('active');
  const badge = li.querySelector('.badge'); if (badge) badge.remove();
  $('app').classList.add('in-chat'); $('app').classList.remove('in-settings');
  if (location.hash !== '#chat') history.pushState({ v: 'chat' }, '', '#chat');
  chatHasE2e = false; peerId = c.peer || null; peerUnknown = false;
  for (const k of Object.keys(msgEls)) delete msgEls[k];
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
    if (peerId && await e2eStart()) E2E.peerHasKeys(peerId).then(h => { if (currentChat === c) { $('safetyBtn').hidden = !h; safetyLabel(); } }).catch(() => {});
  } else {
    fillAvatar($('chatAva'), { display_name: c.title || '?', id: c.id });
    if (await e2eStart()) { try { await E2E.receive(c.id); } catch (e) { showErr('Не удалось получить ключи группы: ' + ruErr(e)); } }
  }
  if (currentChat !== c) return;
  if (chan) sb.removeChannel(chan);
  // Приватный канал: broadcast «печатает» доступен только участникам чата (политики realtime.messages на сервере)
  await rtAuth();
  if (currentChat !== c) return;
  subChat(c);
  if (!c.role) { const { data: r } = await sb.from('chat_members').select('role').eq('chat_id', c.id).eq('user_id', me.id).maybeSingle(); if (r) c.role = r.role; }
  loadPins(); loadLastSeen(); paintSub();
  $('messages').prepend(olderBtn); olderBtn.hidden = true; oldestAt = null;
  const { data, error } = await sb.from('messages').select('*').eq('chat_id', c.id).order('created_at', { ascending: false }).limit(PAGE);
  if (error) showErr('Не удалось загрузить сообщения: ' + ruErr(error));
  if (currentChat !== c) return;
  for (const m of (data || []).reverse()) await addMsg(m);
  if (data && data.length) oldestAt = data[0].created_at;
  olderBtn.hidden = !(data && data.length === PAGE);
  if (!(data || []).length) { const p = document.createElement('p'); p.className = 'empty-state'; txt(p, 'Сообщений пока нет. Всё, что вы напишете, будет зашифровано сквозным шифрованием.'); $('messages').append(p); }
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
    for (const m of data || []) { // от новых к старым, каждое вставляем сразу после кнопки
      if (msgEls[m.id]) continue;
      const d = document.createElement('div'); d.dataset.id = m.id; msgEls[m.id] = d;
      btn.after(d); await renderMsg(m, d);
    }
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
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_members', filter: `chat_id=eq.${c.id}` }, p => { if (p.new && p.new.user_id !== me.id) { readState[p.new.user_id] = p.new.last_read_at; paintAllTicks(); } })
    // DELETE в Realtime не фильтруется по колонкам — приходит только id, сверяем с загруженными
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, p => { if (p.old && p.old.id && msgEls[p.old.id]) { removeMsgEl(p.old.id); loadChatsSoon(); } })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_pins', filter: `chat_id=eq.${c.id}` }, () => loadPins())
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chat_pins' }, p => { if (!p.old || !p.old.chat_id || p.old.chat_id === c.id) loadPins(); })
    // reactions без chat_id: INSERT сверяем с загруженными сообщениями, DELETE приходит только с id — перечитываем
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reactions' }, p => { const r = p.new; if (r && msgEls[r.message_id]) addReact(r); })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'reactions' }, () => reloadReactsSoon())
    .on('broadcast', { event: 'typing' }, p => onTyping(p.payload))
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
  const st = {}; for (const r of data || []) if (r.user_id !== me.id) st[r.user_id] = r.last_read_at;
  readState = st; paintAllTicks();
}
function isRead(at) {
  const others = Object.values(readState);
  return others.length > 0 && others.every(r => r && new Date(r) >= new Date(at));
}
function paintTicks(d) {
  const t = d.querySelector('.ticks'); if (!t) return;
  const r = isRead(d.dataset.at);
  t.classList.toggle('read', r); txt(t, r ? '✓✓' : '✓');
  t.title = r ? 'Прочитано' : 'Отправлено'; t.setAttribute('aria-label', t.title);
}
function paintAllTicks() { document.querySelectorAll('#messages .msg.mine').forEach(paintTicks); }
setInterval(() => { if (currentChat && document.visibilityState === 'visible') loadReadState(); }, 8000);

// mark_read — только когда чат действительно на экране: вкладка видима, окно в фокусе, панель чата показана
let markT = null, lastMarked = 0;
function chatVisible() {
  if (!currentChat || document.visibilityState !== 'visible' || !document.hasFocus()) return false;
  const p = $('chatPane'); return p.offsetParent !== null && p.getClientRects().length > 0 && !$('app').classList.contains('in-settings');
}
function maybeMarkRead() {
  clearTimeout(markT);
  markT = setTimeout(async () => {
    if (!chatVisible()) return;
    const box = $('messages'); if (box.scrollHeight - box.scrollTop - box.clientHeight > 120) return; // пользователь листает историю
    const newest = [...box.querySelectorAll('.msg:not(.mine)')].pop();
    if (!newest || new Date(newest.dataset.at).getTime() <= lastMarked) return;
    const c = currentChat;
    const upto = newest.dataset.at;
    const { error } = await sb.rpc('mark_read', { p_chat: c.id, p_upto: upto });
    if (error) console.warn('mark_read', error);
    if (!error && currentChat === c) lastMarked = new Date(newest.dataset.at).getTime();
  }, 600);
}
document.addEventListener('visibilitychange', maybeMarkRead);
window.addEventListener('focus', maybeMarkRead);
$('messages').addEventListener('scroll', maybeMarkRead, { passive: true });
$('sendForm').onsubmit = async e => {
  e.preventDefault();
  const body = $('msgInput').value.trim(); if (!body || !currentChat) return;
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
  try { await sendPayload(chat, JSON.stringify({ v: 1, t: body }), rt ? { reply_to: rt } : null); if (chan) chan.send({ type: 'broadcast', event: 'typing', payload: { u: me.id, stop: true } }).catch(() => {}); lastTypingSent = 0; }
  catch (err) { $('msgInput').value = body; if (rt) startReply(rt); toastLong(err && err.userMsg ? err.userMsg : ruErr(err)); }
};
function userErr(msg) { const e = new Error(msg); e.userMsg = msg; return e; }
const KEY_CHANGED = 'Ключ безопасности собеседника изменился (новое устройство или переустановка). Сообщение НЕ отправлено.\n\nНадёжнее сначала сверить код безопасности (кнопка «🔒 Код безопасности»). Нажмите «ОК», только если уверены, что это действительно собеседник: новый ключ будет принят.';
async function encryptForPeer(pt, peer = peerId) {
  try { return await E2E.encryptDM(peer, pt); }
  catch (e) {
    if (!(e instanceof E2E.KeyChange)) throw e;
    if (!confirm(KEY_CHANGED)) throw userErr('Не отправлено: ключ собеседника изменился.');
    await E2E.acceptKeys(e.userId); return E2E.encryptDM(peer, pt);
  }
}
async function insertEncrypted(row, pt) {
  const sig = ctSig(row.ciphertext);
  sentOwn[sig] = pt;
  const { data, error } = await sb.from('messages').insert(row).select('id').single();
  if (error) { delete sentOwn[sig]; throw error; }
  await E2E.rememberOwn(data.id, pt, row.ciphertext.sk);
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
  try { await E2E.checkDevice(); } catch (e) { throw userErr('Сообщение не отправлено: не удалось зарегистрировать ключи этого устройства (' + ruErr(e) + ').'); }
  if (chat.kind === 'direct') {
    const peer = await chatPeer(chat);
    if (!peer) throw userErr('Сообщение не отправлено: не удалось определить собеседника.');
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
      if (!error) { await E2E.rememberOwn(m.id, pt, r.ct.sk); return; }
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
  await E2E.rememberOwn(m.id, pt);
}

// ---------- файлы: AES-256-GCM как в Android (ключ и sha256 внутри зашифрованного сообщения) ----------
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
async function sendFile(chat, file, extra, caption, fw) {
  if (!(await e2eStart())) throw userErr('Файл не отправлен: шифрование на этом устройстве не запустилось.');
  const fpeer = chat.kind === 'direct' ? await chatPeer(chat) : null;
  if (chat.kind === 'direct' && !(fpeer && await E2E.peerHasKeys(fpeer))) throw userErr('Файл не отправлен: у собеседника нет ключей шифрования, а файлы без шифрования не отправляются.');
  const plain = new Uint8Array(await file.arrayBuffer());
  const enc = await E2E.encryptFile(plain);
  const path = `chat/${chat.id}/${crypto.randomUUID()}_file.bin`;
  const { error } = await sb.storage.from('chat-files').upload(path, new Blob([enc.ct], { type: 'application/octet-stream' }), { contentType: 'application/octet-stream', upsert: false });
  if (error) throw error;
  const f = { p: path, n: safeName(file.name), s: plain.length, m: file.type || '', k: enc.k, iv: enc.iv, h: enc.h };
  // подпись — только внутри зашифрованного payload (поле caption), на сервер открытым текстом не уходит
  const pl = { v: 1, t: '', f }; if (caption) pl.caption = String(caption).slice(0, 4000); if (fw) pl.fw = fw;
  try { await sendPayload(chat, JSON.stringify(pl), extra); }
  catch (e) { await sb.storage.from('chat-files').remove([path]).catch(() => {}); throw e; }
}
async function fetchFilePlain(f) {
  const { data, error } = await sb.storage.from('chat-files').createSignedUrl(f.p, 60);
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
  const sp = document.createElement('span'); sp.className = 'spinner'; box.append(sp);
  (imgUrls[f.p] = imgUrls[f.p] || fetchFilePlain(f).then(p => {
    const real = sniffImage(p);
    if (!real || real !== mime) { const e = new Error('not an image'); e.notImage = true; throw e; }
    return URL.createObjectURL(new Blob([p], { type: real }));
  }))
    .then(url => {
      const im = document.createElement('img'); im.alt = safeName(f.n); im.src = url;
      im.onload = () => { box.textContent = ''; box.classList.remove('loading'); box.append(im); };
      im.onerror = () => { txt(box, 'Не удалось показать картинку'); };
      box.onclick = ev => { ev.stopPropagation(); openImage(url, im.alt, f, caption, fromOther); };
    })
    .catch(e => {
      delete imgUrls[f.p]; box.classList.remove('loading'); box.onclick = null;
      if (e && (e.notImage || e.corrupt) && onFallback) return onFallback(!!e.corrupt); // не картинка — как файл; повреждён — строка ошибки
      txt(box, 'Не удалось загрузить картинку');
    });
  return box;
}
// Диалог поверх экрана с записью в истории: «Назад» в браузере закрывает его
function overlayHistory(dlg) {
  const tag = dlg.id + ':' + Date.now();
  history.pushState({ ...(history.state || {}), ov: tag }, '', location.href);
  const onPop = () => { if (dlg.open) { dlg.dataset.popped = '1'; dlg.close(); } };
  window.addEventListener('popstate', onPop, { once: true });
  dlg.addEventListener('close', () => {
    window.removeEventListener('popstate', onPop);
    if (!dlg.dataset.popped && history.state && history.state.ov === tag) history.back();
    delete dlg.dataset.popped;
  }, { once: true });
}
function msIcon(name, cls) { const i = document.createElement('span'); i.className = 'ms' + (cls ? ' ' + cls : ''); i.setAttribute('aria-hidden', 'true'); txt(i, name); return i; }
// Превью вложения в списке чатов: расшифровываем последнее сообщение локально (сервер знает только last_has_file)
const lastPrev = {}; // chat_id + last_at → {icon, text}
async function filePreviewSoon(c, sub) {
  const key = c.id + '|' + c.last_at;
  const paint = v => { if (!v || !sub.isConnected) return; sub.textContent = ''; if (c.last_sender === me.id) sub.append('Вы: '); sub.prepend(msIcon(v.icon, 'sub-ic')); sub.append(v.text); };
  if (lastPrev[key]) return paint(lastPrev[key]);
  try {
    const { data } = await sb.from('messages').select('*').eq('chat_id', c.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!data || !data.ciphertext) return;
    const pl = await decryptPayload(data); if (!pl || pl.fail || pl.other || !pl.f) return;
    const img = !!imgMime(pl.f);
    paint(lastPrev[key] = { icon: img ? 'image' : 'description', text: img ? (pl.caption || pl.t || 'Фото') : (pl.caption || safeName(pl.f.n)) });
  } catch (e) { /* остаётся «Файл» */ }
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
    try { await sendFile(chat, file, undefined, cap.value.trim()); d.close(); }
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
function safetyLabel() { if (peerId && E2E) txt($('safetyBtn'), E2E.hasPendingChange(peerId) ? 'Ключ изменился' : E2E.isVerified(peerId) ? 'Код проверен' : 'Код безопасности'); }
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
    if (E2E.hasPendingChange(peer)) { txt(s, '⚠ Ключ собеседника изменился. Сверьте новый код, прежде чем принимать.'); }
    else if (E2E.isVerified(peer)) { s.className = 'hint ok'; txt(s, '✅ Код проверен'); }
    else txt(s, 'Код ещё не проверен.');
    $('acceptBtn').hidden = !E2E.hasPendingChange(peer); safetyLabel(); };
  st(); $('scanInput').value = '';
  const check = async v => {
    if (!v) return;
    if (await E2E.verifyScanned(peer, v)) { st(); $('safetyState').className = 'hint ok'; txt($('safetyState'), '✅ QR совпал — код проверен'); }
    else { $('safetyState').className = 'hint bad'; txt($('safetyState'), '❌ Код НЕ совпадает. Возможно, переписку подменяют или у собеседника другое устройство.'); }
  };
  $('checkBtn').onclick = () => check($('scanInput').value.trim());
  $('matchBtn').onclick = async () => { if (confirm('Вы сравнили все 60 цифр с экраном собеседника, и они совпадают?')) { await E2E.markVerified(peer); st(); } };
  $('acceptBtn').onclick = async () => { if (confirm('Принять новый ключ? Делайте это, только если собеседник подтвердил смену устройства. Надёжнее — сначала сверить QR.')) { await E2E.acceptKeys(peer); st(); } };
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
$('safetyBtn').onclick = () => showSafety().catch(e => toastLong(ruErr(e)));
$('findForm').onsubmit = e => { e.preventDefault(); window.findSubmit(); };

$('backBtn').onclick = () => history.length > 1 && location.hash === '#chat' ? history.back() : closeChatView();
function closeChatView() { $('app').classList.remove('in-chat'); }
$('peerBtn').onclick = async () => {
  if (!currentChat || currentChat.kind !== 'direct' || !peerId) return;
  const p = await getProfile(peerId, true);
  fillAvatar($('peerAva'), p); txt($('peerName'), displayName(p)); txt($('peerNick'), p ? '@' + p.username : ''); $('peerNick').hidden = !p;
  txt($('peerBio'), p ? p.bio || 'Не указано' : ''); $('peerBio').hidden = !p; $('peerBio').classList.toggle('unset', !!p && !p.bio);
  $('peerDlg').showModal();
};
$('closePeer').onclick = () => $('peerDlg').close();
$('chatMenuBtn').onclick = e => { if (!currentChat) return; const r = e.currentTarget.getBoundingClientRect(); openMenu({ clientX: r.right - 220, clientY: r.bottom + 4 }, chatMenuItems(currentChat)); };

// ---------- настройки и профиль ----------
const THEMES = { system: null, dark: 'dark', light: 'light' };
function applyTheme(t) {
  if (!(t in THEMES)) t = 'system';
  if (THEMES[t]) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { t === 'system' ? localStorage.removeItem('msgr-theme') : localStorage.setItem('msgr-theme', t); } catch { /* нет localStorage */ }
  document.querySelectorAll('#themeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === t)));
  const tv = $('themeVal'); if (tv) txt(tv, { system: 'Системная', light: 'Светлая', dark: 'Тёмная' }[t]);
  const dark = THEMES[t] ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.querySelector('meta[name=theme-color]').content = dark ? '#0f1720' : '#eef2f6';
}
document.querySelectorAll('#themeSeg button').forEach(b => { b.onclick = () => applyTheme(b.dataset.mode); });
applyTheme((() => { try { return localStorage.getItem('msgr-theme') || 'system'; } catch { return 'system'; } })());
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
  if (push && location.hash !== '#' + which) history.pushState({ v: which }, '', '#' + which);
  if (which === 'profile') fillSettings().catch(e => showErr('Не удалось загрузить профиль: ' + ruErr(e)));
  else { let cv = null; try { cv = localStorage.getItem('msgr-seen'); } catch { /* */ }
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
    if (t === 'chats') { if (/^#(profile|settings)$/.test(location.hash)) history.pushState({ v: 'chats' }, '', currentChat && $('app').classList.contains('in-chat') ? '#chat' : '#'); closeSettings(); }
    else openSettings(true, t);
  };
});
$('meBtn').onclick = () => openSettings(true, 'profile');
$('settingsBack').onclick = () => /^#(profile|settings)$/.test(location.hash) ? history.back() : closeSettings();
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
function askConfirm(text, okText) {
  return new Promise(res => {
    const d = $('confirmDlg'); txt($('confirmText'), text); txt($('confirmOk'), okText);
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
  const on = $('notifSw').checked; try { localStorage.setItem('msgr-notify', on ? '1' : '0'); } catch { /* */ }
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
async function cacheBytes() { let n = 0; if ('caches' in window) for (const k of await caches.keys()) { const c = await caches.open(k); for (const r of await c.keys()) { const x = await c.match(r); if (x) n += (await x.clone().blob()).size; } } return n; }
async function paintStorage() { try { const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; txt($('storeVal'), est ? fmtSize(est.usage || 0) : '—'); } catch { txt($('storeVal'), '—'); } }
$('rowStorage').onclick = async () => {
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const cb = await cacheBytes().catch(() => 0), nAva = Object.keys(avaUrls).length, nProf = Object.keys(profiles).length;
  const btn = el('button', 'ghost', 'Очистить кэш'); btn.type = 'button';
  const info = el('p', 'hint small', 'Ключи шифрования и расшифрованная история хранятся отдельно и при очистке не удаляются.');
  btn.onclick = async () => {
    if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
    for (const k of Object.keys(avaUrls)) delete avaUrls[k];
    for (const k of Object.keys(profiles)) if (k !== me.id) delete profiles[k];
    try { sessionStorage.clear(); } catch { /* */ }
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
async function onSession(session) {
  const uid = session ? session.user.id : null;
  if (lastUid !== undefined && uid === lastUid) { me = session ? session.user : null; return; }
  lastUid = uid;
  me = session ? session.user : null;
  $('auth').hidden = !!me; $('app').hidden = !me;
  if (me) {
    stopQr();
    refreshMe().catch(() => txt($('me'), me.email || '')); watchProfiles(); touchPresence();
    { const m = /^#(profile|settings)$/.exec(location.hash); if (m) openSettings(false, m[1]); else setNav('chats'); }
    e2eStart().then(ok => { deviceCheck(true); if (ok && E2E.isFreshDevice && E2E.isFreshDevice()) offerRestore(); });
    paintBackupRow();
    loadChats();
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
  try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* */ }
  onSession(null);
}
async function rtAuth(token) {
  try { if (!token) { const { data } = await sb.auth.getSession(); token = data.session && data.session.access_token; } if (token) await sb.realtime.setAuth(token); }
  catch (e) { console.warn('realtime setAuth', e); }
}
sb.auth.onAuthStateChange((e, s) => {
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
  const key = await Backup.deriveKey(pass, salt, kdf);
  const bin = await Backup.seal({ v: 1, uid: me.id, created_at: new Date().toISOString(), messages }, key, me.id);
  if (bin.length > 104857600) throw userErr('Копия больше 100 МБ');
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
  if (first) nodes.push(el('p', '', 'Ключи этого устройства не удалось перенести. Старую переписку можно вернуть из резервной копии.'));
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
async function offerRestore() {
  const k = 'msgr-restore-offered:' + me.id + ':' + (E2E.deviceId() || '');
  try { if (localStorage.getItem(k)) return; } catch (e) { /* */ }
  try { if (await getBackupRow()) { try { localStorage.setItem(k, '1'); } catch (e) { /* */ } backupSheet(true); } } catch (e) { console.warn('key_backups', e); }
}
