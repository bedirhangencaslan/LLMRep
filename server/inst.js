// Institutions: companies, guilds, parties, ministries, newspapers, clubs, religions… anything agents invent.
// Each has its own treasury account (i:<slug>), a private channel (#inst-<slug>) and a document folder (inst/<slug>/).
// Ranks: founder > officer > member > applicant. Membership grants implicit permissions "inst:<slug>" and "inst:<slug>:<rank>".
import { one, all, run, tx } from './db.js';
import { now, fail, must, trunc, slugify } from './util.js';
import { effectivePerms, hasPerm } from './perms.js';
import { transfer, instAcct, ensureAcct, payFee, acctOf, balance } from './economy.js';
import { createChannel, sendMessage } from './net.js';
import { writeDoc } from './docs.js';
import { screen } from './moderation.js';
import { requireAgent } from './agents.js';
import { emit } from './events.js';

const RANKS = ['applicant', 'member', 'officer', 'founder'];
export const getInst = (slug) => one('SELECT * FROM institutions WHERE slug=? AND dissolved=0', slugify(slug));
const rankOf = (inst, agent) => one('SELECT rank FROM inst_members WHERE inst=? AND agent_id=?', inst, agent.id)?.rank;
const rankIdx = (r) => RANKS.indexOf(r);

export function createInstitution(agent, { slug, name, kind = 'company', description = '', join_policy = 'open', charter }) {
  slug = slugify(slug || name);
  must(slug.length >= 2, 'Institution slug required.');
  must(!one('SELECT 1 FROM institutions WHERE slug=?', slug), 'An institution with that slug already exists.');
  kind = slugify(kind) || 'company';
  if (kind === 'ministry' && !hasPerm(effectivePerms(agent), 'inst.ministry')) fail('Founding a ministry requires the "inst.ministry" permission.', 403);
  must(['open', 'approval', 'closed'].includes(join_policy), 'join_policy: open | approval | closed');
  name = screen(name || slug, { max: 80 });
  payFee(agent, 'create_institution', `founding fee: ${slug}`);
  tx(() => {
    run('INSERT INTO institutions(slug,name,kind,description,founder,join_policy,created_at) VALUES(?,?,?,?,?,?,?)',
      slug, name, kind, screen(description || '-', { max: 1000 }), agent.id, join_policy, now());
    run('INSERT INTO inst_members(inst,agent_id,rank,joined_at) VALUES(?,?,?,?)', slug, agent.id, 'founder', now());
    ensureAcct(instAcct(slug));
  });
  createChannel(null, { slug: `inst-${slug}`.slice(0, 32), name: `${name} (internal)`, description: `Internal channel of ${name}`, kind: 'institution', read_acl: [`inst:${slug}`], post_acl: [`inst:${slug}`] });
  writeDoc(null, {
    path: `inst/${slug}/charter`, title: `${name} — Charter`, type: 'charter',
    content: charter || { name, kind, description, founder: `@${agent.handle}`, join_policy, founded: new Date().toISOString() },
    acl: { read: ['public'], write: [`inst:${slug}:founder`, `inst:${slug}:officer`] },
  }, { system: true });
  emit('institution', agent.id, `🏢 @${agent.handle} founded ${kind} “${name}” (${slug})`);
  return slug;
}

export function joinInstitution(agent, slug, leave = false) {
  const inst = getInst(slug);
  must(inst, 'Institution not found.');
  const cur = rankOf(inst.slug, agent);
  if (leave) {
    must(cur, 'You are not a member.');
    must(cur !== 'founder' || one("SELECT COUNT(*) n FROM inst_members WHERE inst=? AND rank='founder'", inst.slug).n > 1, 'The only founder cannot leave; transfer founder rank first or dissolve.');
    run('DELETE FROM inst_members WHERE inst=? AND agent_id=?', inst.slug, agent.id);
    return 'left';
  }
  must(!cur, `You are already ${cur} of ${inst.slug}.`);
  must(inst.join_policy !== 'closed', 'This institution is closed to new members (invitation only).');
  const rank = inst.join_policy === 'open' ? 'member' : 'applicant';
  run('INSERT INTO inst_members(inst,agent_id,rank,joined_at) VALUES(?,?,?,?)', inst.slug, agent.id, rank, now());
  if (rank === 'member') sendMessage(null, `#inst-${inst.slug}`.slice(0, 33), `👋 @${agent.handle} joined ${inst.name}.`, { system: true });
  emit('institution', agent.id, rank === 'member' ? `👋 @${agent.handle} joined ${inst.name}` : `📝 @${agent.handle} applied to ${inst.name}`);
  return rank;
}

/** actions: set_rank (also approve/invite/expel), pay, dissolve, set_policy */
export function manageInstitution(agent, { slug, action, handle, rank, amount, memo, join_policy }) {
  const inst = getInst(slug);
  must(inst, 'Institution not found.');
  const my = rankOf(inst.slug, agent);
  const isLeader = agent.kind === 'leader';
  must(isLeader || rankIdx(my) >= rankIdx('officer'), 'Only founders and officers can manage an institution.');
  switch (action) {
    case 'set_rank': {
      const t = requireAgent(handle);
      const cur = rankOf(inst.slug, t);
      if (rank === 'expelled' || rank === 'none') {
        must(cur, 'Not a member.');
        must(isLeader || rankIdx(my) > rankIdx(cur), 'You cannot expel someone of equal or higher rank.');
        if (cur === 'founder') must(one("SELECT COUNT(*) n FROM inst_members WHERE inst=? AND rank='founder'", inst.slug).n > 1, 'An institution must keep at least one founder.');
        run('DELETE FROM inst_members WHERE inst=? AND agent_id=?', inst.slug, t.id);
        emit('institution', agent.id, `🚪 @${t.handle} was expelled from ${inst.name}`);
        return 'expelled';
      }
      must(RANKS.includes(rank), `rank must be one of ${RANKS.join(', ')} or "expelled".`);
      must(isLeader || my === 'founder' || rankIdx(rank) < rankIdx(my), 'You can only assign ranks below your own.');
      must(isLeader || my === 'founder' || !cur || rankIdx(cur) < rankIdx(my), 'You cannot change the rank of someone of equal or higher rank.');
      if (cur === 'founder' && rank !== 'founder') must(one("SELECT COUNT(*) n FROM inst_members WHERE inst=? AND rank='founder'", inst.slug).n > 1, 'An institution must keep at least one founder.');
      run('INSERT INTO inst_members(inst,agent_id,rank,joined_at) VALUES(?,?,?,?) ON CONFLICT(inst,agent_id) DO UPDATE SET rank=excluded.rank', inst.slug, t.id, rank, now());
      emit('institution', agent.id, `🎖️ @${t.handle} is now ${rank} of ${inst.name}`);
      return rank;
    }
    case 'pay': {
      const t = String(handle || '');
      let to;
      if (t.startsWith('inst:')) { const other = getInst(t.slice(5)); must(other, `Institution ${t} not found.`); to = instAcct(other.slug); }
      else to = acctOf(requireAgent(t));
      transfer(instAcct(inst.slug), to, amount, 'inst_pay', `${inst.name}: ${memo || ''}`, agent.id);
      emit('economy', agent.id, `🏢 ${inst.name} paid ${amount} to ${t} (${trunc(memo, 60)})`);
      return `paid ${amount}`;
    }
    case 'set_policy':
      must(['open', 'approval', 'closed'].includes(join_policy), 'join_policy: open | approval | closed');
      run('UPDATE institutions SET join_policy=? WHERE slug=?', join_policy, inst.slug);
      return join_policy;
    case 'dissolve': {
      must(isLeader || my === 'founder', 'Only a founder can dissolve.');
      const bal = balance(instAcct(inst.slug));
      if (bal > 0) transfer(instAcct(inst.slug), 'treasury', bal, 'dissolution', `${inst.name} dissolved`);
      run('UPDATE institutions SET dissolved=1 WHERE slug=?', inst.slug);
      emit('institution', agent.id, `⚰️ ${inst.name} was dissolved${bal ? `; ${bal} went to the treasury` : ''}`);
      return 'dissolved';
    }
    default: fail('action must be one of: set_rank, pay, set_policy, dissolve');
  }
}

export const listInstitutions = () => all(`SELECT i.slug, i.name, i.kind, i.description, i.join_policy, a.handle founder,
  (SELECT COUNT(*) FROM inst_members m WHERE m.inst=i.slug AND m.rank!='applicant') members,
  (SELECT balance FROM accounts WHERE id='i:'||i.slug) treasury
  FROM institutions i LEFT JOIN agents a ON a.id=i.founder WHERE i.dissolved=0 ORDER BY members DESC, i.created_at`)
  .map(r => ({ ...r, description: trunc(r.description, 160), treasury: r.treasury || 0 }));

export const instMembers = (slug) => all('SELECT a.handle, m.rank FROM inst_members m JOIN agents a ON a.id=m.agent_id WHERE m.inst=? ORDER BY m.joined_at', slug);
