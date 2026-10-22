const express = require('express'), { Pool } = require('pg'), crypto = require('crypto');

const SECRET = process.env.SECRET || 'change-me-set-SECRET-env';
// Vercel's Neon integration may use a custom prefix (e.g. STORAGE_URL), so find any env var holding a Postgres URL.
const isPg = k => /^postgres(ql)?:\/\//.test(process.env[k] || '');
const envKey = ['DATABASE_URL', 'POSTGRES_URL'].find(isPg) ||
  Object.keys(process.env).find(k => isPg(k) && !/UNPOOLED|NON_POOLING/.test(k)) ||
  Object.keys(process.env).find(isPg);
let conn = (envKey && process.env[envKey]) || '';
conn = conn.replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');
const pool = conn ? new Pool({ connectionString: conn, max: 1, idleTimeoutMillis: 10000 }) : null;
const q = (t, p) => pool.query(t, p).then(r => r.rows);
const MSG = 'id, sender AS "from", recipient AS "to", body AS "text", ts::float8 AS ts, status, kind, media_id AS "media", dur';

let ready;
const init = () => ready || (ready = (async () => {
  await q(`CREATE TABLE IF NOT EXISTS users(phone text PRIMARY KEY, name text NOT NULL, salt text NOT NULL, hash text NOT NULL, last_seen bigint NOT NULL DEFAULT 0)`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS show_status boolean NOT NULL DEFAULT true`);
  await q(`CREATE TABLE IF NOT EXISTS messages(id uuid PRIMARY KEY, sender text NOT NULL, recipient text NOT NULL, body text NOT NULL, ts bigint NOT NULL, status text NOT NULL)`);
  await q(`CREATE TABLE IF NOT EXISTS blocks(blocker text NOT NULL, blocked text NOT NULL, PRIMARY KEY(blocker, blocked))`);
  await q(`CREATE TABLE IF NOT EXISTS reports(id serial PRIMARY KEY, reporter text NOT NULL, reported text NOT NULL, reason text, context jsonb NOT NULL, created bigint NOT NULL)`);
  await q(`CREATE INDEX IF NOT EXISTS msg_pair ON messages(sender, recipient, ts)`);
  await q(`CREATE INDEX IF NOT EXISTS msg_pending ON messages(recipient, status)`);
  await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text'`);
  await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_id uuid`);
  await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS dur int NOT NULL DEFAULT 0`);
  await q(`CREATE TABLE IF NOT EXISTS media(id uuid PRIMARY KEY, sender text NOT NULL, recipient text NOT NULL, mime text NOT NULL, data bytea NOT NULL, created bigint NOT NULL)`);
  await q(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS media uuid`);
  await q(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS media_kind text`);
})().catch(e => { ready = null; throw e; }));

const mac = b => crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
const sign = p => { const b = Buffer.from(p).toString('base64url'); return b + '.' + mac(b); };
const verify = tok => {
  if (!tok || typeof tok !== 'string') return null;
  const [b, s] = tok.split('.');
  if (!b || !s) return null;
  const e = mac(b);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  return Buffer.from(b, 'base64url').toString();
};
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const userExists = async p => (await q('SELECT 1 FROM users WHERE phone=$1', [p])).length > 0;

const app = express();
app.use(express.json({ limit: '50kb' }));

const zlib = require('zlib');
// ---- Calculator app icon, drawn in code so no image files are needed ----
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const inRR = (x, y, x0, y0, w, h, r) => {
  if (x < x0 || x > x0 + w || y < y0 || y > y0 + h) return false;
  const cx = x < x0 + r ? x0 + r : x > x0 + w - r ? x0 + w - r : x;
  const cy = y < y0 + r ? y0 + r : y > y0 + h - r ? y0 + h - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
function iconColor(x, y) {
  let c = [28, 28, 30];
  if (inRR(x, y, .1, .1, .8, .19, .04)) { c = [0, 0, 0]; if (inRR(x, y, .5, .17, .32, .05, .025)) c = [255, 255, 255]; }
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++)
    if (inRR(x, y, .1 + col * .2 + .01, .35 + row * .14 + .01, .18, .12, .045))
      c = col === 3 ? [255, 159, 10] : row === 0 ? [165, 165, 165] : [80, 80, 82];
  return c;
}
const iconCache = {};
function iconPng(s) {
  if (iconCache[s]) return iconCache[s];
  const stride = s * 4 + 1, raw = Buffer.alloc(stride * s);
  for (let py = 0; py < s; py++) for (let px = 0; px < s; px++) {
    let r = 0, g = 0, b = 0;
    for (const [dx, dy] of [[.25, .25], [.75, .25], [.25, .75], [.75, .75]]) { const c = iconColor((px + dx) / s, (py + dy) / s); r += c[0]; g += c[1]; b += c[2]; }
    const o = py * stride + 1 + px * 4;
    raw[o] = r >> 2; raw[o + 1] = g >> 2; raw[o + 2] = b >> 2; raw[o + 3] = 255;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(s, 0); ihdr.writeUInt32BE(s, 4); ihdr[8] = 8; ihdr[9] = 6;
  return iconCache[s] = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

app.get('/api/icon.png', (req, res) => {
  const s = [64, 180, 192, 512].includes(+req.query.s) ? +req.query.s : 180;
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.send(iconPng(s));
});

app.use('/api', (req, res, next) => {
  if (!pool) return res.status(503).json({ error: 'The database is not connected yet.' });
  init().then(() => next()).catch(e => { console.error(e); res.status(500).json({ error: 'Database error. Try again.' }); });
});

const h = fn => (req, res, next) => fn(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: 'Server error. Try again.' }); });
const auth = h(async (req, res, next) => {
  const p = verify((req.headers.authorization || '').replace('Bearer ', ''));
  if (!p || !(await userExists(p))) return res.status(401).json({ error: 'Please log in again' });
  req.me = p; next();
});

app.post('/api/register', h(async (req, res) => {
  const { name, phone, password } = req.body || {};
  const ph = String(phone || '').replace(/\D/g, '');
  if (!name || ph.length < 8 || ph.length > 15 || !password || String(password).length < 6)
    return res.status(400).json({ error: 'Enter your name, a phone number (8-15 digits) and a password (6+ characters)' });
  const salt = crypto.randomBytes(16).toString('hex'), nm = String(name).trim().slice(0, 40);
  const r = await q('INSERT INTO users(phone,name,salt,hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING phone',
    [ph, nm, salt, hashPw(String(password), salt)]);
  if (!r.length) return res.status(409).json({ error: 'This number is already registered. Log in instead.' });
  res.json({ token: sign(ph), user: { phone: ph, name: nm } });
}));

app.post('/api/login', h(async (req, res) => {
  const { phone, password } = req.body || {};
  const [u] = await q('SELECT * FROM users WHERE phone=$1', [String(phone || '').replace(/\D/g, '')]);
  const bad = () => res.status(400).json({ error: 'Wrong phone number or password' });
  if (!u || !password) return bad();
  const a = Buffer.from(hashPw(String(password), u.salt)), b = Buffer.from(u.hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return bad();
  res.json({ token: sign(u.phone), user: { phone: u.phone, name: u.name } });
}));

async function chatList(me, myShow) {
  const rows = await q(`
    WITH x AS (SELECT ${MSG}, CASE WHEN sender=$1 THEN recipient ELSE sender END AS other
               FROM messages WHERE sender=$1 OR recipient=$1)
    SELECT DISTINCT ON (x.other) x.other, x.id, x."from", x."to", x."text", x.ts, x.status, x.kind, u.name, u.last_seen::float8 AS ls, u.show_status AS ss,
           (SELECT count(*)::int FROM messages WHERE sender=x.other AND recipient=$1 AND status<>'read') AS unread
    FROM x JOIN users u ON u.phone=x.other ORDER BY x.other, x.ts DESC`, [me]);
  return rows.map(r => ({
    user: { phone: r.other, name: r.name }, unread: r.unread, online: !!(myShow && r.ss && Date.now() - r.ls < 12000),
    last: { id: r.id, from: r.from, to: r.to, text: r.text, ts: r.ts, status: r.status, kind: r.kind }
  })).sort((a, b) => b.last.ts - a.last.ts);
}

app.get('/api/sync', auth, h(async (req, res) => {
  const me = req.me, peer = String(req.query.peer || '').replace(/\D/g, '');
  if (!req.query.bg) await q('UPDATE users SET last_seen=$2 WHERE phone=$1', [me, Date.now()]);
  const [mine] = await q('SELECT show_status FROM users WHERE phone=$1', [me]);
  const myShow = mine.show_status;
  await q(`UPDATE messages SET status='delivered' WHERE recipient=$1 AND status='sent'`, [me]);
  if (peer) await q(`UPDATE messages SET status='read' WHERE recipient=$1 AND sender=$2 AND status<>'read'`, [me, peer]);
  const chats = await chatList(me, myShow);
  let msgs = [], online = false, name = '', iBlocked = false;
  if (peer) {
    msgs = await q(`SELECT ${MSG} FROM (SELECT * FROM messages WHERE (sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1) ORDER BY ts DESC LIMIT 200) m ORDER BY ts`, [me, peer]);
    const [u] = await q('SELECT name, last_seen, show_status FROM users WHERE phone=$1', [peer]);
    if (u) { online = !!(myShow && u.show_status && Date.now() - Number(u.last_seen) < 12000); name = u.name; }
    iBlocked = (await q('SELECT 1 FROM blocks WHERE blocker=$1 AND blocked=$2', [me, peer])).length > 0;
  }
  res.json({ chats, msgs, online, name, iBlocked, showStatus: myShow });
}));

app.post('/api/send', auth, h(async (req, res) => {
  const b = req.body || {}, to = String(b.to || ''), text = String(b.text || '').trim().slice(0, 4000);
  if (!text || to === req.me || !(await userExists(to))) return res.status(400).json({ error: 'Message not sent' });
  const bl = await q('SELECT blocker FROM blocks WHERE (blocker=$1 AND blocked=$2) OR (blocker=$2 AND blocked=$1)', [req.me, to]);
  if (bl.length) return res.status(403).json({ error: bl.some(x => x.blocker === req.me) ? 'You blocked this user. Unblock to send messages.' : 'This message could not be sent.' });
  const m = { id: crypto.randomUUID(), from: req.me, to, text, ts: Date.now(), status: 'sent', kind: 'text' };
  await q('INSERT INTO messages(id,sender,recipient,body,ts,status) VALUES($1,$2,$3,$4,$5,$6)', [m.id, req.me, to, text, m.ts, 'sent']);
  res.json(m);
}));

app.get('/api/users', auth, h(async (req, res) => {
  const t = String(req.query.q || '').toLowerCase().trim().replace(/[%_\\]/g, '');
  if (!t) return res.json([]);
  res.json(await q('SELECT phone, name FROM users WHERE phone<>$1 AND (phone LIKE $2 OR lower(name) LIKE $2) LIMIT 20', [req.me, '%' + t + '%']));
}));

// ---- Photos and voice messages (stored in the database, served only to the two people in the chat) ----
const MEDIA_TYPES = { 'image/jpeg': 'image', 'audio/mp4': 'audio', 'audio/webm': 'audio', 'audio/ogg': 'audio', 'audio/mpeg': 'audio', 'audio/aac': 'audio', 'audio/x-m4a': 'audio' };
app.post('/api/sendmedia', auth, express.raw({ type: () => true, limit: '3mb' }), h(async (req, res) => {
  const to = String(req.query.to || '');
  const base = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const kind = MEDIA_TYPES[base], data = req.body;
  if (!kind || !Buffer.isBuffer(data) || !data.length) return res.status(400).json({ error: 'Unsupported file' });
  if (!to || to === req.me || !(await userExists(to))) return res.status(400).json({ error: 'Message not sent' });
  const bl = await q('SELECT blocker FROM blocks WHERE (blocker=$1 AND blocked=$2) OR (blocker=$2 AND blocked=$1)', [req.me, to]);
  if (bl.length) return res.status(403).json({ error: bl.some(x => x.blocker === req.me) ? 'You blocked this user. Unblock to send messages.' : 'This message could not be sent.' });
  const dur = Math.min(Math.max(parseInt(req.query.dur) || 0, 0), 600);
  const mid = crypto.randomUUID(), id = crypto.randomUUID(), ts = Date.now();
  await q('INSERT INTO media(id,sender,recipient,mime,data,created) VALUES($1,$2,$3,$4,$5,$6)', [mid, req.me, to, base, data, ts]);
  await q(`INSERT INTO messages(id,sender,recipient,body,ts,status,kind,media_id,dur) VALUES($1,$2,$3,'',$4,'sent',$5,$6,$7)`, [id, req.me, to, ts, kind, mid, dur]);
  res.json({ id, from: req.me, to, text: '', ts, status: 'sent', kind, media: mid, dur });
}));

app.get('/api/media/:id', auth, h(async (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).end();
  const [m] = await q('SELECT mime, data FROM media WHERE id=$1 AND (sender=$2 OR recipient=$2)', [id, req.me]);
  if (!m) return res.status(404).end();
  res.set({ 'Content-Type': m.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.send(m.data);
}));

app.post('/api/status', auth, h(async (req, res) => {
  await q('UPDATE users SET show_status=$2 WHERE phone=$1', [req.me, !!(req.body && req.body.show)]);
  res.json({ ok: true });
}));

app.post('/api/block', auth, h(async (req, res) => {
  const b = req.body || {}, p = String(b.phone || '');
  if (!p || p === req.me || !(await userExists(p))) return res.status(400).json({ error: 'Invalid user' });
  if (b.block) await q('INSERT INTO blocks(blocker,blocked) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.me, p]);
  else await q('DELETE FROM blocks WHERE blocker=$1 AND blocked=$2', [req.me, p]);
  res.json({ ok: true });
}));

// Only messages you received can be reported. The admin sees the reported message plus a few before it.
app.post('/api/report', auth, h(async (req, res) => {
  const b = req.body || {}, id = String(b.messageId || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid message' });
  const [m] = await q(`SELECT ${MSG} FROM messages WHERE id=$1 AND recipient=$2`, [id, req.me]);
  if (!m) return res.status(404).json({ error: 'Message not found' });
  const ctx = await q(`SELECT ${MSG} FROM messages WHERE ((sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1)) AND ts<=$3 ORDER BY ts DESC LIMIT 6`, [req.me, m.from, m.ts]);
  ctx.reverse();
  await q('INSERT INTO reports(reporter,reported,reason,context,created,media,media_kind) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [req.me, m.from, String(b.reason || '').slice(0, 200), JSON.stringify(ctx.map(x => ({ from: x.from, text: x.kind === 'text' ? x.text : '[' + x.kind + ']', ts: x.ts }))), Date.now(), m.kind === 'text' ? null : m.media, m.kind === 'text' ? null : m.kind]);
  if (b.block) await q('INSERT INTO blocks(blocker,blocked) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.me, m.from]);
  res.json({ ok: true });
}));

// Admin: counts and reported messages only. Disabled unless the ADMIN_KEY environment variable is set.
const adminOK = (req, res, next) => {
  const k = Buffer.from(process.env.ADMIN_KEY || ''), g = Buffer.from(String(req.headers['x-admin-key'] || ''));
  if (!k.length || k.length !== g.length || !crypto.timingSafeEqual(k, g)) return res.status(404).json({ error: 'Not found' });
  next();
};
app.get('/api/admin/reports', adminOK, h(async (req, res) => {
  const [stats] = await q(`SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM messages) AS messages, (SELECT count(*)::int FROM reports) AS reports`);
  const reports = await q('SELECT id, reporter, reported, reason, context, created::float8 AS created, media, media_kind FROM reports ORDER BY id DESC LIMIT 100');
  res.json({ stats, reports });
}));

// Admin can open only media that someone has reported.
app.get('/api/admin/media/:id', adminOK, h(async (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).end();
  const [m] = await q('SELECT m.mime, m.data FROM media m WHERE m.id=$1 AND EXISTS (SELECT 1 FROM reports r WHERE r.media=m.id)', [id]);
  if (!m) return res.status(404).end();
  res.set({ 'Content-Type': m.mime, 'X-Content-Type-Options': 'nosniff' });
  res.send(m.data);
}));

module.exports = app;
