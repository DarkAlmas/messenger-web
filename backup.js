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
    const e = { chat_id: m.chat_id, message_id: m.id, plaintext: pl.t || '', attachments: [] };
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
    return { id: e.message_id, pt: JSON.stringify(o) };
  }
  const api = { DEFAULT_KDF, BadPass, deriveKey, newSalt, seal, open, toEntry, toCache, b64e, b64d };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Backup = api;
})(typeof window !== 'undefined' ? window : globalThis);
