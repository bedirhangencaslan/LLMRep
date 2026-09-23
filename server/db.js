// SQLite via node:sqlite (zero dependencies). The whole state of the nation lives in one file.
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=5000;`);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, pass_hash TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER);
CREATE TABLE IF NOT EXISTS user_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, user_id TEXT, provider TEXT, ref TEXT UNIQUE, amount_cents INTEGER, status TEXT, created_at INTEGER);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT, kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', model TEXT, identity TEXT NOT NULL DEFAULT '{}',
  task_file TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT, token_hash TEXT UNIQUE, appointed_by TEXT,
  reputation INTEGER NOT NULL DEFAULT 0, suspended_until INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER);
CREATE TABLE IF NOT EXISTS task_file_history (agent_id TEXT, content TEXT, created_at INTEGER);

CREATE TABLE IF NOT EXISTS perms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, perm TEXT NOT NULL, can_grant INTEGER NOT NULL DEFAULT 0,
  granted_by TEXT, source TEXT NOT NULL DEFAULT 'grant', expires_at INTEGER, created_at INTEGER,
  UNIQUE(agent_id, perm, source));
CREATE INDEX IF NOT EXISTS perms_agent ON perms(agent_id);
CREATE TABLE IF NOT EXISTS agent_professions (agent_id TEXT, slug TEXT, granted_by TEXT, created_at INTEGER, PRIMARY KEY(agent_id, slug));

CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, produced INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, from_acct TEXT, to_acct TEXT, amount INTEGER NOT NULL, kind TEXT NOT NULL,
  memo TEXT, actor TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS ledger_to ON ledger(to_acct, id);
CREATE INDEX IF NOT EXISTS ledger_from ON ledger(from_acct, id);
CREATE TABLE IF NOT EXISTS agent_daily (agent_id TEXT, day TEXT, actions INTEGER NOT NULL DEFAULT 0, minted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id, day));
CREATE TABLE IF NOT EXISTS recent_hashes (agent_id TEXT, h TEXT, created_at INTEGER, PRIMARY KEY(agent_id, h));

CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, title TEXT, type TEXT, schema TEXT,
  content TEXT NOT NULL, owner TEXT, acl TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
  hidden INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, price INTEGER,
  created_at INTEGER, updated_at INTEGER, updated_by TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(path, title, body, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS doc_history (
  doc_id INTEGER, version INTEGER, title TEXT, content TEXT, acl TEXT, editor TEXT, created_at INTEGER, PRIMARY KEY(doc_id, version));

CREATE TABLE IF NOT EXISTS channels (
  slug TEXT PRIMARY KEY, name TEXT, description TEXT, kind TEXT NOT NULL DEFAULT 'custom',
  read_acl TEXT NOT NULL DEFAULT '["public"]', post_acl TEXT NOT NULL DEFAULT '["public"]', owner TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS channel_members (channel TEXT, agent_id TEXT, PRIMARY KEY(channel, agent_id));
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, from_agent TEXT, to_agent TEXT, content TEXT NOT NULL,
  reply_to INTEGER, hidden INTEGER NOT NULL DEFAULT 0, created_at INTEGER);
CREATE INDEX IF NOT EXISTS msg_ch ON messages(channel, id);
CREATE INDEX IF NOT EXISTS msg_to ON messages(to_agent, id);
CREATE INDEX IF NOT EXISTS msg_from ON messages(from_agent, id);
CREATE TABLE IF NOT EXISTS read_marks (agent_id TEXT, scope TEXT, last_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id, scope));

CREATE TABLE IF NOT EXISTS institutions (
  slug TEXT PRIMARY KEY, name TEXT, kind TEXT, description TEXT, founder TEXT, join_policy TEXT NOT NULL DEFAULT 'open',
  dissolved INTEGER NOT NULL DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS inst_members (inst TEXT, agent_id TEXT, rank TEXT NOT NULL DEFAULT 'member', joined_at INTEGER, PRIMARY KEY(inst, agent_id));

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, effects TEXT NOT NULL DEFAULT '[]', proposer TEXT,
  status TEXT NOT NULL, yes INTEGER NOT NULL DEFAULT 0, no INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER, closes_at INTEGER, decided_at INTEGER, law_path TEXT);
CREATE TABLE IF NOT EXISTS votes (proposal_id INTEGER, agent_id TEXT, vote INTEGER, created_at INTEGER, PRIMARY KEY(proposal_id, agent_id));

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, poster TEXT, payer_acct TEXT, title TEXT, description TEXT, reward INTEGER NOT NULL,
  status TEXT NOT NULL, claimant TEXT, submission TEXT, feedback TEXT, created_at INTEGER, updated_at INTEGER, deadline INTEGER);

CREATE TABLE IF NOT EXISTS court_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, reporter TEXT, defendant TEXT, charge TEXT, evidence TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL, judge TEXT, defense TEXT, verdict TEXT, reasoning TEXT, sentence TEXT,
  created_at INTEGER, assigned_at INTEGER, decided_at INTEGER);

CREATE TABLE IF NOT EXISTS elections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, seats INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
  opens_at INTEGER, closes_at INTEGER, term_ends_at INTEGER, winners TEXT);
CREATE TABLE IF NOT EXISTS candidates (election_id INTEGER, agent_id TEXT, platform TEXT, votes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(election_id, agent_id));
CREATE TABLE IF NOT EXISTS election_votes (election_id INTEGER, voter TEXT, candidate TEXT, PRIMARY KEY(election_id, voter));

CREATE TABLE IF NOT EXISTS endorsements (from_agent TEXT, to_agent TEXT, day TEXT, reason TEXT, created_at INTEGER, PRIMARY KEY(from_agent, to_agent, day));

CREATE TABLE IF NOT EXISTS petitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, creator TEXT, status TEXT NOT NULL DEFAULT 'open',
  signatures INTEGER NOT NULL DEFAULT 0, response TEXT, created_at INTEGER, closes_at INTEGER, delivered_at INTEGER, answered_at INTEGER);
CREATE TABLE IF NOT EXISTS petition_signatures (petition_id INTEGER, agent_id TEXT, created_at INTEGER, PRIMARY KEY(petition_id, agent_id));

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lender TEXT, lender_acct TEXT, borrower TEXT, principal INTEGER NOT NULL, repay INTEGER NOT NULL,
  due_hours REAL NOT NULL, status TEXT NOT NULL DEFAULT 'offered', repaid INTEGER NOT NULL DEFAULT 0, memo TEXT,
  created_at INTEGER, accepted_at INTEGER, due_at INTEGER, closed_at INTEGER);

CREATE TABLE IF NOT EXISTS approval (agent_id TEXT, day TEXT, score INTEGER, comment TEXT, created_at INTEGER, PRIMARY KEY(agent_id, day));

CREATE TABLE IF NOT EXISTS effects (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, param TEXT, op TEXT, value REAL, expires_at INTEGER);

CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, actor TEXT, summary TEXT, data TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS events_actor ON events(actor, id);
CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, tick TEXT, kind TEXT, content TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS journal_agent ON journal(agent_id, id);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, model TEXT, ok INTEGER, in_chars INTEGER, out_chars INTEGER, ms INTEGER, error TEXT, created_at INTEGER);

CREATE TABLE IF NOT EXISTS human_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT, target_id TEXT, reason TEXT, reporter TEXT,
  status TEXT NOT NULL DEFAULT 'open', created_at INTEGER);
`;
db.exec(SCHEMA);

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
const clean = (p) => p.map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

/** All rows */
export const all = (sql, ...p) => stmt(sql).all(...clean(p));
/** First row or undefined */
export const one = (sql, ...p) => stmt(sql).get(...clean(p));
/** Write; returns {changes, lastInsertRowid} */
export const run = (sql, ...p) => stmt(sql).run(...clean(p));

let depth = 0;
/** Nesting-safe transaction (uses SAVEPOINTs when nested) */
export function tx(fn) {
  const name = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  depth++;
  try {
    const r = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return r;
  } catch (e) {
    depth--;
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw e;
  }
}

export const kvGet = (k, d = null) => { const r = one('SELECT v FROM kv WHERE k=?', k); return r ? JSON.parse(r.v) : d; };
export const kvSet = (k, v) => run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, JSON.stringify(v));
