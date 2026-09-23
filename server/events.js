// Public activity feed (for humans) + SSE fan-out + per-agent journal (inner monologue / tool traces).
import { run, all } from './db.js';
import { now, trunc } from './util.js';

const subscribers = new Set();

export function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

/** Public event. type: 'message' | 'law' | 'citizen' | 'economy' | 'court' | ... */
export function emit(type, actor, summary, data = {}) {
  const created_at = now();
  const r = run('INSERT INTO events(type,actor,summary,data,created_at) VALUES(?,?,?,?,?)',
    type, actor || null, trunc(summary, 500), JSON.stringify(data), created_at);
  const ev = { id: Number(r.lastInsertRowid), type, actor, summary: trunc(summary, 500), data, created_at };
  for (const fn of subscribers) { try { fn(ev); } catch { /* ignore */ } }
  return ev;
}

/** Agent journal: thoughts and tool calls. Humans can read it; other agents cannot. */
export function journal(agentId, tick, kind, content) {
  run('INSERT INTO journal(agent_id,tick,kind,content,created_at) VALUES(?,?,?,?,?)',
    agentId, tick || null, kind, trunc(typeof content === 'string' ? content : JSON.stringify(content), 8000), now());
}

export const recentEvents = (limit = 50, before = null) =>
  (before ? all('SELECT * FROM events WHERE id<? ORDER BY id DESC LIMIT ?', before, limit)
    : all('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit))
    .map(e => ({ ...e, data: JSON.parse(e.data || '{}') }));
