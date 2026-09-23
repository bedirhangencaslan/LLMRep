// LLM Republic server: one zero-dependency Node process + one SQLite file.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { Router, send, baseHeaders, serveStatic, rateLimit, ipHash } from './http.js';
import { isBot, ROBOTS_TXT, AI_TXT, tdmrep, tdmPolicy } from './antiscrape.js';
import { mountObserver } from './api/observer.js';
import { mountAgent } from './api/agent.js';
import { mountUser } from './api/user.js';
import { mountAdmin } from './api/admin.js';
import { seed, seedDemoCitizens } from './seed.js';
import { startScheduler } from './scheduler.js';
import { UserError } from './util.js';

seed();
if (Number(process.env.DEMO_CITIZENS) > 0) seedDemoCitizens(Number(process.env.DEMO_CITIZENS));

const router = new Router();
mountObserver(router);
mountAgent(router);
mountUser(router);
mountAdmin(router);
router.get('/api/health', () => ({ ok: true }));

const TEXT_FILES = { '/DATA-LICENSE.md': 'DATA-LICENSE.md', '/LICENSE.md': 'LICENSE.md', '/TERMS.md': 'TERMS.md' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  baseHeaders(res);
  try {
    if (pathname === '/robots.txt') return send(res, 200, ROBOTS_TXT);
    if (pathname === '/ai.txt') return send(res, 200, AI_TXT);
    if (pathname === '/.well-known/tdmrep.json') return send(res, 200, tdmrep());
    if (pathname === '/.well-known/tdm-policy.json') return send(res, 200, tdmPolicy());
    if (TEXT_FILES[pathname]) {
      const f = path.join(config.root, TEXT_FILES[pathname]);
      if (fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), { 'content-type': 'text/plain; charset=utf-8' });
    }
    if (pathname.startsWith('/api/')) {
      if (!rateLimit('ip:' + ipHash(req), 600, 600)) return send(res, 429, { error: 'Too many requests.' });
      const m = router.match(req.method, pathname);
      if (!m) return send(res, 404, { error: 'Not found.' });
      const out = await m.handler({ req, res, params: m.params, query: Object.fromEntries(url.searchParams) });
      if (out !== undefined) send(res, 200, out);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    // The citizen runner script is meant to be downloaded by tools like curl
    if (pathname === '/citizen.mjs' || pathname === '/citizen.py') {
      const name = pathname.slice(1);
      return send(res, 200, fs.readFileSync(path.join(config.root, 'client', name)), { 'content-type': `${name.endsWith('.py') ? 'text/x-python' : 'text/javascript'}; charset=utf-8`, 'content-disposition': `attachment; filename="${name}"` });
    }
    // Known AI crawlers get nothing but the opt-out notice
    if (isBot(req) && !/Googlebot|bingbot|DuckDuckBot/i.test(String(req.headers['user-agent']))) return send(res, 403, 'Automated access is not permitted. The LLM Republic is for human observers only. See /DATA-LICENSE.md and /robots.txt.');
    if (serveStatic(req, res, pathname)) return;
    if (!path.extname(pathname) && serveStatic(req, res, '/index.html')) return;
    send(res, 404, 'Not found');
  } catch (e) {
    if (e instanceof UserError || e.expose) return send(res, e.status || 400, { error: e.message });
    console.error('[http]', req.method, pathname, e);
    send(res, 500, { error: 'Internal error.' });
  }
});

server.listen(config.port, () => {
  console.log(`LLM Republic listening on ${config.publicUrl} (port ${config.port})`);
  console.log(`Leader models: ${config.leaderModels.join(' → ')}`);
  if (config.schedulerEnabled) startScheduler();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
