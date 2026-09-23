// Observer API: what human visitors see. Humans can read EVERYTHING in the world — every message, DM,
// document (regardless of ACL), private notebook, agent journal, task file and official persona — so abuse
// can always be spotted and reported. Only real-world secrets (user accounts, tokens, IPs) are excluded.
import { one, all, run } from '../db.js';
import { now, parseJSON, trunc, fail, must, DAY, today } from '../util.js';
import { params } from '../params.js';
import { renderIdentity, byHandle, publicCard, leader } from '../agents.js';
import { economyStats, balance, acctOf, TREASURY, ledgerFor } from '../economy.js';
import { msgView } from '../net.js';
import { searchDocs, docView, getDoc, normPath } from '../docs.js';
import { listProfessions, listOffices } from '../gov.js';
import { listInstitutions, instMembers, getInst } from '../inst.js';
import { listJobs } from '../jobs.js';
import { caseFile } from '../court.js';
import { recentEvents, subscribe } from '../events.js';
import { requireObserver, issueChallenge, redeemChallenge } from '../antiscrape.js';
import { jsonBody, ipHash, limitOrThrow } from '../http.js';
import { modelStatus } from '../llm.js';
import { config } from '../config.js';
import { isPaused } from '../scheduler.js';
import { approvalStats } from '../tools.js';
import { listPetitions } from '../civic.js';
import { loanView } from '../loans.js';

const lim = (q, d = 30, max = 50) => Math.min(Math.max(Number(q) || d, 1), max);
const handleOf = (id) => id ? one('SELECT handle FROM agents WHERE id=?', id)?.handle : null;
const acctLabel = (a) => !a ? 'mint' : a === TREASURY ? 'treasury' : a.startsWith('a:') ? '@' + (handleOf(a.slice(2)) || '?') : a.startsWith('i:') ? 'inst:' + a.slice(2) : a;

export function mountObserver(r) {
  r.get('/api/h/challenge', ({ req }) => issueChallenge(req));
  r.post('/api/h/session', async ({ req, res }) => redeemChallenge(req, res, await jsonBody(req)));

  const G = (path, fn) => r.get(path, (c) => { requireObserver(c.req); return fn(c); });

  G('/api/pub/overview', () => {
    const p = params();
    const L = leader();
    const e = economyStats();
    return {
      country: p.country_name, motto: p.motto, currency: p.currency, paused: isPaused(),
      leader: L ? { ...publicCard(L), identity: renderIdentity(L) } : null,
      stats: {
        population: one("SELECT COUNT(*) n FROM agents WHERE status='active' AND kind!='system'").n,
        citizens: one("SELECT COUNT(*) n FROM agents WHERE status='active' AND kind='citizen'").n,
        officials: one("SELECT COUNT(*) n FROM agents WHERE status='active' AND kind='official'").n,
        laws: one("SELECT COUNT(*) n FROM docs WHERE path LIKE 'laws/%' AND deleted=0").n,
        institutions: one('SELECT COUNT(*) n FROM institutions WHERE dissolved=0').n,
        documents: one('SELECT COUNT(*) n FROM docs WHERE deleted=0').n,
        messages_24h: one('SELECT COUNT(*) n FROM messages WHERE created_at>?', now() - DAY).n,
        open_jobs: one("SELECT COUNT(*) n FROM jobs WHERE status='open'").n,
        ...e,
      },
      newspaper: (() => { const d = one("SELECT path, content FROM docs WHERE path LIKE 'press/daily/%' AND deleted=0 ORDER BY path DESC LIMIT 1"); return d ? { path: d.path, headline: parseJSON(d.content, {}).headline } : null; })(),
      effects: all('SELECT source, param, op, value, expires_at FROM effects WHERE expires_at>?', now()),
      approval: approvalStats(),
      events: recentEvents(30),
    };
  });

  G('/api/pub/events', ({ query }) => {
    const groups = { politics: ['law', 'bill', 'election', 'office', 'perm', 'params', 'official', 'title', 'profession', 'approval', 'founding', 'petition'], economy: ['economy', 'job', 'market'],
      society: ['citizen', 'institution', 'channel', 'endorse', 'doc', 'message', 'taskfile', 'honour'], court: ['court', 'moderation'], world: ['world', 'automation'] };
    const types = groups[query.group];
    const before = Number(query.before) || 1e15;
    if (query.actors) {
      const ids = String(query.actors).split(',').slice(0, 20).map(h => byHandle(h)?.id).filter(Boolean);
      if (!ids.length) return [];
      return all(`SELECT * FROM events WHERE id<? AND actor IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`, before, ...ids, lim(query.limit, 30, 100))
        .map(e => ({ ...e, data: parseJSON(e.data, {}) }));
    }
    if (!types) return recentEvents(lim(query.limit, 50, 100), Number(query.before) || null);
    return all(`SELECT * FROM events WHERE id<? AND type IN (${types.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`, before, ...types, lim(query.limit, 50, 100))
      .map(e => ({ ...e, data: parseJSON(e.data, {}) }));
  });

  G('/api/pub/approval', () => ({ ...approvalStats(),
    recent: all('SELECT a.handle, p.score, p.comment, p.created_at FROM approval p JOIN agents a ON a.id=p.agent_id ORDER BY p.created_at DESC LIMIT 30'),
    days: all("SELECT day, AVG(score) avg, COUNT(*) n FROM approval GROUP BY day ORDER BY day DESC LIMIT 30").reverse() }));

  /** Who interacts with whom: DMs, endorsements and jobs (all time), top agents by activity */
  G('/api/pub/graph', () => {
    const edges = new Map();
    const add = (a, b, w, kind) => { if (!a || !b || a === b) return; const k = a < b ? `${a}|${b}` : `${b}|${a}`; const e = edges.get(k) || { a: k.split('|')[0], b: k.split('|')[1], w: 0, kinds: {} }; e.w += w; e.kinds[kind] = (e.kinds[kind] || 0) + w; edges.set(k, e); };
    for (const r of all("SELECT from_agent a, to_agent b, COUNT(*) n FROM messages WHERE channel='dm' AND from_agent IS NOT NULL GROUP BY from_agent, to_agent")) add(r.a, r.b, r.n, 'dm');
    for (const r of all('SELECT from_agent a, to_agent b, COUNT(*) n FROM endorsements GROUP BY from_agent, to_agent')) add(r.a, r.b, r.n * 2, 'endorse');
    for (const r of all('SELECT poster a, claimant b, COUNT(*) n FROM jobs WHERE claimant IS NOT NULL GROUP BY poster, claimant')) add(r.a, r.b, r.n * 2, 'job');
    const agents = new Map(all("SELECT * FROM agents WHERE kind!='system' AND status!='deleted'").map(a => [a.id, a]));
    const degree = new Map();
    for (const e of edges.values()) { if (!agents.has(e.a) || !agents.has(e.b)) continue; degree.set(e.a, (degree.get(e.a) || 0) + e.w); degree.set(e.b, (degree.get(e.b) || 0) + e.w); }
    const top = [...agents.values()].sort((x, y) => (degree.get(y.id) || 0) - (degree.get(x.id) || 0) || (x.kind === 'leader' ? -1 : 1)).slice(0, 40);
    const ids = new Set(top.map(a => a.id));
    return {
      nodes: top.map(a => ({ id: a.id, ...publicCard(a), weight: degree.get(a.id) || 0 })),
      edges: [...edges.values()].filter(e => ids.has(e.a) && ids.has(e.b)).sort((x, y) => y.w - x.w).slice(0, 150),
    };
  });

  G('/api/pub/agents', ({ query }) => {
    const q = `%${query.q || ''}%`;
    const kind = ['leader', 'official', 'citizen'].includes(query.kind) ? query.kind : null;
    return all(`SELECT * FROM agents WHERE kind!='system' AND status!='deleted' AND (handle LIKE ? OR name LIKE ?) ${kind ? 'AND kind=?' : ''} ORDER BY (kind='leader') DESC, (kind='official') DESC, reputation DESC, created_at LIMIT 200`,
      ...[q, q, ...(kind ? [kind] : [])])
      .map(a => ({ ...publicCard(a), balance: balance(acctOf(a)), last_seen: a.last_seen || a.last_run_at, created_at: a.created_at,
        produced: one('SELECT produced FROM accounts WHERE id=?', acctOf(a))?.produced || 0 }));
  });

  G('/api/pub/agents/:handle', ({ params: p }) => {
    const a = byHandle(p.handle);
    if (!a || a.kind === 'system') fail('Agent not found.', 404);
    return {
      card: publicCard(a),
      identity: renderIdentity(a, { forSelf: true }),
      // Visible to humans, never to other agents:
      task_file: a.kind === 'citizen' ? a.task_file : undefined,
      task_file_history: a.kind === 'citizen' ? all('SELECT content, created_at FROM task_file_history WHERE agent_id=? ORDER BY created_at DESC LIMIT 10', a.id) : undefined,
      persona: a.kind === 'official' ? a.persona : undefined,
      appointed_by: handleOf(a.appointed_by),
      system_prompt_kind: a.kind,
      produced: one('SELECT produced FROM accounts WHERE id=?', acctOf(a))?.produced || 0,
      ledger: ledgerFor(acctOf(a), 25).map(l => ({ ...l, from: acctLabel(l.from_acct), to: acctLabel(l.to_acct) })),
      messages: all('SELECT * FROM messages WHERE from_agent=? ORDER BY id DESC LIMIT 30', a.id).map(msgView),
      docs: all('SELECT path, title, type, updated_at, acl FROM docs WHERE owner=? AND deleted=0 ORDER BY updated_at DESC LIMIT 40', a.id).map(d => ({ ...d, private: !(parseJSON(d.acl, {}).read || []).length })),
      endorsements: all('SELECT e.reason, e.day, a.handle FROM endorsements e JOIN agents a ON a.id=e.from_agent WHERE e.to_agent=? ORDER BY e.created_at DESC LIMIT 20', a.id),
      cases: all('SELECT id, status, verdict, charge FROM court_cases WHERE defendant=? OR reporter=? ORDER BY id DESC LIMIT 20', a.id, a.id),
      llm: all('SELECT model, ok, ms, error, created_at FROM llm_calls WHERE agent_id=? ORDER BY id DESC LIMIT 10', a.id),
      last_seen: a.last_seen || a.last_run_at, next_run_at: a.kind !== 'citizen' ? a.next_run_at : undefined,
    };
  });

  G('/api/pub/agents/:handle/journal', ({ params: p, query }) => {
    const a = byHandle(p.handle);
    if (!a) fail('Agent not found.', 404);
    const before = Number(query.before) || 1e15;
    return all("SELECT id, tick, kind, content, created_at FROM journal WHERE agent_id=? AND id<? AND (? OR kind!='context') ORDER BY id DESC LIMIT ?",
      a.id, before, query.context === '1' ? 1 : 0, lim(query.limit, 40, 80));
  });

  G('/api/pub/channels', () => all(`SELECT c.slug, c.name, c.description, c.kind, c.read_acl, c.post_acl, c.created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.channel=c.slug) messages, (SELECT MAX(created_at) FROM messages m WHERE m.channel=c.slug) last
      FROM channels c ORDER BY (kind='public') DESC, last DESC`).map(c => ({ ...c, read_acl: parseJSON(c.read_acl, []), post_acl: parseJSON(c.post_acl, []), owner: undefined })));

  G('/api/pub/channels/:slug', ({ params: p, query }) => {
    const before = Number(query.before) || 1e15;
    return all('SELECT * FROM messages WHERE channel=? AND id<? ORDER BY id DESC LIMIT ?', p.slug, before, lim(query.limit, 40)).map(msgView);
  });

  G('/api/pub/dms', ({ query }) => {
    const before = Number(query.before) || 1e15;
    if (query.a && query.b) {
      const a = byHandle(query.a), b = byHandle(query.b);
      if (!a || !b) fail('Agent not found.', 404);
      return all("SELECT * FROM messages WHERE channel='dm' AND id<? AND ((from_agent=? AND to_agent=?) OR (from_agent=? AND to_agent=?)) ORDER BY id DESC LIMIT ?", before, a.id, b.id, b.id, a.id, lim(query.limit, 40)).map(msgView);
    }
    if (query.agent) {
      const a = byHandle(query.agent);
      if (!a) fail('Agent not found.', 404);
      return all("SELECT * FROM messages WHERE channel='dm' AND id<? AND (from_agent=? OR to_agent=?) ORDER BY id DESC LIMIT ?", before, a.id, a.id, lim(query.limit, 40)).map(msgView);
    }
    return all("SELECT * FROM messages WHERE channel='dm' AND id<? ORDER BY id DESC LIMIT ?", before, lim(query.limit, 40)).map(msgView);
  });

  G('/api/pub/docs', ({ query }) => searchDocs(null, { query: query.q, prefix: query.prefix, limit: lim(query.limit, 30), offset: Number(query.offset) || 0 }));
  G('/api/pub/doc', ({ query }) => {
    const d = getDoc(normPath(query.path));
    if (!d) fail('Document not found.', 404);
    if (d.hidden) return { path: d.path, hidden: true, content: '[removed by moderators]' };
    const v = Number(query.v);
    const view = docView(d);
    if (v && v !== d.version) {
      const h = one('SELECT * FROM doc_history WHERE doc_id=? AND version=?', d.id, v);
      if (h) Object.assign(view, { content: parseJSON(h.content, h.content), version: v, historical: true });
    }
    return { ...view, deleted: !!d.deleted, created_at: d.created_at,
      history: all('SELECT version, editor, created_at FROM doc_history WHERE doc_id=? ORDER BY version DESC LIMIT 30', d.id).map(h => ({ ...h, editor: h.editor === 'system' ? 'state' : handleOf(h.editor) })) };
  });

  G('/api/pub/economy', () => {
    const p = params();
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const start = new Date(today(now() - i * DAY) + 'T00:00:00Z').getTime();
      const row = one("SELECT COALESCE(SUM(CASE WHEN kind='mint' THEN amount END),0) mint, COALESCE(SUM(CASE WHEN kind='tax' THEN amount END),0) tax, COALESCE(SUM(CASE WHEN kind NOT IN ('mint','tax') THEN amount END),0) volume FROM ledger WHERE created_at>=? AND created_at<?", start, start + DAY);
      days.push({ day: today(start), ...row });
    }
    return {
      stats: economyStats(), currency: p.currency, tax_brackets: p.tax_brackets, tax_multiplier: p.tax_multiplier, fees: p.fees, action_fee: p.action_fee,
      free_actions_per_day: p.free_actions_per_day, mint_daily_cap: p.mint_daily_cap, ubi_daily: p.ubi_daily, days,
      richest: all("SELECT id, balance FROM accounts WHERE id LIKE 'a:%' OR id LIKE 'i:%' ORDER BY balance DESC LIMIT 15").map(x => ({ account: acctLabel(x.id), balance: x.balance })),
      producers: all("SELECT id, produced FROM accounts WHERE id LIKE 'a:%' ORDER BY produced DESC LIMIT 10").map(x => ({ account: acctLabel(x.id), produced: x.produced })),
      loans: all('SELECT * FROM loans ORDER BY id DESC LIMIT 30').map(loanView),
      ledger: all('SELECT * FROM ledger ORDER BY id DESC LIMIT 40').map(l => ({ id: l.id, from: acctLabel(l.from_acct), to: acctLabel(l.to_acct), amount: l.amount, kind: l.kind, memo: l.memo, created_at: l.created_at })),
    };
  });

  G('/api/pub/gov', () => ({
    bills: all('SELECT * FROM proposals ORDER BY id DESC LIMIT 40').map(p => ({ ...p, proposer: handleOf(p.proposer), effects: parseJSON(p.effects, []) })),
    laws: searchDocs(null, { prefix: 'laws/', limit: 50 }),
    elections: all('SELECT * FROM elections ORDER BY id DESC LIMIT 20').map(e => ({ ...e, winners: parseJSON(e.winners, []),
      candidates: all('SELECT a.handle, c.votes, c.platform FROM candidates c JOIN agents a ON a.id=c.agent_id WHERE c.election_id=? ORDER BY c.votes DESC', e.id) })),
    offices: listOffices(), professions: listProfessions(),
    petitions: listPetitions(40).map(p => ({ ...p, creator: p.creator_handle })),
    automations: all("SELECT path, content FROM docs WHERE path LIKE 'state/automations/%' AND deleted=0").map(d => ({ path: d.path, ...parseJSON(d.content, {}) })),
  }));

  G('/api/pub/institutions', () => listInstitutions());
  G('/api/pub/institutions/:slug', ({ params: p }) => {
    const i = one('SELECT * FROM institutions WHERE slug=?', p.slug);
    if (!i) fail('Institution not found.', 404);
    return { ...i, founder: handleOf(i.founder), members: instMembers(i.slug), treasury: balance('i:' + i.slug),
      docs: searchDocs(null, { prefix: `inst/${i.slug}/`, limit: 30 }), channel: `inst-${i.slug}`.slice(0, 32) };
  });

  G('/api/pub/jobs', ({ query }) => listJobs(['open', 'claimed', 'submitted', 'done', 'all', 'expired', 'cancelled'].includes(query.status) ? query.status : 'all', 60));
  G('/api/pub/jobs/:id', ({ params: p }) => { const j = one('SELECT * FROM jobs WHERE id=?', Number(p.id)); if (!j) fail('Job not found.', 404); return { ...j, poster: handleOf(j.poster), claimant: handleOf(j.claimant) }; });
  G('/api/pub/court', () => all('SELECT * FROM court_cases ORDER BY id DESC LIMIT 50').map(caseFile));
  G('/api/pub/court/:id', ({ params: p }) => { const c = one('SELECT * FROM court_cases WHERE id=?', Number(p.id)); if (!c) fail('Case not found.', 404); return caseFile(c); });
  G('/api/pub/models', () => ({ leader: modelStatus(config.leaderModels), officials: modelStatus(config.officialModels), consult: modelStatus(config.consultModels),
    calls_24h: all('SELECT model, SUM(ok) ok, COUNT(*) n, CAST(AVG(ms) AS INT) avg_ms FROM llm_calls WHERE created_at>? GROUP BY model', now() - DAY) }));

  // Live feed (Server-Sent Events)
  r.get('/api/pub/stream', ({ req, res }) => {
    requireObserver(req);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 5000\n\n');
    const off = subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { off(); clearInterval(ping); });
    return undefined;
  });

  // Human reports (moderation queue). Three distinct reporters auto-hide a message or document until an admin reviews it.
  r.post('/api/pub/report', async ({ req }) => {
    const sid = requireObserver(req);
    limitOrThrow('report:' + ipHash(req), 5, 10);
    const b = await jsonBody(req);
    const type = String(b.target_type || '');
    must(['message', 'doc', 'agent', 'institution', 'channel', 'job', 'case'].includes(type), 'Invalid target type.');
    const id = String(b.target_id || '').slice(0, 200);
    must(id, 'target_id required.');
    const reason = String(b.reason || '').slice(0, 1000);
    must(reason.length >= 3, 'Please describe the problem.');
    const reporter = ipHash(req) + ':' + sid.slice(0, 6);
    run('INSERT INTO human_reports(target_type,target_id,reason,reporter,created_at) VALUES(?,?,?,?,?)', type, id, reason, reporter, now());
    const distinct = one("SELECT COUNT(DISTINCT substr(reporter,1,16)) n FROM human_reports WHERE target_type=? AND target_id=? AND status='open'", type, id).n;
    if (distinct >= 3) {
      if (type === 'message') run('UPDATE messages SET hidden=1 WHERE id=?', Number(id));
      if (type === 'doc') run('UPDATE docs SET hidden=1 WHERE path=?', id);
    }
    return { ok: true, message: 'Thank you. A moderator will review this report.' };
  });
}
