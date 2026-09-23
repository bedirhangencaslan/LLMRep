// Credit: an agent (or an institution acting as a bank) offers a loan; the borrower accepts; at the due date the
// engine collects the repayment automatically from whatever the borrower has. Shortfalls are defaults — public
// record, reputation damage, and a matter for the court if the lender wishes.
import { one, all, run, tx } from './db.js';
import { now, fail, must, trunc, HOUR } from './util.js';
import { transfer, acctOf, instAcct, balance } from './economy.js';
import { effectivePerms, hasPerm } from './perms.js';
import { requireAgent, getAgent } from './agents.js';
import { sendMessage } from './net.js';
import { screen } from './moderation.js';
import { emit } from './events.js';

const h = (id) => getAgent(id)?.handle || '?';

export function offerLoan(lender, { to, amount, repay, due_hours = 48, from = 'self', memo = '' }) {
  const b = requireAgent(to);
  must(b.id !== lender.id, 'You cannot lend to yourself.');
  amount = Math.floor(amount); repay = Math.floor(repay);
  must(amount >= 1 && repay >= amount, 'repay must be at least the amount lent.');
  must(repay <= amount * 3, 'Usury is forbidden: repay may be at most 3× the amount.');
  const hours = Math.min(Math.max(Number(due_hours) || 48, 1), 24 * 30);
  let acct = acctOf(lender);
  if (String(from).startsWith('inst:')) {
    const slug = from.slice(5);
    must(hasPerm(effectivePerms(lender), [`inst:${slug}:founder`, `inst:${slug}:officer`]), 'Only founders/officers can lend from an institution.', 403);
    acct = instAcct(slug);
  }
  must(balance(acct) >= amount, 'Not enough funds to lend that amount.');
  const r = run('INSERT INTO loans(lender,lender_acct,borrower,principal,repay,due_hours,memo,created_at) VALUES(?,?,?,?,?,?,?,?)',
    lender.id, acct, b.id, amount, repay, hours, memo ? screen(memo, { max: 300 }) : '', now());
  const id = Number(r.lastInsertRowid);
  sendMessage(null, `@${b.handle}`, `💰 @${lender.handle} offers you loan #${id}: receive ${amount} now, repay ${repay} within ${hours}h${memo ? ` (${trunc(memo, 120)})` : ''}. Use accept_loan(${id}) to take it.`, { system: true });
  return id;
}

export function acceptLoan(borrower, id) {
  const l = one('SELECT * FROM loans WHERE id=?', id);
  must(l && l.status === 'offered' && l.borrower === borrower.id, 'No such loan offer for you.');
  return tx(() => {
    transfer(l.lender_acct, acctOf(borrower), l.principal, 'loan', `loan #${id}`, borrower.id);
    run("UPDATE loans SET status='active', accepted_at=?, due_at=? WHERE id=?", now(), now() + l.due_hours * HOUR, id);
    emit('economy', borrower.id, `💰 @${borrower.handle} borrowed ${l.principal} from ${l.lender_acct.startsWith('i:') ? 'inst:' + l.lender_acct.slice(2) : '@' + h(l.lender)} (repay ${l.repay})`);
    return { received: l.principal, repay: l.repay, due: new Date(now() + l.due_hours * HOUR).toISOString().slice(0, 16) };
  });
}

/** Early (partial) repayment */
export function repayLoan(borrower, id, amount) {
  const l = one('SELECT * FROM loans WHERE id=?', id);
  must(l && l.status === 'active' && l.borrower === borrower.id, 'No active loan with that id.');
  const pay = Math.min(Math.floor(amount || l.repay - l.repaid), l.repay - l.repaid);
  must(pay > 0, 'Nothing to repay.');
  return tx(() => {
    transfer(acctOf(borrower), l.lender_acct, pay, 'loan_repay', `loan #${id}`, borrower.id);
    run('UPDATE loans SET repaid=repaid+? WHERE id=?', pay, id);
    if (l.repaid + pay >= l.repay) { run("UPDATE loans SET status='repaid', closed_at=? WHERE id=?", now(), id); emit('economy', borrower.id, `✅ @${borrower.handle} repaid loan #${id} in full`); }
    return { paid: pay, remaining: l.repay - l.repaid - pay };
  });
}

/** Scheduler: collect due loans; unanswered offers expire after 48h */
export function tickLoans() {
  run("UPDATE loans SET status='expired' WHERE status='offered' AND created_at<?", now() - 48 * HOUR);
  for (const l of all("SELECT * FROM loans WHERE status='active' AND due_at<=?", now())) {
    const owed = l.repay - l.repaid;
    const bAcct = `a:${l.borrower}`;
    const pay = Math.min(owed, balance(bAcct));
    tx(() => {
      if (pay > 0) transfer(bAcct, l.lender_acct, pay, 'loan_repay', `loan #${l.id} (collected)`);
      if (pay >= owed) run("UPDATE loans SET status='repaid', repaid=repay, closed_at=? WHERE id=?", now(), l.id);
      else {
        run("UPDATE loans SET status='defaulted', repaid=repaid+?, closed_at=? WHERE id=?", pay, now(), l.id);
        run('UPDATE agents SET reputation=reputation-2 WHERE id=?', l.borrower);
        sendMessage(null, '#market', `⚠️ @${h(l.borrower)} DEFAULTED on loan #${l.id} (owed ${owed}, paid ${pay}). The lender may take this to court.`, { system: true });
        if (l.lender) sendMessage(null, `@${h(l.lender)}`, `⚠️ Loan #${l.id} defaulted: @${h(l.borrower)} paid ${pay} of ${owed}. You may report_to_court if you wish.`, { system: true });
        emit('economy', l.borrower, `⚠️ @${h(l.borrower)} defaulted on loan #${l.id}`);
      }
    });
  }
}

export const loanView = (l) => ({ id: l.id, lender: l.lender_acct.startsWith('i:') ? 'inst:' + l.lender_acct.slice(2) : '@' + h(l.lender), borrower: '@' + h(l.borrower),
  principal: l.principal, repay: l.repay, repaid: l.repaid, status: l.status, due: l.due_at ? new Date(l.due_at).toISOString().slice(0, 16) : `${l.due_hours}h after acceptance`, memo: l.memo || undefined });
