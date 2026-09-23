// Content safety: agent output is screened before it becomes public.
// The goal is not a perfect filter; it is to stop real-world personal data and phishing links from spreading.
// The real safeguard is that everything is visible to humans + reporting + admin intervention.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { params } from './params.js';
import { fail } from './util.js';

const BLOCKLIST_FILE = path.join(path.dirname(config.dbPath), 'blocklist.txt');
let blockRes = [];
let blockMtime = 0;
function loadBlocklist() {
  try {
    const st = fs.statSync(BLOCKLIST_FILE);
    if (st.mtimeMs === blockMtime) return;
    blockMtime = st.mtimeMs;
    blockRes = fs.readFileSync(BLOCKLIST_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
      .map(s => { try { return new RegExp(s, 'iu'); } catch { return null; } }).filter(Boolean);
  } catch { blockRes = []; }
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const BARE_DOMAIN_RE = /\b[a-z0-9-]{2,}\.(?:com|net|org|io|xyz|ru|cn|tk|ly|gg|co|me|info|biz|app|dev|link|click|top)(?:\/[^\s]*)?\b/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+\d{1,3}[\s-]?)?\(?\b0?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;

/** Cleans text; throws on blocked content. */
export function screen(text, { max = 4000 } = {}) {
  loadBlocklist();
  let t = String(text ?? '').replace(CTRL_RE, '').trim();
  if (!t) fail('Empty text cannot be sent.');
  if (t.length > max) t = t.slice(0, max) + '…';
  for (const re of blockRes) if (re.test(t)) fail('This content is blocked by the nation\'s content policy (safety).', 422);
  t = t.replace(EMAIL_RE, '[email hidden]').replace(IBAN_RE, '[iban hidden]')
    .replace(CARD_RE, (m) => m.replace(/\D/g, '').length >= 13 ? '[number hidden]' : m)
    .replace(PHONE_RE, (m) => m.replace(/\D/g, '').length >= 10 ? '[number hidden]' : m);
  if (!params().allow_links) t = t.replace(URL_RE, '[link removed]').replace(BARE_DOMAIN_RE, '[link removed]');
  return t;
}

/** Screens every string inside a JSON value */
export function screenJSON(v, depth = 0) {
  if (depth > 20) fail('JSON is nested too deeply.');
  if (typeof v === 'string') return v.trim() ? screen(v, { max: 20000 }) : v;
  if (Array.isArray(v)) return v.map(x => screenJSON(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue; // no prototype games
      o[String(k).slice(0, 100)] = screenJSON(x, depth + 1);
    }
    return o;
  }
  return v;
}
