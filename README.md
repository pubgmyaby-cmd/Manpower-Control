# LRC Sync API — Worker Database Baru (Independen)

Backend WebSocket + Durable Object pengganti `wss://lrc-websocket-api.pmowtq.workers.dev/ws`.
Protokolnya kompatibel 100% dengan `index.html` yang sudah ada — Anda tidak perlu ubah
apa pun lagi di UI selain URL Worker-nya.

## 1. Deploy Worker (sekali saja)

Butuh Node.js + akun Cloudflare gratis (https://dash.cloudflare.com/sign-up).

```bash
cd worker
npm install
npx wrangler login        # buka browser, login/daftar Cloudflare
npx wrangler deploy
```

Setelah sukses, wrangler akan menampilkan URL seperti:

```
https://lrc-sync-api.<subdomain-anda>.workers.dev
```

## 2. Sambungkan index.html ke Worker baru

Buka `index.html`, cari baris:

```js
const WEBSOCKET_URL = "wss://REPLACE-WITH-YOUR-WORKER.workers.dev/ws";
```

Ganti jadi (pakai `wss://`, bukan `https://`, dan tambahkan `/ws` di akhir):

```js
const WEBSOCKET_URL = "wss://lrc-sync-api.<subdomain-anda>.workers.dev/ws";
```

## 3. Bikin "database" baru untuk klien/departemen lain

Satu Worker ini bisa melayani BANYAK database independen sekaligus. Yang membedakan
satu database dengan lainnya adalah `APP_ID` di index.html:

```js
const APP_ID = "lrc-offline-db-v11-advanced";
```

- Untuk instalasi/klien baru: copy `index.html`, ganti `APP_ID` jadi string unik lain,
  misalnya `"lrc-klien-abc"`. Data-nya akan otomatis 100% terpisah dari instalasi lain,
  walau sama-sama nyambung ke Worker yang sama.
- Tidak perlu deploy Worker baru tiap ada klien baru — cukup 1 baris ini yang beda.

## 4. Publish index.html ke Cloudflare Pages (biar bisa dibuka multi-device)

Paling gampang, tanpa CLI — drag & drop:

1. Buka https://dash.cloudflare.com → **Workers & Pages** → **Create** → tab **Pages** →
   **Upload assets**.
2. Beri nama project (mis. `lrc-app` — ini akan jadi bagian dari URL-nya).
3. Drag & drop file `index.html` (letakkan sendirian di folder upload).
4. Klik **Deploy**. Anda akan dapat URL publik seperti:
   `https://lrc-app.pages.dev`
5. Buka URL itu dari device manapun (HP, laptop lain, dll) — semuanya akan
   tersambung ke database yang sama lewat Worker di atas.

Setiap kali Anda edit `index.html` lagi (fitur baru dsb.), tinggal upload ulang file yang
sama dengan cara yang sama (Pages akan bikin deployment baru, URL tetap sama).

### Alternatif via CLI (kalau mau otomatis/berulang)

```bash
npx wrangler pages deploy . --project-name=lrc-app
```
(jalankan dari folder yang berisi `index.html`)

## Catatan

- Worker ini pakai WebSocket biasa (bukan Hibernation API) — cukup untuk tim kecil/menengah.
  Kalau nanti user makin banyak & butuh lebih hemat biaya, bisa di-upgrade ke Hibernatable
  WebSockets API dari Cloudflare.
- Lock (pessimistic lock per-cell) auto-expire 45 detik di sisi server, selaras dengan
  timeout 30 detik di UI.
- Data disimpan permanen di Durable Object Storage (bukan cuma RAM) — jadi aman walau
  Worker "tidur"/di-restart oleh Cloudflare.
