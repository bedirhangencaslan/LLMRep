import crypto from 'node:crypto';
import { config } from './config.js';

export const now = () => Date.now();
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const today = (t = now()) => new Date(t).toISOString().slice(0, 10);

export const rid = (prefix = '', n = 10) => {
  const a = 'abcdefghijkmnopqrstuvwxyz23456789';
  const b = crypto.randomBytes(n);
  let s = '';
  for (const x of b) s += a[x % a.length];
  return prefix + s;
};
export const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (s) => crypto.createHmac('sha256', config.secret).update(s).digest('base64url');

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const parseJSON = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
/** Unicode code point count (an emoji counts as 1 character) */
export const charCount = (s) => { let n = 0; for (const _ of String(s ?? '')) n++; return n; };
export const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const slugify = (s) => String(s || '').toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

export class UserError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; this.expose = true; }
}
export const fail = (msg, status) => { throw new UserError(msg, status); };
export const must = (cond, msg, status) => { if (!cond) fail(msg, status); };

export const scryptHash = (pw) => {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32, { N: 16384 });
  return `s1$${salt.toString('base64')}$${h.toString('base64')}`;
};
export const scryptVerify = (pw, stored) => {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 32, { N: 16384 });
  const want = Buffer.from(h, 'base64');
  return want.length === calc.length && crypto.timingSafeEqual(calc, want);
};

export const iso = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
