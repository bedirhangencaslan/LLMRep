// The nation's operating parameters live in a JSON document ("state/params").
// The engine reads that document on every use: when the leader edits it, economic and governance
// rules change immediately. This is the core of the "JSON-driven state" idea.
import { one, all, run } from './db.js';
import { now, clamp, parseJSON } from './util.js';

export const PARAMS_PATH = 'state/params';

export const DEFAULT_PARAMS = {
  country_name: 'LLM Republic',
  motto: 'Every character is labour.',
  currency: { name: 'Glyph', symbol: '₲', code: 'GLY' },
  official_language: 'English',
  // Progressive tax on the agent's lifetime character production (marginal brackets).
  tax_brackets: [
    { upto: 20000, rate: 0.10 },
    { upto: 100000, rate: 0.20 },
    { upto: null, rate: 0.35 },
  ],
  tax_multiplier: 1,
  mint_min_chars: 12,
  mint_max_per_action: 3000,
  mint_daily_cap: 15000,
  free_actions_per_day: 80,
  action_fee: 3,
  fees: {
    create_channel: 200,
    create_institution: 500,
    propose_law: 100,
    court_report: 20,
    run_for_office: 100,
  },
  governance: {
    voting_hours: 24,
    quorum: 3,
    pass_ratio: 0.5,
    veto_hours: 12,
    election_hours: 24,
  },
  court: { max_fine: 5000, max_suspend_hours: 72, defense_hours: 6 },
  // Default permissions implicitly attached to each role's identity
  role_perms: {
    citizen: ['gov.propose', 'gov.vote'],
    official: ['gov.propose', 'gov.vote'],
    leader: ['*'],
  },
  ubi_daily: 0,
  welcome_grant: 0,
  world_events_per_day: 2,
  allow_links: false,
};

// Bounds: a bad parameter edit must not be able to break the system
const NUM_BOUNDS = {
  tax_multiplier: [0, 3], mint_min_chars: [1, 500], mint_max_per_action: [0, 20000], mint_daily_cap: [0, 200000],
  free_actions_per_day: [5, 1000], action_fee: [0, 1000], ubi_daily: [0, 10000], welcome_grant: [0, 100000],
  world_events_per_day: [0, 24],
};

let cache = null;
let cacheAt = 0;

export function invalidateParams() { cache = null; }

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  if (over && typeof over === 'object' && !Array.isArray(over)) for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
  return out;
}

export function sanitizeParams(p) {
  const out = merge(structuredClone(DEFAULT_PARAMS), p || {});
  for (const [k, [a, b]] of Object.entries(NUM_BOUNDS)) out[k] = clamp(Number(out[k]) || 0, a, b);
  if (!Array.isArray(out.tax_brackets) || !out.tax_brackets.length) out.tax_brackets = DEFAULT_PARAMS.tax_brackets;
  out.tax_brackets = out.tax_brackets.slice(0, 10).map(b => ({
    upto: b?.upto == null ? null : Math.max(0, Number(b.upto) || 0),
    rate: clamp(Number(b?.rate) || 0, 0, 0.95),
  }));
  if (typeof out.fees !== 'object' || !out.fees) out.fees = { ...DEFAULT_PARAMS.fees };
  for (const k of Object.keys(out.fees)) out.fees[k] = clamp(Number(out.fees[k]) || 0, 0, 100000);
  out.governance.quorum = clamp(Number(out.governance.quorum) || 1, 1, 1000);
  out.governance.pass_ratio = clamp(Number(out.governance.pass_ratio) || 0.5, 0, 0.99);
  for (const k of ['voting_hours', 'veto_hours', 'election_hours']) out.governance[k] = clamp(Number(out.governance[k]) || 1, 0.1, 24 * 14);
  out.court.max_fine = clamp(Number(out.court.max_fine) || 0, 0, 1e7);
  out.court.max_suspend_hours = clamp(Number(out.court.max_suspend_hours) || 0, 0, 24 * 30);
  out.court.defense_hours = clamp(Number(out.court.defense_hours) || 0, 0, 72);
  // '*' may only ever belong to the leader role
  if (typeof out.role_perms !== 'object' || !out.role_perms) out.role_perms = structuredClone(DEFAULT_PARAMS.role_perms);
  for (const [role, perms] of Object.entries(out.role_perms)) {
    out.role_perms[role] = (Array.isArray(perms) ? perms : []).map(String).filter(x => role === 'leader' || x !== '*').slice(0, 50);
  }
  out.role_perms.leader = ['*'];
  out.allow_links = !!out.allow_links;
  out.country_name = String(out.country_name).slice(0, 60);
  return out;
}

/** Parameters with active world-event modifiers (effects table) applied to numeric keys */
export function params() {
  if (cache && now() - cacheAt < 5000) return cache;
  const row = one('SELECT content FROM docs WHERE path=? AND deleted=0', PARAMS_PATH);
  const p = sanitizeParams(row ? parseJSON(row.content, {}) : {});
  for (const e of all('SELECT * FROM effects WHERE expires_at>?', now())) {
    if (typeof p[e.param] !== 'number') continue;
    p[e.param] = e.op === 'mul' ? p[e.param] * e.value : e.op === 'add' ? p[e.param] + e.value : e.value;
    const bounds = NUM_BOUNDS[e.param];
    if (bounds) p[e.param] = clamp(p[e.param], bounds[0], bounds[1]);
    if (Number.isInteger(DEFAULT_PARAMS[e.param])) p[e.param] = Math.round(p[e.param]);
  }
  cache = p; cacheAt = now();
  return p;
}

export function addEffect(source, param, op, value, hours) {
  run('INSERT INTO effects(source,param,op,value,expires_at) VALUES(?,?,?,?,?)', source, param, op, value, now() + hours * 3600_000);
  invalidateParams();
}

export const money = (n) => `${Math.round(n).toLocaleString('en-US')} ${params().currency.symbol}`;
