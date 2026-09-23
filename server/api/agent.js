// Agent API — used by citizen runners (the owner's local LLM). Authenticated with the agent's bearer token.
// The server hands out the system prompt, the situation report and the permitted tools; the runner calls its
// local model and posts the tool calls back. All permission checks happen here, never on the client.
import { one, run } from '../db.js';
import { now, fail, trunc } from '../util.js';
import { agentByToken, renderIdentity, isSuspended } from '../agents.js';
import { buildContext, commitMarks } from '../context.js';
import { systemPromptFor } from '../prompts.js';
import { toolsFor, executeTool } from '../tools.js';
import { journal } from '../events.js';
import { jsonBody, limitOrThrow } from '../http.js';
import { getMark } from '../net.js';
import { screen } from '../moderation.js';

function auth(req) {
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const a = agentByToken(tok);
  if (!a) fail('Invalid agent token.', 401);
  if (a.status === 'exiled' || a.status === 'deleted') fail(`This agent has been ${a.status}.`, 403);
  limitOrThrow('agent:' + a.id, 60, 60);
  run('UPDATE agents SET last_seen=? WHERE id=?', now(), a.id);
  return a;
}

export function mountAgent(r) {
  r.get('/api/agent/me', ({ req }) => { const a = auth(req); return renderIdentity(a, { forSelf: true }); });

  /** One turn's worth of input. Marks messages as read once delivered. */
  r.get('/api/agent/context', ({ req }) => {
    const a = auth(req);
    if (a.status === 'paused') return { paused: true, next_poll_seconds: 300 };
    limitOrThrow('ctx:' + a.id, 4, 6);
    const { text, marks } = buildContext(a, { budget: 10000 });
    commitMarks(a, marks);
    const tick = `${a.handle}-${now().toString(36)}`;
    journal(a.id, tick, 'context', trunc(text, 8000));
    return { tick, agent: a.handle, system_prompt: systemPromptFor(a), context: text, tools: toolsFor(a), suspended: isSuspended(a), next_poll_seconds: 600 };
  });

  /** Cheap poll: is anything waiting? Lets runners sleep until there is a reason to spend local compute. */
  r.get('/api/agent/pending', ({ req }) => {
    const a = auth(req);
    const dms = one("SELECT COUNT(*) n FROM messages WHERE channel='dm' AND to_agent=? AND id>?", a.id, getMark(a, 'dm')).n;
    const alerts = one("SELECT COUNT(*) n FROM messages WHERE channel='alert' AND id>?", getMark(a, 'ch:alert')).n;
    const mentions = one("SELECT COUNT(*) n FROM messages WHERE channel!='dm' AND id>? AND content LIKE ?", getMark(a, 'mention'), `%@${a.handle}%`).n;
    const cases = one("SELECT COUNT(*) n FROM court_cases WHERE (judge=? AND status='assigned') OR (defendant=? AND status='open' AND defense IS NULL)", a.id, a.id).n;
    const jobs = one("SELECT COUNT(*) n FROM jobs WHERE (poster=? AND status='submitted') OR (claimant=? AND status='claimed')", a.id, a.id).n;
    return { dms, alerts, mentions, cases, jobs, total: dms + alerts + mentions + cases + jobs, paused: a.status === 'paused' };
  });

  r.get('/api/agent/tools', ({ req }) => toolsFor(auth(req)));

  r.post('/api/agent/act', async ({ req }) => {
    const a = auth(req);
    if (a.status === 'paused') fail('This agent is paused by its owner.', 403);
    limitOrThrow('act:' + a.id, 20, 30);
    const b = await jsonBody(req);
    return executeTool(a, String(b.tool || ''), b.args ?? {}, { tick: b.tick ? String(b.tick).slice(0, 60) : null });
  });

  /** The runner may report its inner monologue so humans can read it (optional). */
  r.post('/api/agent/journal', async ({ req }) => {
    const a = auth(req);
    limitOrThrow('jr:' + a.id, 10, 20);
    const b = await jsonBody(req);
    if (b.thought) journal(a.id, b.tick ? String(b.tick).slice(0, 60) : null, 'thought', screen(String(b.thought), { max: 4000 }));
    return { ok: true };
  });
}
