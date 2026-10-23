/* MLC1 — потоковый формат шифрования медиа (спецификация Hack Bot, MEDIA_FORMAT.md). Браузер: window.MLC1; Node: globalThis.MLC1. */
(function (G) {
  'use strict';
  const CS = 65536, TAG = 16, ECS = CS + TAG, HDR = 17, MAGIC = [0x4d, 0x4c, 0x43, 0x31];
  const subtle = () => G.crypto.subtle;
  const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
  const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const isMLC1 = b => !!b && b.length >= 4 && MAGIC.every((m, i) => b[i] === m);
  const corrupt = (msg) => { const e = new Error(msg || 'Файл повреждён'); e.userMsg = 'Файл повреждён'; e.corrupt = true; return e; };
  const key = raw => raw instanceof CryptoKey ? Promise.resolve(raw) : subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  function makeHeader(prefix) { return cat(Uint8Array.from(MAGIC), Uint8Array.of(1), be32(CS), prefix); }
  function parseHeader(h) {
    if (!h || h.length < HDR || !isMLC1(h) || h[4] !== 1) throw corrupt('Неизвестный формат медиа');
    const cs = new DataView(h.buffer, h.byteOffset).getUint32(5); if (cs !== CS) throw corrupt('Неподдерживаемый размер блока');
    return { header: h.slice(0, HDR), prefix: h.slice(9, HDR) };
  }
  const nonce = (prefix, i) => cat(prefix, be32(i));
  const aad = (header, i, last) => cat(header, be32(i), Uint8Array.of(last ? 1 : 0));
  /** число блоков по размеру файла (последний может быть короче, минимум — 16 байт тега) */
  function chunkCount(total) { const body = total - HDR; if (body < TAG) throw corrupt('Файл обрезан'); const n = Math.ceil(body / ECS); if ((body - (n - 1) * ECS) < TAG) throw corrupt('Файл обрезан'); return n; }
  const chunkRange = (i, total) => { const a = HDR + i * ECS; return [a, Math.min(total, a + ECS) - 1]; };
  async function encrypt(rawKey, plain, prefix) {
    const k = await key(rawKey); prefix = prefix || G.crypto.getRandomValues(new Uint8Array(8));
    const header = makeHeader(prefix), n = Math.floor(plain.length / CS) + 1, parts = [header]; // кратно 65536 (и 0) → пустой последний блок
    for (let i = 0; i < n; i++) { const last = i === n - 1, pt = plain.subarray(i * CS, Math.min(plain.length, (i + 1) * CS));
      parts.push(new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce(prefix, i), additionalData: aad(header, i, last), tagLength: 128 }, k, pt))); }
    return cat(...parts);
  }
  async function decryptChunk(k, hdr, i, last, ct) {
    if (ct.length < TAG || ct.length > ECS || (!last && ct.length !== ECS)) throw corrupt('Блок ' + i + ' неверной длины');
    try { return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce(hdr.prefix, i), additionalData: aad(hdr.header, i, last), tagLength: 128 }, await key(k), ct)); }
    catch { throw corrupt('Блок ' + i + ' не прошёл проверку'); }
  }
  async function decrypt(rawKey, file) {
    const hdr = parseHeader(file.subarray(0, HDR)), n = chunkCount(file.length), k = await key(rawKey), out = [];
    for (let i = 0; i < n; i++) { const [a, b] = chunkRange(i, file.length); out.push(await decryptChunk(k, hdr, i, i === n - 1, file.subarray(a, b + 1))); }
    return cat(...out);
  }
  G.MLC1 = { CS, TAG, ECS, HDR, isMLC1, parseHeader, chunkCount, chunkRange, encrypt, decrypt, decryptChunk, importKey: key };
})(typeof window !== 'undefined' ? window : globalThis);
