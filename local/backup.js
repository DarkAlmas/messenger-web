// Резервная копия переписки v1 — формат docs/backup_format.md (общий с Android):
// backup.bin = nonce(12) || AES-256-GCM(key, nonce, JSON, AAD="msgr-backup:v1:<uid>"),
// key = Argon2id(UTF-8 фраза, base64decode(salt), m=65536 KiB, t=3, p=1, v=0x13, 32 байта). Ключей и сессий в копии нет.
(function (root) {
  const DEFAULT_KDF = { alg: 'argon2id', m: 65536, t: 3, p: 1 };
  const te = new TextEncoder(), td = new TextDecoder('utf-8', { fatal: true });
  const subtle = (root.crypto || require('crypto').webcrypto).subtle;
  const rnd = n => (root.crypto || require('crypto').webcrypto).getRandomValues(new Uint8Array(n));
  const b64e = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const argon = () => (root.hashwasm || (typeof require === 'function' ? require('./vendor/hash-wasm/argon2.umd.min.js') : null));
  class BadPass extends Error { constructor() { super('Неверная фраза'); this.userMsg = 'Неверная фраза'; } }
  function checkKdf(k) {
    if (!k || k.alg !== 'argon2id') throw new Error('Неизвестный KDF копии');
    for (const f of ['m', 't', 'p']) if (!Number.isInteger(k[f]) || k[f] < 1) throw new Error('Неверные параметры KDF');
    if (k.m > 1048576 || k.t > 10 || k.p > 16) throw new Error('Слишком тяжёлые параметры KDF');
  }
  async function deriveKey(pass, saltB64, kdf) {
    checkKdf(kdf);
    const raw = await argon().argon2id({ password: te.encode(pass), salt: b64d(saltB64), parallelism: kdf.p, iterations: kdf.t, memorySize: kdf.m, hashLength: 32, outputType: 'binary' });
    return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  const aad = uid => te.encode('msgr-backup:v1:' + uid);
  const newSalt = () => b64e(rnd(16));
  async function seal(obj, key, uid) {
    const nonce = rnd(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(uid), tagLength: 128 }, key, te.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length); out.set(nonce); out.set(ct, 12); return out;
  }
  async function open(bin, key, uid) {
    bin = new Uint8Array(bin); if (bin.length < 12 + 16) throw new Error('Файл копии повреждён');
    let pt; try { pt = await subtle.decrypt({ name: 'AES-GCM', iv: bin.subarray(0, 12), additionalData: aad(uid), tagLength: 128 }, key, bin.subarray(12)); }
    catch { throw new BadPass(); }
    const o = JSON.parse(td.decode(pt));
    if (!o || o.v !== 1) throw new Error('Неподдерживаемая версия копии');
    if (o.uid !== uid) throw new Error('Копия принадлежит другому аккаунту');
    if (!Array.isArray(o.messages)) throw new Error('В копии нет сообщений');
    return o;
  }
  /** Внутренний payload сайта {t,f:{p,n,s,k,iv,m,h},fw} → запись копии */
  function toEntry(m, pl) {
    const e = { chat_id: m.chat_id, message_id: m.id, plaintext: (pl.t0 !== undefined ? pl.t0 : pl.t) || '', attachments: [] };
    if (pl.caption) e.caption = pl.caption; // подпись к вложению (необязательное поле, v остаётся 1)
    if (m.sender_id) e.sender_id = m.sender_id; if (m.created_at) e.created_at = m.created_at;
    if (pl.f && pl.f.p) { const a = { path: pl.f.p, name: pl.f.n || 'file', size: pl.f.s || 0, key: pl.f.k, nonce: pl.f.iv }; if (pl.f.m) a.mime = pl.f.m; if (pl.f.h) a.sha256 = pl.f.h; e.attachments.push(a); }
    if (pl.fw) e.forwarded = { name: pl.fw };
    return e;
  }
  /** Запись копии → строка кэша pts (как Android: {"v":1,"t":..,"f":{p,n,s,k,iv,m,h}}) */
  function toCache(e) {
    if (!e || typeof e.message_id !== 'string') return null;
    const o = { v: 1, t: typeof e.plaintext === 'string' ? e.plaintext : '' };
    const a = Array.isArray(e.attachments) && e.attachments[0];
    if (a && a.path && a.key && a.nonce) { o.f = { p: a.path, n: a.name || 'file', s: a.size || 0, k: a.key, iv: a.nonce }; if (a.mime) o.f.m = a.mime; if (a.sha256) o.f.h = a.sha256; }
    const fw = e.forwarded && (typeof e.forwarded === 'string' ? e.forwarded : e.forwarded.name || e.forwarded.fw);
    if (typeof fw === 'string' && fw) o.fw = fw.slice(0, 64);
    if (o.f && typeof e.caption === 'string' && e.caption) o.caption = e.caption.slice(0, 4000);
    return { id: e.message_id, pt: JSON.stringify(o) };
  }

  // ---- Формат v2 (BACKUP_FORMAT.md, общий с Android, байт в байт) ----
  // backup.bin = "MLB2"(4) | 0x02 | memKiB u32 BE | iters u8 | salt(16) | nonce(12) | AES-256-GCM(ct||tag16), AAD = заголовок (45 байт).
  // KDF: Argon2id(password = UTF-8("ml-backup-v2:" + uid + ":" + loginPassword), salt(16), m=memKiB, t=iters, p=1, v=0x13, 32 байта).
  const MAGIC = [0x4d, 0x4c, 0x42, 0x32], HDR = 4 + 1 + 4 + 1 + 16 + 12;
  const kdfInputV2 = (uid, pass) => te.encode('ml-backup-v2:' + uid + ':' + pass);
  const isV2 = bin => { bin = new Uint8Array(bin); return bin.length >= 5 && MAGIC.every((b, i) => bin[i] === b) && bin[4] === 2; };
  async function keyV2(uid, pass, salt, m, t) {
    if (m < 8192 || m > 1048576 || t < 1 || t > 10) throw new Error('Неверные параметры KDF');
    const raw = await argon().argon2id({ password: kdfInputV2(uid, pass), salt, parallelism: 1, iterations: t, memorySize: m, hashLength: 32, outputType: 'binary' });
    return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  /** obj → Uint8Array (новая соль и nonce при каждом сохранении). opts: {m,t,salt,nonce} — для тестов. */
  async function encodeV2(obj, pass, uid, opts = {}) {
    const m = opts.m || DEFAULT_KDF.m, t = opts.t || DEFAULT_KDF.t, salt = opts.salt || rnd(16), nonce = opts.nonce || rnd(12);
    const h = new Uint8Array(HDR); h.set(MAGIC); h[4] = 2; new DataView(h.buffer).setUint32(5, m, false); h[9] = t; h.set(salt, 10); h.set(nonce, 26);
    const key = await keyV2(uid, pass, salt, m, t);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: h, tagLength: 128 }, key, te.encode(JSON.stringify(obj))));
    const out = new Uint8Array(HDR + ct.length); out.set(h); out.set(ct, HDR); return out;
  }
  async function decodeV2(bin, pass, uid) {
    bin = new Uint8Array(bin); if (!isV2(bin) || bin.length < HDR + 16) throw new Error('Файл копии повреждён');
    const h = bin.subarray(0, HDR), m = new DataView(bin.buffer, bin.byteOffset).getUint32(5, false), t = bin[9];
    const key = await keyV2(uid, pass, bin.slice(10, 26), m, t);
    let pt; try { pt = await subtle.decrypt({ name: 'AES-GCM', iv: bin.slice(26, 38), additionalData: h, tagLength: 128 }, key, bin.subarray(HDR)); }
    catch { throw new BadPass(); }
    const o = JSON.parse(td.decode(pt));
    if (!o || o.uid !== uid) throw new Error('Копия принадлежит другому аккаунту');
    if (!Array.isArray(o.messages)) throw new Error('В копии нет сообщений');
    return o;
  }
  const api = { isV2, encodeV2, decodeV2, kdfInputV2, DEFAULT_KDF, BadPass, deriveKey, newSalt, seal, open, toEntry, toCache, b64e, b64d };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Backup = api;
})(typeof window !== 'undefined' ? window : globalThis);
