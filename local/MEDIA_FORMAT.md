# MLC1 — потоковый формат зашифрованных медиа

Спецификация Hack Bot (дословно):

- Header 17 bytes: 'MLC1'(4) | version 0x01 | chunkSize u32 BE (always 65536) | nonce prefix 8 random bytes per file.
- Plaintext split into 65536-byte chunks, each AES-256-GCM separately; encrypted chunk 65552 bytes (data+16 tag), last may be shorter.
- Chunk nonce: prefix(8) || i u32 BE.
- Chunk AAD: header(17) || i u32 BE || lastFlag (0x01 last, 0x00 otherwise). If plaintext length is multiple of 65536 (incl. 0), append an empty final chunk (16 bytes tag only).
- Chunk i at offset 17 + i*65552, fetched via Range. Files not starting with MLC1 are legacy, downloaded whole. Tag failure => stop playback, never skip.
- File key same as current.

## Примечания сайта (/local/)

- Число блоков: `n = floor(s / 65536) + 1`, размер файла: `17 + n*16 + s` (s — размер открытого текста, поле `f.s` в payload). Так сайт знает размер без Content-Range.
- Ключ `f.k` (32 байта, base64) — как раньше. Поле `f.iv` у MLC1 не используется (пишется случайным для совместимости формы payload).
- Целостность: при потоковом воспроизведении проверяется каждый блок (тег GCM; номер блока и флаг последнего в AAD защищают от перестановки и обрезки). `f.h` (SHA-256 всего открытого текста) по-прежнему пишется и проверяется только при полном скачивании.
- MLC1 используется для голосовых и кружков (`job.media`); обычные файлы — прежний формат.
- Код: `mlc1.js`, тест: `tests/media_mlc1_test.mjs` (сверено независимо через Python `cryptography`).

## Тестовые векторы

Ключ `00 01 … 1f`, префикс `a0 a1 … a7`, открытый текст: байт j = j mod 251.

| Длина | Блоков | Длина шифротекста | SHA-256 шифротекста | Тег блока 0 | Тег блока 1 |
|---|---|---|---|---|---|
| 65636 | 2 | 65685 | `3b9a591d0250d9f18676c42dc1767da44e0b070852ea2304c9a7b039c9087ec1` | `6c59962c78634a0e580f959d2b80c18d` | `cfd38430149dd36683b58d4bf55288b7` |
| 65536 | 2 (второй пустой) | 65585 | `47134393e0703b5bf707bd97b369d81ae23fbceaf7310c5cc0a0d672173e01f8` | `6c59962c78634a0e580f959d2b80c18d` | `49d08eb793603e6e7f45366aec43b307` |
