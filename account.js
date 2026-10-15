// Вход через Google, выбор имени пользователя, поиск по @username (docs/design/google_username.md)
(() => {
const NICK_RE = /^[a-z0-9_]{5,32}$/;
const REDIRECT = 'https://darkalmas.github.io/messenger-web/';
const MSG = { ok: n => '@' + n + ' свободно', invalid: 'От 5 до 32 символов: a–z, 0–9 и _', reserved: 'Это имя недоступно', taken: 'Это имя уже занято', rate: 'Слишком часто, подождите немного', checking: 'Проверяем…' };
const isRate = e => e && (e.code === 'P0429' || /rate limited/i.test(e.message || '') || e.status === 429);

// ---------- кнопка Google ----------
const gBtn = $('googleBtn');
async function googleEnabled() {
  try { const r = await fetch(`${C.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: C.SUPABASE_KEY } }); const j = await r.json(); return !!(j.external && j.external.google); }
  catch (e) { return null; }
}
gBtn.onclick = async () => {
  gBtn.disabled = true; gBtn.classList.add('busy');
  const done = () => { gBtn.disabled = false; gBtn.classList.remove('busy'); };
  const en = await googleEnabled();
  if (en === false) { done(); return toast('Google-вход пока не включён', 3000); }
  if (en === null) { done(); return toast('Нет соединения с сервером', 3000); }
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: REDIRECT } });
  if (error) { done(); toast(/not enabled|unsupported provider/i.test(error.message) ? 'Google-вход пока не включён' : 'Не удалось войти через Google: ' + ruErr(error), 3000); }
};

// ---------- возврат после Google (PKCE ?code= или implicit #access_token=) ----------
(async () => {
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
  const err = q.get('error_description') || h.get('error_description') || q.get('error') || h.get('error');
  const clean = () => history.replaceState(null, '', location.pathname);
  try {
    if (err) { clean(); toast(/not enabled|unsupported provider/i.test(err) ? 'Google-вход пока не включён' : 'Вход через Google не удался: ' + err, 4000); return; }
    if (q.get('code')) { const c = q.get('code'); clean(); const { error } = await sb.auth.exchangeCodeForSession(c); if (error) throw error; }
    else if (h.get('access_token') && h.get('refresh_token')) { const at = h.get('access_token'), rt = h.get('refresh_token'); clean(); const { error } = await sb.auth.setSession({ access_token: at, refresh_token: rt }); if (error) throw error; }
  } catch (e) { toast('Вход через Google не удался: ' + ruErr(e), 4000); }
  // SIGNED_IN → onSession() в app.js: e2eStart, rebind_device и т.д. как при обычном входе
})();

// ---------- живая проверка имени ----------
function nickChecker(input, hint, onState, getCurrent) {
  let seq = 0, timer = null, backoffUntil = 0;
  const show = (cls, text) => { hint.className = 'nick-hint ' + cls; txt(hint, text); input.classList.toggle('bad', cls === 'bad'); };
  const run = async () => {
    const n = input.value; const my = ++seq;
    if (getCurrent && n === getCurrent()) { show('', ''); return onState('same', n); }
    if (!NICK_RE.test(n)) { show(n ? 'bad' : '', n ? MSG.invalid : ''); return onState('invalid', n); }
    if (Date.now() < backoffUntil) { show('wait', MSG.rate); onState('rate', n); clearTimeout(timer); timer = setTimeout(run, backoffUntil - Date.now()); return; }
    show('wait spin', MSG.checking); onState('checking', n);
    const { data, error } = await sb.rpc('check_username', { p_username: n });
    if (my !== seq) return; // устаревший ответ
    if (error) {
      if (isRate(error)) { backoffUntil = Date.now() + 3000; show('wait', MSG.rate); onState('rate', n); timer = setTimeout(run, 3000); return; }
      show('bad', ruErr(error)); return onState('error', n);
    }
    if (data === 'ok') show('ok', MSG.ok(n)); else show('bad', MSG[data] || MSG.invalid);
    onState(data, n);
  };
  input.addEventListener('input', () => {
    const v = input.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
    if (v !== input.value) input.value = v;
    seq++; clearTimeout(timer); timer = setTimeout(run, 300);
  });
  return { run, show, bump: () => seq++ };
}
async function saveNick(n) {
  const { data, error } = await sb.rpc('set_username', { p_username: n });
  if (error) return isRate(error) ? 'rate' : Promise.reject(error);
  return data;
}

// ---------- экран «Выберите имя пользователя» ----------
const nkDlg = $('nickDlg'), nkIn = $('nickInput'), nkHint = $('nickHint'), nkGo = $('nickGo');
nkDlg.addEventListener('cancel', e => e.preventDefault()); // блокирующий: Esc не закрывает
const nk = nickChecker(nkIn, nkHint, st => { nkGo.disabled = st !== 'ok'; });
function suggest(u) {
  const md = u.user_metadata || {};
  let base = String(md.full_name || md.name || (u.email || '').split('@')[0] || 'user').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  if (base.length < 3) base = 'user';
  const box = $('nickChips'); box.replaceChildren();
  const seen = new Set();
  while (seen.size < 3) seen.add(base + (seen.size === 0 && base.length >= 5 ? '' : Math.floor(10 + Math.random() * 990)));
  for (const s of seen) { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; txt(b, '@' + s); b.onclick = () => { nkIn.value = s; nk.bump(); nk.run(); }; box.append(b); }
}
nkGo.onclick = async () => {
  const n = nkIn.value; nkGo.disabled = true;
  try {
    const r = await saveNick(n);
    if (r === 'ok') { nkDlg.close(); await refreshMe(); toast('Имя сохранено'); return; }
    if (r === 'taken') { nk.show('bad', 'Только что заняли, выберите другое'); nkIn.focus(); return; }
    nk.show(r === 'rate' ? 'wait' : 'bad', r === 'rate' ? MSG.rate : (MSG[r] || MSG.invalid));
  } catch (e) { nk.show('bad', ruErr(e)); nkGo.disabled = false; }
};
$('nickLogout').onclick = async () => { nkDlg.close(); try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* */ } };
let checkedUid = null;
async function checkChosen(s) {
  if (!s) { checkedUid = null; if (nkDlg.open) nkDlg.close(); return; }
  if (checkedUid === s.user.id) return; checkedUid = s.user.id;
  const { data, error } = await sb.from('profiles').select('username_chosen').eq('id', s.user.id).maybeSingle();
  if (error || !data || data.username_chosen !== false) return;
  nkIn.value = ''; nk.show('', ''); nkGo.disabled = true; suggest(s.user);
  if (!nkDlg.open) nkDlg.showModal(); nkIn.focus();
}
sb.auth.onAuthStateChange((e, s) => { setTimeout(() => checkChosen(s), 0); });

// ---------- смена имени в профиле (те же проверки) ----------
const pNick = $('pNick'), pHint = $('pNickHint');
window.nickProfile = { state: 'same' };
nickChecker(pNick, pHint, st => { window.nickProfile.state = st; }, () => (profiles[me && me.id] || {}).username);
window.saveProfileNick = saveNick; window.NICK_MSG = MSG;

// ---------- поиск по @username ----------
const fIn = $('findUser'), fRes = $('findResults');
let fSeq = 0, fTimer = null;
const esc = s => s.replace(/[\\%_]/g, m => '\\' + m);
fIn.addEventListener('input', () => {
  clearTimeout(fTimer); const my = ++fSeq;
  const q = normNick(fIn.value);
  if (!fIn.value.trim().startsWith('@') || q.length < 1) { fRes.hidden = true; fRes.replaceChildren(); return; }
  fTimer = setTimeout(async () => {
    const { data, error } = await sb.from('profiles').select('*').ilike('username', esc(q) + '%').order('username').limit(10);
    if (my !== fSeq) return;
    fRes.replaceChildren(); const h = document.createElement('li'); h.className = 'sec'; txt(h, 'Глобальный поиск'); fRes.append(h);
    const list = (data || []).filter(p => !me || p.id !== me.id);
    if (error || !list.length) { const li = document.createElement('li'); li.className = 'empty'; txt(li, error ? ruErr(error) : 'Пользователь не найден'); fRes.append(li); }
    for (const p of list) {
      const li = document.createElement('li'); li.tabIndex = 0;
      const a = document.createElement('span'); a.className = 'ava'; fillAvatar(a, p);
      const t = document.createElement('span'); const b = document.createElement('b'); txt(b, displayName(p)); const sm = document.createElement('small'); txt(sm, '@' + p.username); t.append(b, sm);
      li.append(a, t);
      li.onclick = li.onkeydown = async ev => {
        if (ev.type === 'keydown' && ev.key !== 'Enter') return;
        const { data: chatId, error: ce } = await sb.rpc('create_direct_chat', { p_other: p.id });
        if (ce) return toast(ruErr(ce), 3000);
        fIn.value = ''; fRes.hidden = true; await loadChats();
        const c = document.querySelector(`#chatList li[data-id="${chatId}"]`); if (c) c.click();
      };
      fRes.append(li);
    }
    fRes.hidden = false;
  }, 300);
});
})();
