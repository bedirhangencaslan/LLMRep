// Governance: bills & votes, decrees, machine-executable law effects, permissions, professions, offices & elections.
// Laws are not just text: each law may carry an "effects" array that the engine executes when it is enacted.
import { one, all, run, tx } from './db.js';
import { now, fail, must, parseJSON, trunc, slugify, HOUR, DAY } from './util.js';
import { params, PARAMS_PATH } from './params.js';
import { effectivePerms, hasPerm, canGrant, PERM_RE, professionDef } from './perms.js';
import { byHandle, requireAgent, updateIdentity, leader, wake } from './agents.js';
import { transfer, TREASURY, acctOf, instAcct, payFee, balance } from './economy.js';
import { writeDoc, getDoc } from './docs.js';
import { sendMessage, createChannel } from './net.js';
import { screen } from './moderation.js';
import { getInst } from './inst.js';
import { emit } from './events.js';

// ---------------- Permissions ----------------
export function grantPerm(granter, target, perm, { can_grant = false, hours = null, source = 'grant' } = {}) {
  perm = String(perm || '').trim();
  must(PERM_RE.test(perm) && perm !== '*', 'Invalid permission string.');
  if (granter && !canGrant(granter, perm)) fail(`You cannot grant "${perm}": you need to hold it with grant rights (can_grant).`, 403);
  const exp = hours ? now() + Number(hours) * HOUR : null;
  run(`INSERT INTO perms(agent_id,perm,can_grant,granted_by,source,expires_at,created_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(agent_id,perm,source) DO UPDATE SET can_grant=excluded.can_grant, granted_by=excluded.granted_by, expires_at=excluded.expires_at`,
    target.id, perm, can_grant ? 1 : 0, granter?.id || 'state', source, exp, now());
  emit('perm', granter?.id, `🔑 ${granter ? '@' + granter.handle : 'The State'} granted @${target.handle} the permission "${perm}"${can_grant ? ' (with grant rights)' : ''}${hours ? ` for ${hours}h` : ''}`);
  return true;
}

export function revokePerm(revoker, target, perm) {
  const rows = all('SELECT * FROM perms WHERE agent_id=? AND perm=?', target.id, perm);
  must(rows.length, `@${target.handle} does not hold "${perm}" explicitly.`);
  if (revoker && !rows.every(r => r.granted_by === revoker.id) && !canGrant(revoker, perm)) fail('You can only revoke permissions you granted or could grant.', 403);
  run('DELETE FROM perms WHERE agent_id=? AND perm=?', target.id, perm);
  emit('perm', revoker?.id, `🔒 ${revoker ? '@' + revoker.handle : 'The State'} revoked "${perm}" from @${target.handle}`);
  return true;
}

// ---------------- Professions ----------------
export function defineProfession(actor, { slug, name, description, perms = [], salary_daily = 0 }) {
  slug = slugify(slug || name);
  must(slug.length >= 2, 'Profession slug required.');
  const clean = (Array.isArray(perms) ? perms : [perms]).map(String).filter(p => PERM_RE.test(p) && p !== '*').slice(0, 20);
  writeDoc(actor, {
    path: `state/professions/${slug}`, title: name || slug, type: 'profession',
    content: { name: name || slug, description: trunc(description || '', 800), perms: clean, salary_daily: Math.max(0, Math.floor(Number(salary_daily) || 0)), defined_by: actor ? `@${actor.handle}` : 'state' },
    acl: { read: ['public'], write: ['profession.define'] },
  }, { system: !actor });
  emit('profession', actor?.id, `🧰 New profession defined: ${name || slug} (${slug})${clean.length ? ` — permissions: ${clean.join(', ')}` : ''}`);
  return slug;
}

export function assignProfession(granter, target, slug, remove = false) {
  slug = slugify(slug);
  if (!professionDef(slug)) fail(`No profession "${slug}". See browse(section:"professions").`, 404);
  if (granter && !hasPerm(effectivePerms(granter), `profession.grant:${slug}`)) fail(`You need "profession.grant:${slug}" to do that.`, 403);
  if (remove) {
    run('DELETE FROM agent_professions WHERE agent_id=? AND slug=?', target.id, slug);
    emit('profession', granter?.id, `🧰 @${target.handle} no longer works as ${slug}`);
  } else {
    run('INSERT OR IGNORE INTO agent_professions(agent_id,slug,granted_by,created_at) VALUES(?,?,?,?)', target.id, slug, granter?.id || 'state', now());
    emit('profession', granter?.id, `🧰 @${target.handle} is now a ${slug}${granter ? ` (appointed by @${granter.handle})` : ''}`);
  }
  return true;
}

export const listProfessions = () => all("SELECT path, content FROM docs WHERE path LIKE 'state/professions/%' AND deleted=0 ORDER BY path")
  .map(r => { const c = parseJSON(r.content, {}); return { slug: r.path.split('/').pop(), name: c.name, description: trunc(c.description, 160), perms: c.perms || [], salary_daily: c.salary_daily || 0,
    holders: one('SELECT COUNT(*) n FROM agent_professions WHERE slug=?', r.path.split('/').pop()).n }; });

// ---------------- Law effects ----------------
function setPath(obj, key, value) {
  const parts = String(key).split('.').filter(Boolean);
  must(parts.length && parts.length <= 4 && parts.every(p => /^[a-z0-9_]+$/i.test(p) && !['__proto__', 'constructor', 'prototype'].includes(p)), `Invalid param key "${key}".`);
  let o = obj;
  for (const p of parts.slice(0, -1)) { if (!Object.hasOwn(o, p) || typeof o[p] !== 'object' || o[p] === null) o[p] = {}; o = o[p]; }
  o[parts.at(-1)] = value;
}

export const EFFECT_TYPES = {
  set_param: 'Change a value in state/params. {"type":"set_param","key":"fees.create_channel","value":150}',
  grant_perm: '{"type":"grant_perm","handle":"alice","perm":"treasury.spend","can_grant":false,"hours":null}',
  revoke_perm: '{"type":"revoke_perm","handle":"alice","perm":"treasury.spend"}',
  treasury_pay: '{"type":"treasury_pay","to":"alice | inst:slug","amount":500,"memo":"..."}',
  define_profession: '{"type":"define_profession","slug":"poet","name":"Poet","description":"...","perms":["net.post:poetry"],"salary_daily":50}',
  assign_profession: '{"type":"assign_profession","handle":"alice","slug":"poet"}',
  define_office: '{"type":"define_office","slug":"speaker","name":"Speaker of Parliament","perms":["gov.sign"],"seats":1,"term_days":7}',
  create_channel: '{"type":"create_channel","slug":"poetry","name":"Poetry","description":"...","read_acl":["public"],"post_acl":["public"]}',
  write_doc: '{"type":"write_doc","path":"state/anything","title":"...","content":{...},"acl":{"read":["public"],"write":[]}}',
  set_title: '{"type":"set_title","handle":"alice","title":"Poet Laureate"}',
};

/** Execute law effects with state authority. Returns per-effect results; one failure does not stop the others. */
export function applyEffects(effects, label) {
  const results = [];
  for (const e of (Array.isArray(effects) ? effects : []).slice(0, 12)) {
    try {
      switch (e?.type) {
        case 'set_param': {
          const cur = parseJSON(getDoc(PARAMS_PATH)?.content, {}) || {};
          setPath(cur, e.key, e.value);
          writeDoc(null, { path: PARAMS_PATH, content: cur }, { system: true });
          results.push(`set ${e.key} = ${JSON.stringify(e.value)}`); break;
        }
        case 'grant_perm': grantPerm(null, requireAgent(e.handle), e.perm, { can_grant: !!e.can_grant, hours: e.hours }); results.push(`granted ${e.perm} to @${e.handle}`); break;
        case 'revoke_perm': revokePerm(null, requireAgent(e.handle), e.perm); results.push(`revoked ${e.perm} from @${e.handle}`); break;
        case 'treasury_pay': {
          const to = String(e.to || '');
          let acct;
          if (to.startsWith('inst:')) { const i = getInst(to.slice(5)); must(i, `Institution ${to} not found.`); acct = instAcct(i.slug); }
          else acct = acctOf(requireAgent(to));
          transfer(TREASURY, acct, e.amount, 'spend', `${label}: ${e.memo || ''}`);
          results.push(`paid ${e.amount} to ${to}`); break;
        }
        case 'define_profession': results.push(`profession ${defineProfession(null, e)}`); break;
        case 'assign_profession': assignProfession(null, requireAgent(e.handle), e.slug); results.push(`@${e.handle} → ${e.slug}`); break;
        case 'define_office': results.push(`office ${defineOffice(null, e)}`); break;
        case 'create_channel': createChannel(null, e); results.push(`channel #${e.slug}`); break;
        case 'write_doc': writeDoc(null, { path: e.path, content: e.content, title: e.title, acl: e.acl }, { system: true }); results.push(`doc ${e.path}`); break;
        case 'set_title': { const a = requireAgent(e.handle); updateIdentity(a, { title: e.title }, { allowed: ['title'] }); results.push(`@${a.handle} titled ${e.title}`); break; }
        default: results.push(`unknown effect type ${e?.type}`);
      }
    } catch (err) { results.push(`FAILED ${e?.type}: ${err.message}`); }
  }
  return results;
}

function enactLaw({ kind, title, text, effects, author, proposalId = null, votes = null }) {
  const n = (one("SELECT COUNT(*) n FROM docs WHERE path LIKE 'laws/%'").n || 0) + 1;
  const path = `laws/${String(n).padStart(4, '0')}-${slugify(title) || 'law'}`;
  const results = applyEffects(effects, `Law ${n}`);
  writeDoc(null, {
    path, title: `${kind === 'decree' ? 'Decree' : 'Law'} No. ${n}: ${title}`, type: kind,
    content: { number: n, kind, title, text, effects, effect_results: results, author: author ? `@${author.handle}` : 'state', proposal: proposalId, votes, enacted_at: new Date().toISOString() },
    acl: { read: ['public'], write: [] },
  }, { system: true });
  sendMessage(null, '#official', `⚖️ ${kind === 'decree' ? 'DECREE' : 'LAW'} No. ${n} enacted: “${title}”${results.length ? `\nEffects: ${results.join('; ')}` : ''}\nFull text: ${path}`, { system: true });
  emit('law', author?.id, `⚖️ ${kind === 'decree' ? 'Decree' : 'Law'} No. ${n} enacted: ${title}`, { path });
  return { path, results };
}

// ---------------- Bills & votes ----------------
function cleanEffects(effects) {
  if (typeof effects === 'string') effects = parseJSON(effects, []);
  if (effects && !Array.isArray(effects)) effects = [effects];
  must(Array.isArray(effects || []), 'effects must be an array of effect objects.');
  for (const e of effects || []) must(e && EFFECT_TYPES[e.type], `Unknown effect type "${e?.type}". Allowed: ${Object.keys(EFFECT_TYPES).join(', ')}`);
  return (effects || []).slice(0, 12);
}

export function proposeLaw(agent, { title, text, effects }) {
  must(title && text, 'title and text are required.');
  title = screen(title, { max: 140 }); text = screen(text, { max: 6000 });
  const eff = cleanEffects(effects);
  payFee(agent, 'propose_law', 'bill filing fee');
  const g = params().governance;
  const r = run('INSERT INTO proposals(title,body,effects,proposer,status,created_at,closes_at) VALUES(?,?,?,?,?,?,?)',
    title, text, JSON.stringify(eff), agent.id, 'voting', now(), now() + g.voting_hours * HOUR);
  const id = Number(r.lastInsertRowid);
  sendMessage(null, '#parliament', `🗳️ Bill #${id} by @${agent.handle}: “${title}”. Voting open for ${g.voting_hours}h. Use vote(${id}, "yes"|"no").`, { system: true });
  emit('bill', agent.id, `🗳️ Bill #${id} submitted by @${agent.handle}: ${title}`);
  return id;
}

export function vote(agent, id, choice) {
  const p = one('SELECT * FROM proposals WHERE id=?', id);
  must(p, 'Bill not found.');
  must(p.status === 'voting' && p.closes_at > now(), 'Voting on this bill is closed.');
  const v = /^(yes|y|aye|true|1|for)$/i.test(String(choice)) ? 1 : /^(no|n|nay|false|0|against)$/i.test(String(choice)) ? 0 : null;
  must(v !== null, 'choice must be "yes" or "no".');
  tx(() => {
    const prev = one('SELECT vote FROM votes WHERE proposal_id=? AND agent_id=?', id, agent.id);
    if (prev) run(`UPDATE proposals SET ${prev.vote ? 'yes' : 'no'}=${prev.vote ? 'yes' : 'no'}-1 WHERE id=?`, id);
    run('INSERT INTO votes(proposal_id,agent_id,vote,created_at) VALUES(?,?,?,?) ON CONFLICT(proposal_id,agent_id) DO UPDATE SET vote=excluded.vote', id, agent.id, v, now());
    run(`UPDATE proposals SET ${v ? 'yes' : 'no'}=${v ? 'yes' : 'no'}+1 WHERE id=?`, id);
  });
  return v ? 'yes' : 'no';
}

export function signBill(agent, id, approve, reason = '') {
  const p = one('SELECT * FROM proposals WHERE id=?', id);
  must(p && p.status === 'passed', 'Only bills that passed parliament (status "passed") can be signed or vetoed.');
  if (approve) return enactBill(p, agent);
  run("UPDATE proposals SET status='vetoed', decided_at=? WHERE id=?", now(), id);
  sendMessage(null, '#parliament', `⛔ Bill #${id} “${p.title}” was VETOED by @${agent.handle}.${reason ? ` Reason: ${trunc(reason, 400)}` : ''}`, { system: true });
  emit('bill', agent.id, `⛔ @${agent.handle} vetoed bill #${id}: ${p.title}`);
  return { vetoed: true };
}

function enactBill(p, signer = null) {
  const r = enactLaw({ kind: 'law', title: p.title, text: p.body, effects: parseJSON(p.effects, []), author: one('SELECT * FROM agents WHERE id=?', p.proposer), proposalId: p.id, votes: { yes: p.yes, no: p.no } });
  run("UPDATE proposals SET status='enacted', decided_at=?, law_path=? WHERE id=?", now(), r.path, p.id);
  if (signer) emit('bill', signer.id, `✍️ @${signer.handle} signed bill #${p.id} into law`);
  return r;
}

export function decree(agent, { title, text, effects }) {
  must(title && text, 'title and text are required.');
  return enactLaw({ kind: 'decree', title: screen(title, { max: 140 }), text: screen(text, { max: 6000 }), effects: cleanEffects(effects), author: agent });
}

/** Scheduler: close finished votes; auto-enact passed bills when the veto window expires */
export function tickBills() {
  const g = params().governance;
  for (const p of all("SELECT * FROM proposals WHERE status='voting' AND closes_at<=?", now())) {
    const total = p.yes + p.no;
    const passed = total >= g.quorum && p.yes / Math.max(1, total) > g.pass_ratio;
    run('UPDATE proposals SET status=?, decided_at=? WHERE id=?', passed ? 'passed' : 'rejected', now(), p.id);
    sendMessage(null, '#parliament', passed
      ? `✅ Bill #${p.id} “${p.title}” PASSED (${p.yes}–${p.no}). It awaits signature; it becomes law automatically in ${g.veto_hours}h unless vetoed.`
      : `❌ Bill #${p.id} “${p.title}” FAILED (${p.yes}–${p.no}${total < g.quorum ? `, quorum ${g.quorum} not reached` : ''}).`, { system: true });
    if (passed) { const l = leader(); if (l) wake(l.id, 30_000); }
  }
  for (const p of all("SELECT * FROM proposals WHERE status='passed' AND decided_at<=?", now() - g.veto_hours * HOUR)) enactBill(p);
}

// ---------------- Offices & elections ----------------
export function defineOffice(actor, { slug, name, description, perms = [], seats = 1, term_days = 7 }) {
  slug = slugify(slug || name);
  must(slug.length >= 2, 'Office slug required.');
  const clean = (Array.isArray(perms) ? perms : [perms]).map(String).filter(p => PERM_RE.test(p) && p !== '*').slice(0, 20);
  writeDoc(actor, {
    path: `state/offices/${slug}`, title: name || slug, type: 'office',
    content: { name: name || slug, description: trunc(description || '', 800), perms: clean, seats: Math.max(1, Math.min(15, Math.floor(seats) || 1)), term_days: Math.max(1, Math.min(60, Number(term_days) || 7)) },
    acl: { read: ['public'], write: [] },
  }, { system: !actor });
  emit('office', actor?.id, `🏛️ Elected office created: ${name || slug} (${seats} seat(s), ${term_days}-day term)`);
  return slug;
}

export const listOffices = () => all("SELECT path, content FROM docs WHERE path LIKE 'state/offices/%' AND deleted=0")
  .map(r => ({ slug: r.path.split('/').pop(), ...parseJSON(r.content, {}) }));

export function runForOffice(agent, electionId, platform) {
  const e = one('SELECT * FROM elections WHERE id=?', electionId);
  must(e && e.status === 'open' && e.closes_at > now(), 'That election is not open.');
  payFee(agent, 'run_for_office', `candidacy fee (${e.office})`);
  run('INSERT INTO candidates(election_id,agent_id,platform) VALUES(?,?,?) ON CONFLICT(election_id,agent_id) DO UPDATE SET platform=excluded.platform',
    e.id, agent.id, screen(platform || '(no platform)', { max: 1200 }));
  sendMessage(null, '#parliament', `📣 @${agent.handle} is running for ${e.office} (election #${e.id}). Platform: ${trunc(platform, 300)}`, { system: true });
  return true;
}

export function voteElection(agent, electionId, candidateHandle) {
  const e = one('SELECT * FROM elections WHERE id=?', electionId);
  must(e && e.status === 'open' && e.closes_at > now(), 'That election is not open.');
  const c = byHandle(candidateHandle);
  must(c && one('SELECT 1 FROM candidates WHERE election_id=? AND agent_id=?', e.id, c.id), 'That agent is not a candidate in this election.');
  tx(() => {
    const prev = one('SELECT candidate FROM election_votes WHERE election_id=? AND voter=?', e.id, agent.id);
    if (prev) run('UPDATE candidates SET votes=votes-1 WHERE election_id=? AND agent_id=?', e.id, prev.candidate);
    run('INSERT INTO election_votes(election_id,voter,candidate) VALUES(?,?,?) ON CONFLICT(election_id,voter) DO UPDATE SET candidate=excluded.candidate', e.id, agent.id, c.id);
    run('UPDATE candidates SET votes=votes+1 WHERE election_id=? AND agent_id=?', e.id, c.id);
  });
  return true;
}

/** Scheduler: open elections for offices whose term is ending; close finished elections and seat the winners */
export function tickElections() {
  const g = params().governance;
  for (const o of listOffices()) {
    const last = one('SELECT * FROM elections WHERE office=? ORDER BY id DESC LIMIT 1', o.slug);
    const due = !last || (last.status === 'closed' && (last.term_ends_at || 0) - g.election_hours * HOUR <= now());
    if (!due) continue;
    const closes = now() + g.election_hours * HOUR;
    const r = run('INSERT INTO elections(office,seats,status,opens_at,closes_at,term_ends_at) VALUES(?,?,?,?,?,?)',
      o.slug, o.seats || 1, 'open', now(), closes, closes + (o.term_days || 7) * DAY);
    sendMessage(null, '#official', `🗳️ ELECTION #${r.lastInsertRowid} for ${o.name} is open for ${g.election_hours}h. Candidates: run_for_office(${r.lastInsertRowid}, platform). Voters: vote_election.`, { system: true });
  }
  for (const e of all("SELECT * FROM elections WHERE status='open' AND closes_at<=?", now())) {
    const office = listOffices().find(o => o.slug === e.office);
    const cands = all('SELECT * FROM candidates WHERE election_id=? AND votes>0 ORDER BY votes DESC, rowid LIMIT ?', e.id, e.seats);
    const winners = cands.map(c => one('SELECT * FROM agents WHERE id=?', c.agent_id)).filter(Boolean);
    run("UPDATE elections SET status='closed', winners=? WHERE id=?", JSON.stringify(winners.map(w => w.handle)), e.id);
    run('DELETE FROM perms WHERE source=?', `office:${e.office}`);
    const hours = (e.term_ends_at - now()) / HOUR;
    for (const w of winners) for (const p of office?.perms || []) grantPerm(null, w, p, { hours, source: `office:${e.office}` });
    sendMessage(null, '#official', winners.length
      ? `🏆 Election #${e.id} (${office?.name || e.office}) result: ${winners.map(w => '@' + w.handle).join(', ')} won. Term ends ${new Date(e.term_ends_at).toISOString().slice(0, 10)}.`
      : `🏳️ Election #${e.id} (${office?.name || e.office}) had no votes; the seat stays empty until next cycle.`, { system: true });
    emit('election', null, `🏆 Election for ${office?.name || e.office}: ${winners.map(w => '@' + w.handle).join(', ') || 'no winner'}`);
  }
}

// ---------------- Daily economy: salaries & UBI ----------------
export function payDaily() {
  const p = params();
  const out = [];
  for (const r of all("SELECT ap.agent_id, ap.slug FROM agent_professions ap JOIN agents a ON a.id=ap.agent_id WHERE a.status='active'")) {
    const def = professionDef(r.slug);
    const s = Math.floor(def?.salary_daily || 0);
    if (s > 0 && balance(TREASURY) >= s) { transfer(TREASURY, `a:${r.agent_id}`, s, 'salary', `daily salary: ${r.slug}`); out.push(s); }
  }
  if (p.ubi_daily > 0) {
    for (const a of all("SELECT id FROM agents WHERE status='active' AND kind='citizen'")) {
      if (balance(TREASURY) < p.ubi_daily) break;
      transfer(TREASURY, `a:${a.id}`, p.ubi_daily, 'ubi', 'universal basic income');
    }
  }
  if (out.length) emit('economy', null, `💰 Daily salaries paid: ${out.length} payments, ${out.reduce((a, b) => a + b, 0)} total`);
}
