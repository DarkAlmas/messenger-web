// Сквозное шифрование на сайте: официальный libsignal (Rust), собранный в WASM (vendor/sigwasm).
// Протокол и формат — как в Android-клиенте (E2eCore/E2eGroup): X3DH/PQXDH + Double Ratchet, Kyber-1024, Sender Keys.
// Своей криптографии здесь нет.
import initWasm, { Store, distId, compareScannable } from './vendor/sigwasm/sigwasm.js?v=20261014k';

const OTK_BATCH = 100, OTK_LOW = 20, CLAIM_TTL = 10 * 60 * 1000, SEND_FRESH = 60 * 1000;
let sb, store = null, kv = {}, db, uid = null, ready = null;
const claimedAt = {};
let rebindFail = false;
/** Был ли при этом входе неудачный перенос ключей (тогда переписку можно вернуть из резервной копии) */
export const rebindFailed = () => rebindFail;
let freshDev = false; // в этом запуске заведены новые ключи (новое устройство)
export const isFreshDevice = () => freshDev;
/** Аргументы rebind_device. Сюда же добавится подпись серверного challenge старым identity-ключом, когда сервер её потребует. */
async function rebindArgs(oldDev) { return { p_old_device: oldDev, p_secret: kv.dsec }; }
/** Секрет устройства (32 случайных байта, base64url без '='): хранится только рядом с ключами и уходит только в set_device_secret/rebind_device. Не логировать. */
function newSecret() { const b = crypto.getRandomValues(new Uint8Array(32)); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
/** Свежий секрет после rebind_device и после регистрации новых ключей. Локально заменяем только после успеха RPC;
 *  при ошибке старый секрет остаётся (rebind по нему ещё работает), смену повторим при следующем запуске. */
async function ensureSecret(rotate) {
  if (!rotate && kv.dsec && kv.dsec_set === '1' && kv.dsec_rotate !== '1') return;
  const fresh = newSecret();
  const { error } = await sb.rpc('set_device_secret', { p_secret: fresh });
  if (error) { console.warn('set_device_secret: ошибка', error.code || error.message); if (kv.dsec) await put('dsec_rotate', '1'); return; }
  await put('dsec', fresh); await put('dsec_set', '1'); if (kv.dsec_rotate) await del('dsec_rotate');
}
export class KeyChange extends Error { constructor(u) { super('Ключ безопасности собеседника изменился'); this.userId = u; } }
export class NoKey extends Error {}

// ---- IndexedDB ----
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('local-msgr-e2e', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function tx(mode, fn) { return new Promise((res, rej) => { const t = db.transaction('kv', mode); const s = t.objectStore('kv'); const out = fn(s); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); }
async function loadAll() { const out = {}; await new Promise((res, rej) => { const c = db.transaction('kv').objectStore('kv').openCursor(); c.onsuccess = () => { const x = c.result; if (!x) return res(); out[x.key] = x.value; x.continue(); }; c.onerror = () => rej(c.error); }); return out; }
let dirty = false, ver = null;
async function put(k, v) { kv[k] = v; dirty = true; await tx('readwrite', s => s.put(v, k)); }
async function del(k) { delete kv[k]; dirty = true; await tx('readwrite', s => s.delete(k)); }
async function saveStore() { await put('state', store.export()); }
const jlist = k => { try { const v = JSON.parse(kv[k] || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const jget = k => { try { return kv[k] ? JSON.parse(kv[k]) : {}; } catch { return {}; } };

// Все операции с хранилищем строго по очереди (ratchet нельзя продвигать параллельно)
// Между вкладками — Web Locks: одно хранилище IndexedDB, ratchet продвигает только одна вкладка за раз.
// Перед операцией, если другая вкладка что-то записала (ключ 'ver'), перечитываем состояние.
let chain = Promise.resolve();
// Другие вкладки узнают об изменениях (доверие к ключам, события смены ключа) и перечитывают общее хранилище IndexedDB
const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel('local-msgr-e2e') : null;
if (bc) bc.onmessage = () => { if (db) locked(async () => {}).then(() => dispatchEvent(new Event('e2e-changed'))).catch(() => {}); };
async function syncFromDb() {
  if (!db) return;
  const v = await tx('readonly', s => s.get('ver'));
  if (v === ver) return;
  kv = await loadAll(); ver = v;
  if (!kv.dev) ready = null; // другая вкладка вышла из аккаунта
  if (store) { store.free(); store = null; }
  if (kv.state) store = Store.load(kv.state);
}
async function runLocked(fn) {
  await syncFromDb(); dirty = false;
  try { return await fn(); }
  finally { if (dirty && db) { ver = Math.random().toString(36).slice(2); kv.ver = ver; await tx('readwrite', s => s.put(ver, 'ver')); dirty = false; if (bc) try { bc.postMessage(ver); } catch { /* */ } } }
}
// Блокировку между вкладками ждём не дольше LOCK_WAIT: зависшая/замороженная (Android Chrome в фоне) вкладка,
// держащая 'local-msgr-e2e', иначе навсегда останавливала расшифровку и загрузку чата — сообщения молча не показывались.
// Держим блокировку не дольше LOCK_HOLD: операция, ждущая сеть без ответа, отпускает очередь (её результат придёт позже).
const LOCK_WAIT = 12000, LOCK_HOLD = 30000;
export class LockBusy extends Error { constructor() { super('шифрование занято другой вкладкой этого браузера'); this.name = 'LockBusy'; this.userMsg = 'Шифрование занято другой вкладкой этого браузера. Закройте лишние вкладки сайта и обновите страницу.'; } }
export class E2eTimeout extends Error { constructor() { super('операция шифрования не завершилась вовремя'); this.name = 'E2eTimeout'; this.userMsg = 'Шифрование не ответило вовремя — сообщение не отправлено. Повторите.'; } }
// Причина частого «операция дольше 30 с»: таймер не снимался после завершения операции и срабатывал всегда.
// Теперь: таймер снимается; если операция действительно зависла — очередь освобождается, а её поздний результат отбрасывается (ошибка E2eTimeout).
function holdCap(p, onExpire) {
  let t; const done = new Promise(r => { t = setTimeout(() => { console.warn('e2e: операция дольше ' + LOCK_HOLD / 1000 + ' с — очередь шифрования освобождена'); if (onExpire) onExpire(); r(); }, LOCK_HOLD); });
  return Promise.race([p.finally(() => clearTimeout(t)), done]);
}
const locked = fn => {
  const run = () => {
    if (!navigator.locks) return runLocked(fn);
    let res, rej; const out = new Promise((a, b) => { res = a; rej = b; });
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ac && setTimeout(() => ac.abort(), LOCK_WAIT);
    let expired = false;
    navigator.locks.request('local-msgr-e2e', ac ? { signal: ac.signal } : {}, () => { clearTimeout(t); const p = runLocked(fn); p.then(v => expired ? rej(new E2eTimeout()) : res(v), rej); return holdCap(p.catch(() => {}), () => { expired = true; rej(new E2eTimeout()); }); })
      .catch(e => { clearTimeout(t); if (e && e.name === 'AbortError') { console.error('e2e: блокировка msgr-e2e не получена за ' + LOCK_WAIT / 1000 + ' с (другая вкладка)'); rej(new LockBusy()); } else rej(e); });
    return out;
  };
  // Очередь без своего таймера: раньше таймер 30 с запускался в момент постановки в очередь (включая ожидание предыдущих
  // операций) — при пачке расшифровок он срабатывал ложно и пускал следующие операции параллельно. Время удержания
  // ограничено внутри блокировки (holdCap), ожидание блокировки — LOCK_WAIT.
  const p = chain.then(run, run); chain = p.catch(() => {}); return p;
};

function sessionId(jwt) { const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(p)))).session_id; }
async function token() {
  let s = null; try { const { data } = await sb.auth.getSession(); s = data.session; } catch (e) { /* без сети обновление токена падает */ }
  if (!s && !navigator.onLine) { try { const o = JSON.parse(localStorage.getItem('local-msgr-auth') || 'null'); if (o && o.access_token && o.user && o.user.id) s = o; } catch { /* */ } } // офлайн: только id сессии и пользователя из локальной сессии
  if (!s) throw new Error('нет сессии'); return s;
}
const isNetErr = e => !(e && (e.name === 'IdentityMismatch' || e.name === 'KeysLost')) && (!navigator.onLine || /failed to fetch|networkerror|network request failed|load failed|fetch|internet/i.test(String((e && (e.message || e)) || '')));
let deferredSync = false;
/** Ключи загружены локально, а серверная часть (проверка строки, prekeys, секрет) отложена до появления сети */
export const syncPending = () => deferredSync;
export async function syncDeferred() { if (!deferredSync) return false; deferredSync = false; ready = null; await ensureReady(); return true; }
const chk = ({ data, error }) => { if (error) throw error; return data; };
export const deviceId = () => kv.dev || null;
// Быстрый просмотр без блокировки и без запуска шифрования (20.10, Support Bot: ~10 с заглушек на новом устройстве).
// Только чтение IndexedDB: сохранённый текст (pts:) или «конверта для этого устройства нет» — такие сообщения показываем сразу,
// не дожидаясь генерации/загрузки ключей. Всё остальное → null, обычная расшифровка под блокировкой.
let peekDb = null;
export async function peek(m) {
  try {
    if (!m || !m.ciphertext || m.ciphertext.sk !== undefined) return null;
    if (kv['pts:' + m.id]) return { pt: kv['pts:' + m.id] };
    if (!peekDb) peekDb = idb();
    const d = await peekDb;
    const get = k => new Promise((res, rej) => { const r = d.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const pt = await get('pts:' + m.id); if (pt) return { pt };
    let sid = null; try { sid = sessionId((await token()).access_token); } catch { return null; }
    const dev = kv.dev || await get('dev'); let old = []; try { old = JSON.parse((kv.olddevs || await get('olddevs')) || '[]'); } catch { /* */ }
    const mine = [sid, dev, ...old].filter(Boolean);
    return mine.some(x => m.ciphertext[x]) ? null : { other: true };
  } catch { return null; }
}
/** Выход из состояния IdentityMismatch: серверную строку не трогаем (ни перезаписи, ни удаления — это улика возможной подмены),
 *  только помечаем, что при следующем входе rebind в эту строку запрещён: устройство проходит обычную регистрацию с новым session_id.
 *  Доверие, расшифрованная история (pt:/pts:/ptg:) и резервная копия остаются (keep в ensureReadyFor). */
export async function resetForRelogin() {
  if (!db) return;
  return locked(async () => { await put('norebind', '1'); });
}

export function init(client) { sb = client; }
export class KeysLost extends Error {}
export class RebindBlocked extends Error { constructor() { super('прежний сеанс этого устройства ещё активен на сервере'); this.name = 'RebindBlocked'; this.userMsg = 'Прежний сеанс на этом устройстве ещё не завершён на сервере, поэтому ключи шифрования пока не перенесены. Сообщения не отправляются.'; } }
const rebindBlocked = () => new RebindBlocked();
/** На сервере у строки этого устройства другой identity-ключ, чем в браузере: отправка остановлена, нужен повторный вход. */
export class IdentityMismatch extends KeysLost {
  constructor(dev, localFp, serverFp) { super('ключи этого устройства не совпадают с сервером'); this.name = 'IdentityMismatch'; this.code = 'E2E_IDENTITY_MISMATCH'; this.deviceId = dev || null; this.localFp = localFp || null; this.serverFp = serverFp || null; this.userMsg = 'Ключи этого устройства не совпадают с сервером. Отправка остановлена — войдите заново.'; }
}
const keysLost = why => { const e = new KeysLost('Ключи шифрования этого устройства не загрузились (' + why + '). Новые ключи НЕ создаются автоматически, чтобы не сломать переписку. Обновите страницу; если не поможет — выйдите и войдите снова.'); e.userMsg = e.message; return e; };

/** Ключи для текущей сессии (session_id = device_id), публикация, пополнение одноразовых prekey. */
// Одна инициализация на сессию: device_id = session_id из JWT текущей сессии. Новая сессия (выход → вход) — новая инициализация
// (rebind_device старого устройства или новые ключи); прежний id устройства как device_id не используется.
let readySid = null;
export async function ensureReady() {
  const sid = sessionId((await token()).access_token);
  if (sid !== readySid) { ready = null; readySid = sid; }
  return ensureReadyFor(sid);
}
function ensureReadyFor(sid) {
  if (!ready) ready = locked(async () => {
    freshDev = false; rebindFail = false; let localOk = false;
    await initWasm({ module_or_path: new URL('./vendor/sigwasm/sigwasm_bg.wasm?v=20261014k', import.meta.url) });
    if (!db) {
      try { db = await idb(); await syncFromDb(); }
      catch (err) { db = null; console.error(err); throw keysLost('хранилище браузера (IndexedDB) недоступно: ' + ((err && err.message) || err)); }
    }
    const s = await token(); uid = s.user.id;
    const dev = sessionId(s.access_token);
    if (dev !== sid) throw new Error('сессия сменилась во время запуска шифрования'); // следующий вызов начнёт заново
    if (kv.dev === dev && kv.uid === uid && !kv.state) throw keysLost('локальное хранилище ключей повреждено (нет состояния)');
    // Новая сессия того же пользователя, локальные ключи целы: переносим строку ключей старого устройства на новую сессию
    // (rpc rebind_device) ДО публикации новых ключей — собеседники не увидят «ключ изменился». Не вышло — обычная регистрация.
    if (kv.dev && kv.dev !== dev && kv.uid === uid && kv.state && kv.dsec && kv.norebind !== '1') {
      const { data: has, error: he } = await sb.from('devices_keys').select('device_id').eq('device_id', dev).maybeSingle();
      if (he && isNetErr(he)) throw he; // без сети не переносим и не заводим новые ключи — повторим при связи
      if (!he && !has) {
        const adopt = async nd => {
          const cand = Store.load(kv.state); // проверяем, что состояние читается, до смены id
          const old = jlist('olddevs'); if (!old.includes(kv.dev)) old.push(kv.dev);
          await put('olddevs', JSON.stringify(old.slice(-20))); await put('dev', String(nd));
          store = cand; await put('uploaded', '1');
          // Сессии libsignal привязаны к адресу (device_id). После rebind у собеседника нет сессии с НОВЫМ адресом,
          // а наша неподтверждённая сессия продолжила бы слать PreKey-сообщения с уже израсходованным одноразовым ключом
          // собеседника → у него «invalid prekey identifier» (tg26). Поэтому каждому собеседнику — новый X3DH со свежим бандлом.
          await put('refresh', JSON.stringify(sessionDevs(cand))); await put('refresh_mig', '1');
          for (const k of Object.keys(claimedAt)) delete claimedAt[k];
          for (const k of Object.keys(kv)) if (k.startsWith('skd:')) await del(k); // ключи групп раздать новому id
          // Сразу после успешного rebind replace_prekeys не вызываем: перенесённые одноразовые ключи остаются (догружаем только если их 0)
          if (!(chk(await sb.rpc('my_prekey_count')) > 0)) await topUp();
          await ensureSecret(true); await put('dsec_mig', '1'); // секрет старого устройства больше не используем
          return kv.dev;
        };
        try {
          const { data: nd, error: re } = await sb.rpc('rebind_device', await rebindArgs(kv.dev));
          if (re) { // коды Hack Bot (20.10): RB001 denied, RB002 прежний сеанс активен, RB003 у сеанса уже есть устройство; текст — запасной вариант
            const c = re.code || '', t = re.message || '';
            const kind = c === 'RB001' ? 'denied' : c === 'RB002' ? 'active' : c === 'RB003' ? 'has' : /rebind denied/i.test(t) ? 'denied' : /active session/i.test(t) ? 'active' : /already has a device/i.test(t) ? 'has' : '';
            const e = new Error(kind === 'denied' ? 'rebind denied' : kind === 'active' ? 'rebind_device: old device still has an active session' : 'rebind_device: ' + (t || c || 'ошибка')); e.raw = re; throw e; }
          if (!nd) throw new Error('rebind_device вернул пустой id');
          return await adopt(nd);
        } catch (err) {
          // Ответ rebind_device потерялся, но перенос прошёл: строка этой сессии уже с НАШИМ identity — принимаем её, новые ключи не заводим
          if (!/rebind denied/.test((err && err.message) || '')) {
            try {
              const { data: r2 } = await sb.from('devices_keys').select('identity_pub').eq('device_id', dev).maybeSingle();
              if (r2 && r2.identity_pub === identityPub(Store.load(kv.state))) return await adopt(dev);
            } catch { /* ниже — обычная регистрация */ }
          }
          // 20.10 (Hack Bot): «old device still has an active session» — прежний сеанс этого браузера не закрыт на сервере.
          // Новое устройство молча НЕ заводим (копились лишние устройства, ломалась старая история): ключи остаются как есть,
          // пользователь решает — повторить после закрытия прежнего сеанса или явно зарегистрировать новое устройство.
          if (/active session/i.test((err && err.message) || '')) throw rebindBlocked();
          // Сбой сети / сервера (не «denied») — тоже не регистрируем: повторим при следующем запуске
          if (!/rebind denied/.test((err && err.message) || '') && (isNetErr(err) || !(err && err.raw))) throw err;
          // 'rebind denied' — штатно (старый сеанс отозван/секрет не подошёл): молча заводим новые ключи
          if (!/rebind denied/.test((err && err.message) || '')) console.warn('rebind_device не удался, регистрируем новое устройство:', err && err.message);
          rebindFail = true;
        }
      }
    }
    if (kv.dev !== dev || kv.uid !== uid) {
      // Новые ключи — только для новой сессии. Если сервер уже знает это устройство, а локальных ключей нет
      // (хранилище браузера очищено/сбой IndexedDB), молча не генерируем: собеседники увидели бы «ключ изменился».
      if (!kv.dev || kv.dev === dev) {
        const { data: row, error } = await sb.from('devices_keys').select('device_id').eq('device_id', dev).maybeSingle();
        if (error) throw error;
        if (row) throw keysLost('ключи этого устройства есть на сервере, но не найдены в браузере');
      }
      // Новая сессия = новое устройство; доверие (trust/verified) к собеседникам того же пользователя сохраняем
      const keepTrust = kv.uid === uid;
      // тот же пользователь: доверие и уже расшифрованный текст (pts:/pt:/ptg:) оставляем — история и резервная копия не теряются
      const keep = k => keepTrust && /^(trust|pending|verified|kc|nd|seen|iks|kcblock|pts|pt|ptg):/.test(k);
      for (const k of Object.keys(kv)) if (!keep(k)) await del(k);
      store = Store.newDevice(); freshDev = true;
      await saveStore(); await put('otk_next', '1'); await put('uid', uid); await put('dev', dev);
    } else {
      try { store = Store.load(kv.state); } catch (err) { console.error(err); throw keysLost('не удалось прочитать сохранённые ключи'); }
      localOk = true;
    }
    try {
      // Строки devices_keys этой сессии нет на сервере (удалена/не дошла) — регистрируем ключи заново, иначе собеседники не могут писать
      if (localOk && kv.uploaded === '1') {
        const { data: row, error } = await sb.from('devices_keys').select('device_id').eq('device_id', dev).maybeSingle();
        if (!error && !row) { console.warn('e2e: нет строки devices_keys для этой сессии — регистрируем ключи'); for (const k of Object.keys(kv)) if (k.startsWith('skd:')) await del(k); await put('uploaded', '0'); }
      }
    // Разовая миграция: устройство уже переносилось (rebind) старой версией сайта — сессии могли остаться привязанными к прежнему id
    if (kv.refresh_mig !== '1') { if (jlist('olddevs').length && store) await put('refresh', JSON.stringify(sessionDevs(store))); await put('refresh_mig', '1'); }
    await publish(dev);
    await topUp();
    // Секрет — сразу после загрузки ключей. Разовая миграция dsec_mig: строки, пересозданные 87b07d4 (delete+insert),
    // потеряли rebind_hash на сервере — такие устройства задают секрет заново при ближайшем запуске.
    await ensureSecret(kv.dsec_mig !== '1');
    if (kv.dsec_set === '1' && kv.dsec_rotate !== '1') await put('dsec_mig', '1');
    } catch (err) {
      // Нет сети: ключи этого устройства уже прочитаны локально — работаем с ними, серверную часть повторим при появлении связи.
      // Новое устройство / rebind без сети не делаем (идут выше и бросают ошибку как раньше).
      if (localOk && isNetErr(err)) { deferredSync = true; console.warn('e2e: нет сети, проверка ключей на сервере отложена'); return dev; }
      throw err;
    }
    deferredSync = false;
    return dev;
  }).catch(e => { ready = null; throw e; });
  return ready;
}

async function publish(dev) {
  if (kv.uploaded !== '1') {
      const row = { ...JSON.parse(store.publicRow()), device_id: dev, user_id: uid };
      const { error } = await sb.from('devices_keys').insert(row);
      if (error) {
        if (!/duplicate|23505/.test(error.message + error.code)) throw error;
        await replaceDeviceKeys(dev, row);
      }
      await put('uploaded', '1');
    }
}

/** Строка devices_keys этого устройства ещё на сервере? Нет (её удалила серверная чистка) — публикуем ключи заново. */
export async function checkDevice() {
  const sid = sessionId((await token()).access_token);
  if (kv.dev !== sid) { await ensureReady(); return 'reinit'; } // ключи прошлой сессии не публикуем под чужим device_id
  return locked(async () => {
    if (!store || !kv.dev) return 'not-ready';
    const { data, error } = await sb.from('devices_keys').select('device_id').eq('device_id', kv.dev).maybeSingle();
    if (error) throw error;
    if (data) { await topUp(); return 'ok'; }
    for (const k of Object.keys(kv)) if (k.startsWith('skd:')) await del(k); // ключи групп этому устройству нужно раздать заново
    await put('uploaded', '0');
    await publish(kv.dev); await topUp();
    return 'restored';
  });
}

/** Отпечаток ПУБЛИЧНОГО identity-ключа: SHA-256, первые 16 байт hex группами по 4. Приватных частей не касается. */
async function pubFp(b64) {
  try { const raw = Uint8Array.from(atob(String(b64).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', raw)); return [...h.slice(0, 16)].map(x => x.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(' '); }
  catch { return '(не прочитан)'; }
}
const identityPub = st => JSON.parse(st.publicRow()).identity_pub;
/** Строка devices_keys этой сессии уже есть на сервере (повторная публикация, прошлый запуск). Строку НЕ удаляем: вместе с ней
 *  пропадал rebind_hash (87b07d4) — следующий rebind не проходил, а через час чистка удаляла ключи устройства. identity не меняем никогда:
 *  тот же identity — обновляем подписанный/Kyber prekey и заменяем одноразовые ключи через replace_prekeys; другой identity — ошибка. */
async function replaceDeviceKeys(dev, row) {
  const cur = chk(await sb.from('devices_keys').select('identity_pub').eq('device_id', dev).maybeSingle());
  if (!cur || cur.identity_pub !== row.identity_pub) {
    // Возможна подмена строки на сервере: свою строку НЕ перезаписываем и серверный ключ локально НЕ принимаем.
    const lf = await pubFp(row.identity_pub), sf = cur ? await pubFp(cur.identity_pub) : '(нет строки)';
    console.error('E2E_IDENTITY_MISMATCH device_id=' + dev + ' local_identity_fp=' + lf + ' server_identity_fp=' + sf);
    await put('idmm', dev); throw new IdentityMismatch(dev, lf, sf);
  }
  const upd = { ...row }; delete upd.identity_pub; delete upd.device_id; delete upd.user_id;
  chk(await sb.from('devices_keys').update(upd).eq('device_id', dev));
  await put('otk_full', '1'); // следующий topUp заменяет полный набор одноразовых ключей (replace_prekeys)
}

const OTK_MAX_ID = 16777215;
/** Одноразовые ключи: 1) новые сохраняем локально, 2) rpc replace_prekeys (сервер атомарно удаляет старые одноразовые ключи
 *  устройства и вставляет новые), 3) только после успеха двигаем счётчик. Номера монотонные (otk_next) — с прошлыми не совпадают. */
async function topUp() {
  const have = kv.otk_full === '1' ? 0 : (chk(await sb.rpc('my_prekey_count')) || 0);
  if (have >= OTK_LOW) return;
  let next = +kv.otk_next || 1;
  if (next + OTK_BATCH - 1 > OTK_MAX_ID) next = 1;
  const keys = JSON.parse(store.genPrekeys(next, OTK_BATCH)).map(r => ({ id: r.key_id, pub: r.pub }));
  await saveStore(); await put('otk_next', String(next + OTK_BATCH)); // сначала локально (номера не переиспользуем даже при ошибке)
  chk(await sb.rpc('replace_prekeys', { p_keys: keys }));
  if (kv.otk_full) await del('otk_full');
}

/** Устройства, с которыми в хранилище есть сессия (ключи карты sess из export; секретов не касается). */
function sessionDevs(st) { try { return Object.keys(JSON.parse(st.export()).sess || {}); } catch { return []; } }
const needsFresh = d => jlist('refresh').includes(d);
async function freshDone(d) { const r = jlist('refresh'); const i = r.indexOf(d); if (i >= 0) { r.splice(i, 1); await put('refresh', JSON.stringify(r)); } }

/** Доверенные устройства пользователя с готовой сессией; TOFU как в Android. */
async function devicesFor(user, ttl = CLAIM_TTL) {
  const trust = jget('trust:' + user);
  if (!claimedAt[user] || Date.now() - claimedAt[user] > ttl || Object.keys(trust).some(needsFresh)) {
    let rows;
    try { rows = chk(await sb.rpc('claim_prekeys', { p_user: user })) || []; }
    catch (err) {
      // Сбой claim_prekeys: уже установленные сессии (бандл, полученный при открытии чата) используем; без них — ошибка наверх
      const have = Object.keys(trust).filter(d => store.hasSession(d));
      if (have.length && !kv['pending:' + user]) { console.warn('claim_prekeys: ошибка, используем установленные сессии', err && (err.code || err.message)); return have; }
      throw err;
    }
    if (rows.length) claimedAt[user] = Date.now(); else delete claimedAt[user]; // пустой ответ не кэшируем: собеседник может войти в любой момент
    const valid = {};
    for (const o of rows) {
      if (o.device_id === kv.dev || !o.kyber_prekey) continue;
      try { if (Store.verifyRow(JSON.stringify(o))) valid[o.device_id] = o; } catch { /* битая строка — пропускаем */ }
    }
    // Пустой ответ (собеседник без ключей, лимит, сбой) доверие НЕ сбрасывает; устройство убираем, только если сервер вернул другие устройства
    // «Известный контакт» — считаем ДО удаления ушедших устройств: на сервере при выходе строка старого устройства удаляется,
    // и новое устройство приходит вместо него (а не рядом, как в моке) — иначе trust пуст и строка «новое устройство» не появлялась
    const known = Object.keys(trust).length > 0 || jlist('seen:' + user).length > 0;
    // identity, которые мы уже знали у этого пользователя: устройство с тем же identity под новым id — это перенос (rebind_device)
    // того же устройства, а не новое устройство: код безопасности тот же, строку «новое устройство» не показываем
    const knownIks = new Set([...Object.values(trust), ...jlist('iks:' + user)]);
    if (Object.keys(trust).length) await markSeen(user, Object.keys(trust));
    if (Object.keys(valid).length) for (const d of Object.keys(trust)) if (!valid[d]) delete trust[d];
    let changed = false, added = false;
    for (const [d, o] of Object.entries(valid)) {
      if (trust[d] && trust[d] !== o.identity_pub) { changed = true; store.deleteSession(d); } // ключ этого устройства на сервере ≠ сохранённого
      else if (!trust[d] && known && !jlist('seen:' + user).includes(d) && !knownIks.has(o.identity_pub)) added = true; // новое устройство (не первый контакт)
      trust[d] = o.identity_pub;
    }
    await put('trust:' + user, JSON.stringify(trust)); await markSeen(user, Object.keys(trust)); await markIks(user, Object.values(trust));
    if (changed) await keyChanged(user);
    if (added) await sysEvent('nd:' + user);
    // Проверенный собеседник и устройство с НОВЫМ identity (вход в чистом профиле, переустановка): код не сверен — как смена ключа,
    // снимаем «проверено» и блокируем первую отправку. Тот же identity под новым id (rebind) сюда не попадает.
    if (added && kv['verified:' + user] && !changed) await keyChanged(user);
    for (const [d, o] of Object.entries(valid)) {
      if (trust[d] !== o.identity_pub) continue;
      await put('devuser:' + d, user);
      if (store.hasSession(d) && !needsFresh(d)) continue;
      store.processBundle(JSON.stringify(o)); await freshDone(d);
    }
    await saveStore();
  }
  return Object.keys(trust).filter(d => store.hasSession(d));
}

const sentAt = {};
/** Собеседник мог сменить устройство (отметка прочтения/доставки, вход): следующая отправка заново запросит его устройства. */
export const devicesStale = user => { if (Date.now() - (claimedAt[user] || 0) > SEND_FRESH) { delete claimedAt[user]; delete sentAt[user]; } }; // не чаще раза в минуту (лимит claim_prekeys)
export const hasPendingChange = () => false; // смена ключа не блокирует: системная строка в чате (keyEvents)
/** Событие «код безопасности изменился» — только локально (IndexedDB этого браузера), на сервер не уходит и с сервера не принимается. */
async function sysEvent(k) { const ev = jlist(k); ev.push(new Date().toISOString()); await put(k, JSON.stringify(ev.slice(-50))); }
async function markIks(user, iks) { const s = jlist('iks:' + user); let ch = false; for (const k of iks) if (k && !s.includes(k)) { s.push(k); ch = true; } if (ch) await put('iks:' + user, JSON.stringify(s.slice(-20))); }
async function markSeen(user, devs) { const s = jlist('seen:' + user); let ch = false; for (const d of devs) if (!s.includes(d)) { s.push(d); ch = true; } if (ch) await put('seen:' + user, JSON.stringify(s.slice(-50))); }
async function keyChanged(user) {
  await sysEvent('kc:' + user);
  // Проверенный собеседник: метку «проверено» снимаем и блокируем первую отправку до решения пользователя
  if (kv['verified:' + user]) { await del('verified:' + user); await put('kcblock:' + user, '1'); }
  if (kv['pending:' + user]) await del('pending:' + user);
}
const okAt = x => typeof x === 'string' && !isNaN(Date.parse(x));
/** Локальные системные события: [{k:'kc'|'nd', at}] (с перечитыванием общего хранилища). */
export const keyEvents = user => locked(async () => [...jlist('kc:' + user).filter(okAt).map(at => ({ k: 'kc', at })), ...jlist('nd:' + user).filter(okAt).map(at => ({ k: 'nd', at }))].sort((a, b) => a.at < b.at ? -1 : 1));
export const sendBlocked = user => locked(async () => kv['kcblock:' + user] === '1');
export const unblockSend = user => locked(async () => { if (kv['kcblock:' + user]) await del('kcblock:' + user); });
/** Принять новые ключи собеседника (как acceptKeys в Android). */
export function acceptKeys(user) {
  return locked(async () => {
    await acceptPendingInner(user); if (kv['verified:' + user]) await del('verified:' + user);
  });
}

/** Есть ли у собеседника устройства с ключами (тогда отправляем только шифротекст). */
export function peerHasKeys(peer) {
  return locked(async () => { try { return (await devicesFor(peer)).length > 0; } catch (e) { if (e instanceof KeyChange) return true; throw e; } });
}

/** Шифротекст {device: {f,t,b}} для устройств собеседника и своих других устройств; null — у собеседника нет ключей. */
export function encryptDM(peer, pt) {
  return locked(async () => {
    // 20.10 (Support Bot): список устройств собеседника из кэша (до 10 мин) мог быть устаревшим — B вошёл на новом устройстве,
    // а первое сообщение шифровалось только для старого (удалённого) и не доходило. Перед отправкой обновляем список,
    // если это первое сообщение «серии» (прошлое ушло больше SEND_FRESH назад) или собеседник подал признаки жизни с другого
    // устройства (devicesStale). Лимит claim_prekeys — 60 в час; при ошибке/лимите используются уже установленные сессии.
    const first = !(Date.now() - (sentAt[peer] || 0) < SEND_FRESH);
    const peerDevs = await devicesFor(peer, first ? 0 : CLAIM_TTL); sentAt[peer] = Date.now();
    if (!peerDevs.length) return null;
    const all = [...peerDevs];
    try { for (const d of await devicesFor(uid)) if (!all.includes(d)) all.push(d); } catch (e) { if (e.userId === uid) throw e; }
    const ct = {};
    for (const d of all) { const m = JSON.parse(store.encrypt(d, pt)); ct[d] = { f: kv.dev, t: m.t, b: m.b }; }
    await saveStore();
    return { ct, pt };
  });
}
export const rememberOwn = (id, pt, sk) => locked(async () => { await put('pts:' + id, pt); if (sk) await put('ptg:' + id + ':' + await h16(sk), pt); });

/** Номера ключей из PreKeySignalMessage (только id, не ключи): версия (1 байт) + protobuf: 1 preKeyId, 6 signedPreKeyId, 7 kyberPreKeyId. */
function preKeyIds(b64) {
  try {
    const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const out = { otk: '-', spk: '-', kyber: '-' }; let i = 1;
    const vi = () => { let r = 0, sh = 0, x; do { x = u[i++]; r += (x & 0x7f) * 2 ** sh; sh += 7; } while (x & 0x80 && i < u.length); return r; };
    while (i < u.length) {
      const tag = vi(), f = tag >>> 3, wt = tag & 7;
      if (wt === 0) { const v = vi(); if (f === 1) out.otk = v; else if (f === 6) out.spk = v; else if (f === 7) out.kyber = v; }
      else if (wt === 2) { const n = vi(); i += n; } else if (wt === 5) i += 4; else if (wt === 1) i += 8; else break;
    }
    return out;
  } catch { return null; }
}
async function h16(s) { const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); return [...b].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 16); }

/** Расшифровка личного сообщения. null — не для этого устройства. */
export function decryptDM(m) {
  return locked(async () => {
    if (kv['pts:' + m.id]) return kv['pts:' + m.id];
    // Своя запись: сначала текущий id устройства, затем прежние id (до rebind_device)
    let e = m.ciphertext && m.ciphertext[kv.dev];
    if (!e && m.ciphertext) for (const o of jlist('olddevs').reverse()) if (m.ciphertext[o]) { e = m.ciphertext[o]; break; }
    if (!e) return null;
    const ck = 'pt:' + m.id + ':' + await h16(e.b);
    if (kv[ck]) return kv[ck];
    let s;
    try { s = store.decrypt(e.f, e.t, e.b); }
    catch (err) {
      let msg = (err && err.message) || String(err);
      // Новый identity у известного устройства: смену признаём, только если ключ на сервере действительно ≠ сохранённого
      if (/untrusted identity/i.test(msg) && m.sender_id) {
        const { data: row } = await sb.from('devices_keys').select('identity_pub').eq('device_id', e.f).maybeSingle();
        const trust = jget('trust:' + m.sender_id);
        if (row && row.identity_pub && trust[e.f] && row.identity_pub !== trust[e.f]) {
          store.deleteSession(e.f); trust[e.f] = row.identity_pub; await put('trust:' + m.sender_id, JSON.stringify(trust)); delete claimedAt[m.sender_id];
          await keyChanged(m.sender_id);
          try { s = store.decrypt(e.f, e.t, e.b); msg = null; } catch (e2) { msg = (e2 && e2.message) || String(e2); }
        }
      }
      if (msg) {
        const env = m.ciphertext[kv.dev] === e ? kv.dev : (jlist('olddevs').find(o => m.ciphertext[o] === e) || '?');
        const pk = +e.t === 3 ? preKeyIds(e.b) : null;
        const x = new Error('decrypt t=' + e.t + ' from ' + String(e.f).slice(0, 8) + ' to ' + String(env).slice(0, 8) + (env === kv.dev ? '' : ' (прежний id)')
          + (pk ? ' prekey=' + pk.otk + ' spk=' + pk.spk + ' kyber=' + pk.kyber : '') + ': ' + msg);
        x.cause = err; throw x;
      }
    }
    await saveStore(); await put(ck, s);
    if (m.sender_id) {
      await put('devuser:' + e.f, m.sender_id);
      const trust = jget('trust:' + m.sender_id), ik = store.identityOf(e.f);
      if (ik && trust[e.f] !== ik) {
        const was = trust[e.f], known = Object.keys(trust).length > 0 || jlist('seen:' + m.sender_id).length > 0, seen = jlist('seen:' + m.sender_id).includes(e.f);
        const sameIk = Object.values(trust).includes(ik) || jlist('iks:' + m.sender_id).includes(ik);
        trust[e.f] = ik; await put('trust:' + m.sender_id, JSON.stringify(trust)); await markSeen(m.sender_id, [e.f]); await markIks(m.sender_id, [ik]);
        if (was) await keyChanged(m.sender_id); else if (known && !seen && !sameIk) await sysEvent('nd:' + m.sender_id);
      }
    }
    return s;
  });
}

// ---------- группы: Sender Keys (как E2eGroup в Android) ----------
const gwarn = {};
function warn(chat, w) { (gwarn[chat] = gwarn[chat] || new Set()).add(w); }
export const warnings = chat => [...(gwarn[chat] || [])];

async function epochOf(chat, devs) {
  if (devs.length) return devs[0].key_epoch;
  return chk(await sb.from('chats').select('key_epoch').eq('id', chat).single()).key_epoch;
}

/** Раздаёт SKDM текущей эпохи устройствам участников; возвращает {epoch, others}. */
export function distribute(chat) {
  return locked(async () => {
    const me = kv.dev;
    const devs = chk(await sb.rpc('group_devices', { p_chat: chat })) || [];
    const epoch = await epochOf(chat, devs);
    const skdm = store.groupSkdm(me, chat, epoch); await saveStore();
    const doneKey = 'skd:' + chat + ':' + epoch, done = jget(doneKey);
    const byUser = {};
    for (const o of devs) { if (o.device_id === me || done[o.device_id]) continue; (byUser[o.user_id] = byUser[o.user_id] || {})[o.device_id] = o.identity_pub; }
    const out = [], sent = [];
    for (const [user, ds] of Object.entries(byUser)) {
      let ok;
      try {
        ok = await devicesFor(user);
        if (Object.keys(ds).some(d => !ok.includes(d))) { delete claimedAt[user]; ok = await devicesFor(user); }
      } catch (e) { if (e instanceof KeyChange) { warn(chat, 'Ключ безопасности участника изменился — ключ группы ему не отправлен.'); continue; } throw e; }
      const trust = jget('trust:' + user);
      for (const [d, ik] of Object.entries(ds)) {
        if (!ok.includes(d)) continue;
        if (trust[d] !== ik) { warn(chat, 'Сервер прислал для участника другой ключ устройства — ключ группы не отправлен.'); continue; }
        const m = JSON.parse(store.encryptBytes(d, skdm));
        out.push({ chat_id: chat, epoch, sender_user: uid, sender_device: me, recipient_device: d, ciphertext: JSON.stringify({ t: m.t, b: m.b }) });
        sent.push(d);
      }
    }
    await saveStore();
    if (out.length) {
      const { error } = await sb.from('sender_key_distributions').insert(out);
      if (error) {
        if (!/duplicate|23505|409/.test(error.message + error.code)) throw error;
        for (const r of out) { const { error: e1 } = await sb.from('sender_key_distributions').insert(r); if (e1 && !/duplicate|23505|409/.test(e1.message + e1.code)) throw e1; }
      }
      for (const d of sent) done[d] = 1;
      await put(doneKey, JSON.stringify(done));
    }
    return { epoch, others: devs.length };
  });
}

/** Забирает адресованные этому устройству SKDM группы. */
export function receive(chat) {
  return locked(async () => {
    const rows = chk(await sb.from('sender_key_distributions').select('id,epoch,sender_user,sender_device,ciphertext').eq('chat_id', chat).order('created_at')) || [];
    let n = 0;
    for (const r of rows) {
      try {
        if (kv['trust:' + r.sender_user] == null) { try { await devicesFor(r.sender_user); } catch { /* pending */ } }
        const e = JSON.parse(r.ciphertext);
        const skdm = store.decryptBytes(r.sender_device, e.t, e.b); await saveStore();
        const ik = store.identityOf(r.sender_device);
        let trusted = jget('trust:' + r.sender_user)[r.sender_device];
        if (!trusted) { delete claimedAt[r.sender_user]; try { await devicesFor(r.sender_user); } catch { /* pending */ } trusted = jget('trust:' + r.sender_user)[r.sender_device]; }
        if (!ik || ik !== trusted) warn(chat, 'Получен ключ группы с незнакомым или изменившимся ключом устройства участника — он не принят.');
        else { store.groupProcess(r.sender_device, chat, r.epoch, skdm); await saveStore(); await put('gdev:' + r.sender_device, r.sender_user); n++; }
      } catch (ex) { warn(chat, 'Не удалось расшифровать ключ группы от участника.'); }
      await sb.from('sender_key_distributions').delete().eq('id', r.id); // второй раз не расшифровать
    }
    return n;
  });
}

/** Групповое сообщение ({sk}) с key_epoch и sender_device. */
export function decryptGroup(chat, m) {
  return locked(async () => {
    const sk = m.ciphertext.sk, ck = 'ptg:' + m.id + ':' + await h16(sk);
    if (kv[ck]) return kv[ck];
    if (kv['pts:' + m.id]) return kv['pts:' + m.id]; // своя копия или восстановлено из резервной копии
    if (!m.sender_device) throw new Error('нет sender_device');
    if (m.sender_device === kv.dev || jlist('olddevs').includes(m.sender_device)) { if (kv['pts:' + m.id]) return kv['pts:' + m.id]; throw new NoKey('своё сообщение без копии'); }
    const du = kv['gdev:' + m.sender_device];
    if (!du || !store.groupHasKey(m.sender_device, chat, m.key_epoch)) throw new NoKey('ключ отправителя ещё не получен');
    if (du !== m.sender_id) throw new Error('устройство не принадлежит отправителю');
    const s = store.groupDecrypt(m.sender_device, chat, m.key_epoch, sk);
    await saveStore(); await put(ck, s);
    return s;
  });
}

export function encryptGroup(chat, epoch, pt) {
  return locked(async () => { const sk = store.groupEncrypt(kv.dev, chat, epoch, pt); await saveStore(); return { ct: { sk }, pt }; });
}

// ---------- код безопасности (libsignal Fingerprint v2, 5200 итераций — как Android) ----------
/** [{dev, digits, qr}] по доверенным (и ожидающим) устройствам собеседника. */
export function safetyNumbers(peer) {
  return locked(async () => {
    const t = { ...jget('trust:' + peer), ...jget('pending:' + peer) };
    return Object.entries(t).map(([dev, ik]) => ({ dev, ...JSON.parse(store.fingerprint(uid, peer, ik)) }));
  });
}
/** Сравнивает отсканированный QR (base64-строка из QR приложения) с нашими кодами; при совпадении — проверено. */
export function verifyScanned(peer, scanned) {
  return locked(async () => {
    const t = { ...jget('trust:' + peer), ...jget('pending:' + peer) };
    for (const ik of Object.values(t)) {
      const mine = JSON.parse(store.fingerprint(uid, peer, ik)).qr;
      let ok = false; try { ok = compareScannable(mine, scanned.trim()); } catch { /* не тот формат */ }
      if (ok) { await acceptPendingInner(peer); await put('verified:' + peer, kv['trust:' + peer]); return true; }
    }
    return false;
  });
}
/** Пользователь сам сравнил цифры и подтвердил совпадение. */
export function markVerified(peer) { return locked(async () => { await acceptPendingInner(peer); await put('verified:' + peer, kv['trust:' + peer] || '{}'); if (kv['kcblock:' + peer]) await del('kcblock:' + peer); }); }
/** Проверено = каждый текущий identity собеседника был среди сверенных. Сравниваем identity, а не id устройств:
 *  после rebind_device id меняется, ключ — нет, и отметка «проверено» не должна пропадать. */
export const isVerified = peer => {
  if (kv['verified:' + peer] == null) return false;
  const v = new Set(Object.values(jget('verified:' + peer))), t = Object.values(jget('trust:' + peer));
  return t.length > 0 && t.every(ik => v.has(ik));
};
async function acceptPendingInner(user) {
  if (!kv['pending:' + user]) return;
  const trust = jget('trust:' + user), pending = jget('pending:' + user);
  for (const [d, ik] of Object.entries(pending)) { trust[d] = ik; store.deleteSession(d); }
  await put('trust:' + user, JSON.stringify(trust)); await del('pending:' + user);
  delete claimedAt[user]; await saveStore();
}

// ---------- файлы: AES-256-GCM, как E2eCore.encryptFile (ct||tag, ключ 32 байта, IV 12 байт, sha256 hex) ----------
const b64e = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
export async function encryptFile(plain) {
  const key = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, k, plain));
  return { ct, k: b64e(key), iv: b64e(iv), h: hex(await crypto.subtle.digest('SHA-256', plain)) };
}
export async function decryptFile(ct, kB64, ivB64, h) {
  const k = await crypto.subtle.importKey('raw', b64d(kB64), 'AES-GCM', false, ['decrypt']);
  const p = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(ivB64), tagLength: 128 }, k, ct));
  if (h && hex(await crypto.subtle.digest('SHA-256', p)) !== h) { const e = new Error('Файл повреждён'); e.userMsg = 'Файл повреждён'; e.corrupt = true; throw e; }
  return p;
}

/** Резервная копия: открытый текст из локального кэша (если уже расшифровано) */
export const cachedPlain = id => locked(async () => kv['pts:' + id] || null);
/** Восстановление: [{id, pt}] → кэш pts:<id> (существующие не перезаписываем). Возвращает число добавленных. */
export function importPlain(items) {
  return locked(async () => { let n = 0; for (const x of items) { if (!x.id || kv['pts:' + x.id]) continue; await put('pts:' + x.id, x.pt); n++; } return n; });
}
export const oldDeviceIds = () => jlist('olddevs');
/** Выход: стереть ключи этого устройства. */
export function wipe() {
  return locked(async () => { ready = null; if (store) { store.free(); store = null; } if (!db) return; for (const k of Object.keys(kv)) if (k !== 'ver') await del(k); });
}
export { distId };
