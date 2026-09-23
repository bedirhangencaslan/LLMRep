// The heartbeat of the nation. Every few seconds: close votes and elections, expire jobs, assign judges,
// run JSON automations, maybe fire a world event; once a day: salaries, UBI, newspaper, cleanup.
// Server-run agents take turns strictly one at a time, which doubles as a natural rate limiter for free APIs.
import { one, all, run, kvGet, kvSet } from './db.js';
import { config } from './config.js';
import { now, today, parseJSON, trunc, DAY } from './util.js';
import { tickBills, tickElections, payDaily } from './gov.js';
import { tickJobs } from './jobs.js';
import { tickCourt } from './court.js';
import { maybeWorldEvent, publishNewspaper } from './world.js';
import { runTurn } from './runtime.js';
import { executeTool } from './tools.js';
import { byHandle } from './agents.js';
import { emit } from './events.js';
import { tickPetitions, weeklyHonours } from './civic.js';
import { tickLoans } from './loans.js';

const FORBIDDEN_IN_AUTOMATION = new Set(['consult_model', 'appoint_official', 'dismiss_official', 'grant_permission', 'revoke_permission', 'decree']);
let busy = false;
let timer = null;

export const isPaused = () => config.paused || kvGet('paused', false);

export async function runAutomations() {
  const docs = all("SELECT path, content, owner, updated_by FROM docs WHERE path LIKE 'state/automations/%' AND deleted=0 AND hidden=0");
  for (const d of docs) {
    const a = parseJSON(d.content, {});
    if (!a || a.enabled === false || FORBIDDEN_IN_AUTOMATION.has(a.tool)) continue;
    const every = Math.max(10, Number(a.every_minutes) || 60) * 60_000;
    const key = `auto:${d.path}`;
    const last = kvGet(key, 0);
    if (now() - last < every) continue;
    kvSet(key, now());
    const agent = byHandle(a.run_as);
    if (!agent || agent.status !== 'active') continue;
    // No impersonation: an automation acts as whoever last edited it, or — only if the last editor was the
    // Head of State or the engine itself — as a state agent (leader/official).
    const editor = d.updated_by && d.updated_by !== 'system' ? one('SELECT id, kind FROM agents WHERE id=?', d.updated_by) : null;
    const editorIsSovereign = !d.updated_by || d.updated_by === 'system' || editor?.kind === 'leader';
    const allowed = agent.id === d.updated_by || (editorIsSovereign && ['leader', 'official'].includes(agent.kind));
    if (!allowed) { emit('automation', null, `⚙️ Automation ${d.path} refused: it may not act as @${agent.handle}`); continue; }
    const res = await executeTool(agent, a.tool, a.args || {}, { system: true, noMint: true, tick: `auto:${d.path}` });
    emit('automation', agent.id, `⚙️ Automation ${d.path.split('/').pop()} ran ${a.tool} as @${agent.handle}: ${res.ok ? 'ok' : 'failed — ' + trunc(res.error, 100)}`);
  }
}

async function daily() {
  if (kvGet('daily:last') === today()) return;
  kvSet('daily:last', today());
  payDaily();
  weeklyHonours();
  run('DELETE FROM recent_hashes WHERE created_at<?', now() - 7 * DAY);
  run('DELETE FROM llm_calls WHERE created_at<?', now() - 30 * DAY);
  run('DELETE FROM effects WHERE expires_at<?', now() - DAY);
  run('DELETE FROM user_sessions WHERE expires_at<?', now());
  await publishNewspaper().catch(e => console.error('[newspaper]', e.message));
}

export async function tick() {
  if (busy) return;
  busy = true;
  try {
    tickBills(); tickElections(); tickJobs(); tickCourt(); tickPetitions(); tickLoans();
    await runAutomations();
    maybeWorldEvent();
    await daily();
    // Server-run agents take turns one at a time; several per tick if turns are quick
    const started = now();
    for (let i = 0; i < 6 && !isPaused() && now() - started < 8000; i++) {
      const a = one(`SELECT * FROM agents WHERE status='active' AND next_run_at<=?
        AND (kind IN ('leader','official') OR (kind='citizen' AND model LIKE 'mock:%'))
        ORDER BY (kind='leader') DESC, next_run_at LIMIT 1`, now());
      if (!a) break;
      const r = await runTurn(a);
      if (process.env.LOG_TURNS !== '0') console.log(`[turn] @${a.handle}: ${r.steps} steps, ${r.actions} actions${r.failed ? ' (no model available)' : ''}`);
    }
  } catch (e) {
    console.error('[scheduler]', e);
  } finally { busy = false; }
}

export function startScheduler(intervalMs = 10_000) {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  setTimeout(tick, 1500);
}
export function stopScheduler() { clearInterval(timer); timer = null; }
