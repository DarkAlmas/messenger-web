//! Минимальная WASM-обёртка над официальным libsignal-protocol для веб-клиента Мессенджера.
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use futures_util::FutureExt;
use libsignal_protocol::*;
use rand::TryRngCore;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

type R<T> = std::result::Result<T, JsError>;
fn e<E: std::fmt::Display>(x: E) -> JsError { JsError::new(&x.to_string()) }
fn now_ms() -> u64 { js_sys::Date::now() as u64 }
fn now() -> SystemTime { UNIX_EPOCH + Duration::from_millis(now_ms()) }
fn b64(b: &[u8]) -> String { B64.encode(b) }
fn unb64(s: &str) -> R<Vec<u8>> { B64.decode(s).map_err(e) }
fn sync<T>(f: impl std::future::Future<Output = T>) -> T { f.now_or_never().expect("store is synchronous") }
fn addr(dev: &str) -> ProtocolAddress { ProtocolAddress::new(dev.to_string(), DeviceId::new(1).unwrap()) }

#[derive(Default)]
struct Data {
    idk: Vec<u8>,
    reg: u32,
    pre: HashMap<u32, Vec<u8>>,
    spk: HashMap<u32, Vec<u8>>,
    kpk: HashMap<u32, Vec<u8>>,
    sess: HashMap<String, Vec<u8>>,
    ident: HashMap<String, Vec<u8>>,
    sk: HashMap<String, Vec<u8>>,
}

fn nf(what: &str) -> SignalProtocolError { SignalProtocolError::InvalidState("store", what.to_string()) }

#[async_trait(?Send)]
impl IdentityKeyStore for Data {
    async fn get_identity_key_pair(&self) -> Result<IdentityKeyPair, SignalProtocolError> { IdentityKeyPair::try_from(&self.idk[..]) }
    async fn get_local_registration_id(&self) -> Result<u32, SignalProtocolError> { Ok(self.reg) }
    async fn save_identity(&mut self, a: &ProtocolAddress, k: &IdentityKey) -> Result<IdentityChange, SignalProtocolError> {
        let nw = k.serialize().to_vec();
        let old = self.ident.insert(a.name().to_string(), nw.clone());
        Ok(IdentityChange::from_changed(old.is_some_and(|o| o != nw)))
    }
    async fn is_trusted_identity(&self, a: &ProtocolAddress, k: &IdentityKey, _d: Direction) -> Result<bool, SignalProtocolError> {
        Ok(self.ident.get(a.name()).is_none_or(|o| o[..] == k.serialize()[..]))
    }
    async fn get_identity(&self, a: &ProtocolAddress) -> Result<Option<IdentityKey>, SignalProtocolError> {
        self.ident.get(a.name()).map(|b| IdentityKey::decode(b)).transpose()
    }
}
#[async_trait(?Send)]
impl PreKeyStore for Data {
    async fn get_pre_key(&self, id: PreKeyId) -> Result<PreKeyRecord, SignalProtocolError> {
        PreKeyRecord::deserialize(self.pre.get(&u32::from(id)).ok_or(SignalProtocolError::InvalidPreKeyId)?)
    }
    async fn save_pre_key(&mut self, id: PreKeyId, r: &PreKeyRecord) -> Result<(), SignalProtocolError> { self.pre.insert(id.into(), r.serialize()?); Ok(()) }
    async fn remove_pre_key(&mut self, id: PreKeyId) -> Result<(), SignalProtocolError> { self.pre.remove(&u32::from(id)); Ok(()) }
}
#[async_trait(?Send)]
impl SignedPreKeyStore for Data {
    async fn get_signed_pre_key(&self, id: SignedPreKeyId) -> Result<SignedPreKeyRecord, SignalProtocolError> {
        SignedPreKeyRecord::deserialize(self.spk.get(&u32::from(id)).ok_or(SignalProtocolError::InvalidSignedPreKeyId)?)
    }
    async fn save_signed_pre_key(&mut self, id: SignedPreKeyId, r: &SignedPreKeyRecord) -> Result<(), SignalProtocolError> { self.spk.insert(id.into(), r.serialize()?); Ok(()) }
}
#[async_trait(?Send)]
impl KyberPreKeyStore for Data {
    async fn get_kyber_pre_key(&self, id: KyberPreKeyId) -> Result<KyberPreKeyRecord, SignalProtocolError> {
        KyberPreKeyRecord::deserialize(self.kpk.get(&u32::from(id)).ok_or(SignalProtocolError::InvalidKyberPreKeyId)?)
    }
    async fn save_kyber_pre_key(&mut self, id: KyberPreKeyId, r: &KyberPreKeyRecord) -> Result<(), SignalProtocolError> { self.kpk.insert(id.into(), r.serialize()?); Ok(()) }
    async fn mark_kyber_pre_key_used(&mut self, _k: KyberPreKeyId, _s: SignedPreKeyId, _b: &PublicKey) -> Result<(), SignalProtocolError> { Ok(()) }
}
#[async_trait(?Send)]
impl SessionStore for Data {
    async fn load_session(&self, a: &ProtocolAddress) -> Result<Option<SessionRecord>, SignalProtocolError> {
        self.sess.get(a.name()).map(|b| SessionRecord::deserialize(b)).transpose()
    }
    async fn store_session(&mut self, a: &ProtocolAddress, r: &SessionRecord) -> Result<(), SignalProtocolError> {
        self.sess.insert(a.name().to_string(), r.serialize()?); Ok(())
    }
}

#[async_trait(?Send)]
impl SenderKeyStore for Data {
    async fn store_sender_key(&mut self, a: &ProtocolAddress, id: uuid::Uuid, r: &SenderKeyRecord) -> Result<(), SignalProtocolError> {
        self.sk.insert(format!("{}|{}", a.name(), id), r.serialize()?); Ok(())
    }
    async fn load_sender_key(&mut self, a: &ProtocolAddress, id: uuid::Uuid) -> Result<Option<SenderKeyRecord>, SignalProtocolError> {
        self.sk.get(&format!("{}|{}", a.name(), id)).map(|b| SenderKeyRecord::deserialize(b)).transpose()
    }
}

/// Как Java UUID.nameUUIDFromBytes("msgr-group:<chat>:<epoch>").
fn dist_id(chat: &str, epoch: u32) -> uuid::Uuid {
    use md5::Digest;
    let h: [u8; 16] = md5::Md5::digest(format!("msgr-group:{chat}:{epoch}").as_bytes()).into();
    uuid::Builder::from_md5_bytes(h).into_uuid()
}

#[wasm_bindgen(js_name = distId)]
pub fn dist_id_js(chat: &str, epoch: u32) -> String { dist_id(chat, epoch).to_string() }

fn mapj<K: ToString>(m: &HashMap<K, Vec<u8>>) -> Value { Value::Object(m.iter().map(|(k, v)| (k.to_string(), Value::String(b64(v)))).collect()) }
fn unmap<K: std::str::FromStr + std::hash::Hash + Eq>(v: &Value) -> R<HashMap<K, Vec<u8>>> {
    let mut m = HashMap::new();
    if let Some(o) = v.as_object() { for (k, x) in o { m.insert(k.parse().map_err(|_| e("bad key"))?, unb64(x.as_str().unwrap_or(""))?); } }
    Ok(m)
}

#[wasm_bindgen]
pub struct Store { d: Data }

#[wasm_bindgen]
impl Store {
    /// Новое устройство: identity, registration id, signed prekey #1 и Kyber-1024 prekey #1.
    #[wasm_bindgen(js_name = newDevice)]
    pub fn new_device() -> R<Store> {
        let mut rng = rand::rngs::OsRng.unwrap_err();
        let idk = IdentityKeyPair::generate(&mut rng);
        let reg = 1 + (rand::Rng::random::<u32>(&mut rng) % 16380);
        let ts = Timestamp::from_epoch_millis(now_ms());
        let spk = KeyPair::generate(&mut rng);
        let sig = idk.private_key().calculate_signature(&spk.public_key.serialize(), &mut rng).map_err(e)?;
        let kp = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng);
        let ksig = idk.private_key().calculate_signature(&kp.public_key.serialize(), &mut rng).map_err(e)?;
        let mut d = Data { idk: idk.serialize().to_vec(), reg, ..Default::default() };
        d.spk.insert(1, SignedPreKeyRecord::new(1.into(), ts, &spk, &sig).serialize().map_err(e)?);
        d.kpk.insert(1, KyberPreKeyRecord::new(1.into(), ts, &kp, &ksig).serialize().map_err(e)?);
        Ok(Store { d })
    }

    pub fn load(json: &str) -> R<Store> {
        let v: Value = serde_json::from_str(json).map_err(e)?;
        Ok(Store { d: Data {
            idk: unb64(v["idk"].as_str().ok_or(e("no idk"))?)?,
            reg: v["reg"].as_u64().ok_or(e("no reg"))? as u32,
            pre: unmap(&v["pre"])?, spk: unmap(&v["spk"])?, kpk: unmap(&v["kpk"])?,
            sess: unmap(&v["sess"])?, ident: unmap(&v["ident"])?, sk: unmap(&v["sk"])?,
        }})
    }

    pub fn export(&self) -> String {
        json!({"idk": b64(&self.d.idk), "reg": self.d.reg, "pre": mapj(&self.d.pre), "spk": mapj(&self.d.spk),
               "kpk": mapj(&self.d.kpk), "sess": mapj(&self.d.sess), "ident": mapj(&self.d.ident), "sk": mapj(&self.d.sk)}).to_string()
    }

    /// Строка для devices_keys (без device_id/user_id), как в Android E2eCore.
    #[wasm_bindgen(js_name = publicRow)]
    pub fn public_row(&self) -> R<String> {
        let idk = IdentityKeyPair::try_from(&self.d.idk[..]).map_err(e)?;
        let spk = SignedPreKeyRecord::deserialize(&self.d.spk[&1]).map_err(e)?;
        let kpk = KyberPreKeyRecord::deserialize(&self.d.kpk[&1]).map_err(e)?;
        Ok(json!({"registration_id": self.d.reg, "identity_pub": b64(&idk.identity_key().serialize()),
            "signed_prekey_id": 1, "signed_prekey": b64(&spk.public_key().map_err(e)?.serialize()),
            "signed_prekey_sig": b64(&spk.signature().map_err(e)?),
            "kyber_prekey_id": 1, "kyber_prekey": b64(&kpk.public_key().map_err(e)?.serialize()),
            "kyber_prekey_sig": b64(&kpk.signature().map_err(e)?)}).to_string())
    }

    /// Генерирует одноразовые prekey с id start..start+n, сохраняет локально; возвращает [{key_id,pub}].
    #[wasm_bindgen(js_name = genPrekeys)]
    pub fn gen_prekeys(&mut self, start: u32, n: u32) -> R<String> {
        let mut rng = rand::rngs::OsRng.unwrap_err();
        let mut out = vec![];
        for id in start..start + n {
            let kp = KeyPair::generate(&mut rng);
            self.d.pre.insert(id, PreKeyRecord::new(id.into(), &kp).serialize().map_err(e)?);
            out.push(json!({"key_id": id, "pub": b64(&kp.public_key.serialize())}));
        }
        Ok(Value::Array(out).to_string())
    }

    #[wasm_bindgen(js_name = hasSession)]
    pub fn has_session(&self, dev: &str) -> bool {
        self.d.sess.get(dev).and_then(|b| SessionRecord::deserialize(b).ok())
            .is_some_and(|s| s.has_usable_sender_chain(now(), SessionUsabilityRequirements::all()).unwrap_or(false))
    }

    #[wasm_bindgen(js_name = deleteSession)]
    pub fn delete_session(&mut self, dev: &str) { self.d.sess.remove(dev); self.d.ident.remove(dev); }

    #[wasm_bindgen(js_name = identityOf)]
    pub fn identity_of(&self, dev: &str) -> Option<String> { self.d.ident.get(dev).map(|b| b64(b)) }

    /// Проверка подписей signed/kyber prekey строки claim_prekeys.
    #[wasm_bindgen(js_name = verifyRow)]
    pub fn verify_row(row: &str) -> R<bool> {
        let o: Value = serde_json::from_str(row).map_err(e)?;
        let s = |k: &str| -> R<Vec<u8>> { unb64(o[k].as_str().ok_or(e(format!("no {k}")))?) };
        let ik = IdentityKey::decode(&s("identity_pub")?).map_err(e)?;
        let spk = PublicKey::deserialize(&s("signed_prekey")?).map_err(e)?;
        if !ik.public_key().verify_signature(&spk.serialize(), &s("signed_prekey_sig")?) { return Ok(false); }
        let kk = kem::PublicKey::deserialize(&s("kyber_prekey")?).map_err(e)?;
        Ok(ik.public_key().verify_signature(&kk.serialize(), &s("kyber_prekey_sig")?))
    }

    /// X3DH/PQXDH: строит сессию по строке claim_prekeys.
    #[wasm_bindgen(js_name = processBundle)]
    pub fn process_bundle(&mut self, row: &str) -> R<()> {
        let o: Value = serde_json::from_str(row).map_err(e)?;
        let s = |k: &str| -> R<Vec<u8>> { unb64(o[k].as_str().ok_or(e(format!("no {k}")))?) };
        let otk = match (o["otk_id"].as_u64(), o["otk_pub"].as_str()) {
            (Some(id), Some(p)) => Some(((id as u32).into(), PublicKey::deserialize(&unb64(p)?).map_err(e)?)),
            _ => None,
        };
        let b = PreKeyBundle::new(o["registration_id"].as_u64().ok_or(e("no reg"))? as u32, DeviceId::new(1).unwrap(), otk,
            (o["signed_prekey_id"].as_u64().ok_or(e("no spk id"))? as u32).into(), PublicKey::deserialize(&s("signed_prekey")?).map_err(e)?,
            s("signed_prekey_sig")?, (o["kyber_prekey_id"].as_u64().ok_or(e("no kpk id"))? as u32).into(),
            kem::PublicKey::deserialize(&s("kyber_prekey")?).map_err(e)?, s("kyber_prekey_sig")?,
            IdentityKey::decode(&s("identity_pub")?).map_err(e)?).map_err(e)?;
        let dev = o["device_id"].as_str().ok_or(e("no device_id"))?;
        let mut rng = rand::rngs::OsRng.unwrap_err();
        let d = &mut self.d;
        let (ss, is): (*mut Data, *mut Data) = (d, d);
        // SAFETY: Data реализует оба трейта над разными полями; вызовы синхронны.
        sync(process_prekey_bundle(&addr(dev), unsafe { &mut *ss }, unsafe { &mut *is }, &b, now(), &mut rng)).map_err(e)
    }

    /// Шифрует для устройства: {"t": type, "b": base64}.
    pub fn encrypt(&mut self, dev: &str, plaintext: &str) -> R<String> {
        let mut rng = rand::rngs::OsRng.unwrap_err();
        let d: *mut Data = &mut self.d;
        let m = sync(message_encrypt(plaintext.as_bytes(), &addr(dev), unsafe { &mut *d }, unsafe { &mut *d }, now(), &mut rng)).map_err(e)?;
        Ok(json!({"t": m.message_type() as u8, "b": b64(m.serialize())}).to_string())
    }

    /// Расшифровывает сообщение от устройства `from` (t=3 PreKey, t=2 Whisper).
    pub fn decrypt(&mut self, from: &str, t: u8, body: &str) -> R<String> {
        let raw = unb64(body)?;
        let msg = match t {
            3 => CiphertextMessage::PreKeySignalMessage(PreKeySignalMessage::try_from(&raw[..]).map_err(e)?),
            2 => CiphertextMessage::SignalMessage(SignalMessage::try_from(&raw[..]).map_err(e)?),
            _ => return Err(e("unknown message type")),
        };
        let mut rng = rand::rngs::OsRng.unwrap_err();
        let d: *mut Data = &mut self.d;
        let pt = unsafe { sync(message_decrypt(&msg, &addr(from), &mut *d, &mut *d, &mut *d, &*d, &mut *d, &mut rng)) }.map_err(e)?;
        String::from_utf8(pt).map_err(e)
    }

    /// SKDM своего ключа отправителя для группы/эпохи (создаёт ключ при первом вызове), base64.
    #[wasm_bindgen(js_name = groupSkdm)]
    pub fn group_skdm(&mut self, me: &str, chat: &str, epoch: u32) -> R<String> {
        let mut rng = rand::rngs::OsRng.unwrap_err();
        let m = sync(create_sender_key_distribution_message(&addr(me), dist_id(chat, epoch), &mut self.d, &mut rng)).map_err(e)?;
        Ok(b64(m.serialized()))
    }

    /// Шифрует SKDM (base64) для устройства 1:1-сессией: {"t","b"}.
    #[wasm_bindgen(js_name = encryptBytes)]
    pub fn encrypt_bytes(&mut self, dev: &str, data_b64: &str) -> R<String> {
        let data = unb64(data_b64)?;
        let mut rng = rand::rngs::OsRng.unwrap_err();
        let d: *mut Data = &mut self.d;
        let m = sync(message_encrypt(&data, &addr(dev), unsafe { &mut *d }, unsafe { &mut *d }, now(), &mut rng)).map_err(e)?;
        Ok(json!({"t": m.message_type() as u8, "b": b64(m.serialize())}).to_string())
    }

    /// Расшифровывает 1:1-сообщение в байты (base64).
    #[wasm_bindgen(js_name = decryptBytes)]
    pub fn decrypt_bytes(&mut self, from: &str, t: u8, body: &str) -> R<String> {
        let raw = unb64(body)?;
        let msg = match t {
            3 => CiphertextMessage::PreKeySignalMessage(PreKeySignalMessage::try_from(&raw[..]).map_err(e)?),
            2 => CiphertextMessage::SignalMessage(SignalMessage::try_from(&raw[..]).map_err(e)?),
            _ => return Err(e("unknown message type")),
        };
        let mut rng = rand::rngs::OsRng.unwrap_err();
        let d: *mut Data = &mut self.d;
        let pt = unsafe { sync(message_decrypt(&msg, &addr(from), &mut *d, &mut *d, &mut *d, &*d, &mut *d, &mut rng)) }.map_err(e)?;
        Ok(b64(&pt))
    }

    /// Принимает SKDM от устройства; проверяет distribution id = группа/эпоха.
    #[wasm_bindgen(js_name = groupProcess)]
    pub fn group_process(&mut self, from: &str, chat: &str, epoch: u32, skdm_b64: &str) -> R<()> {
        let m = SenderKeyDistributionMessage::try_from(&unb64(skdm_b64)?[..]).map_err(e)?;
        if m.distribution_id().map_err(e)? != dist_id(chat, epoch) { return Err(e("ключ не этой группы/эпохи")); }
        sync(process_sender_key_distribution_message(&addr(from), &m, &mut self.d)).map_err(e)
    }

    #[wasm_bindgen(js_name = groupHasKey)]
    pub fn group_has_key(&self, from: &str, chat: &str, epoch: u32) -> bool { self.d.sk.contains_key(&format!("{}|{}", from, dist_id(chat, epoch))) }

    /// Групповое сообщение: base64 SenderKeyMessage (для {"sk": ...}).
    #[wasm_bindgen(js_name = groupEncrypt)]
    pub fn group_encrypt_js(&mut self, me: &str, chat: &str, epoch: u32, plaintext: &str) -> R<String> {
        let mut rng = rand::rngs::OsRng.unwrap_err();
        let m = sync(group_encrypt(&mut self.d, &addr(me), dist_id(chat, epoch), plaintext.as_bytes(), &mut rng)).map_err(e)?;
        Ok(b64(m.serialized()))
    }

    #[wasm_bindgen(js_name = groupDecrypt)]
    pub fn group_decrypt_js(&mut self, from: &str, chat: &str, epoch: u32, sk_b64: &str) -> R<String> {
        let raw = unb64(sk_b64)?;
        let m = SenderKeyMessage::try_from(&raw[..]).map_err(e)?;
        if m.distribution_id() != dist_id(chat, epoch) { return Err(e("ключ не этой группы/эпохи")); }
        let pt = sync(group_decrypt(&raw, &mut self.d, &addr(from))).map_err(e)?;
        String::from_utf8(pt).map_err(e)
    }
}
