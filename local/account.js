// Вход через Google, выбор имени пользователя, поиск по @username (docs/design/google_username.md)
(() => {
const NICK_RE = /^[a-z0-9_]{5,32}$/;
const REDIRECT = 'https://darkalmas.github.io/messenger-web/local/';
const RULE = 'От 5 до 32 символов: латиница, цифры и _';
const MSG = { ok: n => '@' + n + ' свободно', invalid: RULE, reserved: 'Это имя недоступно', taken: 'Это имя уже занято', rate: 'Слишком часто, подождите немного', checking: 'Проверяем…' };
const isRate = e => e && (e.code === 'P0429' || /rate limited/i.test(e.message || '') || e.status === 429);

// ---------- кнопка Google ----------
const gBtn = $('googleBtn');
async function googleEnabled() {
  try { const r = await fetch(`${C.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: C.SUPABASE_KEY } }); const j = await r.json(); return !!(j.external && j.external.google); }
  catch (e) { return null; }
}
// Кнопка и «или» скрыты, пока сервер не скажет external.google === true (включится сама, когда провайдер включат)
function showGoogle(on) { gBtn.hidden = !on; $('googleSep').hidden = !on; }
(async () => {
  try { if (sessionStorage.getItem('local-msgr-google') === '1') showGoogle(true); } catch (e) { /* */ }
  const en = await googleEnabled();
  if (en === null) return; // ошибка сети — оставляем как есть (по умолчанию скрыто)
  showGoogle(en); try { sessionStorage.setItem('local-msgr-google', en ? '1' : '0'); } catch (e) { /* */ }
})();
gBtn.onclick = async () => {
  gBtn.disabled = true; gBtn.classList.add('busy');
  if (window.beforeSignIn && await window.beforeSignIn()) { gBtn.disabled = false; gBtn.classList.remove('busy'); return; }
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: REDIRECT } });
  if (error) { gBtn.disabled = false; gBtn.classList.remove('busy'); toast('Не удалось войти через Google: ' + ruErr(error), 3000); }
};

// ---------- возврат после Google (PKCE ?code= или implicit #access_token=) ----------
(async () => {
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
  const err = q.get('error_description') || h.get('error_description') || q.get('error') || h.get('error');
  const clean = () => history.replaceState(null, '', location.pathname);
  try {
    if (err) { clean(); toast('Вход через Google не удался: ' + err, 4000); return; }
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
    if (getCurrent && n === getCurrent()) { show('', RULE); return onState('same', n); }
    if (!NICK_RE.test(n)) { show(n ? 'bad' : '', RULE); return onState('invalid', n); }
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
$('nickLogout').onclick = async () => { nkDlg.close(); userSignOut = true; await (window.endSession ? window.endSession() : sb.auth.signOut({ scope: 'local' }).catch(() => {})); };
let checkedUid = null;
async function checkChosen(s) {
  if (!s) { checkedUid = null; if (nkDlg.open) nkDlg.close(); return; }
  if (checkedUid === s.user.id) return; checkedUid = s.user.id;
  const { data, error } = await sb.from('profiles').select('username_chosen').eq('id', s.user.id).maybeSingle();
  if (error || !data || data.username_chosen !== false) return;
  nkIn.value = ''; nk.show('', RULE); nkGo.disabled = true; suggest(s.user);
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
let fSeq = 0, fTimer = null, findRpc = true;
// Точный поиск: сначала rpc('find_user'), если функции ещё нет (42883/PGRST202) — eq по username, максимум 1 результат
async function findUser(n) {
  if (findRpc) {
    const { data, error } = await sb.rpc('find_user', { username: n });
    if (!error) { const r = Array.isArray(data) ? data[0] : data; if (r && r.id) seedProfile(r); return { list: r && r.id ? [r] : [] }; }
    if (error.code === '42883' || error.code === 'PGRST202') findRpc = false; else return { error };
  }
  return { list: [], error: { message: 'Поиск временно недоступен' } }; // прямое чтение profiles по имени не используем
}
// Подсказка в «Глобальном поиске»: серая, красная только для неожиданных ошибок; текст через textContent (без HTML)
function findHint(t, bad) {
  fRes.replaceChildren(); const h = document.createElement('li'); h.className = 'sec'; txt(h, 'Глобальный поиск');
  const li = document.createElement('li'); li.className = 'empty' + (bad ? ' bad' : ''); txt(li, t); fRes.append(h, li); fRes.hidden = false;
}
window.findUserExact = findUser; window.isRateErr = isRate;
// Один запрос на запрос: ответ на тот же q (в полёте или за последние 5 с) переиспользуем
const lookCache = {};
function lookup(q) {
  const c = lookCache[q]; if (c && (c.pending || Date.now() - c.at < 5000)) return c.p;
  const e = lookCache[q] = { pending: true, at: Date.now() };
  e.p = findUser(q).then(r => { e.pending = false; e.at = Date.now(); if (r.error) delete lookCache[q]; return r; });
  return e.p;
}
async function openDM(p) {
  const { data: chatId, error: ce } = await sb.rpc('create_direct_chat', { p_other: p.id });
  if (ce) return toast(ruErr(ce), 3000);
  fIn.value = ''; fRes.hidden = true; await loadChats();
  const c = document.querySelector(`#chatList li[data-id="${chatId}"]`); if (c) c.click();
}
/** Показ результата — только в блоке «Глобальный поиск» */
function renderFind(q, r) {
  const list = ((r && r.list) || []).filter(p => !me || p.id !== me.id).slice(0, 1);
  if (r.error && isRate(r.error)) return findHint(MSG.rate);
  if (r.error) return findHint(ruErr(r.error), true);
  if (!list.length) return findHint(r.list && r.list.length ? 'Это ваше собственное имя пользователя' : 'Пользователь @' + q + ' не найден');
  fRes.replaceChildren(); const h = document.createElement('li'); h.className = 'sec'; txt(h, 'Глобальный поиск'); fRes.append(h);
  for (const p of list) {
    const li = document.createElement('li'); li.tabIndex = 0;
    const a = document.createElement('span'); a.className = 'ava'; fillAvatar(a, p);
    const t = document.createElement('span'); const b = document.createElement('b'); txt(b, displayName(p)); const sm = document.createElement('small'); txt(sm, '@' + p.username); t.append(b, sm);
    li.append(a, t);
    li.onclick = li.onkeydown = ev => { if (ev.type === 'keydown' && ev.key !== 'Enter') return; openDM(p); };
    fRes.append(li);
  }
  fRes.hidden = false;
  return list[0];
}
/** Проверка имени до запроса: подсказка (серая) или ошибка (красная) в блоке */
function precheck(q, strict) {
  if (NICK_RE.test(q)) return true;
  findHint(RULE, strict || /[^a-z0-9_]/.test(q) || q.length > 32); return false;
}
fIn.addEventListener('input', () => {
  clearTimeout(fTimer); const my = ++fSeq;
  const q = normNick(fIn.value);
  if (!fIn.value.trim().startsWith('@') || !q) { fRes.hidden = true; fRes.replaceChildren(); return; }
  if (!precheck(q)) return;
  fTimer = setTimeout(async () => { const r = await lookup(q); if (my === fSeq) renderFind(q, r); }, 300);
});
// Enter / «Написать»: тот же запрос (без дубля), результат в блоке; найден — сразу открываем чат
window.findSubmit = async () => {
  clearTimeout(fTimer); const my = ++fSeq;
  const q = normNick(fIn.value); if (!q) return;
  if (!precheck(q, true)) return;
  const btn = $('newDirect'); if (btn.disabled) return;
  btn.style.width = btn.offsetWidth + 'px'; btn.disabled = true; btn.classList.add('busy');
  try { const r = await lookup(q); if (my !== fSeq) return; const p = renderFind(q, r); if (p) await openDM(p); }
  finally { btn.disabled = false; btn.classList.remove('busy'); btn.style.width = ''; }
};
})();
