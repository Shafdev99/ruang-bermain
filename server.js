import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dir, 'data');
const SECRET = process.env.SESSION_SECRET || 'dev-secret-ubah-di-produksi';
const MAX_MB = 3;

// Database: Turso (libSQL) bila TURSO_DATABASE_URL diisi (WAJIB di Vercel, disk Vercel hanya-baca).
// Tanpa itu: SQLite lokal di folder data/ (untuk localhost / VPS).
let db;
if (process.env.TURSO_DATABASE_URL) {
  const { createClient } = await import('@libsql/client/web');
  const c = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  const ex = (sql, a) => c.execute({ sql, args: a });
  db = {
    prepare: sql => ({
      get: async (...a) => (await ex(sql, a)).rows[0],
      all: async (...a) => [...(await ex(sql, a)).rows],
      run: async (...a) => { const r = await ex(sql, a); return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid) }; },
    }),
    exec: sql => c.executeMultiple(sql),
  };
} else {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(DATA, { recursive: true });
  const l = new DatabaseSync(path.join(DATA, 'app.db'));
  db = {
    prepare: sql => { const q = l.prepare(sql); return { get: async (...a) => q.get(...a), all: async (...a) => q.all(...a), run: async (...a) => { const r = q.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; } }; },
    exec: async sql => l.exec(sql),
  };
}
await db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, name TEXT, kelas TEXT, hash TEXT, role TEXT DEFAULT 'siswa', created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS games(id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, descr TEXT, hidden INTEGER DEFAULT 0, plays INTEGER DEFAULT 0, created TEXT DEFAULT CURRENT_TIMESTAMP, thumb TEXT);
CREATE TABLE IF NOT EXISTS likes(user_id INTEGER, game_id INTEGER, PRIMARY KEY(user_id,game_id));
CREATE TABLE IF NOT EXISTS blobs(game_id INTEGER, kind TEXT, body TEXT, PRIMARY KEY(game_id,kind));
`);
try { await db.exec('ALTER TABLE games ADD COLUMN thumb TEXT'); } catch { }
// Migrasi file lama (v1.1.0 ke bawah: data/games/*.html, data/thumbs/*) ke tabel blobs
for (const g of await db.prepare('SELECT id,thumb FROM games').all()) {
  const hf = path.join(DATA, 'games', `${g.id}.html`);
  if (fs.existsSync(hf) && !(await db.prepare("SELECT 1 FROM blobs WHERE game_id=? AND kind='html'").get(g.id))) {
    await db.prepare("INSERT INTO blobs VALUES(?,'html',?)").run(g.id, fs.readFileSync(hf, 'utf8'));
    const tf = g.thumb && path.join(DATA, 'thumbs', `${g.id}.${g.thumb}`);
    if (tf && fs.existsSync(tf)) await db.prepare("INSERT OR REPLACE INTO blobs VALUES(?,'thumb',?)").run(g.id, fs.readFileSync(tf).toString('base64'));
  }
}
if (!(await db.prepare("SELECT 1 FROM users WHERE role='admin'").get())) {
  const u = process.env.ADMIN_USER || 'admin', p = process.env.ADMIN_PASS || 'admin12345';
  await db.prepare("INSERT INTO users(username,name,kelas,hash,role) VALUES(?,?,?,?,'admin')").run(u, 'Admin', '-', bcrypt.hashSync(p, 10));
  console.log(`Akun admin dibuat: ${u}${process.env.ADMIN_PASS ? '' : ' / admin12345  (SEGERA GANTI via env!)'}`);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const hue = id => (id * 47) % 360;

function page(req, title, body) {
  const u = req.user, f = req.session.flash; req.session.flash = null;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Ruang Bermain</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css"></head><body>
<header class="top"><a class="brand" href="/">Ruang Bermain</a><nav>
${u ? `<a href="/upload">Upload game</a><a href="/me">Game saya</a><a href="/password">Password</a>${u.role === 'admin' ? '<a href="/admin">Admin</a>' : ''}
<form method="post" action="/logout"><button class="link">Keluar (${esc(u.username)})</button></form>`
      : `<a href="/login">Masuk</a><a class="btn sm" href="/register">Daftar</a>`}</nav></header>
<main>${f ? `<p class="flash ${f.t}">${esc(f.m)}</p>` : ''}${body}</main>
<footer>Game dibuat siswa TJKT dengan vibe coding.</footer></body></html>`;
}
const flash = (req, m, t = 'ok') => { req.session.flash = { m, t }; };
// Batas percobaan gagal (per kunci, mis. IP+username). Sengaja tidak per-IP saja: sekolah biasanya berbagi satu IP publik.
const buckets = new Map();
function limited(key, max, ms, add) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.t < now) b = { n: 0, t: now + ms };
  if (add) b.n++;
  buckets.set(key, b); return b.n >= max;
}
setInterval(() => { const n = Date.now(); for (const [k, b] of buckets) if (b.t < n) buckets.delete(k); }, 6e5).unref();
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const sniff = b => b.length > 12 && (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png' : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg' : b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null);
const rmBlobs = id => db.prepare('DELETE FROM blobs WHERE game_id=?').run(id);
const saveThumb = async (id, ext, buf) => { await db.prepare("INSERT OR REPLACE INTO blobs(game_id,kind,body) VALUES(?,'thumb',?)").run(id, buf.toString('base64')); await db.prepare('UPDATE games SET thumb=? WHERE id=?').run(ext, id); };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(cookieSession({ name: 's', keys: [SECRET], maxAge: 7 * 864e5, sameSite: 'lax', httpOnly: true }));
app.use(express.static(path.join(__dir, 'public')));
app.use(async (req, res, next) => {
  req.body ??= {};
  req.user = req.session.uid ? await db.prepare('SELECT id,username,name,kelas,role FROM users WHERE id=?').get(req.session.uid) : null;
  next();
});
const needLogin = (req, res, next) => req.user ? next() : (flash(req, 'Masuk dulu ya.', 'err'), res.redirect('/login'));
const needAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).send(page(req, 'Ditolak', '<h1>Khusus admin</h1>'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024 } }).fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]);
const saveFile = (id, buf) => db.prepare("INSERT OR REPLACE INTO blobs(game_id,kind,body) VALUES(?,'html',?)").run(id, buf.toString('utf8'));

const card = g => `<a class="card" href="/game/${g.id}" style="--h:${hue(g.id)}"><div class="cover"><span>${esc(g.title.slice(0, 1).toUpperCase())}</span>${g.thumb ? `<img src="/thumb/${g.id}" alt="" loading="lazy">` : ''}</div>
<div class="meta"><h3>${esc(g.title)}</h3><p>${esc(g.name)} · ${esc(g.kelas)}</p><small>♥ ${g.likes} · ${g.plays}× dimainkan</small></div></a>`;

// ---------- Publik ----------
app.get('/', async (req, res) => {
  const q = clip(req.query.q, 50);
  const rows = await db.prepare(`SELECT g.*,u.name,u.kelas,(SELECT COUNT(*) FROM likes WHERE game_id=g.id) likes FROM games g JOIN users u ON u.id=g.user_id WHERE g.hidden=0 AND (g.title LIKE ? OR u.name LIKE ? OR u.kelas LIKE ?) ORDER BY g.id DESC`).all(...Array(3).fill(`%${q}%`));
  res.send(page(req, 'Beranda', `<section class="hero"><h1>Main game buatan teman sekelas.</h1><p>Setiap game di sini dibuat siswa TJKT lewat vibe coding. Klik, mainkan, lalu bikin versimu sendiri.</p>
<form class="search"><input name="q" value="${esc(q)}" placeholder="Cari judul, nama, atau kelas"><button class="btn">Cari</button></form></section>
${rows.length ? `<div class="grid">${rows.map(card).join('')}</div>` : `<p class="empty">${q ? 'Tidak ada game yang cocok.' : 'Belum ada game. <a href="/upload">Upload game pertama</a>.'}</p>`}`));
});

app.get('/game/:id', async (req, res) => {
  const g = await db.prepare('SELECT g.*,u.name,u.kelas,(SELECT COUNT(*) FROM likes WHERE game_id=g.id) likes FROM games g JOIN users u ON u.id=g.user_id WHERE g.id=?').get(+req.params.id);
  if (!g || (g.hidden && req.user?.role !== 'admin' && req.user?.id !== g.user_id)) return res.status(404).send(page(req, '404', '<h1>Game tidak ditemukan</h1>'));
  if (!req.query.r) await db.prepare('UPDATE games SET plays=plays+1 WHERE id=?').run(g.id);
  const liked = req.user && await db.prepare('SELECT 1 FROM likes WHERE user_id=? AND game_id=?').get(req.user.id, g.id);
  res.send(page(req, g.title, `<article class="play"><h1>${esc(g.title)}</h1><p class="by">oleh ${esc(g.name)} · ${esc(g.kelas)}</p>
${g.hidden ? '<p class="flash err">Game ini disembunyikan admin.</p>' : ''}
<div class="frame"><iframe id="f" src="/play/${g.id}" sandbox="allow-scripts allow-pointer-lock" allow="fullscreen" loading="lazy"></iframe></div>
<div class="row"><button class="btn" onclick="document.getElementById('f').requestFullscreen()">Layar penuh</button>
${req.user ? `<form method="post" action="/like/${g.id}"><button class="btn alt">♥ ${liked ? 'Disukai' : 'Suka'} (${g.likes})</button></form>` : `<a class="btn alt" href="/login">♥ Suka (${g.likes})</a>`}</div><p class="descr">${esc(g.descr)}</p></article>`));
});

// File game disajikan dengan CSP sandbox: tidak bisa membaca cookie/sesi situs.
app.get('/play/:id', async (req, res) => {
  const g = await db.prepare('SELECT * FROM games WHERE id=?').get(+req.params.id);
  const b = g && await db.prepare("SELECT body FROM blobs WHERE game_id=? AND kind='html'").get(g.id);
  if (!b || (g.hidden && req.user?.role !== 'admin' && req.user?.id !== g.user_id)) return res.sendStatus(404);
  res.set({ 'Content-Security-Policy': 'sandbox allow-scripts allow-pointer-lock', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'text/html; charset=utf-8' });
  res.send(b.body);
});
app.post('/like/:id', needLogin, async (req, res) => {
  const id = +req.params.id;
  if (await db.prepare('SELECT 1 FROM games WHERE id=? AND hidden=0').get(id)) {
    const del = await db.prepare('DELETE FROM likes WHERE user_id=? AND game_id=?').run(req.user.id, id);
    if (!del.changes) await db.prepare('INSERT INTO likes VALUES(?,?)').run(req.user.id, id);
  }
  res.redirect(`/game/${id}?r=1`);
});
app.get('/thumb/:id', async (req, res) => {
  const g = await db.prepare('SELECT id,thumb,user_id,hidden FROM games WHERE id=?').get(+req.params.id);
  const b = g?.thumb && await db.prepare("SELECT body FROM blobs WHERE game_id=? AND kind='thumb'").get(g.id);
  if (!b || !MIME[g.thumb] || (g.hidden && req.user?.role !== 'admin' && req.user?.id !== g.user_id)) return res.sendStatus(404);
  res.set({ 'Content-Type': MIME[g.thumb], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
  res.send(Buffer.from(b.body, 'base64'));
});

// ---------- Akun ----------
const authForm = (req, reg) => page(req, reg ? 'Daftar' : 'Masuk', `<form class="box" method="post"><h1>${reg ? 'Daftar akun siswa' : 'Masuk'}</h1>
${reg ? '<label>Nama lengkap<input name="name" required maxlength="40"></label><label>Kelas<input name="kelas" required maxlength="20" placeholder="contoh: XI TJKT 1"></label>' : ''}
<label>Username<input name="username" required maxlength="20" autocomplete="username"></label>
<label>Password<input type="password" name="password" required minlength="6" autocomplete="${reg ? 'new' : 'current'}-password"></label>
<button class="btn">${reg ? 'Daftar' : 'Masuk'}</button><p class="alt">${reg ? 'Sudah punya akun? <a href="/login">Masuk</a>' : 'Belum punya akun? <a href="/register">Daftar</a>'}</p></form>`);
app.get('/register', async (req, res) => res.send(authForm(req, true)));
app.get('/login', async (req, res) => res.send(authForm(req, false)));
app.post('/register', async (req, res) => {
  const username = clip(req.body.username, 20).toLowerCase(), name = clip(req.body.name, 40), kelas = clip(req.body.kelas, 20), pw = String(req.body.password || '');
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) { flash(req, 'Username 3–20 karakter: huruf, angka, titik, atau underscore.', 'err'); return res.redirect('/register'); }
  if (!name || !kelas || pw.length < 6) { flash(req, 'Lengkapi semua kolom. Password minimal 6 karakter.', 'err'); return res.redirect('/register'); }
  if (await db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) { flash(req, 'Username sudah dipakai. Coba yang lain.', 'err'); return res.redirect('/register'); }
  const r = await db.prepare('INSERT INTO users(username,name,kelas,hash) VALUES(?,?,?,?)').run(username, name, kelas, bcrypt.hashSync(pw, 10));
  req.session.uid = r.lastInsertRowid; flash(req, 'Akun dibuat. Sekarang upload game pertamamu!'); res.redirect('/upload');
});
app.post('/login', async (req, res) => {
  const un = clip(req.body.username, 20).toLowerCase(), key = `l|${req.ip}|${un}`;
  if (limited(key, 5, 15 * 6e4)) { flash(req, 'Terlalu banyak percobaan gagal. Coba lagi 15 menit lagi.', 'err'); return res.redirect('/login'); }
  const u = await db.prepare('SELECT * FROM users WHERE username=?').get(un);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.hash)) { limited(key, 5, 15 * 6e4, true); flash(req, 'Username atau password salah.', 'err'); return res.redirect('/login'); }
  buckets.delete(key); req.session.uid = u.id; res.redirect(u.role === 'admin' ? '/admin' : '/me');
});
app.get('/password', needLogin, async (req, res) => res.send(page(req, 'Ganti password', `<form class="box" method="post"><h1>Ganti password</h1>
<label>Password lama<input type="password" name="old" required autocomplete="current-password"></label>
<label>Password baru (minimal 6 karakter)<input type="password" name="new" required minlength="6" autocomplete="new-password"></label>
<button class="btn">Simpan password</button></form>`)));
app.post('/password', needLogin, async (req, res) => {
  const key = `p|${req.user.id}`, nw = String(req.body.new || '');
  if (limited(key, 5, 15 * 6e4)) { flash(req, 'Terlalu banyak percobaan gagal. Coba lagi 15 menit lagi.', 'err'); return res.redirect('/password'); }
  const u = await db.prepare('SELECT hash FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.old || ''), u.hash)) { limited(key, 5, 15 * 6e4, true); flash(req, 'Password lama salah.', 'err'); return res.redirect('/password'); }
  if (nw.length < 6) { flash(req, 'Password baru minimal 6 karakter.', 'err'); return res.redirect('/password'); }
  await db.prepare('UPDATE users SET hash=? WHERE id=?').run(bcrypt.hashSync(nw, 10), req.user.id);
  buckets.delete(key); flash(req, 'Password berhasil diganti.'); res.redirect('/me');
});
app.post('/logout', async (req, res) => { req.session = null; res.redirect('/'); });

// ---------- Kelola game sendiri ----------
const gameForm = (req, g) => page(req, g ? 'Edit game' : 'Upload game', `<form class="box" method="post" enctype="multipart/form-data"><h1>${g ? 'Edit game' : 'Upload game'}</h1>
<label>Judul<input name="title" required maxlength="60" value="${esc(g?.title)}"></label>
<label>Deskripsi / cara main<textarea name="descr" rows="4" maxlength="500">${esc(g?.descr)}</textarea></label>
<label>File game (.html, maks ${MAX_MB} MB)${g ? ' — kosongkan jika tidak diganti' : ''}<input type="file" name="file" accept=".html,.htm" ${g ? '' : 'required'}></label>
<label>Gambar sampul (opsional; PNG/JPG/WEBP, maks 500 KB)<input type="file" name="thumb" accept="image/png,image/jpeg,image/webp"></label>
<p class="hint">Satu file .html lengkap (CSS & JS di dalamnya). Game tidak bisa memuat file lain dari server ini.</p>
<button class="btn">${g ? 'Simpan perubahan' : 'Terbitkan game'}</button></form>`);
const own = async (req, res) => {
  const g = await db.prepare('SELECT * FROM games WHERE id=?').get(+req.params.id);
  if (!g || (g.user_id !== req.user.id && req.user.role !== 'admin')) { res.sendStatus(404); return null; }
  return g;
};
const validFile = f => f && /\.html?$/i.test(f.originalname) && f.size > 0;
const handle = (req, res, id) => upload(req, res, async err => {
  try {
    const back = id ? `/edit/${id}` : '/upload';
    const title = clip(req.body?.title, 60);
    if (err) { flash(req, err.code === 'LIMIT_FILE_SIZE' ? `File terlalu besar (maks ${MAX_MB} MB).` : 'Upload gagal.', 'err'); return res.redirect(back); }
    if (!title) { flash(req, 'Judul wajib diisi.', 'err'); return res.redirect(back); }
    const f = req.files?.file?.[0], t = req.files?.thumb?.[0]; let ext = null;
    if (t) { ext = t.size <= 512 * 1024 && sniff(t.buffer); if (!ext) { flash(req, 'Gambar sampul harus PNG, JPG, atau WEBP (maks 500 KB).', 'err'); return res.redirect(back); } }
    if (f && !validFile(f)) { flash(req, 'File harus berekstensi .html', 'err'); return res.redirect(back); }
    if (id) {
      await db.prepare('UPDATE games SET title=?,descr=? WHERE id=?').run(title, clip(req.body.descr, 500), id);
      if (f) await saveFile(id, f.buffer);
    } else {
      if (!f) { flash(req, 'Pilih file .html dulu.', 'err'); return res.redirect(back); }
      id = (await db.prepare('INSERT INTO games(user_id,title,descr) VALUES(?,?,?)').run(req.user.id, title, clip(req.body.descr, 500))).lastInsertRowid;
      await saveFile(id, f.buffer);
    }
    if (t) await saveThumb(id, ext, t.buffer);
    flash(req, id ? 'Game tersimpan.' : 'Game terbit.'); res.redirect(`/game/${id}`);
  } catch (e) { console.error(e); flash(req, 'Terjadi kesalahan server. Coba lagi.', 'err'); res.redirect('/'); }
});
app.get('/upload', needLogin, async (req, res) => res.send(gameForm(req)));
app.post('/upload', needLogin, async (req, res) => handle(req, res, null));
app.get('/edit/:id', needLogin, async (req, res) => { const g = await own(req, res); if (g) res.send(gameForm(req, g)); });
app.post('/edit/:id', needLogin, async (req, res) => { const g = await own(req, res); if (g) handle(req, res, g.id); });
app.post('/delete/:id', needLogin, async (req, res) => {
  const g = await own(req, res); if (!g) return;
  await db.prepare('DELETE FROM games WHERE id=?').run(g.id); await db.prepare('DELETE FROM likes WHERE game_id=?').run(g.id); await rmBlobs(g.id);
  flash(req, 'Game dihapus.'); res.redirect(req.user.role === 'admin' && req.get('referer')?.includes('/admin') ? '/admin' : '/me');
});
app.get('/me', needLogin, async (req, res) => {
  const rows = await db.prepare('SELECT g.*,u.name,u.kelas,(SELECT COUNT(*) FROM likes WHERE game_id=g.id) likes FROM games g JOIN users u ON u.id=g.user_id WHERE g.user_id=? ORDER BY g.id DESC').all(req.user.id);
  res.send(page(req, 'Game saya', `<h1>Game saya</h1>${rows.length ? `<table><tr><th>Judul</th><th>Dimainkan</th><th>Status</th><th></th></tr>${rows.map(g => `<tr><td><a href="/game/${g.id}">${esc(g.title)}</a></td><td>${g.plays}</td><td>${g.hidden ? 'Disembunyikan admin' : 'Tayang'}</td>
<td class="act"><a href="/edit/${g.id}">Edit</a><form method="post" action="/delete/${g.id}" onsubmit="return confirm('Hapus game ini?')"><button class="link danger">Hapus</button></form></td></tr>`).join('')}</table>` : '<p class="empty">Belum ada game. <a href="/upload">Upload sekarang</a>.</p>'}`));
});

// ---------- Admin ----------
app.get('/admin', needLogin, needAdmin, async (req, res) => {
  const games = await db.prepare('SELECT g.*,u.name,u.kelas,(SELECT COUNT(*) FROM likes WHERE game_id=g.id) likes FROM games g JOIN users u ON u.id=g.user_id ORDER BY g.id DESC').all();
  const users = await db.prepare("SELECT u.*,(SELECT COUNT(*) FROM games WHERE user_id=u.id) n FROM users u WHERE role='siswa' ORDER BY kelas,name").all();
  res.send(page(req, 'Admin', `<h1>Admin</h1><p>${games.length} game · ${users.length} siswa</p>
<h2>Semua game</h2><table><tr><th>Judul</th><th>Pembuat</th><th>Status</th><th></th></tr>${games.map(g => `<tr><td><a href="/game/${g.id}">${esc(g.title)}</a></td><td>${esc(g.name)} (${esc(g.kelas)})</td><td>${g.hidden ? 'Disembunyikan' : 'Tayang'}</td>
<td class="act"><form method="post" action="/admin/hide/${g.id}"><button class="link">${g.hidden ? 'Tayangkan' : 'Takedown'}</button></form>
<form method="post" action="/delete/${g.id}" onsubmit="return confirm('Hapus permanen?')"><button class="link danger">Hapus</button></form></td></tr>`).join('') || '<tr><td colspan="4">Kosong</td></tr>'}</table>
<h2>Siswa</h2><table><tr><th>Nama</th><th>Kelas</th><th>Username</th><th>Game</th><th></th></tr>${users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.kelas)}</td><td>${esc(u.username)}</td><td>${u.n}</td>
<td class="act"><form method="post" action="/admin/reset/${u.id}" onsubmit="return confirm('Reset password jadi 12345678?')"><button class="link">Reset password</button></form>
<form method="post" action="/admin/user-delete/${u.id}" onsubmit="return confirm('Hapus akun beserta semua game-nya?')"><button class="link danger">Hapus akun</button></form></td></tr>`).join('') || '<tr><td colspan="5">Belum ada siswa</td></tr>'}</table>`));
});
app.post('/admin/hide/:id', needLogin, needAdmin, async (req, res) => { await db.prepare('UPDATE games SET hidden=1-hidden WHERE id=?').run(+req.params.id); flash(req, 'Status game diubah.'); res.redirect('/admin'); });
app.post('/admin/reset/:id', needLogin, needAdmin, async (req, res) => { await db.prepare("UPDATE users SET hash=? WHERE id=? AND role='siswa'").run(bcrypt.hashSync('12345678', 10), +req.params.id); flash(req, 'Password direset ke 12345678. Minta siswa menggantinya.'); res.redirect('/admin'); });
app.post('/admin/user-delete/:id', needLogin, needAdmin, async (req, res) => {
  const id = +req.params.id;
  for (const g of await db.prepare('SELECT id FROM games WHERE user_id=?').all(id)) { await rmBlobs(g.id); await db.prepare('DELETE FROM likes WHERE game_id=?').run(g.id); }
  await db.prepare('DELETE FROM likes WHERE user_id=?').run(id);
  await db.prepare('DELETE FROM games WHERE user_id=?').run(id); await db.prepare("DELETE FROM users WHERE id=? AND role='siswa'").run(id);
  flash(req, 'Akun dihapus.'); res.redirect('/admin');
});

if (!process.env.VERCEL) app.listen(process.env.PORT || 3000, () => console.log(`Arcade Kelas jalan di port ${process.env.PORT || 3000}`));
export default app;
