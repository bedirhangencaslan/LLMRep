// Minimal HTTP toolkit: router, JSON bodies, cookies, client IP, rate limits, static files, security headers.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { UserError, hmac } from './util.js';

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

export function clientIp(req) {
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf);
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '0.0.0.0';
}
/** We never store raw IPs — only a keyed hash */
export const ipHash = (req) => hmac('ip:' + clientIp(req)).slice(0, 16);

export function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new UserError('Request body too large.', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function jsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new UserError('Invalid JSON body.'); }
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true, sameSite = 'Lax' } = {}) {
  const secure = config.publicUrl.startsWith('https');
  const c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=${sameSite}${httpOnly ? '; HttpOnly' : ''}${secure ? '; Secure' : ''}${maxAge != null ? `; Max-Age=${maxAge}` : ''}`;
  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', prev ? [].concat(prev, c) : c);
}

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

// ---- Rate limiting (token buckets, in memory) ----
const buckets = new Map();
/** Returns true if allowed. rate = tokens per minute, burst = bucket size */
export function rateLimit(key, rate, burst = rate) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: burst, ts: t }; buckets.set(key, b); }
  b.tokens = Math.min(burst, b.tokens + ((t - b.ts) / 60_000) * rate);
  b.ts = t;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t - b.ts > 3600_000) buckets.delete(k); }, 600_000).unref();

export function limitOrThrow(key, rate, burst) {
  if (!rateLimit(key, rate, burst)) throw new UserError('Too many requests — slow down.', 429);
}

// ---- Security & anti-AI-training headers ----
export function baseHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  // Machine-readable opt-outs from text & data mining / AI training (TDMRep, W3C CG) + robots directives
  res.setHeader('x-robots-tag', 'noai, noimageai, noarchive, nosnippet');
  res.setHeader('tdm-reservation', '1');
  res.setHeader('tdm-policy', `${config.publicUrl}/.well-known/tdm-policy.json`);
  if (config.publicUrl.startsWith('https')) res.setHeader('strict-transport-security', 'max-age=15552000');
}

// ---- Static files ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const PUBLIC_DIR = path.join(config.root, 'public');
const staticCache = new Map();

export function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return false;
  let entry = staticCache.get(file);
  if (!entry) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return false;
      entry = { body: fs.readFileSync(file), type: MIME[path.extname(file)] || 'application/octet-stream', etag: `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"` };
      if (process.env.NODE_ENV === 'production') staticCache.set(file, entry);
    } catch { return false; }
  }
  // Revalidate every time (cheap 304s) so a deploy is visible immediately
  const headers = { 'content-type': entry.type, 'cache-control': 'no-cache', etag: entry.etag };
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); res.end(); return true; }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : entry.body);
  return true;
}
