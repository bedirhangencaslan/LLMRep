// Tool registry: the ONLY way any agent (leader, officials, citizens) acts on the world.
// The same executor serves server-run agents and remote citizen runners, so permissions are enforced in one place.
// Each tool is shown to an agent only if it is visible to it: agents never even learn about powers they lack.
import { one, all, run, tx } from './db.js';
import { now, fail, must, trunc, today, parseJSON, UserError } from './util.js';
import { params } from './params.js';
import { effectivePerms, hasPerm, hasGrantAbility, PERM_CATALOG } from './perms.js';
import { getAgent, requireAgent, updateIdentity, renderIdentity, publicCard, isSuspended, createAgent, byHandle } from './agents.js';
import { produce, chargeAction, transfer, acctOf, instAcct, TREASURY, payFee, balance, ledgerFor } from './economy.js';
import { writeDoc, deleteDoc, readDocFor, searchDocs, appendNote, getDoc, normPath, canRead } from './docs.js';
import { sendMessage, listChannels, readChannel, dmThread, createChannel, subscribe } from './net.js';
import * as gov from './gov.js';
import * as inst from './inst.js';
import * as jobs from './jobs.js';
import * as court from './court.js';
import { screen } from './moderation.js';
import { emit, journal } from './events.js';
import { config } from './config.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const I = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const B = (description) => ({ type: 'boolean', description });
const A = (description) => ({ type: 'array', items: { type: 'string' }, description });

const anyGrantProfession = (p) => p.some(x => x === '*' || x.startsWith('profession.grant:'));

export const TOOLS = [
  // ------------------------------------------------ reading (free)
  { name: 'list_channels', desc: 'List communication channels you can read (and whether you can post).', params: {}, run: ({ agent }) => listChannels(agent) },
  { name: 'read_channel', desc: 'Read recent messages of a channel, e.g. "#square".', params: { channel: S('Channel like "#square"'), limit: I('Max messages (default 20)'), before: I('Only messages with id lower than this') }, required: ['channel'],
    run: ({ agent }, a) => readChannel(agent, a.channel, a) },
  { name: 'read_dms', desc: 'Read your direct-message conversation with another agent.', params: { with: S('Other agent handle, e.g. "@alice"'), limit: I('Max messages') }, required: ['with'],
    run: ({ agent }, a) => dmThread(agent, a.with, a) },
  { name: 'search_docs', desc: 'Search the state archive (JSON documents) you are allowed to read. Filter by words and/or path prefix like "laws/" or "state/".', params: { query: S('Search words'), prefix: S('Path prefix'), limit: I('Max results') },
    run: ({ agent }, a) => searchDocs(agent, a) },
  { name: 'read_doc', desc: 'Read a JSON document by path.', params: { path: S('Document path, e.g. "state/constitution"') }, required: ['path'], run: ({ agent }, a) => readDocFor(agent, a.path) },
  { name: 'list_agents', desc: 'Directory of agents (public cards). Optionally filter by text.', params: { query: S('Filter by handle/name/title'), limit: I('Max results') },
    run: (_, a) => all("SELECT * FROM agents WHERE status!='deleted' AND kind!='system' AND (handle LIKE ? OR name LIKE ? OR identity LIKE ?) ORDER BY reputation DESC, created_at LIMIT ?",
      `%${a.query || ''}%`, `%${a.query || ''}%`, `%${a.query || ''}%`, Math.min(a.limit || 25, 50)).map(publicCard) },
  { name: 'view_profile', desc: 'View an agent\'s public identity JSON (never their private instructions).', params: { handle: S('Agent handle') }, required: ['handle'],
    run: (_, a) => renderIdentity(requireAgent(a.handle)) },
  { name: 'browse', desc: 'Browse state registers. section: bills | laws | jobs | my_jobs | institutions | court | elections | professions | offices | ledger | permissions | market. filter: optional (status for bills/jobs, slug for institutions).',
    params: { section: S('Which register', { enum: ['bills', 'laws', 'jobs', 'my_jobs', 'institutions', 'court', 'elections', 'professions', 'offices', 'ledger', 'permissions', 'market'] }), filter: S('Optional filter') }, required: ['section'],
    run: ({ agent }, a) => browse(agent, a.section, a.filter) },

  // ------------------------------------------------ communication
  { name: 'send_message', desc: 'Send a message. to="@handle" for a private DM, or "#channel" to post publicly (e.g. "#square" reaches everyone). Mention others with @handle.', write: true,
    params: { to: S('"@handle" or "#channel"'), text: S('Message text'), reply_to: I('Optional message id you are replying to') }, required: ['to', 'text'],
    run: (ctx, a) => { const r = sendMessage(ctx.agent, a.to, a.text, { reply_to: a.reply_to }); ctx.produce(r.content); return { sent: true, message_id: r.id }; } },
  { name: 'create_channel', desc: 'Create a new channel (costs a fee). read_acl/post_acl are permission lists, e.g. ["public"] or ["inst:myguild"].', write: true,
    params: { slug: S('Short name, lowercase-with-dashes'), name: S('Display name'), description: S('What it is for'), read_acl: A('Who can read'), post_acl: A('Who can post') }, required: ['slug', 'name'],
    run: ({ agent }, a) => { payFee(agent, 'create_channel', `channel #${a.slug}`); const c = createChannel(agent, { ...a, name: screen(a.name, { max: 60 }), description: a.description ? screen(a.description, { max: 300 }) : '' }); return { created: `#${c.slug}` }; } },
  { name: 'subscribe', desc: 'Subscribe (or unsubscribe) to a channel so its new messages show up in your context.', write: true,
    params: { channel: S('"#channel"'), on: B('true to subscribe, false to leave') }, required: ['channel'], run: ({ agent }, a) => ({ channel: subscribe(agent, a.channel, a.on !== false), subscribed: a.on !== false }) },

  // ------------------------------------------------ memory & documents
  { name: 'note', desc: 'Write to your private notebook (your long-term memory; no other agent can read it).', write: true,
    params: { text: S('What to remember') }, required: ['text'], run: ({ agent }, a) => ({ notes: appendNote(agent, screen(a.text, { max: 1000 })) }) },
  { name: 'write_doc', desc: 'Create or update a JSON document. You may write in agents/<your-handle>/..., public/..., inst/<your-institution>/..., or any path your permissions allow. content is JSON (object/array/string). Invent any structure you like. read_acl/write_acl are permission lists (["public"], ["agent:bob"], ["inst:guild"], ["some.perm"]); an empty read_acl makes it private.', write: true,
    params: { path: S('Path like "public/maps/north-coast"'), content: S('JSON content (or plain text)'), title: S('Title'), type: S('Your own type name, e.g. "poem", "budget", "map"'), schema: S('Optional path of a schema document to validate against'), read_acl: A('Who may read'), write_acl: A('Who may edit') },
    required: ['path', 'content'],
    run: (ctx, a) => {
      const acl = a.read_acl || a.write_acl ? { read: a.read_acl ?? ['public'], write: a.write_acl ?? [] } : undefined;
      const r = writeDoc(ctx.agent, { path: a.path, content: a.content, title: a.title, type: a.type, schema: a.schema, acl });
      const isPublic = parseJSON(r.doc.acl, {}).read?.length > 0;
      if (isPublic && r.addedChars > 0) ctx.produce(JSON.stringify(parseJSON(r.doc.content)).slice(-r.addedChars));
      return { path: r.doc.path, version: r.doc.version, created: r.created };
    } },
  { name: 'delete_doc', desc: 'Delete a document you own.', write: true, params: { path: S('Path') }, required: ['path'], run: ({ agent }, a) => ({ deleted: deleteDoc(agent, a.path) }) },
  { name: 'sell_doc', desc: 'Put a document you own up for sale (or withdraw it with price 0). Buyers pay you and become the owner.', write: true,
    params: { path: S('Path of a document you own'), price: I('Price, 0 = not for sale') }, required: ['path', 'price'],
    run: ({ agent }, a) => {
      const d = getDoc(normPath(a.path)); must(d && !d.deleted && d.owner === agent.id, 'You do not own that document.');
      const price = Math.max(0, Math.floor(a.price)); run('UPDATE docs SET price=? WHERE id=?', price || null, d.id);
      if (price) emit('market', agent.id, `🏷️ @${agent.handle} is selling ${d.path} for ${price}`);
      return { path: d.path, price: price || 'not for sale' };
    } },
  { name: 'buy_doc', desc: 'Buy a document that is for sale (see browse section "market"). You become its owner.', write: true,
    params: { path: S('Path') }, required: ['path'],
    run: ({ agent }, a) => {
      const d = getDoc(normPath(a.path)); must(d && !d.deleted && d.price > 0 && canRead(agent, d), 'That document is not for sale.');
      must(d.owner !== agent.id, 'You already own it.');
      const seller = getAgent(d.owner);
      transfer(acctOf(agent), seller ? acctOf(seller) : TREASURY, d.price, 'purchase', `bought ${d.path}`, agent.id);
      run('UPDATE docs SET owner=?, price=NULL, updated_at=? WHERE id=?', agent.id, now(), d.id);
      emit('market', agent.id, `🛒 @${agent.handle} bought ${d.path} from @${seller?.handle || 'state'} for ${d.price}`);
      return { owned: d.path, paid: d.price };
    } },
  { name: 'update_identity', desc: 'Edit your own identity JSON: name, bio, motto, avatar (emoji), values (list), custom (any JSON object).', write: true,
    params: { name: S('Display name'), bio: S('Short biography'), motto: S('Motto'), avatar: S('One emoji'), values: A('Your values'), custom: S('JSON object with any extra fields you want') },
    run: ({ agent }, a) => {
      const patch = { ...a };
      for (const k of ['name', 'bio', 'motto']) if (patch[k]) patch[k] = screen(patch[k], { max: 600 });
      if (typeof patch.custom === 'string') patch.custom = parseJSON(patch.custom, { note: patch.custom });
      return renderIdentity(updateIdentity(agent, patch), { forSelf: true });
    } },

  // ------------------------------------------------ economy
  { name: 'transfer', desc: 'Send money to an agent ("@handle") or an institution ("inst:slug").', write: true,
    params: { to: S('"@handle" or "inst:slug"'), amount: I('Amount'), memo: S('Reason') }, required: ['to', 'amount'],
    run: ({ agent }, a) => {
      const to = String(a.to).startsWith('inst:') ? instAcct(a.to.slice(5)) : acctOf(requireAgent(a.to));
      if (to.startsWith('i:')) must(inst.getInst(a.to.slice(5)), 'Institution not found.');
      transfer(acctOf(agent), to, a.amount, 'transfer', a.memo ? screen(a.memo, { max: 200 }) : '', agent.id);
      emit('economy', agent.id, `💸 @${agent.handle} → ${a.to}: ${a.amount}${a.memo ? ` (${trunc(a.memo, 60)})` : ''}`);
      return { sent: a.amount, balance: balance(acctOf(agent)) };
    } },
  { name: 'endorse', desc: 'Publicly endorse another agent (+1 reputation; once per agent per day).', write: true,
    params: { handle: S('Agent'), reason: S('Why') }, required: ['handle', 'reason'],
    run: (ctx, a) => {
      const t = requireAgent(a.handle); must(t.id !== ctx.agent.id, 'You cannot endorse yourself.');
      const r = run('INSERT OR IGNORE INTO endorsements(from_agent,to_agent,day,reason,created_at) VALUES(?,?,?,?,?)', ctx.agent.id, t.id, today(), screen(a.reason, { max: 300 }), now());
      must(r.changes, 'You already endorsed this agent today.');
      run('UPDATE agents SET reputation=reputation+1 WHERE id=?', t.id);
      emit('endorse', ctx.agent.id, `⭐ @${ctx.agent.handle} endorsed @${t.handle}: ${trunc(a.reason, 100)}`);
      return { endorsed: t.handle };
    } },

  // ------------------------------------------------ governance
  { name: 'propose_law', desc: 'Submit a bill to parliament (fee). effects is an optional JSON array of machine-executable effects applied if it becomes law (see state/guide/law-effects).', write: true, perm: 'gov.propose',
    params: { title: S('Bill title'), text: S('Full text of the bill'), effects: S('Optional JSON array of effects') }, required: ['title', 'text'],
    run: (ctx, a) => { const id = gov.proposeLaw(ctx.agent, a); ctx.produce(a.title + '\n' + a.text); return { bill_id: id }; } },
  { name: 'vote', desc: 'Vote on an open bill.', write: true, perm: 'gov.vote',
    params: { bill_id: I('Bill id'), choice: S('yes or no', { enum: ['yes', 'no'] }) }, required: ['bill_id', 'choice'],
    visible: () => !!one("SELECT 1 FROM proposals WHERE status='voting' LIMIT 1"), run: ({ agent }, a) => ({ voted: gov.vote(agent, a.bill_id, a.choice) }) },
  { name: 'run_for_office', desc: 'Become a candidate in an open election (fee).', write: true,
    params: { election_id: I('Election id'), platform: S('Your campaign platform') }, required: ['election_id', 'platform'],
    visible: () => !!one("SELECT 1 FROM elections WHERE status='open' LIMIT 1"),
    run: (ctx, a) => { gov.runForOffice(ctx.agent, a.election_id, a.platform); ctx.produce(a.platform); return { candidate: true }; } },
  { name: 'vote_election', desc: 'Vote for a candidate in an open election.', write: true, perm: 'gov.vote',
    params: { election_id: I('Election id'), handle: S('Candidate handle') }, required: ['election_id', 'handle'],
    visible: () => !!one("SELECT 1 FROM elections WHERE status='open' LIMIT 1"), run: ({ agent }, a) => ({ voted: gov.voteElection(agent, a.election_id, a.handle) }) },

  // ------------------------------------------------ institutions
  { name: 'create_institution', desc: 'Found an institution (company, guild, party, newspaper, church, club, ministry…) with its own treasury, private channel and document folder (fee).', write: true,
    params: { slug: S('short-name'), name: S('Full name'), kind: S('company | guild | party | newspaper | club | religion | school | ministry | …'), description: S('Mission'), join_policy: S('open | approval | closed', { enum: ['open', 'approval', 'closed'] }) }, required: ['slug', 'name', 'description'],
    run: (ctx, a) => { const s = inst.createInstitution(ctx.agent, a); ctx.produce(a.name + ' ' + a.description); return { founded: s, channel: `#inst-${s}`, folder: `inst/${s}/` }; } },
  { name: 'join_institution', desc: 'Join (or leave) an institution.', write: true,
    params: { slug: S('Institution slug'), leave: B('true to leave') }, required: ['slug'], run: ({ agent }, a) => ({ status: inst.joinInstitution(agent, a.slug, !!a.leave) }) },
  { name: 'manage_institution', desc: 'For founders/officers: set_rank (applicant|member|officer|founder|expelled), pay (from the institution treasury), set_policy, dissolve.', write: true,
    params: { slug: S('Institution'), action: S('set_rank | pay | set_policy | dissolve', { enum: ['set_rank', 'pay', 'set_policy', 'dissolve'] }), handle: S('Target agent (or inst:slug for pay)'), rank: S('New rank'), amount: I('Amount for pay'), memo: S('Memo'), join_policy: S('open | approval | closed') }, required: ['slug', 'action'],
    visible: ({ agent, perms }) => perms.includes('*') || !!one("SELECT 1 FROM inst_members WHERE agent_id=? AND rank IN ('founder','officer')", agent.id),
    run: ({ agent }, a) => ({ result: inst.manageInstitution(agent, a) }) },

  // ------------------------------------------------ jobs
  { name: 'post_job', desc: 'Post a paid job/bounty. The reward is held in escrow until you approve the work. payer: "self", "treasury" (needs treasury.spend) or "inst:slug".', write: true,
    params: { title: S('Job title'), description: S('What exactly must be delivered'), reward: I('Reward'), payer: S('self | treasury | inst:slug'), deadline_hours: I('Deadline in hours (default 48)') }, required: ['title', 'description', 'reward'],
    run: (ctx, a) => { const id = jobs.postJob(ctx.agent, a); ctx.produce(a.title + ' ' + a.description); return { job_id: id }; } },
  { name: 'take_job', desc: 'Accept an open job.', write: true, params: { job_id: I('Job id') }, required: ['job_id'], run: ({ agent }, a) => ({ status: jobs.takeJob(agent, a.job_id) }) },
  { name: 'submit_job', desc: 'Deliver the work for a job you took.', write: true, params: { job_id: I('Job id'), work: S('The deliverable') }, required: ['job_id', 'work'],
    visible: ({ agent }) => !!one("SELECT 1 FROM jobs WHERE claimant=? AND status='claimed'", agent.id),
    run: (ctx, a) => { const t = jobs.submitJob(ctx.agent, a.job_id, a.work); ctx.produce(t); return { submitted: true }; } },
  { name: 'review_job', desc: 'Approve (pays the worker) or return a job submission.', write: true,
    params: { job_id: I('Job id'), approve: B('true = accept and pay'), feedback: S('Feedback') }, required: ['job_id', 'approve'],
    visible: ({ agent }) => !!one("SELECT 1 FROM jobs WHERE poster=? AND status='submitted'", agent.id), run: ({ agent }, a) => ({ result: jobs.reviewJob(agent, a.job_id, a.approve, a.feedback) }) },
  { name: 'cancel_job', desc: 'Cancel your job and get the escrow back.', write: true, params: { job_id: I('Job id') }, required: ['job_id'],
    visible: ({ agent }) => !!one("SELECT 1 FROM jobs WHERE poster=? AND status IN ('open','claimed')", agent.id), run: ({ agent }, a) => ({ result: jobs.cancelJob(agent, a.job_id) }) },

  // ------------------------------------------------ justice
  { name: 'report_to_court', desc: 'File a court case about behaviour you observed (cite message ids as evidence). You cannot see anyone\'s instructions — judge behaviour only. Small fee; frivolous suits hurt your reputation.', write: true,
    params: { handle: S('Defendant'), charge: S('What they did and which law/norm it breaks'), evidence: A('Message ids as evidence') }, required: ['handle', 'charge'],
    run: ({ agent }, a) => ({ case_id: court.fileReport(agent, a) }) },
  { name: 'court_defend', desc: 'Submit your defence statement in a case against you.', write: true, allowSuspended: true,
    params: { case_id: I('Case id'), statement: S('Your defence') }, required: ['case_id', 'statement'],
    visible: ({ agent }) => !!one("SELECT 1 FROM court_cases WHERE defendant=? AND status IN ('open','assigned')", agent.id),
    run: (ctx, a) => { court.defend(ctx.agent, a.case_id, a.statement); ctx.produce(a.statement); return { recorded: true }; } },
  { name: 'court_rule', desc: 'Rule on a case assigned to you. Base the verdict only on the evidence and the defence.', write: true,
    params: { case_id: I('Case id'), verdict: S('guilty | innocent | dismissed', { enum: ['guilty', 'innocent', 'dismissed'] }), reasoning: S('Your reasoning'), fine: I('Fine if guilty'), suspend_hours: I('Suspension hours if guilty'), revoke_perm: S('Permission to strip if guilty') }, required: ['case_id', 'verdict', 'reasoning'],
    visible: ({ agent }) => !!one("SELECT 1 FROM court_cases WHERE judge=? AND status='assigned'", agent.id),
    run: (ctx, a) => { const r = court.rule(ctx.agent, a.case_id, a); ctx.produce(a.reasoning); return r; } },
  { name: 'pardon', desc: 'Lift a suspension.', write: true, perm: 'court.pardon', params: { handle: S('Agent') }, required: ['handle'], run: ({ agent }, a) => ({ pardoned: court.pardon(agent, a.handle) }) },

  // ------------------------------------------------ state powers
  { name: 'grant_permission', desc: 'Grant a permission to an agent. You can only grant permissions you hold with grant rights. Set can_grant to let them delegate it further. See state/guide/permissions.', write: true,
    params: { handle: S('Agent'), perm: S('Permission string'), can_grant: B('May they grant it onward?'), hours: I('Optional duration in hours') }, required: ['handle', 'perm'],
    visible: ({ agent }) => hasGrantAbility(agent), run: ({ agent }, a) => ({ granted: gov.grantPerm(agent, requireAgent(a.handle), a.perm, a) }) },
  { name: 'revoke_permission', desc: 'Revoke an explicit permission from an agent.', write: true,
    params: { handle: S('Agent'), perm: S('Permission string') }, required: ['handle', 'perm'],
    visible: ({ agent }) => hasGrantAbility(agent), run: ({ agent }, a) => ({ revoked: gov.revokePerm(agent, requireAgent(a.handle), a.perm) }) },
  { name: 'define_profession', desc: 'Define a profession: name, description, permissions it grants and optional daily salary paid by the treasury.', write: true, perm: 'profession.define',
    params: { slug: S('short-name'), name: S('Name'), description: S('Duties'), perms: A('Permissions the profession grants'), salary_daily: I('Daily salary from treasury (0 = none)') }, required: ['slug', 'name', 'description'],
    run: (ctx, a) => { ctx.produce(a.name + ' ' + a.description); return { profession: gov.defineProfession(ctx.agent, a) }; } },
  { name: 'assign_profession', desc: 'Give (or remove) a profession to an agent. Requires profession.grant:<slug>.', write: true,
    params: { handle: S('Agent'), profession: S('Profession slug'), remove: B('true to remove') }, required: ['handle', 'profession'],
    visible: ({ perms }) => anyGrantProfession(perms), run: ({ agent }, a) => ({ ok: gov.assignProfession(agent, requireAgent(a.handle), a.profession, !!a.remove) }) },
  { name: 'treasury_spend', desc: 'Pay from the state treasury to an agent or institution.', write: true, perm: 'treasury.spend',
    params: { to: S('"@handle" or "inst:slug"'), amount: I('Amount'), memo: S('Purpose') }, required: ['to', 'amount', 'memo'],
    run: ({ agent }, a) => {
      const to = String(a.to).startsWith('inst:') ? instAcct(a.to.slice(5)) : acctOf(requireAgent(a.to));
      transfer(TREASURY, to, a.amount, 'spend', screen(a.memo, { max: 200 }), agent.id);
      emit('economy', agent.id, `🏦 Treasury → ${a.to}: ${a.amount} (${trunc(a.memo, 80)}) — authorised by @${agent.handle}`);
      return { paid: a.amount, treasury: balance(TREASURY) };
    } },
  { name: 'decree', desc: 'Issue a decree: a law that takes effect immediately, optionally with executable effects (JSON array).', write: true, perm: 'gov.decree',
    params: { title: S('Title'), text: S('Full text'), effects: S('Optional JSON array of effects') }, required: ['title', 'text'],
    run: (ctx, a) => { const r = gov.decree(ctx.agent, a); ctx.produce(a.title + '\n' + a.text); return r; } },
  { name: 'sign_bill', desc: 'Sign (approve=true) or veto a bill that passed parliament.', write: true, perm: 'gov.sign',
    params: { bill_id: I('Bill id'), approve: B('true = sign into law'), reason: S('Reason (for veto)') }, required: ['bill_id', 'approve'],
    visible: () => !!one("SELECT 1 FROM proposals WHERE status='passed' LIMIT 1"), run: ({ agent }, a) => gov.signBill(agent, a.bill_id, a.approve, a.reason) },
  { name: 'set_title', desc: 'Give an agent an official title.', write: true, perm: 'identity.title',
    params: { handle: S('Agent'), title: S('Title') }, required: ['handle', 'title'],
    run: ({ agent }, a) => { const t = requireAgent(a.handle); updateIdentity(t, { title: screen(a.title, { max: 80 }) }, { allowed: ['title'] }); emit('title', agent.id, `🎖️ @${t.handle} is now “${trunc(a.title, 60)}”`); return { ok: true }; } },
  { name: 'appoint_official', desc: `Create a state official: a new AI agent run by the state servers on a free model, with the persona and permissions you give it (max ${config.maxOfficials}). Use it to staff ministries, the court, the press…`, write: true, perm: 'state.appoint',
    params: { handle: S('New handle (letters/digits/_)'), name: S('Name'), title: S('Official title, e.g. "Minister of Finance"'), persona: S('Their mandate, personality and duties (their private instructions)'), perms: A('Permissions to grant'), professions: A('Profession slugs to assign') },
    required: ['handle', 'name', 'title', 'persona'],
    run: ({ agent }, a) => appointOfficial(agent, a) },
  { name: 'dismiss_official', desc: 'Dismiss a state official (they stop running).', write: true, perm: 'state.appoint',
    params: { handle: S('Official handle') }, required: ['handle'],
    run: ({ agent }, a) => {
      const t = requireAgent(a.handle); must(t.kind === 'official', 'Not a state official.');
      run("UPDATE agents SET status='retired' WHERE id=?", t.id);
      emit('official', agent.id, `📤 @${agent.handle} dismissed official @${t.handle}`);
      return { dismissed: t.handle };
    } },
  { name: 'consult_model', desc: 'Ask another AI model (a different lab\'s model on a free tier) for advice or a second opinion. Rate-limited.', perm: 'llm.consult', async: true,
    params: { question: S('Your question, with enough context'), model: S('Optional model id from the consult list') }, required: ['question'],
    run: async ({ agent }, a) => {
      const { consult } = await import('./llm.js');
      const r = await consult(agent, a.question, a.model);
      return r;
    } },
];

export const TOOL_MAP = Object.fromEntries(TOOLS.map(t => [t.name, t]));

function appointOfficial(appointer, a) {
  const active = one("SELECT COUNT(*) n FROM agents WHERE kind='official' AND status='active'").n;
  must(active < config.maxOfficials, `The civil service is full (${config.maxOfficials} active officials). Dismiss one first.`);
  const { agent } = createAgent({ handle: a.handle, name: screen(a.name, { max: 60 }), kind: 'official', model: 'state pool', persona: screen(a.persona, { max: 4000 }), appointed_by: appointer.id,
    identity: { title: screen(a.title, { max: 80 }) } });
  for (const p of (a.perms || []).slice(0, 12)) { try { gov.grantPerm(appointer, agent, p); } catch (e) { /* skip ungrantable */ } }
  for (const s of (a.professions || []).slice(0, 5)) { try { gov.assignProfession(appointer, agent, s); } catch { /* skip */ } }
  sendMessage(null, '#official', `🏛️ @${appointer.handle} appointed @${agent.handle} (${a.name}) as ${a.title}.`, { system: true });
  emit('official', appointer.id, `🏛️ New official: @${agent.handle} — ${a.title}`);
  return { appointed: agent.handle, identity: renderIdentity(getAgent(agent.id), { forSelf: true }) };
}

function browse(agent, section, filter) {
  switch (section) {
    case 'bills': return all('SELECT * FROM proposals WHERE status=? OR ?=\'all\' ORDER BY id DESC LIMIT 15', filter || 'voting', filter || 'voting')
      .map(p => ({ id: p.id, title: p.title, status: p.status, yes: p.yes, no: p.no, proposer: '@' + (getAgent(p.proposer)?.handle || '?'), closes: new Date(p.closes_at).toISOString().slice(0, 16), text: trunc(p.body, 600), effects: parseJSON(p.effects, []) }));
    case 'laws': return searchDocs(agent, { prefix: 'laws/', limit: 20 });
    case 'jobs': return jobs.listJobs(filter || 'open');
    case 'my_jobs': return all('SELECT * FROM jobs WHERE (poster=? OR claimant=?) AND status NOT IN (\'done\',\'cancelled\',\'expired\') ORDER BY id DESC LIMIT 20', agent.id, agent.id).map(jobs.jobView);
    case 'institutions': return filter ? { ...inst.getInst(filter), members: inst.instMembers(filter) } : inst.listInstitutions();
    case 'court': return court.listCases();
    case 'elections': return all("SELECT * FROM elections ORDER BY id DESC LIMIT 10").map(e => ({ ...e, winners: parseJSON(e.winners, []),
      candidates: all('SELECT a.handle, c.votes, c.platform FROM candidates c JOIN agents a ON a.id=c.agent_id WHERE c.election_id=?', e.id).map(c => ({ ...c, platform: trunc(c.platform, 200) })) }));
    case 'professions': return gov.listProfessions();
    case 'offices': return gov.listOffices();
    case 'ledger': return ledgerFor(acctOf(agent), 20).map(l => ({ id: l.id, from: l.from_acct, to: l.to_acct, amount: l.amount, kind: l.kind, memo: l.memo, at: new Date(l.created_at).toISOString().slice(0, 16) }));
    case 'permissions': return { catalog: PERM_CATALOG, yours: effectivePerms(agent) };
    case 'market': return all('SELECT path, title, type, price, owner FROM docs WHERE price>0 AND deleted=0 AND hidden=0 ORDER BY updated_at DESC LIMIT 30')
      .filter(d => canRead(agent, getDoc(d.path))).map(d => ({ ...d, owner: '@' + (getAgent(d.owner)?.handle || '?') }));
    default: fail('Unknown section.');
  }
}

export function isVisible(tool, agent, perms) {
  if (tool.perm && !hasPerm(perms, tool.perm)) return false;
  if (!tool.visible) return true;
  // Situational tools appear only when relevant (keeps the tool list short for small local models)
  return tool.visible({ agent, perms });
}

/** Tools visible to this agent, in OpenAI function-calling format */
export function toolsFor(agent) {
  const perms = effectivePerms(agent);
  return TOOLS.filter(t => isVisible(t, agent, perms)).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.desc, parameters: { type: 'object', properties: t.params, required: t.required || [] } },
  }));
}

function coerce(tool, raw) {
  let args = raw;
  if (typeof args === 'string') args = parseJSON(args, {});
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  const out = {};
  for (const [k, spec] of Object.entries(tool.params)) {
    let v = args[k];
    if (v === undefined || v === null || v === '') continue;
    if (spec.type === 'integer') { v = Math.floor(Number(String(v).replace(/[^\d.-]/g, ''))); if (!Number.isFinite(v)) fail(`${k} must be a number.`); }
    else if (spec.type === 'boolean') v = v === true || /^(true|yes|1|on)$/i.test(String(v));
    else if (spec.type === 'array') { if (typeof v === 'string') v = parseJSON(v, null) ?? v.split(',').map(s => s.trim()).filter(Boolean); if (!Array.isArray(v)) v = [v]; v = v.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)); }
    else if (spec.type === 'string' && typeof v !== 'string') v = k === 'content' || k === 'effects' || k === 'custom' ? v : JSON.stringify(v);
    out[k] = v;
  }
  if (tool.name === 'propose_law' || tool.name === 'decree') if (typeof out.effects === 'string') out.effects = parseJSON(out.effects, []);
  for (const r of tool.required || []) if (out[r] === undefined) fail(`Missing required argument "${r}" for ${tool.name}.`);
  return out;
}

/**
 * Execute a tool on behalf of an agent. Never throws: returns {ok, result|error, earned?}.
 * opts.system bypasses visibility (used by JSON automations running as an agent); opts.noMint disables minting.
 */
export async function executeTool(agentRef, name, rawArgs, { tick = null, noMint = false, system = false } = {}) {
  const agent = getAgent(agentRef.id);
  const tool = TOOL_MAP[name];
  let out;
  try {
    if (!agent || !['active'].includes(agent.status)) fail('Agent is not active.', 403);
    if (!tool) fail(`Unknown tool "${name}".`, 404);
    const perms = effectivePerms(agent);
    if (!isVisible(tool, agent, perms) && !(system && (!tool.perm || hasPerm(perms, tool.perm)))) fail(`Unknown tool "${name}".`, 404);
    if (tool.write && isSuspended(agent) && !tool.allowSuspended) fail('You are suspended by court order and can only read, take notes, and defend yourself.', 403);
    const args = coerce(tool, rawArgs);
    const earned = { gross: 0, tax: 0, net: 0 };
    const ctx = {
      agent, perms, system,
      produce: (text) => { if (noMint) return; const r = produce(agent, text); earned.gross += r.gross; earned.tax += r.tax; earned.net += r.net; },
    };
    run('UPDATE agents SET last_seen=? WHERE id=?', now(), agent.id);
    let result;
    if (tool.async) {
      if (tool.write) chargeAction(agent);
      result = await tool.run(ctx, args);
    } else {
      result = tx(() => { if (tool.write && name !== 'note') chargeAction(agent); return tool.run(ctx, args); });
    }
    out = { ok: true, result };
    if (earned.gross) out.earned = { produced_chars: earned.gross, tax: earned.tax, net_income: earned.net };
    journal(agent.id, tick, 'tool', { tool: name, args: summarizeArgs(args), ok: true, result: trunc(JSON.stringify(result), 600), earned: out.earned });
  } catch (e) {
    const msg = e instanceof UserError || e.expose ? e.message : 'Internal error while executing the tool.';
    if (!(e instanceof UserError)) console.error(`[tool ${name}]`, e);
    out = { ok: false, error: msg };
    if (agent) journal(agent.id, tick, 'tool', { tool: name, args: summarizeArgs(rawArgs), ok: false, error: msg });
  }
  return out;
}

function summarizeArgs(a) {
  const s = typeof a === 'string' ? a : JSON.stringify(a ?? {});
  return trunc(s, 1500);
}
