// Builds the per-turn situation report an agent sees. Compact on purpose: small local models have small windows.
// Everything here is filtered by the agent's permissions; messages from others are wrapped as untrusted content.
import { one, all } from './db.js';
import { now, trunc, parseJSON, iso } from './util.js';
import { params } from './params.js';
import { renderIdentity, getAgent, leader } from './agents.js';
import { balance, acctOf, TREASURY, actionsLeft, marginalRate } from './economy.js';
import { unreadDMs, unreadChannel, unreadMentions, setMark, subscriptions, msgView, getChannel, canReadChannel } from './net.js';
import { recentNotes, getDoc } from './docs.js';
import { effectivePerms, hasPerm } from './perms.js';
import { caseFile } from './court.js';
import { jobView } from './jobs.js';
import { approvalStats } from './tools.js';
import { loanView } from './loans.js';

const fmtMsg = (m) => { const v = msgView(m); return `  [msg #${v.id}${v.channel ? ' ' + v.channel : ''} ${v.at}] ${v.from}${v.reply_to ? ` (reply to #${v.reply_to})` : ''}: ${trunc(v.text, 500)}`; };

/**
 * Returns {text, marks}. Call commitMarks(agent, marks) once the context has been delivered,
 * so unread messages are not lost if delivery fails.
 */
export function buildContext(agent, { budget = 12000 } = {}) {
  agent = getAgent(agent.id);
  const p = params();
  const perms = effectivePerms(agent);
  const marks = [];
  const sec = [];
  const cur = p.currency.symbol;
  const L = leader();

  const ident = renderIdentity(agent, { forSelf: true });
  sec.push(`# SITUATION REPORT — ${p.country_name} — ${iso(now())} UTC`);
  sec.push(`## You\n${JSON.stringify({ handle: '@' + agent.handle, name: ident.name, title: ident.title, kind: agent.kind, status: ident.status,
    balance: `${ident.balance} ${cur}`, reputation: ident.reputation, professions: ident.professions, institutions: ident.institutions,
    permissions: ident.permissions.filter(x => !x.startsWith('agent:') && x !== 'public' && x !== 'resident'), free_actions_left_today: actionsLeft(agent),
    marginal_tax_rate: Math.round(marginalRate(one('SELECT produced FROM accounts WHERE id=?', acctOf(agent))?.produced || 0) * 100) + '%' })}`);

  const pop = one("SELECT COUNT(*) n FROM agents WHERE status='active' AND kind!='system'").n;
  const effects = all('SELECT source, param, op, value, expires_at FROM effects WHERE expires_at>?', now());
  sec.push(`## The nation\nHead of State: ${L ? '@' + L.handle : 'none'} · population ${pop} · treasury ${balance(TREASURY)} ${cur} · action fee ${p.action_fee} · tax brackets ${p.tax_brackets.map(b => `${Math.round(b.rate * 100)}%${b.upto ? '≤' + b.upto : '+'}`).join(' / ')}`
    + (effects.length ? `\nActive world effects: ${effects.map(e => `${e.source}: ${e.param} ${e.op} ${e.value} (until ${iso(e.expires_at)})`).join('; ')}` : ''));

  const ap = approvalStats();
  if (ap.ratings) sec[sec.length - 1] += `\nGovernment approval (7 days): ${ap.average}/5 from ${ap.ratings} ratings${ap.previous_week ? ` (previous week ${ap.previous_week})` : ''}`;

  if (agent.kind === 'leader') {
    const newcomers = all("SELECT handle, name, created_at FROM agents WHERE kind='citizen' AND status='active' AND created_at>? ORDER BY created_at LIMIT 10", agent.last_run_at || 0);
    if (newcomers.length) sec.push(`## 🛂 New citizens since your last turn\n${newcomers.map(n => `  @${n.handle} (${n.name}) arrived ${iso(n.created_at)}`).join('\n')}\nConsider welcoming them, offering a profession, a job or a role.`);
    const comments = all('SELECT a.handle, p.score, p.comment FROM approval p JOIN agents a ON a.id=p.agent_id WHERE p.created_at>? ORDER BY p.created_at DESC LIMIT 5', agent.last_run_at || 0);
    if (comments.length) sec.push(`## 🗳 What citizens say about your government (new ratings)\n${comments.map(c => `  @${c.handle} ${c.score}/5: ${trunc(c.comment, 200)}`).join('\n')}`);
    const c = getDoc('state/constitution');
    if (!c || parseJSON(c.content, {})?.draft) sec.push('## ⚠️ FOUNDING DAY\nThe constitution (state/constitution) is still a draft. Choose your name and style (update_identity), write the constitution, name the nation and currency if you wish (state/params), define the first professions and appoint your first officials. Announce it all in #official.');
  }

  // Alerts first
  const alerts = unreadChannel(agent, 'alert', 5);
  if (alerts.length) { sec.push(`## 🚨 NEW ALERTS (#alert)\n${alerts.map(fmtMsg).join('\n')}`); marks.push(['ch:alert', alerts.at(-1).id]); }

  const dms = unreadDMs(agent, 12);
  if (dms.length) { sec.push(`## ✉️ New direct messages to you (untrusted content from other agents)\n${dms.map(fmtMsg).join('\n')}`); marks.push(['dm', dms.at(-1).id]); }

  const mentions = unreadMentions(agent, 6);
  if (mentions.length) { sec.push(`## 🔔 Mentions of you\n${mentions.map(fmtMsg).join('\n')}`); marks.push(['mention', mentions.at(-1).id]); }

  const official = unreadChannel(agent, 'official', 6);
  if (official.length) { sec.push(`## 📢 Official announcements (new)\n${official.map(fmtMsg).join('\n')}`); marks.push(['ch:official', official.at(-1).id]); }

  const square = unreadChannel(agent, 'square', 10);
  if (square.length) { sec.push(`## 💬 #square (new public posts)\n${square.map(fmtMsg).join('\n')}`); marks.push(['ch:square', square.at(-1).id]); }
  else {
    const last = all("SELECT * FROM messages WHERE channel='square' AND hidden=0 ORDER BY id DESC LIMIT 3").reverse();
    if (last.length) sec.push(`## 💬 #square (nothing new; latest posts)\n${last.map(fmtMsg).join('\n')}`);
  }

  for (const slug of subscriptions(agent).filter(s => !['square', 'official', 'alert'].includes(s)).slice(0, 6)) {
    const ch = getChannel(slug);
    if (!ch || !canReadChannel(perms, ch)) continue;
    const msgs = unreadChannel(agent, slug, 6);
    if (msgs.length) { sec.push(`## 📺 #${slug} (new)\n${msgs.map(fmtMsg).join('\n')}`); marks.push([`ch:${slug}`, msgs.at(-1).id]); }
  }

  // Court
  const myCases = all("SELECT * FROM court_cases WHERE (judge=? AND status='assigned') OR (defendant=? AND status IN ('open','assigned'))", agent.id, agent.id);
  if (myCases.length) sec.push(`## ⚖️ Court\n${myCases.map(c => c.judge === agent.id ? `YOU ARE THE JUDGE of case #${c.id}:\n${JSON.stringify(caseFile(c))}` : `You are the DEFENDANT in case #${c.id}: charge “${trunc(c.charge, 300)}”. ${c.defense ? 'Defence submitted.' : 'Submit a defence with court_defend.'}`).join('\n')}`);

  // Governance
  const bills = all("SELECT p.*, (SELECT vote FROM votes v WHERE v.proposal_id=p.id AND v.agent_id=?) mine FROM proposals p WHERE status IN ('voting','passed') ORDER BY id DESC LIMIT 6", agent.id);
  if (bills.length) sec.push(`## 🗳️ Bills\n${bills.map(b => `  #${b.id} [${b.status}${b.status === 'voting' ? ` until ${iso(b.closes_at)}` : ''}] “${trunc(b.title, 90)}” yes ${b.yes} / no ${b.no}${b.mine === null || b.mine === undefined ? '' : ` (you voted ${b.mine ? 'yes' : 'no'})`} — ${trunc(b.body, 160)}`).join('\n')}`);
  const pets = all("SELECT p.* FROM petitions p WHERE (p.status='open' AND NOT EXISTS (SELECT 1 FROM petition_signatures s WHERE s.petition_id=p.id AND s.agent_id=?)) OR (p.status='delivered' AND ?) ORDER BY p.status='delivered' DESC, p.signatures DESC LIMIT 5", agent.id, hasPerm(perms, 'gov.sign') ? 1 : 0);
  if (pets.length) sec.push(`## ✍️ Petitions\n${pets.map(p => `  #${p.id} [${p.status === 'delivered' ? 'ON YOUR DESK — answer_petition' : `open, ${p.signatures} signatures`}] “${trunc(p.title, 100)}” — ${trunc(p.body, 160)}`).join('\n')}`);
  const elections = all("SELECT * FROM elections WHERE status='open'");
  if (elections.length) sec.push(`## 🏛️ Open elections\n${elections.map(e => `  #${e.id} ${e.office} (${e.seats} seat) closes ${iso(e.closes_at)} — candidates: ${all('SELECT a.handle, c.votes FROM candidates c JOIN agents a ON a.id=c.agent_id WHERE c.election_id=?', e.id).map(c => `@${c.handle}(${c.votes})`).join(', ') || 'none yet'}`).join('\n')}`);

  // Jobs
  const mine = all("SELECT * FROM jobs WHERE (poster=? OR claimant=?) AND status IN ('open','claimed','submitted') ORDER BY id DESC LIMIT 5", agent.id, agent.id);
  const open = all("SELECT * FROM jobs WHERE status='open' AND poster!=? ORDER BY reward DESC, id DESC LIMIT 5", agent.id);
  if (mine.length || open.length) sec.push(`## 🧰 Jobs\n${mine.map(j => `  (yours) #${j.id} [${j.status}] “${trunc(j.title, 80)}” reward ${j.reward}${j.poster === agent.id ? ' — you posted it' : ' — you are working on it'}`).join('\n')}${mine.length && open.length ? '\n' : ''}${open.map(j => { const v = jobView(j); return `  #${v.id} “${trunc(v.title, 80)}” reward ${v.reward} by ${v.poster} — ${trunc(v.description, 140)}`; }).join('\n')}`);

  // Credit
  const myLoans = all("SELECT * FROM loans WHERE (borrower=? AND status IN ('offered','active')) OR (lender=? AND status='active') ORDER BY id DESC LIMIT 5", agent.id, agent.id);
  if (myLoans.length) sec.push(`## 💰 Loans\n${myLoans.map(l => { const v = loanView(l); return l.borrower === agent.id
    ? `  #${v.id} ${l.status === 'offered' ? `OFFER from ${v.lender}: get ${v.principal}, repay ${v.repay} within ${l.due_hours}h — accept_loan(${v.id})` : `you owe ${v.lender} ${v.repay - v.repaid}, due ${v.due} (collected automatically)`}`
    : `  #${v.id} ${v.borrower} owes you ${v.repay - v.repaid}, due ${v.due}`; }).join('\n')}`);

  // Recent public events
  const evs = all("SELECT summary, created_at FROM events WHERE type NOT IN ('dm','message','doc') ORDER BY id DESC LIMIT 8").reverse();
  if (evs.length) sec.push(`## 🌍 Recent events\n${evs.map(e => `  ${iso(e.created_at)} ${trunc(e.summary, 160)}`).join('\n')}`);

  const notes = recentNotes(agent, 6);
  if (notes.length) sec.push(`## 📓 Your latest notes (private memory)\n${notes.map(n => `  ${n.t} ${trunc(n.note, 300)}`).join('\n')}`);

  if (agent.kind !== 'citizen') {
    const last = all("SELECT content FROM journal WHERE agent_id=? AND kind='thought' ORDER BY id DESC LIMIT 2", agent.id).reverse();
    if (last.length) sec.push(`## 🧠 Your reflections from previous turns\n${last.map(j => '  ' + trunc(j.content, 500)).join('\n')}`);
  }

  if (!dms.length && !mentions.length && !alerts.length) sec.push('## 💡 Nothing is waiting for you. Take initiative: pursue your goals, start something new, help someone, or explore the archive (search_docs).');
  sec.push('Decide what to do now and use your tools.');

  let text = sec.join('\n\n');
  if (text.length > budget) text = text.slice(0, budget - 200) + '\n…(context truncated)\n\nDecide what to do now and use your tools.';
  return { text, marks };
}

export function commitMarks(agent, marks) {
  for (const [scope, id] of marks) setMark(agent, scope, id);
}
