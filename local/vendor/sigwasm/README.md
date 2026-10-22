# sigwasm — libsignal в браузере

Официальный `libsignal-protocol` (signalapp/libsignal **v0.86.5**, та же версия, что `org.signal:libsignal-android:0.86.5` в Android-клиенте),
собранный в WebAssembly с тонкой обёрткой `src/lib.rs`. Своей криптографии нет.
Лицензия libsignal: AGPL-3.0-only; исходники обёртки — здесь, libsignal — https://github.com/signalapp/libsignal/tree/v0.86.5

Сборка (Node не нужен):
```
git clone --depth 1 -b v0.86.5 https://github.com/signalapp/libsignal ../libsignal   # рядом с этой папкой
cp ../libsignal/Cargo.lock .
PROTOC=/path/to/protoc RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
  cargo +nightly-2025-09-24 build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir . target/wasm32-unknown-unknown/release/sigwasm.wasm   # wasm-bindgen-cli 0.2.103
```
