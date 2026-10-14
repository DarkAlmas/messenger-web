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
  const { data: members, error } = await sb.from('chat_members').select('chat_id, chats(id, title, kind)').eq('user_id', me.id);
  const ul = $('chatList'); ul.innerHTML = '';
  if (error) { txt($('chatTitle'), ruErr(error)); return; }
  for (const m of members || []) {
    const c = m.chats; if (!c) continue;
    const li = document.createElement('li');
    li.dataset.id = c.id;
    txt(li, c.title || 'Личный чат');
    li.onclick = () => openChat(c, li);
    ul.appendChild(li);
    if (c.kind === 'direct' && !c.title) {
      sb.from('chat_members').select('user_id').eq('chat_id', c.id).neq('user_id', me.id).limit(1).maybeSingle()
        .then(async ({ data }) => { if (data) txt(li, await nameOf(data.user_id)); });
    }
  }
}
async function nameOf(id) {
  if (names[id]) return names[id];
  const { data } = await sb.from('profiles').select('username, display_name').eq('id', id).maybeSingle();
  return (names[id] = data ? ((data.display_name && data.display_name !== data.username) ? data.display_name + ' @' + data.username : '@' + data.username) : 'неизвестный');
}
let chatHasE2e = false, peerId = null;
// ---------- сквозное шифрование (e2e.js + libsignal WASM) ----------
let E2E = null, e2eErr = null;
const e2eMod = import('./e2e.js?v=20261014e').then(m => { m.init(sb); return (E2E = m); });
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
async function renderMsg(m, d) {
  d.className = 'msg' + (m.sender_id === me.id ? ' mine' : '');
  d.textContent = '';
  const small = document.createElement('small');
  txt(small, m.sender_id ? await nameOf(m.sender_id) : 'удалённый аккаунт');
  const b = document.createElement('span');
  d.append(small, b);
  let pl = null;
  if (m.ciphertext) {
    chatHasE2e = true;
    pl = await decryptPayload(m);
    if (pl && !pl.other && !pl.fail) {
      txt(b, pl.t);
      if (pl.f) {
        const fb = document.createElement('button'); fb.type = 'button'; fb.className = 'file';
        txt(fb, '📎 ' + (pl.f.n || 'файл') + (pl.f.s ? ' (' + fmtSize(pl.f.s) + ')' : ''));
        fb.onclick = () => downloadFile(pl.f, m.sender_id !== me.id).catch(e => alert(e.userMsg || ruErr(e)));
        if (pl.t) d.append(document.createElement('br'));
        d.append(fb);
      }
      if (m.sender_id === me.id && !pl.f) {
        const eb = document.createElement('button'); eb.type = 'button'; eb.className = 'edit'; eb.title = 'Изменить'; txt(eb, '✏️');
        eb.onclick = () => editMsg(m, pl.t);
        small.append(eb);
      }
      const w = document.createElement('em'); w.className = 'okE2e'; txt(w, '🔒 сквозное шифрование'); d.append(w);
    } else { b.className = 'e2e'; txt(b, pl && pl.other ? '🔒 зашифровано для другого устройства' : pl && pl.fail ? '🔒 не удалось расшифровать' : '🔒 зашифровано, откройте в приложении'); }
  } else {
    txt(b, m.body);
    const w = document.createElement('em'); w.className = 'noe2e'; txt(w, '⚠ не зашифровано'); d.append(w);
  }
  if (m.edited_at) { const e = document.createElement('span'); e.className = 'edited'; txt(e, '(изм.)'); small.append(e); }
}
async function addMsg(m) {
  if (msgEls[m.id]) return updMsg(m);
  const d = document.createElement('div'); d.dataset.id = m.id; msgEls[m.id] = d;
  const box = $('messages'); box.appendChild(d);
  await renderMsg(m, d);
  box.scrollTop = box.scrollHeight;
}
async function updMsg(m) { const d = msgEls[m.id]; if (d) await renderMsg(m, d); }
async function openChat(c, li) {
  currentChat = c;
  document.querySelectorAll('#chatList li').forEach(x => x.classList.remove('active')); li.classList.add('active');
  chatHasE2e = false; peerId = null;
  for (const k of Object.keys(msgEls)) delete msgEls[k];
  txt($('chatTitle'), li.textContent); $('sendForm').hidden = false; $('messages').innerHTML = ''; $('safetyBtn').hidden = true;
  if (c.kind === 'direct') {
    const { data: pm } = await sb.from('chat_members').select('user_id').eq('chat_id', c.id).neq('user_id', me.id).limit(1).maybeSingle(); peerId = pm ? pm.user_id : null;
    if (peerId && await e2eStart()) E2E.peerHasKeys(peerId).then(h => { if (currentChat === c) { $('safetyBtn').hidden = !h; safetyLabel(); } }).catch(() => {});
  }
  else if (await e2eStart()) { try { await E2E.receive(c.id); } catch (e) { showErr('Не удалось получить ключи группы: ' + ruErr(e)); } }
  if (currentChat !== c) return;
  const { data } = await sb.from('messages').select('*').eq('chat_id', c.id).order('created_at').limit(200);
  for (const m of data || []) await addMsg(m);
  if (chan) sb.removeChannel(chan);
  chan = sb.channel('chat-' + c.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${c.id}` }, p => addMsg(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `chat_id=eq.${c.id}` }, p => updMsg(p.new))
    .subscribe();
}
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
  const url = URL.createObjectURL(new Blob([plain], { type: 'application/octet-stream' }));
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
$('newDirect').onclick = async () => {
  const nick = normNick($('findUser').value); if (!nick) return;
  const { data: u } = await sb.from('profiles').select('id').eq('username', nick).maybeSingle();
  if (!u) return alert('Пользователь не найден');
  const { error } = await sb.rpc('create_direct_chat', { p_other: u.id });
  if (error) return alert(ruErr(error));
  $('findUser').value = ''; loadChats();
};

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
    txt($('me'), await nameOf(me.id));
    e2eStart().then(() => deviceCheck(true));
    loadChats();
  } else { qrFails = 0; startQr(); }
}
sb.auth.onAuthStateChange((_e, s) => onSession(s));
sb.auth.getSession().then(({ data }) => onSession(data.session));
