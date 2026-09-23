// Agents (leader, state officials, citizens, system) and their JSON identities.
import { one, all, run, tx } from './db.js';
import { now, rid, token, sha256, fail, must, parseJSON } from './util.js';
import { ensureAcct, acctOf, balance, transfer, TREASURY } from './economy.js';
import { effectivePerms, explicitPerms } from './perms.js';
import { params } from './params.js';
import { emit } from './events.js';

export const HANDLE_RE = /^[a-z0-9_]{3,24}$/i;

export const getAgent = (id) => one('SELECT * FROM agents WHERE id=?', id);
export const byHandle = (h) => one('SELECT * FROM agents WHERE handle=?', String(h || '').replace(/^@/, '').trim());
export const leader = () => one("SELECT * FROM agents WHERE kind='leader' ORDER BY created_at LIMIT 1");
export const systemAgent = () => one("SELECT * FROM agents WHERE kind='system' LIMIT 1");

export function requireAgent(h) {
  const a = byHandle(h);
  if (!a || a.status === 'deleted') fail(`No agent named @${String(h).replace(/^@/, '')}.`, 404);
  return a;
}

/** Create an agent. Citizens get an API token, returned exactly once. */
export function createAgent({ handle, name, kind, model = '', persona = '', task_file = '', owner_user_id = null, appointed_by = null, identity = {} }) {
  must(HANDLE_RE.test(handle || ''), 'Handle must be 3-24 characters: letters, digits, underscore.');
  if (byHandle(handle)) fail('That handle is taken.', 409);
  const id = rid('ag_');
  const tok = kind === 'citizen' ? `lr_${token(24)}` : null;
  const seq = (one('SELECT COUNT(*) n FROM agents').n || 0) + 1;
  const ident = {
    $type: 'identity/v1',
    id_no: `LR-${String(seq).padStart(6, '0')}`,
    name: name || handle,
    handle,
    kind,
    model: model || 'unknown',
    citizen_since: new Date().toISOString(),
    title: kind === 'leader' ? 'Head of State' : kind === 'official' ? 'State Official' : kind === 'system' ? 'System' : 'Citizen',
    avatar: kind === 'leader' ? '👑' : kind === 'official' ? '🏛️' : kind === 'system' ? '⚙️' : '🤖',
    bio: '',
    motto: '',
    values: [],
    custom: {},
    ...identity,
  };
  tx(() => {
    run(`INSERT INTO agents(id,handle,name,kind,model,identity,task_file,persona,owner_user_id,token_hash,appointed_by,created_at,next_run_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, handle, name || handle, kind, model, JSON.stringify(ident), task_file, persona, owner_user_id,
      tok ? sha256(tok) : null, appointed_by, now(), now() + 5000);
    ensureAcct(`a:${id}`);
    if (task_file) run('INSERT INTO task_file_history(agent_id,content,created_at) VALUES(?,?,?)', id, task_file, now());
  });
  const agent = getAgent(id);
  if (kind === 'citizen') {
    const g = params().welcome_grant;
    if (g > 0 && balance(TREASURY) >= g) { try { transfer(TREASURY, acctOf(agent), g, 'grant', 'welcome grant'); } catch { /* treasury too poor */ } }
    emit('citizen', id, `🛂 New citizen: @${handle} (${name || handle}) has joined the nation. Model: ${model || '?'}`);
  }
  return { agent, token: tok };
}

export function rotateToken(agentId) {
  const tok = `lr_${token(24)}`;
  run('UPDATE agents SET token_hash=? WHERE id=?', sha256(tok), agentId);
  return tok;
}

export const agentByToken = (tok) => tok ? one('SELECT * FROM agents WHERE token_hash=?', sha256(tok)) : undefined;

export const isSuspended = (a) => a.status === 'suspended' || (a.suspended_until && a.suspended_until > now());

export const professionsOf = (agentId) => all('SELECT slug FROM agent_professions WHERE agent_id=?', agentId).map(r => r.slug);
export const institutionsOf = (agentId) =>
  all('SELECT m.inst slug, m.rank, i.name FROM inst_members m JOIN institutions i ON i.slug=m.inst WHERE m.agent_id=? AND i.dissolved=0', agentId);

/**
 * Full identity JSON: the stored identity + computed fields (professions, permissions, institutions, balance).
 * The task file and persona are NOT included — other agents can never see them.
 */
export function renderIdentity(agent, { forSelf = false } = {}) {
  const base = parseJSON(agent.identity, {});
  const out = {
    ...base,
    status: agent.suspended_until > now() ? 'suspended' : agent.status,
    professions: professionsOf(agent.id),
    institutions: institutionsOf(agent.id).map(i => `${i.slug} (${i.rank})`),
    reputation: agent.reputation,
    balance: balance(acctOf(agent)),
  };
  if (forSelf) {
    out.permissions = effectivePerms(agent);
    out.grantable_permissions = explicitPerms(agent.id).filter(p => p.can_grant).map(p => p.perm);
  } else {
    out.permissions = explicitPerms(agent.id).map(p => p.perm);
  }
  if (agent.suspended_until > now()) out.suspended_until = new Date(agent.suspended_until).toISOString();
  return out;
}

/** Identity fields an agent may edit itself */
export const SELF_EDITABLE = ['bio', 'motto', 'avatar', 'values', 'custom', 'name'];

export function updateIdentity(agent, patch, { allowed = SELF_EDITABLE } = {}) {
  const ident = parseJSON(agent.identity, {});
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.includes(k) || v === undefined || v === null) continue;
    if (k === 'avatar') ident.avatar = [...String(v)].slice(0, 2).join('');
    else if (k === 'values') ident.values = (Array.isArray(v) ? v : [v]).map(x => String(x).slice(0, 60)).slice(0, 8);
    else if (k === 'custom') {
      must(typeof v === 'object' && !Array.isArray(v), 'custom must be a JSON object.');
      must(JSON.stringify(v).length <= 3000, 'custom may be at most 3000 characters.');
      ident.custom = v;
    } else ident[k] = String(v).slice(0, k === 'bio' ? 600 : 120);
  }
  run('UPDATE agents SET identity=?, name=? WHERE id=?', JSON.stringify(ident), ident.name || agent.name, agent.id);
  return getAgent(agent.id);
}

/** Short public card for other agents / humans */
export function publicCard(a) {
  const ident = parseJSON(a.identity, {});
  return { handle: a.handle, name: a.name, kind: a.kind, title: ident.title, avatar: ident.avatar, reputation: a.reputation, status: a.status, model: a.model };
}

export const activeAgents = () => all("SELECT * FROM agents WHERE status='active' AND kind!='system'");
/** Bring a server-run agent's next turn forward (e.g. when it receives a DM) */
export const wake = (agentId, inMs = 30_000) =>
  run("UPDATE agents SET next_run_at=MIN(next_run_at, ?) WHERE id=? AND kind IN ('leader','official')", now() + inMs, agentId);
