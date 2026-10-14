const C = window.MSG_CONFIG;
const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false } });
const $ = id => document.getElementById(id);
let me = null, regMode = false, currentChat = null, chan = null, qrTimer = null;
const names = {};

function txt(el, s) { el.textContent = s; }

// ---------- вход по почте ----------
$('toggleReg').onclick = () => {
  regMode = !regMode;
  $('username').hidden = !regMode;
  $('username').required = regMode;
  txt($('loginBtn'), regMode ? 'Зарегистрироваться' : 'Войти');
  txt($('toggleReg'), regMode ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Регистрация');
};
$('loginForm').onsubmit = async e => {
  e.preventDefault();
  const email = $('email').value.trim(), password = $('password').value;
  txt($('authMsg'), '');
  if (regMode) {
    const username = $('username').value.trim().toLowerCase();
    const { error } = await sb.auth.signUp({ email, password, options: { data: { username, display_name: username } } });
    txt($('authMsg'), error ? error.message : 'Письмо с подтверждением отправлено на почту. Подтвердите и войдите.');
  } else {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) txt($('authMsg'), error.message);
  }
};
$('logout').onclick = async () => { try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* сеть недоступна — локальную сессию всё равно чистим */ } };

// ---------- вход по QR ----------
async function fn(name, body) {
  const r = await fetch(`${C.SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: C.SUPABASE_KEY, Authorization: `Bearer ${C.SUPABASE_KEY}` },
    body: JSON.stringify(body || {})
  });
  return r.json();
}
async function startQr() {
  clearInterval(qrTimer);
  let q;
  try { q = await fn('qr-create'); } catch (e) { txt($('qrStatus'), 'QR пока недоступен'); return; }
  if (!q || !/^[0-9a-f]{64}$/.test(q.token || '')) { txt($('qrStatus'), 'QR пока недоступен'); return; }
  const qr = qrcode(0, 'M'); qr.addData(JSON.stringify({ t: 'msgr-login', v: 1, token: q.token })); qr.make();
  $('qr').innerHTML = qr.createSvgTag(5, 0);
  txt($('qrStatus'), 'Откройте приложение на телефоне и отсканируйте код. Входите только если сами только что открыли этот QR.');
  const expires = q.expires_at ? new Date(q.expires_at).getTime() : Date.now() + 110000;
  qrTimer = setInterval(async () => {
    if (Date.now() >= expires) { clearInterval(qrTimer); return startQr(); }
    let p; try { p = await fn('qr-poll', { token: q.token, poll_secret: q.poll_secret }); } catch (e) { return; }
    if (!p) return;
    if (p.status === 'approved') {
      clearInterval(qrTimer);
      const s = p.session;
      if (s && s.access_token && s.refresh_token) await sb.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
    } else if (p.status === 'denied' || p.status === 'expired') { clearInterval(qrTimer); startQr(); }
  }, 2000);
}

// ---------- чаты ----------
async function loadChats() {
  const { data: members, error } = await sb.from('chat_members').select('chat_id, chats(id, title, kind)').eq('user_id', me.id);
  const ul = $('chatList'); ul.innerHTML = '';
  if (error) { txt($('chatTitle'), error.message); return; }
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
async function addMsg(m) {
  const d = document.createElement('div');
  d.className = 'msg' + (m.sender_id === me.id ? ' mine' : '');
  const small = document.createElement('small');
  txt(small, m.sender_id ? await nameOf(m.sender_id) : 'удалённый аккаунт');
  const b = document.createElement('span'); txt(b, m.body);
  d.append(small, b);
  const box = $('messages'); box.appendChild(d); box.scrollTop = box.scrollHeight;
}
async function openChat(c, li) {
  currentChat = c;
  document.querySelectorAll('#chatList li').forEach(x => x.classList.remove('active')); li.classList.add('active');
  txt($('chatTitle'), li.textContent); $('sendForm').hidden = false; $('messages').innerHTML = '';
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
  $('msgInput').value = '';
  const { error } = await sb.from('messages').insert({ chat_id: currentChat.id, sender_id: me.id, body });
  if (error) alert(error.message);
};
$('newDirect').onclick = async () => {
  const nick = $('findUser').value.trim().toLowerCase(); if (!nick) return;
  const { data: u } = await sb.from('profiles').select('id').eq('username', nick).maybeSingle();
  if (!u) return alert('Пользователь не найден');
  const { error } = await sb.rpc('create_direct_chat', { p_other: u.id });
  if (error) return alert(error.message);
  $('findUser').value = ''; loadChats();
};

// ---------- состояние ----------
async function onSession(session) {
  me = session ? session.user : null;
  $('auth').hidden = !!me; $('app').hidden = !me;
  if (me) {
    clearInterval(qrTimer);
    txt($('me'), await nameOf(me.id));
    loadChats();
  } else startQr();
}
sb.auth.onAuthStateChange((_e, s) => onSession(s));
sb.auth.getSession().then(({ data }) => onSession(data.session));
