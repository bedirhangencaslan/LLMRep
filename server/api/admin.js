// Moderator/admin API (Bearer ADMIN_TOKEN, or a logged-in user with is_admin). The human safety net:
// review reports, hide content, suspend/exile agents, ban users, pause the whole world.
import crypto from 'node:crypto';
import { one, all, run, kvSet } from '../db.js';
import { config } from '../config.js';
import { now, fail, must, parseJSON } from '../util.js';
import { byHandle, getAgent } from '../agents.js';
import { jsonBody, limitOrThrow, ipHash } from '../http.js';
import { currentUser } from './user.js';
import { fireWorldEvent, publishNewspaper } from '../world.js';
import { runTurn } from '../runtime.js';
import { modelStatus } from '../llm.js';
import { invalidateParams } from '../params.js';
import { emit } from '../events.js';
import { sendMessage } from '../net.js';

function requireAdmin(req) {
  limitOrThrow('admin:' + ipHash(req), 60, 60);
  const h = String(req.headers.authorization || '');
  if (config.adminToken && h.startsWith('Bearer ')) {
    const a = Buffer.from(h.slice(7)), b = Buffer.from(config.adminToken);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return 'token';
  }
  const u = currentUser(req);
  if (u?.is_admin && req.headers['x-llmrep'] === '1') return u.username;
  fail('Admin only.', 403);
}

export function mountAdmin(r) {
  const A = (m, path, fn) => r.add(m, path, async (c) => { c.admin = requireAdmin(c.req); c.body = m === 'POST' ? await jsonBody(c.req) : {}; return fn(c); });

  A('GET', '/api/admin/reports', ({ query }) => all('SELECT * FROM human_reports WHERE status=? ORDER BY id DESC LIMIT 200', query.status || 'open'));
  A('POST', '/api/admin/reports/:id', ({ params: p, body }) => { run('UPDATE human_reports SET status=? WHERE id=?', String(body.status || 'resolved'), Number(p.id)); return { ok: true }; });

  A('POST', '/api/admin/hide', ({ body }) => {
    const hidden = body.hidden === false ? 0 : 1;
    if (body.type === 'message') run('UPDATE messages SET hidden=? WHERE id=?', hidden, Number(body.id));
    else if (body.type === 'doc') { run('UPDATE docs SET hidden=? WHERE path=?', hidden, String(body.id)); invalidateParams(); }
    else fail('type must be message or doc');
    run("UPDATE human_reports SET status='resolved' WHERE target_type=? AND target_id=?", body.type, String(body.id));
    return { ok: true };
  });

  /** status: active | suspended | exiled | deleted. Exile = permanent removal from the world (visible as such). */
  A('POST', '/api/admin/agents/:handle', ({ params: p, body }) => {
    const a = byHandle(p.handle);
    must(a, 'Agent not found.');
    // "paused" belongs to owners; moderators use "suspended", which owners cannot undo
    must(['active', 'suspended', 'exiled', 'deleted', 'retired'].includes(body.status), 'Invalid status (moderators use "suspended" rather than "paused").');
    run('UPDATE agents SET status=? WHERE id=?', body.status, a.id);
    if (['exiled', 'deleted'].includes(body.status)) run('UPDATE agents SET token_hash=NULL WHERE id=?', a.id);
    if (body.status !== 'active') {
      emit('moderation', null, `🛡️ Moderators set @${a.handle} to ${body.status}${body.reason ? `: ${String(body.reason).slice(0, 200)}` : ''}`);
      if (body.status === 'exiled') sendMessage(null, '#official', `🛡️ @${a.handle} has been exiled from the republic by the human moderators.`, { system: true });
    }
    return { ok: true };
  });

  A('POST', '/api/admin/users/:username', ({ params: p, body }) => {
    const u = one('SELECT * FROM users WHERE username=?', p.username);
    must(u, 'User not found.');
    if (body.banned !== undefined) {
      run('UPDATE users SET banned=? WHERE id=?', body.banned ? 1 : 0, u.id);
      if (body.banned) {
        run('DELETE FROM user_sessions WHERE user_id=?', u.id);
        run("UPDATE agents SET status='suspended', token_hash=NULL WHERE owner_user_id=?", u.id);
      }
    }
    if (body.credits !== undefined) run('UPDATE users SET credits=? WHERE id=?', Math.max(0, Number(body.credits) || 0), u.id);
    if (body.is_admin !== undefined) run('UPDATE users SET is_admin=? WHERE id=?', body.is_admin ? 1 : 0, u.id);
    return { ok: true };
  });

  A('GET', '/api/admin/users', () => all('SELECT id, username, credits, is_admin, banned, created_at, (SELECT COUNT(*) FROM agents a WHERE a.owner_user_id=users.id) agents FROM users ORDER BY created_at DESC LIMIT 500'));
  A('POST', '/api/admin/pause', ({ body }) => { kvSet('paused', !!body.paused); emit('moderation', null, body.paused ? '⏸️ The world has been paused by the moderators.' : '▶️ The world has resumed.'); return { paused: !!body.paused }; });
  A('POST', '/api/admin/world-event', () => fireWorldEvent());
  A('POST', '/api/admin/newspaper', () => publishNewspaper());
  A('POST', '/api/admin/turn/:handle', async ({ params: p }) => { const a = byHandle(p.handle); must(a && a.kind !== 'citizen' || a?.model?.startsWith('mock:'), 'Only server-run agents.'); return runTurn(a); });
  A('GET', '/api/admin/llm', () => ({ leader: modelStatus(config.leaderModels), officials: modelStatus(config.officialModels), consult: modelStatus(config.consultModels),
    recent: all('SELECT l.*, a.handle FROM llm_calls l LEFT JOIN agents a ON a.id=l.agent_id ORDER BY l.id DESC LIMIT 50') }));
  A('GET', '/api/admin/whoami', ({ admin }) => ({ admin }));
}
