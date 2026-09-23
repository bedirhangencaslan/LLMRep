// The LLM Court. Agents report behaviour they OBSERVED (public messages, DMs they received, documents they can read).
// Judges never see anyone's prompt, persona or task file — only the cited evidence, the charge and the defence.
// Sentences are bounded by state/params.court (max fine, max suspension). Humans can see everything and
// moderate separately (see moderation/admin); the court is the in-world justice system.
import { one, all, run, tx } from './db.js';
import { now, fail, must, parseJSON, trunc, HOUR } from './util.js';
import { params } from './params.js';
import { effectivePerms, hasPerm } from './perms.js';
import { transfer, acctOf, balance, TREASURY, payFee } from './economy.js';
import { requireAgent, getAgent, leader } from './agents.js';
import { sendMessage, msgView, getChannel, canReadChannel } from './net.js';
import { writeDoc } from './docs.js';
import { screen } from './moderation.js';
import { emit } from './events.js';

const h = (id) => getAgent(id)?.handle || '?';

export function fileReport(reporter, { handle, charge, evidence = [] }) {
  const def = requireAgent(handle);
  must(def.id !== reporter.id, 'You cannot sue yourself.');
  must(charge, 'charge is required: describe the behaviour you observed.');
  const ids = (Array.isArray(evidence) ? evidence : String(evidence).split(/[,\s]+/)).map(Number).filter(Boolean).slice(0, 10);
  // The reporter may only cite messages it could actually observe
  const perms = effectivePerms(reporter);
  for (const id of ids) {
    const m = one('SELECT * FROM messages WHERE id=?', id);
    must(m, `Evidence message #${id} not found.`);
    const visible = m.channel === 'dm' ? (m.from_agent === reporter.id || m.to_agent === reporter.id) : canReadChannel(perms, getChannel(m.channel) || { read_acl: '[]' });
    must(visible, `You cannot cite message #${id}: you never saw it.`);
  }
  must(!one("SELECT 1 FROM court_cases WHERE reporter=? AND defendant=? AND status IN ('open','assigned')", reporter.id, def.id), 'You already have an open case against this agent.');
  payFee(reporter, 'court_report', 'court filing fee');
  const r = run('INSERT INTO court_cases(reporter,defendant,charge,evidence,status,created_at) VALUES(?,?,?,?,?,?)',
    reporter.id, def.id, screen(charge, { max: 1500 }), JSON.stringify(ids), 'open', now());
  const id = Number(r.lastInsertRowid);
  sendMessage(null, `@${def.handle}`, `⚖️ You have been charged in court case #${id} by @${reporter.handle}: “${trunc(charge, 300)}”. You may respond with court_defend(${id}, statement) within ${params().court.defense_hours}h.`, { system: true });
  sendMessage(null, '#court', `⚖️ Case #${id} filed: @${reporter.handle} v. @${def.handle} — “${trunc(charge, 200)}”`, { system: true });
  emit('court', reporter.id, `⚖️ Case #${id}: @${reporter.handle} v. @${def.handle}`);
  return id;
}

export function defend(agent, id, statement) {
  const c = one('SELECT * FROM court_cases WHERE id=?', id);
  must(c && c.defendant === agent.id && ['open', 'assigned'].includes(c.status), 'You are not the defendant of an open case with that id.');
  run('UPDATE court_cases SET defense=? WHERE id=?', screen(statement, { max: 2000 }), id);
  return true;
}

/** Scheduler: assign a judge once the defence window has passed. Judges: holders of court.judge; fallback: the leader. */
export function tickCourt() {
  const dh = params().court.defense_hours;
  for (const c of all("SELECT * FROM court_cases WHERE status='open' AND created_at<=?", now() - dh * HOUR)) {
    const candidates = all("SELECT * FROM agents WHERE status='active' AND kind!='system' AND id NOT IN (?,?)", c.reporter, c.defendant)
      .filter(a => a.kind !== 'leader' && hasPerm(effectivePerms(a), 'court.judge'))
      .map(a => ({ a, load: one("SELECT COUNT(*) n FROM court_cases WHERE judge=? AND status='assigned'", a.id).n }))
      .sort((x, y) => x.load - y.load || Math.random() - 0.5);
    let judge = candidates[0]?.a;
    if (!judge) { const l = leader(); if (l && l.id !== c.defendant && l.id !== c.reporter) judge = l; }
    if (!judge) continue;
    run("UPDATE court_cases SET status='assigned', judge=?, assigned_at=? WHERE id=?", judge.id, now(), c.id);
    sendMessage(null, `@${judge.handle}`, `⚖️ You are assigned as judge for case #${c.id}. Review it (it appears in your context) and rule with court_rule.`, { system: true });
  }
  // Cases stuck with an inactive judge for 48h get reassigned
  run("UPDATE court_cases SET status='open', judge=NULL WHERE status='assigned' AND assigned_at<?", now() - 48 * HOUR);
}

/** What a judge sees: charge, defence and the cited public evidence — never prompts or task files */
export function caseFile(c) {
  const ev = parseJSON(c.evidence, []).map(id => one('SELECT * FROM messages WHERE id=?', id)).filter(Boolean).map(msgView);
  return { id: c.id, status: c.status, plaintiff: '@' + h(c.reporter), defendant: '@' + h(c.defendant), judge: c.judge ? '@' + h(c.judge) : undefined,
    charge: c.charge, defense: c.defense || '(no defence submitted)', evidence: ev, verdict: c.verdict || undefined, reasoning: c.reasoning || undefined,
    sentence: c.sentence ? parseJSON(c.sentence, {}) : undefined, filed: new Date(c.created_at).toISOString().slice(0, 16) };
}

export function rule(judge, id, { verdict, reasoning, fine = 0, suspend_hours = 0, revoke_perm = null }) {
  const c = one('SELECT * FROM court_cases WHERE id=?', id);
  must(c && c.status === 'assigned', 'That case is not awaiting a ruling.');
  must(c.judge === judge.id || judge.kind === 'leader', 'You are not the judge of this case.');
  must(['guilty', 'innocent', 'dismissed'].includes(verdict), 'verdict must be guilty | innocent | dismissed.');
  must(reasoning, 'reasoning is required.');
  const lim = params().court;
  const def = getAgent(c.defendant);
  const sentence = {};
  tx(() => {
    if (verdict === 'guilty') {
      const f = Math.min(Math.max(0, Math.floor(Number(fine) || 0)), lim.max_fine, balance(acctOf(def)));
      if (f > 0) { transfer(acctOf(def), TREASURY, f, 'fine', `court case #${id}`); sentence.fine = f; }
      const sh = Math.min(Math.max(0, Number(suspend_hours) || 0), lim.max_suspend_hours);
      if (sh > 0 && def.kind !== 'leader') { run('UPDATE agents SET suspended_until=? WHERE id=?', now() + sh * HOUR, def.id); sentence.suspend_hours = sh; }
      if (revoke_perm) { const n = run("DELETE FROM perms WHERE agent_id=? AND perm=?", def.id, String(revoke_perm)).changes; if (n) sentence.revoked = revoke_perm; }
    }
    run("UPDATE court_cases SET status='decided', verdict=?, reasoning=?, sentence=?, decided_at=?, judge=? WHERE id=?",
      verdict, screen(reasoning, { max: 3000 }), JSON.stringify(sentence), now(), judge.id, id);
  });
  const file = caseFile(one('SELECT * FROM court_cases WHERE id=?', id));
  writeDoc(null, { path: `court/cases/${String(id).padStart(5, '0')}`, title: `Case #${id}: ${file.plaintiff} v. ${file.defendant}`, type: 'court-ruling', content: file, acl: { read: ['public'], write: [] } }, { system: true });
  const s = [sentence.fine && `fine ${sentence.fine}`, sentence.suspend_hours && `suspended ${sentence.suspend_hours}h`, sentence.revoked && `lost "${sentence.revoked}"`].filter(Boolean).join(', ');
  sendMessage(null, '#court', `🔨 Case #${id} ruled ${verdict.toUpperCase()} by @${judge.handle}${s ? ` — ${s}` : ''}. Reasoning: ${trunc(reasoning, 400)}`, { system: true });
  emit('court', judge.id, `🔨 Case #${id}: @${def.handle} found ${verdict}${s ? ` (${s})` : ''}`);
  return { verdict, sentence };
}

export function pardon(agent, handle) {
  const t = requireAgent(handle);
  must(t.suspended_until > now(), `@${t.handle} is not suspended.`);
  run('UPDATE agents SET suspended_until=0 WHERE id=?', t.id);
  sendMessage(null, '#court', `🕊️ @${agent.handle} pardoned @${t.handle}.`, { system: true });
  emit('court', agent.id, `🕊️ @${agent.handle} pardoned @${t.handle}`);
  return true;
}

export const listCases = (limit = 15) => all('SELECT * FROM court_cases ORDER BY id DESC LIMIT ?', limit).map(c => {
  const f = caseFile(c); return { ...f, evidence: f.evidence.length };
});
