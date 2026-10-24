// Minimal camera viewer: login + RTSP -> HLS via ffmpeg. No npm dependencies.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---- Config (override with environment variables) ----
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';          // use 127.0.0.1 behind a reverse proxy
const TLS_CERT = process.env.TLS_CERT;               // path to cert (PEM) -> serve HTTPS directly
const TLS_KEY = process.env.TLS_KEY;                 // path to private key (PEM)
const HTTP_REDIRECT_PORT = Number(process.env.HTTP_REDIRECT_PORT || 0); // optional http -> https redirect
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // set when behind a reverse proxy
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASS = process.env.APP_PASS;
const CAM_HOST = process.env.CAM_HOST;   // e.g. 192.168.0.10:554
const CAM_USER = process.env.CAM_USER || '';
const CAM_PWD = process.env.CAM_PWD || '';
const CHANNELS = [1, 2, 3, 4];
const IDLE_STOP_MS = 60 * 1000;            // stop ffmpeg if nobody watches for 60s
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h login
const HLS_DIR = path.join(__dirname, 'hls');
const PUBLIC_DIR = path.join(__dirname, 'public');

const rtspUrl = (ch) => `rtsp://${CAM_HOST}/ch${ch}.sdp?user=${CAM_USER}&pwd=${CAM_PWD}`;

// ---- Sessions ----
const sessions = new Map(); // token -> expiry
const failedLogins = new Map(); // ip -> { count, until }

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req).sid;
  const exp = token && sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  return TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https';
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',').pop().trim();
  return req.socket.remoteAddress;
}

// ---- ffmpeg stream management ----
const streams = new Map(); // ch -> { proc, lastAccess }

function startStream(ch) {
  const dir = path.join(HLS_DIR, `ch${ch}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl(ch),
    '-c:v', 'copy', '-an',          // no re-encoding: cheap on the Pi (camera must send H.264)
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '4',
    '-hls_flags', 'delete_segments+omit_endlist',
    path.join(dir, 'index.m3u8'),
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => console.error(`[ch${ch}] ${d.toString().trim()}`));
  proc.on('exit', (code) => {
    console.log(`[ch${ch}] ffmpeg exited (${code})`);
    if (streams.get(ch)?.proc === proc) streams.delete(ch);
  });
  streams.set(ch, { proc, lastAccess: Date.now() });
  console.log(`[ch${ch}] ffmpeg started`);
}

function touchStream(ch) {
  const s = streams.get(ch);
  if (s) s.lastAccess = Date.now();
  else startStream(ch);
}

setInterval(() => {
  for (const [ch, s] of streams) {
    if (Date.now() - s.lastAccess > IDLE_STOP_MS) {
      console.log(`[ch${ch}] idle, stopping`);
      s.proc.kill('SIGTERM');
      streams.delete(ch);
    }
  }
  for (const [t, exp] of sessions) if (exp < Date.now()) sessions.delete(t);
}, 10 * 1000);

// ---- HTTP helpers ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

function sendFile(res, file, extraHeaders = {}) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...extraHeaders });
    res.end(data);
  });
}

function redirect(res, to, headers = {}) {
  res.writeHead(302, { Location: to, ...headers });
  res.end();
}

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
  req.on('end', () => cb(new URLSearchParams(body)));
}

// ---- Routes ----
function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = clientIp(req);
  const secure = isHttps(req);
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  if (p === '/login' && req.method === 'GET') {
    return sendFile(res, path.join(PUBLIC_DIR, 'login.html'));
  }

  if (p === '/login' && req.method === 'POST') {
    const f = failedLogins.get(ip);
    if (f && f.until > Date.now()) return redirect(res, '/login?e=locked');
    return readBody(req, (form) => {
      const ok = safeEqual(form.get('user') || '', APP_USER) & safeEqual(form.get('pass') || '', APP_PASS);
      if (!ok) {
        const cur = failedLogins.get(ip) || { count: 0, until: 0 };
        cur.count++;
        if (cur.count >= 5) { cur.until = Date.now() + 15 * 60 * 1000; cur.count = 0; }
        failedLogins.set(ip, cur);
        return redirect(res, '/login?e=1');
      }
      failedLogins.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      redirect(res, '/', {
        'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`,
      });
    });
  }

  if (p === '/logout') {
    sessions.delete(parseCookies(req).sid);
    return redirect(res, '/login', { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  }

  // Everything below requires login
  if (!isAuthed(req)) {
    if (p.startsWith('/hls/')) { res.writeHead(401); return res.end(); }
    return redirect(res, '/login');
  }

  if (p === '/') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));

  // /hls/ch1/index.m3u8 or /hls/ch1/index123.ts
  const m = p.match(/^\/hls\/ch([1-4])\/(index\d*\.(?:m3u8|ts))$/);
  if (m) {
    const ch = Number(m[1]);
    touchStream(ch);
    const file = path.join(HLS_DIR, `ch${ch}`, m[2]);
    if (m[2].endsWith('.m3u8') && !fs.existsSync(file)) {
      // ffmpeg still warming up; client retries
      res.writeHead(503, { 'Retry-After': '1' });
      return res.end();
    }
    return sendFile(res, file, { 'Cache-Control': 'no-cache' });
  }

  res.writeHead(404);
  res.end('Not found');
}

const server = TLS_CERT && TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handler)
  : http.createServer(handler);

if (TLS_CERT && TLS_KEY && HTTP_REDIRECT_PORT) {
  http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    redirect(res, `https://${host}${PORT === 443 ? '' : ':' + PORT}${req.url}`);
  }).listen(HTTP_REDIRECT_PORT, HOST);
}

function shutdown() {
  for (const s of streams.values()) s.proc.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (!APP_PASS || !CAM_HOST) {
  console.error('APP_PASS and CAM_HOST must be set. See README.md.');
  process.exit(1);
}
if (!TLS_CERT && !TRUST_PROXY) console.warn('WARNING: running plain HTTP. Use a reverse proxy (TRUST_PROXY=1) or TLS_CERT/TLS_KEY for HTTPS.');
server.listen(PORT, HOST, () => console.log(`Camera viewer on ${TLS_CERT ? 'https' : 'http'}://${HOST}:${PORT}`));
