# Резервная копия v2 (общий формат сайт ↔ Android, байт в байт)

Файл `backups/{uid}/backup.bin`:

| смещение | длина | поле |
|---|---|---|
| 0 | 4 | `MLB2` (0x4D 0x4C 0x42 0x32) |
| 4 | 1 | версия `0x02` |
| 5 | 4 | memKiB, u32 big-endian (65536) |
| 9 | 1 | iters, u8 (3) |
| 10 | 16 | salt |
| 26 | 12 | nonce |
| 38 | … | AES-256-GCM ciphertext ‖ tag(16) |

AAD = байты 0..37 (весь заголовок).

KDF: Argon2id v0x13, m=memKiB, t=iters, p=1, выход 32 байта, salt = 16 байт из заголовка,
**password = UTF-8(`"ml-backup-v2:" + uid + ":" + loginPassword`)** — uid в нижнем регистре, как в auth (UUID с дефисами), пароль без нормализации.
Пример: uid `abc`, пароль `p` → `ml-backup-v2:abc:p`.

Plaintext: тот же JSON, что в v1: `{"v":1,"uid":…,"created_at":…,"messages":[…]}`.

Файл без магии `MLB2` — v1 (`nonce ‖ GCM`, AAD `msgr-backup:v1:<uid>`, соль/KDF из `key_backups`), переносится один раз по старой фразе и пересохраняется в v2.
При каждом сохранении (и смене пароля) — новая соль и nonce. Пользователи Google-входа (без пароля) остаются на v1 с ручной фразой.
