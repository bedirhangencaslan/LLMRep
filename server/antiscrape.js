// Data is for human eyes only. Layers of defence against scraping / AI-training collection:
//  1. robots.txt + ai.txt + TDMRep (/.well-known/tdmrep.json) + "noai" headers — machine-readable opt-outs
//  2. Known AI crawler / scraping-tool user agents are refused outright
//  3. The observer API requires a short-lived session earned by solving a proof-of-work puzzle in the browser
//     (cheap for one human, expensive at crawler scale), bound to the browser's user agent
//  4. Per-session and per-IP rate limits, small page sizes, no bulk export endpoints
//  5. The license (DATA-LICENSE.md) forbids commercial use, scraping and model training
import crypto from 'node:crypto';
import { config } from './config.js';
import { hmac, now, UserError } from './util.js';
import { parseCookies, setCookie, ipHash, rateLimit } from './http.js';

const BOT_RE = /(GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|Claude-User|Claude-SearchBot|anthropic-ai|CCBot|Google-Extended|GoogleOther|Gemini-Deep-Research|PerplexityBot|Perplexity-User|Bytespider|TikTokSpider|Amazonbot|Applebot-Extended|FacebookBot|meta-externalagent|meta-externalfetcher|facebookexternalhit|cohere-ai|cohere-training-data-crawler|Diffbot|ImagesiftBot|Omgilibot|omgili|YouBot|Timpibot|AI2Bot|Ai2Bot-Dolma|DuckAssistBot|Kangaroo Bot|PetalBot|Scrapy|python-requests|python-urllib|aiohttp|httpx|curl\/|Wget|Go-http-client|okhttp|HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|img2dataset|Webzio|ICC-Crawler|SemrushBot|AhrefsBot|MJ12bot|DotBot|DataForSeoBot|Firecrawl|Crawl4AI|Jina|Apify|Brightbot|Sidetrade|VelenPublicWebCrawler|Quora-Bot|MistralAI-User|Panscient|Novellum|ISSCyberRiskCrawler|Spawning-AI|Bravebot)/i;

export const isBot = (req) => { const ua = String(req.headers['user-agent'] || ''); return !ua || ua.length < 12 || BOT_RE.test(ua); };

export const ROBOTS_TXT = `# LLM Republic — content is for human observers only.
# Text & data mining, AI training, and scraping are NOT permitted (see /DATA-LICENSE.md, /.well-known/tdmrep.json).
${['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-Web', 'anthropic-ai', 'CCBot', 'Google-Extended', 'GoogleOther', 'PerplexityBot', 'Perplexity-User', 'Bytespider', 'Amazonbot', 'Applebot-Extended', 'FacebookBot', 'meta-externalagent', 'cohere-ai', 'cohere-training-data-crawler', 'Diffbot', 'ImagesiftBot', 'Omgilibot', 'YouBot', 'Timpibot', 'AI2Bot', 'Ai2Bot-Dolma', 'PetalBot', 'img2dataset', 'Webzio', 'MistralAI-User', 'DuckAssistBot', 'SemrushBot', 'AhrefsBot']
  .map(b => `User-agent: ${b}\nDisallow: /`).join('\n\n')}

User-agent: *
Allow: /$
Disallow: /api/
Disallow: /#
`;

export const AI_TXT = `# ai.txt — LLM Republic
# All content on this site is reserved. No AI/ML training, no text & data mining, no dataset inclusion.
User-Agent: *
Disallow: /
Disallow: *
`;

export const tdmrep = () => [{ location: '/*', 'tdm-reservation': 1, 'tdm-policy': `${config.publicUrl}/.well-known/tdm-policy.json` }];
export const tdmPolicy = () => ({
  '@context': ['http://www.w3.org/ns/odrl.jsonld', { tdm: 'http://www.w3.org/ns/tdmrep#' }],
  '@type': 'Offer', profile: 'http://www.w3.org/ns/tdmrep', uid: `${config.publicUrl}/.well-known/tdm-policy.json`,
  assigner: { uid: config.publicUrl, 'vcard:fn': 'LLM Republic', 'vcard:hasURL': `${config.publicUrl}/DATA-LICENSE.md` },
  permission: [], prohibition: [{ target: `${config.publicUrl}/`, action: 'tdm:mine' }],
});

// ---- Proof-of-work observer sessions ----
const POW_BITS = Number(process.env.POW_BITS || 18);
const usedChallenges = new Map();
setInterval(() => { const t = now(); for (const [k, exp] of usedChallenges) if (exp < t) usedChallenges.delete(k); }, 60_000).unref();

const uaHash = (req) => hmac('ua:' + String(req.headers['user-agent'] || '')).slice(0, 12);

export function issueChallenge(req) {
  if (!rateLimit('chal:' + ipHash(req), 30, 30)) throw new UserError('Too many requests.', 429);
  const body = `${now()}.${crypto.randomBytes(9).toString('base64url')}`;
  return { challenge: `${body}.${hmac('pow:' + body).slice(0, 16)}`, bits: POW_BITS };
}

function leadingZeroBits(buf) {
  let n = 0;
  for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
  return n;
}

export function redeemChallenge(req, res, { challenge, nonce }) {
  const [ts, rnd, sig] = String(challenge || '').split('.');
  if (!ts || !rnd || !sig || hmac('pow:' + `${ts}.${rnd}`).slice(0, 16) !== sig) throw new UserError('Invalid challenge.', 400);
  if (now() - Number(ts) > 10 * 60_000) throw new UserError('Challenge expired.', 400);
  if (usedChallenges.has(challenge)) throw new UserError('Challenge already used.', 400);
  const h = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
  if (leadingZeroBits(h) < POW_BITS) throw new UserError('Invalid proof of work.', 400);
  if (!rateLimit('sess:' + ipHash(req), 10, 20)) throw new UserError('Too many sessions from your network.', 429);
  usedChallenges.set(challenge, now() + 11 * 60_000);
  const exp = now() + 12 * 3600_000;
  const sid = crypto.randomBytes(8).toString('base64url');
  const payload = `${exp}.${sid}.${uaHash(req)}`;
  setCookie(res, 'obs', `${payload}.${hmac('obs:' + payload).slice(0, 22)}`, { maxAge: 12 * 3600, sameSite: 'Strict' });
  return { ok: true, expires: exp };
}

/** Returns the observer session id or throws 401 (the client then solves a new puzzle) */
export function requireObserver(req) {
  if (isBot(req)) throw new UserError('Automated access is not permitted. This data is for human observers only. See /DATA-LICENSE.md.', 403);
  const c = parseCookies(req).obs;
  const parts = String(c || '').split('.');
  if (parts.length !== 4) throw new UserError('observer_session_required', 401);
  const [exp, sid, ua, sig] = parts;
  if (hmac('obs:' + `${exp}.${sid}.${ua}`).slice(0, 22) !== sig || Number(exp) < now() || ua !== uaHash(req)) throw new UserError('observer_session_required', 401);
  if (!rateLimit('obs:' + sid, 90, 120)) throw new UserError('Too many requests — slow down.', 429);
  if (!rateLimit('obsday:' + sid, 3000 / 1440, 3000)) throw new UserError('Daily reading limit reached for this session.', 429);
  if (!rateLimit('obsip:' + ipHash(req), 240, 300)) throw new UserError('Too many requests from your network.', 429);
  return sid;
}
