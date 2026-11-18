# Arcade Kelas / Ruang Bermain (v1.2.0)

Platform siswa TJKT memamerkan game .html hasil vibe coding. Fitur: daftar/login siswa, upload/edit/hapus game, gambar sampul, like, ganti password, batas percobaan login, panel admin (takedown, hapus, reset password).

## Kenapa v1.2.0?
Vercel tidak punya disk permanen (disk hanya-baca), jadi database SQLite di folder `data/` tidak bisa ditulis dan pendaftaran error 500.
Sekarang semua data (akun, game, sampul) disimpan di database Turso (libSQL, gratis, kompatibel SQLite).

## A. Deploy di Vercel
1. Buat akun di turso.tech, buat database baru (pilih region terdekat, mis. Singapore).
2. Ambil **URL database** (`libsql://...`) dan buat **token** untuk database itu.
3. Di Vercel: Project > Settings > Environment Variables, isi (Production):
   - `TURSO_DATABASE_URL` = URL dari Turso
   - `TURSO_AUTH_TOKEN`   = token dari Turso
   - `SESSION_SECRET`     = teks acak panjang
   - `ADMIN_USER`, `ADMIN_PASS` = akun admin (dibuat otomatis saat database masih kosong)
4. Ganti isi repo dengan isi zip ini (`server.js`, `package.json`, `api/`, `vercel.json`, `public/`, `.gitignore`).
   **Hapus folder `data/` dari repo** (tidak dipakai lagi). Push, lalu Redeploy.
   Jika konfigurasi Vercel Anda sudah jalan dengan struktur lain, minimal ganti `server.js` dan `package.json`.

Batas Vercel: ukuran request maks 4,5 MB (batas game 3 MB + sampul 0,5 MB masih muat).
Batas login disimpan di memori per instance, jadi di Vercel sifatnya pelindung ringan.

## B. Localhost / VPS (tanpa Turso)
Syarat Node.js 22.13+. Kosongkan `TURSO_*`; data disimpan di `data/app.db`.
```
npm install
copy .env.example .env      (Linux: cp)
npm start                   -> http://localhost:3000
```
Data lama v1.1.0 (file di `data/games` dan `data/thumbs`) otomatis dipindah ke database saat pertama jalan.

## Catatan
- Game disajikan dengan CSP sandbox: kode game tidak bisa membaca sesi situs.
- Reset password siswa oleh admin: jadi `12345678`. Siswa bisa ganti sendiri lewat menu Password.
