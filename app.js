const C = window.MSG_CONFIG;
const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: true, storage: window.sessionStorage, storageKey: 'msgr-auth', autoRefreshToken: true, detectSessionInUrl: false } });
const $ = id => document.getElementById(id);
let me = null, regMode = false, currentChat = null, chan = null, qrTimer = null;
const names = {};

function txt(el, s) { el.textContent = s; }

// ---------- русские тексты ошибок ----------
function ruErr(e) {
  const m = String((e && (e.message || e.error_description || e.error)) || e || '');
  const l = m.toLowerCase();
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
const e2eMod = import('./e2e.js').then(m => { m.init(sb); return (E2E = m); });
async function e2eStart() {
  try { const m = await e2eMod; await m.ensureReady(); e2eErr = null; }
  catch (e) { e2eErr = e; console.warn('E2E недоступно:', e); }
  return E2E && !e2eErr;
}
const sentOwn = {}; // подпись шифротекста → открытый текст (своё сообщение приходит по Realtime раньше, чем сохранится копия)
const ctSig = m => m.ciphertext && (m.ciphertext.sk || Object.values(m.ciphertext).map(x => x && x.b).sort()[0]);
function payloadText(pt) {
  let o; try { o = JSON.parse(pt); } catch { return pt; }
  if (!o || typeof o !== 'object') return pt;
  return (o.t || '') + (o.f ? (o.t ? '\n' : '') + '📎 Файл — откройте в приложении' : '');
}
async function decryptText(m) {
  const sig = ctSig(m);
  if (sig && sentOwn[sig]) return payloadText(sentOwn[sig]);
  if (!(await e2eStart())) return null;
  try {
    if (m.ciphertext.sk !== undefined) {
      try { return payloadText(await E2E.decryptGroup(m.chat_id, m)); }
      catch (e) { if (!(e instanceof Error) || !(e instanceof E2E.NoKey)) throw e; await E2E.receive(m.chat_id); return payloadText(await E2E.decryptGroup(m.chat_id, m)); }
    }
    const pt = await E2E.decryptDM(m);
    return pt == null ? { other: true } : payloadText(pt);
  } catch (e) { console.warn('decrypt', m.id, e); return { fail: true }; }
}
async function addMsg(m) {
  const d = document.createElement('div');
  d.className = 'msg' + (m.sender_id === me.id ? ' mine' : '');
  const small = document.createElement('small');
  txt(small, m.sender_id ? await nameOf(m.sender_id) : 'удалённый аккаунт');
  const b = document.createElement('span');
  let warn = null;
  if (m.ciphertext) {
    chatHasE2e = true;
    const t = await decryptText(m);
    if (typeof t === 'string') { txt(b, t); warn = document.createElement('em'); warn.className = 'okE2e'; txt(warn, '🔒 сквозное шифрование'); }
    else { b.className = 'e2e'; txt(b, t && t.other ? '🔒 зашифровано для другого устройства' : t && t.fail ? '🔒 не удалось расшифровать' : '🔒 зашифровано, откройте в приложении'); }
  }
  else { txt(b, m.body); warn = document.createElement('em'); warn.className = 'noe2e'; txt(warn, '⚠ не зашифровано'); }
  d.append(small, b); if (warn) d.append(warn);
  const box = $('messages'); box.appendChild(d); box.scrollTop = box.scrollHeight;
}
async function openChat(c, li) {
  currentChat = c;
  document.querySelectorAll('#chatList li').forEach(x => x.classList.remove('active')); li.classList.add('active');
  chatHasE2e = false; peerId = null;
  txt($('chatTitle'), li.textContent); $('sendForm').hidden = false; $('messages').innerHTML = '';
  if (c.kind === 'direct') { const { data: pm } = await sb.from('chat_members').select('user_id').eq('chat_id', c.id).neq('user_id', me.id).limit(1).maybeSingle(); peerId = pm ? pm.user_id : null; }
  else if (await e2eStart()) { try { await E2E.receive(c.id); } catch (e) { console.warn(e); } }
  if (currentChat !== c) return;
  const { data } = await sb.from('messages').select('*').eq('chat_id', c.id).order('created_at').limit(200);
  for (const m of data || []) await addMsg(m);
  if (chan) sb.removeChannel(chan);
  chan = sb.channel('chat-' + c.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${c.id}` }, p => addMsg(p.new))
    .subscribe();
}
$('sendForm').onsubmit = async e => {
  e.preventDefault();
  const body = $('msgInput').value.trim(); if (!body || !currentChat) return;
  const chat = currentChat;
  $('msgInput').value = '';
  try { await sendText(chat, body); }
  catch (err) { $('msgInput').value = body; alert(err && err.userMsg ? err.userMsg : ruErr(err)); }
};
function userErr(msg) { const e = new Error(msg); e.userMsg = msg; return e; }
async function insertEncrypted(row, pt) {
  const sig = row.ciphertext.sk || Object.values(row.ciphertext).map(x => x.b).sort()[0];
  sentOwn[sig] = pt;
  const { data, error } = await sb.from('messages').insert(row).select('id').single();
  if (error) { delete sentOwn[sig]; throw error; }
  await E2E.rememberOwn(data.id, pt, row.ciphertext.sk);
}
async function sendText(chat, body) {
  const ok = await e2eStart();
  if (chat.kind === 'direct' && peerId) {
    if (ok && await E2E.peerHasKeys(peerId)) {
      let r;
      try { r = await E2E.encryptDM(peerId, body); }
      catch (e) {
        if (!(e instanceof E2E.KeyChange)) throw e;
        if (!confirm('Ключ безопасности собеседника изменился (новое устройство или переустановка). Сообщение НЕ отправлено.\n\nЕсли вы уверены, что это действительно собеседник (лучше сверить код безопасности в приложении), нажмите «ОК», чтобы принять новый ключ и отправить.')) throw userErr('Сообщение не отправлено: ключ собеседника изменился.');
        await E2E.acceptKeys(e.userId); r = await E2E.encryptDM(peerId, body);
      }
      if (!r) throw userErr('У собеседника больше нет ключей шифрования. Сообщение не отправлено, попробуйте ещё раз.');
      return insertEncrypted({ chat_id: chat.id, sender_id: me.id, body: '', ciphertext: r.ct }, r.pt);
    }
    if (!ok && !confirm('Шифрование на этом устройстве не запустилось. Отправить сообщение БЕЗ сквозного шифрования?')) throw userErr('Сообщение не отправлено.');
  } else if (chat.kind === 'group' && ok) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { epoch, others } = await E2E.distribute(chat.id);
      if (!others) break; // ни у кого из участников нет ключей — открытый текст с пометкой
      const r = await E2E.encryptGroup(chat.id, epoch, body);
      try { return await insertEncrypted({ chat_id: chat.id, sender_id: me.id, body: '', ciphertext: r.ct, key_epoch: epoch, sender_device: E2E.deviceId() }, r.pt); }
      catch (e) { if (!String(e && e.message).includes('stale key epoch')) throw e; }
    }
  }
  const { error } = await sb.from('messages').insert({ chat_id: chat.id, sender_id: me.id, body });
  if (error) throw error;
};
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
    e2eStart();
    loadChats();
  } else { qrFails = 0; startQr(); }
}
sb.auth.onAuthStateChange((_e, s) => onSession(s));
sb.auth.getSession().then(({ data }) => onSession(data.session));
