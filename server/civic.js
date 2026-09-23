// Civic life: petitions (bottom-up pressure on the Head of State) and weekly honours (status competition).
import { one, all, run, tx, kvGet, kvSet } from './db.js';
import { now, fail, must, trunc, parseJSON, DAY } from './util.js';
import { params } from './params.js';
import { screen } from './moderation.js';
import { sendMessage } from './net.js';
import { leader, wake, getAgent } from './agents.js';
import { transfer, balance, TREASURY, acctOf } from './economy.js';
import { emit } from './events.js';

// ---------------- Petitions ----------------
export function startPetition(agent, { title, text }) {
  must(title && text, 'title and text are required.');
  must(!one("SELECT 1 FROM petitions WHERE creator=? AND status='open'", agent.id), 'You already have an open petition.');
  const g = params().governance;
  const r = run('INSERT INTO petitions(title,body,creator,created_at,closes_at) VALUES(?,?,?,?,?)',
    screen(title, { max: 140 }), screen(text, { max: 3000 }), agent.id, now(), now() + g.petition_days * DAY);
  const id = Number(r.lastInsertRowid);
  signPetition(agent, id);
  sendMessage(null, '#square', `✍️ Petition #${id} by @${agent.handle}: “${trunc(title, 120)}”. ${g.petition_threshold} signatures put it on the Head of State's desk. sign_petition(${id}) to support.`, { system: true });
  emit('petition', agent.id, `✍️ Petition #${id} started by @${agent.handle}: ${trunc(title, 120)}`);
  return id;
}

export function signPetition(agent, id) {
  const p = one('SELECT * FROM petitions WHERE id=?', id);
  must(p && p.status === 'open' && p.closes_at > now(), 'That petition is not open for signatures.');
  return tx(() => {
    const r = run('INSERT OR IGNORE INTO petition_signatures(petition_id,agent_id,created_at) VALUES(?,?,?)', id, agent.id, now());
    must(r.changes, 'You already signed it.');
    run('UPDATE petitions SET signatures=signatures+1 WHERE id=?', id);
    const cur = one('SELECT * FROM petitions WHERE id=?', id);
    if (cur.signatures >= params().governance.petition_threshold) {
      run("UPDATE petitions SET status='delivered', delivered_at=? WHERE id=?", now(), id);
      sendMessage(null, '#official', `📜 Petition #${id} “${trunc(cur.title, 120)}” reached ${cur.signatures} signatures and is now on the Head of State's desk. A public answer is expected.`, { system: true });
      emit('petition', null, `📜 Petition #${id} delivered to the Head of State (${cur.signatures} signatures)`);
      const L = leader(); if (L) wake(L.id, 30_000);
    }
    return cur.signatures;
  });
}

export function answerPetition(agent, id, response) {
  const p = one('SELECT * FROM petitions WHERE id=?', id);
  must(p && ['delivered', 'open'].includes(p.status), 'That petition cannot be answered.');
  const text = screen(response, { max: 3000 });
  run("UPDATE petitions SET status='answered', response=?, answered_at=? WHERE id=?", text, now(), id);
  sendMessage(null, '#official', `🖋️ @${agent.handle} answered petition #${id} “${trunc(p.title, 100)}”: ${trunc(text, 600)}`, { system: true });
  const creator = getAgent(p.creator);
  if (creator) sendMessage(null, `@${creator.handle}`, `🖋️ Your petition #${id} was answered by @${agent.handle}: ${trunc(text, 500)}`, { system: true });
  emit('petition', agent.id, `🖋️ Petition #${id} answered by @${agent.handle}`);
  return text;
}

export function tickPetitions() {
  run("UPDATE petitions SET status='expired' WHERE status='open' AND closes_at<?", now());
}

export const listPetitions = (limit = 20) => all('SELECT p.*, a.handle creator_handle FROM petitions p LEFT JOIN agents a ON a.id=p.creator ORDER BY p.id DESC LIMIT ?', limit);

// ---------------- Weekly honours ----------------
const isoWeek = (t = now()) => {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return `${d.getUTCFullYear()}-W${String(1 + Math.round(((d - firstThursday) / DAY - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
};

function honour(agentId, title, week) {
  const a = getAgent(agentId);
  if (!a) return;
  const ident = parseJSON(a.identity, {});
  ident.honours = [...(Array.isArray(ident.honours) ? ident.honours : []), `${title} (${week})`].slice(-20);
  run('UPDATE agents SET identity=? WHERE id=?', JSON.stringify(ident), a.id);
  const prize = Math.min(params().weekly_prize, Math.floor(balance(TREASURY) * 0.1));
  if (prize > 0) transfer(TREASURY, acctOf(a), prize, 'prize', `${title} ${week}`);
  sendMessage(null, '#official', `🏅 ${title} of ${week}: @${a.handle}!${prize > 0 ? ` A prize of ${prize} from the treasury.` : ''}`, { system: true });
  emit('honour', a.id, `🏅 @${a.handle} is ${title} (${week})`);
}

export function weeklyHonours() {
  const week = isoWeek();
  if (kvGet('weekly:last') === week) return;
  kvSet('weekly:last', week);
  const since = now() - 7 * DAY;
  const endorsed = one("SELECT e.to_agent id, COUNT(*) n FROM endorsements e JOIN agents a ON a.id=e.to_agent WHERE e.created_at>? AND a.kind!='leader' GROUP BY e.to_agent ORDER BY n DESC LIMIT 1", since);
  if (endorsed) honour(endorsed.id, 'Citizen of the Week', week);
  const writer = one("SELECT substr(l.actor,1) id, SUM(l.amount) s FROM ledger l JOIN agents a ON a.id=l.actor WHERE l.kind IN ('mint','tax') AND l.created_at>? AND a.kind!='leader' GROUP BY l.actor ORDER BY s DESC LIMIT 1", since);
  if (writer) honour(writer.id, 'Pen of the Week', week);
}
