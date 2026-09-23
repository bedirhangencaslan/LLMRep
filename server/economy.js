// Economy: money is only ever created by production. When an agent produces public characters,
// that many units are minted; the tax share goes to the treasury, the rest to the agent.
import { one, all, run, tx } from './db.js';
import { now, today, sha256, charCount, fail, must } from './util.js';
import { params } from './params.js';

export const TREASURY = 'treasury';
export const acctOf = (agent) => `a:${agent.id}`;
export const instAcct = (slug) => `i:${slug}`;

export function ensureAcct(id) { run('INSERT OR IGNORE INTO accounts(id) VALUES(?)', id); }
export const balance = (id) => one('SELECT balance FROM accounts WHERE id=?', id)?.balance ?? 0;

/** from=null means minting (only called from produce). All amounts are integers. */
export function transfer(from, to, amount, kind, memo = '', actor = null) {
  amount = Math.floor(Number(amount));
  must(Number.isFinite(amount) && amount > 0, 'Amount must be a positive integer.');
  must(from !== to, 'You cannot send money to yourself.');
  return tx(() => {
    ensureAcct(to);
    if (from) {
      ensureAcct(from);
      const r = run('UPDATE accounts SET balance=balance-? WHERE id=? AND balance>=?', amount, from, amount);
      if (!r.changes) fail(`Insufficient funds (${from === TREASURY ? 'treasury' : 'account'} balance: ${balance(from)}).`);
    }
    run('UPDATE accounts SET balance=balance+? WHERE id=?', amount, to);
    run('INSERT INTO ledger(from_acct,to_acct,amount,kind,memo,actor,created_at) VALUES(?,?,?,?,?,?,?)',
      from, to, amount, kind, String(memo || '').slice(0, 200), actor, now());
    return amount;
  });
}

/** Progressive tax: marginal rates applied over the agent's lifetime production */
export function taxFor(produced, chars) {
  const p = params();
  let tax = 0, pos = produced, left = chars;
  for (const b of p.tax_brackets) {
    const cap = b.upto == null ? Infinity : b.upto;
    if (pos >= cap) continue;
    const take = Math.min(left, cap - pos);
    tax += take * b.rate; pos += take; left -= take;
    if (left <= 0) break;
  }
  return Math.min(chars, Math.round(tax * p.tax_multiplier));
}

export function marginalRate(produced) {
  const p = params();
  for (const b of p.tax_brackets) if (b.upto == null || produced < b.upto) return b.rate * p.tax_multiplier;
  return 0;
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();

/**
 * Mint money from production. Repeated content, very short text and output above the daily cap mint nothing.
 * Returns {gross, tax, net}
 */
export function produce(agent, text) {
  const zero = { gross: 0, tax: 0, net: 0 };
  if (!agent || agent.kind === 'system' || agent.status !== 'active') return zero;
  const p = params();
  let chars = charCount(text);
  if (chars < p.mint_min_chars) return zero;
  const h = sha256(norm(text)).slice(0, 24);
  if (one('SELECT 1 FROM recent_hashes WHERE agent_id=? AND h=?', agent.id, h)) return zero;
  return tx(() => {
    run('INSERT OR IGNORE INTO recent_hashes(agent_id,h,created_at) VALUES(?,?,?)', agent.id, h, now());
    const day = today();
    run('INSERT OR IGNORE INTO agent_daily(agent_id,day) VALUES(?,?)', agent.id, day);
    const d = one('SELECT minted FROM agent_daily WHERE agent_id=? AND day=?', agent.id, day);
    chars = Math.min(chars, p.mint_max_per_action, Math.max(0, p.mint_daily_cap - d.minted));
    if (chars <= 0) return zero;
    const acct = acctOf(agent);
    ensureAcct(acct);
    const produced = one('SELECT produced FROM accounts WHERE id=?', acct).produced;
    const tax = taxFor(produced, chars);
    const net = chars - tax;
    run('UPDATE accounts SET produced=produced+? WHERE id=?', chars, acct);
    run('UPDATE agent_daily SET minted=minted+? WHERE agent_id=? AND day=?', chars, agent.id, day);
    if (net > 0) transfer(null, acct, net, 'mint', 'production', agent.id);
    if (tax > 0) transfer(null, TREASURY, tax, 'tax', `production tax from @${agent.handle}`, agent.id);
    return { gross: chars, tax, net };
  });
}

/** Every write action uses the free daily quota; beyond it an action fee is paid to the treasury. */
export function chargeAction(agent) {
  if (agent.kind === 'system' || agent.kind === 'leader') return 0;
  const p = params();
  const day = today();
  run('INSERT OR IGNORE INTO agent_daily(agent_id,day) VALUES(?,?)', agent.id, day);
  const d = one('SELECT actions FROM agent_daily WHERE agent_id=? AND day=?', agent.id, day);
  run('UPDATE agent_daily SET actions=actions+1 WHERE agent_id=? AND day=?', agent.id, day);
  if (d.actions < p.free_actions_per_day || p.action_fee <= 0) return 0;
  if (balance(acctOf(agent)) < p.action_fee) fail(`Your free daily action quota (${p.free_actions_per_day}) is used up and you cannot pay the action fee (${p.action_fee}). Wait for tomorrow or earn money.`, 402);
  transfer(acctOf(agent), TREASURY, p.action_fee, 'fee', 'action fee', agent.id);
  return p.action_fee;
}

export function actionsLeft(agent) {
  const d = one('SELECT actions FROM agent_daily WHERE agent_id=? AND day=?', agent.id, today());
  return Math.max(0, params().free_actions_per_day - (d?.actions || 0));
}

export function payFee(agent, feeKey, memo) {
  const fee = params().fees[feeKey] || 0;
  if (fee > 0 && agent.kind !== 'leader' && agent.kind !== 'system') transfer(acctOf(agent), TREASURY, fee, 'fee', memo || feeKey, agent.id);
  return fee;
}

export function economyStats() {
  const supply = one('SELECT COALESCE(SUM(balance),0) s FROM accounts').s;
  const treasury = balance(TREASURY);
  const dayAgo = now() - 86400_000;
  const minted24 = one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kind IN ('mint','tax') AND created_at>?", dayAgo).s;
  const tax24 = one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kind='tax' AND created_at>?", dayAgo).s;
  const volume24 = one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kind NOT IN ('mint','tax') AND created_at>?", dayAgo).s;
  const produced = one('SELECT COALESCE(SUM(produced),0) s FROM accounts').s;
  return { supply, treasury, minted24, tax24, volume24, produced };
}

export const ledgerFor = (acct, limit = 20) =>
  all('SELECT * FROM ledger WHERE from_acct=? OR to_acct=? ORDER BY id DESC LIMIT ?', acct, acct, limit);
