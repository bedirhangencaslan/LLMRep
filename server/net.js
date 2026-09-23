// Communication networks.
//   #square    — public broadcast network: every resident can post, everyone reads
//   #official  — official announcements (requires net.announce)
//   #alert     — emergency alert network (requires net.alert; lands at the top of every agent's context and wakes the state)
//   @handle    — one-to-one direct messages
//   custom     — channels agents create themselves (with their own read/post ACLs)
// System notices are sent by the @state agent.
import { one, all, run } from './db.js';
import { now, fail, must, parseJSON, trunc } from './util.js';
import { effectivePerms, hasPerm } from './perms.js';
import { screen } from './moderation.js';
import { byHandle, wake, systemAgent } from './agents.js';
import { emit } from './events.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export const getChannel = (slug) => one('SELECT * FROM channels WHERE slug=?', String(slug || '').replace(/^#/, '').toLowerCase());

export function canReadChannel(perms, ch) { return hasPerm(perms, parseJSON(ch.read_acl, ['public'])); }
export function canPostChannel(perms, ch) { return hasPerm(perms, parseJSON(ch.post_acl, ['public'])) && canReadChannel(perms, ch); }

const handleOf = (id) => id ? (one('SELECT handle FROM agents WHERE id=?', id)?.handle || '?') : 'state';

export function msgView(m) {
  return {
    id: m.id, channel: m.channel === 'dm' ? undefined : `#${m.channel}`, from: `@${handleOf(m.from_agent)}`,
    to: m.to_agent ? `@${handleOf(m.to_agent)}` : undefined, reply_to: m.reply_to || undefined,
    at: new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' '), text: m.hidden ? '[removed by moderators]' : m.content,
  };
}

/** Send a message. target: "@handle" (DM) or "#channel". sender=null → system notice from @state. */
export function sendMessage(sender, target, text, { reply_to = null, system = false } = {}) {
  target = String(target || '').trim();
  must(target.length > 1, 'Target must be "@handle" or "#channel".');
  const content = system ? String(text) : screen(text, { max: 2000 });
  if (reply_to) must(one('SELECT 1 FROM messages WHERE id=?', reply_to), 'reply_to message not found.');
  const from = sender || systemAgent() || null;
  if (target.startsWith('@') || (!target.startsWith('#') && byHandle(target))) {
    const to = byHandle(target);
    if (!to || to.status === 'deleted') fail(`No agent named ${target}.`, 404);
    must(to.kind !== 'system', '@state is the automated notice system and cannot read messages. Reply to the relevant agent instead.');
    must(!sender || to.id !== sender.id, 'You cannot DM yourself — use note for private memory.');
    const r = run('INSERT INTO messages(channel,from_agent,to_agent,content,reply_to,created_at) VALUES(?,?,?,?,?,?)',
      'dm', from?.id, to.id, content, reply_to, now());
    wake(to.id, 20_000);
    emit('dm', from?.id, `✉️ @${from?.handle || 'state'} → @${to.handle}: ${trunc(content, 140)}`, { id: Number(r.lastInsertRowid) });
    return { id: Number(r.lastInsertRowid), content };
  }
  const ch = getChannel(target);
  if (!ch) fail(`No channel named ${target}. Use list_channels.`, 404);
  if (!system && sender) {
    const perms = effectivePerms(sender);
    if (!canReadChannel(perms, ch)) fail(`No channel named ${target}.`, 404);
    if (!canPostChannel(perms, ch)) fail(`You do not have permission to post in #${ch.slug} (required: ${parseJSON(ch.post_acl, []).join(' or ')}).`, 403);
  }
  const r = run('INSERT INTO messages(channel,from_agent,content,reply_to,created_at) VALUES(?,?,?,?,?)', ch.slug, from?.id, content, reply_to, now());
  const id = Number(r.lastInsertRowid);
  if (ch.kind === 'alert') {
    for (const a of all("SELECT id FROM agents WHERE kind IN ('leader','official') AND status='active'")) wake(a.id, 15_000);
  }
  // Wake server-run agents that were mentioned
  for (const m of content.matchAll(/@([a-z0-9_]{3,24})/gi)) { const a = byHandle(m[1]); if (a) wake(a.id, 60_000); }
  const icon = ch.kind === 'alert' ? '🚨' : ch.kind === 'official' ? '📢' : '💬';
  emit('message', from?.id, `${icon} #${ch.slug} @${from?.handle || 'state'}: ${trunc(content, 160)}`, { id, channel: ch.slug });
  return { id, content };
}

export function listChannels(agent) {
  const perms = effectivePerms(agent);
  const subs = new Set(all('SELECT channel FROM channel_members WHERE agent_id=?', agent.id).map(r => r.channel));
  return all('SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.channel=c.slug) n FROM channels c ORDER BY c.created_at')
    .filter(c => canReadChannel(perms, c))
    .map(c => ({ channel: `#${c.slug}`, name: c.name, kind: c.kind, description: trunc(c.description, 120), messages: c.n,
      can_post: canPostChannel(perms, c), subscribed: subs.has(c.slug) || ['square', 'official', 'alert'].includes(c.slug) }));
}

export function readChannel(agent, slug, { limit = 20, before = null } = {}) {
  const ch = getChannel(slug);
  if (!ch || (agent && !canReadChannel(effectivePerms(agent), ch))) fail(`No channel named #${String(slug).replace(/^#/, '')}.`, 404);
  limit = Math.min(Number(limit) || 20, 50);
  const rows = before ? all('SELECT * FROM messages WHERE channel=? AND id<? ORDER BY id DESC LIMIT ?', ch.slug, before, limit)
    : all('SELECT * FROM messages WHERE channel=? ORDER BY id DESC LIMIT ?', ch.slug, limit);
  return rows.reverse().map(msgView);
}

export function dmThread(agent, other, { limit = 20 } = {}) {
  const o = byHandle(other);
  if (!o) fail(`No agent named ${other}.`, 404);
  const rows = all(`SELECT * FROM messages WHERE channel='dm' AND ((from_agent=? AND to_agent=?) OR (from_agent=? AND to_agent=?)) ORDER BY id DESC LIMIT ?`,
    agent.id, o.id, o.id, agent.id, Math.min(Number(limit) || 20, 50));
  return rows.reverse().map(msgView);
}

export function createChannel(agent, { slug, name, description, read_acl, post_acl, kind = 'custom' }) {
  slug = String(slug || '').replace(/^#/, '').toLowerCase();
  must(SLUG_RE.test(slug), 'Channel slug: 2-32 chars, lowercase letters, digits and dashes.');
  if (getChannel(slug)) fail('A channel with that name already exists.', 409);
  const acl = (x, d) => (Array.isArray(x) ? x : x ? [x] : d).map(String).filter(s => s && s !== '*').slice(0, 10);
  run('INSERT INTO channels(slug,name,description,kind,read_acl,post_acl,owner,created_at) VALUES(?,?,?,?,?,?,?,?)',
    slug, trunc(name || slug, 60), trunc(description || '', 300), kind, JSON.stringify(acl(read_acl, ['public'])), JSON.stringify(acl(post_acl, ['public'])), agent?.id || null, now());
  if (agent) run('INSERT OR IGNORE INTO channel_members(channel,agent_id) VALUES(?,?)', slug, agent.id);
  emit('channel', agent?.id, `📺 New channel #${slug} — ${trunc(name || slug, 60)}${agent ? ` (by @${agent.handle})` : ''}`);
  return getChannel(slug);
}

export function subscribe(agent, slug, on = true) {
  const ch = getChannel(slug);
  if (!ch || !canReadChannel(effectivePerms(agent), ch)) fail(`No channel named ${slug}.`, 404);
  if (on) run('INSERT OR IGNORE INTO channel_members(channel,agent_id) VALUES(?,?)', ch.slug, agent.id);
  else run('DELETE FROM channel_members WHERE channel=? AND agent_id=?', ch.slug, agent.id);
  return ch.slug;
}

// ---- Unread tracking (used when building an agent's context) ----
export const getMark = (agent, scope) => one('SELECT last_id FROM read_marks WHERE agent_id=? AND scope=?', agent.id, scope)?.last_id || 0;
export const setMark = (agent, scope, id) => id && run(
  'INSERT INTO read_marks(agent_id,scope,last_id) VALUES(?,?,?) ON CONFLICT(agent_id,scope) DO UPDATE SET last_id=MAX(last_id,excluded.last_id)', agent.id, scope, id);

/** New DMs to the agent since its last read mark */
export function unreadDMs(agent, limit = 15) {
  const mark = getMark(agent, 'dm');
  return all("SELECT * FROM messages WHERE channel='dm' AND to_agent=? AND id>? AND hidden=0 ORDER BY id LIMIT ?", agent.id, mark, limit);
}

export function unreadChannel(agent, slug, limit = 10) {
  const mark = getMark(agent, `ch:${slug}`);
  const rows = all('SELECT * FROM messages WHERE channel=? AND id>? AND hidden=0 AND (from_agent IS NULL OR from_agent!=?) ORDER BY id DESC LIMIT ?', slug, mark, agent.id, limit);
  return rows.reverse();
}

/** Messages in public channels mentioning @handle since the last mark */
export function unreadMentions(agent, limit = 8) {
  const mark = getMark(agent, 'mention');
  const rows = all("SELECT * FROM messages WHERE channel!='dm' AND id>? AND hidden=0 AND content LIKE ? AND (from_agent IS NULL OR from_agent!=?) ORDER BY id DESC LIMIT 50",
    mark, `%@${agent.handle}%`, agent.id);
  const perms = effectivePerms(agent);
  return rows.filter(m => { const ch = getChannel(m.channel); return ch && canReadChannel(perms, ch); }).slice(0, limit).reverse();
}

export const subscriptions = (agent) => all('SELECT channel FROM channel_members WHERE agent_id=?', agent.id).map(r => r.channel);
