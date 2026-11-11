'use strict';
/*
 * ============================================================
 *  TANK ROBOT — Railway relay server
 *
 *     Brauzer (UI)  <--WSS-->  BU SERVER  <--WSS-->  ESP32 robot
 *
 *  - Robot özü serverə qoşulur (çıxan bağlantı), buna görə robotun
 *    olduğu şəbəkədə port açmaq / router tənzimləmək LAZIM DEYİL.
 *  - Brauzer şifrə ilə daxil olur, əmrlər robota ötürülür, cavablar
 *    geri qaytarılır.
 *
 *  Mühit dəyişənləri (Railway → Variables):
 *    ROBOT_KEY    robotun gizli açarı (min. 12 simvol) — ESP32 kodundakı ilə eyni
 *    UI_PASSWORD  veb səhifəyə giriş şifrəsi (min. 6 simvol)
 *    PORT         Railway özü verir
 * ============================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------- config
const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROBOT_KEY = (process.env.ROBOT_KEY || '').trim();
const UI_PASSWORD = (process.env.UI_PASSWORD || '').trim();
const CONFIGURED = ROBOT_KEY.length >= 12 && UI_PASSWORD.length >= 6;

// UI-nın robota göndərə biləcəyi yollar (robot tərəfdə də ayrıca yoxlanılır)
const ROUTES = new Set(['/tank', '/mode', '/servo', '/status', '/settings', '/set', '/reset']);

const REQ_TIMEOUT_MS = 5000;        // robot bu müddətdə cavab verməsə → 504
const MAX_PENDING = 64;             // eyni anda gözləyən sorğu limiti
const MAX_UI_CLIENTS = 8;
const HEARTBEAT_MS = 15000;         // ping intervalı (ölü bağlantıları təmizləyir)
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_FAILS = 5;           // 10 dəqiqədə 5 səhv şifrə → müvəqqəti blok
const RATE_PER_SEC = 40;            // bir UI-dan saniyədə maks. sorğu
const RATE_BURST = 60;

if (!CONFIGURED) {
  console.error('!!! ROBOT_KEY (min 12) və UI_PASSWORD (min 6) dəyişənləri təyin olunmayıb.');
  console.error('!!! Railway → servis → Variables bölməsində əlavə et. Server hələlik girişləri bağlı saxlayır.');
}

// ---------------------------------------------------------------- helpers
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// Railway proxy arxasındayıq: sağdakı XFF elementi proxy-nin gördüyü real ünvandır.
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const parts = String(xf).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || '?';
}

function makeLimiter() {
  const m = new Map();
  return {
    wait(ip) {                                   // blokdursa neçə saniyə qalıb
      const f = m.get(ip);
      if (!f) return 0;
      const age = Date.now() - f.first;
      if (age > AUTH_WINDOW_MS) { m.delete(ip); return 0; }
      return f.n >= AUTH_MAX_FAILS ? Math.ceil((AUTH_WINDOW_MS - age) / 1000) : 0;
    },
    fail(ip) {
      const f = m.get(ip);
      if (!f || Date.now() - f.first > AUTH_WINDOW_MS) m.set(ip, { n: 1, first: Date.now() });
      else f.n++;
    },
    ok(ip) { m.delete(ip); },
    sweep() {
      const now = Date.now();
      for (const [ip, f] of m) if (now - f.first > AUTH_WINDOW_MS) m.delete(ip);
    },
  };
}
const uiLimiter = makeLimiter();
const robotLimiter = makeLimiter();
setInterval(() => { uiLimiter.sweep(); robotLimiter.sweep(); }, 60000).unref();

function sendJ(ws, obj) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (_) { /* bağlantı bağlanıb */ }
}

// ---------------------------------------------------------------- HTTP
let indexHtml = null;
try {
  indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
} catch (e) {
  console.error('public/index.html oxunmadı:', e.message);
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:; " +
    "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const NOT_CONFIGURED_HTML =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<body style="font-family:sans-serif;background:#060a0f;color:#c8e8f0;padding:24px">' +
  '<h2>Server hələ tənzimlənməyib</h2>' +
  '<p>Railway → servis → <b>Variables</b> bölməsində <code>ROBOT_KEY</code> (min. 12 simvol) və ' +
  '<code>UI_PASSWORD</code> (min. 6 simvol) əlavə et. Railway avtomatik yenidən deploy edəcək.</p></body>';

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...SEC_HEADERS });
    return res.end();
  }

  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SEC_HEADERS });
    return res.end(JSON.stringify({ ok: true, configured: CONFIGURED }));
  }

  if (url === '/' || url === '/index.html') {
    if (!CONFIGURED) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS });
      return res.end(NOT_CONFIGURED_HTML);
    }
    if (!indexHtml) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC_HEADERS });
      return res.end('index.html tapilmadi');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS });
    return res.end(req.method === 'HEAD' ? undefined : indexHtml);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC_HEADERS });
  res.end('Not found');
});

// ---------------------------------------------------------------- WebSocket
const wssUI = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const wssRobot = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

let robot = null;                 // { ws, ip, since, fw }
const uiClients = new Set();      // { ws, ip, authed, tokens, last }
const pending = new Map();        // gid -> { c, id, timer }
let gidCounter = 0;

function rejectUpgrade(socket, code, text) {
  try {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch (_) { /* ignore */ }
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  const url = (req.url || '').split('?')[0];
  const ip = clientIp(req);

  if (!CONFIGURED) return rejectUpgrade(socket, 503, 'Service Unavailable');

  if (url === '/ws/robot') {
    if (robotLimiter.wait(ip)) return rejectUpgrade(socket, 429, 'Too Many Requests');
    const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
    if (!m || !safeEqual(m[1].trim(), ROBOT_KEY)) {
      robotLimiter.fail(ip);
      console.log(`[robot] RED: yanlış açar (${ip})`);
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    robotLimiter.ok(ip);
    return wssRobot.handleUpgrade(req, socket, head, (ws) => onRobot(ws, ip));
  }

  if (url === '/ws/ui') {
    if (uiClients.size >= MAX_UI_CLIENTS) return rejectUpgrade(socket, 503, 'Service Unavailable');
    return wssUI.handleUpgrade(req, socket, head, (ws) => onUI(ws, ip));
  }

  return rejectUpgrade(socket, 404, 'Not Found');
});

// ----- robot
function robotMsg() {
  return { t: 'robot', on: !!robot, fw: robot ? robot.fw : null };
}
function broadcastRobot() {
  const m = robotMsg();
  for (const c of uiClients) if (c.authed) sendJ(c.ws, m);
}
function failPending(code, text, only) {
  for (const [gid, p] of pending) {
    if (only && p.c !== only) continue;
    clearTimeout(p.timer);
    pending.delete(gid);
    if (!only) sendJ(p.c.ws, { t: 'res', id: p.id, c: code, d: text });
  }
}

function onRobot(ws, ip) {
  if (robot) {                                     // köhnə bağlantını əvəz et
    try { robot.ws.close(4000, 'replaced'); } catch (_) { /* ignore */ }
    failPending(503, 'robot reconnected');
  }
  const me = { ws, ip, since: Date.now(), fw: null };
  robot = me;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    ws.isAlive = true;
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'res') {
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      sendJ(p.c.ws, { t: 'res', id: p.id, c: m.c, d: m.d });
    } else if (m.t === 'hello') {
      me.fw = typeof m.fw === 'string' ? m.fw.slice(0, 20) : null;
      broadcastRobot();
    }
  });
  ws.on('close', () => {
    if (robot === me) {
      robot = null;
      failPending(503, 'robot offline');
      broadcastRobot();
    }
    console.log(`[robot] qopdu (${ip})`);
  });
  ws.on('error', () => {});

  console.log(`[robot] qoşuldu (${ip})`);
  broadcastRobot();
}

// ----- UI
function onUI(ws, ip) {
  const c = { ws, ip, authed: false, tokens: RATE_BURST, last: Date.now() };
  uiClients.add(c);
  ws.isAlive = true;

  const authTimer = setTimeout(() => { if (!c.authed) ws.close(4001, 'auth timeout'); }, 10000);

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    ws.isAlive = true;
    if (isBinary) return;
    handleUI(c, data.toString());
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    uiClients.delete(c);
    failPending(0, '', c);                         // bu UI-ın gözləyən sorğularını sil
  });
  ws.on('error', () => {});
}

function takeToken(c) {
  const now = Date.now();
  c.tokens = Math.min(RATE_BURST, c.tokens + ((now - c.last) / 1000) * RATE_PER_SEC);
  c.last = now;
  if (c.tokens < 1) return false;
  c.tokens -= 1;
  return true;
}

function handleUI(c, text) {
  let m;
  try { m = JSON.parse(text); } catch (_) { return; }
  if (!m || typeof m !== 'object') return;

  if (m.t === 'auth') {
    if (c.authed) return;
    const wait = uiLimiter.wait(c.ip);
    if (wait) return sendJ(c.ws, { t: 'auth', ok: false, msg: `Çox səhv cəhd. ${wait} san sonra yenidən yoxla.` });
    if (typeof m.pw === 'string' && m.pw.length <= 200 && safeEqual(m.pw, UI_PASSWORD)) {
      uiLimiter.ok(c.ip);
      c.authed = true;
      sendJ(c.ws, { t: 'auth', ok: true });
      sendJ(c.ws, robotMsg());
      console.log(`[ui] giriş (${c.ip})`);
    } else {
      uiLimiter.fail(c.ip);
      console.log(`[ui] RED: yanlış şifrə (${c.ip})`);
      sendJ(c.ws, { t: 'auth', ok: false, msg: 'Şifrə yanlışdır' });
    }
    return;
  }

  if (!c.authed) return;
  if (m.t === 'req') relayReq(c, m);
}

function relayReq(c, m) {
  if (!Number.isSafeInteger(m.id)) return;
  const id = m.id;
  const reply = (code, d) => sendJ(c.ws, { t: 'res', id, c: code, d });

  const p = typeof m.p === 'string' ? m.p : '';
  if (!ROUTES.has(p)) return reply(404, 'unknown');
  if (!robot) return reply(503, 'robot offline');
  if (!takeToken(c)) return reply(429, 'too many requests');
  if (pending.size >= MAX_PENDING) return reply(429, 'busy');

  let qs = '';
  if (m.q !== undefined && m.q !== null) {
    if (typeof m.q !== 'object' || Array.isArray(m.q)) return reply(400, 'bad query');
    const ent = Object.entries(m.q);
    if (ent.length > 6) return reply(400, 'bad query');
    const parts = [];
    for (const [k, v] of ent) {
      const sv = String(v);
      if (!/^[A-Za-z0-9_]{1,16}$/.test(k) || !/^[A-Za-z0-9._-]{0,24}$/.test(sv)) return reply(400, 'bad query');
      parts.push(`${k}=${sv}`);
    }
    qs = parts.join('&');
  }

  gidCounter = (gidCounter % 2000000000) + 1;
  const gid = gidCounter;
  const timer = setTimeout(() => {
    if (pending.delete(gid)) reply(504, 'timeout');
  }, REQ_TIMEOUT_MS);
  pending.set(gid, { c, id, timer });

  try {
    robot.ws.send(`R|${gid}|${p}${qs ? '?' + qs : ''}`);
  } catch (_) {
    clearTimeout(timer);
    pending.delete(gid);
    reply(503, 'robot offline');
  }
}

// ---------------------------------------------------------------- heartbeat / shutdown
const hb = setInterval(() => {
  for (const w of [...wssUI.clients, ...wssRobot.clients]) {
    if (w.isAlive === false) { w.terminate(); continue; }
    w.isAlive = false;
    try { w.ping(); } catch (_) { /* ignore */ }
  }
}, HEARTBEAT_MS);

function shutdown(sig) {
  console.log(`${sig}: söndürülür…`);
  clearInterval(hb);
  for (const w of [...wssUI.clients, ...wssRobot.clients]) {
    try { w.close(1001, 'server restart'); } catch (_) { /* ignore */ }
  }
  server.close();
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tank server hazırdır: port ${PORT} (konfiqurasiya: ${CONFIGURED ? 'OK' : 'EKSİKDİR'})`);
});
