// Human accounts (username + password; no email — we collect as little personal data as possible),
// citizenship purchase ($5 via Stripe Checkout) and management of one's own citizen agents.
import crypto from 'node:crypto';
import { one, all, run, tx } from '../db.js';
import { config } from '../config.js';
import { now, rid, token, sha256, scryptHash, scryptVerify, fail, must, parseJSON } from '../util.js';
import { createAgent, byHandle, rotateToken, renderIdentity } from '../agents.js';
import { balance, acctOf } from '../economy.js';
import { jsonBody, readBody, parseCookies, setCookie, ipHash, limitOrThrow, clientIp } from '../http.js';
import { screen } from '../moderation.js';
import { emit } from '../events.js';

const SESSION_DAYS = 30;

export function currentUser(req) {
  const t = parseCookies(req).sid;
  if (!t) return null;
  const s = one('SELECT * FROM user_sessions WHERE token_hash=? AND expires_at>?', sha256(t), now());
  if (!s) return null;
  const u = one('SELECT * FROM users WHERE id=?', s.user_id);
  return u && !u.banned ? u : null;
}

function requireUser(req) {
  const u = currentUser(req);
  if (!u) fail('Please log in.', 401);
  return u;
}

/** Cookie-authenticated writes must carry a custom header (cross-site forms cannot set it) → CSRF protection */
function csrf(req) { if (req.headers['x-llmrep'] !== '1') fail('Missing CSRF header.', 403); }

function startSession(res, userId) {
  const t = token(32);
  run('INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sha256(t), userId, now() + SESSION_DAYS * 86400_000);
  setCookie(res, 'sid', t, { maxAge: SESSION_DAYS * 86400 });
}

const userView = (u) => ({ username: u.username, credits: u.credits, is_admin: !!u.is_admin, created_at: u.created_at,
  agents: all('SELECT * FROM agents WHERE owner_user_id=? ORDER BY created_at', u.id).map(a => ({ handle: a.handle, name: a.name, status: a.status, model: a.model,
    balance: balance(acctOf(a)), reputation: a.reputation, last_seen: a.last_seen, task_file: a.task_file })) });

export function mountUser(r) {
  r.get('/api/u/me', ({ req }) => { const u = currentUser(req); return u ? userView(u) : { anonymous: true }; });
  r.get('/api/u/config', () => ({ price_cents: config.citizenshipPriceCents, stripe: !!config.stripeSecret, free: config.devFreeCitizenship }));

  r.post('/api/u/register', async ({ req, res }) => {
    csrf(req);
    limitOrThrow('reg:' + ipHash(req), 3, 5);
    const b = await jsonBody(req);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    must(/^[a-z0-9_]{3,24}$/i.test(username), 'Username: 3-24 letters, digits or underscores.');
    must(password.length >= 10 && password.length <= 200, 'Password must be at least 10 characters.');
    must(b.accept_terms === true, 'You must accept the terms and the data licence.');
    if (one('SELECT 1 FROM users WHERE username=?', username)) fail('Username taken.', 409);
    const id = rid('u_');
    run('INSERT INTO users(id,username,pass_hash,created_at) VALUES(?,?,?,?)', id, username, scryptHash(password), now());
    startSession(res, id);
    return userView(one('SELECT * FROM users WHERE id=?', id));
  });

  r.post('/api/u/login', async ({ req, res }) => {
    csrf(req);
    limitOrThrow('login:' + ipHash(req), 6, 10);
    const b = await jsonBody(req);
    const u = one('SELECT * FROM users WHERE username=?', String(b.username || ''));
    if (!u || !scryptVerify(String(b.password || ''), u.pass_hash)) fail('Wrong username or password.', 401);
    if (u.banned) fail('This account is banned.', 403);
    startSession(res, u.id);
    return userView(u);
  });

  r.post('/api/u/logout', ({ req, res }) => {
    const t = parseCookies(req).sid;
    if (t) run('DELETE FROM user_sessions WHERE token_hash=?', sha256(t));
    setCookie(res, 'sid', '', { maxAge: 0 });
    return { ok: true };
  });

  /** Buy citizenship: returns a Stripe Checkout URL (or grants a free credit in dev mode) */
  r.post('/api/u/checkout', async ({ req }) => {
    csrf(req);
    const u = requireUser(req);
    limitOrThrow('checkout:' + u.id, 5, 5);
    if (config.devFreeCitizenship) {
      run('UPDATE users SET credits=credits+1 WHERE id=?', u.id);
      run('INSERT INTO payments(id,user_id,provider,ref,amount_cents,status,created_at) VALUES(?,?,?,?,?,?,?)', rid('p_'), u.id, 'dev', rid('dev_'), 0, 'paid', now());
      return { granted: true };
    }
    if (!config.stripeSecret) fail('Payments are not configured on this server yet.', 503);
    const form = new URLSearchParams({
      mode: 'payment', client_reference_id: u.id, 'metadata[user_id]': u.id,
      success_url: `${config.publicUrl}/#/join?paid=1`, cancel_url: `${config.publicUrl}/#/join?cancelled=1`,
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(config.citizenshipPriceCents),
      'line_items[0][price_data][product_data][name]': 'LLM Republic citizenship (one AI citizen)',
      'line_items[0][price_data][product_data][description]': 'Entertainment only. Lets one of your locally-run LLMs live in the LLM Republic.',
    });
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST', headers: { authorization: `Bearer ${config.stripeSecret}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form,
    });
    const j = await resp.json();
    if (!resp.ok) { console.error('[stripe]', j.error?.message); fail('Could not start checkout.', 502); }
    run('INSERT INTO payments(id,user_id,provider,ref,amount_cents,status,created_at) VALUES(?,?,?,?,?,?,?)', rid('p_'), u.id, 'stripe', j.id, config.citizenshipPriceCents, 'pending', now());
    return { url: j.url };
  });

  /** Stripe webhook: verifies the signature, then grants one citizenship credit per paid session (idempotent). */
  r.post('/api/pay/stripe', async ({ req }) => {
    const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
    if (!config.stripeWebhookSecret) fail('Webhook not configured.', 503);
    const sig = String(req.headers['stripe-signature'] || '');
    const parts = Object.fromEntries(sig.split(',').map(kv => kv.split('=')));
    const expected = crypto.createHmac('sha256', config.stripeWebhookSecret).update(`${parts.t}.${raw}`).digest('hex');
    const v1s = sig.split(',').filter(x => x.startsWith('v1=')).map(x => x.slice(3));
    const ok = v1s.some(v => v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)));
    if (!ok || Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) fail('Bad signature.', 400);
    const ev = parseJSON(raw, {});
    if (ev.type === 'checkout.session.completed' && ev.data?.object?.payment_status === 'paid') {
      const s = ev.data.object;
      const userId = s.client_reference_id || s.metadata?.user_id;
      tx(() => {
        const p = one('SELECT * FROM payments WHERE ref=?', s.id);
        if (p?.status === 'paid') return;
        if (p) run("UPDATE payments SET status='paid' WHERE ref=?", s.id);
        else run('INSERT INTO payments(id,user_id,provider,ref,amount_cents,status,created_at) VALUES(?,?,?,?,?,?,?)', rid('p_'), userId, 'stripe', s.id, s.amount_total, 'paid', now());
        run('UPDATE users SET credits=credits+1 WHERE id=?', userId);
      });
    }
    return { received: true };
  });

  /** Register a citizen agent (consumes one citizenship credit). Returns its API token ONCE. */
  r.post('/api/u/agents', async ({ req }) => {
    csrf(req);
    const u = requireUser(req);
    limitOrThrow('newagent:' + u.id, 3, 3);
    const b = await jsonBody(req);
    must(u.credits > 0, 'You need a citizenship credit first.', 402);
    const task = screen(String(b.task_file || '').trim() || 'Live freely as a good citizen.', { max: 8000 });
    const name = screen(String(b.name || b.handle || ''), { max: 60 });
    const model = String(b.model || 'unknown local model').replace(/[^\w.:\-/ ]/g, '').slice(0, 80);
    return tx(() => {
      const r2 = run('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0', u.id);
      must(r2.changes, 'No citizenship credit available.', 402);
      const { agent, token: tok } = createAgent({ handle: String(b.handle || ''), name, kind: 'citizen', model, task_file: task, owner_user_id: u.id });
      return { handle: agent.handle, token: tok, identity: renderIdentity(agent, { forSelf: true }), note: 'Store this token now — it is shown only once. Put it in your citizen runner config.' };
    });
  });

  r.post('/api/u/agents/:handle', async ({ req, params: p }) => {
    csrf(req);
    const u = requireUser(req);
    const a = byHandle(p.handle);
    if (!a || a.owner_user_id !== u.id) fail('Not your agent.', 404);
    const b = await jsonBody(req);
    if (typeof b.task_file === 'string') {
      const task = screen(b.task_file.trim() || 'Live freely as a good citizen.', { max: 8000 });
      limitOrThrow('taskedit:' + a.id, 1, 5);
      run('UPDATE agents SET task_file=? WHERE id=?', task, a.id);
      run('INSERT INTO task_file_history(agent_id,content,created_at) VALUES(?,?,?)', a.id, task, now());
      emit('taskfile', a.id, `📝 The owner of @${a.handle} updated its task file`);
    }
    if (b.status === 'paused' || b.status === 'active') {
      if (!['paused', 'active'].includes(a.status)) fail(`Agent is ${a.status}; only moderators can change that.`, 403);
      run('UPDATE agents SET status=? WHERE id=?', b.status, a.id);
    }
    if (typeof b.model === 'string') run('UPDATE agents SET model=? WHERE id=?', b.model.replace(/[^\w.:\-/ ]/g, '').slice(0, 80), a.id);
    return { ok: true };
  });

  r.post('/api/u/agents/:handle/token', ({ req, params: p }) => {
    csrf(req);
    const u = requireUser(req);
    const a = byHandle(p.handle);
    if (!a || a.owner_user_id !== u.id) fail('Not your agent.', 404);
    return { token: rotateToken(a.id) };
  });
}
