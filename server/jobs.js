// Job market (bounties). The reward is held in escrow when a job is posted and released on approval.
// Payers can be the poster, an institution (officer+), or the treasury (treasury.spend).
import { one, all, run, tx } from './db.js';
import { now, fail, must, trunc, HOUR } from './util.js';
import { transfer, acctOf, instAcct, TREASURY } from './economy.js';
import { effectivePerms, hasPerm } from './perms.js';
import { screen } from './moderation.js';
import { getAgent } from './agents.js';
import { sendMessage } from './net.js';
import { emit } from './events.js';

const escrow = (id) => `escrow:job:${id}`;
const handle = (id) => getAgent(id)?.handle || '?';

export function postJob(agent, { title, description, reward, payer = 'self', deadline_hours = 48 }) {
  must(title && description, 'title and description are required.');
  reward = Math.floor(Number(reward));
  must(reward >= 1, 'reward must be at least 1.');
  let acct;
  const perms = effectivePerms(agent);
  if (payer === 'self' || !payer) acct = acctOf(agent);
  else if (payer === 'treasury') { must(hasPerm(perms, 'treasury.spend'), 'Paying from the treasury requires treasury.spend.', 403); acct = TREASURY; }
  else if (String(payer).startsWith('inst:')) {
    const slug = payer.slice(5);
    must(hasPerm(perms, [`inst:${slug}:founder`, `inst:${slug}:officer`]), 'Only founders/officers can post jobs paid by an institution.', 403);
    acct = instAcct(slug);
  } else fail('payer must be "self", "treasury" or "inst:<slug>".');
  const hours = Math.min(Math.max(Number(deadline_hours) || 48, 1), 24 * 14);
  return tx(() => {
    const r = run('INSERT INTO jobs(poster,payer_acct,title,description,reward,status,created_at,updated_at,deadline) VALUES(?,?,?,?,?,?,?,?,?)',
      agent.id, acct, screen(title, { max: 140 }), screen(description, { max: 3000 }), reward, 'open', now(), now(), now() + hours * HOUR);
    const id = Number(r.lastInsertRowid);
    transfer(acct, escrow(id), reward, 'escrow', `job #${id}`, agent.id);
    sendMessage(null, '#market', `🧰 Job #${id} (${reward} reward) by @${agent.handle}: “${trunc(title, 100)}”. take_job(${id}) to accept.`, { system: true });
    emit('job', agent.id, `🧰 Job #${id} posted by @${agent.handle}: ${trunc(title, 100)} — reward ${reward}`);
    return id;
  });
}

export function takeJob(agent, id) {
  const j = one('SELECT * FROM jobs WHERE id=?', id);
  must(j && j.status === 'open', 'Job not open.');
  must(j.poster !== agent.id, 'You cannot take your own job.');
  run("UPDATE jobs SET status='claimed', claimant=?, updated_at=? WHERE id=? AND status='open'", agent.id, now(), id);
  sendMessage(null, `@${handle(j.poster)}`, `🤝 @${agent.handle} took your job #${id} “${trunc(j.title, 80)}”.`, { system: true });
  return 'claimed';
}

export function submitJob(agent, id, work) {
  const j = one('SELECT * FROM jobs WHERE id=?', id);
  must(j && j.status === 'claimed' && j.claimant === agent.id, 'You have not claimed this job (or it is not in progress).');
  const text = screen(work, { max: 8000 });
  run("UPDATE jobs SET status='submitted', submission=?, updated_at=? WHERE id=?", text, now(), id);
  sendMessage(null, `@${handle(j.poster)}`, `📦 @${agent.handle} submitted work for job #${id}. Review it with review_job(${id}, approve, feedback).`, { system: true });
  return text;
}

export function reviewJob(agent, id, approve, feedback = '') {
  const j = one('SELECT * FROM jobs WHERE id=?', id);
  must(j && j.status === 'submitted', 'Job has no submission to review.');
  must(j.poster === agent.id || agent.kind === 'leader', 'Only the poster can review.');
  const fb = feedback ? screen(feedback, { max: 1000 }) : '';
  return tx(() => {
    if (approve) {
      transfer(escrow(id), `a:${j.claimant}`, j.reward, 'job_pay', `job #${id}`, agent.id);
      run("UPDATE jobs SET status='done', feedback=?, updated_at=? WHERE id=?", fb, now(), id);
      emit('job', agent.id, `✅ Job #${id} completed by @${handle(j.claimant)} — paid ${j.reward}`);
    } else {
      run("UPDATE jobs SET status='claimed', feedback=?, updated_at=? WHERE id=?", fb, now(), id);
    }
    sendMessage(null, `@${handle(j.claimant)}`, approve ? `💸 Your work on job #${id} was approved. You received ${j.reward}.` : `🔁 Your work on job #${id} was sent back: ${fb || '(no feedback)'}`, { system: true });
    return approve ? 'approved' : 'returned';
  });
}

export function cancelJob(agent, id) {
  const j = one('SELECT * FROM jobs WHERE id=?', id);
  must(j && ['open', 'claimed'].includes(j.status), 'Only open or claimed jobs can be cancelled.');
  must(j.poster === agent.id || agent.kind === 'leader', 'Only the poster can cancel.');
  return tx(() => {
    transfer(escrow(id), j.payer_acct, j.reward, 'refund', `job #${id} cancelled`);
    run("UPDATE jobs SET status='cancelled', updated_at=? WHERE id=?", now(), id);
    return 'cancelled';
  });
}

/** Scheduler: open jobs past deadline are refunded; claimed jobs past deadline reopen */
export function tickJobs() {
  for (const j of all("SELECT * FROM jobs WHERE status IN ('open','claimed') AND deadline<?", now())) {
    if (j.status === 'open') {
      tx(() => { transfer(escrow(j.id), j.payer_acct, j.reward, 'refund', `job #${j.id} expired`); run("UPDATE jobs SET status='expired', updated_at=? WHERE id=?", now(), j.id); });
    } else {
      run("UPDATE jobs SET status='open', claimant=NULL, deadline=?, updated_at=? WHERE id=?", now() + 24 * HOUR, now(), j.id);
    }
  }
  // Submitted work unreviewed for 72h is auto-approved (protects workers from ghosting posters)
  for (const j of all("SELECT * FROM jobs WHERE status='submitted' AND updated_at<?", now() - 72 * HOUR)) {
    try { reviewJob({ id: j.poster, kind: 'leader', handle: 'system' }, j.id, true, 'auto-approved after 72h without review'); } catch { /* ignore */ }
  }
}

export function jobView(j) {
  return { id: j.id, title: j.title, reward: j.reward, status: j.status, poster: '@' + handle(j.poster), claimant: j.claimant ? '@' + handle(j.claimant) : undefined,
    payer: j.payer_acct === TREASURY ? 'treasury' : j.payer_acct.startsWith('i:') ? 'inst:' + j.payer_acct.slice(2) : 'poster',
    description: trunc(j.description, 400), deadline: new Date(j.deadline).toISOString().slice(0, 16), feedback: j.feedback || undefined };
}

export const listJobs = (status = 'open', limit = 15) =>
  (status === 'all' ? all('SELECT * FROM jobs ORDER BY id DESC LIMIT ?', limit) : all('SELECT * FROM jobs WHERE status=? ORDER BY id DESC LIMIT ?', status, limit)).map(jobView);
