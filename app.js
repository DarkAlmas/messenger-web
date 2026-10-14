const C = window.MSG_CONFIG;
const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: true, storageKey: 'msgr-auth', autoRefreshToken: false, detectSessionInUrl: false } });
const $ = id => document.getElementById(id);
// Одна сессия (= одно устройство E2E) на браузер: сессия в localStorage, токен обновляет только одна вкладка-лидер.
try { sessionStorage.removeItem('msgr-auth'); } catch (e) { /* старая версия хранила сессию во вкладке */ }
if (navigator.locks) navigator.locks.request('msgr-auth-leader', () => { sb.auth.startAutoRefresh(); return new Promise(() => {}); });
else sb.auth.startAutoRefresh();
let me = null, regMode = false, currentChat = null, chan = null, qrTimer = null;
const names = {};

function txt(el, s) { el.textContent = s; }
// ---------- видимые ошибки: ничего не падает молча ----------
function showErr(msg) {
  const n = $('notice'); if (!n) { alert(msg); return; }
  txt($('noticeText'), msg); n.hidden = false;
}
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
      if (!/^[a-z0-9_]{3,32}$/.test(username)) return txt($('authMsg'), 'Никнейм: 3–32 символа, только a-z, 0-9 и _');
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
  if (!me && qrFails && $('qrStatus').textContent.startsWith('Нет соединения')) { qrFails = 0; startQr(); }
}
window.addEventListener('online', netBack);
// Событие online срабатывает не везде: пока висит ошибка сети, раз в 5 с проверяем сервер
setInterval(async () => {
  if (!$('authMsg').textContent.startsWith(NET_ERR) && !$('qrStatus').textContent.startsWith('Нет соединения')) return;
  try { const r = await fetch(`${C.SUPABASE_URL}/auth/v1/health`, { headers: { apikey: C.SUPABASE_KEY }, cache: 'no-store' }); if (r.status < 500) netBack(); } catch (e) { /* всё ещё нет сети */ }
}, 5000);
$('logout').onclick = async () => {
  try { if (E2E && E2E.deviceId()) { await sb.from('devices_keys').delete().eq('device_id', E2E.deviceId()); await E2E.wipe(); } } catch (e) { /* не мешаем выходу */ }
  try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* сеть недоступна — локальную сессию всё равно чистим */ } };

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
  if (kind !== 'ok') { box.innerHTML = ''; const s = document.createElement('span'); txt(s, kind === 'loading' ? 'Загрузка…' : 'QR недоступен'); box.appendChild(s); }
  txt($('qrStatus'), status); txt($('qrTimerText'), timer || '');
  $('qrRetry').hidden = kind !== 'error';
}
function qrFail(e) {
  stopQr();
  qrFails++;
  const MAX = 5;
  const reason = e && e.status === 429 ? 'Слишком много запросов QR.' : (e && e.status ? 'Сервер QR временно недоступен.' : 'Нет соединения с сервером.');
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
    if (s <= 0) { stopQr(); qrState('error', 'Срок действия QR истёк.'); }
  };
  tick(); qrCountdown = setInterval(tick, 1000);
  let pollFails = 0;
  qrTimer = setInterval(async () => {
    if (Date.now() >= expires) return;
    let p; try { p = await fn('qr-poll', { token: q.token, poll_secret: q.poll_secret }); pollFails = 0; }
    catch (e) { if (e.status === 429 || ++pollFails >= 5) qrFail(e); return; }
    if (!p) return;
    if (p.status === 'approved') {
      stopQr(); qrState('loading', 'Вход подтверждён, входим…');
      const s = p.session;
      if (s && s.access_token && s.refresh_token) await sb.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
    } else if (p.status === 'denied') { stopQr(); qrState('error', 'Вход отклонён на телефоне.'); }
    else if (p.status === 'expired') { stopQr(); qrState('error', 'Срок действия QR истёк.'); }
  }, 3000);
}

// ---------- чаты ----------
async function loadChats() {
  const ul = $('chatList');
  const { data, error } = await sb.rpc('list_chats');
  if (error) { showErr('Не удалось загрузить чаты: ' + ruErr(error)); return; }
  ul.innerHTML = '';
  for (const c of data || []) {
    const li = document.createElement('li');
    li.dataset.id = c.chat_id; li.tabIndex = 0;
    const chat = { id: c.chat_id, kind: c.kind, title: c.kind === 'direct' ? null : c.title, peer: c.peer_id };
    const ava = avatarEl(c.peer_id ? null : { display_name: c.title || '?', id: c.chat_id });
    const meta = document.createElement('div'); meta.className = 'meta';
    const nm = document.createElement('div'); nm.className = 'name'; txt(nm, c.kind === 'direct' ? (c.title || 'Личный чат') : (c.title || 'Группа'));
    const sub = document.createElement('div'); sub.className = 'sub';
    txt(sub, c.last_sender ? (c.last_sender === me.id ? 'Вы: ' : '') + (c.last_has_file ? '📎 файл' : '🔒 зашифрованное сообщение') : 'Нет сообщений');
    meta.append(nm, sub); li.append(ava, meta);
    if (c.unread > 0 && !(currentChat && currentChat.id === c.chat_id)) { const b = document.createElement('span'); b.className = 'badge'; txt(b, c.unread > 99 ? '99+' : String(c.unread)); li.append(b); }
    if (currentChat && currentChat.id === c.chat_id) li.classList.add('active');
    li.onclick = () => openChat(chat, li);
    li.onkeydown = e => { if (e.key === 'Enter') openChat(chat, li); };
    ul.appendChild(li);
    if (c.peer_id) getProfile(c.peer_id).then(p => { if (p) { txt(nm, displayName(p)); ava.replaceWith(avatarEl(p)); } });
  }
  if (!ul.children.length) { const li = document.createElement('li'); li.className = 'hint'; txt(li, 'Чатов пока нет. Найдите собеседника по никнейму.'); ul.append(li); }
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
  return data;
}
function displayName(p) { return p ? (p.display_name || '@' + p.username) : 'неизвестный'; }
async function nameOf(id) { const p = await getProfile(id); return p ? displayName(p) : 'неизвестный'; }
const COLORS = ['#e17076', '#eda86c', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae', '#5b7a99'];
function colorFor(p) {
  if (p && /^#[0-9a-f]{6}$/.test(p.avatar_color || '')) return p.avatar_color;
  let h = 0; for (const ch of String(p && p.id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
const avaUrls = {}; // путь в storage → { url, exp } (подписанная ссылка)
function avatarEl(p, cls) {
  const s = document.createElement('span'); s.className = 'ava' + (cls ? ' ' + cls : '');
  fillAvatar(s, p); return s;
}
function avatarLetter(p) {
  if (p && p.avatar_letter) return p.avatar_letter;
  return (Array.from(String(p && (p.display_name || p.username) || '?').trim())[0] || '?').toUpperCase();
}
function fillAvatar(s, p) {
  s.textContent = ''; s.hidden = false;
  s.style.background = colorFor(p);
  txt(s, avatarLetter(p));
  const path = p && p.avatar_url;
  s.dataset.path = path || '';
  if (path) avatarSigned(path).then(u => {
    if (!u || s.dataset.path !== path) return;
    const img = new Image(); img.alt = ''; img.referrerPolicy = 'no-referrer';
    img.onload = () => { if (s.dataset.path === path) { s.textContent = ''; s.append(img); } };
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
  profChan = sb.channel('profiles').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, x => profileChanged(x.new)).subscribe();
}

let chatHasE2e = false, peerId = null;
// ---------- сквозное шифрование (e2e.js + libsignal WASM) ----------
let E2E = null, e2eErr = null;
const e2eMod = import('./e2e.js?v=20261014i').then(m => { m.init(sb); return (E2E = m); });
// Проверка устройства: при входе, восстановлении сессии, раз в 10 минут и при возврате на вкладку
let devCheckAt = 0;
async function deviceCheck(force) {
  if (!me || (!force && Date.now() - devCheckAt < 60000)) return;
  devCheckAt = Date.now();
  const { error } = await sb.auth.getUser();
  if (error && (error.status === 401 || error.status === 403 || /session|jwt|not found/i.test(error.message))) {
    showErr('Сессия на этом устройстве завершена (вход отозван или истёк). Войдите снова.');
    try { if (E2E) await E2E.wipe(); } catch (e) { /* всё равно выходим */ }
    await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    return;
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
  catch (e) { e2eErr = e; console.warn('E2E недоступно:', e); showErr('Шифрование на этом устройстве не запустилось: ' + ruErr(e) + '. Отправка сообщений невозможна, обновите страницу (Ctrl+F5).'); }
  return E2E && !e2eErr;
}
const sentOwn = {}; // подпись шифротекста → открытый текст (своё сообщение приходит по Realtime раньше, чем сохранится копия)
const ctSig = c => c && (c.sk || Object.values(c).map(x => x && x.b).sort()[0]);
function parsePayload(pt) {
  let o; try { o = JSON.parse(pt); } catch { return { t: pt }; }
  if (!o || typeof o !== 'object') return { t: String(pt) };
  return { t: o.t || '', f: o.f && typeof o.f === 'object' ? o.f : null };
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
  d.dataset.at = m.created_at;
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
        const fb = document.createElement('button'); fb.type = 'button'; fb.className = 'file';
        fb.title = 'Скачать и расшифровать';
        txt(fb, '📎 ' + (pl.f.n || 'файл') + (pl.f.s ? ' · ' + fmtSize(pl.f.s) : ''));
        fb.onclick = () => { fb.disabled = true; downloadFile(pl.f, !mine).catch(e => alert(e.userMsg || ruErr(e))).finally(() => { fb.disabled = false; }); };
        d.append(fb);
      }
      if (mine && !pl.f) {
        const eb = document.createElement('button'); eb.type = 'button'; eb.className = 'edit'; eb.title = 'Изменить'; eb.setAttribute('aria-label', 'Изменить'); txt(eb, '✏️');
        eb.onclick = () => editMsg(m, pl.t);
        foot.append(eb);
      }
      lock.className = 'lock'; lock.title = 'Сквозное шифрование'; txt(lock, '🔒');
    } else { b.className = 'body e2e'; txt(b, pl && pl.other ? 'зашифровано для другого устройства' : pl && pl.fail ? 'не удалось расшифровать' : 'зашифровано, откройте в приложении'); lock.className = 'lock'; txt(lock, '🔒'); }
  } else {
    txt(b, m.body);
    lock.className = 'noe2e'; lock.title = 'Старое сообщение без шифрования'; txt(lock, '⚠ без шифрования');
  }
  if (m.edited_at) { const e = document.createElement('span'); txt(e, 'изм.'); foot.append(e); }
  const tm = document.createElement('time'); tm.dateTime = m.created_at; txt(tm, fmtTime(m.created_at));
  foot.append(lock, tm);
  if (mine) { const t = document.createElement('span'); t.className = 'ticks'; foot.append(t); }
  d.append(foot);
  if (mine) paintTicks(d);
}
async function addMsg(m) {
  if (msgEls[m.id]) return updMsg(m);
  const d = document.createElement('div'); d.dataset.id = m.id; msgEls[m.id] = d;
  const box = $('messages'); box.appendChild(d);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  await renderMsg(m, d);
  if (nearBottom || m.sender_id === me.id) box.scrollTop = box.scrollHeight;
}
async function updMsg(m) { const d = msgEls[m.id]; if (d) await renderMsg(m, d); }
async function openChat(c, li) {
  currentChat = c; readState = {}; lastMarked = 0;
  document.querySelectorAll('#chatList li').forEach(x => x.classList.remove('active')); li.classList.add('active');
  const badge = li.querySelector('.badge'); if (badge) badge.remove();
  $('app').classList.add('in-chat'); $('app').classList.remove('in-settings');
  if (location.hash !== '#chat') history.pushState({ v: 'chat' }, '', '#chat');
  chatHasE2e = false; peerId = c.peer || null;
  for (const k of Object.keys(msgEls)) delete msgEls[k];
  txt($('chatTitle'), li.querySelector('.name') ? li.querySelector('.name').textContent : li.textContent);
  $('chatAva').hidden = true;
  $('sendForm').hidden = false; $('messages').innerHTML = ''; $('safetyBtn').hidden = true;
  if (c.kind === 'direct') {
    if (!peerId) { const { data: pm } = await sb.from('chat_members').select('user_id').eq('chat_id', c.id).neq('user_id', me.id).limit(1).maybeSingle(); peerId = pm ? pm.user_id : null; }
    if (peerId) getProfile(peerId).then(p => { if (currentChat === c && p) { txt($('chatTitle'), displayName(p)); fillAvatar($('chatAva'), p); } });
    if (peerId && await e2eStart()) E2E.peerHasKeys(peerId).then(h => { if (currentChat === c) { $('safetyBtn').hidden = !h; safetyLabel(); } }).catch(() => {});
  } else {
    fillAvatar($('chatAva'), { display_name: c.title || '?', id: c.id });
    if (await e2eStart()) { try { await E2E.receive(c.id); } catch (e) { showErr('Не удалось получить ключи группы: ' + ruErr(e)); } }
  }
  if (currentChat !== c) return;
  if (chan) sb.removeChannel(chan);
  chan = sb.channel('chat-' + c.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${c.id}` }, p => onIncoming(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `chat_id=eq.${c.id}` }, p => updMsg(p.new))
    // Живые отметки прочтения (работает, когда chat_members добавлен в публикацию Realtime; до этого — опрос раз в 8 с)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_members', filter: `chat_id=eq.${c.id}` }, p => { if (p.new && p.new.user_id !== me.id) { readState[p.new.user_id] = p.new.last_read_at; paintAllTicks(); } })
    .subscribe();
  const { data, error } = await sb.from('messages').select('*').eq('chat_id', c.id).order('created_at', { ascending: false }).limit(200);
  if (error) showErr('Не удалось загрузить сообщения: ' + ruErr(error));
  if (currentChat !== c) return;
  for (const m of (data || []).reverse()) await addMsg(m);
  if (!(data || []).length) { const p = document.createElement('p'); p.className = 'empty-state'; txt(p, 'Сообщений пока нет. Всё, что вы напишете, будет зашифровано сквозным шифрованием.'); $('messages').append(p); }
  await loadReadState();
  maybeMarkRead();
}
async function onIncoming(m) {
  const e = $('messages').querySelector('.empty-state'); if (e) e.remove();
  await addMsg(m);
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
  const chat = currentChat;
  $('msgInput').value = '';
  try { await sendPayload(chat, JSON.stringify({ v: 1, t: body })); }
  catch (err) { $('msgInput').value = body; alert(err && err.userMsg ? err.userMsg : ruErr(err)); }
};
function userErr(msg) { const e = new Error(msg); e.userMsg = msg; return e; }
const KEY_CHANGED = 'Ключ безопасности собеседника изменился (новое устройство или переустановка). Сообщение НЕ отправлено.\n\nНадёжнее сначала сверить код безопасности (кнопка «🔒 Код безопасности»). Нажмите «ОК», только если уверены, что это действительно собеседник: новый ключ будет принят.';
async function encryptForPeer(pt) {
  try { return await E2E.encryptDM(peerId, pt); }
  catch (e) {
    if (!(e instanceof E2E.KeyChange)) throw e;
    if (!confirm(KEY_CHANGED)) throw userErr('Не отправлено: ключ собеседника изменился.');
    await E2E.acceptKeys(e.userId); return E2E.encryptDM(peerId, pt);
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
async function sendPayload(chat, pt) {
  if (!(await e2eStart())) throw userErr('Сообщение не отправлено: шифрование на этом устройстве не запустилось (' + ruErr(e2eErr) + '). Обновите страницу (Ctrl+F5).');
  try { await E2E.checkDevice(); } catch (e) { throw userErr('Сообщение не отправлено: не удалось зарегистрировать ключи этого устройства (' + ruErr(e) + ').'); }
  if (chat.kind === 'direct') {
    if (!peerId) throw userErr('Сообщение не отправлено: не удалось определить собеседника.');
    if (!(await E2E.peerHasKeys(peerId))) throw userErr('Сообщение не отправлено: у собеседника нет ключей шифрования — он ещё не входил в обновлённое приложение или на сайт. Попросите его войти, затем повторите.' + NO_PLAIN);
    const r = await encryptForPeer(pt);
    if (!r) throw userErr('Сообщение не отправлено: у собеседника больше нет ключей шифрования.' + NO_PLAIN);
    return insertEncrypted({ chat_id: chat.id, sender_id: me.id, body: '', ciphertext: r.ct }, r.pt);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const { epoch, others } = await E2E.distribute(chat.id);
    if (!others) throw userErr('Сообщение не отправлено: ни у кого из участников группы нет ключей шифрования.' + NO_PLAIN);
    const r = await E2E.encryptGroup(chat.id, epoch, pt);
    try { return await insertEncrypted({ chat_id: chat.id, sender_id: me.id, body: '', ciphertext: r.ct, key_epoch: epoch, sender_device: E2E.deviceId() }, r.pt); }
    catch (e) { if (!String(e && e.message).includes('stale key epoch')) throw e; }
  }
  throw userErr('Сообщение не отправлено: ключ группы меняется слишком часто, попробуйте ещё раз.');
}

// ---------- правка зашифрованных сообщений (RPC edit_message, как в Android) ----------
async function editMsg(m, oldText) {
  const t = prompt('Изменить сообщение', oldText);
  if (t == null || !t.trim() || t.trim() === oldText) return;
  try { await editEncrypted(m, JSON.stringify({ v: 1, t: t.trim() })); }
  catch (e) { alert(e.userMsg || ruErr(e)); }
}
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
  if (file.size <= 0 || file.size > MAX_FILE) return alert('Файл пустой или больше 25 МБ');
  const chat = currentChat, btn = $('attachBtn'); btn.disabled = true; txt(btn, '⏳');
  try { await sendFile(chat, file); }
  catch (e) { alert(e.userMsg || ruErr(e)); }
  finally { btn.disabled = false; txt(btn, '📎'); }
};
async function sendFile(chat, file) {
  if (!(await e2eStart())) throw userErr('Файл не отправлен: шифрование на этом устройстве не запустилось.');
  if (chat.kind === 'direct' && !(peerId && await E2E.peerHasKeys(peerId))) throw userErr('Файл не отправлен: у собеседника нет ключей шифрования, а файлы без шифрования не отправляются.');
  const plain = new Uint8Array(await file.arrayBuffer());
  const enc = await E2E.encryptFile(plain);
  const path = `chat/${chat.id}/${crypto.randomUUID()}_file.bin`;
  const { error } = await sb.storage.from('chat-files').upload(path, new Blob([enc.ct], { type: 'application/octet-stream' }), { contentType: 'application/octet-stream', upsert: false });
  if (error) throw error;
  const f = { p: path, n: safeName(file.name), s: plain.length, m: file.type || '', k: enc.k, iv: enc.iv, h: enc.h };
  try { await sendPayload(chat, JSON.stringify({ v: 1, t: '', f })); }
  catch (e) { await sb.storage.from('chat-files').remove([path]).catch(() => {}); throw e; }
}
async function downloadFile(f, fromOther) {
  const name = safeName(f.n);
  if (fromOther && RISKY.some(x => name.toLowerCase().endsWith('.' + x)) && !confirm(`«${name}» может быть опасным файлом. Скачать?`)) return;
  const { data, error } = await sb.storage.from('chat-files').createSignedUrl(f.p, 60);
  if (error) throw error;
  const r = await fetch(data.signedUrl);
  if (!r.ok) throw userErr('Скачивание не удалось');
  const ct = new Uint8Array(await r.arrayBuffer());
  if (ct.length > MAX_FILE + 16) throw userErr('Файл слишком большой');
  const plain = await E2E.decryptFile(ct, f.k, f.iv, f.h);
  const url = URL.createObjectURL(new Blob([plain], { type: 'application/octet-stream' })); // octet-stream: браузер сохраняет файл, а не открывает его
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------- код безопасности ----------
function safetyLabel() { if (peerId && E2E) txt($('safetyBtn'), E2E.hasPendingChange(peerId) ? '⚠ Ключ изменился' : E2E.isVerified(peerId) ? '🔒 Код проверен ✅' : '🔒 Код безопасности'); }
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
  $('scanBtn').onclick = () => scanQr().then(check).catch(e => alert('Камера недоступна: ' + ruErr(e)));
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
$('safetyBtn').onclick = () => showSafety().catch(e => alert(ruErr(e)));
$('findForm').onsubmit = async e => {
  e.preventDefault();
  const nick = normNick($('findUser').value); if (!nick) return;
  const { data: u, error: fe } = await sb.from('profiles').select('id').eq('username', nick).maybeSingle();
  if (fe) return alert(ruErr(fe));
  if (!u) return alert('Пользователь @' + nick + ' не найден');
  if (u.id === me.id) return alert('Это ваш собственный никнейм');
  const { data: chatId, error } = await sb.rpc('create_direct_chat', { p_other: u.id });
  if (error) return alert(ruErr(error));
  $('findUser').value = ''; await loadChats();
  const li = document.querySelector(`#chatList li[data-id="${chatId}"]`); if (li) li.click();
};
$('backBtn').onclick = () => history.length > 1 && location.hash === '#chat' ? history.back() : closeChatView();
function closeChatView() { $('app').classList.remove('in-chat'); }
$('peerBtn').onclick = async () => {
  if (!currentChat || currentChat.kind !== 'direct' || !peerId) return;
  const p = await getProfile(peerId, true); if (!p) return;
  fillAvatar($('peerAva'), p); txt($('peerName'), displayName(p)); txt($('peerNick'), '@' + p.username); txt($('peerBio'), p.bio || '');
  $('peerDlg').showModal();
};
$('closePeer').onclick = () => $('peerDlg').close();

// ---------- настройки и профиль ----------
const THEMES = { system: null, dark: 'dark', light: 'light' };
function applyTheme(t) {
  if (!(t in THEMES)) t = 'system';
  if (THEMES[t]) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { t === 'system' ? localStorage.removeItem('msgr-theme') : localStorage.setItem('msgr-theme', t); } catch { /* нет localStorage */ }
  document.querySelectorAll('#themeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === t)));
  const dark = THEMES[t] ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.querySelector('meta[name=theme-color]').content = dark ? '#0f1720' : '#eef2f6';
}
document.querySelectorAll('#themeSeg button').forEach(b => { b.onclick = () => applyTheme(b.dataset.theme); });
applyTheme((() => { try { return localStorage.getItem('msgr-theme') || 'system'; } catch { return 'system'; } })());
let pickedColor = null;
function openSettings(push = true) {
  $('app').classList.add('in-settings');
  if (push && location.hash !== '#settings') history.pushState({ v: 'settings' }, '', '#settings');
  fillSettings().catch(e => showErr('Не удалось загрузить профиль: ' + ruErr(e)));
}
function closeSettings() { $('app').classList.remove('in-settings'); maybeMarkRead(); }
$('settingsBtn').onclick = () => openSettings(); $('meBtn').onclick = () => openSettings();
$('settingsBack').onclick = () => location.hash === '#settings' ? history.back() : closeSettings();
window.addEventListener('popstate', () => {
  if (location.hash === '#settings') openSettings(false); else closeSettings();
  if (location.hash !== '#chat' && location.hash !== '#settings') closeChatView();
});
async function fillSettings() {
  const p = await getProfile(me.id, true);
  if (!p) throw new Error('профиль не найден');
  txt($('setEmail'), me.email || '—'); txt($('setDevice'), E2E && E2E.deviceId() ? E2E.deviceId().slice(0, 8) : '—');
  $('pName').value = p.display_name || ''; $('pNick').value = p.username || ''; $('pBio').value = p.bio || ''; $('pLetter').value = p.avatar_letter || ''; $('pLetter').disabled = !profileExt; txt($('bioCount'), String($('pBio').value.length));
  pickedColor = p.avatar_color || null;
  const ext = !!profileExt;
  $('extNote').hidden = ext; $('pBio').disabled = !ext; $('avaPhotoBtn').disabled = !ext; $('avaRemoveBtn').hidden = !p.avatar_url;
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
$('pBio').oninput = () => txt($('bioCount'), String($('pBio').value.length));
$('pNick').oninput = () => { $('pNick').value = $('pNick').value.toLowerCase(); };
$('profForm').onsubmit = async e => {
  e.preventDefault();
  const name = $('pName').value.trim().replace(/\s+/g, ' '), nick = normNick($('pNick').value), bio = $('pBio').value.trim();
  if (!name || name.length > 64) return txt($('profMsg'), 'Имя: от 1 до 64 символов');
  if (!/^[a-z0-9_]{3,32}$/.test(nick)) return txt($('profMsg'), 'Никнейм: 3–32 символа, только a-z, 0-9 и _');
  const upd = { display_name: name, username: nick };
  if (profileExt) {
    upd.bio = bio || null; if (pickedColor) upd.avatar_color = pickedColor;
    const letter = $('pLetter').value.trim();
    if (letter && (Array.from(letter).length > 2 || /[\s\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(letter))) return txt($('profMsg'), 'Буква аватара: 1–2 символа без пробелов');
    upd.avatar_letter = letter || null;
  }
  $('profSave').disabled = true; txt($('profMsg'), 'Сохраняем…');
  try {
    const { error } = await sb.from('profiles').update(upd).eq('id', me.id);
    if (error) throw error;
    await refreshMe(); txt($('profMsg'), '✅ Сохранено');
  } catch (err) { txt($('profMsg'), ruErr(err)); }
  finally { $('profSave').disabled = false; }
};
async function refreshMe() {
  const p = await getProfile(me.id, true);
  txt($('me'), displayName(p)); fillAvatar($('meAva'), p); fillAvatar($('profAva'), p); $('avaRemoveBtn').hidden = !(p && p.avatar_url);
}
$('avaPhotoBtn').onclick = () => $('avaFile').click();
$('avaFile').onchange = async () => {
  const f = $('avaFile').files[0]; $('avaFile').value = ''; if (!f) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) return txt($('profMsg'), 'Нужна картинка PNG, JPEG, WebP или GIF');
  if (f.size > 20 * 1024 * 1024) return txt($('profMsg'), 'Картинка больше 20 МБ');
  $('avaPhotoBtn').disabled = true; txt($('profMsg'), 'Загружаем фото…');
  try {
    const blob = await squareImage(f, 256);
    const old = (await getProfile(me.id, true)).avatar_url;
    const path = `${me.id}/${crypto.randomUUID()}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
    const { error } = await sb.storage.from('avatars').upload(path, blob, { contentType: blob.type, upsert: false });
    if (error) throw error;
    const { error: e2 } = await sb.from('profiles').update({ avatar_url: path }).eq('id', me.id);
    if (e2) { await sb.storage.from('avatars').remove([path]).catch(() => {}); throw e2; }
    if (old && old !== path) await sb.storage.from('avatars').remove([old]).catch(() => {});
    await refreshMe(); txt($('profMsg'), '✅ Фото обновлено');
  } catch (err) { txt($('profMsg'), 'Фото не загружено: ' + ruErr(err)); }
  finally { $('avaPhotoBtn').disabled = !profileExt; }
};
$('avaRemoveBtn').onclick = async () => {
  if (!confirm('Убрать фото профиля? Останется буква на цветном фоне.')) return;
  try {
    const old = (await getProfile(me.id, true)).avatar_url;
    const { error } = await sb.from('profiles').update({ avatar_url: null }).eq('id', me.id); if (error) throw error;
    if (old) await sb.storage.from('avatars').remove([old]).catch(() => {});
    await refreshMe(); txt($('profMsg'), '✅ Фото убрано');
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
    refreshMe().catch(() => txt($('me'), me.email || '')); watchProfiles();
    if (location.hash === '#settings') openSettings(false);
    e2eStart().then(() => deviceCheck(true));
    loadChats();
  } else { currentChat = null; $('app').classList.remove('in-chat', 'in-settings'); qrFails = 0; startQr(); }
}
sb.auth.onAuthStateChange((_e, s) => onSession(s));
sb.auth.getSession().then(({ data }) => onSession(data.session));
