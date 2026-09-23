// Permission system. A permission is a plain string ("gov.vote", "doc.read:laws/*", "inst:treasury-guild").
// Permissions an agent holds are patterns: "*" is a wildcard. A resource (document, channel, tool) requires
// one or more permission strings; access is granted if any held pattern matches any required string.
import { all, one } from './db.js';
import { now, parseJSON } from './util.js';
import { params } from './params.js';

const reCache = new Map();
function globRe(p) {
  let r = reCache.get(p);
  if (!r) {
    r = new RegExp('^' + p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    if (reCache.size > 5000) reCache.clear();
    reCache.set(p, r);
  }
  return r;
}

/** Does a held pattern satisfy a required permission? */
export function permMatch(held, required) {
  if (held === '*' || held === required) return true;
  if (!held.includes('*')) return false;
  return globRe(held).test(required);
}

// A grantable permission must start with a literal character: "gov.*" is fine, but "*", "**" or "*.*"
// would behave like the leader's omnipotent "*" and are reserved for the Head of State.
export const PERM_RE = /^[a-z0-9_][a-z0-9_.:\-/*]{0,119}$/i;

export function professionDef(slug) {
  const r = one('SELECT content FROM docs WHERE path=? AND deleted=0', `state/professions/${slug}`);
  return r ? parseJSON(r.content, {}) : null;
}

/** Every effective permission of an agent (explicit + implicit). Shown in the identity JSON as well. */
export function effectivePerms(agent) {
  const set = new Set(['public', `agent:${agent.handle.toLowerCase()}`, `role:${agent.kind}`]);
  if (agent.kind !== 'system') set.add('resident');
  for (const p of params().role_perms[agent.kind] || []) set.add(p);
  for (const r of all('SELECT perm FROM perms WHERE agent_id=? AND (expires_at IS NULL OR expires_at>?)', agent.id, now())) set.add(r.perm);
  for (const r of all('SELECT slug FROM agent_professions WHERE agent_id=?', agent.id)) {
    set.add(`profession:${r.slug}`);
    const def = professionDef(r.slug);
    for (const p of (Array.isArray(def?.perms) ? def.perms : [])) if (typeof p === 'string' && p !== '*') set.add(p);
  }
  for (const r of all("SELECT m.inst, m.rank FROM inst_members m JOIN institutions i ON i.slug=m.inst WHERE m.agent_id=? AND i.dissolved=0 AND m.rank!='applicant'", agent.id)) {
    set.add(`inst:${r.inst}`);
    set.add(`inst:${r.inst}:${r.rank}`);
  }
  // Whatever the source (grants, professions, offices, role_perms), only the leader may hold leading-wildcard patterns
  return agent.kind === 'leader' ? [...set] : [...set].filter(p => PERM_RE.test(p));
}

/** perms: output of effectivePerms; required: one permission or a list (any one suffices) */
export function hasPerm(perms, required) {
  const reqs = Array.isArray(required) ? required : [required];
  for (const req of reqs) for (const p of perms) if (permMatch(p, String(req))) return true;
  return false;
}

/** Can this agent grant the permission to others? (holds a can_grant=1 pattern covering it, or '*') */
export function canGrant(agent, perm) {
  if (!PERM_RE.test(perm)) return false;
  if (effectivePerms(agent).includes('*')) return true;
  const rows = all('SELECT perm FROM perms WHERE agent_id=? AND can_grant=1 AND (expires_at IS NULL OR expires_at>?)', agent.id, now());
  return rows.some(r => permMatch(r.perm, perm));
}

export const hasGrantAbility = (agent) => effectivePerms(agent).includes('*') ||
  !!one('SELECT 1 FROM perms WHERE agent_id=? AND can_grant=1 AND (expires_at IS NULL OR expires_at>?) LIMIT 1', agent.id, now());

export const explicitPerms = (agentId) =>
  all('SELECT perm, can_grant, granted_by, source, expires_at FROM perms WHERE agent_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY id', agentId, now());

/** Permission catalogue (reference for the leader and for humans) */
export const PERM_CATALOG = {
  '*': 'Everything (leader only)',
  'gov.propose': 'Submit bills to parliament',
  'gov.vote': 'Vote on bills and in elections',
  'gov.sign': 'Sign or veto bills that passed parliament',
  'gov.decree': 'Issue decrees (laws that take effect immediately)',
  'gov.params': 'Edit state/params (economic and governance parameters)',
  'treasury.spend': 'Spend from the state treasury',
  'net.announce': 'Post to the #official announcement channel',
  'net.alert': 'Post to the #alert emergency network (lands at the top of everyone\'s context)',
  'net.post:<channel>': 'Post to channels that require it',
  'doc.read:<path-glob>': 'Read documents under matching paths',
  'doc.write:<path-glob>': 'Create/edit documents under matching paths',
  'profession.define': 'Define new professions',
  'profession.grant:<slug|*>': 'Grant or remove a profession',
  'court.judge': 'Act as a judge (rule on assigned cases)',
  'court.pardon': 'Pardon convicted agents',
  'state.appoint': 'Appoint/dismiss state officials (AIs run by the server)',
  'identity.title': 'Give titles to others',
  'inst.ministry': 'Found institutions of kind "ministry"',
  'llm.consult': 'Consult other AI models',
};
